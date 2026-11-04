// Backend adapters for the contract suite: the SAME scenarios run against the in-memory store and the
// MySQL store, through the store interface the routes use. Each adapter also installs the lock-order
// checker, so every scenario doubles as a lock-order check on that backend.
//
// The adapters read state directly from the backend (db arrays / SQL) so assertions never depend on the
// code under test to report its own state.

import { db } from '../../server/db/seed.js';
import { lockingEngine } from '../../server/services/lockingEngine.js';
import { MemoryStore } from '../../server/db/memoryStore.js';
import { MySqlStore } from '../../server/db/mysqlStore.js';
import { createPool } from '../../server/db/pool.js';
import { LockOrderChecker, installMemoryLockOrderChecker, instrumentMysqlPool } from '../../server/services/lockOrder.js';
import { openTestDatabase } from '../helpers/mysqlTestDb.js';
import { HOSPITALS, RESOURCES, DOCTORS, AMBULANCES, COORDINATES } from './fixture.js';

const clone = rows => rows.map(row => ({ ...row }));
const parseJson = value => (typeof value === 'string' ? JSON.parse(value) : value ?? null);

// ── In-memory ────────────────────────────────────────────────────────────────────────────────────
export async function createMemoryBackend() {
  const store = new MemoryStore({ db, lockingEngine });
  const checker = new LockOrderChecker();
  const uninstallChecker = installMemoryLockOrderChecker(checker);

  const clearEngine = () => {
    for (const entry of lockingEngine._activeLocks.values()) clearInterval(entry.countdownTimer);
    lockingEngine._activeLocks.clear();
    lockingEngine._requestLocks.clear();
    lockingEngine.hooks.clear();
    db._mutexes.clear();
  };
  const findResource = (hospitalId, type) => db.medicalResources.find(r => r.hospital_id === hospitalId && r.resource_type === type);

  return {
    name: 'memory',
    store,
    engine: lockingEngine,
    hooks: lockingEngine.hooks,
    checker,
    async reset() {
      clearEngine();
      db.hospitals = HOSPITALS.map(h => ({ ...h, ...COORDINATES, address: 'Fictional Ave', contact_phone: '000' }));
      db.medicalResources = RESOURCES.map(r => ({ ...r, version_lock: 0 }));
      db.doctors = clone(DOCTORS);
      db.ambulances = clone(AMBULANCES);
      db.patients = [];
      db.emergencyRequests = [];
      db.resourceAllocations = [];
      db.hospitalAcceptances = [];
      db.emergencyHistory = [];
      db.alerts = [];
      store._idempotencyKeys.clear();
      checker.violations.length = 0;
    },
    async setCapacity(hospitalId, type, { total, available = total, locked = 0 }) {
      Object.assign(findResource(hospitalId, type), { total_capacity: total, available_capacity: available, locked_capacity: locked });
    },
    async resource(hospitalId, type) {
      const r = findResource(hospitalId, type);
      return { total: r.total_capacity, available: r.available_capacity, locked: r.locked_capacity };
    },
    async allResources() {
      return db.medicalResources.map(r => ({ hospital_id: r.hospital_id, resource_type: r.resource_type, total: r.total_capacity, available: r.available_capacity, locked: r.locked_capacity }));
    },
    async request(requestId) {
      const r = db.emergencyRequests.find(item => item.request_id === requestId);
      return r ? { status: r.status } : null;
    },
    async countRequests(requestId) {
      return db.emergencyRequests.filter(item => item.request_id === requestId).length;
    },
    async acceptances(requestId) {
      return db.hospitalAcceptances.filter(a => a.request_id === requestId)
        .map(a => ({ acceptance_id: a.acceptance_id, hospital_id: a.hospital_id, status: a.status }));
    },
    async allocations(requestId) {
      return db.resourceAllocations.filter(a => a.request_id === requestId).map(a => ({ status: a.status, resource_id: a.resource_id }));
    },
    async audit(requestId) {
      return db.emergencyHistory.filter(h => h.request_id === requestId)
        .map(h => ({ event_type: h.event_type, new_state: h.new_state ?? null, metadata: h.metadata ?? null }));
    },
    async ambulance(ambulanceId) {
      const a = db.ambulances.find(item => item.ambulance_id === ambulanceId);
      return { status: a.status, assigned_request_id: a.assigned_request_id ?? null };
    },
    /** The in-memory engine expires any live lock on request; nothing to backdate. */
    async forceExpire() {},
    async close() {
      clearEngine();
      uninstallChecker();
      await store.close();
    }
  };
}

// ── MySQL (dedicated *_test database only) ───────────────────────────────────────────────────────
export async function createMysqlBackend() {
  const handle = await openTestDatabase(); // refuses any database whose name does not end in "_test"
  if (handle.skip) return { skip: handle.skip };
  const { admin, config } = handle;
  await handle.reset(false); // drop + recreate the schema from schema.sql, no demo data

  const rawPool = createPool({ ...config, connectionLimit: 20 });
  const checker = new LockOrderChecker();
  const store = new MySqlStore({ pool: instrumentMysqlPool(rawPool, checker) });
  const one = async (sql, params = []) => (await admin.query(sql, params))[0][0] ?? null;
  const all = async (sql, params = []) => (await admin.query(sql, params))[0];

  return {
    name: 'mysql',
    store,
    engine: store.lockingEngine,
    hooks: store.lockingEngine.hooks,
    checker,
    admin,
    config,
    async reset() {
      store.lockingEngine.hooks.clear();
      await admin.query(`SET FOREIGN_KEY_CHECKS = 0;
        TRUNCATE TABLE EmergencyHistory; TRUNCATE TABLE Alert; TRUNCATE TABLE ResourceAllocation; TRUNCATE TABLE HospitalAcceptance;
        TRUNCATE TABLE Ambulance; TRUNCATE TABLE EmergencyRequest; TRUNCATE TABLE Patient; TRUNCATE TABLE IdempotencyKey;
        TRUNCATE TABLE Doctor; TRUNCATE TABLE MedicalResource; TRUNCATE TABLE SystemUser; TRUNCATE TABLE Hospital;
        SET FOREIGN_KEY_CHECKS = 1`);
      for (const h of HOSPITALS) {
        await admin.query(
          `INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone, emergency_status, acceptance_rate, avg_response_sec)
           VALUES (?, ?, 'Fictional Ave', ?, ?, '000', ?, ?, ?)`,
          [h.hospital_id, h.hospital_name, COORDINATES.location_lat, COORDINATES.location_lng, h.emergency_status, h.acceptance_rate, h.avg_response_sec]
        );
      }
      for (const r of RESOURCES) {
        await admin.query(
          'INSERT INTO MedicalResource (resource_id, hospital_id, resource_type, total_capacity, available_capacity, locked_capacity) VALUES (?, ?, ?, ?, ?, ?)',
          [r.resource_id, r.hospital_id, r.resource_type, r.total_capacity, r.available_capacity, r.locked_capacity]
        );
      }
      for (const d of DOCTORS) {
        await admin.query(
          'INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status) VALUES (?, ?, ?, ?, ?)',
          [d.doctor_id, d.hospital_id, d.full_name, d.specialization, d.availability_status]
        );
      }
      for (const a of AMBULANCES) {
        await admin.query(
          'INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status) VALUES (?, ?, ?, ?, ?)',
          [a.ambulance_id, a.hospital_id, a.vehicle_number, a.ambulance_type, a.status]
        );
      }
      checker.violations.length = 0;
    },
    async setCapacity(hospitalId, type, { total, available = total, locked = 0 }) {
      await admin.query(
        'UPDATE MedicalResource SET total_capacity = ?, available_capacity = ?, locked_capacity = ? WHERE hospital_id = ? AND resource_type = ?',
        [total, available, locked, hospitalId, type]
      );
    },
    async resource(hospitalId, type) {
      const r = await one('SELECT total_capacity, available_capacity, locked_capacity FROM MedicalResource WHERE hospital_id = ? AND resource_type = ?', [hospitalId, type]);
      return { total: r.total_capacity, available: r.available_capacity, locked: r.locked_capacity };
    },
    async allResources() {
      return (await all('SELECT hospital_id, resource_type, total_capacity, available_capacity, locked_capacity FROM MedicalResource ORDER BY resource_id'))
        .map(r => ({ hospital_id: r.hospital_id, resource_type: r.resource_type, total: r.total_capacity, available: r.available_capacity, locked: r.locked_capacity }));
    },
    async request(requestId) {
      return one('SELECT status FROM EmergencyRequest WHERE request_id = ?', [requestId]);
    },
    async countRequests(requestId) {
      return Number((await one('SELECT COUNT(*) AS n FROM EmergencyRequest WHERE request_id = ?', [requestId])).n);
    },
    async acceptances(requestId) {
      return all('SELECT acceptance_id, hospital_id, status FROM HospitalAcceptance WHERE request_id = ? ORDER BY created_at, acceptance_id', [requestId]);
    },
    async allocations(requestId) {
      return all('SELECT status, resource_id FROM ResourceAllocation WHERE request_id = ? ORDER BY allocation_id', [requestId]);
    },
    async audit(requestId) {
      return (await all('SELECT event_type, new_state, metadata FROM EmergencyHistory WHERE request_id = ? ORDER BY history_id', [requestId]))
        .map(h => ({ event_type: h.event_type, new_state: h.new_state, metadata: parseJson(h.metadata) }));
    },
    async ambulance(ambulanceId) {
      return one('SELECT status, assigned_request_id FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
    },
    /** Backdate the persisted expiry so the database clock considers the lock expired. */
    async forceExpire(acceptanceId) {
      await admin.query('UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 1 SECOND WHERE acceptance_id = ?', [acceptanceId]);
    },
    async close() {
      store.lockingEngine.hooks.clear();
      await store.close(); // ends the pool
      await handle.release();
    }
  };
}
