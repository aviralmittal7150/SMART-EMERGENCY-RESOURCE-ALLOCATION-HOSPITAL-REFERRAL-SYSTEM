// server/services/tracking/view.js
// The shapes the tracking API and sockets send. Built from whitelists: the patient shape carries no staff, crew,
// ambulance or other-case data and is always labelled simulated.

const iso = value => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const num = value => (value === null || value === undefined ? null : Number(value));
const point = (lat, lng) => ({ lat: num(lat), lng: num(lng) });

export function tripTimestamps(trip) {
  return {
    created_at: iso(trip.created_at),
    started_at: iso(trip.started_at),
    arrived_patient_at: iso(trip.arrived_patient_at),
    picked_up_at: iso(trip.picked_up_at),
    arrived_hospital_at: iso(trip.arrived_hospital_at),
    completed_at: iso(trip.completed_at),
    updated_at: iso(trip.updated_at)
  };
}

/**
 * The staff view (GET /tracking/trips[/:id]). ctx: { request, patient, hospital } rows as the store returns them
 * (pickup from EmergencyRequest, hospital position from Hospital: read, never copied).
 */
export function staffTripView(trip, ctx) {
  return {
    trip_id: trip.trip_id,
    request_id: trip.request_id,
    case: ctx.request ? { priority: ctx.request.priority, emergency_type: ctx.request.emergency_type, status: ctx.request.status } : null,
    patient: ctx.patient ? { patient_id: ctx.patient.patient_id, full_name: ctx.patient.full_name } : null,
    ambulance: { ambulance_id: trip.ambulance_id },
    hospital: ctx.hospital
      ? { hospital_id: ctx.hospital.hospital_id, name: ctx.hospital.hospital_name, ...point(ctx.hospital.location_lat, ctx.hospital.location_lng) }
      : { hospital_id: trip.hospital_id, name: null, lat: null, lng: null },
    pickup: ctx.request ? point(ctx.request.pickup_lat, ctx.request.pickup_lng) : null,
    start: point(trip.start_lat, trip.start_lng),
    route_to_patient: trip.route_to_patient,
    route_to_hospital: trip.route_to_hospital,
    route_source: trip.route_source,
    phase: trip.phase,
    progress: num(trip.progress),
    current: point(trip.current_lat, trip.current_lng),
    eta_seconds: num(trip.eta_seconds),
    speed_kmh: num(trip.speed_kmh),
    paused: Boolean(Number(trip.paused)),
    is_demo: Number(trip.is_demo) === 1,
    completed: trip.completed_at !== null && trip.completed_at !== undefined,
    timestamps: tripTimestamps(trip)
  };
}

/** tracking:update (staff sockets): the moving parts only. */
export function trackingUpdate(trip) {
  return {
    trip_id: trip.trip_id,
    request_id: trip.request_id,
    phase: trip.phase,
    current: point(trip.current_lat, trip.current_lng),
    progress: num(trip.progress),
    eta_seconds: num(trip.eta_seconds),
    paused: Boolean(Number(trip.paused)),
    route_source: trip.route_source,
    completed: trip.completed_at !== null && trip.completed_at !== undefined
  };
}

/** The patient's redacted view (GET /patient/cases/:id/tracking and patient:tracking). ctx as for staffTripView. */
export function patientTripView(trip, ctx) {
  return {
    phase: trip.phase,
    current: point(trip.current_lat, trip.current_lng),
    eta_seconds: num(trip.eta_seconds),
    route_source: trip.route_source,
    simulated: true,
    hospital: ctx.hospital ? { name: ctx.hospital.hospital_name, ...point(ctx.hospital.location_lat, ctx.hospital.location_lng) } : null,
    pickup: ctx.request ? point(ctx.request.pickup_lat, ctx.request.pickup_lng) : null
  };
}
