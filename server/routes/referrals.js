// server/routes/referrals.js
// Referral Handshake API — /api/v1/referrals
// Implements 90s Soft-Lock, Accept, Reject & TTL Failover

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { lockingEngine } from '../services/lockingEngine.js';
import { db } from '../db/seed.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// POST /api/v1/referrals/initiate
// Place a 90-second soft lock on a hospital's resources
// Body: { request_id, hospital_id, resource_types }
// ────────────────────────────────────────────────────────────
router.post('/initiate',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC'),
  async (req, res) => {
    const { request_id, hospital_id, resource_types = ['ICU_BED'] } = req.body;

    if (!request_id || !hospital_id) {
      return res.status(400).json({ error: 'request_id and hospital_id are required.' });
    }

    // Verify hospital is open
    const hospital = db.hospitals.find(h => h.hospital_id === hospital_id);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });
    if (hospital.emergency_status === 'CLOSED') {
      return res.status(409).json({ error: 'Hospital is CLOSED — cannot initiate referral.' });
    }

    // Verify request exists
    const request = db.emergencyRequests.find(r => r.request_id === request_id);
    if (!request) return res.status(404).json({ error: 'Emergency request not found.' });

    try {
      const lock = await lockingEngine.acquireSoftLock(hospital_id, request_id, resource_types);
      request.status = 'MATCHING';

      res.status(201).json({
        success: true,
        message: `90-second soft-lock placed on ${hospital.hospital_name} for ${request_id}.`,
        acceptance_id: lock.acceptanceId,
        hospital_id,
        request_id,
        expires_in_sec: 90,
        ttl_expires_at: new Date(lock.expiresAt).toISOString()
      });
    } catch (err) {
      res.status(409).json({ error: err.message });
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
    const acceptance = db.hospitalAcceptances.find(a => a.acceptance_id === req.params.acceptanceId);
    if (!acceptance) return res.status(404).json({ error: 'Acceptance record not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== acceptance.hospital_id) {
      return res.status(403).json({ error: 'You can only accept referrals for your own facility.' });
    }

    try {
      const result = await lockingEngine.commitAllocation(req.params.acceptanceId, req.user.user_id);

      // Create alert
      db.alerts.push({
        alert_id:    db.alerts.length + 1,
        hospital_id: acceptance.hospital_id,
        request_id:  acceptance.request_id,
        alert_type:  'INCOMING_REFERRAL',
        message:     `Referral ${acceptance.request_id} ACCEPTED by hospital desk. Resources atomically committed.`,
        status:      'UNREAD',
        created_at:  new Date().toISOString()
      });

      res.json({
        success: true,
        message: `Referral accepted. Resources atomically committed. Ambulance dispatch initiated.`,
        ...result
      });
    } catch (err) {
      res.status(409).json({ error: err.message });
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

    const acceptance = db.hospitalAcceptances.find(a => a.acceptance_id === req.params.acceptanceId);
    if (!acceptance) return res.status(404).json({ error: 'Acceptance record not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== acceptance.hospital_id) {
      return res.status(403).json({ error: 'You can only reject referrals for your own facility.' });
    }

    try {
      const result = await lockingEngine.rejectAndFailover(
        req.params.acceptanceId,
        rejection_reason,
        req.user.user_id
      );
      res.json({
        success: true,
        message: 'Referral rejected. Soft-lock released. System will route to next candidate hospital.',
        ...result
      });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }
);

// ────────────────────────────────────────────────────────────
// GET /api/v1/referrals/active
// All currently active soft-locks
// ────────────────────────────────────────────────────────────
router.get('/active', authenticate, authorize('ADMIN'), (req, res) => {
  res.json({
    success: true,
    active_locks: lockingEngine.getActiveLocks()
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/referrals/history
// All acceptance records (for analytics)
// ────────────────────────────────────────────────────────────
router.get('/history', authenticate, (req, res) => {
  let history = db.hospitalAcceptances;

  // RBAC: Hospital Desk sees only their acceptances
  if (req.user.role === 'HOSPITAL_DESK') {
    history = history.filter(a => a.hospital_id === req.user.hospital_id);
  }

  res.json({ success: true, count: history.length, history });
});

export default router;
