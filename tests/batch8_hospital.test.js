// Batch 8 (P0): the receiving hospital's treatment workflow end to end against a real `node server/server.js`:
// confirm arrival -> allocate bed -> start treatment -> progress notes -> complete treatment, with the access matrix
// (the holding desk only; another hospital 404; ADMIN views but is refused every step; Fleet refused), the order rules
// (409), idempotent repeats (no double release), the unique bed label (also under concurrent allocation), resources
// and specialists released exactly once, the audit chain, the hospital patients list and the admin overview, and the
// case:status socket scoping (command centre + holding hospital + serving unit; never another hospital or unit).
// Also: a tracking trip's arrival never changes the case status, and a closed case closes its active trip.
// Runs on the in-memory store; tests/batch8_hospital_mysql.test.js runs the same scenario on the MySQL test database.
// All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connectSocket } from './helpers/rawSocket.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4281 : 4280;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'batch8-hospital-test-secret-0123456789ab';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASE_STATUS_KEYS = ['at', 'hospital_id', 'incident_id', 'milestone', 'previous_status', 'request_id', 'status'].sort();
const PATIENT_KEYS = ['accepted_at', 'age', 'ambulance_id', 'arrived_at', 'bed_allocated_at', 'bed_label', 'emergency_type', 'gender', 'incident_id',
  'patient_name', 'request_id', 'status', 'treatment_completed_at', 'treatment_started_at', 'triage_category', 'triage_priority', 'trip_phase',
  'updated_at'].sort();

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
const login = async (username, password) => call('/api/v1/auth/login', null, 'POST', { username, password });
const skipped = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };
const step = (id, name, token, body) => call(`/api/v1/emergencies/${id}/${name}`, token, 'POST', body);
const icu = async () => (await call('/api/v1/hospitals/H-101', T.admin)).body.hospital.resources;

/** A new case accepted by H-101 through the normal referral path. */
async function acceptedCase(name, type = 'GENERAL') {
  const created = await call('/api/v1/emergencies', T.admin, 'POST', { patient_name: name, age: 44, emergency_type: type, triage_priority: 2, pickup_lat: 30.31, pickup_lng: 78.03 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lock = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: created.body.request_id, hospital_id: 'H-101' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, T.apex, 'POST');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: created.body.request_id, unit: accepted.body.ambulance_id ?? null };
}

test.before(async () => {
  let env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_SECRET: SECRET, SOCKET_RECHECK_MS: '1000', API_RATE_LIMIT: '100000', SIMULATED_TRANSPORT: 'off', ROUTING_URL: 'off'
  };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  delete env.NODE_ENV;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true);
    env = mysqlServerEnv(PORT, { JWT_SECRET: SECRET, SOCKET_RECHECK_MS: '1000', API_RATE_LIMIT: '100000', JWT_EXPIRES: '', TRUST_PROXY: '', ROUTING_URL: 'off' });
  }
  server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  const accounts = { admin: ['admin', 'admin123'], apex: ['apex_desk', 'hospital123'], stjude: ['stjude_desk', 'hospital123'],
    medic: ['UNIT-402', 'paramedic123'], otherMedic: ['UNIT-601', 'paramedic123'] };
  for (const [key, [username, password]] of Object.entries(accounts)) {
    const result = await login(username, password);
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
    T[`${key}User`] = result.body.user;
  }
});

test.after(async () => {
  for (const socket of Object.values(ctx.sockets ?? {})) socket.events.length = 0;
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  if (database && !database.skip) {
    try { await database.reset(true); } finally { await database.release(); }
  }
});

test(`treatment workflow: arrival -> bed -> start -> notes -> complete, in order, by the holding desk only; idempotent; released once [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  ctx.sockets = {};
  for (const who of ['admin', 'apex', 'stjude', 'medic', 'otherMedic']) {
    ctx.sockets[who] = await connectSocket(BASE, T[who]);
    assert.ok(ctx.sockets[who].connected, who);
  }
  const before = await icu();
  const a = await acceptedCase('Fictional Workflow Patient', 'CARDIAC'); // holds an ICU_BED and a VENTILATOR at H-101
  ctx.a = a;
  const held = await icu();
  assert.deepEqual([held.icubed.available, held.ventilator.available], [before.icubed.available - 1, before.ventilator.available - 1]);

  // Who may act: the holding desk only. Another hospital 404, ADMIN 403 (view only), Fleet 403; PATCH stays admin-only.
  for (const name of ['arrive', 'allocate-bed', 'start-treatment', 'notes', 'complete']) {
    const body = name === 'allocate-bed' ? { bed_label: 'ICU-3' } : name === 'notes' ? { note: 'x' } : undefined;
    assert.equal((await step(a.id, name, T.stjude, body)).status, 404, `${name}: another hospital`);
    assert.equal((await step(a.id, name, T.admin, body)).status, 403, `${name}: ADMIN`);
    assert.equal((await step(a.id, name, T.medic, body)).status, 403, `${name}: Fleet`);
  }
  assert.equal((await call(`/api/v1/emergencies/${a.id}/status`, T.apex, 'PATCH', { status: 'IN_TREATMENT' })).status, 403, 'desks use the steps, not PATCH');
  assert.equal((await step('REQ-0000', 'arrive', T.apex)).status, 404);

  // Order: nothing before arrival.
  assert.equal((await step(a.id, 'start-treatment', T.apex)).status, 409, 'start before arrival');
  assert.equal((await step(a.id, 'allocate-bed', T.apex, { bed_label: 'ICU-3' })).status, 409, 'bed before arrival');
  assert.equal((await step(a.id, 'notes', T.apex, { note: 'too early' })).status, 409, 'note before treatment');
  assert.equal((await step(a.id, 'complete', T.apex)).status, 409, 'complete before start');

  const arrived = await step(a.id, 'arrive', T.apex);
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.equal(arrived.body.unchanged, false);
  assert.ok(arrived.body.milestones.arrived_at);
  assert.equal((await call(`/api/v1/emergencies/${a.id}`, T.admin)).body.request.status, 'ALLOCATED', 'arrival does not change the status');
  const again = await step(a.id, 'arrive', T.apex);
  assert.deepEqual([again.status, again.body.unchanged, again.body.milestones.arrived_at], [200, true, arrived.body.milestones.arrived_at], 'a repeat is a no-op');
  assert.equal((await step(a.id, 'start-treatment', T.apex)).status, 409, 'start before a bed');

  for (const bad of [{}, { bed_label: '' }, { bed_label: 'x'.repeat(31) }, { bed_label: 'ICU<3>' }, { bed_label: 3 }]) {
    assert.equal((await step(a.id, 'allocate-bed', T.apex, bad)).status, 400, JSON.stringify(bad));
  }
  const bed = await step(a.id, 'allocate-bed', T.apex, { bed_label: 'ICU-3' });
  assert.equal(bed.status, 200, JSON.stringify(bed.body));
  assert.deepEqual([bed.body.milestones.bed_label, bed.body.bed_resource, bed.body.unchanged], ['ICU-3', 'ICU_BED', false], 'the ICU bed the case holds');
  assert.equal((await step(a.id, 'allocate-bed', T.apex, { bed_label: 'icu-3' })).body.unchanged, true, 'the same bed again: no-op');
  const other = await step(a.id, 'allocate-bed', T.apex, { bed_label: 'ICU-4' });
  assert.equal(other.status, 409, 'a second, different bed is refused');
  assert.deepEqual((await icu()).icubed, held.icubed, 'allocating the held bed consumes no further capacity');

  const started = await step(a.id, 'start-treatment', T.apex);
  assert.deepEqual([started.status, started.body.status, started.body.previous_status, started.body.unchanged], [200, 'IN_TREATMENT', 'ALLOCATED', false]);
  assert.ok(started.body.milestones.treatment_started_at);
  const startedAgain = await step(a.id, 'start-treatment', T.apex);
  assert.deepEqual([startedAgain.status, startedAgain.body.unchanged, startedAgain.body.milestones.treatment_started_at],
    [200, true, started.body.milestones.treatment_started_at]);

  for (const bad of [{}, { note: '' }, { note: 'x'.repeat(501) }]) assert.equal((await step(a.id, 'notes', T.apex, bad)).status, 400);
  const note1 = await step(a.id, 'notes', T.apex, { note: 'Fictional: stable, monitoring.' });
  assert.equal(note1.status, 201, JSON.stringify(note1.body));
  assert.deepEqual([note1.body.note.note, note1.body.note.hospital_id, note1.body.note.author_id], ['Fictional: stable, monitoring.', 'H-101', T.apexUser.user_id]);
  await step(a.id, 'notes', T.apex, { note: 'Fictional: improving.' });
  const notes = await call(`/api/v1/emergencies/${a.id}/notes`, T.admin);
  assert.deepEqual([notes.status, notes.body.notes.map(n => n.note)], [200, ['Fictional: stable, monitoring.', 'Fictional: improving.']], 'ADMIN reads the notes');
  assert.equal((await call(`/api/v1/emergencies/${a.id}/notes`, T.apex)).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${a.id}/notes`, T.stjude)).status, 404, 'another hospital');
  assert.equal((await call(`/api/v1/emergencies/${a.id}/notes`, T.medic)).status, 404, 'Fleet');

  // Complete: releases what the case holds exactly once; a duplicate click releases nothing more.
  const completed = await step(a.id, 'complete', T.apex);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.deepEqual([completed.body.status, completed.body.previous_status, completed.body.unchanged, completed.body.released_allocations],
    ['COMPLETED', 'IN_TREATMENT', false, 2]);
  assert.deepEqual(completed.body.released_specialists, [], 'a cardiologist is not an exclusive (reserved) specialist');
  assert.ok(completed.body.milestones.treatment_completed_at);
  assert.deepEqual([(await icu()).icubed.available, (await icu()).ventilator.available], [before.icubed.available, before.ventilator.available], 'released');
  const dup = await step(a.id, 'complete', T.apex);
  assert.deepEqual([dup.status, dup.body.unchanged, dup.body.released_allocations], [200, true, 0]);
  assert.deepEqual([(await icu()).icubed.available, (await icu()).ventilator.available], [before.icubed.available, before.ventilator.available], 'never released twice');
  assert.equal((await step(a.id, 'notes', T.apex, { note: 'late' })).status, 409, 'no note after completion');
  if (a.unit) {
    const unit = (await call(`/api/v1/ambulances/${a.unit}`, T.admin)).body.ambulance;
    assert.equal(unit.assigned_request_id ?? null, null, 'the ambulance link is released');
  }

  const detail = (await call(`/api/v1/emergencies/${a.id}`, T.admin)).body;
  assert.ok(detail.allocations.every(x => x.status === 'RELEASED'));
  const trail = (await call(`/api/v1/emergencies/${a.id}/audit`, T.admin)).body.audit_trail.map(e => e.event_type);
  for (const event of ['PATIENT_ARRIVED', 'BED_ALLOCATED', 'TREATMENT_STARTED', 'TREATMENT_COMPLETED', 'RESOURCE_RELEASED']) {
    assert.equal(trail.filter(e => e === event).length, 1, `${event} exactly once`);
  }
  assert.equal(trail.filter(e => e === 'TREATMENT_NOTE').length, 2);
  assert.equal(trail.filter(e => e === 'STATUS_CHANGED').length, 2, 'IN_TREATMENT and COMPLETED, once each');
  assert.equal((await call('/api/v1/audit/verify', T.admin)).body.verification.valid, true);
});

test(`beds: a label is unique among the hospital's open cases (also under concurrent allocation) and free again after completion [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const b = await acceptedCase('Fictional Bed Patient B');
  const c = await acceptedCase('Fictional Bed Patient C');
  ctx.b = b;
  for (const x of [b, c]) assert.equal((await step(x.id, 'arrive', T.apex)).status, 200);
  // ICU-3 belonged to the completed case A: free again (case-insensitive label).
  const reused = await step(b.id, 'allocate-bed', T.apex, { bed_label: 'icu-3' });
  assert.deepEqual([reused.status, reused.body.bed_resource], [200, null], 'a GENERAL case holds no ICU bed: a ward bed, not a capacity unit');
  const taken = await step(c.id, 'allocate-bed', T.apex, { bed_label: 'ICU-3' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already allocated/);

  // Two desks allocate the same free bed to two cases at the same moment: exactly one wins.
  const d = await acceptedCase('Fictional Bed Patient D');
  assert.equal((await step(d.id, 'arrive', T.apex)).status, 200);
  const results = await Promise.all([c, d].map(x => step(x.id, 'allocate-bed', T.apex, { bed_label: 'Ward B-7' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], JSON.stringify(results.map(r => r.body)));
  const holders = [];
  for (const x of [c, d]) holders.push((await call(`/api/v1/emergencies/${x.id}`, T.admin)).body.request.bed_label);
  assert.deepEqual(holders.filter(label => label === 'Ward B-7').length, 1, 'one case holds the bed');
  ctx.loser = [c, d][results.findIndex(r => r.status === 409)];
  assert.equal((await call('/api/v1/audit/verify', T.admin)).body.verification.valid, true);
});

test(`patients list and overview: the holding desk and ADMIN only; milestones, counts [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const list = await call('/api/v1/hospitals/H-101/patients', T.apex);
  assert.equal(list.status, 200);
  assert.equal(list.body.count, list.body.patients.length);
  for (const p of list.body.patients) assert.deepEqual(Object.keys(p).sort(), PATIENT_KEYS);
  const a = list.body.patients.find(p => p.request_id === ctx.a.id);
  assert.equal(a.status, 'COMPLETED', 'completed within 24 h stays on the board');
  assert.deepEqual([a.bed_label, Boolean(a.arrived_at && a.treatment_started_at && a.treatment_completed_at)], ['ICU-3', true]);
  const b = list.body.patients.find(p => p.request_id === ctx.b.id);
  assert.deepEqual([b.status, b.bed_label, Boolean(b.arrived_at), b.treatment_started_at], ['ALLOCATED', 'icu-3', true, null]);
  assert.ok(list.body.patients.findIndex(p => p.status === 'COMPLETED') > list.body.patients.findIndex(p => p.status === 'ALLOCATED'), 'open cases first');
  assert.equal((await call('/api/v1/hospitals/H-101/patients', T.admin)).status, 200);
  assert.equal((await call('/api/v1/hospitals/H-101/patients', T.stjude)).status, 403, 'another hospital');
  assert.equal((await call('/api/v1/hospitals/H-101/patients', T.medic)).status, 403, 'Fleet');
  assert.equal((await call('/api/v1/hospitals/H-NOPE/patients', T.admin)).status, 404);
  const own = (await call('/api/v1/hospitals/H-102/patients', T.stjude)).body.patients;
  assert.ok(!own.some(p => [ctx.a.id, ctx.b.id].includes(p.request_id)), 'a desk sees only its own patients');

  assert.equal((await call('/api/v1/hospitals/overview', T.apex)).status, 403);
  assert.equal((await call('/api/v1/hospitals/overview', T.medic)).status, 403);
  const overview = await call('/api/v1/hospitals/overview', T.admin);
  assert.equal(overview.status, 200);
  const h101 = overview.body.hospitals.find(h => h.hospital_id === 'H-101');
  assert.deepEqual(Object.keys(h101).sort(), ['active_cases', 'completed_24h', 'doctors', 'emergency_status', 'hospital_id', 'hospital_name', 'referrals_24h', 'resources']);
  assert.deepEqual(Object.keys(h101.resources.ICU_BED).sort(), ['available', 'occupied', 'reserved', 'total']);
  assert.deepEqual(Object.keys(h101.referrals_24h).sort(), ['accepted', 'cancelled', 'expired', 'pending', 'rejected']);
  assert.ok(h101.referrals_24h.accepted >= 4, 'the four referrals accepted here');
  assert.ok(h101.completed_24h >= 1);
  assert.ok(h101.active_cases.arrived >= 3, 'B, C and D arrived, not in treatment');
  const board = list.body.patients;
  assert.equal(h101.active_cases.in_treatment, board.filter(p => p.status === 'IN_TREATMENT').length);
  assert.equal(h101.doctors.CARDIOLOGIST.total, 1);
});

test(`case:status reaches the command centre, the holding hospital and the serving unit only [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  await sleep(300);
  await Promise.all(Object.values(ctx.sockets).map(s => s.waitFor(() => false, 200)));
  const events = (who, id) => ctx.sockets[who].events.filter(e => e.name === 'case:status' && e.payload.request_id === id).map(e => e.payload);
  const adminA = events('admin', ctx.a.id);
  assert.deepEqual(adminA.map(e => e.milestone), ['ACCEPTED', 'ARRIVED', 'BED_ALLOCATED', 'TREATMENT_STARTED', 'TREATMENT_NOTE', 'TREATMENT_NOTE', 'COMPLETED'],
    'one event per change, in order (a repeated click sends nothing)');
  for (const e of adminA) {
    assert.deepEqual(Object.keys(e).sort(), CASE_STATUS_KEYS);
    assert.deepEqual([e.hospital_id, e.incident_id], ['H-101', null]);
  }
  assert.deepEqual(adminA.find(e => e.milestone === 'TREATMENT_STARTED'), { ...adminA.find(e => e.milestone === 'TREATMENT_STARTED'), status: 'IN_TREATMENT', previous_status: 'ALLOCATED' });
  assert.deepEqual(adminA.find(e => e.milestone === 'ARRIVED'), { ...adminA.find(e => e.milestone === 'ARRIVED'), status: 'ALLOCATED', previous_status: 'ALLOCATED' });
  assert.deepEqual(events('apex', ctx.a.id).map(e => e.milestone), adminA.map(e => e.milestone), 'the holding hospital gets every change');
  for (const id of [ctx.a.id, ctx.b.id]) assert.equal(events('stjude', id).length, 0, 'never another hospital');
  assert.equal(events('otherMedic', ctx.a.id).length, 0, 'never another unit');
  if (ctx.a.unit === 'AMB-01') assert.ok(events('medic', ctx.a.id).some(e => e.milestone === 'ACCEPTED'), 'the dispatched unit hears its case');
  assert.ok(ctx.sockets.admin.events.some(e => e.name === 'allocation:committed' && e.payload.requestId === ctx.a.id), 'ADMIN sees the accept live');
  // Admin closing a case (PATCH) also announces it.
  assert.equal((await call(`/api/v1/emergencies/${ctx.loser.id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  assert.ok(await ctx.sockets.apex.waitFor(s => s.events.some(e => e.name === 'case:status' && e.payload.request_id === ctx.loser.id && e.payload.milestone === 'CANCELLED'), 3000));
  assert.ok(!ctx.sockets.stjude.events.some(e => e.name === 'case:status' && e.payload.request_id === ctx.loser.id));
});

test(`hospital resources: a desk updates only its own, and the live /hospitals list follows at once [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const own = await call('/api/v1/hospitals/H-101/resources/OT', T.apex, 'PATCH', { available_capacity: 1 });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const listed = (await call('/api/v1/hospitals', T.admin)).body.hospitals.find(h => h.hospital_id === 'H-101');
  assert.equal(listed.resources.ot.available, 1, 'the recommendation data (GET /hospitals) is read live');
  assert.equal((await call('/api/v1/hospitals/H-102/resources/OT', T.apex, 'PATCH', { available_capacity: 1 })).status, 403, 'not another hospital');
});
