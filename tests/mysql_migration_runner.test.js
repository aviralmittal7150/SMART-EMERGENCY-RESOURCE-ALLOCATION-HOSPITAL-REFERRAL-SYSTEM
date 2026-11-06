// Migration runner (server/db/migrate.js) against a REAL MySQL server: ordering, re-run safety, adoption of
// a database created before the runner, failure midway (MySQL DDL is not transactional), operator recovery,
// tamper and out-of-order detection, two runners at once, and the start-up refusal.
//
// Synthetic migrations (004/005) live only in temporary copies of the migrations directory and create
// probe tables named ZzRunnerProbe*; nothing under server/db/migrations is modified.
// Runs only against the dedicated *_test database (see tests/helpers/mysqlTestDb.js). Data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { openTestDatabase, mysqlServerEnv } from './helpers/mysqlTestDb.js';
import { SCHEMA_TABLES, initializeSchema } from '../server/db/init.js';
import { checkSchema } from '../server/db/bootstrap.js';
import {
  runMigrations, migrationStatus, markApplied, retryFailed, listMigrationFiles, MigrationError, MIGRATIONS_DIR
} from '../server/db/migrate.js';

const PROBES = ['ZzRunnerProbeA', 'ZzRunnerProbeB'];
const handle = await openTestDatabase();

if (handle.skip) {
  test.skip(`MySQL migration runner (skipped: ${handle.skip})`, () => {});
} else {
  const { admin, config } = handle;
  const connections = [];
  const connect = async () => {
    const conn = await mysql.createConnection({ ...config });
    connections.push(conn);
    return conn;
  };
  const tempDirs = [];
  const migrationsWith = extra => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-'));
    tempDirs.push(dir);
    for (const f of listMigrationFiles()) fs.copyFileSync(f.path, path.join(dir, f.file));
    for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), sql);
    return dir;
  };

  const assertTestDatabase = () => {
    if (!/_test$/.test(config.database)) throw new Error(`Refusing to modify "${config.database}".`);
  };
  async function dropEverything() {
    assertTestDatabase();
    await admin.query(`SET FOREIGN_KEY_CHECKS = 0; ${[...SCHEMA_TABLES, ...PROBES].map(t => `DROP TABLE IF EXISTS \`${t}\``).join('; ')}; SET FOREIGN_KEY_CHECKS = 1`);
  }
  async function freshSchema() {
    await dropEverything();
    await handle.reset(false); // schema.sql (records 001-003 as BASELINE)
  }
  async function oldSchemaWithData() {
    await dropEverything();
    await admin.query(fs.readFileSync(new URL('./fixtures/schema_before_lifecycle.sql', import.meta.url), 'utf8'));
    await admin.query(`
      INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone)
        VALUES ('H-R', 'Fictional Runner Hospital', 'Fictional Ave', 28.6, 77.2, '000');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-R', 'Fictional Runner Patient', 52, 'STROKE');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status) VALUES ('REQ-R', 'PAT-R', 'STROKE', 2, 'WAITING');`);
  }
  const rows = async () => (await admin.query('SELECT version, status, checksum, statements_applied, recorded_at FROM SchemaMigration ORDER BY version'))[0]
    .map(r => ({ ...r }));
  const tableExists = async name => (await admin.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]))[0][0].n > 0;
  async function structure() {
    const [columns] = await admin.query(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable, column_default AS dflt
       FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, column_name`);
    const [indexes] = await admin.query(
      `SELECT table_name AS t, index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name NOT LIKE '%_ibfk_%' AND index_name NOT LIKE 'fk_%'
       GROUP BY table_name, index_name ORDER BY table_name, index_name`);
    return { columns: columns.map(r => ({ ...r })), indexes: indexes.map(r => ({ ...r })) };
  }

  test.after(async () => {
    await dropEverything();
    await handle.reset(true); // leave the current schema with demo data for whoever runs next
    for (const conn of connections) await conn.end().catch(() => {});
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    await handle.release();
  });

  // ── Fresh databases and re-runs ──────────────────────────────────────────────────────────────
  test('a database created from schema.sql has every migration as BASELINE; running the runner twice changes nothing', async () => {
    await freshSchema();
    const before = await rows();
    assert.deepEqual(before.map(r => [r.version, r.status]), listMigrationFiles().map(f => [f.version, 'BASELINE']));
    const conn = await connect();
    assert.deepEqual(await runMigrations(conn), { baselined: [], applied: [], pending: [] });
    assert.deepEqual(await runMigrations(conn), { baselined: [], applied: [], pending: [] });
    assert.deepEqual(await rows(), before, 'not even recorded_at changed');
    assert.deepEqual(await checkSchema(conn), []);
  });

  test('an empty database is refused (it is created with db:init, not migrated)', async () => {
    await dropEverything();
    await assert.rejects(runMigrations(await connect()), err => err instanceof MigrationError && /empty.*db:init/.test(err.message));
    assert.equal(await tableExists('SchemaMigration'), false);
  });

  // ── Adopting a database created before the runner ────────────────────────────────────────────
  test('a pre-runner database is refused without --baseline, and nothing is created', async () => {
    await oldSchemaWithData();
    await assert.rejects(runMigrations(await connect()), err => /created before the migration runner.*--baseline/s.test(err.message));
    assert.equal(await tableExists('SchemaMigration'), false);
    await assert.rejects(initializeSchema(admin), /predates the migration runner/,
      'db:init must not run over it either (it would record migrations it never applied)');
    assert.equal(await tableExists('SchemaMigration'), false);
  });

  test('--dry-run reports the plan for a pre-runner database and changes nothing', async () => {
    await oldSchemaWithData();
    const shape = await structure();
    const plan = await runMigrations(await connect(), { baseline: 'none', dryRun: true });
    assert.deepEqual(plan, { baselined: [], applied: [], pending: ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration'] });
    assert.deepEqual(await structure(), shape);
  });

  test('--baseline none applies 001, 002, 003 in order: identical to a fresh schema, data kept, re-run is a no-op', async () => {
    await freshSchema();
    const fresh = await structure();
    await oldSchemaWithData();
    const conn = await connect();
    const result = await runMigrations(conn, { baseline: 'none' });
    assert.deepEqual(result, { baselined: [], applied: ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration'], pending: [] });
    const recorded = await rows();
    const files = listMigrationFiles();
    assert.deepEqual(recorded.map(r => [r.version, r.status, r.checksum, r.statements_applied]),
      [[files[0].version, 'APPLIED', files[0].checksum, 5], [files[1].version, 'APPLIED', files[1].checksum, 1], [files[2].version, 'APPLIED', files[2].checksum, 1]]);
    assert.deepEqual(await structure(), fresh, 'the upgraded database matches a freshly created one');
    assert.equal((await admin.query("SELECT full_name FROM Patient WHERE patient_id = 'PAT-R'"))[0][0].full_name, 'Fictional Runner Patient');
    assert.deepEqual(await checkSchema(conn), []);
    assert.deepEqual(await runMigrations(conn), { baselined: [], applied: [], pending: [] }, 're-run applies nothing');
    await assert.rejects(runMigrations(conn, { baseline: '002' }), /only for a database without a SchemaMigration table/);
  });

  test('--baseline 002 on a database migrated by hand records 001/002 and applies only 003', async () => {
    await oldSchemaWithData();
    for (const f of listMigrationFiles().slice(0, 2)) await admin.query(f.sql);
    const result = await runMigrations(await connect(), { baseline: '002' });
    assert.deepEqual(result, { baselined: ['001_referral_lifecycle', '002_idempotency_keys'], applied: ['003_schema_migration'], pending: [] });
    assert.deepEqual((await rows()).map(r => [r.version, r.status]),
      [['001_referral_lifecycle', 'BASELINE'], ['002_idempotency_keys', 'BASELINE'], ['003_schema_migration', 'APPLIED']]);
    await assert.rejects(runMigrations(await connect(), { baseline: '999' }), /only for a database without/);
  });

  test('an unknown baseline is refused before anything is written', async () => {
    await oldSchemaWithData();
    await assert.rejects(runMigrations(await connect(), { baseline: '042' }), /Unknown baseline "042"/);
    assert.equal(await tableExists('SchemaMigration'), false);
  });

  // ── Ordering ─────────────────────────────────────────────────────────────────────────────────
  test('pending migrations are applied strictly in number order (005 depends on 004)', async () => {
    await freshSchema();
    const dir = migrationsWith({
      '005_probe_column.sql': 'ALTER TABLE ZzRunnerProbeA ADD COLUMN note VARCHAR(20) NULL;',
      '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);'
    });
    const result = await runMigrations(await connect(), { dir });
    assert.deepEqual(result.applied, ['004_probe_table', '005_probe_column']);
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), []);
  });

  test('a pending migration numbered below an applied one is refused (no out-of-order application)', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);', '005_probe_b.sql': 'CREATE TABLE ZzRunnerProbeB (id INT PRIMARY KEY);' });
    // 005 was applied (e.g. from another branch) while 004 never was.
    await admin.query("INSERT INTO SchemaMigration (version, status, checksum, statements_applied) VALUES ('005_probe_b', 'APPLIED', ?, 1)",
      [listMigrationFiles(dir)[4].checksum]);
    await assert.rejects(runMigrations(await connect(), { dir }), /004_probe_table is not applied although a later one is/);
    assert.equal(await tableExists('ZzRunnerProbeA'), false, 'nothing was applied');
    const problems = await checkSchema(admin, { migrationsDir: dir });
    assert.ok(problems.some(p => /out-of-order/.test(p)) && problems.some(p => /pending migrations: 004_probe_table/.test(p)), JSON.stringify(problems));
  });

  // ── Tampering and unknown versions ───────────────────────────────────────────────────────────
  test('an applied migration file that was edited afterwards is refused (checksum mismatch)', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    await runMigrations(await connect(), { dir });
    fs.writeFileSync(path.join(dir, '004_probe_table.sql'), 'CREATE TABLE ZzRunnerProbeA (id BIGINT PRIMARY KEY);');
    await assert.rejects(runMigrations(await connect(), { dir }), /004_probe_table\.sql was changed after it was applied/);
    assert.ok((await checkSchema(admin, { migrationsDir: dir })).some(p => /checksum mismatch/.test(p)));
  });

  test('a migration recorded in the database but unknown to this code is refused', async () => {
    await freshSchema();
    await admin.query("INSERT INTO SchemaMigration (version, status) VALUES ('099_from_newer_code', 'APPLIED')");
    await assert.rejects(runMigrations(await connect()), /099_from_newer_code is recorded in the database but no such file exists/);
  });

  // ── Failure midway and operator recovery ─────────────────────────────────────────────────────
  test('a failure midway is recorded precisely, blocks further runs and start-up, and can be retried', async () => {
    await freshSchema();
    const broken = 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);\nALTER TABLE ZzRunnerProbeA ADD COLUMN broken NOT_A_TYPE;\nALTER TABLE ZzRunnerProbeA ADD COLUMN note VARCHAR(20) NULL;';
    const dir = migrationsWith({ '004_probe_table.sql': broken });
    await assert.rejects(runMigrations(await connect(), { dir }), err => {
      assert.ok(err instanceof MigrationError);
      assert.deepEqual([err.version, err.failedStatement, err.statementsApplied], ['004_probe_table', 2, 1]);
      assert.match(err.message, /statement 2 of 3.*Statements 1-1 stayed applied/s);
      return true;
    });
    const failed = (await rows()).find(r => r.version === '004_probe_table');
    assert.deepEqual([failed.status, failed.statements_applied], ['FAILED', 1]);
    assert.equal(await tableExists('ZzRunnerProbeA'), true, 'statement 1 stayed applied: DDL is not transactional');

    // Nothing is re-run automatically, and the server refuses to start.
    await assert.rejects(runMigrations(await connect(), { dir }), /004_probe_table is FAILED after 1 statement/);
    assert.ok((await checkSchema(admin, { migrationsDir: dir })).some(p => /004_probe_table is FAILED/.test(p)));

    // Operator: undo statement 1, fix the file, then --retry. The fixed file runs from statement 1.
    await admin.query('DROP TABLE ZzRunnerProbeA');
    fs.writeFileSync(path.join(dir, '004_probe_table.sql'), broken.replace(' broken NOT_A_TYPE', ' fixed INT NULL'));
    await retryFailed(await connect(), '004_probe_table');
    assert.deepEqual((await runMigrations(await connect(), { dir })).applied, ['004_probe_table']);
    const applied = (await rows()).find(r => r.version === '004_probe_table');
    assert.deepEqual([applied.status, applied.statements_applied], ['APPLIED', 3]);
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), []);
    await assert.rejects(retryFailed(await connect(), '004_probe_table'), /not FAILED or RUNNING/);
  });

  test('--mark-applied records a failed migration the operator completed by hand', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);\nALTER TABLE ZzRunnerProbeA ADD COLUMN x NOT_A_TYPE;' });
    await assert.rejects(runMigrations(await connect(), { dir }), MigrationError);
    await admin.query('ALTER TABLE ZzRunnerProbeA ADD COLUMN x INT NULL'); // the operator finishes it
    await markApplied(await connect(), '004_probe_table', { dir });
    assert.equal((await rows()).find(r => r.version === '004_probe_table').status, 'APPLIED');
    assert.deepEqual(await runMigrations(await connect(), { dir }), { baselined: [], applied: [], pending: [] });
    await assert.rejects(markApplied(await connect(), '004_probe_table', { dir }), /not FAILED or RUNNING/);
  });

  test('an interrupted run (left RUNNING, e.g. the process was killed) blocks until resolved', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    await admin.query("INSERT INTO SchemaMigration (version, status, checksum, statements_applied) VALUES ('004_probe_table', 'RUNNING', ?, 0)",
      [listMigrationFiles(dir)[3].checksum]);
    await assert.rejects(runMigrations(await connect(), { dir }), /004_probe_table is RUNNING/);
    await retryFailed(await connect(), '004_probe_table');
    assert.deepEqual((await runMigrations(await connect(), { dir })).applied, ['004_probe_table']);
  });

  // ── Concurrency ──────────────────────────────────────────────────────────────────────────────
  test('two runners started together: the advisory lock lets one apply, the other finds nothing to do', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);', '005_probe_b.sql': 'CREATE TABLE ZzRunnerProbeB (id INT PRIMARY KEY);' });
    // Hold the runners' advisory lock so both start while it is taken, then let them race for it.
    const gatekeeper = await connect();
    const lockName = "CONCAT('eris_migrate:', LEFT(SHA2(DATABASE(), 256), 32))";
    assert.equal(Number((await gatekeeper.query(`SELECT GET_LOCK(${lockName}, 5) AS got`))[0][0].got), 1);
    const [connA, connB] = [await connect(), await connect()];
    const both = Promise.all([runMigrations(connA, { dir }), runMigrations(connB, { dir })]);
    await gatekeeper.query(`SELECT RELEASE_LOCK(${lockName})`);
    const [a, b] = await both;
    assert.deepEqual([...a.applied, ...b.applied].sort(), ['004_probe_table', '005_probe_b'], 'each migration applied exactly once');
    assert.ok(a.applied.length === 0 || b.applied.length === 0, 'one runner did all the work while holding the lock');
    assert.deepEqual((await rows()).filter(r => r.version.startsWith('00') && Number(r.version.slice(0, 3)) > 3).map(r => r.status), ['APPLIED', 'APPLIED']);
  });

  // ── Start-up refusal and CLI ─────────────────────────────────────────────────────────────────
  test('the start-up check refuses a database with pending migrations and names them', async () => {
    await freshSchema();
    const dir = migrationsWith({ '004_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), ['pending migrations: 004_probe_table (run `npm run db:migrate`)']);
    assert.deepEqual(await checkSchema(admin), [], 'with the real migrations the fresh database is current');
    const status = await migrationStatus(admin, { dir });
    assert.deepEqual(status.pending.map(p => p.version), ['004_probe_table']);
  });

  test('CLI: `node server/db/migrate.js --status` and a plain run work against the test database', async () => {
    await freshSchema();
    const run = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(MIGRATIONS_DIR, '..', 'migrate.js'), ...args], { env: mysqlServerEnv(0) });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out }));
    });
    const status = await run('--status');
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /001_referral_lifecycle\s+BASELINE/);
    assert.match(status.out, /003_schema_migration\s+BASELINE/);
    if (config.password) assert.equal(status.out.includes(config.password), false, 'the password is never printed');
    const apply = await run();
    assert.equal(apply.code, 0, apply.out);
    assert.match(apply.out, /up to date/);
  });
}
