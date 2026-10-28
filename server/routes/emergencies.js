// server/routes/emergencies.js
// Emergency Request Lifecycle API — /api/v1/emergencies

import express from 'express';
import { createHash } from 'node:crypto';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { REQUEST_STATUSES } from '../services/lifecycle.js';
import {
  VALID_EMERGENCY_TYPES,
  resolveEmergencyRequirements
} from '../services/emergencyRequirements.js';

const router = express.Router();

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// Hospital desks may only see cases referred to their own facility (patient data minimisation).
const scopeOf = req => (req.user.role === 'HOSPITAL_DESK' ? req.user.hospital_id : undefined);

// Optional Idempotency-Key header: a client retrying a create (timeout, double click) sends the same
// key and gets the original case back instead of registering the patient twice. Keys are per user.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies
// Priority-queue ordered list of all emergencies
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  // OS Priority Scheduling — ordered by priority (1=highest), then by request_time
  const queue = await store.listRequests({ status: req.query.status, hospitalScope: scopeOf(req) });
  res.json({ success: true, count: queue.length, queue });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId
// Single emergency with full allocation history
// ────────────────────────────────────────────────────────────
router.get('/:requestId', authenticate, async (req, res) => {
  const detail = await store.getRequestDetail(req.params.requestId, { hospitalScope: scopeOf(req) });
  if (!detail) return res.status(404).json({ error: 'Emergency request not found.' });
  res.json({ success: true, ...detail });
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/emergencies
// Create a new emergency request (Paramedic or Admin)
// ────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ADMIN', 'PARAMEDIC'),
  async (req, res) => {
    const {
      patient_name, age, gender = 'UNKNOWN', emergency_type,
      triage_priority = 3, clinical_notes, pickup_lat, pickup_lng,
      contact_phone, required_resources = [], required_specialist = null
    } = req.body;

    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1-100 characters: letters, digits, "_", "-", ".", ":".' });
    }

    if (typeof patient_name !== 'string' || !patient_name.trim() || !emergency_type) {
      return res.status(400).json({ error: 'Required: patient_name, emergency_type, triage_priority.' });
    }

    // Match the database column limits so an oversized value is a clear 400, not a storage error.
    if (patient_name.length > 150) {
      return res.status(400).json({ error: 'patient_name must be at most 150 characters.' });
    }
    if (contact_phone !== undefined && contact_phone !== null && String(contact_phone).length > 30) {
      return res.status(400).json({ error: 'contact_phone must be at most 30 characters.' });
    }
    if (clinical_notes !== undefined && clinical_notes !== null && String(clinical_notes).length > 20000) {
      return res.status(400).json({ error: 'clinical_notes must be at most 20000 characters.' });
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

    const input = {
      patient: {
        full_name:       patient_name,
        age:             parsedAge,
        gender:          normalizedGender,
        emergency_type:  normalizedType,
        triage_priority: parsedPriority,
        contact_phone:   contact_phone || null
      },
      request: {
        emergency_type:          normalizedType,
        required_resource_types: requirements.resourceTypes,
        required_specialist:     requirements.specialist,
        priority:                parsedPriority,
        pickup_lat:              latitude,
        pickup_lng:              longitude,
        clinical_notes:          clinical_notes || ''
      }
    };
    // The fingerprint covers the validated input, so a key reused for a different case is detected.
    const idempotency = idempotencyKey === undefined ? null : {
      key: idempotencyKey,
      endpoint: 'POST /emergencies',
      fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex')
    };

    let created;
    try {
      created = await store.createRequest(input, actorOf(req), { idempotency });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
      return;
    }

    if (created.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(201).json({
      success: true,
      message: `Emergency request ${created.request_id} created and enqueued in OS Priority Queue.`,
      request_id: created.request_id,
      patient_id: created.patient_id,
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
    const { status } = req.body;

    if (!REQUEST_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${REQUEST_STATUSES.join(', ')}` });
    }

    try {
      const result = await store.transitionRequestStatus(req.params.requestId, status, actorOf(req));

      // Only the in-memory store can leave a lock behind (its cleanup is not transactional).
      if (result.lockCleanupError) {
        return res.status(500).json({
          error: 'Status updated, but releasing the pending referral lock failed. The lock cannot be committed and will be released when its 90-second TTL expires.',
          request_id: req.params.requestId,
          previous_status: result.previous,
          new_status: result.status,
          lock_cleanup: 'FAILED'
        });
      }

      res.json({ success: true, request_id: req.params.requestId, previous_status: result.previous, new_status: result.status });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId/audit
// Full immutable audit trail for an emergency
// ────────────────────────────────────────────────────────────
router.get('/:requestId/audit', authenticate, async (req, res) => {
  const events = await store.listRequestAudit(req.params.requestId, { hospitalScope: scopeOf(req) });
  if (events === null) return res.status(404).json({ error: 'Emergency request not found.' });

  res.json({ success: true, request_id: req.params.requestId, audit_trail: events });
});

export default router;
