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
    const { status, request_id, current_lat, current_lng, eta_mins } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const amb = db.ambulances.find(a => a.ambulance_id === req.params.ambulanceId);
    if (!amb) return res.status(404).json({ error: 'Ambulance not found.' });

    // Hospital desks may only manage units stationed at their own facility.
    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== amb.hospital_id) {
      return res.status(403).json({ error: 'You can only update ambulances stationed at your own facility.' });
    }

    // Validate every input before mutating anything, so a 4xx never leaves partial state.
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
      if (!Number.isInteger(eta) || eta < 0) return res.status(400).json({ error: 'eta_mins must be a non-negative integer.' });
    }

    if (status === 'DISPATCHED') {
      if (!request_id) return res.status(400).json({ error: 'request_id is required when dispatching an ambulance.' });
      const request = db.emergencyRequests.find(item => item.request_id === request_id);
      if (!request) return res.status(404).json({ error: 'Emergency request not found.' });
      const accepted = db.hospitalAcceptances.some(a => a.request_id === request_id && a.status === 'ACCEPTED');
      if (!['ALLOCATED', 'IN_TREATMENT'].includes(request.status) || !accepted) {
        return res.status(409).json({ error: 'Ambulance dispatch requires an accepted emergency referral.' });
      }
      if (amb.status !== 'AVAILABLE') {
        return res.status(409).json({ error: 'Ambulance is not available for dispatch.' });
      }
      const alreadyAssigned = db.ambulances.find(a => a.ambulance_id !== amb.ambulance_id && a.assigned_request_id === request_id);
      if (alreadyAssigned) {
        return res.status(409).json({ error: `Request ${request_id} already has ambulance ${alreadyAssigned.ambulance_id} assigned.` });
      }
    }

    const previous = amb.status;
    amb.status = status;
    if (status === 'DISPATCHED') amb.assigned_request_id = request_id;
    if (status === 'AVAILABLE') delete amb.assigned_request_id;
    if (latitude !== undefined) amb.current_lat = latitude;
    if (longitude !== undefined) amb.current_lng = longitude;
    if (eta !== undefined) amb.eta_mins = eta;
    amb.updated_at = new Date().toISOString();

    db.auditLog({
      request_id: status === 'DISPATCHED' ? request_id : null,
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
