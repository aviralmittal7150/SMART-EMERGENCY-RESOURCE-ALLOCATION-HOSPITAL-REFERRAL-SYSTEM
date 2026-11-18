// Batch 3, review round 2, in process on the in-memory store: accounts are loaded on every request and socket check
// (item 5), the dummy login hash has the real cost (item 6), TRUST_PROXY parsing (item 10), dispatch scope (item 1).
// The HTTP / socket behaviour on both stores is in tests/security_scoping.test.js. Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../server/db/seed.js';
import { memoryTokenFor } from './helpers/testUsers.js';
import authRoutes from '../server/routes/auth.js';
import emergenciesRoutes from '../server/routes/emergencies.js';
import { refreshSocketAccount } from '../server/services/socketAccounts.js';
import { dispatchScope } from '../server/services/accessPolicy.js';
import { BCRYPT_COST, dummyHash } from '../server/services/passwords.js';
import { BCRYPT_COST as CLI_COST } from '../scripts/user-create.js';
import { parseTrustProxy } from '../server/services/trustProxy.js';
import { parseRecheckInterval } from '../server/services/socketAccounts.js';
import { MemoryStore } from '../server/db/memoryStore.js';

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/emergencies', emergenciesRoutes);
let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const call = async (path, token) => {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
};
const account = id => db.systemUsers.find(u => u.user_id === id);

test('every request loads the account: deactivation and scope changes apply at once, not at token expiry', async () => {
  const token = memoryTokenFor(db, { user_id: 'U-R2-DESK', role: 'HOSPITAL_DESK', hospital_id: 'H-101' });
  assert.equal((await call('/api/v1/auth/me', token)).body.user.hospital_id, 'H-101');

  account('U-R2-DESK').hospital_id = 'H-102'; // the token still says H-101
  assert.equal((await call('/api/v1/auth/me', token)).body.user.hospital_id, 'H-102', 'scope comes from the account row');

  account('U-R2-DESK').role = 'ADMIN';
  account('U-R2-DESK').hospital_id = null;
  assert.equal((await call('/api/v1/auth/me', token)).body.user.role, 'ADMIN');
  account('U-R2-DESK').role = 'HOSPITAL_DESK';
  account('U-R2-DESK').hospital_id = 'H-101';

  account('U-R2-DESK').is_active = 0;
  for (const path of ['/api/v1/auth/me', '/api/v1/emergencies']) {
    const refused = await call(path, token);
    assert.equal(refused.status, 401, `${path}: a deactivated account is refused`);
  }
  account('U-R2-DESK').is_active = 1;
  assert.equal((await call('/api/v1/emergencies', token)).status, 200);

  db.systemUsers.splice(db.systemUsers.indexOf(account('U-R2-DESK')), 1);
  assert.equal((await call('/api/v1/auth/me', token)).status, 401, 'a deleted account is refused');

  // A demo account is refused on every request when NODE_ENV=production, not only at login.
  const demo = memoryTokenFor(db, { user_id: 'U-R2-DEMO', role: 'ADMIN', is_demo: 1 });
  assert.equal((await call('/api/v1/auth/me', demo)).status, 200);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await call('/api/v1/auth/me', demo)).status, 401);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
  }
});

test('live sockets: a deactivated account is disconnected, a changed scope moves rooms, a store outage changes nothing', async () => {
  memoryTokenFor(db, { user_id: 'U-R2-SOCK', role: 'HOSPITAL_DESK', hospital_id: 'H-101' });
  const fake = () => {
    const socket = { id: 's1', rooms: new Set(['user:U-R2-SOCK', 'staff', 'hospital:H-101']), disconnected: false,
      user: { user_id: 'U-R2-SOCK', role: 'HOSPITAL_DESK', hospital_id: 'H-101', ambulance_id: null, exp: 1e12 } };
    socket.join = room => socket.rooms.add(room);
    socket.leave = room => socket.rooms.delete(room);
    socket.disconnect = () => { socket.disconnected = true; };
    return socket;
  };
  const quiet = { log() {}, error() {} };

  const s = fake();
  assert.equal(await refreshSocketAccount(s, { log: quiet }), 'unchanged');
  account('U-R2-SOCK').hospital_id = 'H-103';
  assert.equal(await refreshSocketAccount(s, { log: quiet }), 'rescoped');
  assert.deepEqual([...s.rooms].sort(), ['hospital:H-103', 'staff', 'user:U-R2-SOCK']);
  assert.equal(s.user.hospital_id, 'H-103');
  assert.equal(s.user.exp, 1e12, 'the token expiry is kept');

  account('U-R2-SOCK').role = 'ADMIN';
  account('U-R2-SOCK').hospital_id = null;
  assert.equal(await refreshSocketAccount(s, { log: quiet }), 'rescoped');
  assert.deepEqual([...s.rooms].sort(), ['admin', 'command_center', 'staff', 'user:U-R2-SOCK']);

  const failing = fake();
  assert.equal(await refreshSocketAccount(failing, { log: quiet, load: async () => { throw new Error('store down'); } }), 'error');
  assert.equal(failing.disconnected, false);

  account('U-R2-SOCK').is_active = 0;
  assert.equal(await refreshSocketAccount(s, { log: quiet }), 'disconnected');
  assert.equal(s.disconnected, true);
});

test('the dummy login hash uses the same bcrypt cost as real account hashes', async () => {
  assert.equal(CLI_COST, BCRYPT_COST);
  assert.ok(BCRYPT_COST >= 12);
  const hash = await dummyHash();
  assert.equal(bcrypt.getRounds(hash), BCRYPT_COST);
  assert.equal(await dummyHash(), hash, 'computed once');
  const source = fs.readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');
  assert.ok(!/\$2[aby]\$\d\d\$/.test(source), 'no hardcoded hash in the login route');
});

test('TRUST_PROXY: true and junk are refused; hop counts and explicit subnets are accepted', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('10.0.0.0/8, 192.168.1.10, loopback, ::1'), ['10.0.0.0/8', '192.168.1.10', 'loopback', '::1']);
  for (const bad of ['true', 'TRUE', 'yes-please', '10.0.0.0/33', '10.0.0.1/8/2', 'example.com', ',']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
  }
});

test('dispatch scope: admins any case, a desk only cases ACCEPTED by its own hospital, a paramedic their case scope', () => {
  assert.deepEqual(dispatchScope({ role: 'ADMIN', user_id: 'a' }), { kind: 'all' });
  assert.deepEqual(dispatchScope({ role: 'HOSPITAL_DESK', user_id: 'd', hospital_id: 'H-101' }), { kind: 'hospital', hospitalId: 'H-101', statuses: ['ACCEPTED'] });
  assert.deepEqual(dispatchScope({ role: 'PARAMEDIC', user_id: 'p', ambulance_id: 'AMB-01' }), { kind: 'user', userId: 'p', ambulanceId: 'AMB-01' });
});

test('SOCKET_RECHECK_MS: unset is 60 s; only whole milliseconds >= 1000 are accepted (round 3, item 2)', () => {
  assert.equal(parseRecheckInterval(undefined), 60_000);
  assert.equal(parseRecheckInterval(''), 60_000);
  assert.equal(parseRecheckInterval('1000'), 1000);
  assert.equal(parseRecheckInterval('2147483647'), 2147483647, 'the largest timer delay Node accepts');
  for (const bad of ['0', 'NaN', 'abc', '999', '1e4', '-5', '1.5', '10s', '2147483648', '3000000000', '99999999999999999999']) assert.throws(() => parseRecheckInterval(bad), /SOCKET_RECHECK_MS/, bad);
});

test('countUsableAdmins counts only usable, non-demo ADMIN accounts: patients, desks or demo admins are not enough (Batch 6 round 2)', async () => {
  const store = users => new MemoryStore({ db: { systemUsers: users, on() {} } });
  const row = extra => ({ user_id: 'U', username: 'u', role: 'ADMIN', hospital_id: null, is_active: 1, is_demo: 0, ...extra });
  assert.equal(await store([row({ role: 'HOSPITAL_DESK', hospital_id: 'H-101' }), row({ role: 'PATIENT', patient_id: 'PAT-001' }),
    row({ role: 'DISPATCHER' }), row({ role: 'PARAMEDIC' })]).countUsableAdmins(), 0, 'staff and patients cannot administer');
  assert.equal(await store([row({ is_demo: 1 }), row({ is_active: 0 }), row({ patient_id: 'PAT-001' })]).countUsableAdmins(), 0);
  assert.equal(await store([row({}), row({ role: 'PARAMEDIC' })]).countUsableAdmins(), 1);
});

test('a PATIENT account may not carry a hospital or a unit', async () => {
  const { accountShapeProblem } = await import('../server/services/accounts.js');
  assert.match(accountShapeProblem({ role: 'PATIENT', patient_id: 'PAT-1', hospital_id: 'H-101' }), /cannot be linked/);
  assert.match(accountShapeProblem({ role: 'PATIENT', patient_id: 'PAT-1', ambulance_id: 'AMB-01' }), /cannot be linked/);
  assert.equal(accountShapeProblem({ role: 'PATIENT', patient_id: 'PAT-1' }), null);
});

test('the session bump is decided by the store against the STORED row, not a stale caller view (Batch 6 round 3)', async () => {
  const users = [{ user_id: 'U-RACE', username: 'race', role: 'DISPATCHER', hospital_id: null, ambulance_id: null, patient_id: null,
    is_active: 1, is_demo: 0, token_version: 1 }];
  const store = new MemoryStore({ db: { systemUsers: users, on() {}, auditLog() {} } });
  const admin = { role: 'ADMIN', id: 'U-ADMIN' };
  // The route read role PARAMEDIC, another admin has since made it DISPATCHER; the route now writes PARAMEDIC back.
  await store.updateUser('U-RACE', { role: 'PARAMEDIC' }, admin);
  assert.deepEqual([users[0].role, users[0].token_version], ['PARAMEDIC', 2], 'a real change against the stored row ends the sessions');
  await store.updateUser('U-RACE', { role: 'PARAMEDIC', display_name: 'Same role' }, admin);
  assert.equal(users[0].token_version, 2, 'no change of role or link: no bump');
  await store.updateUser('U-RACE', { ambulance_id: 'AMB-02' }, admin);
  assert.equal(users[0].token_version, 3, 'a link change');
  await store.updateUser('U-RACE', { is_active: 0 }, admin);
  assert.equal(users[0].token_version, 4, 'a deactivation');
  await store.updateUser('U-RACE', { is_active: 1 }, admin);
  assert.equal(users[0].token_version, 4, 'a re-activation alone does not need a bump (old tokens are already dead)');
});

test('my-registrations means are reported only from 20 observations (S6-2); per-case minutes always (Batch 6 round 4)', async () => {
  const { registrationReport } = await import('../server/services/registrationReport.js');
  const t0 = Date.UTC(2026, 10, 1);
  const raw = n => ({
    requests: Array.from({ length: n }, (_, i) => ({ request_id: `REQ-${1000 + i}`, patient_id: `PAT-${i}`, full_name: 'Fictional', age: 30,
      gender: 'UNKNOWN', emergency_type: 'GENERAL', priority: 3, status: 'ALLOCATED', registered_ms: t0 + i * 1000 })),
    events: Array.from({ length: n }, (_, i) => ({ request_id: `REQ-${1000 + i}`, event_type: 'ALLOCATION_COMMITTED', new_state: 'ALLOCATED',
      hospital_id: 'H-1', metadata: { ambulance_id: null }, ms: t0 + i * 1000 + 6 * 60_000, history_id: i + 1 })),
    hospitals: [{ hospital_id: 'H-1', hospital_name: 'Fictional Hospital' }]
  });
  const window = { fromMs: t0 - 1, toMs: t0 + 86_400_000 };
  const below = registrationReport(raw(19), window, 500).summary;
  assert.deepEqual([below.avg_minutes_to_acceptance, below.sample_size.acceptance, below.minimum_sample], [null, 19, 20]);
  const at = registrationReport(raw(20), window, 500);
  assert.deepEqual([at.summary.avg_minutes_to_acceptance, at.summary.sample_size.acceptance], [6, 20]);
  assert.equal(at.summary.avg_minutes_to_dispatch, null, 'no dispatch happened: no mean, sample 0');
  assert.equal(at.summary.sample_size.dispatch, 0);
  assert.equal(at.cases[0].minutes_to_acceptance, 6, 'per-case minutes always');
  assert.equal(at.cases[0].request_id, 'REQ-1019', 'newest first');
});

test('the in-memory seed has no demo cases or demo history when NODE_ENV=production; outside production it has them', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = env => JSON.parse(execFileSync(process.execPath, ['-e', `import('./server/db/seed.js').then(({ db: d }) => console.log(JSON.stringify({
    cases: d.emergencyRequests.length, patients: d.patients.length, referrals: d.hospitalAcceptances.length, allocations: d.resourceAllocations.length,
    assignments: d.doctorAssignments.length, audit: d.emergencyHistory.length, claims: d.requestClaims.length,
    surgeon: d.doctors.find(x => x.doctor_id === 'DR-013').availability_status, unit: d.ambulances.find(a => a.ambulance_id === 'AMB-02').assigned_request_id ?? null,
    unitStatus: d.ambulances.find(a => a.ambulance_id === 'AMB-02').status,
    updated: d.emergencyRequests.every(r => typeof r.updated_at === 'string') })))`],
  { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' }));
  assert.deepEqual(probe({ NODE_ENV: 'production' }),
    { cases: 0, patients: 0, referrals: 0, allocations: 0, assignments: 0, audit: 0, claims: 0, surgeon: 'AVAILABLE', unit: null, unitStatus: 'AVAILABLE', updated: true });
  assert.deepEqual(probe({ NODE_ENV: 'development' }),
    { cases: 3, patients: 3, referrals: 2, allocations: 4, assignments: 1, audit: 9, claims: 7, surgeon: 'IN_PROCEDURE', unit: 'REQ-8901', unitStatus: 'IN_TRANSIT', updated: true });
});
