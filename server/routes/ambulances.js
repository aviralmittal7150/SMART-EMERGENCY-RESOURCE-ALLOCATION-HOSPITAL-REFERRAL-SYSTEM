// server/routes/ambulances.js
// EMS Ambulance Fleet Management API — /api/v1/ambulances

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { ambulanceFilter, canAccessAmbulance, dispatchScope, isAdmin } from '../services/accessPolicy.js';
import { validateBody, validateQuery, ID20 } from '../services/validation.js';
import { areaProblem } from '../services/operatingArea.js';

const router = express.Router();

const VALID_STATUSES = ['AVAILABLE', 'DISPATCHED', 'IN_TRANSIT', 'MAINTENANCE'];

// GET /api/v1/ambulances
// Scoped (server/services/accessPolicy.js): admins all units, a desk its hospital's units, a paramedic their own unit.
router.get('/',
  authenticate,
  validateQuery({ status: { type: 'enum', values: VALID_STATUSES, upper: true }, hospital_id: ID20 }),
  async (req, res) => {
    const filter = ambulanceFilter(req.user, req.validQuery.hospital_id);
    const ambulances = filter ? await store.listAmbulances({ status: req.validQuery.status, ...filter }) : [];
    res.json({ success: true, count: ambulances.length, ambulances });
  });

// GET /api/v1/ambulances/stats/summary
// KPI summary for command center
router.get('/stats/summary', authenticate, async (req, res) => {
  res.json({ success: true, summary: await store.ambulanceSummary() });
});

// GET /api/v1/ambulances/:ambulanceId
router.get('/:ambulanceId', authenticate, async (req, res) => {
  const amb = await store.getAmbulance(req.params.ambulanceId);
  if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });
  if (!canAccessAmbulance(req.user, amb)) return res.status(403).json({ error: 'You can only view ambulances in your own scope.' });
  res.json({ success: true, ambulance: amb });
});

// PATCH /api/v1/ambulances/:ambulanceId/status
// Admin-only fleet administration. Crew movement is handled by the audited /tracking trip actions.
router.patch('/:ambulanceId/status',
  authenticate,
  authorize('ADMIN'),
  // Every input is validated before anything is written, so a 4xx never leaves partial state (X7).
  validateBody({
    status: { type: 'enum', required: true, values: VALID_STATUSES },
    request_id: ID20,
    current_lat: { type: 'number', min: -90, max: 90 },
    current_lng: { type: 'number', min: -180, max: 180 },
    eta_mins: { type: 'integer', min: 0, max: 32767 } // Ambulance.eta_mins is SMALLINT
  }),
  async (req, res) => {
    const { status, request_id, current_lat, current_lng, eta_mins } = req.valid;
    // Batch 8 (P-0.1): a unit position outside the operating area (Dehradun) is refused.
    const outside = areaProblem([['current_lat / current_lng', current_lat, current_lng]]);
    if (outside) return res.status(400).json({ error: outside });

    const amb = await store.getAmbulance(req.params.ambulanceId);
    if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });

    // X4: ADMIN any unit; a desk the units stationed at its hospital; a paramedic only the unit they crew.
    if (!canAccessAmbulance(req.user, amb)) {
      return res.status(403).json({
        error: req.user.role === 'PARAMEDIC'
          ? 'Paramedics can only update the ambulance they are assigned to.'
          : 'You can only update ambulances stationed at your own facility.'
      });
    }

    // Round 2, item 1: dispatching to a case needs that case in the caller's dispatch scope. Missing and not visible
    // get the same 404, so a request id's existence is not revealed (the store's own 404 has the same wording).
    if (status === 'DISPATCHED' && !isAdmin(req.user)) {
      if (!request_id) return res.status(400).json({ error: 'request_id is required when dispatching an ambulance.' });
      if (!(await store.caseVisible(request_id, dispatchScope(req.user)))) {
        return res.status(404).json({ error: 'Emergency request not found.' });
      }
    }

    try {
      const ambulance = await store.updateAmbulanceStatus(
        amb.ambulance_id,
        { status, request_id, current_lat, current_lng, eta_mins },
        { role: req.user.role, id: req.user.user_id }
      );
      res.json({ success: true, ambulance });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

export default router;
