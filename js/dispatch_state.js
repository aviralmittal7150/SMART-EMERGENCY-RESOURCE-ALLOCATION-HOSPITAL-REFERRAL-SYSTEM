// js/dispatch_state.js
// Pure decision + orchestration logic for the roadside "Dispatch EMS" action.
// No DOM or network access here: app.js injects the API calls, so the behaviour
// can be tested in Node against the real backend routes.
//
// Background: accepting a referral makes the backend auto-dispatch an ambulance
// (accept response `ambulance_id`; ambulances then carry `assigned_request_id`).
// A manual dispatch for a case that already has a unit is refused with HTTP 409,
// so the UI must recognise the existing assignment instead of dispatching again.

// Request ids with a dispatch call currently in flight (duplicate-click guard).
const defaultInFlight = new Set();

// Only a unit on the road is transport for a case (matches ON_ROAD_AMBULANCE_STATUSES on the server).
// An AVAILABLE or MAINTENANCE unit is never shown as assigned, so dispatch of a replacement stays open.
const ON_ROAD = ['DISPATCHED', 'IN_TRANSIT'];

export function isDispatchInFlight(requestId, inFlight = defaultInFlight) {
  return inFlight.has(requestId);
}

/**
 * The ambulance already assigned to the accepted referral's case, or null.
 * `assigned_request_id` from the API is authoritative. Right after accept (before the
 * workspace refresh lands) the accept response's `ambulance_id` bridges the gap. Either way
 * only a unit on the road counts: one released after completion, or taken out of service
 * (MAINTENANCE), is not mistaken for an assignment.
 */
export function findAssignedAmbulance(ambulances, referral) {
  if (!referral) return null;
  const list = (Array.isArray(ambulances) ? ambulances : []).filter(a => ON_ROAD.includes(a.status));
  const byAssignment = list.find(a => a.assigned_request_id && a.assigned_request_id === referral.requestId);
  if (byAssignment) return byAssignment;
  if (!referral.ambulanceId) return null;
  const byId = list.find(a => (a.id || a.ambulance_id) === referral.ambulanceId);
  if (byId && (!byId.assigned_request_id || byId.assigned_request_id === referral.requestId)) {
    return byId;
  }
  return null;
}

export function describeAmbulance(ambulance) {
  const id = ambulance.id || ambulance.ambulance_id;
  const type = ambulance.type || ambulance.ambulance_type;
  const eta = Number(ambulance.etaMins ?? ambulance.eta_mins);
  return [id, type, ambulance.status, Number.isFinite(eta) && eta > 0 ? `ETA ${eta} min` : null]
    .filter(Boolean)
    .join(' • ');
}

/**
 * What the Dispatch EMS control should look like right now.
 * state: IN_FLIGHT | AWAITING_ACCEPTANCE | NO_ACCEPTED_REFERRAL | ASSIGNED | DISPATCHABLE
 */
export function getDispatchControl({ referral, awaitingAcceptance = false, ambulances, inFlight = defaultInFlight }) {
  if (referral && inFlight.has(referral.requestId)) {
    return { state: 'IN_FLIGHT', disabled: true, label: '⏳ Dispatching…', detail: '', ambulance: null };
  }
  // These two keep the original behaviour: the button stays clickable and explains why not.
  if (awaitingAcceptance) {
    return { state: 'AWAITING_ACCEPTANCE', disabled: false, label: null, detail: '', ambulance: null };
  }
  if (!referral) {
    return { state: 'NO_ACCEPTED_REFERRAL', disabled: false, label: null, detail: '', ambulance: null };
  }
  const assigned = findAssignedAmbulance(ambulances, referral);
  if (assigned) {
    const id = assigned.id || assigned.ambulance_id;
    return {
      state: 'ASSIGNED',
      disabled: true,
      label: `🚑 ${id} assigned`,
      detail: `Ambulance assigned to ${referral.requestId}: ${describeAmbulance(assigned)}`,
      ambulance: assigned
    };
  }
  return { state: 'DISPATCHABLE', disabled: false, label: null, detail: '', ambulance: null };
}

/**
 * Handle a click on Dispatch EMS.
 *
 * deps:
 *   referral            accepted referral { requestId, ambulanceId? } or null
 *   awaitingAcceptance  a referral handshake is still pending
 *   getAmbulances()     current ambulance list (re-read after every refresh)
 *   dispatch(ambulance) performs the dispatch; rejects on failure
 *   refresh()           re-synchronises ambulances from the API (no-op when standalone)
 *   onChange()          optional; called when the in-flight state changes (to re-render)
 *
 * Outcomes: AWAITING_ACCEPTANCE | NO_ACCEPTED_REFERRAL | ALREADY_ASSIGNED | IN_FLIGHT |
 *           NO_AMBULANCE | DISPATCHED | FAILED
 */
export async function dispatchForReferral({
  referral,
  awaitingAcceptance = false,
  getAmbulances,
  dispatch,
  refresh = async () => {},
  onChange = () => {},
  inFlight = defaultInFlight
}) {
  if (awaitingAcceptance) return { outcome: 'AWAITING_ACCEPTANCE' };
  if (!referral) return { outcome: 'NO_ACCEPTED_REFERRAL' };

  const existing = findAssignedAmbulance(getAmbulances(), referral);
  if (existing) return { outcome: 'ALREADY_ASSIGNED', ambulance: existing };

  if (inFlight.has(referral.requestId)) return { outcome: 'IN_FLIGHT' };

  const candidate = getAmbulances().find(a => a.status === 'AVAILABLE' && !a.assigned_request_id);
  if (!candidate) return { outcome: 'NO_AMBULANCE' };

  // Claimed synchronously (before any await) so a second click in the same tick is refused.
  inFlight.add(referral.requestId);
  onChange();
  try {
    try {
      await dispatch(candidate);
    } catch (error) {
      // Most commonly HTTP 409 because the backend already assigned a unit. Re-read the
      // authoritative state before deciding whether this is really a failure.
      try { await refresh(); } catch { /* the original error is what matters */ }
      const assigned = findAssignedAmbulance(getAmbulances(), referral);
      if (assigned) return { outcome: 'ALREADY_ASSIGNED', ambulance: assigned, recovered: true };
      return { outcome: 'FAILED', error };
    }
    await refresh();
    const assigned = findAssignedAmbulance(getAmbulances(), referral) || candidate;
    return { outcome: 'DISPATCHED', ambulance: assigned };
  } finally {
    inFlight.delete(referral.requestId);
    onChange();
  }
}
