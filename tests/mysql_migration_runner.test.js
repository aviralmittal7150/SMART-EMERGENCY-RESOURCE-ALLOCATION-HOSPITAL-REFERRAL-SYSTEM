// Migration runner (server/db/migrate.js) against a REAL MySQL server: ordering, re-run safety, adoption of
// a database created before the runner, failure midway (MySQL DDL is not transactional), operator recovery,
// tamper and out-of-order detection, two runners at once, and the start-up refusal.
//
// Synthetic migrations (012/013, after the real 001-011) live only in temporary copies of the migrations directory and create
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
import { createPool } from '../server/db/pool.js';
import { MySqlLockingEngine } from '../server/services/mysqlLockingEngine.js';
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
    await handle.reset(false); // schema.sql (records 001-008 as BASELINE)
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
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable, column_default AS dflt,
              collation_name AS coll
       FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, column_name`);
    const [indexes] = await admin.query(
      `SELECT table_name AS t, index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name NOT LIKE '%_ibfk_%' AND index_name NOT LIKE 'fk_%'
       GROUP BY table_name, index_name ORDER BY table_name, index_name`);
    // Foreign keys with their ON DELETE rule; a named constraint (fk_%) must keep its name, auto-named ones are normalised.
    const [keys] = await admin.query(
      `SELECT k.table_name AS t, k.column_name AS c, k.referenced_table_name AS ref_t, k.referenced_column_name AS ref_c,
              r.delete_rule AS on_delete, IF(LEFT(k.constraint_name, 3) = 'fk_', k.constraint_name, '(auto)') AS name
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
       WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name, k.column_name`);
    return { columns: columns.map(r => ({ ...r })), indexes: indexes.map(r => ({ ...r })), keys: keys.map(r => ({ ...r })) };
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
    assert.deepEqual(plan, { baselined: [], applied: [], pending: ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration', '004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents'] });
    assert.deepEqual(await structure(), shape);
  });

  test('--baseline none applies 001 to 008 in order: identical to a fresh schema, data kept, re-run is a no-op', async () => {
    await freshSchema();
    const fresh = await structure();
    await oldSchemaWithData();
    const conn = await connect();
    const result = await runMigrations(conn, { baseline: 'none' });
    assert.deepEqual(result, { baselined: [], applied: ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration', '004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents'], pending: [] });
    const recorded = await rows();
    const files = listMigrationFiles();
    assert.deepEqual(recorded.map(r => [r.version, r.status, r.checksum, r.statements_applied]),
      [[files[0].version, 'APPLIED', files[0].checksum, 5], [files[1].version, 'APPLIED', files[1].checksum, 1], [files[2].version, 'APPLIED', files[2].checksum, 1],
        [files[3].version, 'APPLIED', files[3].checksum, 2], [files[4].version, 'APPLIED', files[4].checksum, 8],
        [files[5].version, 'APPLIED', files[5].checksum, 3], [files[6].version, 'APPLIED', files[6].checksum, 5],
        [files[7].version, 'APPLIED', files[7].checksum, 5], [files[8].version, 'APPLIED', files[8].checksum, 2],
        [files[9].version, 'APPLIED', files[9].checksum, 1], [files[10].version, 'APPLIED', files[10].checksum, 6]]);
    assert.deepEqual(await structure(), fresh, 'the upgraded database matches a freshly created one');
    assert.equal((await admin.query("SELECT full_name FROM Patient WHERE patient_id = 'PAT-R'"))[0][0].full_name, 'Fictional Runner Patient');
    assert.deepEqual(await checkSchema(conn), []);
    assert.deepEqual(await runMigrations(conn), { baselined: [], applied: [], pending: [] }, 're-run applies nothing');
    await assert.rejects(runMigrations(conn, { baseline: '002' }), /only for a database without a SchemaMigration table/);
  });

  test('--baseline 002 on a database migrated by hand records 001/002 and applies only 003 to 008', async () => {
    await oldSchemaWithData();
    for (const f of listMigrationFiles().slice(0, 2)) await admin.query(f.sql);
    const result = await runMigrations(await connect(), { baseline: '002' });
    assert.deepEqual(result, { baselined: ['001_referral_lifecycle', '002_idempotency_keys'], applied: ['003_schema_migration', '004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents'], pending: [] });
    assert.deepEqual((await rows()).map(r => [r.version, r.status]),
      [['001_referral_lifecycle', 'BASELINE'], ['002_idempotency_keys', 'BASELINE'], ['003_schema_migration', 'APPLIED'],
        ['004_doctor_assignment', 'APPLIED'], ['005_staged_claims', 'APPLIED'], ['006_audit_chain', 'APPLIED'], ['007_analytics_integrity', 'APPLIED'],
        ['008_accounts_and_scoping', 'APPLIED'], ['009_portal_roles', 'APPLIED'], ['010_ambulance_trips', 'APPLIED'], ['011_incidents', 'APPLIED']]);
    await assert.rejects(runMigrations(await connect(), { baseline: '999' }), /only for a database without/);
  });

  test('an unknown baseline is refused before anything is written', async () => {
    await oldSchemaWithData();
    await assert.rejects(runMigrations(await connect(), { baseline: '042' }), /Unknown baseline "042"/);
    assert.equal(await tableExists('SchemaMigration'), false);
  });

  // ── db:init on a database the runner manages but has not finished (finding A1) ──────────────────
  /** A database at migration 003: the pre-runner schema, then 001-003 applied by the runner itself. */
  async function databaseAt003() {
    await oldSchemaWithData();
    const upTo003 = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-003-'));
    tempDirs.push(upTo003);
    for (const f of listMigrationFiles().filter(m => m.number <= 3)) fs.copyFileSync(f.path, path.join(upTo003, f.file));
    const result = await runMigrations(await connect(), { dir: upTo003, baseline: 'none' });
    assert.deepEqual(result.applied, ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration']);
  }
  const chainColumns = async () => (await admin.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'EmergencyHistory' AND column_name = 'chain_seq'"))[0][0].n;

  test('db:init refuses a database at migration 003 and records nothing; db:migrate then upgrades it to the current schema (A1)', async () => {
    await freshSchema();
    const fresh = await structure();
    await databaseAt003();
    const recordedBefore = await rows();
    await assert.rejects(initializeSchema(admin), err => {
      assert.match(err.message, /has not applied 004_doctor_assignment, 005_staged_claims, 006_audit_chain, 007_analytics_integrity, 008_accounts_and_scoping, 009_portal_roles, 010_ambulance_trips, 011_incidents/);
      assert.match(err.message, /npm run db:migrate/);
      return true;
    });
    assert.deepEqual(await rows(), recordedBefore, 'no BASELINE row was recorded for 004-008');
    assert.equal(await tableExists('AuditChainHead'), false, 'schema.sql did not run');
    assert.equal(Number(await chainColumns()), 0);

    const conn = await connect();
    assert.deepEqual((await runMigrations(conn)).applied, ['004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents']);
    assert.deepEqual(await checkSchema(conn), []);
    assert.deepEqual(await structure(), fresh, 'migrated database identical to a fresh one');
    assert.equal((await admin.query("SELECT is_demo FROM EmergencyRequest WHERE request_id = 'REQ-R'"))[0][0].is_demo, 0, 'a real case is not demo');
    await initializeSchema(admin); // every migration recorded now: db:init changes nothing and is allowed
    assert.deepEqual(await structure(), fresh);
  });

  test('007 records as legacy only the unchained rows stored BEFORE the first chained row; a later unchained row stays a break', async () => {
    // Pre-chain history on the pre-runner schema, then 001-006 (chaining starts), chained rows, one late unchained row, then 007.
    await oldSchemaWithData();
    await admin.query("INSERT INTO EmergencyHistory (request_id, event_type) VALUES ('REQ-R', 'LEGACY_A'), ('REQ-R', 'LEGACY_B')");
    const [[{ legacyTop }]] = await admin.query('SELECT MAX(history_id) AS legacyTop FROM EmergencyHistory');
    const upTo006 = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-006-'));
    tempDirs.push(upTo006);
    for (const f of listMigrationFiles().filter(m => m.number <= 6)) fs.copyFileSync(f.path, path.join(upTo006, f.file));
    assert.deepEqual((await runMigrations(await connect(), { dir: upTo006, baseline: 'none' })).applied.at(-1), '006_audit_chain');
    const pool = createPool({ ...config, connectionLimit: 2 });
    try {
      const engine = new MySqlLockingEngine({ pool });
      for (const n of [1, 2]) {
        await engine._tx(conn => engine._audit(conn, { request_id: 'REQ-R', event_type: `CHAINED_${n}`, actor_role: 'SYSTEM' }));
      }
      await admin.query("INSERT INTO EmergencyHistory (request_id, event_type) VALUES ('REQ-R', 'LATE_UNCHAINED')");
      const [[{ late }]] = await admin.query("SELECT history_id AS late FROM EmergencyHistory WHERE event_type = 'LATE_UNCHAINED'");
      assert.ok(Number(late) > Number(legacyTop));

      assert.deepEqual((await runMigrations(await connect())).applied, ['007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents']);
      const [[mark]] = await admin.query('SELECT legacy_max_history_id, legacy_count FROM AuditChainHead WHERE id = 1');
      assert.deepEqual([Number(mark.legacy_max_history_id), Number(mark.legacy_count)], [Number(legacyTop), 2], 'only the 2 pre-chain rows are legacy');

      const v = await engine.verifyAuditChain();
      assert.equal(v.valid, false);
      assert.deepEqual([v.first_break.reason, v.first_break.history_id], ['UNCHAINED_ROW', Number(late)]);
      assert.equal(v.legacy_unchained, 2);
      assert.deepEqual(v.legacy_mark, { max_history_id: Number(legacyTop), count: 2 });
    } finally {
      await pool.end();
    }
  });

  test('checkSchema names the 004-008 columns when the bookkeeping claims migrations that never ran (what db:init used to cause)', async () => {
    await databaseAt003();
    // The old db:init behaviour, reproduced by hand: schema.sql over a 003 database records 004-008 as BASELINE
    // (CREATE TABLE IF NOT EXISTS adds the new tables) but never runs their ALTERs.
    await admin.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await rows()).filter(r => r.status === 'BASELINE').map(r => r.version), ['004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents']);
    const problems = await checkSchema(admin);
    assert.deepEqual(problems, [
      "Doctor.availability_status lacks the 'RESERVED' / 'ASSIGNED' values (migration 004_doctor_assignment)",
      'EmergencyRequest.current_stage is missing (migration 005_staged_claims; run `npm run db:migrate`)',
      'ResourceAllocation.stage_no is missing (migration 005_staged_claims; run `npm run db:migrate`)',
      'Hospital.safety_state is missing (migration 005_staged_claims; run `npm run db:migrate`)',
      'EmergencyHistory.chain_seq is missing (migration 006_audit_chain; run `npm run db:migrate`)',
      'EmergencyHistory.prev_hash is missing (migration 006_audit_chain; run `npm run db:migrate`)',
      'EmergencyHistory.row_hash is missing (migration 006_audit_chain; run `npm run db:migrate`)',
      'EmergencyHistory.event_time_ms is missing (migration 006_audit_chain; run `npm run db:migrate`)',
      'EmergencyRequest.is_demo is missing (migration 007_analytics_integrity; run `npm run db:migrate`)',
      'SystemUser.ambulance_id is missing (migration 008_accounts_and_scoping; run `npm run db:migrate`)',
      'SystemUser.is_demo is missing (migration 008_accounts_and_scoping; run `npm run db:migrate`)',
      'HospitalAcceptance.initiated_by is missing (migration 008_accounts_and_scoping; run `npm run db:migrate`)',
      'EmergencyRequest.created_by is missing (migration 008_accounts_and_scoping; run `npm run db:migrate`)',
      'SystemUser.patient_id is missing (migration 009_portal_roles; run `npm run db:migrate`)',
      'SystemUser.token_version is missing (migration 009_portal_roles; run `npm run db:migrate`)',
      ...['EmergencyRequest.incident_id', 'EmergencyRequest.triage_category', 'EmergencyRequest.arrived_at', 'EmergencyRequest.bed_label',
        'EmergencyRequest.active_bed_key', 'EmergencyRequest.treatment_started_at', 'EmergencyRequest.dispatch_ambulance_id', 'Ambulance.capacity']
        .map(c => `${c} is missing (migration 011_incidents; run \`npm run db:migrate\`)`),
      'EmergencyRequest.request_time must be TIMESTAMP(3) (migration 007_analytics_integrity)'
    ], 'the server refuses to start on it instead of failing at the first audit write');
  });

  // ── Ordering ─────────────────────────────────────────────────────────────────────────────────
  test('pending migrations are applied strictly in number order (013 depends on 012)', async () => {
    await freshSchema();
    const dir = migrationsWith({
      '013_probe_column.sql': 'ALTER TABLE ZzRunnerProbeA ADD COLUMN note VARCHAR(20) NULL;',
      '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);'
    });
    const result = await runMigrations(await connect(), { dir });
    assert.deepEqual(result.applied, ['012_probe_table', '013_probe_column']);
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), []);
  });

  test('a pending migration numbered below an applied one is refused (no out-of-order application)', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);', '013_probe_b.sql': 'CREATE TABLE ZzRunnerProbeB (id INT PRIMARY KEY);' });
    // 013 was applied (e.g. from another branch) while 012 never was.
    await admin.query("INSERT INTO SchemaMigration (version, status, checksum, statements_applied) VALUES ('013_probe_b', 'APPLIED', ?, 1)",
      [listMigrationFiles(dir).find(f => f.version === '013_probe_b').checksum]);
    await assert.rejects(runMigrations(await connect(), { dir }), /012_probe_table is not applied although a later one is/);
    assert.equal(await tableExists('ZzRunnerProbeA'), false, 'nothing was applied');
    const problems = await checkSchema(admin, { migrationsDir: dir });
    assert.ok(problems.some(p => /out-of-order/.test(p)) && problems.some(p => /pending migrations: 012_probe_table/.test(p)), JSON.stringify(problems));
  });

  // ── Tampering and unknown versions ───────────────────────────────────────────────────────────
  test('an applied migration file that was edited afterwards is refused (checksum mismatch)', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    await runMigrations(await connect(), { dir });
    fs.writeFileSync(path.join(dir, '012_probe_table.sql'), 'CREATE TABLE ZzRunnerProbeA (id BIGINT PRIMARY KEY);');
    await assert.rejects(runMigrations(await connect(), { dir }), /012_probe_table\.sql was changed after it was applied/);
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
    const dir = migrationsWith({ '012_probe_table.sql': broken });
    await assert.rejects(runMigrations(await connect(), { dir }), err => {
      assert.ok(err instanceof MigrationError);
      assert.deepEqual([err.version, err.failedStatement, err.statementsApplied], ['012_probe_table', 2, 1]);
      assert.match(err.message, /statement 2 of 3.*Statements 1-1 stayed applied/s);
      return true;
    });
    const failed = (await rows()).find(r => r.version === '012_probe_table');
    assert.deepEqual([failed.status, failed.statements_applied], ['FAILED', 1]);
    assert.equal(await tableExists('ZzRunnerProbeA'), true, 'statement 1 stayed applied: DDL is not transactional');

    // Nothing is re-run automatically, and the server refuses to start.
    await assert.rejects(runMigrations(await connect(), { dir }), /012_probe_table is FAILED after 1 statement/);
    assert.ok((await checkSchema(admin, { migrationsDir: dir })).some(p => /012_probe_table is FAILED/.test(p)));

    // Operator: undo statement 1, fix the file, then --retry. The fixed file runs from statement 1.
    await admin.query('DROP TABLE ZzRunnerProbeA');
    fs.writeFileSync(path.join(dir, '012_probe_table.sql'), broken.replace(' broken NOT_A_TYPE', ' fixed INT NULL'));
    await retryFailed(await connect(), '012_probe_table');
    assert.deepEqual((await runMigrations(await connect(), { dir })).applied, ['012_probe_table']);
    const applied = (await rows()).find(r => r.version === '012_probe_table');
    assert.deepEqual([applied.status, applied.statements_applied], ['APPLIED', 3]);
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), []);
    await assert.rejects(retryFailed(await connect(), '012_probe_table'), /not FAILED or RUNNING/);
  });

  test('--mark-applied records a failed migration the operator completed by hand', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);\nALTER TABLE ZzRunnerProbeA ADD COLUMN x NOT_A_TYPE;' });
    await assert.rejects(runMigrations(await connect(), { dir }), MigrationError);
    await admin.query('ALTER TABLE ZzRunnerProbeA ADD COLUMN x INT NULL'); // the operator finishes it
    await markApplied(await connect(), '012_probe_table', { dir });
    assert.equal((await rows()).find(r => r.version === '012_probe_table').status, 'APPLIED');
    assert.deepEqual(await runMigrations(await connect(), { dir }), { baselined: [], applied: [], pending: [] });
    await assert.rejects(markApplied(await connect(), '012_probe_table', { dir }), /not FAILED or RUNNING/);
  });

  test('an interrupted run (left RUNNING, e.g. the process was killed) blocks until resolved', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    await admin.query("INSERT INTO SchemaMigration (version, status, checksum, statements_applied) VALUES ('012_probe_table', 'RUNNING', ?, 0)",
      [listMigrationFiles(dir).find(f => f.version === '012_probe_table').checksum]);
    await assert.rejects(runMigrations(await connect(), { dir }), /012_probe_table is RUNNING/);
    await retryFailed(await connect(), '012_probe_table');
    assert.deepEqual((await runMigrations(await connect(), { dir })).applied, ['012_probe_table']);
  });

  // ── Concurrency ──────────────────────────────────────────────────────────────────────────────
  test('two runners started together: the advisory lock lets one apply, the other finds nothing to do', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);', '013_probe_b.sql': 'CREATE TABLE ZzRunnerProbeB (id INT PRIMARY KEY);' });
    // Hold the runners' advisory lock so both start while it is taken, then let them race for it.
    const gatekeeper = await connect();
    const lockName = "CONCAT('eris_migrate:', LEFT(SHA2(DATABASE(), 256), 32))";
    assert.equal(Number((await gatekeeper.query(`SELECT GET_LOCK(${lockName}, 5) AS got`))[0][0].got), 1);
    const [connA, connB] = [await connect(), await connect()];
    const both = Promise.all([runMigrations(connA, { dir }), runMigrations(connB, { dir })]);
    await gatekeeper.query(`SELECT RELEASE_LOCK(${lockName})`);
    const [a, b] = await both;
    assert.deepEqual([...a.applied, ...b.applied].sort(), ['012_probe_table', '013_probe_b'], 'each migration applied exactly once');
    assert.ok(a.applied.length === 0 || b.applied.length === 0, 'one runner did all the work while holding the lock');
    assert.deepEqual((await rows()).filter(r => /_probe_/.test(r.version)).map(r => [r.version, r.status]),
      [['012_probe_table', 'APPLIED'], ['013_probe_b', 'APPLIED']]);
  });

  // ── Migrations 004-009: the documented manual rollbacks ──────────────────────────────────────
  test('011, 010, 009, 008, 007, 006, 005 then 004 rollback: the SQL in server/db/migrations/README.md undoes each on a database with live data, and all re-apply', async () => {
    await freshSchema();
    const readme = fs.readFileSync(path.join(MIGRATIONS_DIR, 'README.md'), 'utf8');
    const sqlAfter = marker => {
      const block = readme.slice(readme.indexOf(marker)).match(/```sql\n([\s\S]*?)```/)?.[1];
      assert.ok(block, `the README has a rollback SQL block after ${marker}`);
      return block.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(x => x.trim()).filter(Boolean);
    };
    const rollback011 = sqlAfter('**Manual rollback of 011.**');
    assert.equal(rollback011.length, 9);
    const rollback010 = sqlAfter('**Manual rollback of 010.**');
    assert.equal(rollback010.length, 2);
    const rollback009 = sqlAfter('**Manual rollback of 009.**');
    assert.equal(rollback009.length, 4);
    const rollback008 = sqlAfter('**Manual rollback of 008.**');
    assert.equal(rollback008.length, 7);
    const rollback007 = sqlAfter('**Manual rollback of 007.**');
    assert.equal(rollback007.length, 4);
    const rollback006 = sqlAfter('**Manual rollback of 006.**');
    const rollback005 = sqlAfter('**Manual rollback of 005.**');
    assert.equal(rollback006.length, 4);
    const statements = sqlAfter('**Manual rollback** (there is no automatic down-migration)');
    assert.equal(rollback005.length, 5);
    assert.equal(statements.length, 4);

    // A doctor held by a case, as in production at the moment of a rollback.
    await admin.query(`
      INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone) VALUES ('H-RB', 'Fictional Rollback Hospital', 'Fictional Ave', 28.6, 77.2, '000');
      INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status) VALUES ('DR-RB', 'H-RB', 'Fictional Surgeon', 'TRAUMA_SURGEON', 'ASSIGNED');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-RB', 'Fictional Rollback Patient', 40, 'TRAUMA');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status) VALUES ('REQ-RB', 'PAT-RB', 'TRAUMA', 1, 'ALLOCATED');
      INSERT INTO DoctorAssignment (assignment_id, doctor_id, request_id, hospital_id, status) VALUES ('DA-RB', 'DR-RB', 'REQ-RB', 'H-RB', 'COMMITTED');
      INSERT INTO RequestClaim (request_id, stage_no, resource_type) VALUES ('REQ-RB', 1, 'OT'), ('REQ-RB', 1, 'TRAUMA_SURGEON'), ('REQ-RB', 2, 'ICU_BED');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-001', 'Fictional Demo Patient', 58, 'CARDIAC'), ('PAT-RB2', 'Fictional Real Patient', 30, 'CARDIAC');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status, is_demo, request_time)
        VALUES ('REQ-8901', 'PAT-001', 'CARDIAC', 1, 'WAITING', 1, '2026-02-02 06:00:00.250'),
               ('REQ-8902', 'PAT-RB2', 'CARDIAC', 1, 'WAITING', 0, '2026-02-02 06:00:01.750');
      INSERT INTO EmergencyHistory (history_id, event_type) VALUES (41, 'FICTIONAL_PRE_CHAIN_EVENT');
      INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number) VALUES ('AMB-RB', 'H-RB', 'VEH-RB');
      INSERT INTO SystemUser (user_id, username, password_hash, role, display_name, ambulance_id, is_demo)
        VALUES ('USER-RB', 'Fictional.Medic', '$2b$10$76rFLj36eOVlkfsODAHrF.wi4WjpP9LmFH7O8TGNZh236k06Uqt5u', 'PARAMEDIC', 'Fictional Medic', 'AMB-RB', 0);
      UPDATE EmergencyRequest SET created_by = 'USER-RB' WHERE request_id = 'REQ-8902';
      INSERT INTO IdempotencyKey (actor_id, endpoint, idem_key, request_hash, resource_id) VALUES ('USER-RB', 'POST /emergencies', 'Key-A', REPEAT('a', 64), 'REQ-8902'),
        ('USER-RB', 'POST /emergencies', 'key-a', REPEAT('b', 64), 'REQ-8902');
      INSERT INTO SystemUser (user_id, username, password_hash, role, display_name, patient_id, is_demo)
        VALUES ('USER-RB-PAT', 'fictional.rb.patient', 'x', 'PATIENT', 'Fictional Patient', 'PAT-RB2', 0),
               ('USER-RB-DSP', 'fictional.rb.dispatch', 'x', 'DISPATCHER', 'Fictional Operator', NULL, 0);
      UPDATE Ambulance SET status = 'IN_TRANSIT', assigned_request_id = 'REQ-RB' WHERE ambulance_id = 'AMB-RB';
      INSERT INTO AmbulanceTrip (trip_id, request_id, ambulance_id, hospital_id, start_lat, start_lng, speed_kmh, route_to_patient, route_to_hospital,
                                 route_source, phase, progress, current_lat, current_lng)
        VALUES ('TRIP-RB', 'REQ-RB', 'AMB-RB', 'H-RB', 28.6, 77.2, 60, '[[28.6, 77.2], [28.61, 77.2]]', '[[28.61, 77.2], [28.6, 77.2]]',
                'simulated', 'EN_ROUTE_TO_PATIENT', 0.5, 28.605, 77.2);`);
    // 011 data: an incident with a victim of unknown age holding a bed, a progress note, a seat on AMB-RB.
    await admin.query(`
      INSERT INTO Incident (incident_id, title, incident_type, location_lat, location_lng, severity) VALUES ('INC-RB', 'Fictional Rollback Crash', 'bus_crash', 28.6, 77.2, 'high');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-RB3', 'MCI-001', NULL, 'GENERAL');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status, incident_id, incident_seq, triage_category, arrived_at, bed_label, bed_hospital_id)
        VALUES ('REQ-RB3', 'PAT-RB3', 'GENERAL', 3, 'IN_TREATMENT', 'INC-RB', 1, 'YELLOW', NOW(3), 'Ward A-1', 'H-RB');
      INSERT INTO TreatmentUpdate (update_id, request_id, hospital_id, author_id, note) VALUES ('TU-RB', 'REQ-RB3', 'H-RB', 'USER-RB', 'Fictional note');
      INSERT INTO AmbulanceAssignment (assignment_id, ambulance_id, request_id, triage_category) VALUES ('AA-RB', 'AMB-RB', 'REQ-RB3', 'YELLOW');`);
    // 011: one open case per bed label per hospital, and one active seat per case, guaranteed by the database.
    await assert.rejects(admin.query(`INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status, bed_label, bed_hospital_id)
      VALUES ('REQ-RB4', 'PAT-RB3', 'GENERAL', 3, 'ALLOCATED', 'ward a-1', 'H-RB')`), /Duplicate entry .*uq_active_bed/);
    await assert.rejects(admin.query("INSERT INTO AmbulanceAssignment (assignment_id, ambulance_id, request_id) VALUES ('AA-RB2', 'AMB-RB', 'REQ-RB3')"),
      /Duplicate entry .*uq_assignment_active_request/);
    // 010: at most one active trip per ambulance and per case, guaranteed by the database (generated unique keys).
    await assert.rejects(admin.query(`INSERT INTO AmbulanceTrip (trip_id, request_id, ambulance_id, hospital_id, start_lat, start_lng, speed_kmh,
      route_to_patient, route_to_hospital, route_source, current_lat, current_lng)
      VALUES ('TRIP-RB2', 'REQ-8901', 'AMB-RB', 'H-RB', 28.6, 77.2, 60, '[]', '[]', 'simulated', 28.6, 77.2)`), /Duplicate entry .*uq_trip_active_ambulance/);
    assert.equal((await admin.query("SELECT COUNT(*) AS n FROM IdempotencyKey WHERE idem_key = 'key-a'"))[0][0].n, 1, '008: keys are case-sensitive');
    await assert.rejects(admin.query("DELETE FROM Doctor WHERE doctor_id = 'DR-RB'"), /foreign key constraint fails/,
      'ON DELETE RESTRICT: a doctor with assignment history cannot be deleted');
    const withAssignment = await structure();

    const columnType = async (table, column) => (await admin.query(
      'SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]))[0][0]?.t ?? null;
    const collation = async (table, column) => (await admin.query(
      'SELECT collation_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]))[0][0]?.c;
    const auditRows = async () => Number((await admin.query('SELECT COUNT(*) AS n FROM EmergencyHistory'))[0][0].n);
    const historyBefore = await auditRows();
    // 011 first: its tables and columns go; the cases stay; an unknown age becomes 0 (documented).
    for (const statement of rollback011) await admin.query(statement);
    for (const table of ['Incident', 'TreatmentUpdate', 'AmbulanceAssignment']) assert.equal(await tableExists(table), false, `011 rollback drops ${table}`);
    for (const [table, column] of [['EmergencyRequest', 'incident_id'], ['EmergencyRequest', 'active_bed_key'], ['EmergencyRequest', 'arrived_at'], ['Ambulance', 'capacity']]) {
      assert.equal(await columnType(table, column), null, `011 rollback drops ${table}.${column}`);
    }
    assert.deepEqual({ ...(await admin.query("SELECT r.status, p.age FROM EmergencyRequest r JOIN Patient p USING (patient_id) WHERE request_id = 'REQ-RB3'"))[0][0] },
      { status: 'IN_TREATMENT', age: 0 }, 'the case stays');
    assert.equal(await auditRows(), historyBefore, 'audit rows are immutable: none removed');
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['010_ambulance_trips'], '011 is forgotten');
    assert.ok((await checkSchema(admin)).some(p => /pending migrations: 011_incidents/.test(p)));
    await admin.query("DELETE FROM EmergencyRequest WHERE request_id = 'REQ-RB3'; DELETE FROM Patient WHERE patient_id = 'PAT-RB3'");
    // 010 next: the trips go (their audit rows would stay), nothing else changes.
    for (const statement of rollback010) await admin.query(statement);
    assert.equal(await tableExists('AmbulanceTrip'), false, '010 rollback drops AmbulanceTrip');
    assert.equal(await auditRows(), historyBefore, 'audit rows are immutable: none removed');
    assert.equal((await admin.query("SELECT status FROM Ambulance WHERE ambulance_id = 'AMB-RB'"))[0][0].status, 'IN_TRANSIT', 'the unit is untouched');
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['009_portal_roles'], '010 is forgotten');
    assert.ok((await checkSchema(admin)).some(p => /missing table AmbulanceTrip/.test(p)) && (await checkSchema(admin)).some(p => /pending migrations: 010_ambulance_trips/.test(p)));
    // 009 next: accounts with the new roles go (earlier code cannot represent them), then the column and the enum.
    for (const statement of rollback009) await admin.query(statement);
    assert.equal(await columnType('SystemUser', 'patient_id'), null, '009 rollback drops SystemUser.patient_id');
    assert.equal(await columnType('SystemUser', 'token_version'), null, '009 rollback drops SystemUser.token_version');
    assert.equal(await columnType('SystemUser', 'role'), "enum('ADMIN','HOSPITAL_DESK','PARAMEDIC')");
    assert.deepEqual((await admin.query("SELECT user_id FROM SystemUser ORDER BY user_id"))[0].map(r => r.user_id), ['USER-RB'], 'only the new-role accounts were removed');
    assert.equal(await columnType('EmergencyHistory', 'actor_role'), "enum('SYSTEM','ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER')",
      'audit rows are immutable: actor_role keeps DISPATCHER');
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['008_accounts_and_scoping'], '009 is forgotten');
    assert.ok((await checkSchema(admin)).some(p => /pending migrations: 009_portal_roles/.test(p)));
    for (const statement of rollback008) await admin.query(statement);
    for (const [table, column] of [['SystemUser', 'ambulance_id'], ['SystemUser', 'is_demo'], ['SystemUser', 'display_name'],
      ['HospitalAcceptance', 'initiated_by'], ['EmergencyRequest', 'created_by']]) {
      assert.equal(await columnType(table, column), null, `008 rollback drops ${table}.${column}`);
    }
    assert.notEqual(await collation('SystemUser', 'username'), 'utf8mb4_bin', '008 rollback restores the default collation');
    assert.notEqual(await collation('IdempotencyKey', 'idem_key'), 'utf8mb4_bin');
    assert.equal((await admin.query("SELECT username FROM SystemUser WHERE user_id = 'USER-RB'"))[0][0].username, 'Fictional.Medic', 'the account stays');
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['007_analytics_integrity'], '008 is forgotten');
    assert.ok((await checkSchema(admin)).some(p => /pending migrations: 008_accounts_and_scoping/.test(p)));
    for (const statement of rollback007) await admin.query(statement);
    assert.equal(await columnType('EmergencyRequest', 'is_demo'), null, '007 rollback drops is_demo');
    assert.deepEqual([await columnType('AuditChainHead', 'legacy_max_history_id'), await columnType('AuditChainHead', 'legacy_count')], [null, null],
      '007 rollback drops the recorded legacy mark');
    assert.equal(await columnType('EmergencyRequest', 'request_time'), 'timestamp', '007 rollback restores second precision');
    assert.equal((await admin.query("SHOW INDEX FROM HospitalAcceptance WHERE Key_name = 'idx_created_at'"))[0].length, 0);
    assert.equal((await admin.query("SELECT COUNT(*) AS n FROM EmergencyRequest WHERE request_id IN ('REQ-8901', 'REQ-8902')"))[0][0].n, 2, 'the rows stay');
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['006_audit_chain'], '007 is forgotten');
    for (const statement of rollback006) await admin.query(statement);
    assert.equal(await tableExists('AuditChainHead'), false);
    for (const statement of rollback005) await admin.query(statement);
    assert.equal(await tableExists('RequestClaim'), false);
    assert.deepEqual((await rows()).map(r => r.version).slice(-1), ['004_doctor_assignment'], '006 and 005 are forgotten, 004 still recorded');
    for (const statement of statements) await admin.query(statement);
    assert.equal(await tableExists('DoctorAssignment'), false);
    assert.equal((await admin.query("SELECT availability_status AS s FROM Doctor WHERE doctor_id = 'DR-RB'"))[0][0].s, 'AVAILABLE');
    const [[enumRow]] = await admin.query(
      "SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'Doctor' AND column_name = 'availability_status'");
    assert.equal(enumRow.t, "enum('AVAILABLE','IN_PROCEDURE','OFF_DUTY')");
    assert.deepEqual((await rows()).map(r => r.version), ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration']);
    // What the previous release sees: its own migrations (001-003) only, nothing pending, nothing unknown.
    const previousRelease = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-prev-'));
    tempDirs.push(previousRelease);
    for (const f of listMigrationFiles().filter(m => m.number <= 3)) fs.copyFileSync(f.path, path.join(previousRelease, f.file));
    const prevProblems = (await checkSchema(admin, { migrationsDir: previousRelease }))
      // this release's checks still name what 004-008 add; the previous release does not look for them
      .filter(p => !/missing table (DoctorAssignment|RequestClaim|AuditChainHead|AmbulanceTrip|Incident|TreatmentUpdate|AmbulanceAssignment)|\(migration 0(0[4-9]|1[01])_/.test(p));
    assert.deepEqual(prevProblems, []);
    // ...while this release's code reports 004 as pending and refuses to start.
    assert.ok((await checkSchema(admin)).some(p => /pending migrations: 004_doctor_assignment, 005_staged_claims, 006_audit_chain, 007_analytics_integrity, 008_accounts_and_scoping, 009_portal_roles, 010_ambulance_trips, 011_incidents/.test(p)));

    // Rolling forward again restores exactly the structure 004-008 create (columns include their collations).
    assert.deepEqual((await runMigrations(await connect())).applied, ['004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents']);
    const restored = await structure();
    assert.deepEqual(restored.columns, withAssignment.columns, 'rolling forward restores the exact columns');
    assert.deepEqual(restored.indexes, withAssignment.indexes);
    assert.deepEqual(restored.keys, withAssignment.keys, 'rolling forward restores the foreign keys, fk_user_ambulance included');
    assert.ok(restored.keys.some(k => k.name === 'fk_user_ambulance' && k.on_delete === 'SET NULL'));
    assert.deepEqual(await checkSchema(admin), []);
    // Re-applying 007 records the legacy rows present at that moment: the one unchained row (nothing is chained yet).
    assert.deepEqual({ ...(await admin.query('SELECT legacy_max_history_id AS max_id, legacy_count AS n FROM AuditChainHead WHERE id = 1'))[0][0] },
      { max_id: 41, n: 1 });
    // 007's backfill marks only the known demo case owned by its demo patient; the rollback rounded request times to
    // whole seconds (.250 -> :00, .750 -> :02), which re-applying cannot restore (documented in the README).
    assert.deepEqual((await admin.query("SELECT request_id, is_demo, DATE_FORMAT(request_time, '%H:%i:%s.%f') AS t FROM EmergencyRequest WHERE request_id IN ('REQ-8901', 'REQ-8902') ORDER BY request_id"))[0]
      .map(r => [r.request_id, r.is_demo, r.t]), [['REQ-8901', 1, '06:00:00.000000'], ['REQ-8902', 0, '06:00:02.000000']]);
  });

  // ── Start-up refusal and CLI ─────────────────────────────────────────────────────────────────
  test('the start-up check refuses a database with pending migrations and names them', async () => {
    await freshSchema();
    const dir = migrationsWith({ '012_probe_table.sql': 'CREATE TABLE ZzRunnerProbeA (id INT PRIMARY KEY);' });
    assert.deepEqual(await checkSchema(admin, { migrationsDir: dir }), ['pending migrations: 012_probe_table (run `npm run db:migrate`)']);
    assert.deepEqual(await checkSchema(admin), [], 'with the real migrations the fresh database is current');
    const status = await migrationStatus(admin, { dir });
    assert.deepEqual(status.pending.map(p => p.version), ['012_probe_table']);
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
    assert.match(status.out, /004_doctor_assignment\s+BASELINE/);
    assert.match(status.out, /005_staged_claims\s+BASELINE/);
    assert.match(status.out, /006_audit_chain\s+BASELINE/);
    assert.match(status.out, /007_analytics_integrity\s+BASELINE/);
    assert.match(status.out, /008_accounts_and_scoping\s+BASELINE/);
    assert.match(status.out, /009_portal_roles\s+BASELINE/);
    assert.match(status.out, /010_ambulance_trips\s+BASELINE/);
    assert.match(status.out, /011_incidents\s+BASELINE/);
    if (config.password) assert.equal(status.out.includes(config.password), false, 'the password is never printed');
    const apply = await run();
    assert.equal(apply.code, 0, apply.out);
    assert.match(apply.out, /up to date/);
  });
}
