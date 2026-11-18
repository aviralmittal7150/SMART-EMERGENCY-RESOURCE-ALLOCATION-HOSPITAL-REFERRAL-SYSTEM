// Batch 3 (security and API) in-process tests: token rules (X9), the one scoping policy (X5), strict validation (X7),
// hashed demo accounts (X2), bounded request-id generation (X8) and initiated_by inheritance on failover in the
// in-memory engine (B1-R1). The HTTP and socket behaviour on both backends is in tests/security_scoping.test.js.
// All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  verifyToken, generateToken, getJwtSecret, getJwtExpires, assertAuthConfig, JWT_SECRET_PLACEHOLDER
} from '../server/middleware/auth.js';
import * as policy from '../server/services/accessPolicy.js';
import { validateFields, ValidationError } from '../server/services/validation.js';
import { DEMO_USERS } from '../server/db/demoUsers.js';
import { db } from '../server/db/seed.js';
import { MemoryStore } from '../server/db/memoryStore.js';
import { lockingEngine } from '../server/services/lockingEngine.js';
import { candidateRequestId, MAX_REQUEST_ID_ATTEMPTS, RequestIdExhaustedError } from '../server/services/requestIds.js';

const SECRET = 'unit-test-secret-that-is-long-enough-1234';
process.env.JWT_SECRET = SECRET;
delete process.env.JWT_EXPIRES;
delete process.env.JWT_ISSUER;
delete process.env.JWT_AUDIENCE;

const ADMIN = { user_id: 'U-A', username: 'a', role: 'ADMIN', hospital_id: null };
const DESK = { user_id: 'U-D', username: 'd', role: 'HOSPITAL_DESK', hospital_id: 'H-101' };
const MEDIC = { user_id: 'U-P', username: 'p', role: 'PARAMEDIC', hospital_id: null, ambulance_id: 'AMB-01' };

// ── JWT (X9) ─────────────────────────────────────────────────────────────────
test('tokens are HS256 with issuer and audience, and verify', () => {
  const token = generateToken(MEDIC);
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
  assert.equal(header.alg, 'HS256');
  const claims = verifyToken(token);
  assert.deepEqual([claims.iss, claims.aud, claims.sub, claims.ambulance_id], ['eris-api', 'eris-console', 'U-P', 'AMB-01']);
  assert.equal(claims.exp - claims.iat, 8 * 3600, 'JWT_EXPIRES default 8h');
});

test('verification refuses alg none, another algorithm, a wrong secret, issuer or audience, expiry and bad claims', () => {
  const now = Math.floor(Date.now() / 1000);
  const good = { user_id: 'X', role: 'ADMIN', iss: 'eris-api', aud: 'eris-console', iat: now, exp: now + 600 };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const forged = [
    ['alg none', `${b64({ alg: 'none', typ: 'JWT' })}.${b64(good)}.`],
    ['HS512 with the right secret', jwt.sign(good, SECRET, { algorithm: 'HS512' })],
    ['HS384 with the right secret', jwt.sign(good, SECRET, { algorithm: 'HS384' })],
    ['wrong secret', jwt.sign(good, 'another-secret-another-secret-another', { algorithm: 'HS256' })],
    ['wrong issuer', jwt.sign({ ...good, iss: 'someone-else' }, SECRET, { algorithm: 'HS256' })],
    ['wrong audience', jwt.sign({ ...good, aud: 'other-app' }, SECRET, { algorithm: 'HS256' })],
    ['no issuer/audience', jwt.sign({ user_id: 'X', role: 'ADMIN', exp: now + 600 }, SECRET, { algorithm: 'HS256' })],
    ['expired', jwt.sign({ ...good, iat: now - 100, exp: now - 10 }, SECRET, { algorithm: 'HS256' })],
    ['no expiry', jwt.sign({ user_id: 'X', role: 'ADMIN', iss: 'eris-api', aud: 'eris-console' }, SECRET, { algorithm: 'HS256' })],
    ['unknown role', jwt.sign({ ...good, role: 'ROOT' }, SECRET, { algorithm: 'HS256' })],
    ['desk without hospital', jwt.sign({ ...good, role: 'HOSPITAL_DESK', hospital_id: null }, SECRET, { algorithm: 'HS256' })]
  ];
  for (const [name, token] of forged) assert.throws(() => verifyToken(token), `${name} must be refused`);
  assert.equal(verifyToken(jwt.sign(good, SECRET, { algorithm: 'HS256' })).user_id, 'X', 'the control token verifies');
});

test('JWT_SECRET rules: production requires >= 32 characters and not the .env.example placeholder; no hardcoded fallback', () => {
  const prod = extra => ({ NODE_ENV: 'production', ...extra });
  assert.throws(() => getJwtSecret(prod({})), /must be set/);
  assert.throws(() => getJwtSecret(prod({ JWT_SECRET: JWT_SECRET_PLACEHOLDER })), /placeholder/);
  assert.throws(() => getJwtSecret(prod({ JWT_SECRET: 'x'.repeat(31) })), /at least 32/);
  assert.equal(getJwtSecret(prod({ JWT_SECRET: 'y'.repeat(32) })), 'y'.repeat(32));
  // Development without a secret: a random per-process value, never a constant from the source.
  const dev = getJwtSecret({ NODE_ENV: 'development' });
  assert.match(dev, /^[0-9a-f]{64}$/);
  const source = fs.readFileSync(new URL('../server/middleware/auth.js', import.meta.url), 'utf8');
  assert.ok(!source.includes(dev));
  assert.equal(JWT_SECRET_PLACEHOLDER, fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8').match(/^JWT_SECRET=(.*)$/m)[1]);
});

test('JWT_EXPIRES: a bare number is seconds, a span is passed through, an invalid value stops start-up', () => {
  assert.equal(getJwtExpires({ JWT_EXPIRES: '3600' }), 3600);
  assert.equal(getJwtExpires({ JWT_EXPIRES: '2h' }), '2h');
  assert.equal(getJwtExpires({}), '8h');
  assert.throws(() => assertAuthConfig({ JWT_SECRET: SECRET, JWT_EXPIRES: 'soon' }), /JWT_EXPIRES is invalid/);
  assert.doesNotThrow(() => assertAuthConfig({ JWT_SECRET: SECRET, JWT_EXPIRES: '90' }));
  assert.throws(() => assertAuthConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' }), /at least 32/);
});

// ── Scoping policy (X5) ──────────────────────────────────────────────────────
test('the scoping policy: one table for every role', () => {
  assert.deepEqual(policy.caseScope(ADMIN), { kind: 'all' });
  assert.deepEqual(policy.caseScope(DESK), { kind: 'hospital', hospitalId: 'H-101' });
  assert.deepEqual(policy.caseScope(MEDIC), { kind: 'user', userId: 'U-P', ambulanceId: 'AMB-01' });
  assert.deepEqual(policy.caseScope({ role: 'ROOT', user_id: 'x' }), { kind: 'none' }, 'anything unexpected fails closed');
  assert.deepEqual(policy.caseScope({ role: 'HOSPITAL_DESK', user_id: 'x' }), { kind: 'none' });

  assert.equal(policy.canManageHospital(ADMIN, 'H-105'), true);
  assert.equal(policy.canManageHospital(DESK, 'H-101'), true);
  assert.equal(policy.canManageHospital(DESK, 'H-102'), false);
  assert.equal(policy.canManageHospital(MEDIC, 'H-101'), false);

  assert.deepEqual(policy.doctorFilter(ADMIN, 'H-103'), { hospitalId: 'H-103' });
  assert.deepEqual(policy.doctorFilter(DESK, 'H-103'), { hospitalId: 'H-101' }, 'a desk cannot ask for another roster');
  assert.equal(policy.doctorFilter(MEDIC), null);

  assert.deepEqual(policy.ambulanceFilter(DESK), { hospitalId: 'H-101' });
  assert.deepEqual(policy.ambulanceFilter(MEDIC, 'H-105'), { ambulanceId: 'AMB-01' });
  assert.equal(policy.ambulanceFilter({ ...MEDIC, ambulance_id: null }), null);
  const unit = { ambulance_id: 'AMB-03', hospital_id: 'H-102' };
  assert.deepEqual([ADMIN, DESK, MEDIC, { ...DESK, hospital_id: 'H-102' }, { ...MEDIC, ambulance_id: 'AMB-03' }].map(u => policy.canAccessAmbulance(u, unit)),
    [true, false, false, true, true]);

  assert.deepEqual(policy.referralFilter(ADMIN), {});
  assert.deepEqual(policy.referralFilter(DESK), { hospitalId: 'H-101' });
  assert.deepEqual(policy.referralFilter(MEDIC), { initiatedBy: 'U-P' });
  assert.equal(policy.canDecideReferral(DESK, { hospital_id: 'H-102' }), false);
  assert.equal(policy.canDecideReferral(MEDIC, { hospital_id: 'H-101' }), false);

  const locks = [{ hospitalId: 'H-101' }, { hospitalId: 'H-102' }];
  assert.equal(policy.visibleLocks(ADMIN, locks).length, 2);
  assert.deepEqual(policy.visibleLocks(DESK, locks), [{ hospitalId: 'H-101' }]);
  assert.equal(policy.visibleLocks(MEDIC, locks), null);

  assert.deepEqual(policy.socketRooms(ADMIN), ['user:U-A', 'staff', 'command_center', 'admin']);
  assert.deepEqual(policy.socketRooms(DESK), ['user:U-D', 'staff', 'hospital:H-101']);
  assert.deepEqual(policy.socketRooms(MEDIC), ['user:U-P', 'staff', 'ambulance:AMB-01'], 'a paramedic: its unit\'s trips (Batch 7)');
  assert.deepEqual(policy.socketRooms({ ...MEDIC, ambulance_id: null }), ['user:U-P', 'staff']);
  assert.deepEqual(policy.socketRooms({ user_id: 'U-O', role: 'DISPATCHER' }), ['user:U-O', 'staff', 'command_center']);
  assert.deepEqual(policy.socketRooms({ user_id: 'U-PT', role: 'PATIENT', patient_id: 'PAT-1' }), ['user:U-PT'], 'a patient: own room only');
});

test('every route file and the socket handlers take their scoping from accessPolicy (no local role checks on hospital ids)', () => {
  const dir = new URL('../server/routes/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!/req\.user\.hospital_id\s*[!=]==/.test(source), `${file} compares hospital ids itself`);
  }
  const server = fs.readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  assert.match(server, /socketRooms\(socket\.user\)/);
  assert.match(server, /visibleLocks\(socket\.user/);
});

// ── Validation (X7) ──────────────────────────────────────────────────────────
test('validation refuses wrong types, missing fields, out-of-range integers, unknown enums and long strings', () => {
  const schema = {
    name: { type: 'string', required: true, maxLength: 5 },
    age: { type: 'integer', required: true, min: 0, max: 130 },
    kind: { type: 'enum', values: ['A', 'B'], upper: true },
    lat: { type: 'number', min: -90, max: 90, nullable: true }
  };
  const ok = validateFields({ name: ' Ann ', age: 0, kind: 'b', lat: null, extra: { ignored: true } }, schema);
  assert.deepEqual(ok, { name: 'Ann', age: 0, kind: 'B', lat: null });
  const bad = [
    { name: { a: 1 }, age: 1 }, { name: ['x'], age: 1 }, { name: 'x', age: '' }, { name: 'x', age: '5' }, { name: 'x', age: 1.5 },
    { name: 'x', age: true }, { name: 'x', age: 131 }, { name: 'x', age: -1 }, { name: 'x' }, { age: 3 }, { name: '   ', age: 3 },
    { name: 'toolong', age: 3 }, { name: 'x', age: 3, kind: 'C' }, { name: 'x', age: 3, kind: 7 }, { name: 'x', age: 3, lat: 91 },
    { name: 'x', age: 3, lat: '10' }, { name: null, age: 3 }
  ];
  for (const input of bad) assert.throws(() => validateFields(input, schema), ValidationError, JSON.stringify(input));
  assert.throws(() => validateFields([1, 2], schema), /JSON object/);
  // Query strings: digits only for integers.
  const q = { limit: { type: 'integer', min: 1, max: 1000 } };
  assert.deepEqual(validateFields({ limit: '300' }, q, { inQuery: true }), { limit: 300 });
  for (const value of ['1e3', '-1', '', '0', '1001', ' 5']) assert.throws(() => validateFields({ limit: value }, q, { inQuery: true }), ValidationError, value);
});

// ── Accounts (X2) ────────────────────────────────────────────────────────────
const DEMO_PASSWORDS = ['admin123', 'hospital123', 'paramedic123']; // the documented, fictional demo passwords

test('demo accounts are stored as bcrypt hashes (cost >= 10) only, flagged demo, and each paramedic crews a unit', async () => {
  for (const user of [...DEMO_USERS, ...db.systemUsers]) {
    assert.match(user.password_hash, /^\$2[aby]\$(\d\d)\$[./A-Za-z0-9]{53}$/);
    assert.ok(Number(user.password_hash.slice(4, 6)) >= 10, 'bcrypt cost >= 10');
    assert.equal(user.is_demo, 1);
    assert.ok(!('password' in user), 'no plaintext field');
    for (const value of Object.values(user)) assert.ok(!DEMO_PASSWORDS.includes(value), 'no plaintext value');
  }
  const expected = { admin: 'admin123', apex_desk: 'hospital123', 'UNIT-402': 'paramedic123' };
  for (const [username, password] of Object.entries(expected)) {
    assert.equal(await bcrypt.compare(password, DEMO_USERS.find(u => u.username === username).password_hash), true);
  }
  assert.deepEqual(DEMO_USERS.filter(u => u.role === 'PARAMEDIC').map(u => [u.username, u.ambulance_id]), [['UNIT-402', 'AMB-01'], ['UNIT-601', 'AMB-04']]);
});

test('no demo password appears in plaintext anywhere in the server source', () => {
  const files = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full); else if (/\.(js|sql)$/.test(e.name)) files.push(full);
  });
  walk(new URL('../server', import.meta.url).pathname);
  walk(new URL('../scripts', import.meta.url).pathname);
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const password of DEMO_PASSWORDS) assert.ok(!text.includes(password), `${file} contains a demo password`);
  }
  assert.ok(!/u\.password\s*===|password\s*===\s*password/.test(fs.readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8')),
    'login never compares plaintext');
});

// ── Request ids (X8) ─────────────────────────────────────────────────────────
test('memory request ids: the four-digit space can be exhausted without hanging, and the loop is bounded', async () => {
  const store = new MemoryStore();
  const saved = db.emergencyRequests;
  const fill = [];
  for (let n = 1000; n <= 9999; n += 1) fill.push({ request_id: `REQ-${n}`, status: 'COMPLETED', priority: 5 });
  db.emergencyRequests = [...saved, ...fill];
  const actor = { role: 'ADMIN', id: 'U-A' };
  const input = {
    patient: { full_name: 'Fictional Id Patient', age: 30, gender: 'UNKNOWN', emergency_type: 'GENERAL', triage_priority: 5, contact_phone: null },
    request: { emergency_type: 'GENERAL', required_resource_types: [], required_specialist: null, priority: 5, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
  };
  const random = Math.random;
  try {
    const created = await store.createRequest(input, actor);
    assert.match(created.request_id, /^REQ-\d{6}$/, 'after the 4-digit space is exhausted the id widens');

    // Every candidate collides: the store gives up after MAX_REQUEST_ID_ATTEMPTS instead of looping forever.
    Math.random = () => 0;
    db.emergencyRequests.push({ request_id: candidateRequestId(MAX_REQUEST_ID_ATTEMPTS - 1, () => 0), status: 'COMPLETED', priority: 5 });
    const started = Date.now();
    await assert.rejects(store.createRequest(input, actor), RequestIdExhaustedError);
    assert.ok(Date.now() - started < 1000);
  } finally {
    Math.random = random;
    db.emergencyRequests = saved;
  }
  assert.equal(MAX_REQUEST_ID_ATTEMPTS, 40);
  assert.match(candidateRequestId(0), /^REQ-\d{4}$/);
  assert.match(candidateRequestId(20), /^REQ-\d{6}$/);
});

// ── initiated_by inheritance in the in-memory engine (B1-R1) ─────────────────
test('memory engine: initiated_by is recorded, and a failover after rejection or expiry inherits it', async () => {
  const store = new MemoryStore();
  const actor = { role: 'PARAMEDIC', id: 'USER-EMS-001' };
  const create = () => store.createRequest({
    patient: { full_name: 'Fictional Failover Patient', age: 40, gender: 'UNKNOWN', emergency_type: 'RESPIRATORY', triage_priority: 2, contact_phone: null },
    request: { emergency_type: 'RESPIRATORY', required_resource_types: ['ICU_BED', 'VENTILATOR'], required_specialist: null, priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
  }, actor);
  const acceptance = id => db.hospitalAcceptances.find(a => a.acceptance_id === id);

  const first = await create();
  const lock = await store.acquireReferralLock('H-101', first.request_id, ['ICU_BED', 'VENTILATOR'], { initiatedBy: actor.id });
  assert.equal(acceptance(lock.acceptanceId).initiated_by, actor.id);
  const rejected = await store.rejectReferral(lock.acceptanceId, 'Full', 'USER-HSP-101');
  assert.ok(rejected.next_acceptance_id, 'a failover referral was placed');
  assert.equal(acceptance(rejected.next_acceptance_id).initiated_by, actor.id, 'failover after rejection inherits initiated_by');
  assert.deepEqual((await store.listAcceptances({ initiatedBy: actor.id })).map(a => a.request_id), [first.request_id, first.request_id]);
  await store.transitionRequestStatus(first.request_id, 'CANCELLED', { role: 'ADMIN', id: 'U-A' });

  const second = await create();
  const lock2 = await store.acquireReferralLock('H-103', second.request_id, ['ICU_BED', 'VENTILATOR'], { initiatedBy: actor.id });
  const expired = new Promise(resolve => lockingEngine.once('lock_expired', resolve));
  await lockingEngine._handleTimeout({ ...lockingEngine._activeLocks.get(lock2.acceptanceId) });
  const event = await expired;
  assert.equal(event.acceptanceId, lock2.acceptanceId);
  assert.ok(event.nextAcceptanceId, 'the expiry failed over');
  assert.equal(acceptance(event.nextAcceptanceId).initiated_by, actor.id, 'failover after expiry inherits initiated_by');
  await store.transitionRequestStatus(second.request_id, 'CANCELLED', { role: 'ADMIN', id: 'U-A' });
  assert.equal(lockingEngine.getActiveLocks().length, 0);
});
