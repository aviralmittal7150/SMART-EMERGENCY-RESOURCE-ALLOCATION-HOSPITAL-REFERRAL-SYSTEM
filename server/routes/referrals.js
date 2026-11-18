// server/routes/referrals.js
// Referral Handshake API — /api/v1/referrals
// Implements 90s Soft-Lock, Accept, Reject & TTL Failover

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { resolveEmergencyRequirements } from '../services/emergencyRequirements.js';
import { caseScope, canDecideReferral, referralFilter, visibleLocks, isCommandCenter } from '../services/accessPolicy.js';
import { validateBody, ID20 } from '../services/validation.js';
import { insideArea, AREA_MESSAGE } from '../services/operatingArea.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// POST /api/v1/referrals/initiate
// Admin command centre only: place a 90-second soft lock on a hospital's resources
// Body: { request_id, hospital_id }
// ────────────────────────────────────────────────────────────
router.post('/initiate',
  authenticate,
  authorize('ADMIN'),
  validateBody({ request_id: { ...ID20, required: true }, hospital_id: { ...ID20, required: true }, ambulance_id: { ...ID20, nullable: true } }),
  async (req, res) => {
    const { request_id, hospital_id } = req.valid;
    // Batch 8 (P-0.3) Dispatch: an ADMIN may name the unit (see GET /emergencies/:id/dispatch-options). It must be
    // AVAILABLE and inside the operating area now; when the hospital accepts, the auto-dispatch takes it if it is still
    // AVAILABLE (otherwise the usual rule applies). Recorded on the case (dispatch_ambulance_id) and audited.
    const ambulanceId = req.valid.ambulance_id ?? null;
    if (ambulanceId) {
      if (!isCommandCenter(req.user)) return res.status(403).json({ error: 'Only the command centre (ADMIN) chooses the ambulance at dispatch.' });
      const unit = await store.getAmbulance(ambulanceId);
      if (!unit) return res.status(404).json({ error: 'Ambulance not found.' });
      if (unit.status !== 'AVAILABLE') return res.status(409).json({ error: `Ambulance ${ambulanceId} is ${unit.status}, not AVAILABLE.` });
      if (!insideArea(Number(unit.current_lat), Number(unit.current_lng))) return res.status(409).json({ error: `Ambulance ${ambulanceId} ${AREA_MESSAGE}` });
    }

    // Verify hospital is open
    const hospital = await store.getHospital(hospital_id);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });
    if (hospital.emergency_status === 'CLOSED') {
      return res.status(409).json({ error: 'Hospital is CLOSED — cannot initiate referral.' });
    }

    // Verify request exists, and that the caller may see it (a paramedic refers only the cases in their scope).
    const request = await store.getRequest(request_id);
    if (!request || !(await store.caseVisible(request_id, caseScope(req.user)))) {
      return res.status(404).json({ error: 'Emergency request not found.' });
    }

    if (!['NEW', 'WAITING', 'MATCHING'].includes(request.status)) {
      return res.status(409).json({ error: `Request is already in ${request.status} state and cannot receive a referral.` });
    }

    if (await store.hasPendingAcceptance(request_id)) {
      return res.status(409).json({ error: 'This request already has a pending hospital referral.' });
    }

    const requirements = resolveEmergencyRequirements(
      request.emergency_type,
      request.required_resource_types,
      request.required_specialist
    );
    if (!requirements) return res.status(409).json({ error: 'Emergency requirements are invalid.' });

    if (requirements.specialist && !(await store.hasAvailableSpecialist(hospital_id, requirements.specialist))) {
      return res.status(409).json({ error: `Required specialist ${requirements.specialist} is not available at ${hospital_id}.` });
    }

    try {
      if (ambulanceId) await store.setDispatchAmbulance(request_id, ambulanceId, { role: req.user.role, id: req.user.user_id });
      // initiated_by: the caller is told about this referral's outcome (and a failover's) on socket room user:<id>.
      const lock = await store.acquireReferralLock(hospital_id, request_id, requirements.resourceTypes, { initiatedBy: req.user.user_id });

      res.status(201).json({
        success: true,
        message: `90-second soft-lock placed on ${hospital.hospital_name} for ${request_id}.`,
        acceptance_id: lock.acceptanceId,
        hospital_id,
        request_id,
        dispatch_ambulance_id: ambulanceId,
        // What this referral actually soft-locked: the claim's current stage (for staged TRAUMA/POLYTRAUMA, stage 1
        // only). The case's full requirement across all stages is reported separately.
        resource_types: lock.resourceTypes,
        stage: lock.stage ?? 1,
        reserved_specialist: lock.specialistId ?? null,
        required_resource_types: requirements.resourceTypes,
        required_specialist: requirements.specialist,
        expires_in_sec: 90,
        ttl_expires_at: new Date(lock.expiresAt).toISOString()
      });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

// ────────────────────────────────────────────────────────────
// POST /api/v1/referrals/:acceptanceId/accept
// Hospital accepts referral — atomic commit
// ────────────────────────────────────────────────────────────
router.post('/:acceptanceId/accept',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  async (req, res) => {
    // RBAC: Hospital Desk can only accept for their own facility
    const acceptance = await store.getAcceptance(req.params.acceptanceId);
    if (!acceptance) return res.status(404).json({ error: 'Acceptance record not found.' });

    if (!canDecideReferral(req.user, acceptance)) {
      return res.status(403).json({ error: 'You can only accept referrals for your own facility.' });
    }

    try {
      // The hospital alert is recorded by the server's 'allocation_committed' listener, after the
      // commit and outside this response: a failing alert write must not turn an accept into an error.
      const result = await store.commitReferral(req.params.acceptanceId, req.user.user_id);

      // A retry of an accept that already committed reports that same allocation (nothing is re-applied).
      if (result.replayed) res.set('Idempotent-Replayed', 'true');
      res.json({
        success: true,
        message: result.replayed
          ? 'Referral was already accepted. Returning the committed allocation; nothing was changed.'
          : `Referral accepted. Resources atomically committed; EMS dispatch can now be assigned.`,
        ...result
      });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

// ────────────────────────────────────────────────────────────
// POST /api/v1/referrals/:acceptanceId/reject
// Hospital rejects referral — release lock & failover
// Body: { rejection_reason }
// ────────────────────────────────────────────────────────────
router.post('/:acceptanceId/reject',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  // HospitalAcceptance.rejection_reason is VARCHAR(300).
  validateBody({ rejection_reason: { type: 'string', maxLength: 300, emptyAs: 'No capacity at this time', default: 'No capacity at this time' } }),
  async (req, res) => {
    const { rejection_reason } = req.valid;

    const acceptance = await store.getAcceptance(req.params.acceptanceId);
    if (!acceptance) return res.status(404).json({ error: 'Acceptance record not found.' });

    if (!canDecideReferral(req.user, acceptance)) {
      return res.status(403).json({ error: 'You can only reject referrals for your own facility.' });
    }

    try {
      const result = await store.rejectReferral(req.params.acceptanceId, rejection_reason, req.user.user_id);
      res.json({
        success: true,
        message: 'Referral rejected. Soft-lock released. System will route to next candidate hospital.',
        ...result
      });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

// ────────────────────────────────────────────────────────────
// GET /api/v1/referrals/active
// All currently active soft-locks
// ────────────────────────────────────────────────────────────
router.get('/active', authenticate, authorize('ADMIN', 'DISPATCHER', 'HOSPITAL_DESK'), async (req, res) => {
  const locks = visibleLocks(req.user, await store.getActiveLocks()) ?? [];
  res.json({
    success: true,
    active_locks: locks
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/referrals/history
// Acceptance records in the caller's scope: admins all, a desk those sent to its hospital, a paramedic those they sent
// ────────────────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  const filter = referralFilter(req.user);
  const history = filter ? await store.listAcceptances(filter) : [];

  res.json({ success: true, count: history.length, history });
});

export default router;
