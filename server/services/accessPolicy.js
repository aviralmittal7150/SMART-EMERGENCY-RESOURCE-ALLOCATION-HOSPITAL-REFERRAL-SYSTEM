// server/services/accessPolicy.js
// ONE read/write scoping policy for the REST routes and the Socket.IO handlers (review finding X5; Batch 6 portals).
// Every route and socket handler asks this module; none decides scoping on its own.
//
//   ADMIN          everything, including account management (/admin/users), audit verification and the
//                  history/forecast analytics.
//   DISPATCHER     the command-centre operator: creates cases; reads every case, its detail and audit trail; refers
//                  any case; reads every hospital in full (rosters included) and every ambulance; dispatches or changes
//                  any unit; dashboard, KPIs, active locks; the command-centre socket stream for cases. NOT: accept or
//                  reject referrals, change a case's status, hospital status/resources, doctors, accounts,
//                  /analytics/history|forecast|audit|referrals, /audit/verify, and not the admin-only audit stream.
//   HOSPITAL_DESK  its own hospital in full (roster, resources, ambulances, safety); the cases that have a PENDING or
//                  ACCEPTED referral to its hospital; the referrals to its hospital; socket room hospital:<id>.
//   PARAMEDIC      the cases they registered or whose assigned ambulance is theirs; the referrals they initiated;
//                  their own ambulance (and only that unit's status may be changed by them).
//   PATIENT        ONLY GET /auth/me and the read-only /patient/* API (their own patient profile and cases, redacted,
//                  and the simulated tracking of their own case); every other endpoint is 403. Socket: user:<id> only,
//                  receiving patient:case_update and patient:tracking for their cases.
//   Ambulance trips (Batch 7, /tracking): ADMIN and DISPATCHER every trip and every action; a desk reads the trips to
//                  its hospital; a paramedic reads its own unit's ACTIVE trips only (not an earlier crew's finished trips,
//                  with their patient and pickup point) and may start / pick up / complete them.
//   every staff role  the public hospital summary used for recommendation and the network-wide aggregate counts.
//
// Socket rooms: user:<user_id> (everyone), staff (every staff role: KPIs, snapshots), command_center (ADMIN and
// DISPATCHER: lock/allocation events and case audit entries), admin (ADMIN only: audit entries without a case, e.g.
// account, hospital and roster changes), hospital:<id> (a desk), ambulance:<id> (the paramedic crewing that unit).
//
// Case scopes passed to the stores: { kind: 'all' } | { kind: 'hospital', hospitalId, statuses? } |
// { kind: 'user', userId, ambulanceId } | { kind: 'patient', patientId } | { kind: 'none' }. Anything unexpected fails
// closed ('none').

import { STAFF_ROLES } from './accounts.js';

export const ALL = Object.freeze({ kind: 'all' });
export const NONE = Object.freeze({ kind: 'none' });

const deskHospital = user => (user?.role === 'HOSPITAL_DESK' && typeof user.hospital_id === 'string' ? user.hospital_id : null);
export const isAdmin = user => user?.role === 'ADMIN';
export const isDispatcher = user => user?.role === 'DISPATCHER';
export const isPatient = user => user?.role === 'PATIENT';
export const isStaff = user => STAFF_ROLES.includes(user?.role);
/** ADMIN or DISPATCHER: the network-wide operational view. */
export const isCommandCenter = user => isAdmin(user) || isDispatcher(user);

/** Which emergency cases (and their audit trails) the user may read. */
export function caseScope(user) {
  if (isCommandCenter(user)) return ALL;
  const hospitalId = deskHospital(user);
  if (hospitalId) return { kind: 'hospital', hospitalId };
  if (user?.role === 'PARAMEDIC' && typeof user.user_id === 'string') {
    return { kind: 'user', userId: user.user_id, ambulanceId: user.ambulance_id ?? null };
  }
  if (isPatient(user) && typeof user.patient_id === 'string' && user.patient_id) return { kind: 'patient', patientId: user.patient_id };
  return NONE;
}

/**
 * Which cases the user may dispatch a unit to (round 2, item 1): ADMIN / DISPATCHER any; a desk only a case ACCEPTED by
 * its own hospital; a paramedic the cases in their case scope. A case outside this scope is answered like a missing one.
 */
export function dispatchScope(user) {
  if (isCommandCenter(user)) return ALL;
  const hospitalId = deskHospital(user);
  if (hospitalId) return { kind: 'hospital', hospitalId, statuses: ['ACCEPTED'] };
  if (isPatient(user)) return NONE;
  return caseScope(user);
}

/** Manage a hospital (status / resources / doctors / safety writes): ADMIN, or the desk of that hospital. */
export const canManageHospital = (user, hospitalId) => isAdmin(user) || (deskHospital(user) !== null && deskHospital(user) === hospitalId);
/** Read a hospital in full (roster, active allocations, Banker's safety): ADMIN, DISPATCHER, or the desk of that hospital. */
export const canReadHospitalDetail = (user, hospitalId) => isDispatcher(user) || canManageHospital(user, hospitalId);

/** Doctor list filter: { hospitalId } (undefined = all), or null = the user may see no roster. */
export function doctorFilter(user, requestedHospitalId) {
  if (isCommandCenter(user)) return { hospitalId: requestedHospitalId };
  const own = deskHospital(user);
  return own ? { hospitalId: own } : null;
}
export const canSeeDoctor = (user, doctor) => Boolean(doctor) && canReadHospitalDetail(user, doctor.hospital_id);

/** Ambulance list filter: { hospitalId?, ambulanceId? }, or null = no unit is visible. */
export function ambulanceFilter(user, requestedHospitalId) {
  if (isCommandCenter(user)) return { hospitalId: requestedHospitalId };
  const own = deskHospital(user);
  if (own) return { hospitalId: own };
  if (user?.role === 'PARAMEDIC' && user.ambulance_id) return { ambulanceId: user.ambulance_id };
  return null;
}
/** Read or change one unit: ADMIN / DISPATCHER any; a desk the units stationed at its hospital; a paramedic their own unit (X4). */
export function canAccessAmbulance(user, ambulance) {
  if (!ambulance) return false;
  if (isCommandCenter(user)) return true;
  const own = deskHospital(user);
  if (own) return ambulance.hospital_id === own;
  return user?.role === 'PARAMEDIC' && Boolean(user.ambulance_id) && user.ambulance_id === ambulance.ambulance_id;
}

// ── Batch 8: the hospital treatment workflow, patients list, incidents ─────────────────────────────────────────────
/**
 * The hospital steps on a case (confirm arrival, allocate bed, start treatment, progress note, complete treatment):
 * ONLY the desk of the hospital holding the case (its latest ACCEPTED referral). Returns 'ok' | 'not_found' |
 * 'forbidden'. Another hospital's desk: 'not_found' (answered like a missing case). ADMIN: 'forbidden' (it sees every
 * step but never performs one: the receiving hospital owns its operational record). Fleet and anyone else: 'forbidden'.
 */
export function hospitalStepRight(user, holderHospitalId) {
  const own = deskHospital(user);
  if (!own) return 'forbidden';
  return holderHospitalId && holderHospitalId === own ? 'ok' : 'not_found';
}

/** Read a case's treatment notes: ADMIN, or the desk of the hospital holding the case. */
export const canReadTreatmentNotes = (user, holderHospitalId) => isAdmin(user) || (Boolean(holderHospitalId) && deskHospital(user) === holderHospitalId);

/** GET /hospitals/:id/patients: ADMIN, or the desk of that hospital. */
export const canReadHospitalPatients = (user, hospitalId) => canManageHospital(user, hospitalId);

/**
 * /incidents (Batch 8 P1): ADMIN only. A desk sees an incident's victims only as its own patients (GET
 * /hospitals/:id/patients), Fleet only the cases its unit serves (case scope). Anything else is answered like a missing one.
 */
export function canSeeIncident(user, incident) {
  return Boolean(incident) && isAdmin(user);
}

/**
 * The rooms that receive `case:status` (every case status change): the command centre, the desk of the hospital
 * holding the case (if any) and the crews of the units serving it (if any). Never any other hospital or unit.
 */
export function caseStatusRooms({ hospitalId = null, ambulanceIds = [] } = {}) {
  const rooms = [COMMAND_CENTER];
  if (hospitalId) rooms.push(hospitalRoom(hospitalId));
  for (const id of ambulanceIds) if (id) rooms.push(ambulanceRoom(id));
  return rooms;
}

/** Referral (HospitalAcceptance) list filter for GET /referrals/history. */
export function referralFilter(user) {
  if (isCommandCenter(user)) return {};
  const own = deskHospital(user);
  if (own) return { hospitalId: own };
  if (user?.role === 'PARAMEDIC' && typeof user.user_id === 'string') return { initiatedBy: user.user_id };
  return null;
}
/** Accept / reject a referral: ADMIN, or the desk of the hospital it was sent to (never a dispatcher). */
export const canDecideReferral = (user, acceptance) => Boolean(acceptance) && canManageHospital(user, acceptance.hospital_id);

/** Active soft-locks (GET /referrals/active and the socket request:active_locks): ADMIN/DISPATCHER all, a desk its own, else null. */
export function visibleLocks(user, locks) {
  if (isCommandCenter(user)) return locks;
  const own = deskHospital(user);
  return own ? locks.filter(lock => lock.hospitalId === own) : null;
}

/** Ambulance trips (Batch 7): the list filter { } all | { hospitalId } | { ambulanceId, activeOnly }, or null = none. */
export function tripFilter(user) {
  if (isCommandCenter(user)) return {};
  const own = deskHospital(user);
  if (own) return { hospitalId: own };
  if (user?.role === 'PARAMEDIC' && user.ambulance_id) return { ambulanceId: user.ambulance_id, activeOnly: true };
  return null;
}
/** Read one trip: the same scope as tripFilter. Out of scope is answered like a missing trip (404). */
export function canSeeTrip(user, trip) {
  const filter = trip ? tripFilter(user) : null;
  if (!filter) return false;
  if (filter.hospitalId) return trip.hospital_id === filter.hospitalId;
  if (filter.ambulanceId) return trip.ambulance_id === filter.ambulanceId && !(filter.activeOnly && trip.completed_at != null);
  return true;
}
/** What a paramedic may do on its own unit's trip; ADMIN and DISPATCHER may do every action, nobody else any. */
export const PARAMEDIC_TRIP_ACTIONS = Object.freeze(['start', 'pickup', 'complete']);
export function canActOnTrip(user, trip, action) {
  if (!trip) return false;
  if (isCommandCenter(user)) return true;
  return user?.role === 'PARAMEDIC' && Boolean(user.ambulance_id) && user.ambulance_id === trip.ambulance_id
    && PARAMEDIC_TRIP_ACTIONS.includes(action);
}

/**
 * A PATIENT may call only these (method + path under /api/v1); every other endpoint answers 403 before its handler
 * runs (enforced once, in authenticate). Login itself needs no token.
 */
export function patientMayCall(method, path) {
  const p = path.split('?')[0].replace(/\/+$/, '');
  if (method !== 'GET') return false;
  return p === '/api/v1/auth/me' || p === '/api/v1/patient/me' || p === '/api/v1/patient/cases'
    || /^\/api\/v1\/patient\/cases\/[^/]+(\/tracking)?$/.test(p);
}

export const userRoom = userId => `user:${userId}`;
export const hospitalRoom = hospitalId => `hospital:${hospitalId}`;
export const ambulanceRoom = ambulanceId => `ambulance:${ambulanceId}`;
export const COMMAND_CENTER = 'command_center';
export const STAFF_ROOM = 'staff';
export const ADMIN_ROOM = 'admin';

/** The socket rooms a user joins: the same scoping as REST, expressed as rooms. */
export function socketRooms(user) {
  const rooms = [];
  if (typeof user?.user_id === 'string') rooms.push(userRoom(user.user_id));
  if (!isStaff(user)) return rooms; // a patient: their own user room only
  rooms.push(STAFF_ROOM);
  if (isCommandCenter(user)) rooms.push(COMMAND_CENTER);
  if (isAdmin(user)) rooms.push(ADMIN_ROOM);
  const own = deskHospital(user);
  if (own) rooms.push(hospitalRoom(own));
  if (user.role === 'PARAMEDIC' && typeof user.ambulance_id === 'string' && user.ambulance_id) rooms.push(ambulanceRoom(user.ambulance_id));
  return rooms;
}
