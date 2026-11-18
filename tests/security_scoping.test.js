// Batch 3 (security and API) over HTTP and Socket.IO against a real `node server/server.js`: hashed accounts and login
// (X2), token rules on REST and sockets (X9), the one scoping policy per role over REST AND sockets (X5), paramedic
// ambulance binding (X4), per-user referral:status (B1-R1), CSP / no-store / error shape (X11), strict validation (X7),
// rate limits (X6) and the UI additions (accepted/pending hospital, KPI names, real remaining seconds).
// Runs on the in-memory store by default; tests/security_scoping_mysql.test.js runs the IDENTICAL scenario on the MySQL
// test database (API_TEST_BACKEND=mysql). All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { connectSocket } from './helpers/rawSocket.js';
import { DEMO_USERS } from '../server/db/demoUsers.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4253 : 4252;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'security-scoping-test-secret-0123456789';
const SOCKET_EVENT_LIMIT = 8;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "style-src 'self' https://fonts.googleapis.com https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
];
const STATUS_KEYS = ['acceptance_id', 'request_id', 'hospital_id', 'status', 'next_acceptance_id', 'next_hospital_id', 'ambulance_id', 'at'];

let server = null;
let database = null;
let skipReason = null;
const T = {};      // tokens
const U = {};      // users as returned by /auth/login

function startServer(port, env) {
  const proc = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' };
  proc.stdout.on('data', chunk => { log.text += chunk; });
  proc.stderr.on('data', chunk => { log.text += chunk; });
  return { proc, log };
}

async function waitHealthy(proc, base, log) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${log.text}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`server did not become healthy:\n${log.text}`);
}

/** The exit code, or 'still running' (the process is then killed) if it does not exit within `ms`: a test never hangs. */
async function exitCodeWithin(proc, ms = 15_000) {
  const timer = sleep(ms).then(() => 'still running');
  const result = await Promise.race([once(proc, 'exit').then(([code]) => code), timer]);
  if (result === 'still running') await stop(proc);
  return result;
}

async function stop(proc) {
  if (proc && proc.exitCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
}

async function call(path, token, method = 'GET', body, headers = {}, base = BASE) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}

const login = (username, password, base = BASE) => call('/api/v1/auth/login', null, 'POST', { username, password }, {}, base);
const ids = async token => new Set((await call('/api/v1/emergencies', token)).body.queue.map(r => r.request_id));
async function createCase(token, name, type = 'CARDIAC', headers = {}) {
  const created = await call('/api/v1/emergencies', token, 'POST', { patient_name: name, age: 50, emergency_type: type, triage_priority: 2 }, headers);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.request_id;
}
const skipped = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };

test.before(async () => {
  // The memory server never receives the MySQL test credentials (MYSQL_TEST_*), even if this process has them.
  let env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(PORT), DB_USE_MEMORY: 'true', SIMULATED_TRANSPORT: 'off', JWT_SECRET: SECRET, SOCKET_EVENT_LIMIT: String(SOCKET_EVENT_LIMIT), SOCKET_RECHECK_MS: '1000'
  };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true); // fresh schema + demo data (demo accounts included), test database only
    env = mysqlServerEnv(PORT, { JWT_SECRET: SECRET, SOCKET_EVENT_LIMIT: String(SOCKET_EVENT_LIMIT), SOCKET_RECHECK_MS: '1000', JWT_EXPIRES: '', TRUST_PROXY: '' });
  }
  const started = startServer(PORT, env);
  server = started.proc;
  await waitHealthy(server, BASE, started.log);
  const accounts = { admin: ['admin', 'admin123'], medicA: ['UNIT-402', 'paramedic123'], medicB: ['UNIT-601', 'paramedic123'],
    desk101: ['apex_desk', 'hospital123'], desk102: ['stjude_desk', 'hospital123'], desk103: ['fortis_desk', 'hospital123'] };
  for (const [key, [username, password]] of Object.entries(accounts)) {
    const result = await login(username, password);
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
    U[key] = result.body.user;
  }
});

test.after(async () => {
  await stop(server);
  await database?.release?.();
});

// ── Headers and error shape ──────────────────────────────────────────────────
test(`CSP, no-store on /api, one error shape and the real 404 path [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  for (const path of ['/', '/api/v1/hospitals']) {
    const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${T.admin}` } });
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, `${path} carries a Content-Security-Policy`);
    assert.deepEqual(csp.split(';').map(d => d.trim()).filter(Boolean), EXPECTED_CSP, `${path}: exactly the policy of SERVER_REQUIREMENTS.md §1`);
  }
  assert.equal((await call('/api/v1/hospitals', T.admin)).headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/v1/emergencies', null)).headers.get('cache-control'), 'no-store', 'error responses too');
  assert.notEqual((await fetch(`${BASE}/css/main.css`)).headers.get('cache-control'), 'no-store', 'static assets are not affected');

  const missing = await call('/api/v1/no-such-thing?x=1', T.admin);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { success: false, error: 'API endpoint not found: GET /api/v1/no-such-thing' });
  for (const result of [await call('/api/v1/emergencies', null), await call('/api/v1/analytics/audit', T.medicA),
    await call('/api/v1/emergencies/REQ-0000', T.admin), await call('/api/v1/emergencies', T.admin, 'POST', '{"broken json')]) {
    assert.equal(result.body.success, false, JSON.stringify(result.body));
    assert.equal(typeof result.body.error, 'string');
  }
});

// ── Accounts and login (X2) ──────────────────────────────────────────────────
test(`login: hashed accounts, one error for unknown user and wrong password, the session shape the UI reads [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const wrong = await login('admin', 'not-the-password');
  const unknown = await login('nobody-at-all', 'whatever-password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body, 'the same response for an unknown user and a wrong password');
  assert.equal((await login('ADMIN', 'admin123')).status, 401, 'usernames are case-sensitive on both stores');
  const storedHash = DEMO_USERS.find(u => u.username === 'admin').password_hash;
  assert.equal((await login('admin', storedHash)).status, 401, 'the stored hash is not a password (bcrypt.compare only, no plain comparison)');

  const ok = await login('UNIT-402', 'paramedic123');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.user, { user_id: 'USER-EMS-001', username: 'UNIT-402', role: 'PARAMEDIC', hospital_id: null, ambulance_id: 'AMB-01', patient_id: null, display_name: 'Paramedic Unit 402' });
  assert.equal(ok.body.expires_in, '8h', 'the configured JWT_EXPIRES, not a constant');
  const claims = jwt.decode(ok.body.token);
  assert.equal(new Date(ok.body.expires_at).getTime(), claims.exp * 1000);
  assert.equal(claims.exp - claims.iat, 8 * 3600);
  const me = await call('/api/v1/auth/me', ok.body.token);
  assert.deepEqual(me.body.user, ok.body.user);
  assert.equal(U.desk101.hospital_id, 'H-101');

  for (const body of [{ username: { $ne: '' }, password: 'x' }, { username: 'admin' }, { username: 'admin', password: ['admin123'] }, ['admin']]) {
    const bad = await call('/api/v1/auth/login', null, 'POST', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }

  if (BACKEND === 'mysql') {
    const [rows] = await database.admin.query('SELECT username, password_hash, is_demo FROM SystemUser ORDER BY user_id');
    assert.equal(rows.length, 8);
    for (const row of rows) {
      assert.match(row.password_hash, /^\$2[aby]\$1\d\$/, 'bcrypt, cost >= 10');
      assert.ok(!['admin123', 'hospital123', 'paramedic123'].includes(row.password_hash));
      assert.equal(row.is_demo, 1);
    }
    const [columns] = await database.admin.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'SystemUser' AND column_name LIKE '%pass%'");
    assert.deepEqual(columns.map(c => c.c), ['password_hash'], 'no plaintext password column');
  }
});

// ── Tokens on REST and sockets (X9) ──────────────────────────────────────────
test(`tokens: alg none, other algorithms, wrong secret / issuer / audience and expired tokens are refused on REST and sockets; a socket is cut at expiry [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const now = Math.floor(Date.now() / 1000);
  const claims = { user_id: 'USER-ADM-001', username: 'admin', role: 'ADMIN', hospital_id: null, ambulance_id: null };
  const sign = (extra = {}, options = {}) => jwt.sign({ ...claims, ...extra }, options.secret ?? SECRET,
    { algorithm: 'HS256', issuer: 'eris-api', audience: 'eris-console', expiresIn: 600, ...options.jwt });
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const forged = {
    algNone: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iss: 'eris-api', aud: 'eris-console', iat: now, exp: now + 600 })}.`,
    hs512: sign({}, { jwt: { algorithm: 'HS512' } }),
    wrongSecret: sign({}, { secret: 'a-completely-different-secret-value-xx' }),
    wrongIssuer: sign({}, { jwt: { issuer: 'evil' } }),
    wrongAudience: sign({}, { jwt: { audience: 'evil' } }),
    expired: jwt.sign({ ...claims, iss: 'eris-api', aud: 'eris-console', iat: now - 120, exp: now - 60 }, SECRET, { algorithm: 'HS256' })
  };
  assert.equal((await call('/api/v1/auth/me', sign())).status, 200, 'the control token is accepted');
  for (const [name, token] of Object.entries(forged)) {
    assert.equal((await call('/api/v1/emergencies', token)).status, 401, `REST refuses ${name}`);
    const socket = await connectSocket(BASE, token);
    assert.equal(socket.connected, false, `socket refuses ${name}`);
    assert.match(socket.error, /Invalid or expired/);
    assert.equal(socket.events.length, 0);
  }

  // A socket whose token expires is disconnected by the server.
  const shortLived = sign({}, { jwt: { expiresIn: 2 } });
  const socket = await connectSocket(BASE, shortLived);
  assert.equal(socket.connected, true);
  assert.ok(await socket.waitFor(s => s.has('system:snapshot')));
  assert.equal(socket.disconnected, false);
  assert.ok(await socket.waitFor(s => s.disconnected, 6000), 'disconnected when the token expired');
});

// ── REST scoping per role (X5) and ambulance binding (X4) ────────────────────
test(`REST scoping: cases, referrals, rosters, units and hospital detail per role; paramedics bound to their unit [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const c1 = await createCase(T.medicA, 'Fictional Scope One', 'CARDIAC');
  const c2 = await createCase(T.medicB, 'Fictional Scope Two', 'RESPIRATORY');

  // Paramedics: their own cases only.
  assert.ok((await ids(T.medicA)).has(c1));
  assert.ok(!(await ids(T.medicA)).has(c2));
  assert.ok((await ids(T.medicB)).has(c2));
  assert.ok(!(await ids(T.medicB)).has(c1));
  assert.ok(![...await ids(T.medicA)].some(id => ['REQ-8901', 'REQ-8902', 'REQ-8903'].includes(id)), 'not the demo cases of others');
  assert.equal((await call(`/api/v1/emergencies/${c2}`, T.medicA)).status, 404);
  assert.equal((await call(`/api/v1/emergencies/${c2}/audit`, T.medicA)).status, 404);
  assert.equal((await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c2, hospital_id: 'H-103' })).status, 404,
    'a paramedic cannot refer a case outside their scope');
  for (const desk of [T.desk101, T.desk102]) assert.ok(!(await ids(desk)).has(c1), 'no desk sees an unreferred case');

  // Referral to H-101: only that desk sees the case, and the list shows the pending hospital.
  const first = await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c1, hospital_id: 'H-101' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok((await ids(T.desk101)).has(c1));
  assert.equal((await call(`/api/v1/emergencies/${c1}/audit`, T.desk101)).status, 200);
  assert.ok(!(await ids(T.desk102)).has(c1));
  assert.equal((await call(`/api/v1/emergencies/${c1}`, T.desk102)).status, 404);
  const row = async () => (await call('/api/v1/emergencies', T.admin)).body.queue.find(r => r.request_id === c1);
  assert.deepEqual([(await row()).pending_hospital_id, (await row()).accepted_hospital_id], ['H-101', null]);

  // A desk cannot decide another hospital's referral; a rejection ends H-101's access (not "any historical row").
  assert.equal((await call(`/api/v1/referrals/${first.body.acceptance_id}/accept`, T.desk102, 'POST')).status, 403);
  const rejected = await call(`/api/v1/referrals/${first.body.acceptance_id}/reject`, T.desk101, 'POST', { rejection_reason: 'Full' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.next_hospital_id, 'H-103', 'server-side failover to the best eligible hospital');
  assert.ok(!(await ids(T.desk101)).has(c1), 'a REJECTED referral grants no access');
  assert.equal((await call(`/api/v1/emergencies/${c1}`, T.desk101)).status, 404);
  assert.ok((await ids(T.desk103)).has(c1), 'the failover hospital (PENDING) sees it');

  const accepted = await call(`/api/v1/referrals/${rejected.body.next_acceptance_id}/accept`, T.desk103, 'POST');
  assert.equal(accepted.status, 200);
  assert.deepEqual([(await row()).accepted_hospital_id, (await row()).pending_hospital_id], ['H-103', null]);
  assert.ok((await ids(T.desk103)).has(c1), 'ACCEPTED keeps access');

  // GET /referrals/history per role; the failover referral inherits initiated_by.
  const history = async token => (await call('/api/v1/referrals/history', token)).body.history;
  const mine = await history(T.medicA);
  assert.deepEqual(mine.map(a => a.acceptance_id).sort(), [first.body.acceptance_id, rejected.body.next_acceptance_id].sort());
  assert.ok(mine.every(a => a.initiated_by === U.medicA.user_id));
  assert.deepEqual(await history(T.medicB), []);
  assert.ok((await history(T.desk101)).every(a => a.hospital_id === 'H-101'));
  assert.ok((await history(T.desk101)).length >= 1);
  assert.ok((await history(T.admin)).length >= 2);

  // A paramedic also sees a case their unit serves: move B's unit onto A's case.
  const auto = accepted.body.ambulance_id;
  if (auto) assert.equal((await call(`/api/v1/ambulances/${auto}/status`, T.admin, 'PATCH', { status: 'AVAILABLE' })).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${c1}`, T.medicB)).status, 404);
  assert.equal((await call('/api/v1/ambulances/AMB-04/status', T.admin, 'PATCH', { status: 'DISPATCHED', request_id: c1 })).status, 200);
  assert.ok((await ids(T.medicB)).has(c1), 'assigned ambulance is theirs');
  assert.equal((await call(`/api/v1/emergencies/${c1}`, T.medicB)).status, 200);
  assert.deepEqual(await history(T.medicB), [], 'serving a case does not reveal who referred it');

  // X4: a paramedic changes only their own unit; a desk only its hospital's units.
  assert.equal((await call('/api/v1/ambulances/AMB-03/status', T.medicA, 'PATCH', { status: 'MAINTENANCE' })).status, 403);
  assert.equal((await call('/api/v1/ambulances/AMB-04/status', T.medicA, 'PATCH', { status: 'AVAILABLE' })).status, 403);
  assert.equal((await call('/api/v1/ambulances/AMB-04/status', T.medicB, 'PATCH', { status: 'IN_TRANSIT', eta_mins: 7 })).status, 200);
  assert.equal((await call('/api/v1/ambulances/AMB-01/status', T.desk102, 'PATCH', { status: 'MAINTENANCE' })).status, 403);
  assert.equal((await call('/api/v1/ambulances/AMB-01/status', T.desk101, 'PATCH', { status: 'AVAILABLE' })).status, 200);
  assert.equal((await call('/api/v1/ambulances/AMB-01/status', T.medicA, 'PATCH', { status: 'AVAILABLE', current_lat: 30.3, current_lng: 78.0 })).status, 200);

  const units = async token => (await call('/api/v1/ambulances', token)).body.ambulances;
  assert.deepEqual((await units(T.medicA)).map(a => a.ambulance_id), ['AMB-01']);
  assert.deepEqual((await units(T.medicB)).map(a => a.ambulance_id), ['AMB-04']);
  assert.ok((await units(T.desk101)).every(a => a.hospital_id === 'H-101'));
  assert.equal((await units(T.admin)).length, 7); // Batch 8: seven units stationed across Dehradun
  assert.equal((await call('/api/v1/ambulances/AMB-03', T.medicA)).status, 403);
  assert.equal((await call('/api/v1/ambulances/AMB-01', T.medicA)).status, 200);

  // Hospitals: the public summary for everyone, rosters only where the caller manages the hospital.
  const hospitals = async token => (await call('/api/v1/hospitals', token)).body.hospitals;
  for (const h of await hospitals(T.medicA)) {
    assert.ok(!('doctors' in h), `${h.hospital_id}: no roster for a paramedic`);
    assert.equal(typeof h.specialists_available.CARDIOLOGIST, 'number');
    assert.ok(h.resources.icubed && Number.isFinite(h.location_lat));
  }
  assert.deepEqual((await hospitals(T.desk101)).filter(h => 'doctors' in h).map(h => h.hospital_id), ['H-101']);
  assert.ok((await hospitals(T.admin)).every(h => Array.isArray(h.doctors)));
  assert.equal((await hospitals(T.medicA)).find(h => h.hospital_id === 'H-103').specialists_available.CARDIOLOGIST, 1);
  assert.deepEqual([await call('/api/v1/hospitals/H-101', T.medicA), await call('/api/v1/hospitals/H-101', T.desk102),
    await call('/api/v1/hospitals/H-101', T.desk101)].map(r => r.status), [403, 403, 200]);

  // Doctors: a paramedic sees no roster; a desk only its own, whatever it asks for.
  assert.equal((await call('/api/v1/doctors', T.medicA)).body.count, 0);
  assert.ok((await call('/api/v1/doctors?hospital_id=H-103', T.desk101)).body.doctors.every(d => d.hospital_id === 'H-101'));
  assert.deepEqual([await call('/api/v1/doctors/DR-005', T.desk101), await call('/api/v1/doctors/DR-005', T.medicA),
    await call('/api/v1/doctors/DR-005', T.admin)].map(r => r.status), [403, 403, 200]);

  // X11: a doctor's shift change is audited.
  assert.equal((await call('/api/v1/doctors/DR-001/shift', T.desk102, 'PATCH', { shift_start: '09:30' })).status, 403);
  assert.equal((await call('/api/v1/doctors/DR-001/shift', T.desk101, 'PATCH', { shift_start: '09:30' })).status, 200);
  const shift = (await call('/api/v1/analytics/audit?event_type=DOCTOR_SHIFT_CHANGED&limit=5', T.admin)).body.audit_trail;
  assert.equal(shift.length, 1);
  assert.deepEqual([shift[0].previous_state, shift[0].new_state, shift[0].actor_role, shift[0].actor_id, shift[0].hospital_id],
    ['08:00-20:00', '09:30-20:00', 'HOSPITAL_DESK', 'USER-HSP-101', 'H-101']);
});

test(`idempotent replay reports the case's current status; keys are case-sensitive on both stores [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const body = { patient_name: 'Fictional Replay Patient', age: 33, emergency_type: 'RESPIRATORY', triage_priority: 3 };
  const first = await call('/api/v1/emergencies', T.medicA, 'POST', body, { 'Idempotency-Key': 'Scope-Key-1' });
  assert.deepEqual([first.status, first.body.status], [201, 'WAITING']);
  assert.equal((await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: first.body.request_id, hospital_id: 'H-105' })).status, 201);
  const replay = await call('/api/v1/emergencies', T.medicA, 'POST', body, { 'Idempotency-Key': 'Scope-Key-1' });
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual([replay.status, replay.body.request_id, replay.body.status], [201, first.body.request_id, 'MATCHING']);
  const otherCase = await call('/api/v1/emergencies', T.medicA, 'POST', body, { 'Idempotency-Key': 'scope-key-1' });
  assert.equal(otherCase.headers.get('idempotent-replayed'), null, 'a key differing only in case is a different key');
  assert.notEqual(otherCase.body.request_id, first.body.request_id);
  for (const id of [first.body.request_id, otherCase.body.request_id]) {
    assert.equal((await call(`/api/v1/emergencies/${id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  }
});

// ── Sockets: rooms, per-user referral:status, KPI names, throttle ────────────
test(`sockets follow the same scoping; referral:status reaches the initiator only, with exactly the documented payload [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const names = ['admin', 'medicA', 'medicB', 'desk101', 'desk102', 'desk103'];
  const s = {};
  for (const name of names) {
    s[name] = await connectSocket(BASE, T[name]);
    assert.ok(await s[name].waitFor(x => x.has('system:snapshot')), `${name} connected`);
  }
  const settle = () => Promise.all(names.map(name => s[name].waitFor(() => false, 700)));
  const statuses = name => s[name].events.filter(e => e.name === 'referral:status').map(e => e.payload);
  const mentions = (name, id) => s[name].events.some(e => JSON.stringify(e.payload ?? '').includes(id));

  // 1. Referral to H-101: only that desk is alerted, with the lock's real remaining time.
  const c3 = await createCase(T.medicA, 'Fictional Socket Three', 'CARDIAC');
  const lock = await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c3, hospital_id: 'H-101' });
  assert.equal(lock.status, 201);
  assert.ok(await s.desk101.waitFor(x => x.has('referral:incoming')));
  const incoming = s.desk101.event('referral:incoming');
  assert.equal(incoming.acceptance_id, lock.body.acceptance_id);
  assert.ok(incoming.remaining_sec <= 90 && incoming.remaining_sec >= 80, `remaining_sec ${incoming.remaining_sec}`);

  // 2. Rejection with failover: the initiator gets REJECTED then PENDING (the failover referral).
  const rejected = await call(`/api/v1/referrals/${lock.body.acceptance_id}/reject`, T.desk101, 'POST', { rejection_reason: 'Full' });
  assert.equal(rejected.status, 200);
  const nextId = rejected.body.next_acceptance_id;
  assert.ok(nextId);
  assert.ok(await s.medicA.waitFor(() => statuses('medicA').some(p => p.status === 'PENDING')));
  const [rej, pend] = statuses('medicA');
  assert.deepEqual(Object.keys(rej), STATUS_KEYS, 'exactly the documented fields, no patient data');
  assert.deepEqual({ ...rej, at: undefined }, {
    acceptance_id: lock.body.acceptance_id, request_id: c3, hospital_id: 'H-101', status: 'REJECTED',
    next_acceptance_id: nextId, next_hospital_id: rejected.body.next_hospital_id, ambulance_id: null, at: undefined
  });
  assert.ok(!Number.isNaN(Date.parse(rej.at)));
  assert.deepEqual([pend.acceptance_id, pend.request_id, pend.hospital_id, pend.status, pend.next_acceptance_id],
    [nextId, c3, rejected.body.next_hospital_id, 'PENDING', null]);
  assert.ok(await s.desk103.waitFor(x => x.events.some(e => e.name === 'referral:incoming' && e.payload.acceptance_id === nextId)));
  // Round 2 item 9: the declining hospital is not told which hospital got the case next; the command centre is.
  assert.ok(await s.desk101.waitFor(x => x.has('referral:rejected')));
  const declined = s.desk101.events.find(e => e.name === 'referral:rejected' && e.payload.acceptanceId === lock.body.acceptance_id).payload;
  for (const key of ['next_acceptance_id', 'next_hospital_id', 'nextAcceptanceId', 'nextHospitalId']) assert.ok(!(key in declined), `hospital room payload carries ${key}`);
  assert.ok(!JSON.stringify(declined).includes(nextId), 'the failover referral id does not reach the declining hospital');
  assert.ok(await s.admin.waitFor(x => x.events.some(e => e.name === 'lock:released' && e.payload.next_acceptance_id === nextId)), 'admins keep the failover');

  // 3. Acceptance: ACCEPTED with the auto-dispatched unit.
  const accepted = await call(`/api/v1/referrals/${nextId}/accept`, T.desk103, 'POST');
  assert.equal(accepted.status, 200);
  assert.ok(await s.medicA.waitFor(() => statuses('medicA').some(p => p.status === 'ACCEPTED')));
  const acc = statuses('medicA').find(p => p.status === 'ACCEPTED');
  assert.deepEqual([acc.acceptance_id, acc.hospital_id, acc.ambulance_id], [nextId, 'H-103', accepted.body.ambulance_id ?? null]);

  // 4. Cancelling a case with a pending referral: CANCELLED.
  const c5 = await createCase(T.medicA, 'Fictional Socket Five', 'RESPIRATORY');
  const lock5 = await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c5, hospital_id: 'H-105' });
  assert.equal(lock5.status, 201);
  assert.equal((await call(`/api/v1/emergencies/${c5}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  assert.ok(await s.medicA.waitFor(() => statuses('medicA').some(p => p.status === 'CANCELLED' && p.acceptance_id === lock5.body.acceptance_id)));

  // 5. Expiry (MySQL: the persisted expiry is moved into the past; its sweeper expires it and fails over).
  if (BACKEND === 'mysql') {
    const c6 = await createCase(T.medicA, 'Fictional Socket Six', 'RESPIRATORY');
    const lock6 = await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c6, hospital_id: 'H-105' });
    assert.equal(lock6.status, 201);
    await database.admin.query('UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 1 SECOND WHERE acceptance_id = ?', [lock6.body.acceptance_id]);
    assert.ok(await s.medicA.waitFor(() => statuses('medicA').some(p => p.status === 'EXPIRED'), 15_000), 'EXPIRED delivered');
    const exp = statuses('medicA').find(p => p.status === 'EXPIRED');
    assert.equal(exp.acceptance_id, lock6.body.acceptance_id);
    if (exp.next_acceptance_id) {
      assert.ok(await s.medicA.waitFor(() => statuses('medicA').some(p => p.status === 'PENDING' && p.acceptance_id === exp.next_acceptance_id)));
    }
    assert.equal((await call(`/api/v1/emergencies/${c6}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  }
  await settle();

  // 6. Nobody else hears about A's referrals, and the scoped streams stay scoped.
  for (const name of ['admin', 'medicB', 'desk101', 'desk102', 'desk103']) {
    assert.deepEqual(statuses(name), [], `${name} receives no referral:status of another user`);
  }
  for (const id of [c3, c5]) {
    assert.ok(!mentions('medicB', id), 'another paramedic receives nothing about the case');
    assert.ok(!mentions('desk102', id), 'an uninvolved desk receives nothing about the case');
  }
  assert.ok(!mentions('desk101', c5), 'H-101 hears nothing about a referral to H-105');
  for (const name of ['medicA', 'medicB', 'desk101', 'desk102', 'desk103']) {
    for (const event of ['audit:entry', 'lock:acquired', 'lock:released', 'allocation:committed', 'lock:expired']) {
      assert.ok(!s[name].has(event), `${name} must not receive ${event} (command_center only)`);
    }
  }
  for (const name of ['medicA', 'medicB']) assert.ok(!s[name].has('referral:incoming'), `${name} is not a hospital room`);
  assert.ok(s.admin.has('audit:entry') && s.admin.has('lock:acquired'), 'the command centre does receive them');

  // 7. KPI names aligned with /analytics/dashboard (old names kept).
  await s.medicA.emit('request:kpis');
  assert.ok(await s.medicA.waitFor(x => x.has('kpis:update')));
  const kpis = s.medicA.events.filter(e => e.name === 'kpis:update').at(-1).payload;
  assert.equal(kpis.critical_p1_waiting, kpis.critical_p1);
  assert.equal(kpis.available_ambulances, kpis.ambulances_available);

  // 8. Paramedics cannot list locks over the socket either; a desk sees only its own.
  await s.medicB.emit('request:active_locks');
  assert.equal(await s.medicB.waitFor(x => x.has('locks:update'), 600), false);

  // 9. Per-socket throttle: a burst beyond SOCKET_EVENT_LIMIT is dropped.
  const before = s.desk102.events.filter(e => e.name === 'kpis:update').length;
  for (let i = 0; i < 30; i += 1) await s.desk102.emit('request:kpis');
  await s.desk102.waitFor(() => false, 1500);
  const answered = s.desk102.events.filter(e => e.name === 'kpis:update').length - before;
  assert.ok(answered >= 1 && answered <= SOCKET_EVENT_LIMIT + 1, `answered ${answered} of 30 (limit ${SOCKET_EVENT_LIMIT})`);
});

// ── Validation (X7) ──────────────────────────────────────────────────────────
test(`strict validation: wrong types, arrays, objects, ranges and lengths are 400s and change nothing [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const countCases = async () => (await call('/api/v1/emergencies', T.admin)).body.count;
  const casesBefore = await countCases();
  const good = { patient_name: 'Fictional Valid Patient', age: 40, emergency_type: 'GENERAL', triage_priority: 4 };
  const badCases = [
    { ...good, patient_name: { first: 'x' } }, { ...good, patient_name: ['x'] }, { ...good, patient_name: '   ' },
    { ...good, patient_name: 'x'.repeat(151) }, { ...good, age: '' }, { ...good, age: '40' }, { ...good, age: 131 }, { ...good, age: -1 },
    { ...good, age: 4.5 }, { ...good, age: true }, { ...good, age: undefined }, { ...good, triage_priority: '1' }, { ...good, triage_priority: 6 },
    { ...good, emergency_type: 'ALIEN' }, { ...good, emergency_type: ['GENERAL'] }, { ...good, gender: 'X' },
    { ...good, contact_phone: 'x'.repeat(31) }, { ...good, contact_phone: 12345 }, { ...good, clinical_notes: { a: 1 } },
    { ...good, pickup_lat: '28.6', pickup_lng: 77.2 }, { ...good, pickup_lat: 91, pickup_lng: 77.2 },
    { ...good, required_resources: 'ICU_BED' }, { ...good, required_resources: [{}] }, { ...good, required_specialist: { x: 1 } }
  ];
  for (const body of badCases) {
    const result = await call('/api/v1/emergencies', T.admin, 'POST', body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.success, false);
  }
  assert.equal(await countCases(), casesBefore, 'no case was created by a refused request');

  const capacity = body => call('/api/v1/hospitals/H-104/resources/OT', T.admin, 'PATCH', body);
  for (const body of [{ available_capacity: true }, { available_capacity: '1' }, { available_capacity: 0.5 }, { available_capacity: -1 },
    { total_capacity: [3] }, {}, { available_capacity: null }]) {
    assert.equal((await capacity(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await capacity({ available_capacity: 1 })).status, 200, 'a valid edit still works');

  const c = await createCase(T.medicA, 'Fictional Validation Referral', 'RESPIRATORY');
  const lock = await call('/api/v1/referrals/initiate', T.medicA, 'POST', { request_id: c, hospital_id: 'H-101' });
  assert.equal(lock.status, 201);
  for (const body of [{ rejection_reason: 'x'.repeat(301) }, { rejection_reason: { text: 'x' } }, { rejection_reason: ['x'] }]) {
    assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/reject`, T.desk101, 'POST', body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ request_id: [c], hospital_id: 'H-101' }, { request_id: c, hospital_id: { $gt: '' } }, { request_id: c }]) {
    assert.equal((await call('/api/v1/referrals/initiate', T.medicA, 'POST', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/reject`, T.desk101, 'POST', { rejection_reason: 'x'.repeat(300) })).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${c}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);

  for (const path of ['/api/v1/emergencies?status=WAITING&status=NEW', '/api/v1/hospitals?status=OPEN&status=CLOSED',
    '/api/v1/analytics/audit?limit=5&limit=6', '/api/v1/analytics/history?days=7&days=8', '/api/v1/ambulances?status=AVAILABLE&status=MAINTENANCE',
    '/api/v1/analytics/audit?limit=1e3', '/api/v1/analytics/audit?limit=0', '/api/v1/emergencies?status=NOPE']) {
    const result = await call(path, T.admin);
    assert.equal(result.status, 400, path);
    assert.equal(result.body.success, false);
  }
  assert.equal((await call('/api/v1/ambulances/AMB-05/status', T.admin, 'PATCH', { status: 'MAINTENANCE', eta_mins: -1 })).status, 400);
  assert.equal((await call('/api/v1/ambulances/AMB-05/status', T.admin, 'PATCH', { status: 'MAINTENANCE', eta_mins: '5' })).status, 400);
  assert.equal((await call('/api/v1/ambulances/AMB-05/status', T.admin, 'PATCH', { status: ['MAINTENANCE'] })).status, 400);
  assert.equal((await call('/api/v1/doctors', T.admin, 'POST', { hospital_id: 'H-101', full_name: ['x'], specialization: 'CARDIOLOGIST' })).status, 400);
  assert.equal((await call('/api/v1/doctors/DR-001/shift', T.admin, 'PATCH', { shift_start: '25:00' })).status, 400);
  assert.equal((await call('/api/v1/doctors/DR-001/shift', T.admin, 'PATCH', {})).status, 400);
  assert.equal((await call('/api/v1/emergencies/REQ-8903/status', T.admin, 'PATCH', { status: 'cancelled' })).status, 400);
  assert.equal((await call('/api/v1/hospitals/H-101/status', T.admin, 'PATCH', { emergency_status: { $ne: 'x' } })).status, 400);
});

// ── Dispatch needs the case in the caller's scope (round 2, item 1) ──────────
test(`dispatching a unit to a case outside the caller's scope is a 404, exactly like a missing case [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  for (const unit of ['AMB-01', 'AMB-03']) assert.equal((await call(`/api/v1/ambulances/${unit}/status`, T.admin, 'PATCH', { status: 'AVAILABLE' })).status, 200);
  const adminCase = await createCase(T.admin, 'Fictional Admin Only Patient', 'GENERAL');
  const lock = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: adminCase, hospital_id: 'H-101' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, T.desk101, 'POST');
  assert.equal(accepted.status, 200);
  if (accepted.body.ambulance_id) {
    assert.equal((await call(`/api/v1/ambulances/${accepted.body.ambulance_id}/status`, T.admin, 'PATCH', { status: 'AVAILABLE' })).status, 200);
  }
  const dispatch = (token, unit, requestId) => call(`/api/v1/ambulances/${unit}/status`, token, 'PATCH', { status: 'DISPATCHED', request_id: requestId });

  // A paramedic's own unit, to a case they cannot see: refused, and indistinguishable from a request id that does not exist.
  const hidden = await dispatch(T.medicA, 'AMB-01', adminCase);
  const missing = await dispatch(T.medicA, 'AMB-01', 'REQ-0000');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body);
  assert.equal((await call(`/api/v1/emergencies/${adminCase}`, T.medicA)).status, 404, 'the case stays invisible');
  assert.equal((await call(`/api/v1/emergencies/${adminCase}/audit`, T.medicA)).status, 404);
  // A desk's unit, to a case accepted by another hospital: refused the same way.
  const otherDesk = await dispatch(T.desk102, 'AMB-03', adminCase);
  assert.equal(otherDesk.status, 404);
  assert.deepEqual(otherDesk.body, (await dispatch(T.desk102, 'AMB-03', 'REQ-0000')).body);
  // The accepting hospital's desk may dispatch its own unit to it.
  assert.equal((await dispatch(T.desk101, 'AMB-01', adminCase)).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${adminCase}/status`, T.admin, 'PATCH', { status: 'COMPLETED' })).status, 200);
});

// ── Account changes apply at once (round 2, item 5): MySQL, where the test can change the account row ──
if (BACKEND === 'mysql') {
test(`a deactivated account is refused at once on REST and its live socket is cut; a scope change moves the socket [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const sql = (q, p = []) => database.admin.query(q, p);
  await sql(`INSERT INTO SystemUser (user_id, username, password_hash, role, hospital_id, display_name, is_active, is_demo)
             VALUES ('USER-R2-DESK', 'fictional.r2.desk', ?, 'HOSPITAL_DESK', 'H-101', 'Fictional R2 Desk', 1, 0)`, [DEMO_USERS[0].password_hash]);
  const token = jwt.sign({ user_id: 'USER-R2-DESK', username: 'fictional.r2.desk', role: 'HOSPITAL_DESK', hospital_id: 'H-101', ambulance_id: null },
    SECRET, { algorithm: 'HS256', issuer: 'eris-api', audience: 'eris-console', expiresIn: 600 });
  assert.equal((await call('/api/v1/auth/me', token)).body.user.hospital_id, 'H-101');

  // Scope change: the token still says H-101; REST and the live socket follow the row (H-102).
  const socket = await connectSocket(BASE, token);
  assert.ok(await socket.waitFor(x => x.has('system:snapshot')));
  await sql("UPDATE SystemUser SET hospital_id = 'H-102' WHERE user_id = 'USER-R2-DESK'");
  assert.equal((await call('/api/v1/auth/me', token)).body.user.hospital_id, 'H-102');
  await socket.waitFor(() => false, 2500); // > SOCKET_RECHECK_MS
  const c = await createCase(T.admin, 'Fictional Rescope Patient', 'GENERAL');
  const lock = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: c, hospital_id: 'H-102' });
  assert.equal(lock.status, 201);
  assert.ok(await socket.waitFor(x => x.events.some(e => e.name === 'referral:incoming' && e.payload.acceptance_id === lock.body.acceptance_id)),
    'the socket was moved to hospital:H-102');
  const c2 = await createCase(T.admin, 'Fictional Old Room Patient', 'GENERAL');
  const lock2 = await call('/api/v1/referrals/initiate', T.admin, 'POST', { request_id: c2, hospital_id: 'H-101' });
  assert.equal(lock2.status, 201);
  await socket.waitFor(() => false, 800);
  assert.ok(!socket.events.some(e => e.name === 'referral:incoming' && e.payload.acceptance_id === lock2.body.acceptance_id), 'and left hospital:H-101');

  // Deactivation: REST refuses at once, the live socket is disconnected at the next re-check, a new handshake fails.
  await sql("UPDATE SystemUser SET is_active = 0 WHERE user_id = 'USER-R2-DESK'");
  assert.equal((await call('/api/v1/auth/me', token)).status, 401);
  assert.equal((await call('/api/v1/emergencies', token)).status, 401);
  assert.ok(await socket.waitFor(x => x.disconnected, 6000), 'the live socket of a deactivated account is cut');
  assert.equal((await connectSocket(BASE, token)).connected, false);
  for (const id of [c, c2]) assert.equal((await call(`/api/v1/emergencies/${id}/status`, T.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
});
}

// ── Memory-only: login rate limit and production refusals ──
// Store-independent, so registered for the memory run only (the MySQL production login is in user_create_mysql).
if (BACKEND === 'memory') {
test(`login rate limit is keyed by username + client address, and X-Forwarded-For is ignored unless TRUST_PROXY is set [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  // Batch 8: lockout after 5 failed attempts (LOGIN_RATE_LIMIT default 5): the 6th for that username gets 429.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('/api/v1/auth/login', null, 'POST', { username: 'limit-probe', password: 'wrong-password' }, { 'X-Forwarded-For': `10.0.0.${i}` })).status, 401);
  }
  const blocked = await call('/api/v1/auth/login', null, 'POST', { username: 'limit-probe', password: 'wrong-password' }, { 'X-Forwarded-For': '10.9.9.9' });
  assert.equal(blocked.status, 429, 'the 6th attempt is locked out; a spoofed X-Forwarded-For does not reset the limit');
  assert.equal((await login('limit-probe', 'wrong-password')).status, 429, 'and stays locked out');
  // Round 2 item 2: the bucket is the username as the lookup sees it (trimmed), so padding does not open a new one.
  for (const padded of ['limit-probe ', ' limit-probe', '\tlimit-probe\n', 'limit-probe\r\n']) {
    assert.equal((await call('/api/v1/auth/login', null, 'POST', { username: padded, password: 'wrong-password' })).status, 429, JSON.stringify(padded));
  }
  assert.equal(blocked.body.success, false);
  assert.equal((await login('apex_desk', 'wrong-password')).status, 401, 'another username from the same address is not blocked');
  assert.equal((await login('apex_desk', 'hospital123')).status, 200);
});

test(`per-address ceiling counts only wrong credentials; TRUST_PROXY=true and a junk SOCKET_RECHECK_MS are refused at start-up [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const port = 4254;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(port), DB_USE_MEMORY: 'true', SIMULATED_TRANSPORT: 'off', JWT_SECRET: SECRET, LOGIN_IP_RATE_LIMIT: '5', LOGIN_RATE_LIMIT: '2'
  };
  delete env.TRUST_PROXY;
  const limited = startServer(port, env);
  try {
    await waitHealthy(limited.proc, base, limited.log);
    // Round 3 item 1: only wrong credentials (401) feed the per-address ceiling. The per-username limiter's 429s,
    // validation 400s and successes do not, so one user's retries cannot lock out everyone behind the same address.
    for (let i = 0; i < 2; i += 1) assert.equal((await login('retrying-user', 'wrong-password', base)).status, 401);
    for (let i = 0; i < 4; i += 1) assert.equal((await login('retrying-user', 'wrong-password', base)).status, 429, 'per-username limit');
    // (Two only: the per-username limiter, at 2 here, also buckets malformed bodies under the empty username.)
    for (let i = 0; i < 2; i += 1) assert.equal((await call('/api/v1/auth/login', null, 'POST', { username: ['x'], password: 'y' }, {}, base)).status, 400);
    assert.equal((await login('apex_desk', 'hospital123', base)).status, 200, 'another user behind the same address still signs in');
    for (let i = 0; i < 3; i += 1) assert.equal((await login(`spray-${i}`, 'wrong-password', base)).status, 401);
    // Five 401s now: the ceiling is reached for every username from this address.
    assert.equal((await login('spray-new', 'wrong-password', base)).status, 429, 'a new username from the same address is limited');
  } finally {
    await stop(limited.proc);
  }
  for (const value of ['true', 'not-an-address']) {
    const bad = startServer(port, { ...env, TRUST_PROXY: value });
    assert.equal(await exitCodeWithin(bad.proc), 1, value);
    assert.match(bad.log.text, /TRUST_PROXY/);
  }
  // Round 3 item 2: a junk, zero or too small re-check interval stops start-up (it would otherwise spin every 1 ms).
  for (const value of ['0', 'abc', '999', '1e4', '-5', '2147483648', '3000000000']) {
    const bad = startServer(port, { ...env, SOCKET_RECHECK_MS: value });
    assert.equal(await exitCodeWithin(bad.proc), 1, value);
    assert.match(bad.log.text, /SOCKET_RECHECK_MS must be a whole number/);
  }
});

test(`production: a store without an active non-demo account refuses to start; a weak or placeholder JWT_SECRET stops start-up [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const port = 4254;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(port), NODE_ENV: 'production', DB_USE_MEMORY: 'true', JWT_SECRET: 'production-test-secret-0123456789-abcdef'
  };
  // The in-memory store only has demo accounts, which production refuses: nobody could sign in, so it does not start.
  const prod = startServer(port, env);
  assert.equal(await exitCodeWithin(prod.proc), 1);
  assert.match(prod.log.text, /no active non-demo ADMIN account.*Refusing to start/s);
  for (const [secret, message] of [['replace-with-a-long-random-string', /placeholder/], ['short-secret', /at least 32 characters/], ['', /must be set/]]) {
    const bad = startServer(port, { ...env, JWT_SECRET: secret });
    assert.equal(await exitCodeWithin(bad.proc), 1);
    assert.match(bad.log.text, message);
  }
});
}
