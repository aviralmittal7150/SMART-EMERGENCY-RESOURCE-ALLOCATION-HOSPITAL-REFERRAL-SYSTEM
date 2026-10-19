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
import { SCHEMA_TABLES } from './init.js';

/** Returns a list of human-readable problems; empty means the schema fits this version of the code. */
export async function checkSchema(pool) {
  const problems = [];
  const [tables] = await pool.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
  const present = new Set(tables.map(t => t.name));
  const missing = SCHEMA_TABLES.filter(t => !present.has(t));
  if (missing.length) {
    problems.push(`missing tables: ${missing.join(', ')} (run "node server/db/init.js" on an empty database)`);
    return problems; // column checks would only add noise
  }

  const [columns] = await pool.query(
    `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable
     FROM information_schema.columns WHERE table_schema = DATABASE()
       AND ((table_name = 'Ambulance' AND column_name IN ('assigned_request_id', 'destination_hospital_id'))
         OR (table_name = 'EmergencyRequest' AND column_name IN ('required_resources', 'required_specialist'))
         OR (table_name = 'HospitalAcceptance' AND column_name = 'status')
         OR (table_name = 'EmergencyHistory' AND column_name = 'request_id'))`
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
  return problems;
}

export async function bootstrapStore(env = process.env, { log = console } = {}) {
  const config = resolveStorageConfig(env);

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
      throw new Error(`Schema is out of date: ${problems.join('; ')}. See server/db/migrations/001_referral_lifecycle.sql.`);
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
