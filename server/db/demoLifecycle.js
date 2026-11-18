// server/db/demoLifecycle.js
// The recorded history of the demo seed's cases, shared by the in-memory seed (server/db/seed.js) and the MySQL demo
// seed (server/db/init.js), so both stores start from the same consistent state:
//   REQ-8901 (PAT-001)  ALLOCATED: referred to and ACCEPTED by H-103 (Premnagar Heart & Neuro, demo), its ICU bed
//            and ventilator committed there, and unit AMB-02 (stationed at H-103) dispatched and now IN_TRANSIT to it.
//   REQ-8902 (PAT-002) IN_TREATMENT: ACCEPTED by H-105 (Sahastradhara Emergency Centre, demo), ICU bed and OT committed, its trauma
//            surgeon DR-013 assigned (exclusive, D3-B) and now IN_PROCEDURE; no unit (the patient is in treatment).
//   REQ-8903 (PAT-003) WAITING: registered, never referred.
// The capacity counts of the seed already exclude the committed units (available = free), so the allocations below only
// record which case holds which unit. Every audit event is written through each store's normal chained audit path, so
// GET /api/v1/audit/verify verifies a freshly seeded store. All data is fictional.

export const DEMO_ACCEPTANCES = Object.freeze([
  { acceptance_id: 'ACC-DEMO8901', request_id: 'REQ-8901', hospital_id: 'H-103', status: 'ACCEPTED', response_time_sec: 34 },
  { acceptance_id: 'ACC-DEMO8902', request_id: 'REQ-8902', hospital_id: 'H-105', status: 'ACCEPTED', response_time_sec: 41 }
]);

export const DEMO_ALLOCATIONS = Object.freeze([
  { allocation_id: 'ALLOC-D8901-ICU', request_id: 'REQ-8901', hospital_id: 'H-103', resource_id: 'RES-103-ICU' },
  { allocation_id: 'ALLOC-D8901-VNT', request_id: 'REQ-8901', hospital_id: 'H-103', resource_id: 'RES-103-VNT' },
  { allocation_id: 'ALLOC-D8902-ICU', request_id: 'REQ-8902', hospital_id: 'H-105', resource_id: 'RES-105-ICU' },
  { allocation_id: 'ALLOC-D8902-OT', request_id: 'REQ-8902', hospital_id: 'H-105', resource_id: 'RES-105-OT' }
]);

export const DEMO_ASSIGNMENTS = Object.freeze([
  { assignment_id: 'DA-DEMO8902', doctor_id: 'DR-013', request_id: 'REQ-8902', hospital_id: 'H-105', acceptance_id: 'ACC-DEMO8902' }
]);

/** Doctor status and unit state that follow from the history above. */
export const DEMO_DOCTOR_STATUS = Object.freeze({ 'DR-013': 'IN_PROCEDURE' });
/** Their status before the demo history (what a production hospital bootstrap writes). */
export const DEMO_DOCTOR_BASE_STATUS = Object.freeze({ 'DR-013': 'AVAILABLE' });
/** Unit status before the demo history: a production bootstrap starts AMB-02 at its station, not on the road. */
export const DEMO_UNIT_BASE_STATUS = Object.freeze({ 'AMB-02': 'AVAILABLE' });
export const DEMO_UNIT_ASSIGNMENTS = Object.freeze([
  { ambulance_id: 'AMB-02', request_id: 'REQ-8901', destination_hospital_id: 'H-103', status: 'IN_TRANSIT' }
]);

/** The audit events, in order (each store adds the time and the hash chain through its own audit path). */
export const DEMO_AUDIT_EVENTS = Object.freeze([
  { request_id: 'REQ-8901', event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING', actor_role: 'SYSTEM', actor_id: 'DEMO-SEED',
    metadata: { emergency_type: 'CARDIAC', triage_priority: 1, demo: true } },
  { request_id: 'REQ-8902', event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING', actor_role: 'SYSTEM', actor_id: 'DEMO-SEED',
    metadata: { emergency_type: 'TRAUMA', triage_priority: 2, demo: true } },
  { request_id: 'REQ-8903', event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING', actor_role: 'SYSTEM', actor_id: 'DEMO-SEED',
    metadata: { emergency_type: 'RESPIRATORY', triage_priority: 3, demo: true } },
  { request_id: 'REQ-8901', hospital_id: 'H-103', event_type: 'LOCK_ACQUIRED', previous_state: 'WAITING', new_state: 'PENDING_ACCEPTANCE', actor_role: 'SYSTEM',
    metadata: { acceptanceId: 'ACC-DEMO8901', resourceIds: ['RES-103-ICU', 'RES-103-VNT'], stage: 1 } },
  { request_id: 'REQ-8901', hospital_id: 'H-103', event_type: 'ALLOCATION_COMMITTED', previous_state: 'PENDING_ACCEPTANCE', new_state: 'ALLOCATED',
    actor_role: 'HOSPITAL_DESK', actor_id: 'USER-HSP-103', metadata: { acceptanceId: 'ACC-DEMO8901', ambulance_id: 'AMB-02', specialist_id: null } },
  { request_id: 'REQ-8901', hospital_id: 'H-103', event_type: 'AMBULANCE_STATUS_CHANGED', previous_state: 'DISPATCHED', new_state: 'IN_TRANSIT',
    actor_role: 'SYSTEM', actor_id: 'DEMO-SEED', metadata: { ambulance_id: 'AMB-02', vehicle_number: 'DL-01-EM-0002', released_from_request: null } },
  { request_id: 'REQ-8902', hospital_id: 'H-105', event_type: 'LOCK_ACQUIRED', previous_state: 'WAITING', new_state: 'PENDING_ACCEPTANCE', actor_role: 'SYSTEM',
    metadata: { acceptanceId: 'ACC-DEMO8902', resourceIds: ['RES-105-ICU', 'RES-105-OT'], specialistId: 'DR-013', stage: 1 } },
  { request_id: 'REQ-8902', hospital_id: 'H-105', event_type: 'ALLOCATION_COMMITTED', previous_state: 'PENDING_ACCEPTANCE', new_state: 'ALLOCATED',
    actor_role: 'HOSPITAL_DESK', actor_id: 'USER-HSP-105', metadata: { acceptanceId: 'ACC-DEMO8902', ambulance_id: null, specialist_id: 'DR-013' } },
  { request_id: 'REQ-8902', event_type: 'STATUS_CHANGED', previous_state: 'ALLOCATED', new_state: 'IN_TREATMENT', actor_role: 'ADMIN', actor_id: 'USER-ADM-001',
    metadata: { released_allocations: 0, capped_releases: 0 } }
]);
