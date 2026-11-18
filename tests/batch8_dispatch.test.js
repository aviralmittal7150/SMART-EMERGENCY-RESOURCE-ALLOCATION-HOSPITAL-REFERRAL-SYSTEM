// Batch 8 (P-0): Dehradun operating area, verified demo geography, the route guard, admin dispatch with suggestions and
// the immediate simulated transport on acceptance, and the ambulance's status through the journey up to the hospital's
// handover confirmation. End to end against a real `node server/server.js` with a local FAKE routing service (never the
// internet). Runs on the in-memory store; tests/batch8_dispatch_mysql.test.js runs it on the MySQL test database.
// All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connectSocket } from './helpers/rawSocket.js';
import { LOCALITIES, OPERATING_AREA, insideArea, areaProblem } from '../server/services/operatingArea.js';
import { routeProblem, createRouter } from '../server/services/tracking/routing.js';
import { straightLine } from '../server/services/tracking/geo.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4283 : 4282;
const OSRM_PORT = BACKEND === 'mysql' ? 4285 : 4284;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'batch8-dispatch-test-secret-0123456789ab';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DELHI = [28.6129, 77.2295];

// ── Fake routing service: 'ok' an L-shaped road route; 'away' a route through Delhi (leaves the operating area) ──
let osrmMode = 'ok';
const osrm = http.createServer((req, res) => {
  const match = req.url.match(/^\/route\/v1\/driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?overview=full&geometries=geojson$/);
  if (!match) { res.writeHead(500); res.end(); return; }
  const [lng1, lat1, lng2, lat2] = match.slice(1).map(Number);
  const middle = osrmMode === 'away' ? [DELHI[1], DELHI[0]] : [lng2, lat1];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[lng1, lat1], middle, [lng2, lat2]] } }] }));
});

let server = null;
let database = null;
let skipReason = null;
const T = {};
const ctx = {};

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const skipped = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };
async function waitFor(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}
const activeTrip = async requestId => (await call('/api/v1/tracking/trips', T.admin)).body.trips.find(t => t.request_id === requestId && !t.completed) ?? null;

test.before(async () => {
  osrm.listen(OSRM_PORT, '127.0.0.1');
  await once(osrm, 'listening');
  // Simulated transport ON (as in development); a fast clock so a cross-town leg takes a few seconds.
  const settings = { JWT_SECRET: SECRET, API_RATE_LIMIT: '100000', SOCKET_RECHECK_MS: '1000', ROUTING_URL: `http://127.0.0.1:${OSRM_PORT}`,
    ROUTING_TIMEOUT_MS: '500', TRACKING_TICK_MS: '100', TRACKING_TIME_SCALE: '25', TRACKING_DEMO_SPEEDUP: '4', SIMULATED_TRANSPORT: 'on',
    TRACKING_LEG_SECONDS: '3-6' }; // time compression as in development (30-60 s there), shortened for the test
  let env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))), PORT: String(PORT), DB_USE_MEMORY: 'true', ...settings };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  delete env.NODE_ENV;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true);
    env = mysqlServerEnv(PORT, { ...settings, JWT_EXPIRES: '', TRUST_PROXY: '' });
  }
  server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  ctx.log = () => log;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  for (const [key, [username, password]] of Object.entries({ admin: ['admin', 'admin123'], apex: ['apex_desk', 'hospital123'],
    stjude: ['stjude_desk', 'hospital123'], medic: ['UNIT-402', 'paramedic123'], otherMedic: ['UNIT-601', 'paramedic123'] })) {
    const result = await call('/api/v1/auth/login', null, 'POST', { username, password });
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
  }
});

test.after(async () => {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  osrm.close();
  if (database && !database.skip) {
    try { await database.reset(true); } finally { await database.release(); }
  }
});

// ── Operating area and route guard (pure) ─────────────────────────────────────
test('the Dehradun operating area contains every verified locality with margin; the route guard refuses detours and other cities', () => {
  for (const [key, l] of Object.entries(LOCALITIES)) {
    assert.ok(insideArea(l.lat, l.lng), key);
    assert.ok(l.lat - OPERATING_AREA.minLat > 0.04 && OPERATING_AREA.maxLat - l.lat > 0.04 && l.lng - OPERATING_AREA.minLng > 0.04 && OPERATING_AREA.maxLng - l.lng > 0.04, `${key} has margin`);
    assert.match(l.osm, /^(way|node) \d+/, 'the OSM source is recorded');
  }
  assert.equal(insideArea(...DELHI), false);
  assert.equal(areaProblem([['pickup', null, null]]), null, 'not given passes');
  assert.match(areaProblem([['pickup', ...DELHI]]), /pickup is outside the operating area \(Dehradun/);
  assert.match(areaProblem([['pickup', 30.3, null]]), /needs both/);
  const from = [LOCALITIES.CLOCK_TOWER.lat, LOCALITIES.CLOCK_TOWER.lng];
  const to = [LOCALITIES.ISBT.lat, LOCALITIES.ISBT.lng];
  assert.equal(routeProblem([from, [from[0], to[1]], to], from, to, OPERATING_AREA), null, 'an ordinary road route');
  assert.match(routeProblem([from, DELHI, to], from, to, OPERATING_AREA), /leaves the operating area/);
  const detour = [from, [30.44, 78.14], [30.21, 78.14], to];
  assert.match(routeProblem(detour, from, to, OPERATING_AREA), /x the straight-line distance/);
  assert.equal(routeProblem([from, DELHI, to], from, to, null), null, 'no area: unchecked (unit tests of the engine)');
});

test('the router falls back to the labelled, deterministic straight line when the road route fails the guard', async () => {
  const from = [LOCALITIES.CLOCK_TOWER.lat, LOCALITIES.CLOCK_TOWER.lng];
  const to = [LOCALITIES.PREM_NAGAR.lat, LOCALITIES.PREM_NAGAR.lng];
  const warnings = [];
  const fetchImpl = async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: [[from[1], from[0]], [DELHI[1], DELHI[0]], [to[1], to[0]]] } }] }));
  const router = createRouter({ url: 'https://osrm.test', fetchImpl, area: OPERATING_AREA, log: { warn: m => warnings.push(m) } });
  const leg = await router.route(from, to);
  assert.deepEqual([leg.source, leg.points], ['simulated', straightLine(from, to)]);
  assert.match(warnings[0], /Road route refused \(the route leaves the operating area\)/);
  assert.ok(!warnings[0].includes('30.3'), 'no coordinates in the log');
});

test('time compression: every leg lasts min-max real seconds whatever its length; off means real speed x time scale', async () => {
  const { TrackingEngine } = await import('../server/services/tracking/engine.js');
  const compressed = new TrackingEngine({ store: null, timeScale: 4, legSeconds: { min: 30, max: 60 } });
  assert.equal(compressed.legDuration(500, 90), 30, 'a short leg is stretched to 30 s');
  assert.equal(compressed.legDuration(30_000, 90), 60, 'a long leg is compressed to 60 s');
  assert.equal(compressed.legDuration(4_500, 90), 45, 'in between: real speed x time scale');
  assert.equal(compressed.legDuration(0, 90), 0, 'a zero-length leg ends at once');
  const plain = new TrackingEngine({ store: null, timeScale: 1 });
  assert.equal(plain.legDuration(25_000, 90), 1000, 'production default: real speed');
});

test(`GET /geo/operating-area: the bbox and the verified localities, for every signed-in role [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  assert.equal((await call('/api/v1/geo/operating-area', null)).status, 401);
  for (const token of [T.admin, T.apex, T.medic]) {
    const area = await call('/api/v1/geo/operating-area', token);
    assert.equal(area.status, 200);
    assert.deepEqual(area.body.bbox, { min_lat: 30.2, max_lat: 30.45, min_lng: 77.9, max_lng: 78.15 });
    assert.equal(area.body.name, 'Dehradun, Uttarakhand');
    assert.deepEqual(area.body.localities.map(l => l.name), ['Clock Tower (Ghanta Ghar)', 'Rajpur Road', 'ISBT Dehradun', 'Premnagar', 'Clement Town', 'Sahastradhara Road']);
    for (const l of area.body.localities) assert.ok(insideArea(l.lat, l.lng));
  }
});

test('in-memory engine: an AVAILABLE unit positioned outside the operating area is never auto-dispatched', async () => {
  const { MemoryStore } = await import('../server/db/memoryStore.js');
  const store = new MemoryStore();
  const unit = store.db.ambulances.find(a => a.ambulance_id === 'AMB-01');
  const saved = [unit.current_lat, unit.current_lng];
  Object.assign(unit, { current_lat: DELHI[0], current_lng: DELHI[1] });
  try {
    const created = await store.createRequest({
      patient: { full_name: 'Fictional Engine Area', age: 40, gender: 'UNKNOWN', emergency_type: 'GENERAL', triage_priority: 3, contact_phone: null },
      request: { emergency_type: 'GENERAL', required_resource_types: [], required_specialist: null, priority: 3, pickup_lat: 30.33, pickup_lng: 78.04, clinical_notes: '' }
    }, { role: 'ADMIN', id: 'USER-ADM-001' });
    const lock = await store.acquireReferralLock('H-101', created.request_id, []);
    const committed = await store.commitReferral(lock.acceptanceId, 'USER-HSP-101');
    assert.ok(committed.ambulance_id && committed.ambulance_id !== 'AMB-01', `skipped AMB-01: got ${committed.ambulance_id}`);
    assert.equal(unit.status, 'AVAILABLE');
    await store.transitionRequestStatus(created.request_id, 'CANCELLED', { role: 'ADMIN', id: 'USER-ADM-001' });
  } finally {
    Object.assign(unit, { current_lat: saved[0], current_lng: saved[1] });
    for (const entry of store.lockingEngine._activeLocks?.values?.() ?? []) clearInterval(entry.countdownTimer);
  }
});

// ── Demo geography ─────────────────────────────────────────────────────────────
test(`seed: every hospital and unit is in Dehradun; hospital names are fictional and marked demo [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const hospitals = (await call('/api/v1/hospitals', T.admin)).body.hospitals;
  assert.equal(hospitals.length, 6);
  for (const h of hospitals) {
    assert.ok(insideArea(Number(h.location_lat), Number(h.location_lng)), h.hospital_id);
    assert.match(h.hospital_name, /\(demo\)$/);
    assert.doesNotMatch(h.hospital_name, /Apex|Fortis|Max|Jude|Memorial|AIIMS|Delhi/i);
  }
  const units = (await call('/api/v1/ambulances', T.admin)).body.ambulances;
  for (const u of units) assert.ok(insideArea(Number(u.current_lat), Number(u.current_lng)), u.ambulance_id);
  // Stations spread over the localities: from each locality the nearest free unit is within 5 km.
  const { haversineMeters } = await import('../server/services/tracking/geo.js');
  for (const l of Object.values(LOCALITIES)) {
    const nearest = Math.min(...units.filter(u => u.status === 'AVAILABLE').map(u => haversineMeters([l.lat, l.lng], [Number(u.current_lat), Number(u.current_lng)])));
    assert.ok(nearest <= 5000, `${l.name}: nearest free unit ${Math.round(nearest)} m`);
  }
});

test(`operating area: a pickup, unit position or trip start outside Dehradun is refused (400) and nothing is stored [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const before = (await call('/api/v1/emergencies', T.admin)).body.count;
  const outside = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Outside', age: 30, emergency_type: 'GENERAL', pickup_lat: DELHI[0], pickup_lng: DELHI[1] });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /outside the operating area \(Dehradun/);
  assert.equal((await call('/api/v1/emergencies', T.admin)).body.count, before, 'nothing stored');
  assert.equal((await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Half', age: 30, emergency_type: 'GENERAL', pickup_lat: 30.3 })).status, 400);
  const unit = await call('/api/v1/ambulances/AMB-03/status', T.admin, 'PATCH', { status: 'AVAILABLE', current_lat: DELHI[0], current_lng: DELHI[1] });
  assert.equal(unit.status, 400);
  assert.notEqual((await call('/api/v1/ambulances/AMB-03', T.admin)).body.ambulance.current_lat, DELHI[0]);
  const trip = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', { request_id: 'REQ-8903', ambulance_id: 'AMB-03', start_lat: DELHI[0], start_lng: DELHI[1] });
  assert.deepEqual([trip.status, /operating area/.test(trip.body.error)], [400, true], 'validated before routing');
  // A unit somewhere else (legacy data, written behind the API) is never auto-dispatched: the accept takes an in-area unit.
  if (BACKEND === 'mysql') await database.admin.query('UPDATE Ambulance SET current_lat = ?, current_lng = ? WHERE ambulance_id = ?', [DELHI[0], DELHI[1], 'AMB-01']);
  if (BACKEND === 'mysql') {
    const created = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Area Unit', age: 40, emergency_type: 'GENERAL', pickup_lat: 30.33, pickup_lng: 78.04 });
    const sent = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: created.body.request_id, hospital_id: 'H-101' });
    const accepted = await call(`/api/v1/referrals/${sent.body.acceptance_id}/accept`, T.apex, 'POST');
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.ambulance_id && accepted.body.ambulance_id !== 'AMB-01', `AMB-01 (outside the area) is skipped: got ${accepted.body.ambulance_id}`);
    assert.equal((await call('/api/v1/ambulances/AMB-01', T.admin)).body.ambulance.status, 'AVAILABLE');
    assert.equal((await call(`/api/v1/emergencies/${created.body.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
    await database.admin.query('UPDATE Ambulance SET current_lat = ?, current_lng = ? WHERE ambulance_id = ?', [LOCALITIES.CLOCK_TOWER.lat, LOCALITIES.CLOCK_TOWER.lng, 'AMB-01']);
  }
});

// ── Dispatch with suggestions, override, immediate transport, handover ────────
test(`dispatch: suggestions, the admin's unit choice, the trip starts on acceptance, the unit stays busy until the hospital confirms arrival [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const sockets = {};
  for (const who of ['admin', 'apex', 'stjude', 'medic', 'otherMedic']) sockets[who] = await connectSocket(BASE, T[who]);
  const pickup = [30.3005, 78.0102]; // fictional pickup between ISBT and the Clock Tower
  const created = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Dispatch Patient', age: 52, emergency_type: 'GENERAL', triage_priority: 2, pickup_lat: pickup[0], pickup_lng: pickup[1] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request_id;

  assert.equal((await call(`/api/v1/emergencies/${id}/dispatch-options`, T.apex)).status, 403);
  assert.equal((await call(`/api/v1/emergencies/${id}/dispatch-options`, T.medic)).status, 403);
  const options = await call(`/api/v1/emergencies/${id}/dispatch-options`, T.admin);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const units = options.body.ambulances;
  assert.ok(units.length >= 2 && units.every(u => typeof u.distance_km === 'number'));
  assert.ok(units.every((u, i) => i === 0 || units[i - 1].distance_km <= u.distance_km), 'nearest first');
  assert.ok(!units.some(u => ['AMB-02', 'AMB-05'].includes(u.ambulance_id)), 'only AVAILABLE units (AMB-02 is on the road, AMB-05 in maintenance)');
  assert.equal(options.body.suggested.ambulance_id, units[0].ambulance_id);
  const ranked = options.body.hospitals;
  assert.ok(!ranked.some(h => h.hospital_id === 'H-106'), 'a CLOSED hospital is never suggested');
  assert.ok(ranked.every(h => Array.isArray(h.reasons)));
  assert.equal(options.body.suggested.hospital_id, ranked.find(h => h.eligible).hospital_id);

  // The admin overrides the suggested unit with AMB-04 (crewed by UNIT-601) and sends the referral to H-101.
  const busy = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: id, hospital_id: 'H-101', ambulance_id: 'AMB-05' });
  assert.equal(busy.status, 409, 'a unit in maintenance cannot be chosen');
  const sent = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: id, hospital_id: 'H-101', ambulance_id: 'AMB-04' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.dispatch_ambulance_id, 'AMB-04');
  const accepted = await call(`/api/v1/referrals/${sent.body.acceptance_id}/accept`, T.apex, 'POST');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.ambulance_id, 'AMB-04', "the admin's choice is dispatched");

  // The trip is created and started at once, on the road route from the unit's position.
  const trip = await waitFor(() => activeTrip(id), 5000);
  assert.ok(trip, 'a simulated trip exists right after the accept');
  assert.deepEqual([trip.ambulance.ambulance_id, trip.route_source, trip.is_demo], ['AMB-04', 'osrm', false]);
  assert.ok(['EN_ROUTE_TO_PATIENT', 'ARRIVED_AT_PATIENT'].includes(trip.phase), trip.phase);
  assert.equal((await call('/api/v1/ambulances/AMB-04', T.admin)).body.ambulance.status, 'IN_TRANSIT');

  // Time compression: the ETA counts down in real seconds and every leg lasts 3-6 s here (30-60 s in development),
  // whatever its length (this first leg is about 17 km of road).
  assert.ok(trip.eta_seconds <= 6, `the ETA is real seconds left: ${trip.eta_seconds}`);
  const leg1Start = Date.now();
  assert.ok(await waitFor(async () => (await activeTrip(id))?.phase === 'ARRIVED_AT_PATIENT'), 'reaches the patient');
  const leg1 = (Date.now() - leg1Start) / 1000;
  assert.ok(leg1 >= 1.5 && leg1 <= 9, `leg 1 took ${leg1} s`);
  // Pickup (Fleet), then on to the hospital; arrival there does not free the unit or change the case.
  assert.equal((await call(`/api/v1/tracking/trips/${trip.trip_id}/pickup`, T.otherMedic, 'POST')).status, 200);
  const leg2Start = Date.now();
  assert.ok(await waitFor(async () => (await activeTrip(id))?.phase === 'ARRIVED_AT_HOSPITAL'), 'reaches the hospital');
  const leg2 = (Date.now() - leg2Start) / 1000;
  assert.ok(leg2 >= 1.5 && leg2 <= 9, `leg 2 took ${leg2} s (a 2.9 km leg is stretched to the minimum)`);
  const atHospital = (await call(`/api/v1/emergencies/${id}`, T.admin)).body.request;
  assert.deepEqual([atHospital.status, atHospital.arrived_at, atHospital.assigned_ambulance_id], ['ALLOCATED', null, 'AMB-04']);
  assert.equal((await call('/api/v1/ambulances/AMB-04', T.admin)).body.ambulance.status, 'IN_TRANSIT', 'busy until the handover');

  // The hospital confirms the arrival: the trip ends, the unit is AVAILABLE again, no transport is needed any more.
  const arrived = await call(`/api/v1/emergencies/${id}/arrive`, T.apex, 'POST');
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.deepEqual([arrived.body.closed_trip_ids, arrived.body.released_ambulance_id], [[trip.trip_id], 'AMB-04']);
  const unit = (await call('/api/v1/ambulances/AMB-04', T.admin)).body.ambulance;
  assert.deepEqual([unit.status, unit.assigned_request_id ?? null], ['AVAILABLE', null]);
  const after = (await call(`/api/v1/emergencies/${id}`, T.admin)).body.request;
  assert.deepEqual([after.status, Boolean(after.arrived_at), after.transport_required], ['ALLOCATED', true, false]);
  assert.equal(await activeTrip(id), null, 'no trip holds the unit');
  const trail = (await call(`/api/v1/emergencies/${id}/audit`, T.admin)).body.audit_trail.map(e => e.event_type);
  for (const e of ['DISPATCH_PLANNED', 'ALLOCATION_COMMITTED', 'TRIP_CREATED', 'PATIENT_ARRIVED', 'TRIP_CLOSED']) assert.ok(trail.includes(e), e);
  assert.equal((await call('/api/v1/audit/verify', T.admin)).body.verification.valid, true);

  // Live: the unit's crew and the hospital follow the journey; another hospital and another crew hear nothing of it.
  await sleep(300);
  await Promise.all(Object.values(sockets).map(s => s.waitFor(() => false, 200)));
  const caseEvents = who => sockets[who].events.filter(e => e.name === 'case:status' && e.payload.request_id === id).map(e => e.payload.milestone);
  assert.deepEqual(caseEvents('admin'), ['ACCEPTED', 'ARRIVED']);
  assert.deepEqual(caseEvents('apex'), ['ACCEPTED', 'ARRIVED']);
  assert.deepEqual(caseEvents('otherMedic'), ['ACCEPTED', 'ARRIVED'], 'the crew of AMB-04');
  assert.deepEqual([caseEvents('stjude'), caseEvents('medic')], [[], []]);
  const tracked = who => sockets[who].events.filter(e => e.name === 'tracking:update' && e.payload.trip_id === trip.trip_id).length;
  assert.ok(tracked('otherMedic') > 3 && tracked('apex') > 3 && tracked('admin') > 3);
  assert.deepEqual([tracked('stjude'), tracked('medic')], [0, 0]);
  ctx.unitAfter = unit;
});

test(`a road route that leaves Dehradun is never used: the trip falls back to the simulated straight line [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  osrmMode = 'away';
  try {
    const created = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Guard Patient', age: 33, emergency_type: 'GENERAL', pickup_lat: 30.345, pickup_lng: 78.05 });
    const sent = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: created.body.request_id, hospital_id: 'H-101' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const accepted = await call(`/api/v1/referrals/${sent.body.acceptance_id}/accept`, T.apex, 'POST');
    assert.equal(accepted.status, 200);
    const trip = await waitFor(() => activeTrip(created.body.request_id), 5000);
    assert.ok(trip, 'the trip starts');
    assert.equal(trip.route_source, 'simulated');
    for (const [lat, lng] of [...trip.route_to_patient, ...trip.route_to_hospital]) assert.ok(insideArea(lat, lng), 'every point stays in Dehradun');
    assert.match(ctx.log(), /Road route refused \(the route leaves the operating area\)/);
  } finally {
    osrmMode = 'ok';
  }
});
