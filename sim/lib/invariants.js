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
// }
// The harness fixture starts every resource with available = total, so every unit not available is
// committed to a case: total - available must equal the committed count (no occupancy from outside).

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
      if (hospitals.size !== 1 && (q.resource_types?.length ?? 0) > 0) {
        fail('ALLOCATION_HOSPITALS', `${q.request_id}: ${q.status} with committed units at ${hospitals.size} hospital(s) (must be exactly 1)`);
      }
      if (q.resource_types && mine.length !== q.resource_types.length) {
        fail('ALLOCATION_COUNT', `${q.request_id}: ${mine.length} committed unit(s) for ${q.resource_types.length} required resource type(s)`);
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
  return violations;
}
