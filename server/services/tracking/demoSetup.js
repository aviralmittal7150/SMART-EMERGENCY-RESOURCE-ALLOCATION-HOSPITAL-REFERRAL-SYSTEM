// server/services/tracking/demoSetup.js
// "Load sample demo trip" (POST /tracking/demo-setup; ADMIN; never in production). Idempotent and deterministic:
//  1. The sample case is REQ-DT-001 for the fictional patient PAT-DT-001 (is_demo = 1), created through the normal
//     intake path with these fixed ids. Only when that case has been closed (COMPLETED / CANCELLED) is the next number
//     (REQ-DT-002, ...) opened for the same patient; an open sample case is always re-used.
//  2. It is referred and accepted through the NORMAL referral path (soft-lock, then commit: real allocations, the real
//     auto-dispatch and chained audit rows). A case already ALLOCATED / IN_TREATMENT is left as it is.
//  3. The unit (Batch 8): always one CREWED by a demo Fleet login (a demo PARAMEDIC account bound to it), AMB-01 / UNIT-402
//     first, so that crew sees the trip and can confirm the pickup. A crewed unit busy on another DEMO case is freed
//     through the normal path (its demo trip there is abandoned, the unit set AVAILABLE); one on a REAL case is never
//     touched: with no usable crewed unit the set-up is refused (409) and says why. Any other unit on the sample case
//     (e.g. the one the accept auto-dispatched) is released from it, and an active sample trip on another unit abandoned.
//  4. Its trip on that unit: an active trip that is moving or waiting normally is returned unchanged; one that is
//     finished, paused or whose unit left the case is reset to DISPATCHED; otherwise a new demo trip is created.
// Only demo cases, demo trips and the fleet units they use are written. Calls are serialised in this process; across
// processes the fixed ids and the stores' unique active-trip rule keep it duplicate-free.

import { StoreError } from '../../db/storeErrors.js';
import { TERMINAL_STATES, ON_ROAD_AMBULANCE_STATUSES } from '../lifecycle.js';
import { resolveEmergencyRequirements } from '../emergencyRequirements.js';
import { isActive } from './phases.js';

export const DEMO_TRIP = Object.freeze({
  patientId: 'PAT-DT-001',
  requestId: n => `REQ-DT-${String(n).padStart(3, '0')}`,
  maxCases: 999,
  hospitalId: 'H-101',          // its own unit AMB-01 is crewed by the demo paramedic UNIT-402
  preferredUnit: 'AMB-01',
  pickup: [30.3061, 78.0199],   // fictional pickup point in Dehradun, about 2.9 km from H-101 (Clock Tower) towards ISBT
  speedKmh: 90,                 // the demo speed (Batch 8 P-0.2); TRACKING_DEMO_SPEEDUP scales the simulated time
  patient: { full_name: 'Demo Tracking Patient', age: 47, gender: 'UNKNOWN', contact_phone: null },
  emergencyType: 'GENERAL',
  priority: 2
});

let queue = Promise.resolve();

/** Serialised entry point. Returns { trip, request_id, outcome: 'existing' | 'reset' | 'created' }. */
export function setupDemoTrip(engine, actor, options = {}) {
  const run = queue.then(() => setup(engine, actor, options));
  queue = run.catch(() => {});
  return run;
}

async function setup(engine, actor, options) {
  if (process.env.NODE_ENV === 'production') throw new StoreError(403, 'The sample demo trip is not available in production.');
  return sampleTrip(engine, actor, await sampleCase(engine.store, actor), options);
}

/** Usernames of the active PARAMEDIC accounts crewing each unit: Map ambulance_id -> [{ username, is_demo }]. */
export async function crews(store) {
  const { users } = await store.listUsers({ role: 'PARAMEDIC', active: true, limit: 1000 });
  const byUnit = new Map();
  for (const u of users) {
    if (!u.ambulance_id) continue;
    if (!byUnit.has(u.ambulance_id)) byUnit.set(u.ambulance_id, []);
    byUnit.get(u.ambulance_id).push({ username: u.username, is_demo: Number(u.is_demo) === 1 });
  }
  return byUnit;
}

/**
 * The demo-crewed unit for the sample case, AVAILABLE or already on it (freed from another DEMO case if needed).
 * Refuses (409) when every demo-crewed unit is on a real case, out of service or held by a non-demo trip.
 */
async function crewedUnit(engine, actor, requestId) {
  const { store } = engine;
  const crewed = [...(await crews(store)).entries()].filter(([, members]) => members.some(m => m.is_demo)).map(([unitId]) => unitId)
    .sort((a, b) => (Number(b === DEMO_TRIP.preferredUnit) - Number(a === DEMO_TRIP.preferredUnit)) || a.localeCompare(b));
  if (!crewed.length) throw new StoreError(409, 'No ambulance is crewed by a demo Fleet login, so no Fleet user could drive the sample trip. Bind a demo PARAMEDIC account to a unit first.');
  const reasons = [];
  for (const unitId of crewed) {
    const unit = await store.getAmbulance(unitId);
    if (!unit) { reasons.push(`${unitId} does not exist`); continue; }
    const onRoad = ON_ROAD_AMBULANCE_STATUSES.includes(unit.status) && unit.assigned_request_id;
    if (unit.status === 'AVAILABLE' || (onRoad && unit.assigned_request_id === requestId)) return unitId;
    if (!onRoad) { reasons.push(`${unitId} is ${unit.status}`); continue; }
    const other = await store.getRequest(unit.assigned_request_id);
    if (Number(other?.is_demo) !== 1) { reasons.push(`${unitId} is serving the real case ${unit.assigned_request_id}`); continue; }
    const held = (await store.listTrips({ ambulanceId: unitId, activeOnly: true })).filter(t => t.request_id !== requestId);
    if (held.some(t => Number(t.is_demo) !== 1)) { reasons.push(`${unitId} has a non-demo trip`); continue; }
    for (const trip of held) await engine.abandon(trip.trip_id, actor, `Unit taken for the sample demo trip of ${requestId}.`);
    await store.updateAmbulanceStatus(unitId, { status: 'AVAILABLE' }, actor); // off the other demo case, normal path
    return unitId;
  }
  throw new StoreError(409, `No demo-crewed ambulance can take the sample trip (${reasons.join('; ')}). ` +
    'A unit on a real case is never taken over: complete that case or free the unit, then try again.');
}

async function sampleTrip(engine, actor, sample, { speedKmh = DEMO_TRIP.speedKmh } = {}) {
  const { store } = engine;
  // The crewed unit first (refused before any referral if there is none); freed from a demo case it is AVAILABLE, so the
  // accept below auto-dispatches it (H-101's own unit AMB-01 is that hospital's first choice).
  const unitId = await crewedUnit(engine, actor, sample.request_id);
  const request = await ensureAllocated(store, sample, actor);
  const requestId = request.request_id;

  // Only the crewed unit may serve the sample case: an active sample trip on another unit is abandoned and any other
  // unit on the case (e.g. auto-dispatched by the accept) goes back to AVAILABLE, both through the normal paths.
  let latest = (await store.listTrips({ requestId }))[0] ?? null;
  if (latest && isActive(latest) && latest.ambulance_id !== unitId) {
    await engine.abandon(latest.trip_id, actor, `The sample trip moves to the demo-crewed unit ${unitId}.`);
    latest = await store.getTrip(latest.trip_id);
  }
  const onRoad = (await store.getRequestDetail(requestId)).request.assigned_ambulance_id ?? null;
  if (onRoad && onRoad !== unitId) await store.updateAmbulanceStatus(onRoad, { status: 'AVAILABLE' }, actor);

  if (latest && latest.ambulance_id === unitId) {
    if (isActive(latest)) {
      const serving = onRoad === unitId;
      const stuck = Number(latest.paused) === 1 || latest.phase === 'ARRIVED_AT_HOSPITAL' || !serving;
      if (!stuck) return { trip: latest, request_id: requestId, outcome: 'existing' };
    }
    return { trip: await engine.act(latest.trip_id, 'reset', actor), request_id: requestId, outcome: 'reset' };
  }

  const unit = await store.getAmbulance(unitId);
  let start = unit.current_lat !== null && unit.current_lat !== undefined && unit.current_lng !== null && unit.current_lng !== undefined
    ? [Number(unit.current_lat), Number(unit.current_lng)] : null;
  if (!start) {
    const station = await store.getHospital(unit.hospital_id);
    start = [Number(station.location_lat), Number(station.location_lng)];
  }
  const trip = await engine.createTrip({
    request_id: requestId, ambulance_id: unitId, start_lat: start[0], start_lng: start[1], speed_kmh: speedKmh, is_demo: true
  }, actor, { statuses: ['ALLOCATED', 'IN_TREATMENT'] });
  return { trip, request_id: requestId, outcome: 'created' };
}

/** The open sample case: the highest REQ-DT-### if it is still open, else a new one (next number). */
async function sampleCase(store, actor) {
  let current = null;
  let n = 1;
  for (; n <= DEMO_TRIP.maxCases; n += 1) {
    const row = await store.getRequest(DEMO_TRIP.requestId(n));
    if (!row) break;
    current = row;
  }
  if (current && (Number(current.is_demo) !== 1 || current.patient_id !== DEMO_TRIP.patientId)) {
    throw new StoreError(409, `${current.request_id} is not the demo sample case; nothing was changed.`);
  }
  if (current && !TERMINAL_STATES.includes(current.status)) return current;
  if (n > DEMO_TRIP.maxCases) throw new StoreError(409, 'Every sample case id is used; reset the demo database.');

  const requestId = DEMO_TRIP.requestId(n);
  const requirements = resolveEmergencyRequirements(DEMO_TRIP.emergencyType, [], null);
  try {
    await store.createRequest({
      patient: { ...DEMO_TRIP.patient, emergency_type: DEMO_TRIP.emergencyType, triage_priority: DEMO_TRIP.priority },
      request: {
        emergency_type: DEMO_TRIP.emergencyType, required_resource_types: requirements.resourceTypes, required_specialist: requirements.specialist,
        priority: DEMO_TRIP.priority, pickup_lat: DEMO_TRIP.pickup[0], pickup_lng: DEMO_TRIP.pickup[1],
        clinical_notes: 'Fictional sample case for the ambulance live-tracking demo.'
      }
    }, { role: actor.role, id: actor.id }, { fixed: { requestId, patientId: DEMO_TRIP.patientId, isDemo: true } });
  } catch (err) {
    if (!(err instanceof StoreError && err.code === 'EXISTS')) throw err; // created meanwhile by another process: use it
  }
  return store.getRequest(requestId);
}

/** Refer and accept the sample case through the normal referral path unless a hospital already holds it. */
async function ensureAllocated(store, request, actor) {
  if (['ALLOCATED', 'IN_TREATMENT'].includes(request.status)) return request;
  const requestId = request.request_id;
  if (request.status === 'MATCHING') {
    const pending = (await store.getRequestDetail(requestId)).acceptances.find(a => a.status === 'PENDING');
    if (pending) await store.commitReferral(pending.acceptance_id, actor.id);
  } else {
    const hospital = await sampleHospital(store);
    const requirements = resolveEmergencyRequirements(request.emergency_type, request.required_resource_types ?? [], request.required_specialist ?? null);
    const lock = await store.acquireReferralLock(hospital.hospital_id, requestId, requirements.resourceTypes, { initiatedBy: actor.id });
    await store.commitReferral(lock.acceptanceId, actor.id);
  }
  const allocated = await store.getRequest(requestId);
  if (allocated.status !== 'ALLOCATED') throw new StoreError(409, `The sample case ${requestId} could not be accepted (it is ${allocated.status}).`);
  return allocated;
}

/** H-101 unless it is CLOSED; otherwise the first hospital that is not. */
async function sampleHospital(store) {
  const preferred = await store.getHospital(DEMO_TRIP.hospitalId);
  if (preferred && preferred.emergency_status !== 'CLOSED') return preferred;
  const open = (await store.listHospitals()).filter(h => h.emergency_status !== 'CLOSED').sort((a, b) => a.hospital_id.localeCompare(b.hospital_id));
  if (!open.length) throw new StoreError(409, 'Every hospital is CLOSED: the sample case cannot be referred.');
  return open[0];
}
