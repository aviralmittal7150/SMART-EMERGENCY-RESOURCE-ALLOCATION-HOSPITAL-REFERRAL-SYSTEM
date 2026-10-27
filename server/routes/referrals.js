// server/routes/referrals.js
// Referral Handshake API — /api/v1/referrals
// Implements 90s Soft-Lock, Accept, Reject & TTL Failover

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { resolveEmergencyRequirements } from '../services/emergencyRequirements.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// POST /api/v1/referrals/initiate
// Place a 90-second soft lock on a hospital's resources
// Body: { request_id, hospital_id }
// ────────────────────────────────────────────────────────────
router.post('/initiate',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC'),
  async (req, res) => {
    const { request_id, hospital_id } = req.body;

    if (!request_id || !hospital_id) {
      return res.status(400).json({ error: 'request_id and hospital_id are required.' });
    }

    // Verify hospital is open
    const hospital = await store.getHospital(hospital_id);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });
    if (hospital.emergency_status === 'CLOSED') {
      return res.status(409).json({ error: 'Hospital is CLOSED — cannot initiate referral.' });
    }

    // Verify request exists
    const request = await store.getRequest(request_id);
    if (!request) return res.status(404).json({ error: 'Emergency request not found.' });

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
      const lock = await store.acquireReferralLock(hospital_id, request_id, requirements.resourceTypes);

      res.status(201).json({
        success: true,
        message: `90-second soft-lock placed on ${hospital.hospital_name} for ${request_id}.`,
        acceptance_id: lock.acceptanceId,
        hospital_id,
        request_id,
        resource_types: requirements.resourceTypes,
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

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== acceptance.hospital_id) {
      return res.status(403).json({ error: 'You can only accept referrals for your own facility.' });
    }

    try {
      // The hospital alert is recorded by the server's 'allocation_committed' listener, after the
      // commit and outside this response: a failing alert write must not turn an accept into an error.
      const result = await store.commitReferral(req.params.acceptanceId, req.user.user_id);

      res.json({
        success: true,
        message: `Referral accepted. Resources atomically committed; EMS dispatch can now be assigned.`,
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
  async (req, res) => {
    const { rejection_reason = 'No capacity at this time' } = req.body;

    const acceptance = await store.getAcceptance(req.params.acceptanceId);
    if (!acceptance) return res.status(404).json({ error: 'Acceptance record not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== acceptance.hospital_id) {
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
router.get('/active', authenticate, authorize('ADMIN', 'HOSPITAL_DESK'), async (req, res) => {
  const locks = (await store.getActiveLocks()).filter(lock => req.user.role !== 'HOSPITAL_DESK'
    || lock.hospitalId === req.user.hospital_id);
  res.json({
    success: true,
    active_locks: locks
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/referrals/history
// All acceptance records (for analytics)
// ────────────────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  // RBAC: Hospital Desk sees only their acceptances
  const history = await store.listAcceptances({
    hospitalId: req.user.role === 'HOSPITAL_DESK' ? req.user.hospital_id : undefined
  });

  res.json({ success: true, count: history.length, history });
});

export default router;
