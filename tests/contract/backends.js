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
import fs from 'node:fs';
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
      db.doctorAssignments = [];
      db.requestClaims = [];
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
      return db.resourceAllocations.filter(a => a.request_id === requestId).map(a => ({ status: a.status, resource_id: a.resource_id, stage_no: a.stage_no ?? 1 }));
    },
    async audit(requestId) {
      return db.emergencyHistory.filter(h => h.request_id === requestId)
        .map(h => ({ event_type: h.event_type, previous_state: h.previous_state ?? null, new_state: h.new_state ?? null, metadata: h.metadata ?? null }));
    },
    async ambulance(ambulanceId) {
      const a = db.ambulances.find(item => item.ambulance_id === ambulanceId);
      return { status: a.status, assigned_request_id: a.assigned_request_id ?? null };
    },
    async doctor(doctorId) {
      const d = db.doctors.find(item => item.doctor_id === doctorId);
      return d ? { status: d.availability_status } : null;
    },
    /** Specialist assignments of a case (or of every case), oldest first. */
    async assignments(requestId = null) {
      return db.doctorAssignments.filter(a => requestId === null || a.request_id === requestId)
        .map(a => ({ doctor_id: a.doctor_id, hospital_id: a.hospital_id, acceptance_id: a.acceptance_id, status: a.status }));
    },
    /** True while some operation holds the hospital's lock (the per-hospital mutex). */
    async hospitalLockHeld(hospitalId) {
      return db.isHospitalLockHeld(hospitalId);
    },
    async hospitalFlag(hospitalId) {
      return db.hospitals.find(h => h.hospital_id === hospitalId).safety_state ?? 'SAFE';
    },
    async alerts() {
      return db.alerts.map(a => ({ hospital_id: a.hospital_id ?? null, request_id: a.request_id ?? null, alert_type: a.alert_type, message: a.message }));
    },
    /** Hospital-level audit events (no case), oldest first. */
    async hospitalAudit(hospitalId) {
      return db.emergencyHistory.filter(h => h.request_id === null && h.hospital_id === hospitalId)
        .map(h => ({ event_type: h.event_type, new_state: h.new_state ?? null, metadata: h.metadata ?? null }));
    },
    async currentStage(requestId) {
      return db.emergencyRequests.find(r => r.request_id === requestId).current_stage ?? 1;
    },
    /** Every chained audit row, in chain order (read straight from the ledger). */
    async chainRows() {
      return db.emergencyHistory.filter(h => h.chain_seq != null).sort((x, y) => x.chain_seq - y.chain_seq).map(h => ({ ...h }));
    },
    /** TAMPER (tests only): change fields of the chained row with this chain_seq, bypassing the application. */
    async tamperAudit(chainSeq, fields) {
      Object.assign(db.emergencyHistory.find(h => h.chain_seq === chainSeq), fields);
    },
    /** TAMPER (tests only): delete the chained row with this chain_seq. */
    async deleteAudit(chainSeq) {
      db.emergencyHistory.splice(db.emergencyHistory.findIndex(h => h.chain_seq === chainSeq), 1);
    },
    /** TAMPER (tests only): move the displayed event_time of the chained row by deltaMs (event_time_ms untouched). */
    async shiftAuditEventTime(chainSeq, deltaMs) {
      const row = db.emergencyHistory.find(h => h.chain_seq === chainSeq);
      row.event_time = new Date(Date.parse(row.event_time) + deltaMs).toISOString();
    },
    /**
     * TAMPER (tests only): append a row WITHOUT chain columns, as a writer bypassing the chain would. Returns its
     * history_id. (An explicit id is a MySQL notion; memory always appends, so its rule is array position.)
     */
    async insertUnchainedAudit(eventType) {
      const history_id = db.emergencyHistory.length + 1;
      db.emergencyHistory.push({ history_id, request_id: null, hospital_id: null, event_type: eventType, actor_role: 'SYSTEM', event_time: new Date().toISOString() });
      return history_id;
    },
    /** Record the current unchained rows as legacy, as migration 007 does on MySQL. Memory needs no mark (array position). */
    async markLegacy() {},
    /** Write one audit entry through the store's own writer (db.auditLog), as application code does. */
    async writeAudit(entry) {
      db.auditLog(entry);
    },
    /** Age every stored Idempotency-Key by `hours` (the store keeps its own creation time). */
    async ageIdempotencyKeys(hours) {
      for (const record of store._idempotencyKeys.values()) record.created_ms -= hours * 3_600_000;
    },
    /** Replace a case's recorded claim (rows: [{ stage_no, resource_type, quantity }]), e.g. a legacy backfilled one. */
    async setClaim(requestId, rows) {
      db.requestClaims = db.requestClaims.filter(c => c.request_id !== requestId).concat(rows.map(r => ({ request_id: requestId, quantity: 1, ...r })));
    },
    /** How many operations are queued for the hospital's mutex (a direct view of the FIFO queue). */
    async hospitalLockWaiters(hospitalId) {
      return db._mutexes.get(`hospital:${hospitalId}`)?.waiters.length ?? 0;
    },
    /**
     * FIXTURE (tests only): recorded history at explicit epoch-ms times, for the analytics contract. Audit events are
     * written as pre-chain rows (no chain_seq), so the hash chain is untouched.
     * fixture: { requests: [{ request_id, request_ms, emergency_type, priority, pickup_lat, pickup_lng, required_resource_types }],
     *            acceptances: [{ acceptance_id, request_id, hospital_id, status, created_ms, responded_ms }],
     *            events: [{ request_id, event_type, event_ms }] }
     */
    async insertAnalyticsFixture({ requests = [], acceptances = [], events = [] }) {
      const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
      for (const r of requests) {
        db.patients.push({ patient_id: `PAT-${r.request_id}`, full_name: 'Fictional Analytics Patient', age: 40, created_at: iso(r.request_ms) });
        db.emergencyRequests.push({
          request_id: r.request_id, patient_id: `PAT-${r.request_id}`, emergency_type: r.emergency_type, priority: r.priority,
          required_resource_types: r.required_resource_types, required_resources: r.required_resource_types, required_specialist: null,
          pickup_lat: r.pickup_lat ?? null, pickup_lng: r.pickup_lng ?? null, status: 'COMPLETED', current_stage: 1,
          is_demo: r.is_demo ? 1 : 0, request_time: iso(r.request_ms), updated_at: iso(r.request_ms)
        });
      }
      for (const a of acceptances) {
        db.hospitalAcceptances.push({ acceptance_id: a.acceptance_id, request_id: a.request_id, hospital_id: a.hospital_id, status: a.status, created_at: iso(a.created_ms), responded_at: iso(a.responded_ms) });
      }
      for (const e of events) {
        db.emergencyHistory.push({ history_id: db.emergencyHistory.length + 1, request_id: e.request_id, hospital_id: null, event_type: e.event_type, event_time: iso(e.event_ms), actor_role: 'SYSTEM' });
      }
    },
    /** Backdate the lock's expiry (live entry and record), as the MySQL adapter backdates lock_expires_at. */
    async forceExpire(acceptanceId) {
      const past = Date.now() - 1000;
      const entry = lockingEngine._activeLocks.get(acceptanceId);
      if (entry) entry.expiresAt = past;
      const acceptance = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
      if (acceptance) acceptance.lock_expires_at = new Date(past).toISOString();
    },
    /** TAMPER (tests only): write a case's status directly, bypassing the store (a manual edit / an unlocked writer). */
    async setRequestStatus(requestId, status) {
      db.emergencyRequests.find(r => r.request_id === requestId).status = status;
    },
    async close() {
      clearEngine();
      uninstallChecker();
      await store.close();
    }
  };
}

// ── MySQL (dedicated *_test database only) ───────────────────────────────────────────────────────
export async function createMysqlBackend() {
  // Loaded lazily (L-T5): the helper reads .env.local at import time, so a memory-only run never loads credentials.
  const { openTestDatabase } = await import('../helpers/mysqlTestDb.js');
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
        TRUNCATE TABLE EmergencyHistory; TRUNCATE TABLE Alert; TRUNCATE TABLE RequestClaim; TRUNCATE TABLE DoctorAssignment; TRUNCATE TABLE ResourceAllocation; TRUNCATE TABLE HospitalAcceptance;
        TRUNCATE TABLE Ambulance; TRUNCATE TABLE EmergencyRequest; TRUNCATE TABLE Patient; TRUNCATE TABLE IdempotencyKey;
        TRUNCATE TABLE Doctor; TRUNCATE TABLE MedicalResource; TRUNCATE TABLE SystemUser; TRUNCATE TABLE Hospital;
        SET FOREIGN_KEY_CHECKS = 1;
        UPDATE AuditChainHead SET chain_seq = 0, head_hash = REPEAT('0', 64), legacy_max_history_id = NULL, legacy_count = 0 WHERE id = 1`); // the ledger restarts at genesis, with no legacy rows
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
      return all('SELECT status, resource_id, stage_no FROM ResourceAllocation WHERE request_id = ? ORDER BY allocation_id', [requestId]);
    },
    async audit(requestId) {
      return (await all('SELECT event_type, previous_state, new_state, metadata FROM EmergencyHistory WHERE request_id = ? ORDER BY history_id', [requestId]))
        .map(h => ({ event_type: h.event_type, previous_state: h.previous_state, new_state: h.new_state, metadata: parseJson(h.metadata) }));
    },
    async ambulance(ambulanceId) {
      return one('SELECT status, assigned_request_id FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
    },
    async doctor(doctorId) {
      const d = await one('SELECT availability_status FROM Doctor WHERE doctor_id = ?', [doctorId]);
      return d ? { status: d.availability_status } : null;
    },
    async assignments(requestId = null) {
      return all(
        `SELECT doctor_id, hospital_id, acceptance_id, status FROM DoctorAssignment
         WHERE (? IS NULL OR request_id = ?) ORDER BY reserved_at, assignment_id`, [requestId, requestId]
      );
    },
    /**
     * True while another transaction holds the Hospital row lock. Probed with the same lock mode the engine
     * uses (FOR UPDATE), but NOWAIT: a held lock answers ER_LOCK_NOWAIT (3572) at once instead of waiting.
     */
    async hospitalLockHeld(hospitalId) {
      try {
        await admin.query('SELECT hospital_id FROM Hospital WHERE hospital_id = ? FOR UPDATE NOWAIT', [hospitalId]);
        return false;
      } catch (err) {
        if (err.errno === 3572) return true;
        throw err;
      }
    },
    /**
     * How many of our own connections are blocked in the engine's hospital-lock statement for this hospital.
     * An uncontended FOR UPDATE returns at once, so a thread still executing it is waiting for the lock.
     * Read from PROCESSLIST, which shows the same user's threads without extra privileges.
     */
    async hospitalFlag(hospitalId) {
      return (await one('SELECT safety_state FROM Hospital WHERE hospital_id = ?', [hospitalId])).safety_state;
    },
    async alerts() {
      return all('SELECT hospital_id, request_id, alert_type, message FROM Alert ORDER BY alert_id');
    },
    async hospitalAudit(hospitalId) {
      return (await all('SELECT event_type, new_state, metadata FROM EmergencyHistory WHERE request_id IS NULL AND hospital_id = ? ORDER BY history_id', [hospitalId]))
        .map(h => ({ event_type: h.event_type, new_state: h.new_state, metadata: parseJson(h.metadata) }));
    },
    async currentStage(requestId) {
      return Number((await one('SELECT current_stage FROM EmergencyRequest WHERE request_id = ?', [requestId])).current_stage);
    },
    async chainRows() {
      return all('SELECT * FROM EmergencyHistory WHERE chain_seq IS NOT NULL ORDER BY chain_seq');
    },
    async tamperAudit(chainSeq, fields) {
      const cols = Object.keys(fields);
      await admin.query(`UPDATE EmergencyHistory SET ${cols.map(c => `\`${c}\` = ?`).join(', ')} WHERE chain_seq = ?`,
        [...cols.map(c => (fields[c] !== null && typeof fields[c] === 'object' ? JSON.stringify(fields[c]) : fields[c])), chainSeq]);
    },
    async deleteAudit(chainSeq) {
      await admin.query('DELETE FROM EmergencyHistory WHERE chain_seq = ?', [chainSeq]);
    },
    async shiftAuditEventTime(chainSeq, deltaMs) {
      await admin.query('UPDATE EmergencyHistory SET event_time = event_time + INTERVAL ? MICROSECOND WHERE chain_seq = ?', [deltaMs * 1000, chainSeq]);
    },
    async insertUnchainedAudit(eventType, historyId = null) {
      const [result] = await admin.query("INSERT INTO EmergencyHistory (history_id, event_type, actor_role) VALUES (?, ?, 'SYSTEM')", [historyId, eventType]);
      return Number(result.insertId);
    },
    /** Exactly what migration 007 does: record the unchained rows below the first chained row as the legacy set. */
    async markLegacy() {
      const [statement] = fs.readFileSync(new URL('../../server/db/migrations/007_analytics_integrity.sql', import.meta.url), 'utf8')
        .match(/UPDATE AuditChainHead h[\s\S]*?;/);
      await admin.query(statement);
    },
    /** Make the next auto-increment history_id at least `next` (to leave an id gap, as deletions or rollbacks do). */
    async skipHistoryIds(next) {
      await admin.query(`ALTER TABLE EmergencyHistory AUTO_INCREMENT = ${Number(next)}`);
    },
    async writeAudit(entry) {
      await store.lockingEngine.transaction(conn => store.lockingEngine.audit(conn, entry));
    },
    async ageIdempotencyKeys(hours) {
      await admin.query('UPDATE IdempotencyKey SET created_at = created_at - INTERVAL ? HOUR', [hours]);
    },
    async setClaim(requestId, rows) {
      await admin.query('DELETE FROM RequestClaim WHERE request_id = ?', [requestId]);
      for (const r of rows) {
        await admin.query('INSERT INTO RequestClaim (request_id, stage_no, resource_type, quantity) VALUES (?, ?, ?, ?)', [requestId, r.stage_no, r.resource_type, r.quantity ?? 1]);
      }
    },
    async hospitalLockWaiters(hospitalId) {
      const row = await one(
        `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST
         WHERE ID <> CONNECTION_ID() AND COMMAND = 'Query' AND INFO LIKE ?`,
        [`%FROM Hospital WHERE hospital_id = '${hospitalId.replace(/[^A-Z0-9-]/gi, '')}' FOR UPDATE%`]
      );
      return Number(row.n);
    },
    /** FIXTURE (tests only): see the in-memory adapter. Times are written as epoch values (FROM_UNIXTIME). */
    async insertAnalyticsFixture({ requests = [], acceptances = [], events = [] }) {
      const sec = ms => (ms === null || ms === undefined ? null : ms / 1000);
      for (const r of requests) {
        await admin.query(
          "INSERT INTO Patient (patient_id, full_name, age, emergency_type, created_at) VALUES (?, 'Fictional Analytics Patient', 40, ?, FROM_UNIXTIME(?))",
          [`PAT-${r.request_id}`, r.emergency_type, sec(r.request_ms)]);
        await admin.query(
          `INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, priority, pickup_lat, pickup_lng, status, is_demo, request_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, FROM_UNIXTIME(?))`,
          [r.request_id, `PAT-${r.request_id}`, r.emergency_type, JSON.stringify(r.required_resource_types), r.priority, r.pickup_lat ?? null, r.pickup_lng ?? null,
            r.is_demo ? 1 : 0, sec(r.request_ms)]);
      }
      for (const a of acceptances) {
        await admin.query(
          `INSERT INTO HospitalAcceptance (acceptance_id, request_id, hospital_id, status, lock_expires_at, responded_at, created_at)
           VALUES (?, ?, ?, ?, FROM_UNIXTIME(?) + INTERVAL 90 SECOND, FROM_UNIXTIME(?), FROM_UNIXTIME(?))`,
          [a.acceptance_id, a.request_id, a.hospital_id, a.status, sec(a.created_ms), sec(a.responded_ms), sec(a.created_ms)]);
      }
      for (const e of events) {
        await admin.query("INSERT INTO EmergencyHistory (request_id, event_type, actor_role, event_time) VALUES (?, ?, 'SYSTEM', FROM_UNIXTIME(?))",
          [e.request_id, e.event_type, sec(e.event_ms)]);
      }
    },
    async setRequestStatus(requestId, status) {
      await admin.query('UPDATE EmergencyRequest SET status = ? WHERE request_id = ?', [status, requestId]);
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
