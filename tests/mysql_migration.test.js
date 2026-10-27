// The additive migrations (server/db/migrations/001_referral_lifecycle.sql, 002_idempotency_keys.sql)
// tested for real on MySQL:
//   old schema  ->  start-up check rejects it  ->  001 + 002  ->  check passes
//   -> structure identical to a freshly created schema, existing data untouched, engine works on it.
// Runs only against the dedicated *_test database; skipped (not failed) when it is not configured,
// and a failure in CI (REQUIRE_MYSQL_TESTS=true). All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestDatabase } from './helpers/mysqlTestDb.js';
import { createPool } from '../server/db/pool.js';
import { checkSchema } from '../server/db/bootstrap.js';
import { SCHEMA_TABLES, initializeSchema, seedDemoData } from '../server/db/init.js';
import { MySqlLockingEngine } from '../server/services/mysqlLockingEngine.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const MIGRATION_002 = '../server/db/migrations/002_idempotency_keys.sql';
const IDEMPOTENCY_MISSING = 'missing table IdempotencyKey (run server/db/migrations/002_idempotency_keys.sql)';
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
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable, column_default AS dflt
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
      INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, new_state) VALUES ('REQ-M', 'H-M', 'REQUEST_CREATED', 'WAITING');
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
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING], 'after 001 only the 002 table is missing, and it is named');
    await admin.query(read(MIGRATION_002));
    await admin.query(read(MIGRATION_002)); // 002 is re-runnable
    assert.deepEqual(await checkSchema(pool), [], 'the migrated schema passes the start-up check');

    // 5. An upgraded database is structurally identical to a fresh one.
    const migrated = await structure();
    assert.deepEqual(migrated.columns, fresh.columns, 'same columns, types, nullability and defaults');
    assert.deepEqual(migrated.indexes, fresh.indexes, 'same indexes');
    assert.deepEqual(migrated.keys, fresh.keys, 'same foreign keys, including ON DELETE rules (audit rows must outlive their case)');

    // 6. Existing rows are untouched.
    const after = (await admin.query('SELECT (SELECT COUNT(*) FROM Patient) p, (SELECT COUNT(*) FROM EmergencyRequest) r, (SELECT COUNT(*) FROM EmergencyHistory) h, (SELECT COUNT(*) FROM HospitalAcceptance) a'))[0][0];
    assert.deepEqual({ ...after }, { ...before });
    assert.equal((await admin.query("SELECT full_name FROM Patient WHERE patient_id = 'PAT-M'"))[0][0].full_name, 'Fictional Migrated Patient');
    assert.equal((await admin.query("SELECT status FROM HospitalAcceptance WHERE acceptance_id = 'ACC-OLD'"))[0][0].status, 'REJECTED');

    // 7. The locking engine works on the migrated database (it writes the new Ambulance columns).
    const lock = await engine.acquireSoftLock('H-M', 'REQ-M', ['ICU_BED']);
    const committed = await engine.commitAllocation(lock.acceptanceId, 'TEST');
    assert.equal(committed.ambulance_id, 'AMB-M');
    const unit = (await admin.query("SELECT status, assigned_request_id, destination_hospital_id FROM Ambulance WHERE ambulance_id = 'AMB-M'"))[0][0];
    assert.deepEqual({ ...unit }, { status: 'DISPATCHED', assigned_request_id: 'REQ-M', destination_hospital_id: 'H-M' });
    await engine.closeRequest('REQ-M', 'COMPLETED');

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
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING]);

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
    assert.deepEqual(await checkSchema(pool), [IDEMPOTENCY_MISSING, 'EmergencyHistory.request_id must allow NULL']);
    for (const statement of statements.slice(3)) await admin.query(statement);
    await admin.query(read(MIGRATION_002));
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
