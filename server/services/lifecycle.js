// server/services/lifecycle.js
// Single source of truth for the emergency request lifecycle, shared by the in-memory
// and MySQL stores so both enforce exactly the same transitions.
//
// These are the MANUAL transitions (PATCH /emergencies/:id/status). Two moves are deliberately absent:
//  - -> MATCHING: a case is MATCHING exactly while it has a pending referral, so only placing a
//    referral (the locking engines) may set it; a manual MATCHING would strand the case.
//  - MATCHING -> ALLOCATED: allocation only happens through the hospital acceptance handshake.

export const ALLOWED_TRANSITIONS = {
  NEW: ['WAITING', 'CANCELLED'],
  WAITING: ['CANCELLED'],
  MATCHING: ['WAITING', 'CANCELLED'],
  ALLOCATED: ['IN_TREATMENT', 'COMPLETED', 'CANCELLED'],
  IN_TREATMENT: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: []
};

export const REQUEST_STATUSES = Object.keys(ALLOWED_TRANSITIONS);
export const TERMINAL_STATES = ['COMPLETED', 'CANCELLED'];
export const MATCHING_STATES = ['NEW', 'WAITING', 'MATCHING'];

// Transport. An ambulance serves a case only while it is on the road; a unit at station or out of
// service (MAINTENANCE) is never the case's transport, whatever its assignment column says.
export const ON_ROAD_AMBULANCE_STATUSES = ['DISPATCHED', 'IN_TRANSIT'];

/** An accepted case still waiting for the patient to be brought in needs a usable ambulance. */
export function transportRequired(status, assignedAmbulanceId) {
  return status === 'ALLOCATED' && !assignedAmbulanceId;
}

/** True when the move is a legal lifecycle transition. */
export function canTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));
}
