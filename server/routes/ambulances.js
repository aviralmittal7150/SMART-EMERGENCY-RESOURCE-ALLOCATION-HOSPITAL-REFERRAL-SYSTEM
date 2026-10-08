// server/routes/ambulances.js
// EMS Ambulance Fleet Management API — /api/v1/ambulances

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';

const router = express.Router();

const VALID_STATUSES = ['AVAILABLE', 'DISPATCHED', 'IN_TRANSIT', 'MAINTENANCE'];

// GET /api/v1/ambulances
router.get('/', authenticate, (req, res) => {
  const { status, hospital_id } = req.query;
  let ambulances = [...db.ambulances];

  if (status)      ambulances = ambulances.filter(a => a.status === status.toUpperCase());
  if (hospital_id) ambulances = ambulances.filter(a => a.hospital_id === hospital_id);

  const enriched = ambulances.map(a => ({
    ...a,
    hospital_name: db.hospitals.find(h => h.hospital_id === a.hospital_id)?.hospital_name
  }));

  res.json({ success: true, count: enriched.length, ambulances: enriched });
});

// GET /api/v1/ambulances/:ambulanceId
router.get('/:ambulanceId', authenticate, (req, res) => {
  const amb = db.ambulances.find(a => a.ambulance_id === req.params.ambulanceId);
  if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });
  res.json({ success: true, ambulance: amb });
});

// PATCH /api/v1/ambulances/:ambulanceId/status
// Update ambulance transit status + GPS coordinates
router.patch('/:ambulanceId/status',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC', 'HOSPITAL_DESK'),
  (req, res) => {
    const { status, current_lat, current_lng, eta_mins } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const amb = db.ambulances.find(a => a.ambulance_id === req.params.ambulanceId);
    if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });

    const previous = amb.status;
    amb.status = status;
    if (current_lat !== undefined) amb.current_lat = parseFloat(current_lat);
    if (current_lng !== undefined) amb.current_lng = parseFloat(current_lng);
    if (eta_mins    !== undefined) amb.eta_mins    = parseInt(eta_mins, 10);
    amb.updated_at = new Date().toISOString();

    db.auditLog({
      request_id: 'N/A',
      hospital_id: amb.hospital_id,
      event_type: 'AMBULANCE_STATUS_CHANGED',
      previous_state: previous,
      new_state: status,
      actor_role: req.user.role,
      actor_id: req.user.user_id,
      metadata: { ambulance_id: amb.ambulance_id, vehicle_number: amb.vehicle_number }
    });

    res.json({ success: true, ambulance: amb });
  }
);

// GET /api/v1/ambulances/stats/summary
// KPI summary for command center
router.get('/stats/summary', authenticate, (req, res) => {
  const total = db.ambulances.length;
  const available   = db.ambulances.filter(a => a.status === 'AVAILABLE').length;
  const dispatched  = db.ambulances.filter(a => a.status === 'DISPATCHED').length;
  const in_transit  = db.ambulances.filter(a => a.status === 'IN_TRANSIT').length;
  const maintenance = db.ambulances.filter(a => a.status === 'MAINTENANCE').length;

  res.json({ success: true, summary: { total, available, dispatched, in_transit, maintenance } });
});

export default router;
