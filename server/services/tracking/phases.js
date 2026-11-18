// server/services/tracking/phases.js
// The trip lifecycle, validated on the server (pure functions, shared by both stores and the engine):
//
//   DISPATCHED --start--> EN_ROUTE_TO_PATIENT --(end of leg 1, automatic)--> ARRIVED_AT_PATIENT
//     --pickup--> PATIENT_PICKED_UP --(immediately)--> EN_ROUTE_TO_HOSPITAL --(end of leg 2, automatic)-->
//     ARRIVED_AT_HOSPITAL --complete--> (completed: completed_at set; terminal)
//
//   pause / resume: only while moving (EN_ROUTE_*). reset: demo trips only, back to DISPATCHED at the start position.
//   Anything else is refused with a message (HTTP 409).

import { cumulativeMeters, pointAtMeters, round7 } from './geo.js';

export const PHASES = Object.freeze(['DISPATCHED', 'EN_ROUTE_TO_PATIENT', 'ARRIVED_AT_PATIENT', 'PATIENT_PICKED_UP',
  'EN_ROUTE_TO_HOSPITAL', 'ARRIVED_AT_HOSPITAL']);
export const MOVING_PHASES = Object.freeze(['EN_ROUTE_TO_PATIENT', 'EN_ROUTE_TO_HOSPITAL']);
export const TRIP_ACTIONS = Object.freeze(['start', 'pause', 'resume', 'pickup', 'complete', 'reset']);

export const isMoving = trip => MOVING_PHASES.includes(trip.phase);
export const isCompleted = trip => trip.completed_at !== null && trip.completed_at !== undefined;
export const isActive = trip => !isCompleted(trip);

/** null when `action` is allowed on `trip` now; otherwise the reason (sent as a 409). */
export function actionError(trip, action) {
  if (!TRIP_ACTIONS.includes(action)) return `Unknown trip action "${action}".`;
  if (action === 'reset') return Number(trip.is_demo) === 1 ? null : 'Only demo trips can be reset.';
  if (isCompleted(trip)) return `Trip ${trip.trip_id} is already completed; no further ${action} is possible.`;
  switch (action) {
    case 'start':
      return trip.phase === 'DISPATCHED' ? null : `Cannot start: the trip is ${trip.phase}; start is only allowed from DISPATCHED.`;
    case 'pickup':
      return trip.phase === 'ARRIVED_AT_PATIENT' ? null : `Cannot pick up: the trip is ${trip.phase}; pickup is only allowed at ARRIVED_AT_PATIENT.`;
    case 'complete':
      return trip.phase === 'ARRIVED_AT_HOSPITAL' ? null : `Cannot complete: the trip is ${trip.phase}; complete is only allowed at ARRIVED_AT_HOSPITAL.`;
    case 'pause':
      if (!isMoving(trip)) return `Cannot pause: the trip is ${trip.phase}; pause is only allowed while the ambulance is moving.`;
      return trip.paused ? 'The trip is already paused.' : null;
    case 'resume':
      if (!isMoving(trip)) return `Cannot resume: the trip is ${trip.phase}; resume is only allowed while the ambulance is moving.`;
      return trip.paused ? null : 'The trip is not paused.';
    default:
      return `Unknown trip action "${action}".`;
  }
}

/** Ambulance.eta_mins (SMALLINT) from a trip's eta_seconds. */
export const etaMinutes = seconds => (seconds === null || seconds === undefined ? null : Math.min(32767, Math.ceil(seconds / 60)));

const mps = speedKmh => (speedKmh * 1000) / 3600;
const etaFor = (meters, speedKmh) => Math.max(0, Math.ceil(meters / mps(speedKmh)));

/** A trip's two legs with their cumulative distances (cached by the caller per trip). */
export function legsOf(trip) {
  const toPatient = { points: trip.route_to_patient, cumulative: cumulativeMeters(trip.route_to_patient) };
  const toHospital = { points: trip.route_to_hospital, cumulative: cumulativeMeters(trip.route_to_hospital) };
  return { toPatient, toHospital, toPatientMeters: toPatient.cumulative.at(-1), toHospitalMeters: toHospital.cumulative.at(-1) };
}

/** Seconds to the end of the current leg: the pickup point until pickup, then the hospital; 0 on arrival. */
export function etaSeconds(phase, progress, legs, speedKmh) {
  switch (phase) {
    case 'DISPATCHED':
    case 'EN_ROUTE_TO_PATIENT':
      return etaFor(legs.toPatientMeters * (1 - progress), speedKmh);
    case 'ARRIVED_AT_PATIENT':
    case 'PATIENT_PICKED_UP':
      return etaFor(legs.toHospitalMeters, speedKmh);
    case 'EN_ROUTE_TO_HOSPITAL':
      return etaFor(legs.toHospitalMeters * (1 - progress), speedKmh);
    default:
      return 0;
  }
}

/**
 * Move a moving trip `meters` further along its current leg. Returns the new { phase, progress, current_lat,
 * current_lng, eta_seconds, arrived } where `arrived` names the arrival phase when the leg ended in this step (the
 * position is then EXACTLY the leg's last point: the pickup point or the hospital). Never skips ahead: the position is
 * always interpolated on the route, at most `meters` beyond the previous one.
 */
export function step(trip, legs, meters) {
  const toPatient = trip.phase === 'EN_ROUTE_TO_PATIENT';
  const leg = toPatient ? legs.toPatient : legs.toHospital;
  const length = leg.cumulative.at(-1);
  const travelled = Math.min(length, Number(trip.progress) * length + Math.max(0, meters));
  if (travelled >= length) {
    const [lat, lng] = leg.points.at(-1);
    const phase = toPatient ? 'ARRIVED_AT_PATIENT' : 'ARRIVED_AT_HOSPITAL';
    return { phase, progress: 1, current_lat: lat, current_lng: lng, eta_seconds: etaSeconds(phase, 1, legs, trip.speed_kmh), arrived: phase };
  }
  const progress = Math.min(0.999999, Math.round((travelled / length) * 1e6) / 1e6);
  const [lat, lng] = pointAtMeters(leg.points, leg.cumulative, travelled);
  return { phase: trip.phase, progress, current_lat: round7(lat), current_lng: round7(lng), eta_seconds: etaSeconds(trip.phase, progress, legs, trip.speed_kmh), arrived: null };
}
