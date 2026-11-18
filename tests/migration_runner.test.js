// Migration runner: file ordering, statement splitting and checksums (no database needed).
// The database behaviour (apply, re-run, failure, concurrency, start-up refusal) is tested against MySQL
// in tests/mysql_migration_runner.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMigrationFiles, splitStatements, checksumOf, MigrationError, MIGRATIONS_DIR } from '../server/db/migrate.js';
import { initializeSchema } from '../server/db/init.js';

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

test('the real migration directory is valid: contiguous from 001, in order, 003 creates SchemaMigration, 004 DoctorAssignment, 005 RequestClaim, 006 AuditChainHead, 007 is_demo, 008 accounts, 010 AmbulanceTrip, 011 Incident', () => {
  const files = listMigrationFiles();
  assert.deepEqual(files.map(f => f.version),
    ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration', '004_doctor_assignment', '005_staged_claims', '006_audit_chain',
      '007_analytics_integrity', '008_accounts_and_scoping', '009_portal_roles', '010_ambulance_trips', '011_incidents']);
  assert.match(files[10].sql, /CREATE TABLE IF NOT EXISTS Incident[\s\S]*ALTER TABLE EmergencyRequest[\s\S]*ADD COLUMN incident_id VARCHAR\(30\) NULL[\s\S]*ADD CONSTRAINT fk_request_incident[\s\S]*CREATE TABLE IF NOT EXISTS AmbulanceAssignment/);
  assert.match(files[9].sql, /CREATE TABLE IF NOT EXISTS AmbulanceTrip[\s\S]*UNIQUE KEY uq_trip_active_ambulance \(active_ambulance_id\)[\s\S]*UNIQUE KEY uq_trip_active_request \(active_request_id\)/);
  assert.match(files[6].sql, /ADD COLUMN is_demo TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(files[7].sql, /ALTER TABLE SystemUser[\s\S]*ADD COLUMN ambulance_id/);
  assert.match(files[8].sql, /ALTER TABLE SystemUser[\s\S]*'DISPATCHER','PATIENT'[\s\S]*ADD COLUMN patient_id[\s\S]*ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(files[2].sql, /CREATE TABLE IF NOT EXISTS SchemaMigration/);
  assert.match(files[3].sql, /CREATE TABLE IF NOT EXISTS DoctorAssignment/);
  assert.match(files[4].sql, /CREATE TABLE IF NOT EXISTS RequestClaim/);
  assert.match(files[5].sql, /CREATE TABLE IF NOT EXISTS AuditChainHead/);
  assert.ok(files.every(f => /^[0-9a-f]{64}$/.test(f.checksum)));
});

test('files are ordered by number regardless of directory order; non-.sql files are ignored', () => {
  const dir = tempDir({ '010_j.sql': 'SELECT 10;', 'README.md': '# not a migration' });
  for (let n = 1; n <= 9; n += 1) fs.writeFileSync(path.join(dir, `00${n}_m${n}.sql`), `SELECT ${n};`);
  try {
    assert.deepEqual(listMigrationFiles(dir).map(f => f.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { cleanup(dir); }
});

test('a duplicate number, a gap, or a badly named file is refused', () => {
  const cases = [
    [{ '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 2;' }, /share number 001/],
    [{ '001_a.sql': 'SELECT 1;', '003_c.sql': 'SELECT 3;' }, /contiguous from 001.*003_c\.sql/],
    [{ '002_b.sql': 'SELECT 2;' }, /contiguous from 001/],
    [{ '1_a.sql': 'SELECT 1;' }, /Badly named/],
    [{ '001_Bad-Name.sql': 'SELECT 1;' }, /Badly named/]
  ];
  for (const [files, expected] of cases) {
    const dir = tempDir(files);
    try {
      assert.throws(() => listMigrationFiles(dir), err => err instanceof MigrationError && expected.test(err.message));
    } finally { cleanup(dir); }
  }
});

test('the real migrations split into the expected statements (001: 5, 002: 1, 003: 1, 004: 2, 005: 8, 006: 3, 007: 5, 008: 5, 009: 2, 010: 1, 011: 6)', () => {
  const read = name => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  const s001 = splitStatements(read('001_referral_lifecycle.sql'));
  assert.equal(s001.length, 5);
  assert.ok(s001.every(s => /^ALTER TABLE /.test(s)), 'comment lines are not statements');
  assert.equal(splitStatements(read('002_idempotency_keys.sql')).length, 1);
  assert.equal(splitStatements(read('003_schema_migration.sql')).length, 1);
  const s004 = splitStatements(read('004_doctor_assignment.sql'));
  assert.equal(s004.length, 2);
  assert.match(s004[0], /^ALTER TABLE Doctor/);
  assert.match(s004[1], /^CREATE TABLE IF NOT EXISTS DoctorAssignment/);
  const s005 = splitStatements(read('005_staged_claims.sql'));
  assert.equal(s005.length, 8);
  assert.match(s005[0], /^CREATE TABLE IF NOT EXISTS RequestClaim/);
  assert.equal(s005.filter(x => /^INSERT IGNORE INTO RequestClaim/.test(x)).length, 4, 'four backfill statements');
  const s006 = splitStatements(read('006_audit_chain.sql'));
  assert.equal(s006.length, 3);
  assert.ok(!s006.some(x => /CREATE TRIGGER/i.test(x)), 'no triggers: they need SUPER while binary logging is on');
  const s007 = splitStatements(read('007_analytics_integrity.sql'));
  assert.equal(s007.length, 5);
  assert.match(s007[0], /^ALTER TABLE EmergencyRequest\s+ADD COLUMN is_demo[\s\S]*MODIFY COLUMN request_time TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)$/);
  assert.match(s007[1], /^UPDATE EmergencyRequest SET is_demo = 1\s+WHERE \(request_id, patient_id\) IN \(\('REQ-8901', 'PAT-001'\), \('REQ-8902', 'PAT-002'\), \('REQ-8903', 'PAT-003'\)\)$/);
  assert.match(s007[2], /^ALTER TABLE HospitalAcceptance\s+ADD INDEX idx_created_at \(created_at\)$/);
  assert.match(s007[3], /^ALTER TABLE AuditChainHead\s+ADD COLUMN legacy_max_history_id BIGINT UNSIGNED NULL[\s\S]*ADD COLUMN legacy_count BIGINT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(s007[4], /^UPDATE AuditChainHead h\s+JOIN/);
  const s008 = splitStatements(read('008_accounts_and_scoping.sql'));
  assert.equal(s008.length, 5);
  assert.match(s008[0], /^ALTER TABLE SystemUser\s+MODIFY COLUMN username VARCHAR\(80\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL[\s\S]*ADD CONSTRAINT fk_user_ambulance/);
  assert.match(s008[1], /^ALTER TABLE HospitalAcceptance\s+ADD COLUMN initiated_by VARCHAR\(30\) NULL/);
  assert.match(s008[2], /^ALTER TABLE EmergencyRequest\s+ADD COLUMN created_by VARCHAR\(30\) NULL/);
  assert.match(s008[3], /^UPDATE EmergencyRequest r\s+JOIN/);
  assert.match(s008[4], /^ALTER TABLE IdempotencyKey\s+MODIFY COLUMN idem_key VARCHAR\(100\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL$/);
  const s009 = splitStatements(read('009_portal_roles.sql'));
  assert.equal(s009.length, 2);
  assert.match(s009[1], /^ALTER TABLE EmergencyHistory\s+MODIFY COLUMN actor_role ENUM\('SYSTEM','ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER'\) NOT NULL DEFAULT 'SYSTEM'$/);
  const s010 = splitStatements(read('010_ambulance_trips.sql'));
  assert.deepEqual(s010.length, 1);
  assert.match(s010[0], /^CREATE TABLE IF NOT EXISTS AmbulanceTrip \(/);
  const s011 = splitStatements(read('011_incidents.sql'));
  assert.equal(s011.length, 6);
  assert.match(s011[0], /^CREATE TABLE IF NOT EXISTS Incident \(/);
  assert.match(s011[1], /^ALTER TABLE Patient\s+MODIFY COLUMN age TINYINT UNSIGNED NULL/);
  assert.match(s011[2], /^ALTER TABLE EmergencyRequest\s+ADD COLUMN incident_id VARCHAR\(30\) NULL[\s\S]*active_bed_key VARCHAR\(60\) GENERATED ALWAYS AS[\s\S]*ADD UNIQUE KEY uq_active_bed \(active_bed_key\),\s+ADD CONSTRAINT fk_request_incident FOREIGN KEY \(incident_id\) REFERENCES Incident\(incident_id\) ON DELETE RESTRICT$/);
  assert.match(s011[3], /^CREATE TABLE IF NOT EXISTS TreatmentUpdate \(/);
  assert.match(s011[4], /^ALTER TABLE Ambulance\s+ADD COLUMN capacity TINYINT UNSIGNED NOT NULL DEFAULT 1/);
  assert.match(s011[5], /^CREATE TABLE IF NOT EXISTS AmbulanceAssignment \([\s\S]*UNIQUE KEY uq_assignment_active_request \(active_request_id\)/);
  assert.match(s009[0], /^ALTER TABLE SystemUser\s+MODIFY COLUMN role ENUM\('ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER','PATIENT'\) NOT NULL,[\s\S]*ADD CONSTRAINT fk_user_patient FOREIGN KEY \(patient_id\) REFERENCES Patient\(patient_id\) ON DELETE SET NULL$/);
});

// ── db:init (initializeSchema) on an existing database (finding A1), with a scripted connection: no MySQL needed ──
/**
 * A fake connection: `tables` is what information_schema lists, `recorded` the SchemaMigration rows. It records
 * every statement; the multi-statement schema.sql is recognisable by its CREATE TABLE statements.
 */
function scriptedConnection({ tables, recorded = [] }) {
  const sent = [];
  return {
    sent,
    ranSchema: () => sent.some(sql => /CREATE TABLE IF NOT EXISTS Hospital/.test(sql)),
    async query(sql) {
      sent.push(sql);
      if (/information_schema\.tables/.test(sql)) return [tables.map(name => ({ name }))];
      if (/FROM SchemaMigration/.test(sql)) return [recorded];
      return [[]];
    }
  };
}
const ALL_TABLES = ['Hospital', 'Doctor', 'MedicalResource', 'Patient', 'EmergencyRequest', 'HospitalAcceptance', 'ResourceAllocation',
  'Ambulance', 'EmergencyHistory', 'Alert', 'SystemUser', 'IdempotencyKey', 'SchemaMigration'];
const versions = () => listMigrationFiles().map(f => f.version);

test('db:init refuses a runner-managed database that has not recorded every migration, and runs nothing (A1)', async () => {
  // A database at migration 003: its bookkeeping records 001-003 only.
  const conn = scriptedConnection({ tables: ALL_TABLES, recorded: versions().slice(0, 3).map(version => ({ version, status: 'APPLIED' })) });
  await assert.rejects(initializeSchema(conn), err => {
    assert.match(err.message, /has not applied 004_doctor_assignment, 005_staged_claims, 006_audit_chain, 007_analytics_integrity, 008_accounts_and_scoping, 009_portal_roles, 010_ambulance_trips, 011_incidents/);
    assert.match(err.message, /npm run db:migrate/);
    return true;
  });
  assert.equal(conn.ranSchema(), false, 'schema.sql (with its BASELINE rows) was never sent');

  // FAILED / RUNNING rows are recorded but not applied: refused as well.
  const failed = scriptedConnection({ tables: ALL_TABLES, recorded: versions().map((version, i) => ({ version, status: i === 6 ? 'FAILED' : 'APPLIED' })) });
  await assert.rejects(initializeSchema(failed), /has not applied 007_analytics_integrity\..*npm run db:migrate/s);
  assert.equal(failed.ranSchema(), false);

  // Only SchemaMigration exists (e.g. 003 run by hand): still not every migration, still refused.
  const bare = scriptedConnection({ tables: ['SchemaMigration'], recorded: [{ version: '003_schema_migration', status: 'APPLIED' }] });
  await assert.rejects(initializeSchema(bare), /db:migrate/);
  assert.equal(bare.ranSchema(), false);
});

test('db:init creates an empty database, re-runs harmlessly on a fully recorded one, and still refuses a pre-runner one', async () => {
  const empty = scriptedConnection({ tables: ['SomeUnrelatedTable'] });
  await initializeSchema(empty);
  assert.equal(empty.ranSchema(), true, 'an empty database (no project tables) gets schema.sql');

  const current = scriptedConnection({ tables: ALL_TABLES, recorded: versions().map((version, i) => ({ version, status: i < 3 ? 'BASELINE' : 'APPLIED' })) });
  await initializeSchema(current);
  assert.equal(current.ranSchema(), true, 'every migration recorded: schema.sql changes nothing and may run');

  const preRunner = scriptedConnection({ tables: ALL_TABLES.filter(t => t !== 'SchemaMigration') });
  await assert.rejects(initializeSchema(preRunner), /predates the migration runner/);
  assert.equal(preRunner.ranSchema(), false);
});

test('statement splitting respects quotes and comments', () => {
  const sql = `
    -- a comment; with a semicolon
    # another; comment
    /* block; comment */
    INSERT INTO t (a) VALUES ('x;y'), ("q;r"), ('it''s; fine');
    UPDATE \`odd;name\` SET a = 'back\\'slash;' WHERE b = 1;
    SELECT 2--1;
    SELECT 'last statement without a semicolon'`;
  assert.deepEqual(splitStatements(sql), [
    "INSERT INTO t (a) VALUES ('x;y'), (\"q;r\"), ('it''s; fine')",
    "UPDATE `odd;name` SET a = 'back\\'slash;' WHERE b = 1",
    'SELECT 2--1', // "--" without a following space is two minus signs in MySQL, not a comment
    "SELECT 'last statement without a semicolon'"
  ]);
  assert.throws(() => splitStatements("SELECT 'unterminated;"), MigrationError);
  assert.throws(() => splitStatements('SELECT 1; /* never closed'), MigrationError);
});

test('checksums are SHA-256 and ignore Windows line endings (a checkout setting must not look like an edit)', () => {
  assert.equal(checksumOf('SELECT 1;\nSELECT 2;\n'), checksumOf('SELECT 1;\r\nSELECT 2;\r\n'));
  assert.notEqual(checksumOf('SELECT 1;'), checksumOf('SELECT 2;'));
});

test('schema.sql records every migration file as BASELINE (a fresh database already contains them all)', () => {
  const schema = fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
  const insert = schema.match(/INSERT IGNORE INTO SchemaMigration \(version, status\) VALUES([\s\S]*?);/);
  assert.ok(insert, 'schema.sql must insert the baseline rows');
  const declared = [...insert[1].matchAll(/\('([^']+)', 'BASELINE'\)/g)].map(m => m[1]);
  assert.deepEqual(declared, listMigrationFiles().map(f => f.version),
    'add the new migration to schema.sql (schema change + baseline row) when you add a migration file');
});
