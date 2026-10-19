// HTTP-level tests of the application running on MySQL: a real `node server/server.js` process
// pointed at the dedicated *_test database. Covers persistence across restarts, concurrent
// allocation, duplicate-dispatch and cancellation races, rollback, authorization boundaries and
// fail-fast startup. Skipped (not failed) when MySQL is not configured/reachable.
// All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { openTestDatabase, mysqlServerEnv, testConfig } from './helpers/mysqlTestDb.js';

const SHARED_PORT = 4127;
const RESTART_PORT = 4128;
const FAILURE_PORT = 4129;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const handle = await openTestDatabase();

if (handle.skip) {
  test.skip(`MySQL-backed API (skipped: ${handle.skip})`, () => {});
} else {
  const { admin } = handle;

  // ── process + HTTP helpers ─────────────────────────────────────────────────
  function startServer(port, env = mysqlServerEnv(port)) {
    const proc = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { text: '' };
    proc.stdout.on('data', chunk => { out.text += chunk; });
    proc.stderr.on('data', chunk => { out.text += chunk; });
    return { proc, out, port };
  }

  async function waitHealthy(server, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (server.proc.exitCode !== null) throw new Error(`server exited early (${server.proc.exitCode}):\n${server.out.text}`);
      try {
        if ((await fetch(`http://127.0.0.1:${server.port}/health`)).ok) return;
      } catch { /* still starting */ }
      await sleep(100);
    }
    throw new Error(`server did not become healthy:\n${server.out.text}`);
  }

  async function stopServer(server) {
    if (server.proc.exitCode !== null) return server.proc.exitCode;
    server.proc.kill('SIGTERM');
    const [code] = await once(server.proc, 'exit');
    return code;
  }

  async function runUntilExit(env, timeoutMs = 15_000) {
    const server = startServer(FAILURE_PORT, env);
    const timer = setTimeout(() => server.proc.kill('SIGKILL'), timeoutMs);
    const [code] = await once(server.proc, 'exit');
    clearTimeout(timer);
    return { code, output: server.out.text };
  }

  const api = port => async (path, token, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  async function login(call, username, password) {
    const { body } = await call('/api/v1/auth/login', null, 'POST', { username, password });
    return body.token;
  }

  const loginAll = async call => ({
    admin: await login(call, 'admin', 'admin123'),
    paramedic: await login(call, 'UNIT-402', 'paramedic123'),
    desk101: await login(call, 'apex_desk', 'hospital123'),
    desk102: await login(call, 'stjude_desk', 'hospital123'),
    desk103: await login(call, 'fortis_desk', 'hospital123')
  });

  const sql = async (query, params = []) => (await admin.query(query, params))[0];
  const sqlOne = async (query, params = []) => (await sql(query, params))[0];
  const count = async (query, params) => Number((await sqlOne(query, params)).n);

  async function createCase(call, token, type = 'RESPIRATORY', name = 'Fictional Route Patient') {
    const created = await call('/api/v1/emergencies', token, 'POST', { patient_name: name, age: 44, emergency_type: type, triage_priority: 2 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.request_id;
  }

  // ── shared server for most tests; every test starts from a freshly seeded database ──
  let shared;
  const call = api(SHARED_PORT);
  let tokens;

  test.before(async () => {
    await handle.reset(true); // the server's start-up schema check needs the current schema in place first
    shared = startServer(SHARED_PORT);
    await waitHealthy(shared);
    tokens = await loginAll(call);
  });
  test.beforeEach(() => handle.reset(true));
  test.after(async () => {
    if (shared) await stopServer(shared);
    await handle.release();
  });

  // ── Mode, health, persistence ────────────────────────────────────────────
  test('health reports MySQL storage and database reachability', async () => {
    const health = await call('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.storage, 'mysql');
    assert.equal(health.body.database, 'up');
  });

  test('cases, locks, allocations and audit survive a graceful restart', async () => {
    const server = startServer(RESTART_PORT);
    await waitHealthy(server);
    const c1 = api(RESTART_PORT);
    let t = await loginAll(c1);

    // Case A: fully accepted (resources committed, ambulance auto-dispatched).
    const accepted = await createCase(c1, t.paramedic, 'CARDIAC', 'Fictional Persist A');
    const lockA = await c1('/api/v1/referrals/initiate', t.paramedic, 'POST', { request_id: accepted, hospital_id: 'H-101' });
    const commitA = await c1(`/api/v1/referrals/${lockA.body.acceptance_id}/accept`, t.desk101, 'POST');
    assert.equal(commitA.status, 200);
    // Case B: referral still pending when the process stops.
    const pending = await createCase(c1, t.paramedic, 'RESPIRATORY', 'Fictional Persist B');
    const lockB = await c1('/api/v1/referrals/initiate', t.paramedic, 'POST', { request_id: pending, hospital_id: 'H-103' });
    assert.equal(lockB.status, 201);
    const resourcesBefore = (await c1('/api/v1/hospitals/H-101', t.admin)).body.hospital.resources;

    assert.equal(await stopServer(server), 0, 'SIGTERM must shut down cleanly (exit code 0)');

    const restarted = startServer(RESTART_PORT);
    try {
      await waitHealthy(restarted);
      t = await loginAll(c1);

      const detail = (await c1(`/api/v1/emergencies/${accepted}`, t.admin)).body;
      assert.equal(detail.request.status, 'ALLOCATED');
      assert.equal(detail.patient.full_name, 'Fictional Persist A');
      assert.equal(detail.allocations.length, 2);
      assert.ok(detail.allocations.every(a => a.status === 'COMMITTED'));
      assert.equal(detail.acceptances[0].status, 'ACCEPTED');
      assert.ok(detail.auditEvents.some(e => e.event_type === 'ALLOCATION_COMMITTED'));
      const fleet = (await c1('/api/v1/ambulances', t.admin)).body.ambulances;
      assert.equal(fleet.find(a => a.ambulance_id === commitA.body.ambulance_id).assigned_request_id, accepted);
      assert.deepEqual((await c1('/api/v1/hospitals/H-101', t.admin)).body.hospital.resources, resourcesBefore);

      // The pending lock survived too, and can still be accepted after the restart.
      const active = (await c1('/api/v1/referrals/active', t.admin)).body.active_locks;
      assert.ok(active.some(l => l.requestId === pending && l.remainingSec > 0));
      const late = await c1(`/api/v1/referrals/${lockB.body.acceptance_id}/accept`, t.desk103, 'POST');
      assert.equal(late.status, 200);
      assert.equal((await c1(`/api/v1/emergencies/${pending}`, t.admin)).body.request.status, 'ALLOCATED');
    } finally {
      await stopServer(restarted);
    }
  });

  // ── Concurrency ───────────────────────────────────────────────────────────
  test('12 parallel referrals for one ICU bed: exactly one lock, no leaked capacity', async () => {
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(await createCase(call, tokens.paramedic, 'RESPIRATORY', `Fictional Race ${i}`));

    const results = await Promise.all(ids.map(id => call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-102' })));

    assert.equal(results.filter(r => r.status === 201).length, 1);
    assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 409), results.map(r => r.status).join(','));
    assert.equal((await sqlOne("SELECT locked_capacity AS n FROM MedicalResource WHERE resource_id = 'RES-102-ICU'")).n, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM HospitalAcceptance WHERE status = 'PENDING'"), 1);
  });

  test('simultaneous manual dispatches for one case assign exactly one ambulance', async () => {
    await sql("UPDATE Ambulance SET status = 'MAINTENANCE'"); // nothing to auto-dispatch on accept
    const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', 'Fictional Dispatch Race');
    const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-103' });
    const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk103, 'POST');
    assert.equal(accepted.body.ambulance_id, null);
    await sql("UPDATE Ambulance SET status = 'AVAILABLE' WHERE ambulance_id IN ('AMB-01', 'AMB-03', 'AMB-04')");

    const results = await Promise.all(['AMB-01', 'AMB-03', 'AMB-04'].map(unit =>
      call(`/api/v1/ambulances/${unit}/status`, tokens.paramedic, 'PATCH', { status: 'DISPATCHED', request_id: id })));

    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    assert.ok(results.filter(r => r.status === 409).every(r => /already has ambulance|not available/.test(r.body.error)));
    assert.equal(await count('SELECT COUNT(*) AS n FROM Ambulance WHERE assigned_request_id = ?', [id]), 1);
  });

  test('after accept the case already has its auto-dispatched ambulance; a second dispatch is refused', async () => {
    const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', 'Fictional Auto Dispatch');
    const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-103' });
    const accepted = await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk103, 'POST');
    assert.ok(accepted.body.ambulance_id);

    const spare = (await call('/api/v1/ambulances?status=AVAILABLE', tokens.admin)).body.ambulances[0];
    const second = await call(`/api/v1/ambulances/${spare.ambulance_id}/status`, tokens.paramedic, 'PATCH', { status: 'DISPATCHED', request_id: id });
    assert.equal(second.status, 409);
    assert.equal(await count('SELECT COUNT(*) AS n FROM Ambulance WHERE assigned_request_id = ?', [id]), 1);
  });

  test('10 cancel-vs-accept races over HTTP never leave the case allocated or capacity leaked', async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', `Fictional Cancel Race ${round}`);
      const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-103' });
      assert.equal(lock.status, 201);
      const accept = async () => { await sleep(Math.random() * 6); return call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk103, 'POST'); };
      const cancel = async () => { await sleep(Math.random() * 6); return call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' }); };

      const [first, second] = round % 2 ? [accept(), cancel()] : [cancel(), accept()];
      const results = await Promise.all([first, second]);
      const cancelResult = round % 2 ? results[1] : results[0];
      assert.equal(cancelResult.status, 200, `round ${round}: cancellation must always succeed`);

      assert.equal((await call(`/api/v1/emergencies/${id}`, tokens.admin)).body.request.status, 'CANCELLED', `round ${round}`);
      assert.equal(await count("SELECT COUNT(*) AS n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 0, `round ${round}`);
      assert.equal(await count("SELECT COUNT(*) AS n FROM ResourceAllocation WHERE request_id = ? AND status IN ('LOCKED', 'COMMITTED')", [id]), 0, `round ${round}`);
      assert.equal(await count('SELECT COUNT(*) AS n FROM Ambulance WHERE assigned_request_id = ?', [id]), 0, `round ${round}`);
    }
    const icu = await sqlOne("SELECT available_capacity AS available, locked_capacity AS locked FROM MedicalResource WHERE resource_id = 'RES-103-ICU'");
    assert.deepEqual({ ...icu }, { available: 8, locked: 0 }, 'seeded capacity is fully restored');
  });

  test('capacity edits racing with referral locks keep every invariant (validated under the row lock)', async () => {
    const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(await createCase(call, tokens.paramedic, 'RESPIRATORY', `Fictional Capacity ${i}`));

    const referrals = ids.map(id => call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-101' }));
    const edits = [3, 2, 3, 2, 3, 2].map(value => call('/api/v1/hospitals/H-101/resources/ICU_BED', tokens.admin, 'PATCH', { available_capacity: value }));
    const results = await Promise.all([...referrals, ...edits]);

    assert.ok(results.every(r => [200, 201, 400, 409].includes(r.status)), results.map(r => r.status).join(','));
    const rows = await sql('SELECT resource_id, total_capacity AS total, available_capacity AS available, locked_capacity AS locked FROM MedicalResource');
    for (const row of rows) {
      const locked = await count("SELECT COUNT(*) AS n FROM ResourceAllocation WHERE resource_id = ? AND status = 'LOCKED'", [row.resource_id]);
      assert.equal(row.locked, locked, `${row.resource_id}: locked_capacity equals the LOCKED allocations`);
      assert.ok(row.locked <= row.available && row.available <= row.total, `${row.resource_id}: 0 <= locked <= available <= total`);
    }
  });

  // ── Rollback ──────────────────────────────────────────────────────────────
  test('a compound claim that fails on its second resource rolls the first one back', async () => {
    await sql("UPDATE MedicalResource SET available_capacity = 0 WHERE resource_id = 'RES-101-VNT'");
    const id = await createCase(call, tokens.paramedic, 'CARDIAC', 'Fictional Rollback');

    const result = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-101' });

    assert.equal(result.status, 409);
    assert.match(result.body.error, /No available VENTILATOR/);
    assert.equal((await sqlOne("SELECT locked_capacity AS n FROM MedicalResource WHERE resource_id = 'RES-101-ICU'")).n, 0, 'the ICU claim was rolled back');
    assert.equal(await count('SELECT COUNT(*) AS n FROM HospitalAcceptance WHERE request_id = ?', [id]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM ResourceAllocation WHERE request_id = ?', [id]), 0);
    assert.equal((await sqlOne('SELECT status AS s FROM EmergencyRequest WHERE request_id = ?', [id])).s, 'WAITING');
  });

  test('a storage failure mid-transaction rolls back completely and reveals nothing to the client', async () => {
    const patientsBefore = await count('SELECT COUNT(*) AS n FROM Patient');
    const requestsBefore = await count('SELECT COUNT(*) AS n FROM EmergencyRequest');

    // Simulate the audit write failing AFTER the patient and request rows were inserted in the same
    // transaction (dedicated test database only; restored in `finally`).
    await sql('RENAME TABLE EmergencyHistory TO EmergencyHistory_offline');
    let failed;
    try {
      failed = await call('/api/v1/emergencies', tokens.paramedic, 'POST', {
        patient_name: 'Fictional Rollback Patient', age: 30, emergency_type: 'GENERAL', triage_priority: 3
      });
    } finally {
      await sql('RENAME TABLE EmergencyHistory_offline TO EmergencyHistory');
    }

    assert.equal(failed.status, 500);
    assert.equal(failed.body.error, 'Internal server error.');
    assert.ok(!JSON.stringify(failed.body).includes('EmergencyHistory'), 'SQL error text (table names) must never reach the client');
    assert.equal(await count('SELECT COUNT(*) AS n FROM Patient'), patientsBefore, 'the patient insert was rolled back');
    assert.equal(await count('SELECT COUNT(*) AS n FROM EmergencyRequest'), requestsBefore, 'the request insert was rolled back');
    assert.equal((await call('/health')).status, 200, 'the server keeps serving after a failed transaction');

    // Once the table is back the very same request succeeds: nothing was left half-done.
    const retried = await call('/api/v1/emergencies', tokens.paramedic, 'POST', {
      patient_name: 'Fictional Rollback Patient', age: 30, emergency_type: 'GENERAL', triage_priority: 3
    });
    assert.equal(retried.status, 201);
    assert.equal(await count('SELECT COUNT(*) AS n FROM Patient'), patientsBefore + 1);
  });

  test('lifecycle errors keep the API wording: missing case 404, illegal move 409, repeat is a no-op', async () => {
    const missing = await call('/api/v1/emergencies/REQ-NOPE/status', tokens.admin, 'PATCH', { status: 'CANCELLED' });
    assert.deepEqual([missing.status, missing.body.error], [404, 'Request not found.']);
    const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', 'Fictional Lifecycle Wording');
    const illegal = await call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'COMPLETED' });
    assert.deepEqual([illegal.status, illegal.body.error], [409, 'Invalid lifecycle transition: WAITING -> COMPLETED.']);
    assert.equal((await call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
    const again = await call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
    assert.equal(again.status, 200, 'cancelling an already-cancelled case is idempotent');
    assert.equal((await call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'WAITING' })).status, 409);
    assert.equal((await call(`/api/v1/emergencies/${id}/status`, tokens.admin, 'PATCH', { status: 'BOGUS' })).status, 400);
  });

  test('values beyond the database column limits are a clear 400 instead of a storage error', async () => {
    const post = body => call('/api/v1/emergencies', tokens.paramedic, 'POST', { age: 30, emergency_type: 'GENERAL', triage_priority: 3, ...body });
    assert.equal((await post({ patient_name: 'x'.repeat(151) })).status, 400);
    assert.equal((await post({ patient_name: 'Fictional', contact_phone: '1'.repeat(31) })).status, 400);
    assert.equal((await post({ patient_name: 'Fictional', clinical_notes: 'n'.repeat(20001) })).status, 400);
    // The largest accepted notes (20 000 three-byte characters) still fit the TEXT column.
    assert.equal((await post({ patient_name: 'Fictional', clinical_notes: '€'.repeat(20000) })).status, 201);
  });

  // ── Authorization boundaries (MySQL mode) ─────────────────────────────────
  test('authorization and hospital-ownership boundaries hold on MySQL', async () => {
    assert.equal((await call('/api/v1/emergencies')).status, 401);

    const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', 'Fictional Auth Patient');
    // Not referred anywhere yet: no desk can see it.
    assert.equal((await call(`/api/v1/emergencies/${id}`, tokens.desk101)).status, 404);
    const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-101' });
    assert.equal(lock.status, 201);

    assert.equal((await call(`/api/v1/emergencies/${id}`, tokens.desk101)).status, 200);
    assert.equal((await call(`/api/v1/emergencies/${id}/audit`, tokens.desk101)).status, 200);
    assert.equal((await call(`/api/v1/emergencies/${id}`, tokens.desk102)).status, 404);
    assert.equal((await call(`/api/v1/emergencies/${id}/audit`, tokens.desk102)).status, 404);
    assert.ok((await call('/api/v1/emergencies', tokens.desk101)).body.queue.some(r => r.request_id === id));
    assert.ok(!(await call('/api/v1/emergencies', tokens.desk102)).body.queue.some(r => r.request_id === id));

    assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk102, 'POST')).status, 403);
    assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.paramedic, 'POST')).status, 403);
    assert.equal((await call(`/api/v1/emergencies/${id}/status`, tokens.paramedic, 'PATCH', { status: 'CANCELLED' })).status, 403);
    assert.equal((await call('/api/v1/hospitals/H-101/resources/ICU_BED', tokens.desk102, 'PATCH', { available_capacity: 1 })).status, 403);
    assert.equal((await call('/api/v1/hospitals/H-101/resources/ICU_BED', tokens.paramedic, 'PATCH', { available_capacity: 1 })).status, 403);
    assert.equal((await call('/api/v1/ambulances/AMB-01/status', tokens.desk102, 'PATCH', { status: 'MAINTENANCE' })).status, 403);
    assert.equal((await call('/api/v1/doctors/DR-001', tokens.desk102)).status, 403);
    assert.equal((await call('/api/v1/doctors/DR-001/status', tokens.desk102, 'PATCH', { availability_status: 'OFF_DUTY' })).status, 403);
    assert.equal((await call('/api/v1/analytics/audit', tokens.desk101)).status, 403);
    assert.equal((await sqlOne("SELECT status AS s FROM Ambulance WHERE ambulance_id = 'AMB-01'")).s, 'AVAILABLE', 'the refused call changed nothing');
    assert.equal((await call('/api/v1/hospitals/H-101/resources/ICU_BED', tokens.admin, 'PATCH', { available_capacity: 3 })).status, 200);
  });

  // ── Doctors, analytics, audit ─────────────────────────────────────────────
  test('concurrent doctor creation yields unique ids, and ids are not reused after a delete', async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/api/v1/doctors', tokens.admin, 'POST', {
      hospital_id: 'H-101', full_name: `Dr Fictional ${i}`, specialization: 'GENERAL_ER', shift_start: '08:00', shift_end: '20:00'
    })));
    assert.ok(created.every(r => r.status === 201), created.map(r => `${r.status}:${r.body?.error ?? ''}`).join(','));
    const ids = created.map(r => r.body.doctor.doctor_id);
    assert.equal(new Set(ids).size, 6);
    assert.equal(created[0].body.doctor.shift_start, '08:00');

    assert.equal((await call(`/api/v1/doctors/${ids[0]}`, tokens.admin, 'DELETE')).status, 200);
    const again = await call('/api/v1/doctors', tokens.admin, 'POST', { hospital_id: 'H-101', full_name: 'Dr Replacement', specialization: 'GENERAL_ER' });
    assert.equal(again.status, 201);
    const all = (await call('/api/v1/doctors', tokens.admin)).body.doctors.map(d => d.doctor_id);
    assert.equal(new Set(all).size, all.length, 'no duplicate doctor ids');

    assert.equal((await call('/api/v1/doctors', tokens.admin, 'POST', { hospital_id: 'H-101', full_name: 'Bad Shift', specialization: 'GENERAL_ER', shift_start: 'noon' })).status, 400);
    const shift = await call(`/api/v1/doctors/${ids[1]}/shift`, tokens.admin, 'PATCH', { shift_start: '09:30' });
    assert.equal(shift.body.shift_start, '09:30');
  });

  test('analytics, KPIs and the audit trail are served from MySQL and agree with the data', async () => {
    const id = await createCase(call, tokens.paramedic, 'RESPIRATORY', 'Fictional Analytics');
    const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-103' });
    await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk103, 'POST');

    const dashboard = (await call('/api/v1/analytics/dashboard', tokens.admin)).body.dashboard.kpis;
    const icu = await sqlOne("SELECT SUM(available_capacity) AS n FROM MedicalResource WHERE resource_type = 'ICU_BED'");
    assert.equal(dashboard.icu_available, Number(icu.n));
    assert.equal(dashboard.hospitals_open + dashboard.hospitals_limited + dashboard.hospitals_closed, 6);

    const referrals = (await call('/api/v1/analytics/referrals', tokens.admin)).body;
    assert.equal(referrals.summary.accepted, 1);
    assert.equal(referrals.by_hospital.find(h => h.hospital_id === 'H-103').acceptance_rate, 100);

    const audit = (await call('/api/v1/analytics/audit?limit=50', tokens.admin)).body.audit_trail;
    assert.ok(['REQUEST_CREATED', 'LOCK_ACQUIRED', 'ALLOCATION_COMMITTED'].every(type => audit.some(e => e.event_type === type)));
    const filtered = (await call('/api/v1/analytics/audit?event_type=ALLOCATION_COMMITTED', tokens.admin)).body.audit_trail;
    assert.ok(filtered.length >= 1 && filtered.every(e => e.event_type === 'ALLOCATION_COMMITTED'));

    const utilization = (await call('/api/v1/analytics/resources', tokens.admin)).body.utilization;
    assert.equal(utilization.length, 6);
  });

  // ── Fail-fast startup: never a silent fallback to the in-memory store ─────
  test('startup refuses to run when MySQL rejects the credentials, and never prints the password', async () => {
    const secret = 'definitely-wrong-password-for-test';
    const { code, output } = await runUntilExit(mysqlServerEnv(FAILURE_PORT, { DB_PASS: secret }));
    assert.equal(code, 1);
    assert.match(output, /Refusing to start/);
    assert.match(output, /no fallback to the in-memory store/);
    assert.ok(!output.includes(secret), 'the password must never appear in logs');
    await assert.rejects(fetch(`http://127.0.0.1:${FAILURE_PORT}/health`), 'nothing may be listening');
  });

  test('startup refuses to run when MySQL is unreachable', async () => {
    const { code, output } = await runUntilExit(mysqlServerEnv(FAILURE_PORT, { DB_PORT: '1' }));
    assert.equal(code, 1);
    assert.match(output, /Refusing to start/);
  });

  test('production mode requires an explicit storage choice and a configured MySQL', async () => {
    const base = { JWT_SECRET: 'test-only-secret-value' };
    const unset = await runUntilExit(mysqlServerEnv(FAILURE_PORT, { ...base, NODE_ENV: 'production', DB_USE_MEMORY: '' }));
    assert.equal(unset.code, 1);
    assert.match(unset.output, /DB_USE_MEMORY must be set explicitly/);

    const missing = await runUntilExit(mysqlServerEnv(FAILURE_PORT, { ...base, DB_NAME: '' }));
    assert.equal(missing.code, 1);
    assert.match(missing.output, /requires .*DB_NAME/);

    const noPassword = await runUntilExit(mysqlServerEnv(FAILURE_PORT, { ...base, NODE_ENV: 'production', DB_PASS: '' }));
    assert.equal(noPassword.code, 1);
    assert.match(noPassword.output, /non-empty DB_PASS/);
  });

  test('the connected test database is the dedicated *_test one', () => {
    assert.match(testConfig.database, /_test$/);
  });
}
