// server/services/tracking/autoTransport.js
// Batch 8 (P-0.3): simulated transport. When a hospital accepts a case and the accept dispatched an ambulance, the
// simulated trip (unit position -> pickup -> accepting hospital) is created and STARTED at once, so the unit moves
// without anyone pressing "Start". On only when SIMULATED_TRANSPORT is on (default outside production; config.js):
// there is no real GPS. Everything goes through the tracking engine's normal, audited paths (createTrip, act 'start');
// a case without a pickup point, or a unit no longer on the case, is simply skipped (logged), never forced.
// The sample demo case (POST /tracking/demo-setup, patient PAT-DT-001) is skipped too: its set-up accepts it through the
// normal referral path and then creates its OWN demo trip (left DISPATCHED for "Start Demo"). Starting a second, non-demo
// trip here raced that set-up (the unit then "already has an active trip", 409).

import { SYSTEM_ACTOR } from './engine.js';
import { DEMO_TRIP } from './demoSetup.js';

export async function startSimulatedTransport(engine, store, { requestId, ambulanceId }, { speedKmh = DEMO_TRIP.speedKmh, log = console } = {}) {
  try {
    if ((await store.listTrips({ requestId, activeOnly: true })).length) return null; // already moving (idempotent)
    const request = await store.getRequest(requestId);
    if (!request || (Number(request.is_demo) === 1 && request.patient_id === DEMO_TRIP.patientId)) return null;
    const unit = await store.getAmbulance(ambulanceId);
    if (!unit || unit.assigned_request_id !== requestId || unit.current_lat == null || unit.current_lng == null) return null;
    const trip = await engine.createTrip({
      request_id: requestId, ambulance_id: ambulanceId, start_lat: Number(unit.current_lat), start_lng: Number(unit.current_lng),
      speed_kmh: speedKmh, is_demo: false
    }, SYSTEM_ACTOR);
    return await engine.act(trip.trip_id, 'start', SYSTEM_ACTOR);
  } catch (err) {
    log.warn?.(`[TRACKING] No simulated transport for ${requestId}: ${err.message}`);
    return null;
  }
}
