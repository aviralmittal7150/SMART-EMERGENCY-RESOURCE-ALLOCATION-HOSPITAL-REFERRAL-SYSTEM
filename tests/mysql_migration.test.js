// The additive migrations (server/db/migrations/001_referral_lifecycle.sql, 002_idempotency_keys.sql)
// tested for real on MySQL, as they were applied by hand before the migration runner existed:
//   old schema  ->  start-up check rejects it  ->  001 + 002  ->  runner adopted with --baseline 002
//   -> check passes -> structure identical to a freshly created schema, data untouched, engine works on it.
// The runner itself is tested in tests/mysql_migration_runner.test.js.
// Runs only against the dedicated *_test database; skipped (not failed) when it is not configured,
// and a failure in CI (REQUIRE_MYSQL_TESTS=true). All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestDatabase } from './helpers/mysqlTestDb.js';
import { createPool } from '../server/db/pool.js';
import { checkSchema } from '../server/db/bootstrap.js';
import { SCHEMA_TABLES, MIGRATED_TABLES, initializeSchema, seedDemoData } from '../server/db/init.js';
import { runMigrations } from '../server/db/migrate.js';
import { MySqlLockingEngine } from '../server/services/mysqlLockingEngine.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const MIGRATION_002 = '../server/db/migrations/002_idempotency_keys.sql';
const IDEMPOTENCY_MISSING = 'missing table IdempotencyKey (run server/db/migrations/002_idempotency_keys.sql)';
// A database migrated by hand predates the runner: its bookkeeping table is missing until it is adopted.
const RUNNER_NOT_ADOPTED = `missing table SchemaMigration (run ${MIGRATED_TABLES.SchemaMigration})`;
// ...and so is the specialist-assignment table of migration 004, which only the runner applies.
const ASSIGNMENTS_MISSING = `missing table DoctorAssignment (run ${MIGRATED_TABLES.DoctorAssignment})`;
const CLAIMS_MISSING = `missing table RequestClaim (run ${MIGRATED_TABLES.RequestClaim})`;
const CHAIN_MISSING = `missing table AuditChainHead (run ${MIGRATED_TABLES.AuditChainHead})`;
const TRIPS_MISSING = `missing table AmbulanceTrip (run ${MIGRATED_TABLES.AmbulanceTrip})`;
// Migration 011 (Batch 8): three tables.
const BATCH8_MISSING = ['Incident', 'TreatmentUpdate', 'AmbulanceAssignment'].map(t => `missing table ${t} (run ${MIGRATED_TABLES[t]})`);
// What migrations 004-009 add to existing tables: checkSchema names each one until the runner has applied them (A1).
const LATER_COLUMNS = [
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
  ...[['EmergencyRequest', 'incident_id'], ['EmergencyRequest', 'triage_category'], ['EmergencyRequest', 'arrived_at'], ['EmergencyRequest', 'bed_label'],
    ['EmergencyRequest', 'active_bed_key'], ['EmergencyRequest', 'treatment_started_at'], ['EmergencyRequest', 'dispatch_ambulance_id'], ['Ambulance', 'capacity']]
    .map(([t, c]) => `${t}.${c} is missing (migration 011_incidents; run \`npm run db:migrate\`)`),
  'EmergencyRequest.request_time must be TIMESTAMP(3) (migration 007_analytics_integrity)'
];
const handle = await openTestDatabase();

if (handle.skip) {
  test.skip(`MySQL schema migration (skipped: ${handle.skip})`, () => {});
} else {
  const { admin, config } = handle;
  const pool = createPool({ ...config, connectionLimit: 5 });
  const engine = new MySqlLockingEngine({ pool });

  const dropAll = () => {
    // Defence in depth: the helper already refuses non-*_test databases; re-check before any DROP.
    if (!/_test$/.test(config.database)) throw new Error(`Refusing to drop tables in "${config.database}".`);
    return admin.query(
    `SET FOREIGN_KEY_CHECKS = 0; ${SCHEMA_TABLES.map(t => `DROP TABLE IF EXISTS \`${t}\``).join('; ')}; SET FOREIGN_KEY_CHECKS = 1`
    );
  };

  // Structure only: column definitions, indexes and foreign keys (names of auto-generated keys and
  // column order are not meaningful, so they are normalised away).
  async function structure() {
    const [columns] = await admin.query(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable, column_default AS dflt,
              collation_name AS coll
       FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, column_name`
    );
    const [indexes] = await admin.query(
      `SELECT table_name AS t, index_name AS name, non_unique AS nonunique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics WHERE table_schema = DATABASE()
       GROUP BY table_name, index_name, non_unique ORDER BY table_name, index_name`
    );
    const [keys] = await admin.query(
      `SELECT k.table_name AS t, k.column_name AS c, k.referenced_table_name AS ref_t, k.referenced_column_name AS ref_c, r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
       WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name, k.column_name`
    );
    // An FK-supporting index that MySQL created implicitly carries the constraint's name; ignore those.
    const fkNames = new Set((await admin.query(
      'SELECT constraint_name AS n FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()'
    ))[0].map(r => r.n));
    return {
      columns: columns.map(r => ({ ...r })),
      indexes: indexes.filter(i => !fkNames.has(i.name)).map(r => ({ ...r })),
      keys: keys.map(r => ({ ...r }))
    };
  }

  test.after(async () => {
    await handle.reset(true); // leave the database on the current schema for whoever runs next
    await pool.end();
    await handle.release();
  });

  test('migration upgrades the previous schema to exactly the current one, keeps data, and the engine works on it', async () => {
    // 1. Current schema -> reference structure.
    await dropAll();
    await admin.query(read('../server/db/schema.sql'));
    const fresh = await structure();
    assert.deepEqual(await checkSchema(pool), [], 'the current schema passes the start-up check');
    assert.equal(fresh.keys.find(k => k.t === 'EmergencyHistory' && k.c === 'request_id').on_delete, 'SET NULL',
      'reference: audit rows are kept when their case row goes');
    assert.equal(fresh.columns.find(c => c.t === 'EmergencyHistory' && c.c === 'request_id').nullable, 'YES');

    // 2. Previous schema with some existing data.
    await dropAll();
    await admin.query(read('./fixtures/schema_before_lifecycle.sql'));
    await admin.query(`
      INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone)
        VALUES ('H-M', 'Hospital Migrated', 'Fictional Ave', 28.6, 77.2, '000');
      INSERT INTO MedicalResource (resource_id, hospital_id, resource_type, total_capacity, available_capacity)
        VALUES ('RES-M-ICU', 'H-M', 'ICU_BED', 2, 1);
      INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status)
        VALUES ('AMB-M', 'H-M', 'VEH-M', 'ALS', 'AVAILABLE');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-M', 'Fictional Migrated Patient', 61, 'RESPIRATORY');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status)
        VALUES ('REQ-M', 'PAT-M', 'RESPIRATORY', 2, 'WAITING');
      INSERT INTO HospitalAcceptance (acceptance_id, request_id, hospital_id, status, lock_expires_at)
        VALUES ('ACC-OLD', 'REQ-M', 'H-M', 'REJECTED', NOW());
      INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, new_state, actor_role, actor_id)
        VALUES ('REQ-M', 'H-M', 'REQUEST_CREATED', 'WAITING', 'PARAMEDIC', 'USER-EMS-001');
    `);
    const before = (await admin.query('SELECT (SELECT COUNT(*) FROM Patient) p, (SELECT COUNT(*) FROM EmergencyRequest) r, (SELECT COUNT(*) FROM EmergencyHistory) h, (SELECT COUNT(*) FROM HospitalAcceptance) a'))[0][0];

    // 3. The start-up check rejects the old schema and says what is missing.
    const problems = await checkSchema(pool);
    for (const expected of ['Ambulance.assigned_request_id', 'Ambulance.destination_hospital_id',
      'EmergencyRequest.required_resources', 'EmergencyRequest.required_specialist', "'CANCELLED'", 'EmergencyHistory.request_id']) {
      assert.ok(problems.some(p => p.includes(expected)), `expected a problem mentioning ${expected}; got ${JSON.stringify(problems)}`);
    }

    // 4. Apply the real migration file.
    await admin.query(read('../server/db/migrations/001_referral_lifecycle.sql'));
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING, RUNNER_NOT_ADOPTED, ASSIGNMENTS_MISSING, CLAIMS_MISSING, CHAIN_MISSING, TRIPS_MISSING, ...BATCH8_MISSING, ...LATER_COLUMNS], 'after 001 the 002 table is missing, and it is named');
    await admin.query(read(MIGRATION_002));
    await admin.query(read(MIGRATION_002)); // 002 is re-runnable
    assert.deepEqual(await checkSchema(pool), [RUNNER_NOT_ADOPTED, ASSIGNMENTS_MISSING, CLAIMS_MISSING, CHAIN_MISSING, TRIPS_MISSING, ...BATCH8_MISSING, ...LATER_COLUMNS], 'only what the runner applies (its bookkeeping, then 004-008) is missing now');
    // Adopt the runner: declare that 001 and 002 are already applied; it then applies 003 to 008.
    const adopted = await runMigrations(admin, { baseline: '002' });
    assert.deepEqual(adopted, {
      baselined: ['001_referral_lifecycle', '002_idempotency_keys'],
      applied: ['003_schema_migration', '004_doctor_assignment', '005_staged_claims', '006_audit_chain', '007_analytics_integrity',
        '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents'], pending: []
    });
    assert.deepEqual(await checkSchema(pool), [], 'the migrated schema passes the start-up check');

    // 5. An upgraded database is structurally identical to a fresh one.
    const migrated = await structure();
    assert.deepEqual(migrated.columns, fresh.columns, 'same columns, types, nullability, defaults and collations');
    assert.deepEqual(migrated.indexes, fresh.indexes, 'same indexes');
    assert.deepEqual(migrated.keys, fresh.keys, 'same foreign keys, including ON DELETE rules (audit rows must outlive their case)');

    // 6. Existing rows are untouched.
    const after = (await admin.query('SELECT (SELECT COUNT(*) FROM Patient) p, (SELECT COUNT(*) FROM EmergencyRequest) r, (SELECT COUNT(*) FROM EmergencyHistory) h, (SELECT COUNT(*) FROM HospitalAcceptance) a'))[0][0];
    assert.deepEqual({ ...after }, { ...before });
    assert.equal((await admin.query("SELECT full_name FROM Patient WHERE patient_id = 'PAT-M'"))[0][0].full_name, 'Fictional Migrated Patient');
    assert.equal((await admin.query("SELECT status FROM HospitalAcceptance WHERE acceptance_id = 'ACC-OLD'"))[0][0].status, 'REJECTED');
    // 008 backfills who registered each case from its REQUEST_CREATED audit row (paramedics keep seeing their cases).
    assert.equal((await admin.query("SELECT created_by FROM EmergencyRequest WHERE request_id = 'REQ-M'"))[0][0].created_by, 'USER-EMS-001');

    // 7. The locking engine works on the migrated database (it writes the new Ambulance columns).
    const lock = await engine.acquireSoftLock('H-M', 'REQ-M', ['ICU_BED']);
    const committed = await engine.commitAllocation(lock.acceptanceId, 'TEST');
    assert.equal(committed.ambulance_id, 'AMB-M');
    const unit = (await admin.query("SELECT status, assigned_request_id, destination_hospital_id FROM Ambulance WHERE ambulance_id = 'AMB-M'"))[0][0];
    assert.deepEqual({ ...unit }, { status: 'DISPATCHED', assigned_request_id: 'REQ-M', destination_hospital_id: 'H-M' });
    await engine.closeRequest('REQ-M', 'COMPLETED');

    // 7b. The pre-chain audit row is legacy (recorded by migration 007), and the chain written since verifies.
    const head = (await admin.query('SELECT legacy_max_history_id AS max_id, legacy_count AS n FROM AuditChainHead WHERE id = 1'))[0][0];
    assert.equal(Number(head.n), 1, 'migration 007 recorded the one pre-chain row as legacy');
    const verified = await engine.verifyAuditChain();
    assert.equal(verified.valid, true, JSON.stringify(verified.first_break));
    assert.ok(verified.checked >= 3, 'lock, accept and close were chained');
    assert.deepEqual([verified.legacy_unchained, verified.unchained_after_chain], [1, 0]);

    // 8. An audit row outlives its case: deleting the case must not delete the history (ON DELETE SET NULL).
    const history = (await admin.query("SELECT COUNT(*) n FROM EmergencyHistory WHERE hospital_id = 'H-M'"))[0][0].n;
    await admin.query("DELETE FROM ResourceAllocation WHERE request_id = 'REQ-M'");
    await admin.query("DELETE FROM HospitalAcceptance WHERE request_id = 'REQ-M'");
    await admin.query("UPDATE Ambulance SET assigned_request_id = NULL WHERE assigned_request_id = 'REQ-M'");
    await admin.query("DELETE FROM EmergencyRequest WHERE request_id = 'REQ-M'");
    assert.equal((await admin.query("SELECT COUNT(*) n FROM EmergencyHistory WHERE hospital_id = 'H-M'"))[0][0].n, history, 'audit rows survive the deletion of their case');
  });

  // ── Repeatability and failure handling (MySQL DDL is NOT transactional) ──────────────────────
  // The migration file as individual statements (comment lines removed).
  const migrationStatements = () => read('../server/db/migrations/001_referral_lifecycle.sql')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    .split(';').map(statement => statement.trim()).filter(Boolean);

  async function loadOldSchemaWithData() {
    await dropAll();
    await admin.query(read('./fixtures/schema_before_lifecycle.sql'));
    await admin.query(`
      INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone)
        VALUES ('H-M', 'Hospital Migrated', 'Fictional Ave', 28.6, 77.2, '000');
      INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-M', 'Fictional Migrated Patient', 61, 'RESPIRATORY');
      INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, priority, status) VALUES ('REQ-M', 'PAT-M', 'RESPIRATORY', 2, 'WAITING');
      INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, new_state) VALUES ('REQ-M', 'H-M', 'REQUEST_CREATED', 'WAITING');
    `);
  }
  const rowCounts = async () => ({ ...(await admin.query(
    'SELECT (SELECT COUNT(*) FROM Patient) p, (SELECT COUNT(*) FROM EmergencyRequest) r, (SELECT COUNT(*) FROM EmergencyHistory) h'))[0][0] });

  test('re-running the migration, or running it on the current schema, is refused and changes nothing', async () => {
    await loadOldSchemaWithData();
    const statements = migrationStatements();
    assert.equal(statements.length, 5, 'the migration is five statements');
    for (const statement of statements) await admin.query(statement);
    const migrated = await structure();
    const counts = await rowCounts();

    // Not idempotent by design (MySQL has no ADD COLUMN IF NOT EXISTS): the second run must fail LOUDLY on its
    // first statement, before altering anything.
    await assert.rejects(admin.query(read('../server/db/migrations/001_referral_lifecycle.sql')), err => {
      assert.equal(err.code, 'ER_DUP_FIELDNAME');
      return true;
    });
    assert.deepEqual(await structure(), migrated, 'the failed re-run altered nothing');
    assert.deepEqual(await rowCounts(), counts);
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING, RUNNER_NOT_ADOPTED, ASSIGNMENTS_MISSING, CLAIMS_MISSING, CHAIN_MISSING, TRIPS_MISSING, ...BATCH8_MISSING, ...LATER_COLUMNS]);

    // The same on a database created from the current schema.sql.
    await dropAll();
    await admin.query(read('../server/db/schema.sql'));
    const fresh = await structure();
    await assert.rejects(admin.query(read('../server/db/migrations/001_referral_lifecycle.sql')), /Duplicate column name/);
    assert.deepEqual(await structure(), fresh, 'the migration refused to touch an up-to-date schema');
    await admin.query(read(MIGRATION_002));
    assert.deepEqual(await structure(), fresh, '002 is a no-op on an up-to-date schema');
  });

  test('a failure midway leaves the earlier statements applied, is reported precisely, and can be completed', async () => {
    await loadOldSchemaWithData();
    const statements = migrationStatements();
    const counts = await rowCounts();

    // Make statement 3 (EmergencyRequest) fail by applying it by hand first, then run the whole file as an
    // operator would (`mysql < file`). Statements 1 and 2 succeed, statement 3 fails, 4 and 5 never run.
    await admin.query(statements[2]);
    await assert.rejects(admin.query(read('../server/db/migrations/001_referral_lifecycle.sql')), err => {
      assert.equal(err.code, 'ER_DUP_FIELDNAME', 'statement 3 fails because its columns already exist');
      return true;
    });

    // DDL is not transactional: statements 1 and 2 stayed applied. The start-up check names exactly what is
    // still missing, so an operator can finish by running only the remaining statements.
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING, RUNNER_NOT_ADOPTED, ASSIGNMENTS_MISSING, CLAIMS_MISSING, CHAIN_MISSING, TRIPS_MISSING, ...BATCH8_MISSING, 'EmergencyHistory.request_id must allow NULL', ...LATER_COLUMNS]);
    for (const statement of statements.slice(3)) await admin.query(statement);
    await admin.query(read(MIGRATION_002));
    assert.deepEqual(await checkSchema(pool), [RUNNER_NOT_ADOPTED, ASSIGNMENTS_MISSING, CLAIMS_MISSING, CHAIN_MISSING, TRIPS_MISSING, ...BATCH8_MISSING, ...LATER_COLUMNS]);
    await runMigrations(admin, { baseline: '002' });
    assert.deepEqual(await checkSchema(pool), []);
    assert.deepEqual(await rowCounts(), counts, 'no data was lost along the way');

    // And once finished it is identical to a fresh schema.
    const finished = await structure();
    await dropAll();
    await admin.query(read('../server/db/schema.sql'));
    assert.deepEqual(finished, await structure());
  });

  test('re-initialising a current database is idempotent and keeps its data', async () => {
    await dropAll();
    await initializeSchema(admin);
    assert.equal(await seedDemoData(admin), true, 'seeding an empty database inserts the demo data');
    const snapshot = await structure();
    const counts = (await admin.query('SELECT (SELECT COUNT(*) FROM Hospital) h, (SELECT COUNT(*) FROM Doctor) d, (SELECT COUNT(*) FROM EmergencyRequest) r'))[0][0];

    await initializeSchema(admin); // as `npm run db:init` does when run again
    assert.equal(await seedDemoData(admin), false, 'seeding refuses a database that already has hospitals');
    assert.deepEqual(await structure(), snapshot);
    assert.deepEqual({ ...(await admin.query('SELECT (SELECT COUNT(*) FROM Hospital) h, (SELECT COUNT(*) FROM Doctor) d, (SELECT COUNT(*) FROM EmergencyRequest) r'))[0][0] }, { ...counts });
    assert.deepEqual(await checkSchema(pool), []);
  });
}
