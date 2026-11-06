// sim/lib/backends.js
// Storage backends for the stress harness, driven through the same store interface the API routes use.
//  - mysql:  the dedicated *_test database only (tests/helpers/mysqlTestDb.js refuses any other name and
//            serialises with the test suites through an advisory lock). The schema is recreated from
//            schema.sql and the scenario fixture loaded; nothing outside that database is touched.
//  - memory: the in-memory demo store (single process).
// Both install the lock-order checker, so every harness run also checks the global lock order.

import { db } from '../../server/db/seed.js';
import { lockingEngine } from '../../server/services/lockingEngine.js';
import { MemoryStore } from '../../server/db/memoryStore.js';
import { MySqlStore } from '../../server/db/mysqlStore.js';
import { createPool } from '../../server/db/pool.js';
import { LockOrderChecker, installMemoryLockOrderChecker, instrumentMysqlPool } from '../../server/services/lockOrder.js';
import { openTestDatabase } from '../../tests/helpers/mysqlTestDb.js';

const COORDS = { location_lat: 28.6, location_lng: 77.2 };
const TYPES = ['ICU_BED', 'OT', 'VENTILATOR'];

/** Expand a scenario fixture into rows. */
function fixtureRows(fixture) {
  const hospitals = fixture.hospitals.map(h => ({
    hospital_id: h.hospital_id, hospital_name: h.hospital_name ?? `Simulated ${h.hospital_id}`,
    emergency_status: h.emergency_status ?? 'OPEN', acceptance_rate: h.acceptance_rate ?? 0.8, avg_response_sec: h.avg_response_sec ?? 60
  }));
  const resources = fixture.hospitals.flatMap(h => TYPES.map(type => ({
    resource_id: `SIM-RES-${h.hospital_id}-${type}`, hospital_id: h.hospital_id, resource_type: type,
    total_capacity: h.capacity?.[type] ?? 0, available_capacity: h.capacity?.[type] ?? 0, locked_capacity: 0
  })));
  let d = 0;
  const doctors = fixture.hospitals.flatMap(h => (h.specialists ?? []).map(spec => ({
    doctor_id: `SIM-DR-${String(++d).padStart(3, '0')}`, hospital_id: h.hospital_id,
    full_name: `Simulated ${spec} ${h.hospital_id}`, specialization: spec, availability_status: 'AVAILABLE'
  })));
  let a = 0;
  const ambulances = fixture.hospitals.flatMap(h => Array.from({ length: h.ambulances ?? 0 }, () => ({
    ambulance_id: `SIM-AMB-${String(++a).padStart(3, '0')}`, hospital_id: h.hospital_id,
    vehicle_number: `SIM-${String(a).padStart(3, '0')}`, ambulance_type: 'ALS', status: 'AVAILABLE'
  })));
  return { hospitals, resources, doctors, ambulances };
}

// ── In-memory ────────────────────────────────────────────────────────────────────────────────────
export async function createMemoryBackend(fixture) {
  const store = new MemoryStore({ db, lockingEngine });
  const checker = new LockOrderChecker();
  const uninstall = installMemoryLockOrderChecker(checker);
  const rows = fixtureRows(fixture);
  const clearEngine = () => {
    for (const entry of lockingEngine._activeLocks.values()) clearInterval(entry.countdownTimer);
    lockingEngine._activeLocks.clear();
    lockingEngine._requestLocks.clear();
    lockingEngine.hooks.clear();
    db._mutexes.clear();
  };
  return {
    name: 'memory', store, engine: lockingEngine, hooks: lockingEngine.hooks, checker, poolSize: null, db,
    async reset() {
      clearEngine();
      db.hospitals = rows.hospitals.map(h => ({ ...h, ...COORDS, address: 'Simulated Ave', contact_phone: '000' }));
      db.medicalResources = rows.resources.map(r => ({ ...r, version_lock: 0 }));
      db.doctors = rows.doctors.map(x => ({ ...x }));
      db.ambulances = rows.ambulances.map(x => ({ ...x }));
      db.patients = []; db.emergencyRequests = []; db.resourceAllocations = [];
      db.hospitalAcceptances = []; db.emergencyHistory = []; db.alerts = [];
      store._idempotencyKeys.clear();
      checker.violations.length = 0;
      checker.acquisitions = 0;
    },
    async forceExpire() {}, // the in-memory engine expires any live lock on request
    async pendingFor(requestId) {
      return db.hospitalAcceptances.filter(x => x.request_id === requestId && x.status === 'PENDING').map(x => x.acceptance_id);
    },
    async snapshot() {
      const softLocks = [];
      for (const entry of lockingEngine._activeLocks.values()) {
        for (const r of entry.lockedResources ?? []) softLocks.push({ resource_id: r.resource_id, request_id: entry.requestId });
      }
      return {
        resources: db.medicalResources.map(r => ({ resource_id: r.resource_id, hospital_id: r.hospital_id, resource_type: r.resource_type, total: r.total_capacity, available: r.available_capacity, locked: r.locked_capacity })),
        softLocks,
        committed: db.resourceAllocations.filter(x => x.status === 'COMMITTED').map(x => ({ resource_id: x.resource_id, request_id: x.request_id, hospital_id: x.hospital_id })),
        pending: db.hospitalAcceptances.filter(x => x.status === 'PENDING').map(x => ({ acceptance_id: x.acceptance_id, request_id: x.request_id, hospital_id: x.hospital_id })),
        requests: db.emergencyRequests.map(q => ({ request_id: q.request_id, status: q.status, resource_types: q.required_resource_types ?? [] })),
        ambulances: db.ambulances.map(x => ({ ambulance_id: x.ambulance_id, status: x.status, assigned_request_id: x.assigned_request_id ?? null }))
      };
    },
    async serverInfo() { return { backend: 'memory', database: 'in-memory demo store' }; },
    async close() { clearEngine(); uninstall(); await store.close(); }
  };
}

// ── MySQL (*_test database only) ─────────────────────────────────────────────────────────────────
export async function createMysqlBackend(fixture, { poolSize = 20 } = {}) {
  const handle = await openTestDatabase();
  if (handle.skip) return { skip: handle.skip };
  const { admin, config } = handle;
  const rows = fixtureRows(fixture);
  const rawPool = createPool({ ...config, connectionLimit: poolSize });
  const checker = new LockOrderChecker();
  const store = new MySqlStore({ pool: instrumentMysqlPool(rawPool, checker) });
  const all = async (sql, params = []) => (await admin.query(sql, params))[0];

  return {
    name: 'mysql', store, engine: store.lockingEngine, hooks: store.lockingEngine.hooks, checker, poolSize,
    admin, // the *_test database's admin connection (harness tests use it to inject faults)
    async reset() {
      store.lockingEngine.hooks.clear();
      await handle.reset(false); // drop + recreate the schema from schema.sql in the *_test database
      for (const h of rows.hospitals) {
        await admin.query(
          `INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone, emergency_status, acceptance_rate, avg_response_sec)
           VALUES (?, ?, 'Simulated Ave', ?, ?, '000', ?, ?, ?)`,
          [h.hospital_id, h.hospital_name, COORDS.location_lat, COORDS.location_lng, h.emergency_status, h.acceptance_rate, h.avg_response_sec]
        );
      }
      for (const r of rows.resources) {
        await admin.query('INSERT INTO MedicalResource (resource_id, hospital_id, resource_type, total_capacity, available_capacity, locked_capacity) VALUES (?, ?, ?, ?, ?, ?)',
          [r.resource_id, r.hospital_id, r.resource_type, r.total_capacity, r.available_capacity, r.locked_capacity]);
      }
      for (const x of rows.doctors) {
        await admin.query('INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status) VALUES (?, ?, ?, ?, ?)',
          [x.doctor_id, x.hospital_id, x.full_name, x.specialization, x.availability_status]);
      }
      for (const x of rows.ambulances) {
        await admin.query('INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status) VALUES (?, ?, ?, ?, ?)',
          [x.ambulance_id, x.hospital_id, x.vehicle_number, x.ambulance_type, x.status]);
      }
      checker.violations.length = 0;
      checker.acquisitions = 0;
    },
    /** Backdate the persisted expiry so the database clock considers the lock expired. */
    async forceExpire(acceptanceId) {
      await admin.query('UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 1 SECOND WHERE acceptance_id = ?', [acceptanceId]);
    },
    async pendingFor(requestId) {
      return (await all("SELECT acceptance_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [requestId])).map(x => x.acceptance_id);
    },
    async snapshot() {
      const parse = v => (typeof v === 'string' ? JSON.parse(v) : v ?? []);
      return {
        resources: await all('SELECT resource_id, hospital_id, resource_type, total_capacity AS total, available_capacity AS available, locked_capacity AS locked FROM MedicalResource'),
        softLocks: await all("SELECT resource_id, request_id FROM ResourceAllocation WHERE status = 'LOCKED'"),
        committed: await all("SELECT resource_id, request_id, hospital_id FROM ResourceAllocation WHERE status = 'COMMITTED'"),
        pending: await all("SELECT acceptance_id, request_id, hospital_id FROM HospitalAcceptance WHERE status = 'PENDING'"),
        requests: (await all('SELECT request_id, status, required_resources FROM EmergencyRequest')).map(q => ({ request_id: q.request_id, status: q.status, resource_types: parse(q.required_resources) })),
        ambulances: await all('SELECT ambulance_id, status, assigned_request_id FROM Ambulance')
      };
    },
    async serverInfo() {
      const [[row]] = await admin.query('SELECT VERSION() AS version, @@lower_case_table_names AS lctn, @@innodb_lock_wait_timeout AS global_lock_wait, @@transaction_isolation AS default_isolation');
      return { backend: 'mysql', mysqlVersion: row.version, lowerCaseTableNames: Number(row.lctn), databaseIsTest: /_test$/.test(config.database), poolSize, sessionLockWaitTimeoutSec: 10, engineIsolation: 'READ-COMMITTED' };
    },
    async close() {
      store.lockingEngine.hooks.clear();
      await store.close();
      await handle.release();
    }
  };
}
