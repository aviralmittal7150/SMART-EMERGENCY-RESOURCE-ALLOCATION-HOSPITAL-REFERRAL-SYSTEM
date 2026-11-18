// server/routes/tracking.js
// Ambulance live-tracking demo API — /api/v1/tracking (Batch 7). The movement is SIMULATED by the server
// (server/services/tracking/engine.js); every trip is a demo trip.
//
//   POST /demo-trips                      ADMIN, not in production. { request_id, ambulance_id, start_lat, start_lng, speed_kmh? (10-200, default 60) }
//                                         -> 201 { success, trip }
//   POST /demo-setup                      ADMIN, not in production. { speed_kmh? } -> { success, outcome, request_id, trip,
//                                         } (the unit is always one crewed by a demo Fleet login: AMB-01 / UNIT-402 first)
//                                         (201 when a trip was created; 200 when an existing one was returned or reset)
//   POST /trips/:tripId/:action           start | pause | resume | pickup | complete | reset -> { success, trip }
//                                         ADMIN / DISPATCHER: every action; PARAMEDIC: its own unit's trip, start / pickup /
//                                         complete only; everyone else 403. An invalid transition is 409.
//   GET  /trips                           { success, count, trips } in the caller's scope (accessPolicy.tripFilter)
//   GET  /trips/:tripId                   { success, trip }; 404 when missing or out of scope
// Trip shape: server/services/tracking/view.js (staffTripView). For ADMIN only it also has `crew`: the usernames of the
// active PARAMEDIC (Fleet) accounts bound to the trip's unit, so the admin knows which Fleet login drives it. Patients use GET /patient/cases/:id/tracking instead.

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { tripFilter, canSeeTrip, canActOnTrip } from '../services/accessPolicy.js';
import { validateBody, ID20 } from '../services/validation.js';
import { getTracking } from '../services/tracking/index.js';
import { setupDemoTrip, crews } from '../services/tracking/demoSetup.js';
import { TRIP_ACTIONS } from '../services/tracking/phases.js';
import { areaProblem } from '../services/operatingArea.js';

const router = express.Router();
router.use(authenticate);

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });
const NOT_FOUND = { error: 'Trip not found.' };
const SPEED = { type: 'integer', min: 10, max: 200 };

// Both demo writers are refused in production (403): a simulated trip moves a unit and releases it, which must never
// happen to real operations. (Since Batch 8 a trip never changes the case's status; the hospital desk does.)
const PRODUCTION_REFUSAL = 'The ambulance tracking demo is not available in production.';
function notInProduction(req, res, next) {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: PRODUCTION_REFUSAL });
  next();
}

/** The staff view; an ADMIN also gets `crew` (never other roles). `crewMap`: crews(store), read once per request. */
async function viewFor(req, trip, crewMap = null) {
  const view = await getTracking().staffView(trip);
  if (req.user.role !== 'ADMIN') return view;
  const map = crewMap ?? await crews(store);
  return { ...view, crew: (map.get(trip.ambulance_id) ?? []).map(m => m.username).sort() };
}

async function respond(res, work) {
  try {
    await work();
  } catch (err) {
    if (!respondStoreError(res, err)) throw err;
  }
}

router.post('/demo-trips',
  authorize('ADMIN'),
  notInProduction,
  validateBody({
    request_id: { ...ID20, required: true },
    ambulance_id: { ...ID20, required: true },
    start_lat: { type: 'number', required: true, min: -90, max: 90 },
    start_lng: { type: 'number', required: true, min: -180, max: 180 },
    speed_kmh: { ...SPEED, default: 60 }
  }),
  (req, res) => respond(res, async () => {
    // Batch 8 (P-0.1): the start must lie in the operating area (the engine also checks the pickup and the hospital).
    const outside = areaProblem([['start_lat / start_lng', req.valid.start_lat, req.valid.start_lng]]);
    if (outside) return res.status(400).json({ error: outside });
    const tracking = getTracking();
    const trip = await tracking.createTrip({ ...req.valid, is_demo: true }, actorOf(req));
    res.status(201).json({ success: true, trip: await viewFor(req, trip) });
  }));

router.post('/demo-setup',
  authorize('ADMIN'),
  notInProduction,
  validateBody({ speed_kmh: SPEED }),
  (req, res) => respond(res, async () => {
    const tracking = getTracking();
    const result = await setupDemoTrip(tracking, actorOf(req), req.valid.speed_kmh === undefined ? {} : { speedKmh: req.valid.speed_kmh });
    res.status(result.outcome === 'created' ? 201 : 200).json({
      success: true, outcome: result.outcome, request_id: result.request_id, trip: await viewFor(req, result.trip)
    });
  }));

router.get('/trips', authorize('ADMIN', 'DISPATCHER', 'HOSPITAL_DESK', 'PARAMEDIC'), async (req, res) => {
  const filter = tripFilter(req.user);
  const trips = filter ? await store.listTrips(filter) : [];
  const tracking = getTracking();
  const views = [];
  const crewMap = req.user.role === 'ADMIN' ? await crews(store) : null;
  for (const trip of trips) views.push(await viewFor(req, trip, crewMap));
  res.json({ success: true, count: views.length, trips: views });
});

router.get('/trips/:tripId', authorize('ADMIN', 'DISPATCHER', 'HOSPITAL_DESK', 'PARAMEDIC'), async (req, res) => {
  const trip = await store.getTrip(req.params.tripId);
  if (!trip || !canSeeTrip(req.user, trip)) return res.status(404).json(NOT_FOUND);
  res.json({ success: true, trip: await viewFor(req, trip) });
});

router.post('/trips/:tripId/:action', authorize('ADMIN', 'DISPATCHER', 'PARAMEDIC'), (req, res) => respond(res, async () => {
  const { tripId, action } = req.params;
  if (!TRIP_ACTIONS.includes(action)) return res.status(404).json({ error: `Unknown trip action "${action}".` });
  const trip = await store.getTrip(tripId);
  if (!trip || !canSeeTrip(req.user, trip)) return res.status(404).json(NOT_FOUND);
  if (!canActOnTrip(req.user, trip, action)) {
    return res.status(403).json({ error: `Your role may not ${action} this trip (a paramedic may only start, pick up and complete its own unit's trip).` });
  }
  const tracking = getTracking();
  const updated = await tracking.act(tripId, action, actorOf(req));
  res.json({ success: true, trip: await viewFor(req, updated) });
}));

export default router;
