// server/db/init.js
// MySQL schema + demo-data initialisation. NON-DESTRUCTIVE by design:
//   - the schema uses CREATE TABLE IF NOT EXISTS (existing tables and data are never altered or dropped)
//   - demo data is inserted only when the Hospital table is empty
// Usage:  node server/db/init.js            (schema only)
//         node server/db/init.js --seed     (schema + demo hospitals/doctors/ambulances/cases)
// Connection settings come from DB_* environment variables (see .env.example). Passwords are never printed.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { resolveStorageConfig } from './config.js';
import { db as demoData } from './seed.js';
import { DEMO_USERS } from './demoUsers.js';
import {
  DEMO_ACCEPTANCES, DEMO_ALLOCATIONS, DEMO_ASSIGNMENTS, DEMO_DOCTOR_STATUS, DEMO_DOCTOR_BASE_STATUS, DEMO_UNIT_ASSIGNMENTS, DEMO_UNIT_BASE_STATUS, DEMO_AUDIT_EVENTS
} from './demoLifecycle.js';
import { chainEntries, normalizeAuditEntry } from '../services/auditChain.js';
import { singleStageClaim, claimRows } from '../services/clinicalPathways.js';
// Circular with migrate.js (which imports SCHEMA_TABLES etc. from here); safe: neither module uses the other's
// bindings while it is being evaluated, only inside functions.
import { listMigrationFiles, MIGRATIONS_DIR } from './migrate.js';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export const SCHEMA_TABLES = ['Hospital', 'Doctor', 'MedicalResource', 'Patient', 'EmergencyRequest',
  'HospitalAcceptance', 'ResourceAllocation', 'Ambulance', 'EmergencyHistory', 'Alert', 'SystemUser', 'IdempotencyKey',
  'SchemaMigration', 'DoctorAssignment', 'RequestClaim', 'AuditChainHead', 'AmbulanceTrip', 'Incident', 'TreatmentUpdate',
  'AmbulanceAssignment'];

/** Tables added by a later, additive migration: a database missing only these can be upgraded in place. */
export const MIGRATED_TABLES = {
  IdempotencyKey: 'server/db/migrations/002_idempotency_keys.sql',
  SchemaMigration: '`npm run db:migrate -- --baseline <last migration already applied>` once; see server/db/migrations/README.md',
  DoctorAssignment: '`npm run db:migrate` (migration 004_doctor_assignment)',
  RequestClaim: '`npm run db:migrate` (migration 005_staged_claims)',
  AuditChainHead: '`npm run db:migrate` (migration 006_audit_chain)',
  AmbulanceTrip: '`npm run db:migrate` (migration 010_ambulance_trips)',
  Incident: '`npm run db:migrate` (migration 011_incidents)',
  TreatmentUpdate: '`npm run db:migrate` (migration 011_incidents)',
  AmbulanceAssignment: '`npm run db:migrate` (migration 011_incidents)'
};

/** Open a dedicated connection that may run the multi-statement schema file. */
export function connectForInit(mysqlConfig) {
  return mysql.createConnection({
    host: mysqlConfig.host, port: mysqlConfig.port, user: mysqlConfig.user, password: mysqlConfig.password,
    database: mysqlConfig.database, multipleStatements: true, charset: 'utf8mb4'
  });
}

export async function initializeSchema(conn, { migrationsDir = MIGRATIONS_DIR } = {}) {
  // schema.sql records every migration as already present (BASELINE). That is only true for tables it
  // creates itself, so it may only run on an EMPTY database (no project tables), or again on a database that
  // already records every migration (then it changes nothing). On anything else it would record migrations as
  // applied without running their ALTERs (review finding A1).
  const existing = await listExistingTables(conn);
  if (existing.includes('SchemaMigration')) {
    const [rows] = await conn.query("SELECT version, status FROM SchemaMigration");
    const done = new Set(rows.filter(r => r.status === 'BASELINE' || r.status === 'APPLIED').map(r => r.version));
    const missing = listMigrationFiles(migrationsDir).map(f => f.version).filter(v => !done.has(v));
    if (missing.length) {
      throw new Error(`This database is managed by the migration runner and has not applied ${missing.join(', ')}. ` +
        'db:init only creates an empty database; upgrade this one with `npm run db:migrate` (see server/db/migrations/README.md).');
    }
  } else if (existing.some(t => SCHEMA_TABLES.includes(t))) {
    throw new Error('This database already has project tables but no SchemaMigration table (it predates the migration runner). ' +
      'Upgrade it with `npm run db:migrate -- --baseline <last migration already applied>` instead; see server/db/migrations/README.md.');
  }
  await conn.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

export async function listExistingTables(connOrPool) {
  const [rows] = await connOrPool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  return rows.map(r => r.name);
}

/**
 * Insert the demo dataset. Returns false (and writes nothing) if hospitals already exist.
 * The fictional demo ACCOUNTS (bcrypt hashes, is_demo = 1) are inserted only outside production (X2): with
 * NODE_ENV=production the hospitals, units and demo cases are seeded but no login is created; use `npm run user:create`.
 */
export async function seedDemoData(conn, { force = false, env = process.env } = {}) {
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM Hospital');
  if (Number(n) > 0 && !force) return false;

  await conn.beginTransaction();
  try {
    for (const h of demoData.hospitals) {
      await conn.query(
        `INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone, trauma_level,
                               emergency_status, acceptance_rate, avg_response_sec, rating) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [h.hospital_id, h.hospital_name, h.address, h.location_lat, h.location_lng, h.contact_phone, h.trauma_level,
          h.emergency_status, h.acceptance_rate, h.avg_response_sec, h.rating]
      );
    }
    for (const r of demoData.medicalResources) {
      await conn.query(
        `INSERT INTO MedicalResource (resource_id, hospital_id, resource_type, total_capacity, available_capacity, locked_capacity, version_lock)
         VALUES (?,?,?,?,?,?,?)`,
        [r.resource_id, r.hospital_id, r.resource_type, r.total_capacity, r.available_capacity, r.locked_capacity, r.version_lock]
      );
    }
    for (const d of demoData.doctors) {
      await conn.query(
        `INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status, shift_start, shift_end) VALUES (?,?,?,?,?,?,?)`,
        // The pre-history status: the in-memory seed object this reads from may already carry the demo history.
        [d.doctor_id, d.hospital_id, d.full_name, d.specialization, DEMO_DOCTOR_BASE_STATUS[d.doctor_id] ?? d.availability_status, d.shift_start, d.shift_end]
      );
    }
    for (const a of demoData.ambulances) {
      await conn.query(
        `INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status, current_lat, current_lng, eta_mins)
         VALUES (?,?,?,?,?,?,?,?)`,
        // Pre-history status (as for doctors); the demo history below puts AMB-02 back on the road outside production.
        [a.ambulance_id, a.hospital_id, a.vehicle_number, a.ambulance_type, DEMO_UNIT_BASE_STATUS[a.ambulance_id] ?? a.status, a.current_lat, a.current_lng, a.eta_mins]
      );
    }
    // With NODE_ENV=production `db:seed` is the hospital bootstrap only: no demo patients, cases or demo history.
    if (env.NODE_ENV !== 'production') {
      for (const p of demoData.patients) {
        await conn.query(
          'INSERT INTO Patient (patient_id, full_name, age, gender, emergency_type, triage_priority) VALUES (?,?,?,?,?,?)',
          [p.patient_id, p.full_name, p.age, p.gender, p.emergency_type, p.triage_priority]
        );
      }
      for (const r of demoData.emergencyRequests) {
        await conn.query(
          `INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, required_specialist, priority, clinical_notes, status, is_demo)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [r.request_id, r.patient_id, r.emergency_type, JSON.stringify(r.required_resource_types || []), r.required_specialist,
            r.priority, r.clinical_notes, r.status, r.is_demo ? 1 : 0]
        );
        // Demo cases get the single-stage claim migration 005 gives every open case (D2-a10).
        if (!['COMPLETED', 'CANCELLED'].includes(r.status)) {
          for (const row of claimRows(singleStageClaim(r.required_resource_types || [], r.required_specialist))) {
            await conn.query('INSERT INTO RequestClaim (request_id, stage_no, resource_type, quantity) VALUES (?, ?, ?, ?)',
              [r.request_id, row.stage_no, row.resource_type, row.quantity]);
          }
        }
      }
      // The demo cases' recorded history (server/db/demoLifecycle.js; the same as the in-memory seed).
      for (const a of DEMO_ACCEPTANCES) {
        await conn.query(
          `INSERT INTO HospitalAcceptance (acceptance_id, request_id, hospital_id, status, response_time_sec, lock_expires_at, responded_at)
           VALUES (?, ?, ?, ?, ?, NOW(), NOW())`, [a.acceptance_id, a.request_id, a.hospital_id, a.status, a.response_time_sec]);
      }
      for (const a of DEMO_ALLOCATIONS) {
        await conn.query(`INSERT INTO ResourceAllocation (allocation_id, request_id, hospital_id, resource_id, status, stage_no) VALUES (?, ?, ?, ?, 'COMMITTED', 1)`,
          [a.allocation_id, a.request_id, a.hospital_id, a.resource_id]);
      }
      for (const [doctorId, status] of Object.entries(DEMO_DOCTOR_STATUS)) {
        await conn.query('UPDATE Doctor SET availability_status = ? WHERE doctor_id = ?', [status, doctorId]);
      }
      for (const a of DEMO_ASSIGNMENTS) {
        await conn.query(
          `INSERT INTO DoctorAssignment (assignment_id, doctor_id, request_id, hospital_id, acceptance_id, stage_no, status, committed_at)
           VALUES (?, ?, ?, ?, ?, 1, 'COMMITTED', CURRENT_TIMESTAMP(3))`, [a.assignment_id, a.doctor_id, a.request_id, a.hospital_id, a.acceptance_id]);
      }
      for (const u of DEMO_UNIT_ASSIGNMENTS) {
        await conn.query('UPDATE Ambulance SET status = ?, assigned_request_id = ?, destination_hospital_id = ? WHERE ambulance_id = ?',
          [u.status, u.request_id, u.destination_hospital_id, u.ambulance_id]);
      }
      // The demo audit events, chained exactly as MySqlLockingEngine writes them (head locked, rows hashed, head moved).
      const [[head]] = await conn.query('SELECT chain_seq, head_hash FROM AuditChainHead WHERE id = 1 FOR UPDATE');
      const startMs = Date.now();
      const { rows: chained, head: newHead } = chainEntries({ chain_seq: Number(head.chain_seq), hash: head.head_hash },
        DEMO_AUDIT_EVENTS.map((e, i) => ({ ...normalizeAuditEntry(e), event_time_ms: startMs + i, event_time: new Date(startMs + i).toISOString() })));
      for (const r of chained) {
        await conn.query(
          `INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, previous_state, new_state, actor_role, actor_id, metadata,
                                         event_time, event_time_ms, chain_seq, prev_hash, row_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?, ?, ?)`,
          [r.request_id, r.hospital_id, r.event_type, r.previous_state, r.new_state, r.actor_role, r.actor_id,
            r.metadata === null ? null : JSON.stringify(r.metadata), r.event_time_ms, r.event_time_ms, r.chain_seq, r.prev_hash, r.row_hash]
        );
      }
      await conn.query('UPDATE AuditChainHead SET chain_seq = ?, head_hash = ? WHERE id = 1', [newHead.chain_seq, newHead.hash]);
    }
    // Accounts last: a PATIENT account references its Patient row (migration 009).
    if (env.NODE_ENV !== 'production') await insertDemoUsers(conn);
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

/**
 * Insert the fictional demo accounts (bcrypt hashes, is_demo = 1) that are missing. An existing user_id or username is
 * never touched. A desk whose hospital does not exist is skipped; a paramedic whose unit does not exist gets no unit.
 * Returns { inserted: [usernames], skipped: [usernames] }. Callers decide whether demo accounts are allowed.
 */
export async function insertDemoUsers(conn) {
  const inserted = [];
  const skipped = [];
  for (const u of DEMO_USERS) {
    const [[taken]] = await conn.query('SELECT COUNT(*) AS n FROM SystemUser WHERE user_id = ? OR username = ?', [u.user_id, u.username]);
    const [[hospital]] = u.hospital_id ? await conn.query('SELECT COUNT(*) AS n FROM Hospital WHERE hospital_id = ?', [u.hospital_id]) : [[{ n: 1 }]];
    // A patient account needs its patient (a database without the demo cases gets no demo patient logins).
    const [[patient]] = u.patient_id ? await conn.query('SELECT COUNT(*) AS n FROM Patient WHERE patient_id = ?', [u.patient_id]) : [[{ n: 1 }]];
    if (Number(taken.n) > 0 || Number(hospital.n) === 0 || Number(patient.n) === 0) { skipped.push(u.username); continue; }
    const [[unit]] = u.ambulance_id ? await conn.query('SELECT COUNT(*) AS n FROM Ambulance WHERE ambulance_id = ?', [u.ambulance_id]) : [[{ n: 0 }]];
    await conn.query(
      `INSERT INTO SystemUser (user_id, username, password_hash, role, hospital_id, is_active, display_name, ambulance_id, patient_id, is_demo)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [u.user_id, u.username, u.password_hash, u.role, u.hospital_id, u.is_active, u.display_name, Number(unit.n) > 0 ? u.ambulance_id : null,
        u.patient_id ?? null]
    );
    inserted.push(u.username);
  }
  return { inserted, skipped };
}

/**
 * TEST DATABASES ONLY. Drops and recreates every project table, then seeds. Refuses any database
 * whose name does not end in "_test".
 */
export async function resetTestDatabase(conn, databaseName, { seed = true } = {}) {
  if (!/_test$/.test(databaseName || '')) {
    throw new Error(`Refusing to reset "${databaseName}": only databases whose name ends in "_test" may be reset.`);
  }
  await conn.query(`SET FOREIGN_KEY_CHECKS = 0; ${SCHEMA_TABLES.map(t => `DROP TABLE IF EXISTS \`${t}\``).join('; ')}; SET FOREIGN_KEY_CHECKS = 1`);
  await initializeSchema(conn);
  if (seed) await seedDemoData(conn);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ quiet: true });
  const config = resolveStorageConfig({ ...process.env, DB_USE_MEMORY: 'false' });
  const conn = await connectForInit(config.mysql);
  try {
    const before = await listExistingTables(conn);
    await initializeSchema(conn);
    const after = await listExistingTables(conn);
    console.log(`Schema ready on ${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}: ` +
      `${after.length} tables (${after.length - before.length} created, none altered or dropped).`);
    if (process.argv.includes('--seed')) {
      const seeded = await seedDemoData(conn);
      console.log(seeded ? 'Demo data inserted.' : 'Demo data NOT inserted: the database already contains hospitals.');
      if (seeded && process.env.NODE_ENV === 'production') {
        console.log('NODE_ENV=production: no demo accounts were created. Create real accounts with `npm run user:create`.');
      }
    }
  } finally {
    await conn.end();
  }
}
