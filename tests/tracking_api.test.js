// Batch 7, ambulance live-tracking demo, end to end against a real `node server/server.js`: the sample demo set-up
// (idempotent, accepted through the normal referral path), every valid and invalid trip transition over the API, the
// persisted position at each step (progressive along the route, never a jump, ending exactly at the pickup point and the
// hospital, the unit's position following), pause / resume, complete and reset, the scope matrix for every role over
// REST and Socket.IO (the patient's own case vs another's), and routing through a local FAKE OSRM server: success,
// failure and timeout (never the internet). With the MySQL backend also the restart: a moving trip resumes from its
// persisted position. Runs on the in-memory store; tests/tracking_api_mysql.test.js runs it on the MySQL test database.
// All data is fictional.
// Batch 8: the Operator (DISPATCHER) and Patient roles are retired and dormant. Their scoping is still tested on MySQL with
// accounts inserted directly into the store; the in-memory store cannot hold such accounts, so those parts are skipped
// there. The demo set-up always uses the unit crewed by a demo Fleet login (AMB-01 / UNIT-402), freeing it from another
// DEMO case, never from a real one; the ADMIN trip view names that crew.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connectSocket } from './helpers/rawSocket.js';
import { haversineMeters, cumulativeMeters, pointAtMeters } from '../server/services/tracking/geo.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4271 : 4270;
const OSRM_PORT = BACKEND === 'mysql' ? 4273 : 4272;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'tracking-api-test-secret-0123456789abcdef';
const TICK_MS = 100;
const TIME_SCALE = 10;
const SPEED = 200; // km/h: with the x10 time scale about 556 m per second of test time
const MAX_STEP_M = (SPEED / 3.6) * TIME_SCALE * ((2 * TICK_MS) / 1000); // the engine's cap: two ticks
const PATIENT_PASSWORD = 'Fictional-Tracking-Pass-31';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TRIP_KEYS = ['ambulance', 'case', 'completed', 'current', 'eta_seconds', 'hospital', 'is_demo', 'patient', 'paused', 'phase', 'pickup',
  'progress', 'request_id', 'route_source', 'route_to_hospital', 'route_to_patient', 'speed_kmh', 'start', 'timestamps', 'trip_id'];
const UPDATE_KEYS = ['completed', 'current', 'eta_seconds', 'paused', 'phase', 'progress', 'request_id', 'route_source', 'trip_id'];
const PATIENT_KEYS = ['current', 'eta_seconds', 'hospital', 'phase', 'pickup', 'route_source', 'simulated'];

// ── A fake OSRM server: 'ok' answers an L-shaped road route, 'fail' a 500, 'slow' never in time ──
let osrmMode = 'ok';
const osrmRequests = [];
const osrm = http.createServer((req, res) => {
  osrmRequests.push(req.url);
  const match = req.url.match(/^\/route\/v1\/driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?overview=full&geometries=geojson$/);
  if (osrmMode === 'fail' || !match) { res.writeHead(500); res.end('fake failure'); return; }
  if (osrmMode === 'slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); return; }
  const [lng1, lat1, lng2, lat2] = match.slice(1).map(Number);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[lng1, lat1], [lng2, lat1], [lng2, lat2]] } }] }));
});

let server = null;
let serverLog = '';
let database = null;
let env = null;
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
const login = async (username, password) => call('/api/v1/auth/login', null, 'POST', { username, password });
const skipped = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };
const getTrip = async (id, token = T.admin) => (await call(`/api/v1/tracking/trips/${id}`, token)).body.trip;
const act = (id, action, token = T.admin) => call(`/api/v1/tracking/trips/${id}/${action}`, token, 'POST');
const sql = async (query, params = []) => (await database.admin.query(query, params))[0];

async function startServer() {
  server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog}`);
    await sleep(100);
  }
}
async function stopServer() {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
}

test.before(async () => {
  osrm.listen(OSRM_PORT, '127.0.0.1');
  await once(osrm, 'listening');
  const settings = {
    JWT_SECRET: SECRET, SOCKET_RECHECK_MS: '1000', API_RATE_LIMIT: '100000', ROUTING_URL: `http://127.0.0.1:${OSRM_PORT}`,
    ROUTING_TIMEOUT_MS: '300', TRACKING_TICK_MS: String(TICK_MS), TRACKING_TIME_SCALE: String(TIME_SCALE),
    TRACKING_DEMO_SPEEDUP: '1', SIMULATED_TRANSPORT: 'off', TRACKING_LEG_SECONDS: 'off'
  };
  env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))), PORT: String(PORT), DB_USE_MEMORY: 'true', ...settings };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  delete env.NODE_ENV;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true);
    // ENABLE_RETIRED_ROLES=1 (test-only): the dormant DISPATCHER / PATIENT scoping is still exercised here.
    env = mysqlServerEnv(PORT, { ...settings, JWT_EXPIRES: '', TRUST_PROXY: '', ENABLE_RETIRED_ROLES: '1' });
  }
  await startServer();
  const accounts = {
    admin: ['admin', 'admin123'], apex: ['apex_desk', 'hospital123'], stjude: ['stjude_desk', 'hospital123'],
    fortis: ['fortis_desk', 'hospital123'], medic: ['UNIT-402', 'paramedic123'], otherMedic: ['UNIT-601', 'paramedic123']
  };
  if (BACKEND === 'mysql') {
    // Dormant roles, inserted straight into the store (no API or tool may create them any more).
    const hash = await (await import('bcryptjs')).default.hash(PATIENT_PASSWORD, 4);
    await sql(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo) VALUES
      ('USER-DSP-T11', 'fictional.trk.dispatch', ?, 'DISPATCHER', NULL, 'Fictional Operator', 1, 0),
      ('USER-PAT-T11', 'fictional.trk.vance', ?, 'PATIENT', 'PAT-001', 'Fictional Vance', 1, 0)`, [hash, hash]);
    Object.assign(accounts, { dispatcher: ['fictional.trk.dispatch', PATIENT_PASSWORD], vance: ['fictional.trk.vance', PATIENT_PASSWORD] });
  }
  for (const [key, [username, password]] of Object.entries(accounts)) {
    const result = await login(username, password);
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
  }
});

test.after(async () => {
  await stopServer();
  osrm.close();
  if (database && !database.skip) {
    try { await database.reset(true); } finally { await database.release(); } // leave the clean demo seed for whoever runs next
  }
});

// ── Demo set-up ──────────────────────────────────────────────────────────────
test(`demo-setup: a sample case accepted through the normal referral path and one trip on an OSRM route; repeated calls change nothing [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  for (const token of [T.dispatcher, T.apex, T.medic, T.vance].filter(Boolean)) {
    assert.equal((await call('/api/v1/tracking/demo-setup', token, 'POST', {})).status, 403);
    assert.equal((await call('/api/v1/tracking/demo-trips', token, 'POST', {})).status, 403);
  }
  // AMB-01 (crew UNIT-402) is first put on another DEMO case, REQ-8903, through the normal referral: the set-up must free it
  // from there instead of taking a unit no Fleet login crews.
  const lock8903 = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: 'REQ-8903', hospital_id: 'H-101' });
  assert.equal(lock8903.status, 201, JSON.stringify(lock8903.body));
  const accept8903 = await call(`/api/v1/referrals/${lock8903.body.acceptance_id}/accept`, T.apex, 'POST');
  assert.deepEqual([accept8903.status, accept8903.body.ambulance_id], [200, 'AMB-01'], 'AMB-01 is busy on the demo case REQ-8903');

  const first = await call('/api/v1/tracking/demo-setup', T.admin, 'POST', { speed_kmh: SPEED });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const trip = first.body.trip;
  assert.deepEqual([first.body.outcome, first.body.request_id], ['created', 'REQ-DT-001']);
  assert.ok(!('patient_username' in first.body), 'no demo patient account any more');
  assert.equal((await login('patient_demo', 'patient123')).status, 401);
  assert.deepEqual(Object.keys(trip).sort(), [...TRIP_KEYS, 'crew'].sort(), 'an ADMIN also gets the crew');
  assert.deepEqual(trip.crew, ['UNIT-402'], 'the Fleet login that drives it');
  const units = (await call('/api/v1/ambulances', T.admin)).body.ambulances;
  assert.deepEqual(units.filter(u => u.assigned_request_id === 'REQ-DT-001').map(u => [u.ambulance_id, u.status]), [['AMB-01', 'DISPATCHED']],
    'only the crewed unit serves the sample case');
  const req8903 = (await call('/api/v1/emergencies/REQ-8903', T.admin)).body;
  assert.deepEqual([req8903.request.assigned_ambulance_id, req8903.request.status], [null, 'ALLOCATED'], 'freed from the demo case through the normal path');
  assert.deepEqual([trip.phase, trip.progress, trip.route_source, trip.is_demo, trip.paused, trip.speed_kmh, trip.ambulance.ambulance_id],
    ['DISPATCHED', 0, 'osrm', true, false, SPEED, 'AMB-01']);
  assert.deepEqual(trip.patient, { patient_id: 'PAT-DT-001', full_name: 'Demo Tracking Patient' });
  assert.deepEqual(trip.case, { priority: 2, emergency_type: 'GENERAL', status: 'ALLOCATED' });
  assert.deepEqual(trip.pickup, { lat: 30.3061, lng: 78.0199 }, 'from EmergencyRequest.pickup_*');
  assert.deepEqual(trip.hospital, { hospital_id: 'H-101', name: 'Clock Tower Trauma Centre (demo)', lat: 30.3243, lng: 78.0419 }, 'from Hospital');
  assert.deepEqual(trip.start, { lat: 30.3243, lng: 78.0419 }, 'AMB-01 starts where it stands');
  assert.deepEqual([trip.route_to_patient[0], trip.route_to_patient.at(-1), trip.route_to_hospital[0], trip.route_to_hospital.at(-1)],
    [[30.3243, 78.0419], [30.3061, 78.0199], [30.3061, 78.0199], [30.3243, 78.0419]]);
  assert.deepEqual(trip.route_to_patient, [[30.3243, 78.0419], [30.3243, 78.0199], [30.3061, 78.0199]], 'the fake OSRM road route, [lat, lng]');
  assert.deepEqual(osrmRequests.slice(-2).sort(), ['/route/v1/driving/78.0419,30.3243;78.0199,30.3061?overview=full&geometries=geojson',
    '/route/v1/driving/78.0199,30.3061;78.0419,30.3243?overview=full&geometries=geojson'].sort());
  ctx.tripId = trip.trip_id;
  ctx.trip = trip;

  const detail = (await call('/api/v1/emergencies/REQ-DT-001', T.admin)).body;
  assert.deepEqual(detail.acceptances.map(a => [a.hospital_id, a.status]), [['H-101', 'ACCEPTED']], 'accepted through the normal path');
  assert.equal(detail.request.is_demo, 1);
  const unit = (await call('/api/v1/ambulances/AMB-01', T.admin)).body.ambulance;
  assert.deepEqual([unit.status, unit.assigned_request_id], ['DISPATCHED', 'REQ-DT-001']);

  const requestsBefore = await requestsAndTrips();
  for (let i = 0; i < 2; i += 1) {
    const again = await call('/api/v1/tracking/demo-setup', T.admin, 'POST', {});
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.outcome, again.body.trip.trip_id, again.body.trip.phase], ['existing', ctx.tripId, 'DISPATCHED']);
  }
  assert.deepEqual(await requestsAndTrips(), requestsBefore, 'nothing duplicated');
  assert.equal((await call('/api/v1/admin/users?role=PATIENT&limit=200', T.admin)).body.users.filter(u => u.username === 'patient_demo').length, 0);
  assert.deepEqual(requestsBefore, { sampleCases: 1, trips: 1, sampleAcceptances: 1 });
  const trail = (await call('/api/v1/emergencies/REQ-DT-001/audit', T.admin)).body.audit_trail.map(e => e.event_type);
  assert.deepEqual(trail.filter(e => e === 'TRIP_CREATED' || e === 'ALLOCATION_COMMITTED'), ['ALLOCATION_COMMITTED', 'TRIP_CREATED']);
  assert.equal((await call('/api/v1/audit/verify', T.admin)).body.verification.valid, true);
});

async function requestsAndTrips() {
  const trips = (await call('/api/v1/tracking/trips', T.admin)).body.trips;
  const cases = (await call('/api/v1/emergencies', T.admin)).body.queue.filter(r => r.request_id.startsWith('REQ-DT-'));
  const history = (await call('/api/v1/referrals/history', T.admin)).body.history.filter(a => a.request_id === 'REQ-DT-001');
  if (BACKEND === 'mysql') {
    const [[db]] = [await sql(`SELECT (SELECT COUNT(*) FROM EmergencyRequest WHERE request_id LIKE 'REQ-DT-%') AS cases,
      (SELECT COUNT(*) FROM AmbulanceTrip) AS trips, (SELECT COUNT(*) FROM Patient WHERE patient_id = 'PAT-DT-001') AS patients`)];
    assert.deepEqual([Number(db.cases), Number(db.trips), Number(db.patients)], [cases.length, trips.length, 1]);
  }
  return { sampleCases: cases.length, trips: trips.length, sampleAcceptances: history.length };
}

// ── Scope over REST ─────────────────────────────────────────────────────────
test(`scope: every role over REST, and the patient's own case vs another's [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  // A PATIENT account can no longer be created through the admin API (400); on MySQL one is inserted into the store.
  const refused = await call('/api/v1/admin/users', T.admin, 'POST', {
    username: 'tracking.patient', display_name: 'Demo Tracking Patient', role: 'PATIENT', patient_id: 'PAT-DT-001', password: PATIENT_PASSWORD
  });
  assert.equal(refused.status, 400, 'the PATIENT role is retired');
  if (BACKEND === 'mysql') {
    const hash = await (await import('bcryptjs')).default.hash(PATIENT_PASSWORD, 4);
    await sql(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo)
               VALUES ('USER-PAT-T12', 'tracking.patient', ?, 'PATIENT', 'PAT-DT-001', 'Fictional Patient', 1, 0)`, [hash]);
    T.patient = (await login('tracking.patient', PATIENT_PASSWORD)).body.token;
  }

  const id = ctx.tripId;
  const expected = { admin: [200, 1], dispatcher: [200, 1], apex: [200, 1], stjude: [404, 0], fortis: [404, 0], medic: [200, 1], otherMedic: [404, 0] };
  // `crew` (the unit's Fleet logins) is for ADMIN only.
  assert.deepEqual((await getTrip(id)).crew, ['UNIT-402']);
  assert.deepEqual((await call('/api/v1/tracking/trips', T.admin)).body.trips.map(x => x.crew), [['UNIT-402']]);
  for (const who of ['dispatcher', 'apex', 'medic'].filter(w => T[w])) {
    assert.ok(!('crew' in (await call(`/api/v1/tracking/trips/${id}`, T[who])).body.trip), `${who}: no crew`);
    assert.ok(!(await call('/api/v1/tracking/trips', T[who])).body.trips.some(x => 'crew' in x), `${who} list: no crew`);
  }
  for (const [who, [one, count]] of Object.entries(expected).filter(([w]) => T[w])) {
    assert.equal((await call(`/api/v1/tracking/trips/${id}`, T[who])).status, one, `${who} GET one`);
    assert.equal((await call('/api/v1/tracking/trips', T[who])).body.count, count, `${who} list`);
  }
  for (const who of ['patient', 'vance'].filter(w => T[w])) {
    assert.equal((await call(`/api/v1/tracking/trips/${id}`, T[who])).status, 403);
    assert.equal((await call('/api/v1/tracking/trips', T[who])).status, 403);
    assert.equal((await act(id, 'start', T[who])).status, 403);
  }
  assert.equal((await call('/api/v1/tracking/trips/TRIP-NOPE', T.admin)).status, 404);
  // Actions: desks never; another unit's paramedic: not found; the unit's paramedic: start / pickup / complete only.
  for (const action of ['start', 'pause', 'reset']) {
    assert.equal((await act(id, action, T.apex)).status, 403, `apex ${action}`);
    assert.equal((await act(id, action, T.stjude)).status, 403, `stjude ${action}`);
    assert.equal((await act(id, action, T.otherMedic)).status, 404, `UNIT-601 ${action}`);
  }
  for (const action of ['pause', 'resume', 'reset']) assert.equal((await act(id, action, T.medic)).status, 403, `UNIT-402 ${action}`);
  assert.equal((await act(id, 'fly', T.admin)).status, 404);
  assert.equal((await getTrip(id)).phase, 'DISPATCHED', 'nothing changed');

  assert.equal((await call('/api/v1/patient/cases/REQ-DT-001/tracking', T.admin)).status, 403, 'patients only');
  if (BACKEND !== 'mysql') return; // the dormant PATIENT portal: no such account exists in the in-memory store
  // The patient's redacted tracking: own case only; another patient's case and a missing one answer the same 404.
  const own = await call('/api/v1/patient/cases/REQ-DT-001/tracking', T.patient);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(Object.keys(own.body.tracking).sort(), PATIENT_KEYS);
  assert.deepEqual(own.body.tracking.hospital, { name: 'Clock Tower Trauma Centre (demo)', lat: 30.3243, lng: 78.0419 });
  assert.deepEqual([own.body.tracking.simulated, own.body.tracking.phase, own.body.tracking.route_source], [true, 'DISPATCHED', 'osrm']);
  const notOwn = await call('/api/v1/patient/cases/REQ-DT-001/tracking', T.vance);
  const missing = await call('/api/v1/patient/cases/REQ-0000/tracking', T.vance);
  assert.deepEqual([notOwn.status, notOwn.body], [404, missing.body]);
  assert.deepEqual(await call('/api/v1/patient/cases/REQ-8901/tracking', T.vance), { status: 200, body: { success: true, tracking: null } },
    'own case without a trip: 200 with tracking null');
});

// ── The whole trip, every transition, the persisted position, sockets ─────────
test(`trip lifecycle: every invalid transition is 409; the unit moves progressively and persistently, pauses, ends exactly at pickup and hospital; sockets reach exactly the allowed rooms [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const id = ctx.tripId;
  const sockets = {};
  for (const who of ['admin', 'dispatcher', 'apex', 'stjude', 'fortis', 'medic', 'otherMedic', 'patient', 'vance'].filter(w => T[w])) {
    sockets[who] = await connectSocket(BASE, T[who]);
    assert.ok(sockets[who].connected, who);
  }
  const drain = () => Promise.all(Object.values(sockets).map(s => s.waitFor(() => false, 20)));
  const refused = async (action, token = T.admin) => {
    const r = await act(id, action, token);
    assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /\w/);
  };
  for (const action of ['pickup', 'complete', 'pause', 'resume']) await refused(action);

  const startedAt = Date.now();
  const started = await act(id, 'start', T.medic); // the unit's own paramedic
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.trip.phase, 'EN_ROUTE_TO_PATIENT');
  await refused('start');
  await refused('pickup');

  // Leg 1, sampled: progress grows, never by more than the engine's two-tick cap, positions lie on the route.
  const leg = ctx.trip.route_to_patient;
  const cumulative = cumulativeMeters(leg);
  const length = cumulative.at(-1);
  const samples = [];
  let paused = false;
  for (let i = 0; i < 600; i += 1) {
    const trip = await persisted(id);
    samples.push(trip);
    if (trip.phase !== 'EN_ROUTE_TO_PATIENT') break;
    if (!paused && trip.progress > 0.3) {
      paused = true;
      assert.equal((await act(id, 'pause', T.dispatcher ?? T.admin)).status, 200);
      const held = await persisted(id);
      await sleep(5 * TICK_MS);
      await drain();
      const still = await persisted(id);
      assert.deepEqual([still.progress, still.current], [held.progress, held.current], 'paused: the unit stands still');
      assert.equal(still.paused, true);
      await refused('pause');
      assert.equal((await act(id, 'resume', T.dispatcher ?? T.admin)).status, 200);
      await refused('resume');
    }
    await drain();
    await sleep(TICK_MS / 2);
  }
  const moving = samples.filter(s => s.phase === 'EN_ROUTE_TO_PATIENT' && s.progress > 0 && s.progress < 1);
  assert.ok(moving.length >= 8, `seen moving ${moving.length} times: it drives, it does not jump`);
  for (let i = 1; i < samples.length; i += 1) {
    const [a, b] = [samples[i - 1], samples[i]];
    if (b.phase !== 'EN_ROUTE_TO_PATIENT') continue;
    assert.ok(b.progress >= a.progress, 'progress never goes back');
  }
  for (let i = 1; i < moving.length; i += 1) {
    const moved = (moving[i].progress - moving[i - 1].progress) * length;
    const ticks = Math.max(1, Math.ceil((moving[i].at - moving[i - 1].at) / TICK_MS) + 1);
    assert.ok(moved <= ticks * (MAX_STEP_M / 2) + 1, `moved ${moved.toFixed(1)} m in ${moving[i].at - moving[i - 1].at} ms`);
  }
  for (const s of moving) {
    const onRoute = pointAtMeters(leg, cumulative, s.progress * length);
    assert.ok(haversineMeters(onRoute, [s.current.lat, s.current.lng]) < 1, 'the position is on the route at its progress');
  }
  const atPickup = samples.at(-1);
  assert.equal(atPickup.phase, 'ARRIVED_AT_PATIENT');
  assert.deepEqual([atPickup.current, atPickup.progress, atPickup.unit], [{ lat: 30.3061, lng: 78.0199 }, 1, { lat: 30.3061, lng: 78.0199 }], 'exactly at the pickup point');
  for (const action of ['start', 'complete', 'pause', 'resume']) await refused(action);

  const pickedUp = await act(id, 'pickup', T.medic);
  assert.equal(pickedUp.status, 200);
  assert.deepEqual([pickedUp.body.trip.phase, pickedUp.body.trip.progress, pickedUp.body.trip.current], ['EN_ROUTE_TO_HOSPITAL', 0, { lat: 30.3061, lng: 78.0199 }]);
  assert.ok(pickedUp.body.trip.timestamps.picked_up_at && pickedUp.body.trip.timestamps.arrived_patient_at);
  await refused('pickup');
  let last = null;
  let leg2Moving = 0;
  for (let i = 0; i < 600; i += 1) {
    last = await persisted(id);
    if (last.phase !== 'EN_ROUTE_TO_HOSPITAL') break;
    if (last.progress > 0 && last.progress < 1) leg2Moving += 1;
    await drain();
    await sleep(TICK_MS / 2);
  }
  assert.ok(leg2Moving >= 5, `leg 2 seen moving ${leg2Moving} times`);
  assert.equal(last.phase, 'ARRIVED_AT_HOSPITAL');
  assert.deepEqual([last.current, last.unit, last.eta_seconds], [{ lat: 30.3243, lng: 78.0419 }, { lat: 30.3243, lng: 78.0419 }, 0], 'exactly at the hospital');
  await sleep(200);
  // Batch 8: arrival is a fact of the trip only; the case stays ALLOCATED until the hospital desk starts treatment.
  const afterArrival = (await call('/api/v1/emergencies/REQ-DT-001', T.admin)).body.request;
  assert.deepEqual([afterArrival.status, afterArrival.arrived_at, afterArrival.treatment_started_at], ['ALLOCATED', null, null], 'arrival does not advance the case');
  const arrivalRow = (await call('/api/v1/emergencies/REQ-DT-001/audit', T.admin)).body.audit_trail.findLast(e => e.event_type === 'TRIP_PHASE_CHANGED');
  assert.equal(arrivalRow.new_state, 'ARRIVED_AT_HOSPITAL');
  const arrivalMeta = typeof arrivalRow.metadata === 'string' ? JSON.parse(arrivalRow.metadata) : arrivalRow.metadata;
  assert.ok(!('case_to_in_treatment' in arrivalMeta) && !('case_status' in arrivalMeta), 'the arrival audit row says nothing about the case');
  for (const action of ['start', 'pickup', 'pause', 'resume']) await refused(action);

  const completed = await act(id, 'complete', T.medic);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.trip.completed, true);
  for (const action of ['start', 'pickup', 'complete', 'pause', 'resume']) await refused(action);
  const unit = (await call('/api/v1/ambulances/AMB-01', T.admin)).body.ambulance;
  // Batch 8: the unit stays with the case at the hospital until the receiving hospital confirms the handover.
  assert.deepEqual([unit.status, unit.assigned_request_id ?? null, unit.current_lat, unit.current_lng], ['IN_TRANSIT', 'REQ-DT-001', 30.3243, 78.0419]);
  // A paramedic reads only its unit's ACTIVE trips: the finished one (patient, pickup) is gone for UNIT-402, not for staff.
  assert.equal((await call(`/api/v1/tracking/trips/${id}`, T.medic)).status, 404);
  assert.equal((await call('/api/v1/tracking/trips', T.medic)).body.count, 0);
  assert.equal((await call(`/api/v1/tracking/trips/${id}`, T.apex)).status, 200);
  const seconds = (Date.now() - startedAt) / 1000;

  // Sockets: the command centre, the unit's paramedic and the destination desk; nobody else. Patients: redacted only.
  await sleep(300);
  await drain();
  const updates = who => sockets[who].events.filter(e => e.name === 'tracking:update' && e.payload.trip_id === id);
  for (const who of ['admin', 'dispatcher', 'apex', 'medic'].filter(w => T[w])) {
    const mine = updates(who);
    assert.ok(mine.length >= 20, `${who}: ${mine.length} updates`);
    assert.ok(mine.length <= Math.ceil((seconds * 1000) / TICK_MS) + 20, `${who}: at most one per tick (+ actions): ${mine.length}`);
    assert.deepEqual(Object.keys(mine[0].payload).sort(), UPDATE_KEYS);
    assert.deepEqual(new Set(mine.map(e => e.payload.phase)), new Set(['EN_ROUTE_TO_PATIENT', 'ARRIVED_AT_PATIENT', 'EN_ROUTE_TO_HOSPITAL', 'ARRIVED_AT_HOSPITAL']));
    assert.ok(!sockets[who].has('patient:tracking'), `${who} gets no patient payload`);
  }
  for (const who of ['stjude', 'fortis', 'otherMedic', 'patient', 'vance'].filter(w => T[w])) assert.equal(updates(who).length, 0, `${who} gets no tracking:update`);
  if (!T.patient) { ctx.updatesSeen = updates('admin').length; return; } // the dormant patient portal: MySQL only
  const forPatient = sockets.patient.events.filter(e => e.name === 'patient:tracking');
  assert.ok(forPatient.length >= 20, `patient: ${forPatient.length}`);
  for (const e of forPatient) {
    assert.deepEqual(Object.keys(e.payload).sort(), [...PATIENT_KEYS, 'request_id'].sort());
    assert.deepEqual([e.payload.request_id, e.payload.simulated], ['REQ-DT-001', true]);
    assert.deepEqual(Object.keys(e.payload.hospital).sort(), ['lat', 'lng', 'name']);
  }
  assert.equal(sockets.vance.events.filter(e => e.name === 'patient:tracking').length, 0, 'another patient gets nothing');
  ctx.updatesSeen = updates('admin').length;
});

/** The trip as stored, plus the unit's stored position read in the same snapshot (MySQL) or in a stable pair of reads. */
async function persisted(id) {
  for (;;) {
    const at = Date.now();
    if (BACKEND === 'mysql') {
      const [row] = await sql(`SELECT t.phase, t.progress, t.current_lat, t.current_lng, t.paused, t.eta_seconds, a.current_lat AS unit_lat, a.current_lng AS unit_lng
        FROM AmbulanceTrip t JOIN Ambulance a ON a.ambulance_id = t.ambulance_id WHERE t.trip_id = ?`, [id]);
      const api = await getTrip(id);
      if (api.progress !== Number(row.progress) || api.phase !== row.phase) continue; // a tick between the two reads
      return { ...api, at, unit: { lat: Number(row.unit_lat), lng: Number(row.unit_lng) } };
    }
    const before = await getTrip(id);
    const unit = (await call(`/api/v1/ambulances/${before.ambulance.ambulance_id}`, T.admin)).body.ambulance;
    const after = await getTrip(id);
    if (before.progress !== after.progress || before.phase !== after.phase) continue;
    return { ...before, at, unit: { lat: unit.current_lat, lng: unit.current_lng } };
  }
}

// ── Reset and set-up after completion ──────────────────────────────────────
test(`reset: demo-setup after completion resets the same trip to DISPATCHED and re-dispatches its unit; the command centre may reset; no duplicates [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const again = await call('/api/v1/tracking/demo-setup', T.admin, 'POST', {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const trip = again.body.trip;
  assert.deepEqual([again.body.outcome, trip.trip_id, trip.phase, trip.progress, trip.completed, trip.current],
    ['reset', ctx.tripId, 'DISPATCHED', 0, false, trip.start]);
  assert.deepEqual(Object.values(trip.timestamps).filter(Boolean).length, 2, 'only created_at and updated_at remain');
  assert.equal(trip.case.status, 'ALLOCATED', 'a trip never changes the case status (Batch 8)');
  const unit = (await call('/api/v1/ambulances/AMB-01', T.admin)).body.ambulance;
  assert.deepEqual([unit.status, unit.assigned_request_id], ['DISPATCHED', 'REQ-DT-001']);
  assert.equal((await call(`/api/v1/tracking/trips/${ctx.tripId}`, T.medic)).status, 200, 'active again: the unit\'s paramedic sees it');
  assert.equal((await act(ctx.tripId, 'start', T.dispatcher ?? T.admin)).status, 200);
  await sleep(4 * TICK_MS);
  const reset = await act(ctx.tripId, 'reset', T.dispatcher ?? T.admin);
  assert.equal(reset.status, 200);
  assert.deepEqual([reset.body.trip.phase, reset.body.trip.progress], ['DISPATCHED', 0]);
  assert.deepEqual(await requestsAndTrips(), { sampleCases: 1, trips: 1, sampleAcceptances: 1 });
  assert.equal((await call('/api/v1/audit/verify', T.admin)).body.verification.valid, true);

});

// ── MySQL: the optimistic version check of the store itself ─────────────────
test(`MySQL store: a write with a stale trip version is refused (409) and changes nothing [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  if (BACKEND !== 'mysql') { t.skip('the in-memory store has the same check (tests/tracking_units.test.js)'); return; }
  const { createPool } = await import('../server/db/pool.js');
  const { MySqlStore } = await import('../server/db/mysqlStore.js');
  const store = new MySqlStore({ pool: createPool({ ...database.config, connectionLimit: 2 }) });
  try {
    const trip = await store.getTrip(ctx.tripId);
    for (const stale of [trip.version - 1, trip.version + 1]) {
      await assert.rejects(store.updateTrip(ctx.tripId, stale, { paused: 1, progress: 0.5 }), err => err.status === 409 && err.code === 'TRIP_CONFLICT');
    }
    assert.deepEqual(await store.getTrip(ctx.tripId), trip, 'nothing was written');
    const { trip: written } = await store.updateTrip(ctx.tripId, trip.version, { paused: 1 });
    assert.deepEqual([written.paused, written.version], [1, trip.version + 1], 'the current version is accepted and raised');
    await store.updateTrip(ctx.tripId, written.version, { paused: 0 });
  } finally {
    await store.pool.end();
  }
});

// ── Routing fallback and input validation ───────────────────────────────────
async function acceptedCase(name, pickup) {
  const created = await call('/api/v1/emergencies', T.admin, 'POST', {
    patient_name: name, age: 40, emergency_type: 'GENERAL', triage_priority: 3, ...(pickup ? { pickup_lat: pickup[0], pickup_lng: pickup[1] } : {})
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const referral = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: created.body.request_id, hospital_id: 'H-103' });
  assert.equal(referral.status, 201, JSON.stringify(referral.body));
  const accepted = await call(`/api/v1/referrals/${referral.body.acceptance_id}/accept`, T.fortis, 'POST');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { requestId: created.body.request_id, unit: accepted.body.ambulance_id };
}

test(`routing fallback: a failing or slow routing service gives a simulated straight-line trip; demo-trips validates its input [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const body = (requestId, unit, extra = {}) => ({ request_id: requestId, ambulance_id: unit, start_lat: 30.3, start_lng: 78.0, speed_kmh: SPEED, ...extra });
  osrmMode = 'fail';
  const a = await acceptedCase('Fictional Fallback A', [30.307, 78.005]);
  assert.ok(a.unit, 'the accept dispatched a unit');
  for (const [extra, status] of [[{ start_lat: 91 }, 400], [{ start_lng: -181 }, 400], [{ speed_kmh: 5 }, 400], [{ speed_kmh: 201 }, 400], [{ start_lat: '28' }, 400]]) {
    assert.equal((await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(a.requestId, a.unit, extra))).status, status, JSON.stringify(extra));
  }
  assert.equal((await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body('REQ-0000', a.unit))).status, 404);
  assert.equal((await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(a.requestId, 'AMB-NOPE'))).status, 404);
  const busy = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(a.requestId, 'AMB-01'));
  assert.equal(busy.status, 409, 'AMB-01 has the active sample trip');
  const created = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(a.requestId, a.unit));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.trip.route_source, 'simulated');
  assert.deepEqual([created.body.trip.route_to_patient[0], created.body.trip.route_to_patient.at(-1)], [[30.3, 78.0], [30.307, 78.005]]);
  assert.ok(created.body.trip.route_to_patient.length > 2, 'a straight line with intermediate points');
  assert.equal((await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(a.requestId, a.unit))).status, 409, 'one active trip per case');
  ctx.fallbackTripId = created.body.trip.trip_id;

  osrmMode = 'slow';
  const b = await acceptedCase('Fictional Fallback B', [30.306, 78.004]);
  const startedAt = Date.now();
  const slow = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(b.requestId, b.unit));
  assert.equal(slow.status, 201, JSON.stringify(slow.body));
  assert.equal(slow.body.trip.route_source, 'simulated');
  assert.ok(Date.now() - startedAt < 1800, 'the routing timeout (300 ms) applies');
  osrmMode = 'ok';

  const noPickup = await acceptedCase('Fictional No Pickup', null);
  // Every free unit is taken by now (the accept dispatched none): the missing pickup point is refused first anyway.
  const refused = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(noPickup.requestId, noPickup.unit ?? 'AMB-05'));
  assert.deepEqual([refused.status, /no pickup coordinates/.test(refused.body.error)], [409, true]);
  const waiting = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Waiting', age: 30, emergency_type: 'GENERAL', pickup_lat: 30.3, pickup_lng: 78.0 });
  const notAccepted = await call('/api/v1/tracking/demo-trips', T.admin, 'POST', body(waiting.body.request_id, 'AMB-05'));
  assert.equal(notAccepted.status, 409);
  assert.match(notAccepted.body.error, /WAITING/);
});

// ── Restart (MySQL: the position is persisted) ──────────────────────────────
test(`restart: a moving trip resumes from its persisted position, with no jump [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  if (BACKEND !== 'mysql') { t.skip('the in-memory store does not persist across a restart (engine-level resume: tests/tracking_units.test.js)'); return; }
  const id = ctx.fallbackTripId;
  assert.equal((await act(id, 'start')).status, 200);
  await sleep(6 * TICK_MS);
  await stopServer();
  const [stored] = await sql('SELECT phase, progress, current_lat, current_lng FROM AmbulanceTrip WHERE trip_id = ?', [id]);
  assert.equal(stored.phase, 'EN_ROUTE_TO_PATIENT');
  assert.ok(Number(stored.progress) > 0 && Number(stored.progress) < 1, `stopped mid-leg (${stored.progress})`);
  await sleep(1000); // time passes while the server is down: it must not be "caught up" in one jump
  await startServer();
  T.admin = (await login('admin', 'admin123')).body.token;
  const first = await getTrip(id);
  const length = cumulativeMeters(first.route_to_patient).at(-1);
  assert.ok(first.progress >= Number(stored.progress), 'not reset by the restart');
  assert.ok((first.progress - Number(stored.progress)) * length <= MAX_STEP_M + 1, 'no catch-up jump after the restart');
  await sleep(5 * TICK_MS);
  const later = await getTrip(id);
  assert.ok(later.progress > first.progress || later.phase !== 'EN_ROUTE_TO_PATIENT', 'it keeps moving after the restart');
  const ticksInLog = (serverLog.match(/\[TRACKING\] Simulated trips every/g) ?? []).length;
  assert.equal(ticksInLog, 1, 'one engine per process');
});

// ── Batch 8: a demo-crewed unit on a REAL case is never taken over ───────────
test(`demo-setup refuses (409, with the reason) when every demo-crewed unit is on a real case, and takes no uncrewed unit [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  // Free AMB-01 from the sample (the case is completed through the normal path), then put it on a REAL case at H-101.
  const closed = await call('/api/v1/emergencies/REQ-DT-001/status', T.admin, 'PATCH', { status: 'COMPLETED' }); // still ALLOCATED after the trip
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.closed_trip_ids, [ctx.tripId], 'the reset (active) sample trip is closed with its case, so AMB-01 is not held by it');
  const unit04 = (await call('/api/v1/ambulances/AMB-04', T.admin)).body.ambulance;
  if (unit04.status === 'AVAILABLE') {
    assert.equal((await call('/api/v1/ambulances/AMB-04/status', T.admin, 'PATCH', { status: 'MAINTENANCE' })).status, 200);
  }
  const real = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: 'Fictional Real Case', age: 50, emergency_type: 'GENERAL', pickup_lat: 30.32, pickup_lng: 78.01 });
  const lock = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: real.body.request_id, hospital_id: 'H-101' });
  const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, T.apex, 'POST');
  assert.deepEqual([accepted.status, accepted.body.ambulance_id], [200, 'AMB-01'], 'AMB-01 now serves a real case');
  const freeBefore = (await call('/api/v1/ambulances?status=AVAILABLE', T.admin)).body.ambulances.map(u => u.ambulance_id);

  const refused = await call('/api/v1/tracking/demo-setup', T.admin, 'POST', {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, new RegExp(`AMB-01 is serving the real case ${real.body.request_id}`));
  assert.match(refused.body.error, /never taken over/);
  const unit01 = (await call('/api/v1/ambulances/AMB-01', T.admin)).body.ambulance;
  assert.deepEqual([unit01.status, unit01.assigned_request_id], ['DISPATCHED', real.body.request_id], 'the real case keeps its unit');
  assert.deepEqual((await call('/api/v1/ambulances?status=AVAILABLE', T.admin)).body.ambulances.map(u => u.ambulance_id), freeBefore,
    'no uncrewed unit was taken instead');
  assert.equal((await call('/api/v1/tracking/trips', T.admin)).body.trips.filter(x => !x.completed && x.ambulance.ambulance_id !== 'AMB-01' && x.request_id.startsWith('REQ-DT-')).length, 0);
});
