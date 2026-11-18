// Batch 6 (portals): the cross-role access matrix over REST AND Socket.IO against a real `node server/server.js` —
// ADMIN, DISPATCHER, HOSPITAL_DESK (own vs other hospital), PARAMEDIC (own vs other case) and PATIENT (own vs another
// patient's case; every non-patient endpoint 403), the redacted patient view and patient:case_update isolation, and the
// admin account API (denial for every non-admin role, validation, self-demotion, last-admin protection, immediate
// effect of deactivation and role changes, password reset, audit rows).
// Runs on the in-memory store; tests/portal_access_mysql.test.js runs the IDENTICAL scenario on the MySQL test database.
// All patient data is fictional.
//
// Batch 8 (simplified product): only ADMIN, HOSPITAL_DESK and PARAMEDIC accounts can be created; the DISPATCHER and
// PATIENT roles are DORMANT (their policy code stays, no account can be given them). The tests of that dormant policy run
// on MySQL with accounts inserted directly into the store; the in-memory store cannot hold such accounts any more, so
// there they are skipped. Every assertion on the three remaining roles runs on both stores.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connectSocket } from './helpers/rawSocket.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4257 : 4256;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'portal-access-test-secret-0123456789abcd';
const NEW_PASSWORD = 'Fictional-Portal-Pass-77'; // a test value for fictional accounts created here
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const VIEW_KEYS = ['request_id', 'status', 'emergency_type', 'triage_priority', 'requested_at', 'updated_at', 'hospital', 'ambulance', 'timeline'];
const UPDATE_KEYS = ['request_id', 'status', 'hospital_name', 'ambulance_status', 'eta_mins', 'at'];
const REVOKED = 'Your session was ended by an account change. Please sign in again.';

let server = null;
let database = null;
let skipReason = null;
const T = {};
const U = {};

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
const DORMANT = 'dormant role (DISPATCHER / PATIENT): no such account can exist in the in-memory store; tested on MySQL';
const dormantSkipped = t => { if (skipped(t)) return true; if (BACKEND !== 'mysql') { t.skip(DORMANT); return true; } return false; };
const DORMANT_PASSWORD = 'Fictional-Dormant-Pass-55';
async function createCase(token, name, type, extra = {}) {
  const created = await call('/api/v1/emergencies', token, 'POST', { patient_name: name, age: 41, emergency_type: type, triage_priority: 2, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}
/** A dormant-role account (PATIENT / DISPATCHER), inserted straight into the MySQL store: the admin API refuses those roles. */
async function insertDormant(username, role, patientId = null) {
  const hash = await (await import('bcryptjs')).default.hash(NEW_PASSWORD, 4);
  await database.admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)`, [`USER-T-${username.slice(0, 20)}`, username, hash, role, patientId, username]);
}
async function createAccount(body) {
  const created = await call('/api/v1/admin/users', T.admin, 'POST', { password: NEW_PASSWORD, ...body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.user;
}

test.before(async () => {
  let env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_SECRET: SECRET, SOCKET_RECHECK_MS: '1000', API_RATE_LIMIT: '5000', SIMULATED_TRANSPORT: 'off'
  };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true);
    // ENABLE_RETIRED_ROLES=1 (test-only): the dormant DISPATCHER / PATIENT policy is still exercised here.
    env = mysqlServerEnv(PORT, { JWT_SECRET: SECRET, SOCKET_RECHECK_MS: '1000', API_RATE_LIMIT: '5000', JWT_EXPIRES: '', TRUST_PROXY: '', ENABLE_RETIRED_ROLES: '1' });
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
  const accounts = {
    admin: ['admin', 'admin123'], desk101: ['apex_desk', 'hospital123'],
    desk102: ['stjude_desk', 'hospital123'], desk103: ['fortis_desk', 'hospital123'], medicA: ['UNIT-402', 'paramedic123'],
    medicB: ['UNIT-601', 'paramedic123']
  };
  if (BACKEND === 'mysql') {
    // The dormant roles, inserted straight into the store (the admin API and user:create refuse them).
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(DORMANT_PASSWORD, 4);
    await database.admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo) VALUES
      ('USER-DSP-T01', 'fictional.dispatch', ?, 'DISPATCHER', NULL, 'Fictional Operator', 1, 0),
      ('USER-PAT-T01', 'fictional.vance', ?, 'PATIENT', 'PAT-001', 'Fictional Vance', 1, 0),
      ('USER-PAT-T02', 'fictional.jenkins', ?, 'PATIENT', 'PAT-002', 'Fictional Jenkins', 1, 0)`, [hash, hash, hash]);
    Object.assign(accounts, { dispatcher: ['fictional.dispatch', DORMANT_PASSWORD], patV: ['fictional.vance', DORMANT_PASSWORD], patJ: ['fictional.jenkins', DORMANT_PASSWORD] });
  }
  for (const [key, [username, password]] of Object.entries(accounts)) {
    const result = await login(username, password);
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
    U[key] = result.body.user;
  }
});

test.after(async () => {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  await database?.release?.();
});

// ── PATIENT: own data only ───────────────────────────────────────────────────
test(`patient: own profile and cases only, the same 404 for another patient's case and a missing one, 403 everywhere else [${BACKEND}]`, async t => {
  if (dormantSkipped(t)) return;
  assert.deepEqual([U.patV.role, U.patV.patient_id], ['PATIENT', 'PAT-001']);
  assert.equal((await call('/api/v1/auth/me', T.patV)).body.user.patient_id, 'PAT-001');
  const me = await call('/api/v1/patient/me', T.patV);
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.body.patient).sort(), ['age', 'contact_phone', 'full_name', 'gender', 'patient_id']);
  assert.deepEqual([me.body.patient.patient_id, me.body.patient.full_name, me.body.patient.age], ['PAT-001', 'Robert Vance', 58]);

  const cases = await call('/api/v1/patient/cases', T.patV);
  assert.deepEqual(cases.body.cases.map(c => c.request_id), ['REQ-8901']);
  const own = await call('/api/v1/patient/cases/REQ-8901', T.patV);
  assert.equal(own.status, 200);
  assert.deepEqual(Object.keys(own.body.case).sort(), [...VIEW_KEYS].sort());
  // The demo seed is consistent (server/db/demoLifecycle.js): REQ-8901 is ALLOCATED because H-103 accepted it, and its
  // unit is on the way; the timeline comes from real, chained audit rows.
  assert.deepEqual([own.body.case.status, own.body.case.hospital.hospital_id, own.body.case.ambulance.ambulance_id, own.body.case.ambulance.status],
    ['ALLOCATED', 'H-103', 'AMB-02', 'IN_TRANSIT']);
  assert.deepEqual(own.body.case.timeline.map(e => e.event), ['CASE_REGISTERED', 'HOSPITAL_ACCEPTED', 'AMBULANCE_EN_ROUTE']);
  const jenkins = (await call('/api/v1/patient/cases/REQ-8902', T.patJ)).body.case;
  assert.deepEqual([jenkins.status, jenkins.hospital.hospital_id, jenkins.ambulance], ['IN_TREATMENT', 'H-105', null]);
  assert.deepEqual(jenkins.timeline.map(e => e.event), ['CASE_REGISTERED', 'HOSPITAL_ACCEPTED', 'CASE_IN_TREATMENT']);
  const seeded = (await call('/api/v1/emergencies/REQ-8901', T.admin)).body;
  assert.deepEqual(seeded.acceptances.map(a => [a.hospital_id, a.status]), [['H-103', 'ACCEPTED']]);
  assert.deepEqual(seeded.allocations.map(a => a.status), ['COMMITTED', 'COMMITTED']);
  const surgeon = (await call('/api/v1/doctors/DR-013', T.admin)).body.doctor;
  assert.equal(surgeon.availability_status, 'IN_PROCEDURE', 'REQ-8902\'s assigned trauma surgeon is in the procedure');
  assert.ok(Date.parse(own.body.case.updated_at) > 0 && Date.parse(jenkins.updated_at) > 0, 'seeded cases carry updated_at');
  // The demo referrals do not feed the live response-time KPI (demo cases are excluded, as in the history).
  assert.equal((await call('/api/v1/analytics/dashboard', T.admin)).body.dashboard.kpis.avg_referral_response_sec, 0);
  const verify = (await call('/api/v1/audit/verify', T.admin)).body.verification;
  assert.equal(verify.valid, true, JSON.stringify(verify.first_break));
  assert.ok(verify.checked >= 9, 'the seeded history is chained');
  const other = await call('/api/v1/patient/cases/REQ-8902', T.patV); // patient_jenkins's case
  const missing = await call('/api/v1/patient/cases/REQ-0000', T.patV);
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, missing.body, 'not yours and missing are indistinguishable');
  assert.deepEqual((await call('/api/v1/patient/cases', T.patJ)).body.cases.map(c => c.request_id), ['REQ-8902']);

  const denied = [
    ['GET', '/api/v1/emergencies'], ['GET', '/api/v1/emergencies/REQ-8901'], ['GET', '/api/v1/emergencies/REQ-8901/audit'],
    ['POST', '/api/v1/emergencies', { patient_name: 'Fictional X', age: 30, emergency_type: 'GENERAL' }],
    ['GET', '/api/v1/hospitals'], ['GET', '/api/v1/hospitals/H-101'], ['GET', '/api/v1/ambulances'], ['GET', '/api/v1/ambulances/stats/summary'],
    ['PATCH', '/api/v1/ambulances/AMB-01/status', { status: 'AVAILABLE' }], ['GET', '/api/v1/doctors'], ['GET', '/api/v1/referrals/history'],
    ['GET', '/api/v1/referrals/active'], ['POST', '/api/v1/referrals/initiate', { request_id: 'REQ-8901', hospital_id: 'H-101' }],
    ['GET', '/api/v1/analytics/dashboard'], ['GET', '/api/v1/analytics/resources'], ['GET', '/api/v1/audit/verify'],
    ['GET', '/api/v1/admin/users'], ['PATCH', '/api/v1/emergencies/REQ-8901/status', { status: 'CANCELLED' }]
  ];
  for (const [method, path, body] of denied) {
    const result = await call(path, T.patV, method, body);
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.body.success, false);
  }
  for (const staff of ['admin', 'dispatcher', 'desk101', 'medicA']) {
    assert.equal((await call('/api/v1/patient/me', T[staff])).status, 403, `${staff} on the patient API`);
    assert.equal((await call('/api/v1/patient/cases/REQ-8901', T[staff])).status, 403);
  }
});

// ── PATIENT: redacted view and socket isolation over a real lifecycle ────────
test(`patient view is redacted; patient:case_update reaches only that patient; patients get no staff events [${BACKEND}]`, async t => {
  if (dormantSkipped(t)) return;
  const a = await createCase(T.dispatcher, 'Fictional Portal Patient A', 'CARDIAC', { clinical_notes: 'STAFF-ONLY-NOTE-XYZ', contact_phone: '555-0101' });
  const b = await createCase(T.dispatcher, 'Fictional Portal Patient B', 'RESPIRATORY');
  await insertDormant('fictional.patient.a', 'PATIENT', a.patient_id);
  await insertDormant('fictional.patient.b', 'PATIENT', b.patient_id);
  const pa = (await login('fictional.patient.a', NEW_PASSWORD)).body.token;
  const pb = (await login('fictional.patient.b', NEW_PASSWORD)).body.token;
  const sA = await connectSocket(BASE, pa);
  const sB = await connectSocket(BASE, pb);
  const sAdmin = await connectSocket(BASE, T.admin);
  assert.ok(sA.connected && sB.connected);
  assert.ok(await sAdmin.waitFor(x => x.has('system:snapshot')));

  const lock = await call('/api/v1/referrals/initiate', T.dispatcher, 'POST', { request_id: a.request_id, hospital_id: 'H-101' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  const rejected = await call(`/api/v1/referrals/${lock.body.acceptance_id}/reject`, T.desk101, 'POST', { rejection_reason: 'SECRET-REJECT-REASON-42' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.next_hospital_id, 'H-103');
  const accepted = await call(`/api/v1/referrals/${rejected.body.next_acceptance_id}/accept`, T.desk103, 'POST');
  assert.equal(accepted.status, 200);

  const view = (await call(`/api/v1/patient/cases/${a.request_id}`, pa)).body.case;
  assert.deepEqual([view.request_id, view.status, view.hospital.hospital_id, view.hospital.name], [a.request_id, 'ALLOCATED', 'H-103', 'Premnagar Heart & Neuro (demo)']);
  assert.deepEqual(Object.keys(view.hospital).sort(), ['address', 'contact_phone', 'hospital_id', 'location_lat', 'location_lng', 'name']);
  if (accepted.body.ambulance_id) assert.deepEqual(Object.keys(view.ambulance).sort(), ['ambulance_id', 'eta_mins', 'status']);
  const events = view.timeline.map(e => e.event);
  assert.ok(events.includes('CASE_REGISTERED') && events.includes('HOSPITAL_ACCEPTED'), events.join(','));
  assert.ok(view.timeline.every(e => Object.keys(e).sort().join() === 'at,event'));
  const text = JSON.stringify(view);
  for (const secret of ['H-101', 'SECRET-REJECT-REASON-42', 'STAFF-ONLY-NOTE-XYZ', 'USER-', 'actor', 'row_hash', 'prev_hash', 'chain_seq',
    'acceptance', 'rejection', 'REJECTED', 'Fictional Portal Patient B', b.patient_id, b.request_id]) {
    assert.ok(!text.includes(secret), `the patient view leaks "${secret}"`);
  }
  assert.equal((await call(`/api/v1/patient/cases/${b.request_id}`, pa)).status, 404);

  // Only the ACCEPTED hospital is shown: while a referral is merely PENDING the view names no hospital.
  const pending = await createCase(T.dispatcher, 'Fictional Pending Patient', 'RESPIRATORY');
  await insertDormant('fictional.patient.pending', 'PATIENT', pending.patient_id);
  const pp = (await login('fictional.patient.pending', NEW_PASSWORD)).body.token;
  const pLock = await call('/api/v1/referrals/initiate', T.dispatcher, 'POST', { request_id: pending.request_id, hospital_id: 'H-105' });
  assert.equal(pLock.status, 201);
  const pendingView = (await call(`/api/v1/patient/cases/${pending.request_id}`, pp)).body.case;
  assert.deepEqual([pendingView.status, pendingView.hospital], ['MATCHING', null]);
  assert.ok(!JSON.stringify(pendingView).includes('H-105') && !JSON.stringify(pendingView).includes('Sahastradhara'), 'no pending hospital');
  assert.equal((await call(`/api/v1/emergencies/${pending.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);

  assert.ok(await sA.waitFor(x => x.events.some(e => e.name === 'patient:case_update' && e.payload.status === 'ALLOCATED')), 'own update delivered');
  const update = sA.events.find(e => e.name === 'patient:case_update' && e.payload.status === 'ALLOCATED').payload;
  assert.deepEqual(Object.keys(update), UPDATE_KEYS);
  assert.deepEqual([update.request_id, update.hospital_name], [a.request_id, 'Premnagar Heart & Neuro (demo)']);

  // B's case changes: B is told, A is not.
  assert.equal((await call(`/api/v1/emergencies/${b.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  assert.ok(await sB.waitFor(x => x.events.some(e => e.name === 'patient:case_update' && e.payload.status === 'CANCELLED')));
  await sA.emit('request:kpis');
  await sA.emit('request:active_locks');
  await Promise.all([sA.waitFor(() => false, 1200), sB.waitFor(() => false, 600)]);
  for (const [socket, ownId] of [[sA, a.request_id], [sB, b.request_id]]) {
    assert.ok(socket.events.length > 0);
    for (const e of socket.events) {
      assert.equal(e.name, 'patient:case_update', `a patient socket received ${e.name}`);
      assert.equal(e.payload.request_id, ownId, 'only the patient\'s own case');
      assert.ok(!JSON.stringify(e.payload).includes('H-101'));
    }
  }
  assert.ok(await sAdmin.waitFor(x => x.has('audit:entry') && x.has('lock:acquired')), 'staff events exist; patients just never see them');
});

// ── DISPATCHER ───────────────────────────────────────────────────────────────
test(`dispatcher: reads everything operational and refers/dispatches, but never decides referrals, manages or administers [${BACKEND}]`, async t => {
  if (dormantSkipped(t)) return;
  const sD = await connectSocket(BASE, T.dispatcher);
  const sAdmin = await connectSocket(BASE, T.admin);
  assert.ok(await sD.waitFor(x => x.has('system:snapshot')));
  const medicCase = await createCase(T.medicA, 'Fictional Dispatcher View', 'RESPIRATORY');
  assert.ok((await call('/api/v1/emergencies', T.dispatcher)).body.queue.some(r => r.request_id === medicCase.request_id), 'all cases');
  assert.equal((await call(`/api/v1/emergencies/${medicCase.request_id}`, T.dispatcher)).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${medicCase.request_id}/audit`, T.dispatcher)).status, 200);
  const lock = await call('/api/v1/referrals/initiate', T.dispatcher, 'POST', { request_id: medicCase.request_id, hospital_id: 'H-105' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  assert.ok(await sD.waitFor(x => x.events.some(e => e.name === 'lock:acquired' && e.payload.acceptanceId === lock.body.acceptance_id)), 'command-centre stream');
  assert.ok(await sD.waitFor(x => x.events.some(e => e.name === 'audit:entry' && e.payload.request_id === medicCase.request_id)), 'case audit stream');
  assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, T.dispatcher, 'POST')).status, 403);
  assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/reject`, T.dispatcher, 'POST', { rejection_reason: 'x' })).status, 403);
  assert.equal((await call(`/api/v1/emergencies/${medicCase.request_id}/status`, T.dispatcher, 'PATCH', { status: 'CANCELLED' })).status, 403);
  assert.equal((await call('/api/v1/referrals/active', T.dispatcher)).body.active_locks.length >= 1, true);
  assert.equal((await call('/api/v1/referrals/history', T.dispatcher)).status, 200);

  const hospitals = (await call('/api/v1/hospitals', T.dispatcher)).body.hospitals;
  assert.ok(hospitals.length === 6 && hospitals.every(h => Array.isArray(h.doctors)), 'full detail with rosters');
  for (const path of ['/api/v1/hospitals/H-104', '/api/v1/hospitals/H-104/safety', '/api/v1/doctors/DR-005', '/api/v1/analytics/dashboard',
    '/api/v1/analytics/resources', '/api/v1/ambulances/stats/summary']) {
    assert.equal((await call(path, T.dispatcher)).status, 200, path);
  }
  assert.equal((await call('/api/v1/doctors', T.dispatcher)).body.count >= 13, true);
  assert.equal((await call('/api/v1/ambulances', T.dispatcher)).body.ambulances.length, 7);
  assert.equal((await call('/api/v1/ambulances/AMB-05/status', T.dispatcher, 'PATCH', { status: 'AVAILABLE' })).status, 200, 'any unit');
  assert.equal((await call('/api/v1/ambulances/AMB-05/status', T.dispatcher, 'PATCH', { status: 'MAINTENANCE' })).status, 200);

  const forbidden = [
    ['GET', '/api/v1/analytics/history?days=7'], ['GET', '/api/v1/analytics/forecast'], ['GET', '/api/v1/analytics/audit'],
    ['GET', '/api/v1/analytics/referrals'], ['GET', '/api/v1/audit/verify'], ['GET', '/api/v1/admin/users'],
    ['PATCH', '/api/v1/hospitals/H-101/status', { emergency_status: 'LIMITED' }],
    ['PATCH', '/api/v1/hospitals/H-101/resources/ICU_BED', { available_capacity: 1 }],
    ['POST', '/api/v1/doctors', { hospital_id: 'H-101', full_name: 'Dr. Fictional', specialization: 'GENERAL_ER' }],
    ['PATCH', '/api/v1/doctors/DR-001/status', { availability_status: 'OFF_DUTY' }], ['DELETE', '/api/v1/doctors/DR-004'],
    ['POST', `/api/v1/emergencies/${medicCase.request_id}/advance-stage`]
  ];
  for (const [method, path, body] of forbidden) assert.equal((await call(path, T.dispatcher, method, body)).status, 403, `${method} ${path}`);

  // Audit entries without a case (accounts, hospital status) are ADMIN-only on the socket, as GET /analytics/audit is.
  await createAccount({ username: 'fictional.audit.probe', role: 'HOSPITAL_DESK', hospital_id: 'H-104' });
  assert.ok(await sAdmin.waitFor(x => x.events.some(e => e.name === 'audit:entry' && e.payload.event_type === 'USER_CREATED')));
  await sD.waitFor(() => false, 600);
  assert.ok(!sD.events.some(e => e.name === 'audit:entry' && !e.payload.request_id), 'no admin-only audit entries for a dispatcher');
  assert.equal((await call(`/api/v1/emergencies/${medicCase.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
});

// ── HOSPITAL_DESK and PARAMEDIC: own vs other ────────────────────────────────
test(`desk and paramedic: own hospital / own case vs another one [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  assert.equal((await call('/api/v1/hospitals/H-101', T.desk101)).status, 200);
  assert.equal((await call('/api/v1/hospitals/H-102', T.desk101)).status, 403);
  assert.equal((await call('/api/v1/doctors/DR-005', T.desk101)).status, 403);
  const own = await createCase(T.medicA, 'Fictional Own Case', 'GENERAL');
  assert.equal((await call(`/api/v1/emergencies/${own.request_id}`, T.medicA)).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${own.request_id}`, T.medicB)).status, 404);
  assert.equal((await call('/api/v1/ambulances/AMB-04/status', T.medicA, 'PATCH', { status: 'AVAILABLE' })).status, 403);
  for (const role of ['desk101', 'medicA']) {
    assert.equal((await call(`/api/v1/referrals/initiate`, T[role], 'POST', { request_id: 'REQ-8903', hospital_id: 'H-101' })).status,
      role === 'desk101' ? 403 : 404, role);
  }
  assert.equal((await call(`/api/v1/emergencies/${own.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
});

// ── ADMIN account API ────────────────────────────────────────────────────────
test(`admin API: ADMIN only; validation; no hashes; self-demotion and last-admin refused; changes apply at once; audited [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  for (const role of ['dispatcher', 'desk101', 'medicA', 'patV'].filter(r => T[r])) {
    for (const [method, path, body] of [['GET', '/api/v1/admin/users'], ['POST', '/api/v1/admin/users', { username: 'x.y.z', role: 'ADMIN', password: NEW_PASSWORD }],
      ['PATCH', '/api/v1/admin/users/USER-ADM-001', { display_name: 'x' }], ['POST', '/api/v1/admin/users/USER-ADM-001/reset-password', { password: NEW_PASSWORD }]]) {
      assert.equal((await call(path, T[role], method, body)).status, 403, `${role}: ${method} ${path}`);
    }
  }

  const list = await call('/api/v1/admin/users?limit=200', T.admin);
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('password') && !JSON.stringify(list.body).includes('$2'), 'never a hash');
  assert.ok(list.body.users.length === list.body.total && list.body.total >= 8);
  assert.ok(!list.body.users.some(u => ['dispatch_ops', 'patient_vance', 'patient_jenkins'].includes(u.username)), 'no retired demo login');
  const patients = (await call('/api/v1/admin/users?role=patient', T.admin)).body.users;
  assert.ok(patients.every(u => u.role === 'PATIENT'));
  if (BACKEND === 'mysql') assert.ok(['USER-PAT-T01', 'USER-PAT-T02'].every(id => patients.some(u => u.user_id === id)), 'the role filter finds the dormant accounts');
  else assert.deepEqual(patients, [], 'no PATIENT account can exist in the in-memory store');
  const page1 = (await call('/api/v1/admin/users?limit=2&offset=0', T.admin)).body;
  const page2 = (await call('/api/v1/admin/users?limit=2&offset=2', T.admin)).body;
  assert.equal(page1.users.length, 2);
  assert.notDeepEqual(page1.users.map(u => u.user_id), page2.users.map(u => u.user_id));
  assert.equal(page1.total, page2.total);
  assert.equal((await call('/api/v1/admin/users?active=false', T.admin)).body.users.every(u => u.is_active === 0), true);

  const invalid = [
    [{ username: 'fictional.short', role: 'ADMIN', password: 'short-pw' }, 400],
    [{ username: 'fictional.pat', role: 'PATIENT' }, 400],
    [{ username: 'fictional.desk0', role: 'HOSPITAL_DESK' }, 400],
    [{ username: 'fictional.adm.pat', role: 'ADMIN', patient_id: 'PAT-001' }, 400],
    [{ username: 'fictional.desk9', role: 'HOSPITAL_DESK', hospital_id: 'H-999' }, 400],
    [{ username: 'fictional.medic9', role: 'PARAMEDIC', ambulance_id: 'AMB-99' }, 400],
    [{ username: 'fictional.pat9', role: 'PATIENT', patient_id: 'PAT-NOPE' }, 400],
    [{ username: 'fictional.root', role: 'ROOT' }, 400],
    // Batch 8: the Operator and Patient roles are retired: never given, however valid the rest of the body.
    [{ username: 'fictional.operator', role: 'DISPATCHER' }, 400],
    [{ username: 'fictional.patient.ok', role: 'PATIENT', patient_id: 'PAT-001' }, 400],
    [{ username: 'admin', role: 'ADMIN' }, 409]
  ];
  for (const [body, status] of invalid) {
    assert.equal((await call('/api/v1/admin/users', T.admin, 'POST', { password: NEW_PASSWORD, ...body })).status, status, JSON.stringify(body));
  }

  // Self: no self-demotion or self-deactivation; other edits are fine.
  assert.equal((await call(`/api/v1/admin/users/${U.admin.user_id}`, T.admin, 'PATCH', { role: 'HOSPITAL_DESK', hospital_id: 'H-101' })).status, 409);
  assert.equal((await call(`/api/v1/admin/users/${U.admin.user_id}`, T.admin, 'PATCH', { is_active: false })).status, 409);
  assert.equal((await call(`/api/v1/admin/users/${U.admin.user_id}`, T.admin, 'PATCH', { display_name: 'Fictional Chief' })).status, 200);
  assert.equal((await call('/api/v1/admin/users/USER-NOPE', T.admin, 'PATCH', { display_name: 'x' })).status, 404);

  // Last active non-demo ADMIN (the demo admin does not count).
  const one = await createAccount({ username: 'fictional.admin.one', role: 'ADMIN' });
  const oneToken = (await login('fictional.admin.one', NEW_PASSWORD)).body.token;
  for (const role of ['DISPATCHER', 'PATIENT']) {
    assert.equal((await call(`/api/v1/admin/users/${one.user_id}`, T.admin, 'PATCH', { role })).status, 400, `${role}: retired, never given`);
  }
  assert.equal((await call(`/api/v1/admin/users/${one.user_id}`, T.admin, 'PATCH', { role: 'HOSPITAL_DESK', hospital_id: 'H-101' })).status, 409, 'last real admin');
  assert.equal((await call(`/api/v1/admin/users/${one.user_id}`, T.admin, 'PATCH', { is_active: false })).status, 409);
  const two = await createAccount({ username: 'fictional.admin.two', role: 'ADMIN' });
  assert.equal((await call(`/api/v1/admin/users/${one.user_id}`, T.admin, 'PATCH', { role: 'HOSPITAL_DESK', hospital_id: 'H-101' })).status, 200);
  const demoted = await call('/api/v1/admin/users', oneToken);
  assert.deepEqual([demoted.status, demoted.body.error], [401, REVOKED], 'a role change ends the old session at once');
  assert.equal((await call(`/api/v1/admin/users/${two.user_id}`, T.admin, 'PATCH', { is_active: false })).status, 409, 'two is now the last');

  // Immediate effect on REST and a live socket. A role change ends the old session (token_version): the old token is
  // refused, its socket is cut, and a new sign-in gets the new scope.
  const desk = await createAccount({ username: 'fictional.desk.live', role: 'HOSPITAL_DESK', hospital_id: 'H-102' });
  const deskToken = (await login('fictional.desk.live', NEW_PASSWORD)).body.token;
  assert.equal((await call('/api/v1/ambulances', deskToken)).body.ambulances.every(a => a.hospital_id === 'H-102'), true);
  const socket = await connectSocket(BASE, deskToken);
  assert.ok(await socket.waitFor(x => x.has('system:snapshot')));
  assert.equal((await call(`/api/v1/admin/users/${desk.user_id}`, T.admin, 'PATCH', { role: 'ADMIN', hospital_id: null })).status, 200);
  const old = await call('/api/v1/ambulances', deskToken);
  assert.deepEqual([old.status, old.body.error], [401, REVOKED], 'the pre-change token is refused at once');
  assert.ok(await socket.waitFor(x => x.disconnected, 6000), 'and its live socket is cut');
  assert.equal((await connectSocket(BASE, deskToken)).connected, false, 'nor can it open a new socket');
  const newToken = (await login('fictional.desk.live', NEW_PASSWORD)).body.token;
  assert.equal((await call('/api/v1/ambulances', newToken)).body.ambulances.length, 7, 'a new sign-in has the new role');
  const socket2 = await connectSocket(BASE, newToken);
  assert.ok(await socket2.waitFor(x => x.has('system:snapshot')));
  const c = await createCase(T.admin, 'Fictional Rerooming Case', 'GENERAL');
  const lock = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: c.request_id, hospital_id: 'H-104' });
  assert.equal(lock.status, 201);
  assert.ok(await socket2.waitFor(x => x.events.some(e => e.name === 'lock:acquired' && e.payload.acceptanceId === lock.body.acceptance_id)),
    'the new session is in the command centre');
  // Deactivation cuts the session; re-activation does NOT revive the old token (only a new sign-in works).
  assert.equal((await call(`/api/v1/admin/users/${desk.user_id}`, T.admin, 'PATCH', { is_active: false })).status, 200);
  assert.equal((await call('/api/v1/emergencies', newToken)).status, 401, 'deactivation applies at once');
  assert.ok(await socket2.waitFor(x => x.disconnected, 6000), 'and the live socket is cut');
  assert.equal((await call(`/api/v1/admin/users/${desk.user_id}`, T.admin, 'PATCH', { is_active: true })).status, 200);
  const revived = await call('/api/v1/emergencies', newToken);
  assert.deepEqual([revived.status, revived.body.error], [401, REVOKED], 're-activation does not bring the old token back');
  assert.equal((await connectSocket(BASE, newToken)).connected, false);
  assert.equal((await call('/api/v1/emergencies', (await login('fictional.desk.live', NEW_PASSWORD)).body.token)).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${c.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);

  // A password reset ends every existing session at once (REST and socket); a sign-in right after it works.
  await createAccount({ username: 'fictional.ops.reset', role: 'PARAMEDIC', ambulance_id: 'AMB-05' });
  const opsToken = (await login('fictional.ops.reset', NEW_PASSWORD)).body.token;
  const opsSocket = await connectSocket(BASE, opsToken);
  assert.ok(await opsSocket.waitFor(x => x.has('system:snapshot')));
  const ops = (await call('/api/v1/admin/users?role=PARAMEDIC&limit=200', T.admin)).body.users.find(u => u.username === 'fictional.ops.reset');
  assert.equal((await call(`/api/v1/admin/users/${ops.user_id}/reset-password`, T.admin, 'POST', { password: `${NEW_PASSWORD}-r` })).status, 200);
  const afterReset = await call('/api/v1/ambulances', opsToken);
  assert.deepEqual([afterReset.status, afterReset.body.error], [401, REVOKED], 'the old token dies with the old password');
  assert.ok(await opsSocket.waitFor(x => x.disconnected, 6000), 'its live socket is cut');
  const sameSecond = (await login('fictional.ops.reset', `${NEW_PASSWORD}-r`)).body.token;
  assert.equal((await call('/api/v1/ambulances', sameSecond)).status, 200, 'a new sign-in in the same second still works');

  // Resetting a demo account's password makes it a real account (both stores).
  assert.equal((await call('/api/v1/admin/users/USER-HSP-104/reset-password', T.admin, 'POST', { password: `${NEW_PASSWORD}-d` })).status, 200);
  const memorial = (await call('/api/v1/admin/users?role=HOSPITAL_DESK&limit=200', T.admin)).body.users.find(u => u.user_id === 'USER-HSP-104');
  assert.equal(memorial.is_demo, 0);
  assert.ok(!('token_version' in memorial) && !('password_hash' in memorial));

  // A PATIENT account carries no hospital or unit; and referral:status goes only to CURRENT staff: a paramedic later
  // turned into a patient no longer hears about the referrals they sent.
  assert.equal((await call('/api/v1/admin/users', T.admin, 'POST', { username: 'fictional.pat.unit', role: 'PATIENT', patient_id: 'PAT-003', ambulance_id: 'AMB-02', password: NEW_PASSWORD })).status, 400);
  assert.equal((await call('/api/v1/admin/users', T.admin, 'POST', { username: 'fictional.pat.hosp', role: 'PATIENT', patient_id: 'PAT-003', hospital_id: 'H-101', password: NEW_PASSWORD })).status, 400);
  const flip = await createAccount({ username: 'fictional.medic.flip', role: 'PARAMEDIC', ambulance_id: 'AMB-02' });
  const flipStaff = (await login('fictional.medic.flip', NEW_PASSWORD)).body.token;
  const x = await createCase(flipStaff, 'Fictional Flip Patient', 'RESPIRATORY');
  const xLock = await call('/api/v1/referrals/initiate', flipStaff, 'POST', { request_id: x.request_id, hospital_id: 'H-101' });
  assert.equal(xLock.status, 201, JSON.stringify(xLock.body));
  for (const ambulance_id of ['AMB-02', null]) {
    assert.equal((await call(`/api/v1/admin/users/${flip.user_id}`, T.admin, 'PATCH', { role: 'PATIENT', patient_id: x.patient_id, ambulance_id })).status, 400,
      'the PATIENT role is retired: never given by the admin API');
  }
  if (BACKEND === 'mysql') {
    // The dormant rule still holds for an account that holds the role (changed directly in the store).
    await database.admin.query("UPDATE SystemUser SET role = 'PATIENT', patient_id = ?, ambulance_id = NULL, token_version = token_version + 1 WHERE user_id = ?",
      [x.patient_id, flip.user_id]);
    const flipPatient = (await login('fictional.medic.flip', NEW_PASSWORD)).body.token;
    const flipSocket = await connectSocket(BASE, flipPatient);
    assert.ok(flipSocket.connected);
    assert.equal((await call(`/api/v1/referrals/${xLock.body.acceptance_id}/reject`, T.desk101, 'POST', { rejection_reason: 'Full' })).status, 200);
    assert.ok(await flipSocket.waitFor(s => s.has('patient:case_update')), 'the patient still sees their own case');
    await flipSocket.waitFor(() => false, 1000);
    assert.ok(!flipSocket.has('referral:status'), 'no staff referral:status reaches a former paramedic who is now a patient');
    assert.ok(flipSocket.events.every(e => e.name === 'patient:case_update'));
  }
  assert.equal((await call(`/api/v1/emergencies/${x.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);

  // Password reset.
  const reset = await call(`/api/v1/admin/users/${two.user_id}/reset-password`, T.admin, 'POST', { password: `${NEW_PASSWORD}-2` });
  assert.deepEqual([reset.status, reset.body.user_id], [200, two.user_id]);
  assert.equal((await login('fictional.admin.two', NEW_PASSWORD)).status, 401);
  assert.equal((await login('fictional.admin.two', `${NEW_PASSWORD}-2`)).status, 200);
  assert.equal((await call(`/api/v1/admin/users/${two.user_id}/reset-password`, T.admin, 'POST', { password: 'too-short' })).status, 400);

  // Every change is audited with the admin as actor, never with a password.
  const audit = (await call('/api/v1/analytics/audit?limit=200', T.admin)).body.audit_trail
    .filter(e => ['USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET'].includes(e.event_type));
  assert.ok(audit.length >= 8);
  assert.ok(audit.every(e => e.actor_role === 'ADMIN' && e.actor_id === U.admin.user_id));
  assert.ok(audit.some(e => e.event_type === 'USER_PASSWORD_RESET' && JSON.stringify(e.metadata).includes(two.user_id)));
  assert.ok(!JSON.stringify(audit).includes(NEW_PASSWORD), 'no password in the audit trail');
});

// ── Round 4: account-change message, last_login, the admin patient list ─────────
test(`an existing but deactivated account's token gets the account-change message; forged or unknown ones stay generic [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const jwt = (await import('jsonwebtoken')).default;
  const GENERIC = 'Token invalid or expired. Please re-authenticate.';
  const user = await createAccount({ username: 'fictional.r4.inactive', role: 'HOSPITAL_DESK', hospital_id: 'H-104' });
  const token = (await login('fictional.r4.inactive', NEW_PASSWORD)).body.token;
  assert.equal((await call(`/api/v1/admin/users/${user.user_id}`, T.admin, 'PATCH', { is_active: false })).status, 200);
  const refused = await call('/api/v1/emergencies', token);
  assert.deepEqual([refused.status, refused.body.error], [401, REVOKED], 'REST: the account-change message');
  assert.equal((await connectSocket(BASE, token)).error, REVOKED, 'socket handshake: the account-change message');

  const { iat: _iat, exp: _exp, ...claims } = jwt.decode(token);
  const sign = (extra, secret = SECRET) => jwt.sign({ ...claims, ...extra }, secret, { algorithm: 'HS256', expiresIn: 600 });
  const unknown = sign({ user_id: 'USER-NO-SUCH-ONE', sub: 'USER-NO-SUCH-ONE' });
  const forged = sign({}, 'a-completely-different-secret-value-xx');
  for (const [name, bad] of [['unknown account', unknown], ['wrong signature', forged], ['garbage', 'not-a-jwt']]) {
    const r = await call('/api/v1/emergencies', bad);
    assert.deepEqual([r.status, r.body.error], [401, GENERIC], `REST ${name}: generic`);
    assert.equal((await connectSocket(BASE, bad)).error, 'Invalid or expired socket token.', `socket ${name}: generic`);
  }
});

test(`a successful login records last_login (visible to admins) without ending other sessions [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const find = async id => (await call('/api/v1/admin/users?limit=200', T.admin)).body.users.find(u => u.user_id === id);
  assert.ok((await find(U.desk102.user_id)).last_login, 'set by the login in test.before');
  const again = await login('stjude_desk', 'hospital123');
  assert.equal(again.status, 200);
  assert.ok(Date.parse((await find(U.desk102.user_id)).last_login) > 0);
  assert.equal((await call('/api/v1/ambulances', T.desk102)).status, 200, 'the earlier token still works (no token_version bump)');
});

test(`GET /admin/patients: ADMIN only, id/name search, paging, and only id, name, age, gender [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const all = await call('/api/v1/admin/patients?limit=200', T.admin);
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body).sort(), ['limit', 'offset', 'patients', 'success', 'total']);
  assert.ok(all.body.total >= 3 && all.body.patients.length === all.body.total);
  for (const p of all.body.patients) assert.deepEqual(Object.keys(p).sort(), ['age', 'full_name', 'gender', 'patient_id']);
  assert.ok(!JSON.stringify(all.body).includes('contact_phone') && !JSON.stringify(all.body).includes('555-0101'), 'no contact data');
  const vance = (await call('/api/v1/admin/patients?q=vANCe', T.admin)).body;
  assert.deepEqual(vance.patients.map(p => [p.patient_id, p.full_name, p.age, p.gender]), [['PAT-001', 'Robert Vance', 58, 'MALE']]);
  assert.deepEqual((await call('/api/v1/admin/patients?q=PAT-002', T.admin)).body.patients.map(p => p.patient_id), ['PAT-002']);
  assert.equal((await call('/api/v1/admin/patients?q=%25', T.admin)).body.total, 0, 'a wildcard is searched literally');
  const page = (await call('/api/v1/admin/patients?limit=1&offset=1', T.admin)).body;
  assert.deepEqual([page.limit, page.offset, page.patients.length, page.total], [1, 1, 1, all.body.total]);
  assert.equal((await call(`/api/v1/admin/patients?q=${'x'.repeat(151)}`, T.admin)).status, 400);
  assert.equal((await call('/api/v1/admin/patients?limit=0', T.admin)).status, 400);
  for (const role of ['dispatcher', 'desk101', 'medicA', 'patV'].filter(r => T[r])) {
    assert.equal((await call('/api/v1/admin/patients', T[role])).status, 403, role);
  }
});

test(`GET /analytics/my-registrations: the caller's own cases, recorded milestones only, S6-2-gated means, ADMIN only [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const CASE_KEYS = ['request_id', 'patient_id', 'patient_name', 'age', 'gender', 'emergency_type', 'triage_priority', 'status',
    'registered_at', 'first_referral_at', 'accepted_at', 'accepted_hospital_id', 'accepted_hospital_name', 'dispatched_at', 'ambulance_id',
    'completed_at', 'minutes_to_acceptance', 'minutes_to_dispatch', 'minutes_to_completion'];
  // A fresh admin registers two cases: one taken through the whole lifecycle, one left untouched.
  await createAccount({ username: 'fictional.reg.admin', role: 'ADMIN' });
  const reg = (await login('fictional.reg.admin', NEW_PASSWORD)).body.token;
  const done = await createCase(reg, 'Fictional Registered Done', 'GENERAL');
  const idle = await createCase(reg, 'Fictional Registered Idle', 'GENERAL');
  const lock = await call('/api/v1/referrals/initiate', reg, 'POST', { request_id: done.request_id, hospital_id: 'H-101' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, T.desk101, 'POST');
  assert.equal(accepted.status, 200);
  assert.equal((await call(`/api/v1/emergencies/${done.request_id}/status`, reg, 'PATCH', { status: 'COMPLETED' })).status, 200);
  // Another admin's own registration must not appear.
  const others = await createCase(T.admin, 'Fictional Other Admin Case', 'GENERAL');

  const r = await call('/api/v1/analytics/my-registrations', reg);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['cases', 'success', 'summary', 'window']);
  assert.deepEqual(r.body.cases.map(c => c.request_id), [idle.request_id, done.request_id], 'only the caller\'s cases, newest first');
  for (const c of r.body.cases) assert.deepEqual(Object.keys(c), CASE_KEYS);
  const [i, d] = r.body.cases;
  assert.deepEqual([i.first_referral_at, i.accepted_at, i.accepted_hospital_id, i.dispatched_at, i.ambulance_id, i.completed_at,
    i.minutes_to_acceptance, i.minutes_to_dispatch, i.minutes_to_completion], [null, null, null, null, null, null, null, null, null], 'no invented milestones');
  assert.deepEqual([d.patient_name, d.age, d.patient_id, d.status, d.accepted_hospital_id, d.accepted_hospital_name],
    ['Fictional Registered Done', 41, done.patient_id, 'COMPLETED', 'H-101', 'Clock Tower Trauma Centre (demo)']);
  for (const k of ['first_referral_at', 'accepted_at', 'completed_at']) assert.ok(Date.parse(d[k]) >= Date.parse(d.registered_at), k);
  assert.ok(d.minutes_to_acceptance >= 0 && d.minutes_to_completion >= d.minutes_to_acceptance);
  if (accepted.body.ambulance_id) assert.deepEqual([d.ambulance_id, d.dispatched_at !== null], [accepted.body.ambulance_id, true]);
  else assert.deepEqual([d.ambulance_id, d.dispatched_at, d.minutes_to_dispatch], [null, null, null]);
  const sm = r.body.summary;
  assert.deepEqual([sm.count, sm.accepted_count, sm.completed_count, sm.open_count], [2, 1, 1, 1]);
  assert.deepEqual([sm.avg_minutes_to_acceptance, sm.avg_minutes_to_dispatch, sm.avg_minutes_to_completion], [null, null, null], 'below the minimum sample');
  assert.deepEqual([sm.sample_size.acceptance, sm.sample_size.completion, sm.minimum_sample], [1, 1, 20]);
  assert.ok(Date.parse(r.body.window.to) - Date.parse(r.body.window.from) === 30 * 86_400_000, 'default 30 days');
  assert.ok(!(await call('/api/v1/analytics/my-registrations', T.admin)).body.cases.some(c => [done.request_id, idle.request_id].includes(c.request_id)));
  assert.ok((await call('/api/v1/analytics/my-registrations', T.admin)).body.cases.some(c => c.request_id === others.request_id));

  const limited = (await call('/api/v1/analytics/my-registrations?limit=1&days=1', reg)).body;
  assert.deepEqual([limited.cases.length, limited.summary.count], [1, 2], 'limit trims the list, not the summary');
  for (const q of ['days=0', 'days=367', 'days=abc', 'days=1.5', 'limit=0', 'limit=501', 'days=7&days=8', 'limit=5&limit=6']) {
    assert.equal((await call(`/api/v1/analytics/my-registrations?${q}`, reg)).status, 400, q);
  }
  for (const role of ['dispatcher', 'desk101', 'medicA', 'patV'].filter(r => T[r])) {
    assert.equal((await call('/api/v1/analytics/my-registrations', T[role])).status, 403, role);
  }
  assert.equal((await call(`/api/v1/emergencies/${idle.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${others.request_id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
});

if (BACKEND === 'memory') {
test(`API_RATE_LIMIT: configurable per minute, junk stops start-up [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const port = 4258;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(port), DB_USE_MEMORY: 'true', JWT_SECRET: SECRET, SIMULATED_TRANSPORT: 'off'
  };
  for (const value of ['abc', '0', '-5', '1.5', '1e3']) {
    const bad = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env: { ...env, API_RATE_LIMIT: value }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    bad.stdout.on('data', c => { out += c; });
    bad.stderr.on('data', c => { out += c; });
    const code = await Promise.race([once(bad, 'exit').then(([c]) => c), sleep(15_000).then(() => 'still running')]);
    if (code === 'still running') { bad.kill('SIGTERM'); await once(bad, 'exit'); }
    assert.equal(code, 1, value);
    assert.match(out, /API_RATE_LIMIT must be a whole number/);
  }
  const limited = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env: { ...env, API_RATE_LIMIT: '5' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ } await sleep(100); }
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await fetch(`http://127.0.0.1:${port}/api/v1/hospitals`)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429], 'the 6th request in the minute is limited');
  } finally {
    if (limited.exitCode === null) { limited.kill('SIGTERM'); await once(limited, 'exit'); }
  }
});
}
