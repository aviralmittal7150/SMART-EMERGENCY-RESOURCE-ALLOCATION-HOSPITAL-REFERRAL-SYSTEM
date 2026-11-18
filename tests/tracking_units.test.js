// Batch 7, ambulance live-tracking demo: the pure parts (geometry, the trip lifecycle, movement, routing and settings,
// the scoping policy) and the engine on the in-memory store, driven by a fake clock: every valid and invalid transition,
// movement without jumps (also across a clock jump and an engine restart), demo-only reset, one active trip per unit
// and per case, a unit taken off its case halting the trip, and optimistic concurrency. No network: routing uses
// injected fake fetch functions. All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, cumulativeMeters, pointAtMeters, straightLine, normaliseRoute, polylineMeters } from '../server/services/tracking/geo.js';
import { PHASES, TRIP_ACTIONS, actionError, legsOf, step, etaSeconds } from '../server/services/tracking/phases.js';
import { parseRoutingUrl, osrmLeg, createRouter, DEFAULT_ROUTING_URL } from '../server/services/tracking/routing.js';
import { parseTrackingConfig } from '../server/services/tracking/config.js';
import { TrackingEngine } from '../server/services/tracking/engine.js';
import { setupDemoTrip, DEMO_TRIP } from '../server/services/tracking/demoSetup.js';
import { tripFilter, canSeeTrip, canActOnTrip, patientMayCall } from '../server/services/accessPolicy.js';
import { MemoryStore } from '../server/db/memoryStore.js';
import express from 'express';
import { once } from 'node:events';
import { memoryTokenFor } from './helpers/testUsers.js';
import trackingRoutes from '../server/routes/tracking.js';
import { configureStore } from '../server/db/store.js';
import { TRIP_COLUMNS } from '../server/db/mysqlStore.js';

const silent = { log() {}, warn() {}, error() {} };

// ── Geometry ─────────────────────────────────────────────────────────────────
test('geometry: haversine, interpolation between route points, straight-line fallback with exact ends', () => {
  assert.ok(Math.abs(haversineMeters([28, 77], [29, 77]) - 111_195) < 50, 'one degree of latitude is about 111.2 km');
  const route = [[28.6, 77.2], [28.61, 77.2], [28.61, 77.21]];
  const cum = cumulativeMeters(route);
  assert.deepEqual(pointAtMeters(route, cum, cum[1] / 2), [28.605, 77.2], 'halfway along the first segment');
  assert.deepEqual(pointAtMeters(route, cum, cum[2] + 10), [28.61, 77.21], 'clamped to the end');
  const line = straightLine([28.63, 77.218], [28.6129, 77.2295]);
  assert.deepEqual([line[0], line.at(-1)], [[28.63, 77.218], [28.6129, 77.2295]]);
  for (let i = 1; i < line.length; i += 1) assert.ok(haversineMeters(line[i - 1], line[i]) <= 101, 'intermediate points about every 100 m');
  assert.deepEqual(normaliseRoute([[28.6001, 77.2001], [28.61, 77.2]], [28.6, 77.2], [28.62, 77.2]), [[28.6, 77.2], [28.6001, 77.2001], [28.61, 77.2], [28.62, 77.2]]);
  assert.deepEqual(normaliseRoute([], [28.6, 77.2], [28.6, 77.2]), [[28.6, 77.2], [28.6, 77.2]], 'a zero-length leg still has two points');
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
test('every trip action in every phase: exactly the documented transitions are allowed, the rest are refused with a reason', () => {
  const allowed = (phase, paused) => ({
    DISPATCHED: ['start'],
    EN_ROUTE_TO_PATIENT: [paused ? 'resume' : 'pause'],
    ARRIVED_AT_PATIENT: ['pickup'],
    PATIENT_PICKED_UP: [],
    EN_ROUTE_TO_HOSPITAL: [paused ? 'resume' : 'pause'],
    ARRIVED_AT_HOSPITAL: ['complete']
  })[phase];
  let checked = 0;
  for (const phase of PHASES) {
    for (const paused of [0, 1]) {
      for (const completed of [null, '2026-11-14T00:00:00.000Z']) {
        for (const isDemo of [0, 1]) {
          const trip = { trip_id: 'TRIP-X', phase, paused, completed_at: completed, is_demo: isDemo };
          for (const action of TRIP_ACTIONS) {
            const expected = action === 'reset' ? isDemo === 1 : !completed && allowed(phase, paused).includes(action);
            const refusal = actionError(trip, action);
            assert.equal(refusal === null, expected, `${action} in ${phase} paused=${paused} completed=${Boolean(completed)} demo=${isDemo}: ${refusal}`);
            if (!expected) assert.match(refusal, /\w/);
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, PHASES.length * 2 * 2 * 2 * TRIP_ACTIONS.length);
  assert.match(actionError({ phase: 'DISPATCHED', paused: 0, completed_at: null }, 'pickup'), /only allowed at ARRIVED_AT_PATIENT/);
  assert.match(actionError({ phase: 'DISPATCHED', paused: 0, completed_at: null, is_demo: 0 }, 'reset'), /Only demo trips/);
  assert.match(actionError({ phase: 'DISPATCHED', paused: 0, completed_at: null }, 'fly'), /Unknown trip action/);
});

test('movement: progress only grows, never by more than the distance driven, and each leg ends EXACTLY at its last point', () => {
  const trip = {
    phase: 'EN_ROUTE_TO_PATIENT', progress: 0, speed_kmh: 60,
    route_to_patient: [[28.6, 77.2], [28.605, 77.2], [28.605, 77.205]], route_to_hospital: [[28.605, 77.205], [28.6, 77.21]]
  };
  const legs = legsOf(trip);
  let previous = trip.route_to_patient[0];
  let moves = 0;
  while (trip.phase === 'EN_ROUTE_TO_PATIENT') {
    const next = step(trip, legs, 50);
    assert.ok(haversineMeters(previous, [next.current_lat, next.current_lng]) <= 50.01, 'never more than the 50 m driven');
    assert.ok(next.progress >= trip.progress);
    previous = [next.current_lat, next.current_lng];
    Object.assign(trip, next);
    moves += 1;
  }
  assert.equal(trip.phase, 'ARRIVED_AT_PATIENT');
  assert.deepEqual([trip.current_lat, trip.current_lng, trip.progress], [28.605, 77.205, 1], 'exactly at the pickup point');
  assert.equal(moves, Math.ceil(legs.toPatientMeters / 50));
  assert.equal(trip.eta_seconds, etaSeconds('ARRIVED_AT_PATIENT', 1, legs, 60), 'then the ETA is the whole second leg');
  const zero = { ...trip, phase: 'EN_ROUTE_TO_HOSPITAL', progress: 0, route_to_hospital: [[28.6, 77.21], [28.6, 77.21]] };
  assert.equal(step(zero, legsOf(zero), 0).arrived, 'ARRIVED_AT_HOSPITAL', 'a zero-length leg arrives at once');
});

// ── Routing and settings ─────────────────────────────────────────────────────
test('ROUTING_URL: simulated routing is the default in every environment; explicit https (or local test) routing is opt-in', () => {
  assert.equal(parseRoutingUrl(undefined), null);
  assert.equal(parseRoutingUrl(''), null);
  assert.equal(parseRoutingUrl('', { production: true }), null);
  assert.equal(parseRoutingUrl('off'), null);
  assert.equal(parseRoutingUrl('https://osrm.example.org/base/'), 'https://osrm.example.org/base');
  assert.equal(parseRoutingUrl('http://127.0.0.1:5999'), 'http://127.0.0.1:5999');
  for (const [value, production] of [['http://osrm.example.org', false], ['http://127.0.0.1:5999', true], ['ftp://x', false], ['not a url', false],
    ['https://user:pw@osrm.example.org', false], ['https://osrm.example.org/?key=1', false]]) {
    assert.throws(() => parseRoutingUrl(value, { production }), /ROUTING_URL/, value);
  }
  // Batch 8 (P-0.2/P-0.3): a faster tick, a x4 demo speed-up and simulated transport outside production; none in production.
  assert.deepEqual(parseTrackingConfig({}), { tickMs: 500, legSeconds: { min: 30, max: 60 }, timeScale: 4, demoSpeedup: 4, simulatedTransport: true, routingUrl: null, routingTimeoutMs: 4000 });
  assert.deepEqual(parseTrackingConfig({ NODE_ENV: 'production' }), { tickMs: 1000, legSeconds: null, timeScale: 1, demoSpeedup: 1, simulatedTransport: false, routingUrl: null, routingTimeoutMs: 4000 });
  assert.deepEqual(parseTrackingConfig({ TRACKING_TIME_SCALE: '10', TRACKING_DEMO_SPEEDUP: '1', SIMULATED_TRANSPORT: 'off', TRACKING_LEG_SECONDS: 'off' }), { tickMs: 500, legSeconds: null, timeScale: 10, demoSpeedup: 1, simulatedTransport: false, routingUrl: null, routingTimeoutMs: 4000 });
  assert.equal(parseTrackingConfig({ NODE_ENV: 'production', SIMULATED_TRANSPORT: 'on' }).simulatedTransport, true, 'production may turn it on explicitly');
  assert.throws(() => parseTrackingConfig({ NODE_ENV: 'production', TRACKING_DEMO_SPEEDUP: '4' }), /TRACKING_DEMO_SPEEDUP .*must be 1/);
  assert.throws(() => parseTrackingConfig({ SIMULATED_TRANSPORT: 'yes' }), /SIMULATED_TRANSPORT/);
  assert.deepEqual(parseTrackingConfig({ NODE_ENV: 'production', TRACKING_LEG_SECONDS: '20-40' }).legSeconds, { min: 20, max: 40 }, 'production only when configured');
  for (const bad of ['60-30', '0-10', 'fast', '10-700']) assert.throws(() => parseTrackingConfig({ TRACKING_LEG_SECONDS: bad }), /TRACKING_LEG_SECONDS/, bad);
  assert.throws(() => parseTrackingConfig({ TRACKING_DEMO_SPEEDUP: '21' }), /must be a whole number/);
  assert.throws(() => parseTrackingConfig({ NODE_ENV: 'production', TRACKING_TIME_SCALE: '5' }), /must be 1/);
  for (const bad of [{ TRACKING_TICK_MS: '50' }, { TRACKING_TICK_MS: 'fast' }, { TRACKING_TIME_SCALE: '0' }, { ROUTING_TIMEOUT_MS: '99999' }]) {
    assert.throws(() => parseTrackingConfig(bad), /must be a whole number/, JSON.stringify(bad));
  }
});

test('routing: the OSRM request and answer ([lng, lat] -> [lat, lng], exact ends); any failure or timeout falls back to a simulated straight line', async () => {
  const from = [28.63, 77.218];
  const to = [28.6129, 77.2295];
  let asked = null;
  const ok = async url => {
    asked = url;
    return new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: [[77.2181, 28.6299], [77.225, 28.62], [77.2294, 28.613]] } }] }));
  };
  const points = await osrmLeg('https://osrm.test', from, to, { fetchImpl: ok });
  assert.equal(asked, 'https://osrm.test/route/v1/driving/77.218,28.63;77.2295,28.6129?overview=full&geometries=geojson');
  assert.deepEqual(points, [from, [28.6299, 77.2181], [28.62, 77.225], [28.613, 77.2294], to]);
  assert.deepEqual((await createRouter({ url: 'https://osrm.test', fetchImpl: ok, log: silent }).route(from, to)).source, 'osrm');

  const failures = {
    http500: async () => new Response('busy', { status: 500 }),
    noRoute: async () => new Response(JSON.stringify({ code: 'NoRoute', routes: [] })),
    badCoords: async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: [[777, 28], [77, 28]] } }] })),
    network: async () => { throw new TypeError('fetch failed'); },
    // AbortSignal.timeout's timer does not keep the process alive; the server's HTTP listener does, this keep-alive here.
    timeout: (url, { signal }) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 5000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
    })
  };
  for (const [name, fetchImpl] of Object.entries(failures)) {
    const warnings = [];
    const result = await createRouter({ url: 'https://osrm.test', fetchImpl, timeoutMs: 100, log: { warn: m => warnings.push(m) } }).route(from, to);
    assert.equal(result.source, 'simulated', name);
    assert.deepEqual([result.points[0], result.points.at(-1)], [from, to], name);
    assert.equal(warnings.length, 1, name);
    assert.ok(!warnings[0].includes('28.63') && !warnings[0].includes('77.2'), 'the log line carries no coordinates');
  }
  const off = await createRouter({ url: null, fetchImpl: () => assert.fail('routing is off: no request') }).route(from, to);
  assert.equal(off.source, 'simulated');
});

// ── Scoping ──────────────────────────────────────────────────────────────────
test('trip scoping: command centre all; a desk the trips to its hospital; a paramedic its own unit (start/pickup/complete only); patients nothing', () => {
  const trip = { trip_id: 'T', ambulance_id: 'AMB-01', hospital_id: 'H-101' };
  const users = {
    admin: { role: 'ADMIN' }, dispatcher: { role: 'DISPATCHER' }, desk: { role: 'HOSPITAL_DESK', hospital_id: 'H-101' },
    otherDesk: { role: 'HOSPITAL_DESK', hospital_id: 'H-102' }, medic: { role: 'PARAMEDIC', ambulance_id: 'AMB-01' },
    otherMedic: { role: 'PARAMEDIC', ambulance_id: 'AMB-04' }, noUnit: { role: 'PARAMEDIC', ambulance_id: null }, patient: { role: 'PATIENT', patient_id: 'P' }
  };
  const see = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, canSeeTrip(u, trip)]));
  assert.deepEqual(see, { admin: true, dispatcher: true, desk: true, otherDesk: false, medic: true, otherMedic: false, noUnit: false, patient: false });
  const acts = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, TRIP_ACTIONS.filter(a => canActOnTrip(u, trip, a))]));
  assert.deepEqual(acts, {
    admin: [...TRIP_ACTIONS], dispatcher: [...TRIP_ACTIONS], desk: [], otherDesk: [], medic: ['start', 'pickup', 'complete'],
    otherMedic: [], noUnit: [], patient: []
  });
  assert.deepEqual([tripFilter(users.admin), tripFilter(users.desk), tripFilter(users.medic), tripFilter(users.patient)],
    [{}, { hospitalId: 'H-101' }, { ambulanceId: 'AMB-01', activeOnly: true }, null]);
  // A paramedic never reads an earlier crew's finished trip of its unit (patient name, pickup point); staff still do.
  const finished = { ...trip, completed_at: '2026-11-14T00:00:00.000Z' };
  assert.deepEqual(Object.fromEntries(Object.entries(users).map(([k, u]) => [k, canSeeTrip(u, finished)])),
    { ...see, medic: false });
  assert.equal(patientMayCall('GET', '/api/v1/patient/cases/REQ-1/tracking'), true);
  assert.equal(patientMayCall('GET', '/api/v1/tracking/trips'), false);
  assert.equal(patientMayCall('POST', '/api/v1/patient/cases/REQ-1/tracking'), false);
});

// ── Engine on the in-memory store (fake clock, ticks driven by hand) ────────
const store = new MemoryStore();
const admin = { role: 'ADMIN', id: 'USER-ADM-001' };
let clock = 1_000_000;
const engineWith = (extra = {}) => new TrackingEngine({ store, tickMs: 100, timeScale: 1, log: silent, now: () => clock, ...extra });
const legMeters = trip => polylineMeters(trip.phase === 'EN_ROUTE_TO_HOSPITAL' ? trip.route_to_hospital : trip.route_to_patient);

test('engine: the sample trip moves along its route without jumps (also across a 10-minute clock jump and an engine restart)', async () => {
  const engine = engineWith();
  const { trip, outcome } = await setupDemoTrip(engine, admin, { speedKmh: 200 });
  assert.equal(outcome, 'created');
  assert.deepEqual([trip.request_id, trip.ambulance_id, trip.hospital_id, trip.phase, trip.is_demo], [DEMO_TRIP.requestId(1), 'AMB-01', 'H-101', 'DISPATCHED', 1]);
  const started = await engine.act(trip.trip_id, 'start', admin);
  assert.equal(started.phase, 'EN_ROUTE_TO_PATIENT');
  assert.equal((await store.getAmbulance('AMB-01')).status, 'IN_TRANSIT');
  const perTick = (200 / 3.6) * 0.1; // metres per 100 ms tick at 200 km/h
  const length = legMeters(started);

  clock += 100;
  await engine.tick();
  let current = await store.getTrip(trip.trip_id);
  assert.ok(Math.abs(current.progress * length - perTick) < 0.5, `one tick = ${perTick} m (got ${current.progress * length})`);
  clock += 600_000; // a stalled process / a long pause of the host
  await engine.tick();
  const afterJump = await store.getTrip(trip.trip_id);
  assert.ok((afterJump.progress - current.progress) * length <= 2 * perTick + 0.5, 'a clock jump moves at most two ticks');
  const unit = await store.getAmbulance('AMB-01');
  assert.deepEqual([unit.current_lat, unit.current_lng], [afterJump.current_lat, afterJump.current_lng], 'the unit position follows');

  const restarted = engineWith(); // a new process on the same store: continues from the persisted position
  clock += 5_000;
  await restarted.tick();
  current = await store.getTrip(trip.trip_id);
  assert.ok(current.progress > afterJump.progress && (current.progress - afterJump.progress) * length <= perTick + 0.5,
    'the restarted engine resumes from the stored progress with one normal step');
  for (let i = 0; i < 1000 && current.phase === 'EN_ROUTE_TO_PATIENT'; i += 1) {
    clock += 100;
    await restarted.tick();
    current = await store.getTrip(trip.trip_id);
  }
  assert.equal(current.phase, 'ARRIVED_AT_PATIENT');
  assert.deepEqual([current.current_lat, current.current_lng], DEMO_TRIP.pickup);
});

test('engine: pause holds the unit still, resume continues; pickup, hospital arrival (case status unchanged), complete keeps the unit until the handover; reset', async () => {
  const engine = engineWith();
  let trip = (await store.listTrips({ requestId: DEMO_TRIP.requestId(1) }))[0];
  assert.equal(trip.phase, 'ARRIVED_AT_PATIENT');
  await assert.rejects(engine.act(trip.trip_id, 'pause', admin), /only allowed while the ambulance is moving/);
  trip = await engine.act(trip.trip_id, 'pickup', admin);
  assert.deepEqual([trip.phase, trip.progress], ['EN_ROUTE_TO_HOSPITAL', 0]);
  clock += 100;
  await engine.tick();
  trip = await engine.act(trip.trip_id, 'pause', admin);
  const held = await store.getTrip(trip.trip_id);
  for (let i = 0; i < 5; i += 1) { clock += 100; await engine.tick(); }
  assert.deepEqual(await store.getTrip(trip.trip_id), held, 'paused: nothing moves');
  await engine.act(trip.trip_id, 'resume', admin);
  for (let i = 0; i < 2000 && (await store.getTrip(trip.trip_id)).phase === 'EN_ROUTE_TO_HOSPITAL'; i += 1) { clock += 100; await engine.tick(); }
  trip = await store.getTrip(trip.trip_id);
  const hospital = await store.getHospital('H-101');
  assert.deepEqual([trip.phase, trip.current_lat, trip.current_lng, trip.eta_seconds], ['ARRIVED_AT_HOSPITAL', hospital.location_lat, hospital.location_lng, 0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.getRequest(trip.request_id)).status, 'ALLOCATED', 'Batch 8: arrival never changes the case status');
  trip = await engine.act(trip.trip_id, 'complete', admin);
  assert.ok(trip.completed_at);
  const unit = await store.getAmbulance('AMB-01');
  assert.deepEqual([unit.status, unit.assigned_request_id ?? null], ['IN_TRANSIT', trip.request_id], 'Batch 8: not released until the hospital confirms the handover');
  await assert.rejects(engine.act(trip.trip_id, 'start', admin), /already completed/);
  trip = await engine.act(trip.trip_id, 'reset', admin);
  assert.deepEqual([trip.phase, trip.progress, trip.completed_at, trip.started_at, trip.picked_up_at, trip.paused],
    ['DISPATCHED', 0, null, null, null, 0]);
  assert.deepEqual([trip.current_lat, trip.current_lng], [trip.start_lat, trip.start_lng]);
  assert.equal((await store.getAmbulance('AMB-01')).status, 'DISPATCHED', 're-dispatched to the case');
  assert.equal(store.db.ambulanceTrips.filter(t => t.request_id === trip.request_id).length, 1, 'still one trip');
  assert.equal((await store.verifyAuditChain()).valid, true);
});

test('engine: reset is for demo trips only; one active trip per unit and per case; stale writes are refused; a unit taken off its case halts the trip', async () => {
  const engine = engineWith();
  const created = await store.createRequest({
    patient: { full_name: 'Fictional Tracking Unit Test', age: 30, gender: 'UNKNOWN', emergency_type: 'GENERAL', triage_priority: 3, contact_phone: null },
    request: { emergency_type: 'GENERAL', required_resource_types: [], required_specialist: null, priority: 3, pickup_lat: 28.607, pickup_lng: 77.203, clinical_notes: '' }
  }, admin);
  const lock = await store.acquireReferralLock('H-103', created.request_id, [], { initiatedBy: admin.id });
  const accepted = await store.commitReferral(lock.acceptanceId, admin.id);
  const unitId = accepted.ambulance_id;
  assert.ok(unitId, 'the accept dispatched a unit');
  await assert.rejects(engine.createTrip({ request_id: created.request_id, ambulance_id: 'AMB-01', start_lat: 28.6, start_lng: 77.2, speed_kmh: 60 }, admin),
    /AMB-01 already has an active trip/);
  const trip = await engine.createTrip({ request_id: created.request_id, ambulance_id: unitId, start_lat: 28.6, start_lng: 77.2, speed_kmh: 60 }, admin);
  assert.equal(trip.is_demo, 0);
  await assert.rejects(engine.act(trip.trip_id, 'reset', admin), /Only demo trips can be reset/);
  await assert.rejects(store.createTrip({ ...trip, trip_id: 'TRIP-DUP' }), /already has an active trip/);
  await assert.rejects(store.updateTrip(trip.trip_id, trip.version + 7, { paused: 1 }), err => err.code === 'TRIP_CONFLICT');

  await engine.act(trip.trip_id, 'start', admin);
  await store.updateAmbulanceStatus(unitId, { status: 'AVAILABLE' }, admin); // someone sends the unit back to station
  clock += 100;
  await engine.tick();
  const halted = await store.getTrip(trip.trip_id);
  assert.equal(halted.paused, 1);
  assert.ok(store.db.emergencyHistory.some(h => h.event_type === 'TRIP_HALTED' && h.metadata?.trip_id === trip.trip_id));
  await assert.rejects(engine.act(trip.trip_id, 'resume', admin), /no longer dispatched/);
});

test('migration 010 parity: the in-memory AmbulanceTrip rows have exactly the MySQL columns; the engine runs one timer however often it is started', async () => {
  const trip = store.db.ambulanceTrips[0];
  assert.ok(trip, 'trips were created above');
  assert.deepEqual(Object.keys(trip).sort(), TRIP_COLUMNS.split(',').map(c => c.trim()).sort());
  const engine = engineWith({ tickMs: 60_000 });
  engine.start();
  const timer = engine._timer;
  engine.start();
  assert.equal(engine._timer, timer, 'a second start() keeps the one timer');
  engine.stop();
  assert.equal(engine._timer, null);
});

test('a refused reset has no side effects: the unit of another active trip on the same case is not touched', async () => {
  const engine = engineWith();
  const sampleId = DEMO_TRIP.requestId(1);
  const [done] = await store.listTrips({ requestId: sampleId });
  // The sample trip is DISPATCHED again (reset above): drive it to completion quickly.
  await engine.act(done.trip_id, 'start', admin);
  for (let i = 0; i < 3000 && (await store.getTrip(done.trip_id)).phase !== 'ARRIVED_AT_PATIENT'; i += 1) { clock += 100; await engine.tick(); }
  await engine.act(done.trip_id, 'pickup', admin);
  for (let i = 0; i < 3000 && (await store.getTrip(done.trip_id)).phase !== 'ARRIVED_AT_HOSPITAL'; i += 1) { clock += 100; await engine.tick(); }
  await engine.act(done.trip_id, 'complete', admin);
  // A second trip on the same case with the same unit, now moving.
  const second = await engine.createTrip({ request_id: sampleId, ambulance_id: done.ambulance_id, start_lat: 28.62, start_lng: 77.22, speed_kmh: 60 }, admin,
    { statuses: ['ALLOCATED', 'IN_TREATMENT'] });
  await engine.act(second.trip_id, 'start', admin);
  const unitBefore = { ...(await store.getAmbulance(done.ambulance_id)) };
  const auditBefore = store.db.emergencyHistory.length;
  await assert.rejects(engine.act(done.trip_id, 'reset', admin), /already has another active trip/);
  assert.deepEqual({ ...(await store.getAmbulance(done.ambulance_id)) }, unitBefore, 'the unit was not sent to station and back');
  assert.equal(store.db.emergencyHistory.length, auditBefore, 'nothing was written');
  assert.equal((await store.getTrip(second.trip_id)).phase, 'EN_ROUTE_TO_PATIENT');
});

test('a patient account linked a moment ago receives patient:tracking on the very next tick (no stale account cache)', async () => {
  const engine = engineWith();
  const [moving] = await store.listMovingTrips();
  assert.ok(moving, 'a moving trip exists');
  const patientId = (await store.getRequest(moving.request_id)).patient_id;
  const updates = [];
  engine.on('update', u => updates.push(u));
  clock += 100;
  await engine.tick();
  const before = updates.at(-1).patient?.accountIds ?? [];
  await store.createUser({ user_id: 'USER-PAT-FRESH', username: 'fresh.patient', display_name: 'Fictional', role: 'PATIENT',
    password_hash: 'x', patient_id: patientId }, admin);
  clock += 100;
  await engine.tick();
  assert.ok(!before.includes('USER-PAT-FRESH'));
  assert.ok(updates.at(-1).patient.accountIds.includes('USER-PAT-FRESH'), 'linked between two ticks: included on the next one');
  assert.deepEqual(Object.keys(updates.at(-1).patient.payload).sort(),
    ['current', 'eta_seconds', 'hospital', 'phase', 'pickup', 'request_id', 'route_source', 'simulated']);
});

test('demo-setup creates no demo patient account and always drives the unit crewed by the demo Fleet login (AMB-01 / UNIT-402)', async () => {
  const engine = engineWith();
  const result = await setupDemoTrip(engine, admin);
  assert.ok(!('patient_username' in result));
  assert.equal(store.db.systemUsers.filter(u => u.username === 'patient_demo' || (Number(u.is_demo) === 1 && ['PATIENT', 'DISPATCHER'].includes(u.role))).length, 0,
    'no Operator or Patient demo account');
  assert.equal(result.trip.ambulance_id, 'AMB-01');
  assert.deepEqual(store.db.systemUsers.filter(u => u.ambulance_id === result.trip.ambulance_id).map(u => u.username), ['UNIT-402']);
});

test('production: POST /tracking/demo-trips and /tracking/demo-setup are refused (403) and change nothing', async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
  process.env.JWT_SECRET = 'production-refusal-test-secret-0123456789';
  configureStore(store); // as bootstrapStore does: production never falls back to an implicit store
  const token = memoryTokenFor(store.db, { user_id: 'USER-PROD-ADMIN', role: 'ADMIN' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tracking', trackingRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1/tracking`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    process.env.NODE_ENV = 'production';
    const trips = store.db.ambulanceTrips.length;
    const units = JSON.stringify(store.db.ambulances);
    const created = await post('/demo-trips', { request_id: DEMO_TRIP.requestId(1), ambulance_id: 'AMB-05', start_lat: 30.3, start_lng: 78.0 });
    assert.equal(created.status, 403);
    assert.match((await created.json()).error, /not available in production/);
    assert.equal((await post('/demo-setup', {})).status, 403);
    assert.deepEqual([store.db.ambulanceTrips.length, JSON.stringify(store.db.ambulances)], [trips, units]);
    process.env.NODE_ENV = 'test';
    assert.equal((await post('/demo-trips', { request_id: 'REQ-0000', ambulance_id: 'AMB-05', start_lat: 30.3, start_lng: 78.0 })).status, 404,
      'outside production the same request reaches the handler');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
  }
});
