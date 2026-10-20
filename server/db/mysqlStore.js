// server/db/mysqlStore.js
// MySQL implementation of the data-store interface (see server/db/store.js). Persistent: data
// survives restarts and is shared by every process pointed at the same database.
//
// Conventions
//  - Every value is a bound parameter; no SQL is assembled from user input.
//  - Anything that must succeed or fail together (state change + audit row, resource accounting,
//    id allocation) runs in ONE transaction via lockingEngine.transaction().
//  - Lock order is always: EmergencyRequest row -> Ambulance / MedicalResource rows (sorted by type).
//    This matches MySqlLockingEngine, so independent code paths cannot form a lock cycle.
//  - Only expected, business-level refusals become StoreError (4xx). Everything else (lost
//    connection, SQL error) propagates and is reported as a generic 500; SQL text never reaches clients.

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MySqlLockingEngine, LockError } from '../services/mysqlLockingEngine.js';
import { StoreError } from './storeErrors.js';

const ER_DUP_ENTRY = 1062;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;

// DOCTOR shift columns are TIME; the API exposes "HH:MM".
const DOCTOR_COLUMNS = `d.doctor_id, d.hospital_id, d.full_name, d.specialization, d.availability_status,
  TIME_FORMAT(d.shift_start, '%H:%i') AS shift_start, TIME_FORMAT(d.shift_end, '%H:%i') AS shift_end,
  d.created_at, COALESCE(h.hospital_name, 'Unknown') AS hospital_name`;

function mapRequest(row) {
  if (!row) return null;
  let types = row.required_resources;
  if (typeof types === 'string') {
    try { types = JSON.parse(types); } catch { types = []; }
  }
  if (!Array.isArray(types)) types = [];
  const { required_resources: _raw, ...rest } = row;
  return { ...rest, required_resources: types, required_resource_types: types };
}

export class MySqlStore extends EventEmitter {
  constructor({ pool }) {
    super();
    if (!pool) throw new Error('MySqlStore requires a mysql2 pool.');
    this.mode = 'mysql';
    this.pool = pool;
    this.lockingEngine = new MySqlLockingEngine({ pool });
    this.lockingEngine.on('audit', entry => this.emit('audit', entry));
    this._stopSweeper = null;
  }

  /** Start the TTL sweeper (persisted lock expiry; replaces the in-memory timers). */
  startBackgroundWorkers({ sweepIntervalMs = 5000 } = {}) {
    this._stopSweeper?.();
    this._stopSweeper = this.lockingEngine.startExpirySweeper(sweepIntervalMs);
  }

  /** Cheap reachability probe for /health. Throws if the database cannot be queried. */
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  /** Stop workers and release every pooled connection. */
  async close() {
    this._stopSweeper?.();
    this._stopSweeper = null;
    await this.pool.end();
  }

  // ── small helpers ──────────────────────────────────────────────────────────
  async _rows(sql, params = []) {
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  async _row(sql, params = []) {
    return (await this._rows(sql, params))[0] || null;
  }

  _tx(work) {
    return this.lockingEngine.transaction(work);
  }

  /** Contention that outlasts the bounded lock wait is a retryable conflict, not a server fault. */
  async _guard(work) {
    try {
      return await work();
    } catch (err) {
      if (err.errno === ER_LOCK_WAIT_TIMEOUT || err.errno === ER_LOCK_DEADLOCK) {
        throw new StoreError(409, 'The resource is busy. Please retry.');
      }
      throw err;
    }
  }

  /** Translate the engine's business refusals; let infrastructure errors through untouched. */
  async _engine(work) {
    try {
      return await work();
    } catch (err) {
      if (err instanceof LockError) throw new StoreError(err.code === 'NOT_FOUND' ? 404 : 409, err.message);
      if (err.errno === ER_LOCK_WAIT_TIMEOUT || err.errno === ER_LOCK_DEADLOCK) {
        throw new StoreError(409, 'The resource is busy. Please retry.');
      }
      throw err;
    }
  }

  // ── Hospitals & resources ──────────────────────────────────────────────────
  async listHospitals({ status } = {}) {
    return status
      ? this._rows('SELECT * FROM Hospital WHERE emergency_status = ? ORDER BY hospital_id', [status.toUpperCase()])
      : this._rows('SELECT * FROM Hospital ORDER BY hospital_id');
  }

  async getHospital(hospitalId) {
    return this._row('SELECT * FROM Hospital WHERE hospital_id = ?', [hospitalId]);
  }

  async listResources(hospitalId) {
    return hospitalId
      ? this._rows('SELECT * FROM MedicalResource WHERE hospital_id = ? ORDER BY resource_id', [hospitalId])
      : this._rows('SELECT * FROM MedicalResource ORDER BY hospital_id, resource_id');
  }

  async countActiveAllocations(hospitalId) {
    const row = await this._row("SELECT COUNT(*) AS n FROM ResourceAllocation WHERE hospital_id = ? AND status <> 'RELEASED'", [hospitalId]);
    return Number(row.n);
  }

  async updateHospitalStatus(hospitalId, emergencyStatus, actor) {
    return this._guard(() => this._tx(async conn => {
      const [rows] = await conn.query('SELECT emergency_status FROM Hospital WHERE hospital_id = ? FOR UPDATE', [hospitalId]);
      if (!rows.length) return null;
      const previous = rows[0].emergency_status;
      await conn.query('UPDATE Hospital SET emergency_status = ? WHERE hospital_id = ?', [emergencyStatus, hospitalId]);
      await this.lockingEngine.audit(conn, {
        hospital_id: hospitalId, event_type: 'HOSPITAL_STATUS_CHANGED', previous_state: previous,
        new_state: emergencyStatus, actor_role: 'ADMIN', actor_id: actor.id
      });
      return { hospital_id: hospitalId, emergency_status: emergencyStatus };
    }));
  }

  async updateResourceCapacity(hospitalId, resourceType, { total, available }, actor) {
    const type = String(resourceType).toUpperCase();
    return this._guard(() => this._tx(async conn => {
      // The row lock is held for the whole read-validate-write, so a concurrent referral lock
      // cannot slip between the validation and the update.
      const [rows] = await conn.query(
        'SELECT * FROM MedicalResource WHERE hospital_id = ? AND resource_type = ? FOR UPDATE', [hospitalId, type]
      );
      if (!rows.length) throw new StoreError(404, 'Resource not found.');
      const resource = rows[0];

      const nextTotal = total === undefined ? resource.total_capacity : Number(total);
      const nextAvailable = available === undefined ? resource.available_capacity : Number(available);
      if (!Number.isInteger(nextTotal) || !Number.isInteger(nextAvailable)
        || nextTotal < 0 || nextAvailable < 0
        || nextAvailable > nextTotal
        || nextAvailable < resource.locked_capacity) {
        throw new StoreError(400, 'Capacity must be whole numbers with 0 <= locked <= available <= total.');
      }

      await conn.query(
        'UPDATE MedicalResource SET total_capacity = ?, available_capacity = ?, version_lock = version_lock + 1 WHERE resource_id = ?',
        [nextTotal, nextAvailable, resource.resource_id]
      );
      await this.lockingEngine.audit(conn, {
        hospital_id: hospitalId, event_type: 'RESOURCE_CAPACITY_UPDATED',
        previous_state: `${resource.total_capacity}:${resource.available_capacity}`, new_state: `${nextTotal}:${nextAvailable}`,
        actor_role: actor.role, actor_id: actor.id, metadata: { resource_type: resource.resource_type }
      });
      const [[updated]] = await conn.query('SELECT * FROM MedicalResource WHERE resource_id = ?', [resource.resource_id]);
      return updated;
    }));
  }

  // ── Doctors ────────────────────────────────────────────────────────────────
  async listDoctors({ hospitalId, specialization, availabilityStatus } = {}) {
    const where = [];
    const params = [];
    if (hospitalId) { where.push('d.hospital_id = ?'); params.push(hospitalId); }
    if (specialization) { where.push('d.specialization = ?'); params.push(specialization.toUpperCase()); }
    if (availabilityStatus) { where.push('d.availability_status = ?'); params.push(availabilityStatus.toUpperCase()); }
    return this._rows(
      `SELECT ${DOCTOR_COLUMNS} FROM Doctor d LEFT JOIN Hospital h ON h.hospital_id = d.hospital_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.doctor_id`,
      params
    );
  }

  async getDoctor(doctorId) {
    return this._row(
      `SELECT ${DOCTOR_COLUMNS} FROM Doctor d LEFT JOIN Hospital h ON h.hospital_id = d.hospital_id WHERE d.doctor_id = ?`, [doctorId]
    );
  }

  async hasAvailableSpecialist(hospitalId, specialization) {
    const row = await this._row(
      "SELECT 1 AS found FROM Doctor WHERE hospital_id = ? AND specialization = ? AND availability_status = 'AVAILABLE' LIMIT 1",
      [hospitalId, specialization]
    );
    return Boolean(row);
  }

  async addDoctor({ hospital_id, full_name, specialization, shift_start, shift_end }, actor) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this._guard(() => this._tx(async conn => {
          const [[max]] = await conn.query("SELECT COALESCE(MAX(CAST(SUBSTRING(doctor_id, 4) AS UNSIGNED)), 0) AS max_id FROM Doctor");
          const doctorId = `DR-${String(Number(max.max_id) + 1).padStart(3, '0')}`;
          await conn.query(
            `INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status, shift_start, shift_end)
             VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?)`,
            [doctorId, hospital_id, full_name, specialization.toUpperCase(), shift_start || '08:00', shift_end || '20:00']
          );
          await this.lockingEngine.audit(conn, {
            hospital_id, event_type: 'DOCTOR_ADDED', previous_state: null, new_state: 'AVAILABLE',
            actor_role: actor.role, actor_id: actor.id, metadata: { doctorId, full_name, specialization }
          });
          const [[doctor]] = await conn.query(
            `SELECT ${DOCTOR_COLUMNS} FROM Doctor d LEFT JOIN Hospital h ON h.hospital_id = d.hospital_id WHERE d.doctor_id = ?`, [doctorId]
          );
          return doctor;
        }));
      } catch (err) {
        // Two concurrent inserts computed the same next id: the loser retries with a fresh MAX().
        if (err.errno === ER_DUP_ENTRY && attempt < 5) continue;
        throw err;
      }
    }
  }

  async updateDoctorStatus(doctorId, availabilityStatus, actor) {
    return this._guard(() => this._tx(async conn => {
      const [rows] = await conn.query('SELECT hospital_id, full_name, availability_status FROM Doctor WHERE doctor_id = ? FOR UPDATE', [doctorId]);
      if (!rows.length) return null;
      const previous = rows[0].availability_status;
      await conn.query('UPDATE Doctor SET availability_status = ? WHERE doctor_id = ?', [availabilityStatus, doctorId]);
      await this.lockingEngine.audit(conn, {
        hospital_id: rows[0].hospital_id, event_type: 'DOCTOR_STATUS_CHANGED', previous_state: previous,
        new_state: availabilityStatus, actor_role: actor.role, actor_id: actor.id,
        metadata: { doctorId, full_name: rows[0].full_name }
      });
      return { doctor_id: doctorId, previous_status: previous, new_status: availabilityStatus };
    }));
  }

  async updateDoctorShift(doctorId, { shift_start, shift_end }) {
    return this._guard(() => this._tx(async conn => {
      const [rows] = await conn.query('SELECT doctor_id FROM Doctor WHERE doctor_id = ? FOR UPDATE', [doctorId]);
      if (!rows.length) return null;
      if (shift_start) await conn.query('UPDATE Doctor SET shift_start = ? WHERE doctor_id = ?', [shift_start, doctorId]);
      if (shift_end) await conn.query('UPDATE Doctor SET shift_end = ? WHERE doctor_id = ?', [shift_end, doctorId]);
      const [[doctor]] = await conn.query(
        "SELECT TIME_FORMAT(shift_start, '%H:%i') AS shift_start, TIME_FORMAT(shift_end, '%H:%i') AS shift_end FROM Doctor WHERE doctor_id = ?", [doctorId]
      );
      return { doctor_id: doctorId, shift_start: doctor.shift_start, shift_end: doctor.shift_end };
    }));
  }

  async removeDoctor(doctorId, actor) {
    return this._guard(() => this._tx(async conn => {
      const [rows] = await conn.query('SELECT * FROM Doctor WHERE doctor_id = ? FOR UPDATE', [doctorId]);
      if (!rows.length) return null;
      const removed = rows[0];
      await conn.query('DELETE FROM Doctor WHERE doctor_id = ?', [doctorId]);
      await this.lockingEngine.audit(conn, {
        hospital_id: removed.hospital_id, event_type: 'DOCTOR_REMOVED', previous_state: removed.availability_status,
        new_state: null, actor_role: 'ADMIN', actor_id: actor.id, metadata: { doctorId, full_name: removed.full_name }
      });
      return removed;
    }));
  }

  // ── Emergencies ────────────────────────────────────────────────────────────
  // hospitalScope: a hospital desk only sees cases that were referred to its own facility.
  async _visible(requestId, hospitalScope) {
    if (!hospitalScope) return true;
    const row = await this._row(
      'SELECT 1 AS found FROM HospitalAcceptance WHERE request_id = ? AND hospital_id = ? LIMIT 1', [requestId, hospitalScope]
    );
    return Boolean(row);
  }

  async listRequests({ status, hospitalScope } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('r.status = ?'); params.push(status.toUpperCase()); }
    if (hospitalScope) {
      where.push('EXISTS (SELECT 1 FROM HospitalAcceptance ha WHERE ha.request_id = r.request_id AND ha.hospital_id = ?)');
      params.push(hospitalScope);
    }
    const requests = (await this._rows(
      `SELECT r.* FROM EmergencyRequest r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.priority ASC, r.request_time ASC, r.request_id ASC`,
      params
    )).map(mapRequest);
    if (!requests.length) return [];

    const patients = await this._rows('SELECT * FROM Patient WHERE patient_id IN (?)', [[...new Set(requests.map(r => r.patient_id))]]);
    const byId = new Map(patients.map(p => [p.patient_id, p]));
    return requests.map(r => ({ ...r, patient: byId.get(r.patient_id) }));
  }

  async getRequest(requestId) {
    return mapRequest(await this._row('SELECT * FROM EmergencyRequest WHERE request_id = ?', [requestId]));
  }

  async getRequestDetail(requestId, { hospitalScope } = {}) {
    const request = await this.getRequest(requestId);
    if (!request || !(await this._visible(requestId, hospitalScope))) return null;
    const [patient, allocations, acceptances, auditEvents] = await Promise.all([
      this._row('SELECT * FROM Patient WHERE patient_id = ?', [request.patient_id]),
      this._rows('SELECT * FROM ResourceAllocation WHERE request_id = ? ORDER BY allocated_at, allocation_id', [requestId]),
      this._rows('SELECT * FROM HospitalAcceptance WHERE request_id = ? ORDER BY created_at, acceptance_id', [requestId]),
      this._rows('SELECT * FROM EmergencyHistory WHERE request_id = ? ORDER BY history_id', [requestId])
    ]);
    return { request, patient: patient || undefined, allocations, acceptances, auditEvents };
  }

  /** Returns null when the case is not visible to the scope; otherwise the (possibly empty) trail. */
  async listRequestAudit(requestId, { hospitalScope } = {}) {
    if (!(await this._visible(requestId, hospitalScope))) return null;
    return this._rows('SELECT * FROM EmergencyHistory WHERE request_id = ? ORDER BY event_time, history_id', [requestId]);
  }

  async createRequest({ patient, request }, actor) {
    for (let attempt = 0; ; attempt += 1) {
      const patientId = `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
      // Four digits keep the familiar REQ-#### format; widen after repeated collisions.
      const requestId = attempt < 20
        ? `REQ-${Math.floor(1000 + Math.random() * 9000)}`
        : `REQ-${Math.floor(100000 + Math.random() * 900000)}`;
      try {
        return await this._guard(() => this._tx(async conn => {
          await conn.query(
            `INSERT INTO Patient (patient_id, full_name, age, gender, emergency_type, triage_priority, contact_phone)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [patientId, patient.full_name, patient.age, patient.gender, patient.emergency_type, patient.triage_priority, patient.contact_phone]
          );
          await conn.query(
            `INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, required_specialist,
                                           priority, pickup_lat, pickup_lng, clinical_notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING')`,
            [requestId, patientId, request.emergency_type, JSON.stringify(request.required_resource_types), request.required_specialist,
              request.priority, request.pickup_lat, request.pickup_lng, request.clinical_notes]
          );
          await this.lockingEngine.audit(conn, {
            request_id: requestId, event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING',
            actor_role: actor.role, actor_id: actor.id,
            metadata: {
              patient_name: String(patient.full_name).trim(),
              emergency_type: request.emergency_type,
              triage_priority: request.priority,
              required_resource_types: request.required_resource_types,
              required_specialist: request.required_specialist
            }
          });
          return { request_id: requestId, patient_id: patientId, status: 'WAITING' };
        }));
      } catch (err) {
        if (err.errno === ER_DUP_ENTRY && attempt < 40) continue; // id collision: nothing was committed
        throw err;
      }
    }
  }

  async transitionRequestStatus(requestId, newStatus, actor) {
    let result;
    try {
      result = await this._engine(() => this.lockingEngine.transitionRequest(requestId, newStatus, { role: actor.role, id: actor.id }));
    } catch (err) {
      // Same wording as the in-memory store so the API contract is identical in both modes.
      if (err instanceof StoreError && err.status === 404) throw new StoreError(404, 'Request not found.');
      throw err;
    }
    // Atomic: there is no partially-applied state to report, so no lock-cleanup failure can occur.
    return { previous: result.previous, status: result.status, unchanged: result.unchanged, lockCleanupError: null };
  }

  // ── Referrals ──────────────────────────────────────────────────────────────
  async hasPendingAcceptance(requestId) {
    const row = await this._row("SELECT 1 AS found FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' LIMIT 1", [requestId]);
    return Boolean(row);
  }

  /** Take the 90s soft-lock (the engine also marks the case MATCHING in the same transaction). */
  async acquireReferralLock(hospitalId, requestId, resourceTypes) {
    return this._engine(() => this.lockingEngine.acquireSoftLock(hospitalId, requestId, resourceTypes));
  }

  async commitReferral(acceptanceId, actorId) {
    return this._engine(() => this.lockingEngine.commitAllocation(acceptanceId, actorId));
  }

  async rejectReferral(acceptanceId, reason, actorId) {
    return this._engine(() => this.lockingEngine.rejectAndFailover(acceptanceId, reason, actorId));
  }

  async getActiveLocks() {
    return this.lockingEngine.getActiveLocks();
  }

  async getAcceptance(acceptanceId) {
    return this._row('SELECT * FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]);
  }

  async listAcceptances({ hospitalId } = {}) {
    return hospitalId
      ? this._rows('SELECT * FROM HospitalAcceptance WHERE hospital_id = ? ORDER BY created_at, acceptance_id', [hospitalId])
      : this._rows('SELECT * FROM HospitalAcceptance ORDER BY created_at, acceptance_id');
  }

  async createAlert({ hospital_id, request_id, alert_type, message }) {
    const text = String(message).slice(0, 500);
    const [result] = await this.pool.query(
      'INSERT INTO Alert (hospital_id, request_id, alert_type, message) VALUES (?, ?, ?, ?)',
      [hospital_id ?? null, request_id ?? null, alert_type, text]
    );
    return { alert_id: result.insertId, hospital_id, request_id, alert_type, message: text, status: 'UNREAD', created_at: new Date().toISOString() };
  }

  // ── Ambulances ─────────────────────────────────────────────────────────────
  async listAmbulances({ status, hospitalId } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status.toUpperCase()); }
    if (hospitalId) { where.push('a.hospital_id = ?'); params.push(hospitalId); }
    return this._rows(
      `SELECT a.*, h.hospital_name FROM Ambulance a LEFT JOIN Hospital h ON h.hospital_id = a.hospital_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.ambulance_id`,
      params
    );
  }

  async getAmbulance(ambulanceId) {
    return this._row('SELECT * FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
  }

  async ambulanceSummary() {
    const row = await this._row(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'AVAILABLE'), 0) AS available, COALESCE(SUM(status = 'DISPATCHED'), 0) AS dispatched,
              COALESCE(SUM(status = 'IN_TRANSIT'), 0) AS in_transit, COALESCE(SUM(status = 'MAINTENANCE'), 0) AS maintenance
       FROM Ambulance`
    );
    return {
      total: Number(row.total), available: Number(row.available), dispatched: Number(row.dispatched),
      in_transit: Number(row.in_transit), maintenance: Number(row.maintenance)
    };
  }

  async updateAmbulanceStatus(ambulanceId, { status, request_id, current_lat, current_lng, eta_mins }, actor) {
    return this._guard(() => this._tx(async conn => {
      // Dispatch serialises on the case first (same order as referral accept), so two simultaneous
      // dispatches for one case cannot both pass the "already assigned" check.
      if (status === 'DISPATCHED') {
        if (!request_id) throw new StoreError(400, 'request_id is required when dispatching an ambulance.');
        const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [request_id]);
        if (!requests.length) throw new StoreError(404, 'Emergency request not found.');
        const [accepted] = await conn.query("SELECT 1 AS found FROM HospitalAcceptance WHERE request_id = ? AND status = 'ACCEPTED' LIMIT 1", [request_id]);
        if (!['ALLOCATED', 'IN_TREATMENT'].includes(requests[0].status) || !accepted.length) {
          throw new StoreError(409, 'Ambulance dispatch requires an accepted emergency referral.');
        }
      }

      const [ambulances] = await conn.query('SELECT * FROM Ambulance WHERE ambulance_id = ? FOR UPDATE', [ambulanceId]);
      if (!ambulances.length) throw new StoreError(404, 'Ambulance not found.');
      const amb = ambulances[0];

      if (status === 'DISPATCHED') {
        if (amb.status !== 'AVAILABLE') throw new StoreError(409, 'Ambulance is not available for dispatch.');
        const [assigned] = await conn.query(
          'SELECT ambulance_id FROM Ambulance WHERE assigned_request_id = ? AND ambulance_id <> ? LIMIT 1', [request_id, ambulanceId]
        );
        if (assigned.length) {
          throw new StoreError(409, `Request ${request_id} already has ambulance ${assigned[0].ambulance_id} assigned.`);
        }
      }

      const sets = ['status = ?'];
      const params = [status];
      if (status === 'DISPATCHED') { sets.push('assigned_request_id = ?'); params.push(request_id); }
      if (status === 'AVAILABLE') { sets.push('assigned_request_id = NULL', 'destination_hospital_id = NULL'); }
      if (current_lat !== undefined) { sets.push('current_lat = ?'); params.push(current_lat); }
      if (current_lng !== undefined) { sets.push('current_lng = ?'); params.push(current_lng); }
      if (eta_mins !== undefined) { sets.push('eta_mins = ?'); params.push(eta_mins); }
      await conn.query(`UPDATE Ambulance SET ${sets.join(', ')} WHERE ambulance_id = ?`, [...params, ambulanceId]);

      await this.lockingEngine.audit(conn, {
        request_id: status === 'DISPATCHED' ? request_id : null, hospital_id: amb.hospital_id,
        event_type: 'AMBULANCE_STATUS_CHANGED', previous_state: amb.status, new_state: status,
        actor_role: actor.role, actor_id: actor.id,
        metadata: { ambulance_id: amb.ambulance_id, vehicle_number: amb.vehicle_number }
      });
      const [[updated]] = await conn.query('SELECT * FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
      return updated;
    }));
  }

  // ── Analytics & live KPIs ──────────────────────────────────────────────────
  async getAnalyticsData() {
    const [hospitals, medicalResources, doctors, ambulances, emergencyRequests, hospitalAcceptances] = await Promise.all([
      this._rows('SELECT hospital_id, hospital_name, emergency_status FROM Hospital ORDER BY hospital_id'),
      this._rows('SELECT resource_id, hospital_id, resource_type, total_capacity, available_capacity, locked_capacity FROM MedicalResource ORDER BY hospital_id, resource_id'),
      this._rows('SELECT doctor_id, hospital_id, availability_status FROM Doctor'),
      this._rows('SELECT ambulance_id, status FROM Ambulance'),
      this._rows('SELECT request_id, status, priority FROM EmergencyRequest'),
      this._rows('SELECT acceptance_id, hospital_id, status, response_time_sec FROM HospitalAcceptance')
    ]);
    return { hospitals, medicalResources, doctors, ambulances, emergencyRequests, hospitalAcceptances };
  }

  async listAudit({ eventType, hospitalId, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (eventType) { where.push('event_type = ?'); params.push(eventType); }
    if (hospitalId) { where.push('hospital_id = ?'); params.push(hospitalId); }
    return this._rows(
      `SELECT * FROM EmergencyHistory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY event_time DESC, history_id DESC LIMIT ?`,
      [...params, Number(limit)]
    );
  }

  async getKpis() {
    const row = await this._row(
      `SELECT
         (SELECT COUNT(*) FROM EmergencyRequest WHERE status NOT IN ('COMPLETED', 'CANCELLED')) AS active_emergencies,
         (SELECT COUNT(*) FROM EmergencyRequest WHERE priority = 1 AND status = 'WAITING') AS critical_p1,
         (SELECT COALESCE(SUM(available_capacity), 0) FROM MedicalResource WHERE resource_type = 'ICU_BED') AS icu_available,
         (SELECT COALESCE(SUM(available_capacity), 0) FROM MedicalResource WHERE resource_type = 'VENTILATOR') AS ventilators_available,
         (SELECT COUNT(*) FROM Hospital WHERE emergency_status = 'OPEN') AS hospitals_open,
         (SELECT COUNT(*) FROM Ambulance WHERE status = 'AVAILABLE') AS ambulances_available,
         (SELECT COUNT(*) FROM HospitalAcceptance WHERE status = 'PENDING') AS active_locks`
    );
    return {
      active_emergencies: Number(row.active_emergencies), critical_p1: Number(row.critical_p1),
      icu_available: Number(row.icu_available), ventilators_available: Number(row.ventilators_available),
      hospitals_open: Number(row.hospitals_open), ambulances_available: Number(row.ambulances_available),
      active_locks: Number(row.active_locks), timestamp: new Date().toISOString()
    };
  }

  async getSnapshotCounts() {
    const row = await this._row(
      `SELECT
         (SELECT COUNT(*) FROM Hospital) AS hospitals,
         (SELECT COUNT(*) FROM Ambulance WHERE status = 'AVAILABLE') AS ambulances,
         (SELECT COUNT(*) FROM EmergencyRequest WHERE status NOT IN ('COMPLETED', 'CANCELLED')) AS emergencies,
         (SELECT COUNT(*) FROM HospitalAcceptance WHERE status = 'PENDING') AS active_locks`
    );
    return {
      hospitals: Number(row.hospitals), ambulances: Number(row.ambulances), emergencies: Number(row.emergencies),
      active_locks: Number(row.active_locks), server_time: new Date().toISOString()
    };
  }
}

export default MySqlStore;
