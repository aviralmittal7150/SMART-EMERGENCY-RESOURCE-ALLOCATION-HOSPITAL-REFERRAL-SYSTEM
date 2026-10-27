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

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export const SCHEMA_TABLES = ['Hospital', 'Doctor', 'MedicalResource', 'Patient', 'EmergencyRequest',
  'HospitalAcceptance', 'ResourceAllocation', 'Ambulance', 'EmergencyHistory', 'Alert', 'SystemUser', 'IdempotencyKey'];

/** Tables added by a later, additive migration: a database missing only these can be upgraded in place. */
export const MIGRATED_TABLES = { IdempotencyKey: 'server/db/migrations/002_idempotency_keys.sql' };

/** Open a dedicated connection that may run the multi-statement schema file. */
export function connectForInit(mysqlConfig) {
  return mysql.createConnection({
    host: mysqlConfig.host, port: mysqlConfig.port, user: mysqlConfig.user, password: mysqlConfig.password,
    database: mysqlConfig.database, multipleStatements: true, charset: 'utf8mb4'
  });
}

export async function initializeSchema(conn) {
  await conn.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

export async function listExistingTables(connOrPool) {
  const [rows] = await connOrPool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  return rows.map(r => r.name);
}

/** Insert the demo dataset. Returns false (and writes nothing) if hospitals already exist. */
export async function seedDemoData(conn, { force = false } = {}) {
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
        [d.doctor_id, d.hospital_id, d.full_name, d.specialization, d.availability_status, d.shift_start, d.shift_end]
      );
    }
    for (const a of demoData.ambulances) {
      await conn.query(
        `INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status, current_lat, current_lng, eta_mins)
         VALUES (?,?,?,?,?,?,?,?)`,
        [a.ambulance_id, a.hospital_id, a.vehicle_number, a.ambulance_type, a.status, a.current_lat, a.current_lng, a.eta_mins]
      );
    }
    for (const p of demoData.patients) {
      await conn.query(
        'INSERT INTO Patient (patient_id, full_name, age, gender, emergency_type, triage_priority) VALUES (?,?,?,?,?,?)',
        [p.patient_id, p.full_name, p.age, p.gender, p.emergency_type, p.triage_priority]
      );
    }
    for (const r of demoData.emergencyRequests) {
      await conn.query(
        `INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, required_specialist, priority, clinical_notes, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [r.request_id, r.patient_id, r.emergency_type, JSON.stringify(r.required_resource_types || []), r.required_specialist,
          r.priority, r.clinical_notes, r.status]
      );
    }
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
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
    }
  } finally {
    await conn.end();
  }
}
