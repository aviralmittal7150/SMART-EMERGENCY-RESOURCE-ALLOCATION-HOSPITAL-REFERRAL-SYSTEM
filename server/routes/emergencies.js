// server/routes/emergencies.js
// Emergency Request Lifecycle API — /api/v1/emergencies

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies
// Priority-queue ordered list of all emergencies
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { status } = req.query;
  let requests = [...db.emergencyRequests];

  if (status) requests = requests.filter(r => r.status === status.toUpperCase());

  // OS Priority Scheduling — order by priority (1=highest), then by request_time
  requests.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(a.request_time) - new Date(b.request_time);
  });

  const enriched = requests.map(r => ({
    ...r,
    patient: db.patients.find(p => p.patient_id === r.patient_id)
  }));

  res.json({ success: true, count: enriched.length, queue: enriched });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId
// Single emergency with full allocation history
// ────────────────────────────────────────────────────────────
router.get('/:requestId', authenticate, (req, res) => {
  const request = db.emergencyRequests.find(r => r.request_id === req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Emergency request not found.' });

  const patient    = db.patients.find(p => p.patient_id === request.patient_id);
  const allocations = db.resourceAllocations.filter(a => a.request_id === req.params.requestId);
  const acceptances = db.hospitalAcceptances.filter(a => a.request_id === req.params.requestId);
  const auditEvents = db.emergencyHistory.filter(h => h.request_id === req.params.requestId);

  res.json({ success: true, request, patient, allocations, acceptances, auditEvents });
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/emergencies
// Create a new emergency request (Paramedic or Admin)
// ────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC'),
  (req, res) => {
    const {
      patient_name, age, gender = 'UNKNOWN', emergency_type,
      triage_priority = 3, clinical_notes, pickup_lat, pickup_lng,
      contact_phone
    } = req.body;

    if (!patient_name || !emergency_type || !triage_priority) {
      return res.status(400).json({ error: 'Required: patient_name, emergency_type, triage_priority.' });
    }

    if (triage_priority < 1 || triage_priority > 5) {
      return res.status(400).json({ error: 'triage_priority must be between 1 and 5.' });
    }

    const patientId  = `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
    const requestId  = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;

    const patient = {
      patient_id:      patientId,
      full_name:       patient_name,
      age:             parseInt(age, 10) || 35,
      gender:          gender.toUpperCase(),
      emergency_type:  emergency_type.toUpperCase(),
      triage_priority: parseInt(triage_priority, 10),
      contact_phone:   contact_phone || null,
      created_at:      new Date().toISOString()
    };

    const request = {
      request_id:     requestId,
      patient_id:     patientId,
      emergency_type: emergency_type.toUpperCase(),
      priority:       parseInt(triage_priority, 10),
      pickup_lat:     pickup_lat || null,
      pickup_lng:     pickup_lng || null,
      clinical_notes: clinical_notes || '',
      status:         'WAITING',
      request_time:   new Date().toISOString(),
      updated_at:     new Date().toISOString()
    };

    db.patients.push(patient);
    db.emergencyRequests.push(request);

    db.auditLog({
      request_id: requestId,
      event_type: 'REQUEST_CREATED',
      previous_state: null,
      new_state: 'WAITING',
      actor_role: req.user.role,
      actor_id: req.user.user_id,
      metadata: { patient_name, emergency_type, triage_priority }
    });

    res.status(201).json({
      success: true,
      message: `Emergency request ${requestId} created and enqueued in OS Priority Queue.`,
      request_id: requestId,
      patient_id: patientId,
      priority: parseInt(triage_priority, 10),
      status: 'WAITING'
    });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/emergencies/:requestId/status
// Manual status transition (Admin only)
// ────────────────────────────────────────────────────────────
router.patch('/:requestId/status',
  authenticate,
  authorize('ADMIN'),
  (req, res) => {
    const validStatuses = ['NEW','WAITING','MATCHING','ALLOCATED','IN_TREATMENT','COMPLETED','CANCELLED'];
    const { status } = req.body;

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const request = db.emergencyRequests.find(r => r.request_id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const previous = request.status;
    request.status = status;
    request.updated_at = new Date().toISOString();

    // Release resources if COMPLETED or CANCELLED
    if (['COMPLETED', 'CANCELLED'].includes(status)) {
      const allocs = db.resourceAllocations.filter(
        a => a.request_id === req.params.requestId && a.status === 'COMMITTED'
      );
      allocs.forEach(alloc => {
        alloc.status = 'RELEASED';
        alloc.released_at = new Date().toISOString();
        const resource = db.medicalResources.find(r => r.resource_id === alloc.resource_id);
        if (resource) {
          resource.available_capacity += 1;
          resource.version_lock += 1;
        }
      });
    }

    db.auditLog({
      request_id: req.params.requestId,
      event_type: 'STATUS_CHANGED',
      previous_state: previous,
      new_state: status,
      actor_role: 'ADMIN',
      actor_id: req.user.user_id
    });

    res.json({ success: true, request_id: req.params.requestId, previous_status: previous, new_status: status });
  }
);

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId/audit
// Full immutable audit trail for an emergency
// ────────────────────────────────────────────────────────────
router.get('/:requestId/audit', authenticate, (req, res) => {
  const events = db.emergencyHistory
    .filter(h => h.request_id === req.params.requestId)
    .sort((a, b) => new Date(a.event_time) - new Date(b.event_time));

  res.json({ success: true, request_id: req.params.requestId, audit_trail: events });
});

export default router;
