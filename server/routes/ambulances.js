// server/routes/ambulances.js
// EMS Ambulance Fleet Management API — /api/v1/ambulances

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';

const router = express.Router();

const VALID_STATUSES = ['AVAILABLE', 'DISPATCHED', 'IN_TRANSIT', 'MAINTENANCE'];

// GET /api/v1/ambulances
router.get('/', authenticate, async (req, res) => {
  const { status, hospital_id } = req.query;
  const ambulances = await store.listAmbulances({ status, hospitalId: hospital_id });
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
  res.json({ success: true, ambulance: amb });
});

// PATCH /api/v1/ambulances/:ambulanceId/status
// Update ambulance transit status + GPS coordinates
router.patch('/:ambulanceId/status',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC', 'HOSPITAL_DESK'),
  async (req, res) => {
    const { status, request_id, current_lat, current_lng, eta_mins } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const amb = await store.getAmbulance(req.params.ambulanceId);
    if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });

    // Hospital desks may only manage units stationed at their own facility.
    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== amb.hospital_id) {
      return res.status(403).json({ error: 'You can only update ambulances stationed at your own facility.' });
    }

    // Validate every input before anything is written, so a 4xx never leaves partial state.
    let latitude;
    let longitude;
    let eta;
    if (current_lat !== undefined) {
      latitude = Number(current_lat);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return res.status(400).json({ error: 'current_lat must be a valid latitude.' });
    }
    if (current_lng !== undefined) {
      longitude = Number(current_lng);
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return res.status(400).json({ error: 'current_lng must be a valid longitude.' });
    }
    if (eta_mins !== undefined) {
      eta = Number(eta_mins);
      if (!Number.isInteger(eta) || eta < 0 || eta > 32767) return res.status(400).json({ error: 'eta_mins must be a non-negative integer.' });
    }

    try {
      const ambulance = await store.updateAmbulanceStatus(
        amb.ambulance_id,
        { status, request_id, current_lat: latitude, current_lng: longitude, eta_mins: eta },
        { role: req.user.role, id: req.user.user_id }
      );
      res.json({ success: true, ambulance });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

export default router;
