// Accounts on MySQL (review finding X2): `npm run user:create` (scripts/user-create.js) writes bcrypt hashes only and
// never echoes the password; `db:seed` creates the fictional demo accounts only outside production; a production server
// refuses the demo accounts (and says so at start-up) while a real account signs in. Test database only; fictional data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { openTestDatabase, mysqlServerEnv, testConfig } from './helpers/mysqlTestDb.js';
import { upsertUser, UserCreateError, BCRYPT_COST } from '../scripts/user-create.js';
import { seedDemoData } from '../server/db/init.js';
import { createPool } from '../server/db/pool.js';
import { MySqlStore } from '../server/db/mysqlStore.js';

const PORT = 4255;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Fictional-Strong-Pass-42'; // a test value for fictional accounts
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = await openTestDatabase();

if (handle.skip) {
  test.skip(`user:create on MySQL (skipped: ${handle.skip})`, () => {});
} else {
  const { admin } = handle;
  const user = async username => (await admin.query('SELECT * FROM SystemUser WHERE username = ?', [username]))[0][0];

  function runCli(args, { env = {}, stdin = null, script = 'scripts/user-create.js' } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: process.cwd(), env: { ...mysqlServerEnv(0), ERIS_USER_PASSWORD: '', ...env }, stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out }));
      if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
    });
  }

  test.before(() => handle.reset(true));
  test.after(async () => {
    await handle.reset(true);
    await handle.release();
  });

  test('upsertUser stores a bcrypt hash (cost 12) and nothing in plaintext; it validates role scope and references', async () => {
    const created = await upsertUser(admin, { username: 'ops.admin', role: 'ADMIN', displayName: 'Fictional Ops Admin' }, PASSWORD);
    assert.equal(created.created, true);
    const row = await user('ops.admin');
    assert.match(row.password_hash, new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
    assert.equal(await bcrypt.compare(PASSWORD, row.password_hash), true);
    assert.ok(!Object.values(row).some(v => String(v).includes(PASSWORD)), 'no column holds the password');
    assert.deepEqual([row.role, row.is_demo, row.is_active, row.display_name], ['ADMIN', 0, 1, 'Fictional Ops Admin']);

    for (const [account, message] of [
      [{ username: 'x.medic', role: 'PARAMEDIC' }, /needs --ambulance/],
      [{ username: 'x.medic', role: 'PARAMEDIC', ambulanceId: 'AMB-404' }, /AMB-404 does not exist/],
      [{ username: 'x.desk', role: 'HOSPITAL_DESK', hospitalId: 'H-999' }, /H-999 does not exist/],
      [{ username: 'x.admin', role: 'ADMIN', hospitalId: 'H-101' }, /HOSPITAL_DESK accounts only/],
      [{ username: 'bad name!', role: 'ADMIN' }, /--username/],
      [{ username: 'x.admin', role: 'ROOT' }, /--role/],
      // Batch 8: the Operator and Patient portals were retired; those roles can no longer be given.
      [{ username: 'x.operator', role: 'DISPATCHER' }, /--role must be one of ADMIN, HOSPITAL_DESK, PARAMEDIC/],
      [{ username: 'x.patient', role: 'PATIENT', patientId: 'PAT-001' }, /--role must be one of ADMIN, HOSPITAL_DESK, PARAMEDIC/]
    ]) {
      await assert.rejects(upsertUser(admin, account, PASSWORD), err => err instanceof UserCreateError && message.test(err.message));
    }
    await assert.rejects(upsertUser(admin, { username: 'x.admin', role: 'ADMIN' }, 'short'), /at least 12/);
    await assert.rejects(upsertUser(admin, { username: 'x.admin', role: 'ADMIN' }, 'é'.repeat(40)), /72 bytes/);
    assert.equal(await user('x.medic'), undefined, 'nothing was written by a refused call');

    // Updating a demo account makes it a real one (new hash, demo flag cleared).
    const before = await user('apex_desk');
    const updated = await upsertUser(admin, { username: 'apex_desk', role: 'HOSPITAL_DESK', hospitalId: 'H-101' }, PASSWORD);
    assert.deepEqual([updated.created, updated.user_id], [false, before.user_id]);
    const after = await user('apex_desk');
    assert.equal(after.is_demo, 0);
    assert.equal(after.token_version, before.token_version + 1, 'a password change ends the old sessions');
    assert.notEqual(after.password_hash, before.password_hash);
  });

  test('CLI: the password comes from ERIS_USER_PASSWORD or stdin, is never echoed, and never from an argument', async () => {
    const fromEnv = await runCli(['--username', 'cli.medic', '--role', 'paramedic', '--ambulance', 'AMB-05', '--display-name', 'Fictional CLI Medic'],
      { env: { ERIS_USER_PASSWORD: PASSWORD } });
    assert.equal(fromEnv.code, 0, fromEnv.out);
    assert.match(fromEnv.out, /Created PARAMEDIC account "cli\.medic"/);
    assert.ok(!fromEnv.out.includes(PASSWORD), 'the password is not printed');
    if (testConfig.password) assert.ok(!fromEnv.out.includes(testConfig.password), 'the database password is not printed');
    assert.equal((await user('cli.medic')).ambulance_id, 'AMB-05');

    const fromStdin = await runCli(['--username', 'cli.desk', '--role', 'HOSPITAL_DESK', '--hospital', 'H-102'], { stdin: `${PASSWORD}\n` });
    assert.equal(fromStdin.code, 0, fromStdin.out);
    assert.equal(await bcrypt.compare(PASSWORD, (await user('cli.desk')).password_hash), true);
    assert.ok(!fromStdin.out.includes(PASSWORD));

    const onArgv = await runCli(['--username', 'cli.bad', '--role', 'ADMIN', '--password', PASSWORD]);
    assert.equal(onArgv.code, 1);
    assert.match(onArgv.out, /Never pass a password on the command line/);
    const weak = await runCli(['--username', 'cli.bad', '--role', 'ADMIN'], { stdin: 'short\n' });
    assert.equal(weak.code, 1);
    const noTarget = await runCli(['--username', 'cli.bad', '--role', 'ADMIN'], { env: { ERIS_USER_PASSWORD: PASSWORD, DB_NAME: '' } });
    assert.equal(noTarget.code, 1);
    assert.match(noTarget.out, /requires DB_NAME/);
    assert.equal(await user('cli.bad'), undefined);
  });

  test('CLI refuses a database that is not at the current schema (nothing is written)', async () => {
    await admin.query("DELETE FROM SchemaMigration WHERE version = '008_accounts_and_scoping'");
    try {
      const result = await runCli(['--username', 'cli.stale', '--role', 'ADMIN'], { env: { ERIS_USER_PASSWORD: PASSWORD } });
      assert.equal(result.code, 1);
      assert.match(result.out, /not at the current schema.*pending migrations: 008_accounts_and_scoping/s);
      assert.equal(await user('cli.stale'), undefined);
    } finally {
      await admin.query("INSERT INTO SchemaMigration (version, status) VALUES ('008_accounts_and_scoping', 'BASELINE')");
    }
  });

  test('db:seed with NODE_ENV=production is the hospital bootstrap only: no demo account, case or demo history', async () => {
    await handle.reset(false);
    assert.equal(await seedDemoData(admin, { env: { NODE_ENV: 'production' } }), true);
    const [[counts]] = await admin.query('SELECT (SELECT COUNT(*) FROM SystemUser) AS users, (SELECT COUNT(*) FROM Hospital) AS hospitals');
    assert.deepEqual([Number(counts.users), Number(counts.hospitals)], [0, 6]);
    const [[demo]] = await admin.query(`SELECT (SELECT COUNT(*) FROM Patient) AS patients, (SELECT COUNT(*) FROM EmergencyRequest) AS cases,
      (SELECT COUNT(*) FROM HospitalAcceptance) AS referrals, (SELECT COUNT(*) FROM ResourceAllocation) AS allocations,
      (SELECT COUNT(*) FROM DoctorAssignment) AS assignments, (SELECT COUNT(*) FROM EmergencyHistory) AS audit,
      (SELECT availability_status FROM Doctor WHERE doctor_id = 'DR-013') AS surgeon,
      (SELECT assigned_request_id FROM Ambulance WHERE ambulance_id = 'AMB-02') AS unit_case,
      (SELECT status FROM Ambulance WHERE ambulance_id = 'AMB-02') AS unit_status`);
    assert.deepEqual({ ...demo, patients: Number(demo.patients), cases: Number(demo.cases), referrals: Number(demo.referrals),
      allocations: Number(demo.allocations), assignments: Number(demo.assignments), audit: Number(demo.audit) },
    { patients: 0, cases: 0, referrals: 0, allocations: 0, assignments: 0, audit: 0, surgeon: 'AVAILABLE', unit_case: null, unit_status: 'AVAILABLE' });
    await handle.reset(true);
    const [[unit]] = await admin.query("SELECT status, assigned_request_id FROM Ambulance WHERE ambulance_id = 'AMB-02'");
    assert.deepEqual({ ...unit }, { status: 'IN_TRANSIT', assigned_request_id: 'REQ-8901' }, 'outside production AMB-02 keeps the demo IN_TRANSIT state');
    const [[seeded]] = await admin.query('SELECT COUNT(*) AS n, SUM(is_demo) AS demo FROM SystemUser');
    assert.deepEqual([Number(seeded.n), Number(seeded.demo)], [8, 8], 'outside production the 8 demo accounts (admin, 5 desks, 2 Fleet) are seeded, flagged demo');
    const [roles] = await admin.query('SELECT DISTINCT role FROM SystemUser ORDER BY role');
    assert.deepEqual(roles.map(r => r.role), ['ADMIN', 'HOSPITAL_DESK', 'PARAMEDIC'], 'no Operator or Patient demo login');
  });

  test('db:seed-demo-users adds only the missing demo accounts, never in production, and only to a current schema', async () => {
    const seed = (env, args = []) => runCli(args, { env, script: 'scripts/seed-demo-users.js' });
    await handle.reset(true);
    await admin.query("DELETE FROM SystemUser WHERE username <> 'admin'");
    await admin.query("UPDATE SystemUser SET password_hash = 'kept' WHERE username = 'admin'");

    const refused = await seed({ NODE_ENV: 'production' });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /Refusing: demo accounts are never created when NODE_ENV=production/);
    assert.equal(Number((await admin.query('SELECT COUNT(*) AS n FROM SystemUser'))[0][0].n), 1, 'nothing written in production');

    const first = await seed({});
    assert.equal(first.code, 0, first.out);
    const [rows] = await admin.query('SELECT username, password_hash, is_demo, ambulance_id FROM SystemUser ORDER BY user_id');
    assert.equal(rows.length, 8);
    assert.ok(rows.every(r => r.is_demo === 1));
    assert.equal(rows.find(r => r.username === 'admin').password_hash, 'kept', 'an existing account is left untouched');
    assert.ok(rows.filter(r => r.username !== 'admin').every(r => /^\$2[aby]\$10\$/.test(r.password_hash)), 'hashed, never plaintext');
    assert.equal(rows.find(r => r.username === 'UNIT-402').ambulance_id, 'AMB-01');
    if (testConfig.password) assert.ok(!first.out.includes(testConfig.password));

    const again = await seed({});
    assert.equal(again.code, 0);
    assert.match(again.out, /inserted \[\]/, 're-running changes nothing');

    // Round 3 item 3: a database that already has a real (active, non-demo) account is refused unless --force.
    await upsertUser(admin, { username: 'ops.real', role: 'ADMIN' }, PASSWORD);
    await admin.query("DELETE FROM SystemUser WHERE username = 'UNIT-601'");
    const guarded = await seed({});
    assert.equal(guarded.code, 1);
    assert.match(guarded.out, /already has 1 active non-demo account\(s\).*--force/s);
    assert.equal((await admin.query("SELECT COUNT(*) AS n FROM SystemUser WHERE username = 'UNIT-601'"))[0][0].n, 0, 'nothing written');
    const forced = await seed({}, ['--force']);
    assert.equal(forced.code, 0, forced.out);
    assert.match(forced.out, /inserted \[UNIT-601\]/);

    // A database without the demo hospitals and units: desks are skipped, paramedics get no unit.
    await handle.reset(false);
    assert.equal((await seed({})).code, 0);
    const [bare] = await admin.query('SELECT username, ambulance_id FROM SystemUser ORDER BY user_id');
    assert.deepEqual(bare.map(r => [r.username, r.ambulance_id]), [['admin', null], ['UNIT-402', null], ['UNIT-601', null]], 'desks need their hospitals, Fleet logins their units');

    // Not at the current schema: refused.
    await admin.query("DELETE FROM SchemaMigration WHERE version = '008_accounts_and_scoping'");
    try {
      const stale = await seed({});
      assert.equal(stale.code, 1);
      assert.match(stale.out, /not at the current schema/);
    } finally {
      await admin.query("INSERT INTO SchemaMigration (version, status) VALUES ('008_accounts_and_scoping', 'BASELINE')");
    }
    await handle.reset(true);
  });

  test('countUsableAdmins on MySQL counts only usable, non-demo ADMIN accounts (Batch 6 round 2)', async () => {
    await handle.reset(true);
    const pool = createPool({ ...testConfig, connectionLimit: 2 });
    const store = new MySqlStore({ pool });
    try {
      assert.equal(await store.countUsableAdmins(), 0, 'demo accounts only');
      await admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, hospital_id, patient_id, is_active, is_demo)
                         VALUES ('USER-R3-DESK', 'fictional.r3.desk', 'x', 'HOSPITAL_DESK', 'H-101', NULL, 1, 0),
                                ('USER-R3-PAT', 'fictional.r3.pat', 'x', 'PATIENT', NULL, 'PAT-001', 1, 0),
                                ('USER-R3-ADM', 'fictional.r3.adm', 'x', 'ADMIN', NULL, NULL, 0, 0)`);
      assert.equal(await store.countUsableAdmins(), 0, 'a desk, a patient and an inactive admin cannot administer');
      await admin.query("UPDATE SystemUser SET is_active = 1 WHERE user_id = 'USER-R3-ADM'");
      assert.equal(await store.countUsableAdmins(), 1);
    } finally {
      await store.close();
      await handle.reset(true);
    }
  });

  test('the session bump is decided by the MySQL store against the locked row, not a stale caller view (Batch 6 round 3)', async () => {
    await handle.reset(true);
    const pool = createPool({ ...testConfig, connectionLimit: 2 });
    const store = new MySqlStore({ pool });
    const version = async () => (await admin.query("SELECT role, token_version FROM SystemUser WHERE user_id = 'USER-R3-RACE'"))[0][0];
    try {
      await admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, is_active, is_demo, token_version)
                         VALUES ('USER-R3-RACE', 'fictional.r3.race', 'x', 'DISPATCHER', 1, 0, 1)`);
      const actor = { role: 'ADMIN', id: 'USER-ADM-001' };
      // The route read role PARAMEDIC; the stored row is DISPATCHER (another admin's change); the write sets PARAMEDIC.
      await store.updateUser('USER-R3-RACE', { role: 'PARAMEDIC' }, actor);
      assert.deepEqual({ ...(await version()) }, { role: 'PARAMEDIC', token_version: 2 });
      await store.updateUser('USER-R3-RACE', { role: 'PARAMEDIC', display_name: 'Same role' }, actor);
      assert.equal((await version()).token_version, 2, 'no change of role or link: no bump');
      await store.updateUser('USER-R3-RACE', { is_active: 0 }, actor);
      assert.equal((await version()).token_version, 3, 'a deactivation');
    } finally {
      await store.close();
      await handle.reset(true);
    }
  });

  test('getRequestDetail takes one scoped query: "not yours" and "missing" run the same statements', async () => {
    await handle.reset(true);
    const pool = createPool({ ...testConfig, connectionLimit: 2 });
    const store = new MySqlStore({ pool });
    const statements = [];
    const query = pool.query.bind(pool);
    pool.query = (sql, ...rest) => { statements.push(String(sql).replace(/\s+/g, ' ')); return query(sql, ...rest); };
    try {
      const scope = { kind: 'patient', patientId: 'PAT-001' };
      statements.length = 0;
      assert.equal(await store.getRequestDetail('REQ-8902', { scope }), null, 'exists, not this patient\'s');
      const notYours = [...statements];
      statements.length = 0;
      assert.equal(await store.getRequestDetail('REQ-0000', { scope }), null, 'does not exist');
      assert.deepEqual(statements, notYours, 'identical statements on both paths');
      assert.equal(notYours.length, 1);
      assert.ok(await store.getRequestDetail('REQ-8901', { scope }), 'own case found');
    } finally {
      await store.close();
    }
  });

  test('a production server refuses the demo accounts (and warns at start-up) while a real account signs in', async t => {
    if (!testConfig.password) { t.skip('MySQL mode in production needs a non-empty DB_PASS; the test database user has none'); return; }
    await handle.reset(true);
    // Only demo accounts: nobody could sign in, so a production server refuses to start (round 2, item 4).
    const demoOnly = spawn(process.execPath, ['server/server.js'], {
      cwd: process.cwd(), env: mysqlServerEnv(PORT, { NODE_ENV: 'production', JWT_SECRET: 'user-create-production-secret-0123456789' }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let demoOut = '';
    demoOnly.stdout.on('data', chunk => { demoOut += chunk; });
    demoOnly.stderr.on('data', chunk => { demoOut += chunk; });
    // Bounded wait: if the server wrongly starts, the test fails instead of hanging.
    const demoCode = await Promise.race([once(demoOnly, 'exit').then(([code]) => code), sleep(15_000).then(() => 'still running')]);
    if (demoCode === 'still running') { demoOnly.kill('SIGTERM'); await once(demoOnly, 'exit'); }
    assert.equal(demoCode, 1);
    assert.match(demoOut, /no active non-demo ADMIN account.*Refusing to start/s);
    // Real accounts that cannot administer (a patient) are not enough either.
    // A (dormant) PATIENT account, inserted directly: no tool may create that role any more.
    await admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo)
                       VALUES ('USER-OPS-PAT', 'ops.patient', 'x', 'PATIENT', 'PAT-001', 'Fictional Patient', 1, 0)`);
    const patientOnly = spawn(process.execPath, ['server/server.js'], {
      cwd: process.cwd(), env: mysqlServerEnv(PORT, { NODE_ENV: 'production', JWT_SECRET: 'user-create-production-secret-0123456789' }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let patientOut = '';
    patientOnly.stdout.on('data', chunk => { patientOut += chunk; });
    patientOnly.stderr.on('data', chunk => { patientOut += chunk; });
    const patientCode = await Promise.race([once(patientOnly, 'exit').then(([code]) => code), sleep(15_000).then(() => 'still running')]);
    if (patientCode === 'still running') { patientOnly.kill('SIGTERM'); await once(patientOnly, 'exit'); }
    assert.equal(patientCode, 1, 'a production store whose only real account is a patient refuses to start');
    assert.match(patientOut, /no active non-demo ADMIN account/);

    await upsertUser(admin, { username: 'ops.admin', role: 'ADMIN' }, PASSWORD);
    const proc = spawn(process.execPath, ['server/server.js'], {
      cwd: process.cwd(), env: mysqlServerEnv(PORT, { NODE_ENV: 'production', JWT_SECRET: 'user-create-production-secret-0123456789' }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.stderr.on('data', chunk => { out += chunk; });
    try {
      const deadline = Date.now() + 12_000;
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited early:\n${out}`);
        try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
        if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
        await sleep(100);
      }
      const login = async (username, password) => {
        const response = await fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
        });
        return { status: response.status, body: await response.json() };
      };
      const demo = await login('admin', 'admin123');
      assert.equal(demo.status, 401, 'a demo account never signs in to a production server');
      assert.deepEqual(demo.body, (await login('admin', 'wrong-password')).body);
      const real = await login('ops.admin', PASSWORD);
      assert.equal(real.status, 200);
      assert.equal(real.body.user.role, 'ADMIN');
      assert.match(out, /\[SECURITY\] 8 demo account\(s\) exist/);
      assert.match(out, /Refused demo account "admin"/);
      assert.ok(!out.includes(PASSWORD));
    } finally {
      if (proc.exitCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
    }
  });
}
