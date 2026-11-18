// sim/lib/invariants.js
// Safety invariants checked after every harness phase. A pure function over a backend-neutral snapshot,
// so it is unit-tested with deliberately corrupted snapshots (tests/sim_unit.test.js).
//
// snapshot = {
//   resources:  [{ resource_id, hospital_id, resource_type, total, available, locked }],
//   softLocks:  [{ resource_id, request_id }]      one row per soft-locked unit (pending referral)
//   committed:  [{ resource_id, request_id, hospital_id }]   one row per unit committed to a case
//   pending:    [{ acceptance_id, request_id, hospital_id }] PENDING referrals
//   requests:   [{ request_id, status, resource_types }]
//   ambulances: [{ ambulance_id, status, assigned_request_id }]
//   doctors:    [{ doctor_id, status }]                                      (Phase 3 Step 3; optional)
//   hospitalSafety: [{ hospital_id, safe, explanation, anomalies }]          (Phase 3 Step 4; optional)
// requests[].stage_types (optional, Step 4): the physical types of the case's CURRENT treatment stage. An
// allocated case holds exactly those (a staged TRAUMA case holds its OT in stage 1, its ICU bed in stage 2).
//   assignments:[{ doctor_id, request_id, hospital_id, acceptance_id, status }] DoctorAssignment rows (optional)
// }
// requests[].specialist (optional) is the case's required specialist; only EXCLUSIVE_SPECIALISTS are reserved.
// The harness fixture starts every resource with available = total, so every unit not available is
// committed to a case: total - available must equal the committed count (no occupancy from outside).

import { EXCLUSIVE_SPECIALISTS } from '../../server/services/emergencyRequirements.js';

const ACTIVE_ALLOCATED = ['ALLOCATED', 'IN_TREATMENT'];
const TERMINAL = ['COMPLETED', 'CANCELLED'];
const QUEUED = ['NEW', 'WAITING', 'MATCHING'];
const ON_ROAD = ['DISPATCHED', 'IN_TRANSIT'];

const countBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());

export function checkInvariants(snapshot) {
  const violations = [];
  const fail = (code, message) => violations.push({ code, message });
  const softByResource = countBy(snapshot.softLocks, 'resource_id');
  const committedByResource = countBy(snapshot.committed, 'resource_id');
  const pendingByRequest = countBy(snapshot.pending, 'request_id');
  const softByRequest = countBy(snapshot.softLocks, 'request_id');

  for (const r of snapshot.resources) {
    const id = `${r.hospital_id}/${r.resource_type}`;
    if (!(r.locked >= 0 && r.locked <= r.available && r.available <= r.total)) {
      fail('CAPACITY_BOUNDS', `${id}: expected 0 <= locked <= available <= total, got locked=${r.locked} available=${r.available} total=${r.total}`);
    }
    const soft = softByResource.get(r.resource_id) || 0;
    if (soft !== r.locked) fail('LOCKED_MISMATCH', `${id}: locked_capacity=${r.locked} but ${soft} soft-locked unit(s) are held by pending referrals`);
    const committed = committedByResource.get(r.resource_id) || 0;
    if (committed > r.total) fail('DOUBLE_ALLOCATION', `${id}: ${committed} units committed but total capacity is ${r.total}`);
    if (r.total - r.available !== committed) {
      fail('IN_USE_MISMATCH', `${id}: total-available=${r.total - r.available} but ${committed} unit(s) are committed to cases (leaked or double-counted capacity)`);
    }
  }

  for (const q of snapshot.requests) {
    const pending = pendingByRequest.get(q.request_id) || 0;
    const mine = snapshot.committed.filter(c => c.request_id === q.request_id);
    const soft = softByRequest.get(q.request_id) || 0;
    if (pending > 1) fail('MULTIPLE_PENDING', `${q.request_id}: ${pending} pending referrals (at most 1 allowed)`);
    if ((q.status === 'MATCHING') !== (pending === 1)) {
      fail('MATCHING_STATE', `${q.request_id}: status ${q.status} with ${pending} pending referral(s) (MATCHING must mean exactly one)`);
    }
    if (soft > 0 && pending === 0) fail('ORPHAN_SOFT_LOCK', `${q.request_id}: holds ${soft} soft-locked unit(s) without a pending referral`);
    if (ACTIVE_ALLOCATED.includes(q.status)) {
      const hospitals = new Set(mine.map(c => c.hospital_id));
      const expected = q.stage_types ?? q.resource_types;
      if (hospitals.size !== 1 && (expected?.length ?? 0) > 0) {
        fail('ALLOCATION_HOSPITALS', `${q.request_id}: ${q.status} with committed units at ${hospitals.size} hospital(s) (must be exactly 1)`);
      }
      if (expected && mine.length !== expected.length) {
        fail('ALLOCATION_COUNT', `${q.request_id}: ${mine.length} committed unit(s) for ${expected.length} resource type(s) of its current stage`);
      }
    } else if (mine.length) {
      fail('UNEXPECTED_ALLOCATION', `${q.request_id}: status ${q.status} but still holds ${mine.length} committed unit(s)`);
    }
    if (TERMINAL.includes(q.status) && (pending || soft)) {
      fail('TERMINAL_HOLDS', `${q.request_id}: ${q.status} but still has ${pending} pending referral(s) and ${soft} soft-locked unit(s)`);
    }
    if (!QUEUED.includes(q.status) && !ACTIVE_ALLOCATED.includes(q.status) && !TERMINAL.includes(q.status)) {
      fail('UNKNOWN_STATUS', `${q.request_id}: unknown status ${q.status}`);
    }
  }

  const statusOf = new Map(snapshot.requests.map(q => [q.request_id, q.status]));
  const onRoadByRequest = countBy(snapshot.ambulances.filter(a => ON_ROAD.includes(a.status) && a.assigned_request_id), 'assigned_request_id');
  for (const [requestId, units] of onRoadByRequest) {
    if (units > 1) fail('MULTIPLE_AMBULANCES', `${requestId}: ${units} on-road ambulances assigned (at most 1)`);
    const status = statusOf.get(requestId);
    if (status !== undefined && !ACTIVE_ALLOCATED.includes(status)) {
      fail('AMBULANCE_STATE', `${requestId}: an on-road ambulance is assigned but the case is ${status}`);
    }
  }
  for (const a of snapshot.ambulances) {
    if (!ON_ROAD.includes(a.status) && a.assigned_request_id && TERMINAL.includes(statusOf.get(a.assigned_request_id))) {
      fail('AMBULANCE_STALE_ASSIGNMENT', `${a.ambulance_id}: ${a.status} but still assigned to closed case ${a.assigned_request_id}`);
    }
  }
  checkSpecialists(snapshot, fail);
  // Banker's (Step 4): the harness never edits capacity, so every hospital must stay SAFE, and no case may
  // hold more than its recorded claim.
  // Step 5: the audit hash chain verifies in full after every phase.
  if (snapshot.auditChain && !snapshot.auditChain.valid) {
    fail('AUDIT_CHAIN', `audit chain broken: ${JSON.stringify(snapshot.auditChain.first_break)}`);
  }
  for (const h of snapshot.hospitalSafety ?? []) {
    if (!h.safe) fail('BANKER_UNSAFE', `${h.hospital_id}: ${h.explanation}`);
    for (const a of h.anomalies ?? []) fail('CLAIM_EXCEEDED', `${h.hospital_id}/${a.id}: holds more ${a.types.join(', ')} than its claim`);
  }
  return violations;
}

/**
 * Exclusive specialists (D3-B): one active assignment per doctor; the doctor's status mirrors it; a pending
 * referral of a case that needs one holds exactly one reservation, an allocated case exactly one assignment
 * at its allocating hospital, and every other case none.
 */
function checkSpecialists(snapshot, fail) {
  const doctors = snapshot.doctors ?? [];
  const assignments = snapshot.assignments ?? [];
  const active = assignments.filter(a => a.status === 'LOCKED' || a.status === 'COMMITTED');
  const activeByDoctor = countBy(active, 'doctor_id');
  for (const [doctorId, n] of activeByDoctor) {
    if (n > 1) fail('DOUBLE_BOOKED_SPECIALIST', `${doctorId}: ${n} active assignments (at most 1)`);
  }

  const assignmentOf = new Map(active.map(a => [a.doctor_id, a]));
  for (const d of doctors) {
    const a = assignmentOf.get(d.doctor_id);
    const expected = !a ? null : a.status === 'LOCKED' ? ['RESERVED'] : ['ASSIGNED', 'IN_PROCEDURE'];
    if (expected && !expected.includes(d.status)) {
      fail('SPECIALIST_STATUS', `${d.doctor_id}: ${d.status} but holds a ${a.status} assignment for ${a.request_id} (expected ${expected.join(' or ')})`);
    } else if (!expected && ['RESERVED', 'ASSIGNED'].includes(d.status)) {
      fail('SPECIALIST_STATUS', `${d.doctor_id}: ${d.status} without an active assignment`);
    }
  }

  const pendingOf = new Map(snapshot.pending.map(p => [p.request_id, p]));
  for (const q of snapshot.requests) {
    const mine = active.filter(a => a.request_id === q.request_id);
    const locked = mine.filter(a => a.status === 'LOCKED');
    const committed = mine.filter(a => a.status === 'COMMITTED');
    const exclusive = EXCLUSIVE_SPECIALISTS.includes(q.specialist);
    // Step 4: only a case whose CURRENT stage claims the specialist holds one (TRAUMA releases its surgeon in stage 2).
    const stageNeedsSpecialist = q.stage_specialist !== undefined ? Boolean(q.stage_specialist) : exclusive;
    const pending = pendingOf.get(q.request_id);
    const where = `${q.request_id} (${q.status}, needs ${q.specialist ?? 'no specialist'})`;
    if (locked.some(a => !pending || a.acceptance_id !== pending.acceptance_id || a.hospital_id !== pending.hospital_id)) {
      fail('SPECIALIST_ASSIGNMENT', `${where}: a reservation does not belong to the case's pending referral`);
    }
    if (q.status === 'MATCHING' && exclusive && locked.length !== 1) {
      fail('SPECIALIST_ASSIGNMENT', `${where}: pending referral holds ${locked.length} specialist reservation(s) (expected 1)`);
    }
    if (ACTIVE_ALLOCATED.includes(q.status)) {
      const hospitals = new Set(snapshot.committed.filter(c => c.request_id === q.request_id).map(c => c.hospital_id));
      if (stageNeedsSpecialist && committed.length !== 1) {
        fail('SPECIALIST_ASSIGNMENT', `${where}: ${committed.length} assigned specialist(s) (expected 1)`);
      }
      if (!stageNeedsSpecialist && committed.length) {
        fail('SPECIALIST_ASSIGNMENT', `${where}: still holds ${committed.length} specialist(s) its current stage does not claim`);
      }
      if (committed.some(a => hospitals.size && !hospitals.has(a.hospital_id))) {
        fail('SPECIALIST_ASSIGNMENT', `${where}: the assigned specialist is not at the allocating hospital`);
      }
    } else if (committed.length) {
      fail('SPECIALIST_ASSIGNMENT', `${where}: still holds ${committed.length} assigned specialist(s)`);
    }
    if (!exclusive && mine.length) fail('SPECIALIST_ASSIGNMENT', `${where}: holds a specialist assignment it does not need`);
  }
}
