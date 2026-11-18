// server/db/bootstrap.js
// Chooses and starts the data store ONCE at process start-up.
//
// Guarantees:
//  - the mode is explicit (see config.js); in production it must be stated, never assumed
//  - MySQL mode never falls back to the in-memory store: if MySQL is unreachable or its schema is
//    unusable, startup FAILS with a clear message
//  - passwords never appear in logs or errors

import { resolveStorageConfig, describeStorage } from './config.js';
import { createPool } from './pool.js';
import { configureStore } from './store.js';
import { MemoryStore } from './memoryStore.js';
import { MySqlStore } from './mysqlStore.js';
import { SCHEMA_TABLES, MIGRATED_TABLES } from './init.js';
import { migrationStatus, MIGRATIONS_DIR } from './migrate.js';
import { validatePathways } from '../services/clinicalPathways.js';

// Columns added by migrations 004-011 that the code reads or writes. Checked explicitly (not only through the
// SchemaMigration bookkeeping) so a database whose bookkeeping claims a migration it never ran is refused (A1).
const MIGRATED_COLUMNS = [
  ['EmergencyRequest', 'current_stage', '005_staged_claims'],
  ['ResourceAllocation', 'stage_no', '005_staged_claims'],
  ['Hospital', 'safety_state', '005_staged_claims'],
  ['EmergencyHistory', 'chain_seq', '006_audit_chain'],
  ['EmergencyHistory', 'prev_hash', '006_audit_chain'],
  ['EmergencyHistory', 'row_hash', '006_audit_chain'],
  ['EmergencyHistory', 'event_time_ms', '006_audit_chain'],
  ['EmergencyRequest', 'is_demo', '007_analytics_integrity'],
  ['AuditChainHead', 'legacy_max_history_id', '007_analytics_integrity'],
  ['AuditChainHead', 'legacy_count', '007_analytics_integrity'],
  ['SystemUser', 'ambulance_id', '008_accounts_and_scoping'],
  ['SystemUser', 'is_demo', '008_accounts_and_scoping'],
  ['HospitalAcceptance', 'initiated_by', '008_accounts_and_scoping'],
  ['EmergencyRequest', 'created_by', '008_accounts_and_scoping'],
  ['SystemUser', 'patient_id', '009_portal_roles'],
  ['SystemUser', 'token_version', '009_portal_roles'],
  ['EmergencyRequest', 'incident_id', '011_incidents'],
  ['EmergencyRequest', 'triage_category', '011_incidents'],
  ['EmergencyRequest', 'arrived_at', '011_incidents'],
  ['EmergencyRequest', 'bed_label', '011_incidents'],
  ['EmergencyRequest', 'active_bed_key', '011_incidents'],
  ['EmergencyRequest', 'treatment_started_at', '011_incidents'],
  ['EmergencyRequest', 'dispatch_ambulance_id', '011_incidents'],
  ['Ambulance', 'capacity', '011_incidents']
];

/** Returns a list of human-readable problems; empty means the schema fits this version of the code. */
export async function checkSchema(pool, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const problems = [];
  const [tables] = await pool.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
  const present = new Set(tables.map(t => t.name));
  const missing = SCHEMA_TABLES.filter(t => !present.has(t));
  const missingCore = missing.filter(t => !MIGRATED_TABLES[t]);
  if (missingCore.length) {
    problems.push(`missing tables: ${missing.join(', ')} (run "node server/db/init.js" on an empty database)`);
    return problems; // column checks would only add noise
  }
  for (const table of missing) problems.push(`missing table ${table} (run ${MIGRATED_TABLES[table]})`);

  const [columns] = await pool.query(
    `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable
     FROM information_schema.columns WHERE table_schema = DATABASE()
       AND ((table_name = 'Ambulance' AND column_name IN ('assigned_request_id', 'destination_hospital_id'))
         OR (table_name = 'EmergencyRequest' AND column_name IN ('required_resources', 'required_specialist', 'request_time'))
         OR (table_name = 'HospitalAcceptance' AND column_name = 'status')
         OR (table_name = 'EmergencyHistory' AND column_name = 'request_id')
         OR (table_name = 'Doctor' AND column_name = 'availability_status')
         OR (CONCAT(table_name, '.', column_name) IN (?)))`,
    [MIGRATED_COLUMNS.map(([t, c]) => `${t}.${c}`)]
  );
  const has = (t, c) => columns.find(col => col.t === t && col.c === c);
  for (const [t, c] of [['Ambulance', 'assigned_request_id'], ['Ambulance', 'destination_hospital_id'],
    ['EmergencyRequest', 'required_resources'], ['EmergencyRequest', 'required_specialist']]) {
    if (!has(t, c)) problems.push(`${t}.${c} is missing`);
  }
  const acceptanceStatus = has('HospitalAcceptance', 'status');
  if (acceptanceStatus && !acceptanceStatus.type.includes("'CANCELLED'")) problems.push("HospitalAcceptance.status lacks the 'CANCELLED' value");
  const historyRequest = has('EmergencyHistory', 'request_id');
  if (historyRequest && historyRequest.nullable !== 'YES') problems.push('EmergencyHistory.request_id must allow NULL');
  // 004-007: present only when the migration really ran (a table missing as a whole is already reported above).
  const doctorStatus = has('Doctor', 'availability_status');
  if (doctorStatus && !(doctorStatus.type.includes("'RESERVED'") && doctorStatus.type.includes("'ASSIGNED'"))) {
    problems.push("Doctor.availability_status lacks the 'RESERVED' / 'ASSIGNED' values (migration 004_doctor_assignment)");
  }
  for (const [t, c, version] of MIGRATED_COLUMNS) {
    if (!present.has(t)) continue; // the whole table is missing: already reported above
    if (!has(t, c)) problems.push(`${t}.${c} is missing (migration ${version}; run \`npm run db:migrate\`)`);
  }
  const requestTime = has('EmergencyRequest', 'request_time');
  if (requestTime && requestTime.type !== 'timestamp(3)') {
    problems.push('EmergencyRequest.request_time must be TIMESTAMP(3) (migration 007_analytics_integrity)');
  }

  // Migration bookkeeping (only once the runner's table exists; its absence is reported above).
  // The server never migrates by itself: pending, failed or edited migrations stop start-up.
  if (present.has('SchemaMigration')) {
    const status = await migrationStatus(pool, { dir: migrationsDir });
    problems.push(...status.problems);
    if (status.pending.length) {
      problems.push(`pending migrations: ${status.pending.map(m => m.version).join(', ')} (run \`npm run db:migrate\`)`);
    }
  }
  return problems;
}

export async function bootstrapStore(env = process.env, { log = console } = {}) {
  const config = resolveStorageConfig(env);
  // D2-a11: an invalid treatment-pathway table stops start-up instead of refusing admissions later.
  validatePathways();

  if (config.mode === 'memory') {
    const store = new MemoryStore();
    configureStore(store);
    store.startBackgroundWorkers();
    log.warn(`[STORAGE] ${describeStorage(config)}`);
    return { store, config };
  }

  const pool = createPool(config.mysql);
  try {
    await pool.query('SELECT 1');
    const problems = await checkSchema(pool);
    if (problems.length) {
      throw new Error(`Schema is out of date: ${problems.join('; ')}. Upgrade with \`npm run db:migrate\` (see server/db/migrations/README.md).`);
    }
  } catch (err) {
    await pool.end().catch(() => {});
    const detail = err.code ? `${err.code}: ${err.message}` : err.message;
    throw new Error(`MySQL storage is unavailable (${detail}). Refusing to start: there is no fallback to the in-memory store.`);
  }

  const store = new MySqlStore({ pool });
  configureStore(store);
  store.startBackgroundWorkers();
  log.log(`[STORAGE] ${describeStorage(config)}`);
  return { store, config };
}
