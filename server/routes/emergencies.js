// server/routes/emergencies.js
// Emergency Request Lifecycle API — /api/v1/emergencies

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';
import { lockingEngine } from '../services/lockingEngine.js';
import {
  VALID_EMERGENCY_TYPES,
  resolveEmergencyRequirements
} from '../services/emergencyRequirements.js';

const router = express.Router();

const ALLOWED_TRANSITIONS = {
  NEW: ['WAITING', 'CANCELLED'],
  WAITING: ['MATCHING', 'CANCELLED'],
  // MATCHING -> ALLOCATED is deliberately absent: allocation only happens through the
  // hospital acceptance handshake (lockingEngine.commitAllocation), never by manual override.
  MATCHING: ['WAITING', 'CANCELLED'],
  ALLOCATED: ['IN_TREATMENT', 'COMPLETED', 'CANCELLED'],
  IN_TREATMENT: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: []
};

// Hospital desks may only see cases referred to their own facility (patient data minimisation).
function canViewRequest(user, requestId) {
  if (user.role !== 'HOSPITAL_DESK') return true;
  return db.hospitalAcceptances.some(a => a.request_id === requestId && a.hospital_id === user.hospital_id);
}

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies
// Priority-queue ordered list of all emergencies
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { status } = req.query;
  let requests = db.emergencyRequests.filter(r => canViewRequest(req.user, r.request_id));

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
  if (!request || !canViewRequest(req.user, request.request_id)) {
    return res.status(404).json({ error: 'Emergency request not found.' });
  }

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
      contact_phone, required_resources = [], required_specialist = null
    } = req.body;

    if (typeof patient_name !== 'string' || !patient_name.trim() || !emergency_type) {
      return res.status(400).json({ error: 'Required: patient_name, emergency_type, triage_priority.' });
    }

    const parsedAge = Number(age);
    const parsedPriority = Number(triage_priority);
    const normalizedType = String(emergency_type).trim().toUpperCase();
    const normalizedGender = String(gender).trim().toUpperCase();
    const requirements = resolveEmergencyRequirements(normalizedType, required_resources, required_specialist);

    if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 120) {
      return res.status(400).json({ error: 'age must be an integer between 0 and 120.' });
    }
    if (!Number.isInteger(parsedPriority) || parsedPriority < 1 || parsedPriority > 5) {
      return res.status(400).json({ error: 'triage_priority must be between 1 and 5.' });
    }
    if (!VALID_EMERGENCY_TYPES.includes(normalizedType)) {
      return res.status(400).json({ error: `Unsupported emergency_type. Must be: ${VALID_EMERGENCY_TYPES.join(', ')}` });
    }
    if (!['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'].includes(normalizedGender)) {
      return res.status(400).json({ error: 'gender must be MALE, FEMALE, OTHER, or UNKNOWN.' });
    }
    if (!requirements) {
      return res.status(400).json({ error: 'Invalid required_resources or required_specialist.' });
    }

    const latitude = pickup_lat === undefined || pickup_lat === null || pickup_lat === '' ? null : Number(pickup_lat);
    const longitude = pickup_lng === undefined || pickup_lng === null || pickup_lng === '' ? null : Number(pickup_lng);
    if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
      || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
      return res.status(400).json({ error: 'pickup_lat/pickup_lng must be valid coordinates.' });
    }

    const patientId  = `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
    let requestId;
    do {
      requestId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
    } while (db.emergencyRequests.some(request => request.request_id === requestId));

    const patient = {
      patient_id:      patientId,
      full_name:       patient_name,
      age:             parsedAge,
      gender:          normalizedGender,
      emergency_type:  normalizedType,
      triage_priority: parsedPriority,
      contact_phone:   contact_phone || null,
      created_at:      new Date().toISOString()
    };

    const request = {
      request_id:     requestId,
      patient_id:     patientId,
      emergency_type:  normalizedType,
      required_resource_types: requirements.resourceTypes,
      required_resources: requirements.resourceTypes,
      required_specialist: requirements.specialist,
      priority:       parsedPriority,
      pickup_lat:     latitude,
      pickup_lng:     longitude,
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
      metadata: {
        patient_name: patient_name.trim(),
        emergency_type: normalizedType,
        triage_priority: parsedPriority,
        required_resource_types: requirements.resourceTypes,
        required_specialist: requirements.specialist
      }
    });

    res.status(201).json({
      success: true,
      message: `Emergency request ${requestId} created and enqueued in OS Priority Queue.`,
      request_id: requestId,
      patient_id: patientId,
      priority: parsedPriority,
      required_resource_types: requirements.resourceTypes,
      required_specialist: requirements.specialist,
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
  async (req, res) => {
    const validStatuses = ['NEW','WAITING','MATCHING','ALLOCATED','IN_TREATMENT','COMPLETED','CANCELLED'];
    const { status } = req.body;

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const request = db.emergencyRequests.find(r => r.request_id === req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const previous = request.status;
    if (previous === status) {
      return res.json({ success: true, request_id: req.params.requestId, previous_status: previous, new_status: status });
    }
    if (!ALLOWED_TRANSITIONS[previous]?.includes(status)) {
      return res.status(409).json({ error: `Invalid lifecycle transition: ${previous} -> ${status}.` });
    }
    request.status = status;
    request.updated_at = new Date().toISOString();

    // Release resources if COMPLETED or CANCELLED
    let lockCleanupError = null;
    const isTerminal = ['COMPLETED', 'CANCELLED'].includes(status);
    // Returning a matching case to the queue abandons its pending handshake too.
    if (isTerminal || (previous === 'MATCHING' && status === 'WAITING')) {
      // The new status is already recorded (synchronously), so any queued acceptance
      // for a terminal request is refused by the locking engine.
      // If the cleanup fails we still release committed resources below, then
      // report the failure; a leftover lock cannot be committed and expires at its TTL.
      try {
        await lockingEngine.cancelPendingForRequest(req.params.requestId, `Request ${status}`);
      } catch (err) {
        lockCleanupError = err;
        console.error('[LIFECYCLE]', err.message);
        db.auditLog({
          request_id: req.params.requestId,
          event_type: 'LOCK_CLEANUP_FAILED',
          previous_state: previous,
          new_state: status,
          actor_role: 'SYSTEM',
          metadata: { error: err.message }
        });
      }
    }

    if (isTerminal) {
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
      db.ambulances
        .filter(ambulance => ambulance.assigned_request_id === req.params.requestId)
        .forEach(ambulance => {
          ambulance.status = 'AVAILABLE';
          delete ambulance.assigned_request_id;
          ambulance.updated_at = new Date().toISOString();
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

    if (lockCleanupError) {
      return res.status(500).json({
        error: 'Status updated, but releasing the pending referral lock failed. The lock cannot be committed and will be released when its 90-second TTL expires.',
        request_id: req.params.requestId,
        previous_status: previous,
        new_status: status,
        lock_cleanup: 'FAILED'
      });
    }

    res.json({ success: true, request_id: req.params.requestId, previous_status: previous, new_status: status });
  }
);

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId/audit
// Full immutable audit trail for an emergency
// ────────────────────────────────────────────────────────────
router.get('/:requestId/audit', authenticate, (req, res) => {
  if (!canViewRequest(req.user, req.params.requestId)) {
    return res.status(404).json({ error: 'Emergency request not found.' });
  }
  const events = db.emergencyHistory
    .filter(h => h.request_id === req.params.requestId)
    .sort((a, b) => new Date(a.event_time) - new Date(b.event_time));

  res.json({ success: true, request_id: req.params.requestId, audit_trail: events });
});

export default router;
