// server/services/patientView.js
// The REDACTED patient-portal view of a case (Batch 6). Built from a whitelist: only the fields below ever reach a
// patient. Never: staff identities or actor ids, rejection reasons, pending or other hospitals' referrals, clinical
// notes, hash-chain data, or another patient.

// Audit events a patient may see in their timeline, renamed for the portal (event name and time only).
const TIMELINE_EVENTS = {
  REQUEST_CREATED: () => 'CASE_REGISTERED',
  ALLOCATION_COMMITTED: () => 'HOSPITAL_ACCEPTED',
  AMBULANCE_STATUS_CHANGED: e => ({ DISPATCHED: 'AMBULANCE_DISPATCHED', IN_TRANSIT: 'AMBULANCE_EN_ROUTE' })[e.new_state] ?? null,
  STATUS_CHANGED: e => (['IN_TREATMENT', 'COMPLETED', 'CANCELLED'].includes(e.new_state) ? `CASE_${e.new_state}` : null)
};

const iso = value => {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** The hospital that ACCEPTED the case (the latest accepted referral), or null. Pending / other referrals never count. */
export function acceptedHospitalId(acceptances) {
  return acceptances.filter(a => a.status === 'ACCEPTED').at(-1)?.hospital_id ?? null;
}

export function patientTimeline(auditEvents) {
  return auditEvents
    .map(e => ({ event: TIMELINE_EVENTS[e.event_type]?.(e) ?? null, at: iso(e.event_time_ms ?? e.event_time) }))
    .filter(e => e.event && e.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * detail: store.getRequestDetail(...) for a case the patient owns; hospital: the accepted hospital row (or null);
 * ambulance: the case's usable ambulance row (or null). { timeline } adds the status timeline.
 */
export function patientCaseView(detail, hospital, ambulance, { timeline = true } = {}) {
  const r = detail.request;
  const view = {
    request_id: r.request_id,
    status: r.status,
    emergency_type: r.emergency_type,
    triage_priority: r.priority,
    requested_at: iso(r.request_time),
    updated_at: iso(r.updated_at),
    hospital: hospital ? {
      hospital_id: hospital.hospital_id,
      name: hospital.hospital_name,
      address: hospital.address ?? null,
      location_lat: hospital.location_lat === null || hospital.location_lat === undefined ? null : Number(hospital.location_lat),
      location_lng: hospital.location_lng === null || hospital.location_lng === undefined ? null : Number(hospital.location_lng),
      contact_phone: hospital.contact_phone ?? null
    } : null,
    ambulance: ambulance ? {
      ambulance_id: ambulance.ambulance_id,
      status: ambulance.status,
      eta_mins: ambulance.status === 'IN_TRANSIT' || ambulance.status === 'DISPATCHED' ? (ambulance.eta_mins ?? null) : null
    } : null
  };
  if (timeline) view.timeline = patientTimeline(detail.auditEvents ?? []);
  return view;
}

/** The redacted socket payload of patient:case_update. */
export function patientCaseUpdate(view) {
  return {
    request_id: view.request_id,
    status: view.status,
    hospital_name: view.hospital?.name ?? null,
    ambulance_status: view.ambulance?.status ?? null,
    eta_mins: view.ambulance?.eta_mins ?? null,
    at: new Date().toISOString()
  };
}

/** Load and build the view of one case for a patient scope; null when it is not theirs or does not exist. */
export async function loadPatientCase(store, requestId, scope, options) {
  const detail = await store.getRequestDetail(requestId, { scope });
  if (!detail) return null;
  const hospitalId = acceptedHospitalId(detail.acceptances ?? []);
  const ambulanceId = detail.request.assigned_ambulance_id ?? null;
  const [hospital, ambulance] = await Promise.all([
    hospitalId ? store.getHospital(hospitalId) : null,
    ambulanceId ? store.getAmbulance(ambulanceId) : null
  ]);
  return patientCaseView(detail, hospital, ambulance, options);
}
