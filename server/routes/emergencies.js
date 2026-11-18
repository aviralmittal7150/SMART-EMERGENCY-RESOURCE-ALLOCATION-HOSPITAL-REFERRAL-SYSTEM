// server/routes/emergencies.js
// Emergency Request Lifecycle API — /api/v1/emergencies

import express from 'express';
import { createHash } from 'node:crypto';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { REQUEST_STATUSES, TERMINAL_STATES } from '../services/lifecycle.js';
import { caseScope, canManageHospital, hospitalStepRight, canReadTreatmentNotes, isAdmin } from '../services/accessPolicy.js';
import { validateBody, validateQuery } from '../services/validation.js';
import { CASE_FIELDS, buildCaseInput } from '../services/caseIntake.js';
import { acceptedHospitalId } from '../services/patientView.js';
import { getTracking } from '../services/tracking/index.js';
import { areaProblem } from '../services/operatingArea.js';
import { dispatchOptions } from '../services/dispatch.js';

const router = express.Router();

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// Which cases the caller may read (server/services/accessPolicy.js): admins all, a desk the cases referred to it
// (pending or accepted), a paramedic the cases they registered or their unit serves.
const scopeOf = req => caseScope(req.user);

// POST /emergencies body (X7): the shared per-case fields (server/services/caseIntake.js, also used by POST /incidents)
// plus the patient's name, pickup point and contact. Lengths match the columns.
const CREATE_SCHEMA = {
  patient_name: { type: 'string', required: true, maxLength: 150 },
  age: CASE_FIELDS.age,
  gender: CASE_FIELDS.gender,
  emergency_type: CASE_FIELDS.emergency_type,
  triage_priority: CASE_FIELDS.triage_priority,
  clinical_notes: CASE_FIELDS.clinical_notes,
  pickup_lat: { type: 'number', nullable: true, min: -90, max: 90 },
  pickup_lng: { type: 'number', nullable: true, min: -180, max: 180 },
  contact_phone: { type: 'string', nullable: true, maxLength: 30, emptyAs: null },
  required_resources: CASE_FIELDS.required_resources,
  required_specialist: CASE_FIELDS.required_specialist
};

// Optional Idempotency-Key header: a client retrying a create (timeout, double click) sends the same
// key and gets the original case back instead of registering the patient twice. Keys are per user.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies
// Priority-queue ordered list of all emergencies
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, validateQuery({ status: { type: 'enum', values: REQUEST_STATUSES, upper: true } }), async (req, res) => {
  // OS Priority Scheduling — ordered by priority (1=highest), then by request_time
  const queue = await store.listRequests({ status: req.validQuery.status, scope: scopeOf(req) });
  res.json({ success: true, count: queue.length, queue });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId/dispatch-options   (Batch 8 P-0.3, ADMIN)
// Suggestions for the Dispatch dialog: the nearest AVAILABLE units in the operating area and the hospitals ranked
// (eligible first, then distance) with reasons. The admin confirms or overrides, then sends
// POST /referrals/initiate { request_id, hospital_id, ambulance_id }.
// -> { success, request_id, status, suggested: { ambulance_id, hospital_id }, ambulances: [{ ambulance_id, vehicle_number,
//      ambulance_type, station_hospital_id, capacity, distance_km, eta_min_estimate }], hospitals: [{ hospital_id,
//      hospital_name, emergency_status, eligible, reasons, distance_km }], note }
// ────────────────────────────────────────────────────────────
router.get('/:requestId/dispatch-options', authenticate, authorize('ADMIN'), async (req, res) => {
  const request = await store.getRequest(req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Emergency request not found.' });
  res.json({ success: true, request_id: request.request_id, status: request.status, ...(await dispatchOptions(store, request)) });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/emergencies/:requestId
// Single emergency with full allocation history
// ────────────────────────────────────────────────────────────
router.get('/:requestId', authenticate, async (req, res) => {
  const detail = await store.getRequestDetail(req.params.requestId, { scope: scopeOf(req) });
  if (!detail) return res.status(404).json({ error: 'Emergency request not found.' });
  res.json({ success: true, ...detail });
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/emergencies
// Create a new emergency request (Admin command centre only)
// ────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ADMIN'),
  validateBody(CREATE_SCHEMA),
  async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1-100 characters: letters, digits, "_", "-", ".", ":".' });
    }

    // Batch 8 (P-0.1): a pickup point outside the operating area (Dehradun) is refused before anything is stored.
    const outside = areaProblem([['pickup_lat / pickup_lng', req.valid.pickup_lat, req.valid.pickup_lng]]);
    if (outside) return res.status(400).json({ error: outside });

    const input = buildCaseInput({ ...req.valid, full_name: req.valid.patient_name });
    if (!input) {
      return res.status(400).json({ error: 'Invalid required_resources or required_specialist.' });
    }
    const parsedPriority = input.request.priority;
    const requirements = { resourceTypes: input.request.required_resource_types, specialist: input.request.required_specialist };
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
    // The maximum claim recorded at intake, per treatment stage (Banker's option A); read back so a replay shows it too.
    const claim = await store.getClaim(created.request_id);
    res.status(201).json({
      success: true,
      message: `Emergency request ${created.request_id} created and enqueued in OS Priority Queue.`,
      request_id: created.request_id,
      patient_id: created.patient_id,
      priority: parsedPriority,
      required_resource_types: requirements.resourceTypes,
      required_specialist: requirements.specialist,
      // A replay reports the case's real current status (it may have been referred or allocated since).
      status: created.status,
      current_stage: claim?.current_stage ?? 1,
      claim: claim?.stages ?? []
    });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/emergencies/:requestId/status   { status }
// Manual status transition (ADMIN only, unchanged). The hospital's treatment steps have their own endpoints below.
// A terminal move (COMPLETED / CANCELLED) releases resources, specialists and the ambulance (the store) and, since
// Batch 8, closes the case's active tracking trip.
// -> { success, request_id, previous_status, new_status, closed_trip_ids }
// ────────────────────────────────────────────────────────────
router.patch('/:requestId/status',
  authenticate,
  authorize('ADMIN'),
  validateBody({ status: { type: 'enum', required: true, values: REQUEST_STATUSES } }),
  async (req, res) => {
    const { status } = req.valid;
    const requestId = req.params.requestId;
    try {
      const result = await store.transitionRequestStatus(requestId, status, actorOf(req));
      const closedTripIds = await closeTripsIfClosed(requestId, result, actorOf(req));

      // Only the in-memory store can leave a lock behind (its cleanup is not transactional).
      if (result.lockCleanupError) {
        return res.status(500).json({
          error: 'Status updated, but releasing the pending referral lock failed. The lock cannot be committed and will be released when its 90-second TTL expires.',
          request_id: requestId,
          previous_status: result.previous,
          new_status: result.status,
          lock_cleanup: 'FAILED'
        });
      }

      res.json({ success: true, request_id: requestId, previous_status: result.previous, new_status: result.status, closed_trip_ids: closedTripIds });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

/**
 * A closed case keeps no active trip: its unit was released by the transition, so the trip is completed where it stands
 * (TRIP_CLOSED), never left holding the unit. A failure here does not undo the committed status change.
 */
async function closeTripsIfClosed(requestId, result, actor) {
  if (result.unchanged || !TERMINAL_STATES.includes(result.status)) return [];
  try {
    return await getTracking().closeCaseTrips(requestId, actor, `case ${result.status}`);
  } catch (err) {
    console.error(`[TRACKING] Could not close the trips of ${requestId}: ${err.message}`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// Batch 8 (P0): the receiving hospital's treatment steps, in order. HOSPITAL_DESK of the hospital holding the case
// (its ACCEPTED referral) only: another hospital's desk 404, ADMIN 403 (it sees every step: GET /:id, /:id/notes,
// /hospitals/:id/patients, case:status, but never performs one), Fleet 403. Rule: accessPolicy.hospitalStepRight.
// Each step is validated and applied under the case's lock in the store, audited, and announced as case:status.
// A repeated click is a no-op answered 200 with unchanged: true (never a second release).
//   POST /:id/arrive            ALLOCATED, not yet arrived -> arrived_at (ambulance handover: the patient's seat is freed)  PATIENT_ARRIVED
//   POST /:id/allocate-bed      { bed_label } arrived, ALLOCATED -> bed_label (unique among the hospital's open cases)    BED_ALLOCATED
//   POST /:id/start-treatment   ALLOCATED + arrived + bed -> IN_TREATMENT, treatment_started_at                          TREATMENT_STARTED
//   POST /:id/notes             { note } while IN_TREATMENT -> a TreatmentUpdate                                       TREATMENT_NOTE
//   POST /:id/complete          IN_TREATMENT -> COMPLETED, treatment_completed_at; releases resources, specialists,
//                               the ambulance link (existing release path) and closes an active trip  TREATMENT_COMPLETED (+ RESOURCE_RELEASED)
//   GET  /:id/notes             ADMIN or the holding desk -> { success, request_id, notes: [{ update_id, note, author_id, hospital_id, created_at }] }
// Step responses: { success, request_id, unchanged, status, previous_status?, milestones: { arrived_at, bed_label,
//   bed_allocated_at, treatment_started_at, treatment_completed_at }, ... } (see each handler).
// ────────────────────────────────────────────────────────────
const BED_LABEL = { type: 'string', required: true, maxLength: 30, pattern: /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/,
  patternMessage: 'bed_label may contain letters, digits, spaces and . _ / - (e.g. "ICU-3", "Ward A-12").' };

/** The holding hospital of a case the desk may act on; sends 404 / 403 and returns null otherwise. */
async function stepHospital(req, res) {
  const detail = await store.getRequestDetail(req.params.requestId, { scope: scopeOf(req) });
  const holder = detail ? acceptedHospitalId(detail.acceptances ?? []) : null;
  const right = hospitalStepRight(req.user, holder);
  if (right === 'ok') return holder;
  if (right === 'not_found' || (isAdmin(req.user) && !detail)) res.status(404).json({ error: 'Emergency request not found.' });
  else res.status(403).json({ error: 'Only the receiving hospital\'s desk performs this step; ADMIN can view it.' });
  return null;
}

function step(handler) {
  return async (req, res) => {
    const hospitalId = await stepHospital(req, res);
    if (!hospitalId) return;
    try {
      await handler(req, res, hospitalId);
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  };
}

const stepRoles = [authenticate, authorize('HOSPITAL_DESK')];

router.post('/:requestId/arrive', ...stepRoles, step(async (req, res, hospitalId) => {
  const requestId = req.params.requestId;
  const result = await store.confirmArrival(requestId, hospitalId, actorOf(req));
  // The handover (Batch 8 P-0.2): the case's active trip ends where it stands and the unit that brought the patient is
  // released (AVAILABLE) through the normal dispatch path, only now that the hospital has confirmed the arrival.
  let closedTripIds = [];
  let releasedUnit = null;
  if (!result.unchanged) {
    try {
      closedTripIds = await getTracking().closeCaseTrips(requestId, actorOf(req), 'handover confirmed by the receiving hospital');
      const unit = (await store.getRequestDetail(requestId))?.request?.assigned_ambulance_id ?? null;
      if (unit) {
        await store.updateAmbulanceStatus(unit, { status: 'AVAILABLE' }, actorOf(req));
        releasedUnit = unit;
      }
    } catch (err) {
      console.error(`[HANDOVER] ${requestId}: the trip or unit could not be released: ${err.message}`);
    }
  }
  res.json({ success: true, request_id: requestId, ...result, closed_trip_ids: closedTripIds, released_ambulance_id: releasedUnit });
}));

router.post('/:requestId/allocate-bed', ...stepRoles, validateBody({ bed_label: BED_LABEL }), step(async (req, res, hospitalId) => {
  const result = await store.allocateBed(req.params.requestId, hospitalId, req.valid.bed_label, actorOf(req));
  res.json({ success: true, request_id: req.params.requestId, ...result });
}));

router.post('/:requestId/start-treatment', ...stepRoles, step(async (req, res, hospitalId) => {
  const result = await store.transitionRequestStatus(req.params.requestId, 'IN_TREATMENT', actorOf(req), {
    hospitalId, treatmentEvent: 'TREATMENT_STARTED',
    guard: row => (!row.arrived_at ? 'Confirm the patient\'s arrival before starting treatment.'
      : !row.bed_label ? 'Allocate a bed before starting treatment.' : null)
  });
  res.json({ success: true, request_id: req.params.requestId, unchanged: result.unchanged, previous_status: result.previous, status: result.status,
    milestones: await milestonesOf(req.params.requestId) });
}));

router.post('/:requestId/notes', ...stepRoles, validateBody({ note: { type: 'string', required: true, maxLength: 500 } }), step(async (req, res, hospitalId) => {
  const note = await store.addTreatmentNote(req.params.requestId, hospitalId, req.valid.note, actorOf(req));
  res.status(201).json({ success: true, request_id: req.params.requestId, note });
}));

router.post('/:requestId/complete', ...stepRoles, step(async (req, res, hospitalId) => {
  const requestId = req.params.requestId;
  const result = await store.transitionRequestStatus(requestId, 'COMPLETED', actorOf(req), {
    hospitalId, treatmentEvent: 'TREATMENT_COMPLETED',
    // ALLOCATED -> COMPLETED is a legal lifecycle move (an admin closure); the hospital completes only a treated case.
    guard: row => (row.status !== 'IN_TREATMENT' ? 'Start treatment before completing it.' : null)
  });
  const closedTripIds = await closeTripsIfClosed(requestId, result, actorOf(req));
  res.json({ success: true, request_id: requestId, unchanged: result.unchanged, previous_status: result.previous, status: result.status,
    released_allocations: result.released_allocations ?? 0, released_specialists: result.released_specialists ?? [],
    closed_trip_ids: closedTripIds, milestones: await milestonesOf(requestId) });
}));

router.get('/:requestId/notes', authenticate, async (req, res) => {
  const detail = await store.getRequestDetail(req.params.requestId, { scope: scopeOf(req) });
  if (!detail || !canReadTreatmentNotes(req.user, acceptedHospitalId(detail.acceptances ?? []))) {
    return res.status(404).json({ error: 'Emergency request not found.' });
  }
  res.json({ success: true, request_id: req.params.requestId, notes: await store.listTreatmentNotes(req.params.requestId) });
});

async function milestonesOf(requestId) {
  const r = await store.getRequest(requestId);
  const iso = t => (t == null ? null : new Date(t).toISOString());
  return { arrived_at: iso(r?.arrived_at), bed_label: r?.bed_label ?? null, bed_allocated_at: iso(r?.bed_allocated_at),
    treatment_started_at: iso(r?.treatment_started_at), treatment_completed_at: iso(r?.treatment_completed_at) };
}

// ────────────────────────────────────────────────────────────
// POST /api/v1/emergencies/:requestId/advance-stage
// Move an allocated case to its next treatment stage (D2-a6): ADMIN, or the desk of the hospital holding it.
// Releases what the next stage no longer needs and allocates what it adds, only if the hospital stays safe.
// ────────────────────────────────────────────────────────────
router.post('/:requestId/advance-stage',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  async (req, res) => {
    const detail = await store.getRequestDetail(req.params.requestId, { scope: scopeOf(req) });
    if (!detail) return res.status(404).json({ error: 'Emergency request not found.' });
    if (req.user.role === 'HOSPITAL_DESK') {
      const holder = detail.acceptances.filter(a => a.status === 'ACCEPTED').at(-1)?.hospital_id;
      if (!holder || !canManageHospital(req.user, holder)) {
        return res.status(403).json({ error: 'Only the desk of the hospital holding this case can advance its stage.' });
      }
    }
    try {
      const result = await store.advanceStage(req.params.requestId, actorOf(req));
      res.json({ success: true, ...result });
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
  const events = await store.listRequestAudit(req.params.requestId, { scope: scopeOf(req) });
  if (events === null) return res.status(404).json({ error: 'Emergency request not found.' });

  res.json({ success: true, request_id: req.params.requestId, audit_trail: events });
});

export default router;
