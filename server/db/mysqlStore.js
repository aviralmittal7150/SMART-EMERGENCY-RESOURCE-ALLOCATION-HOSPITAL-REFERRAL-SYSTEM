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
import { ON_ROAD_AMBULANCE_STATUSES, transportRequired } from '../services/lifecycle.js';
import { buildClaim, claimRows, claimFromRows, describeClaim } from '../services/clinicalPathways.js';
import { REAL_ADMIN_SQL, changeEndsSessions } from '../services/accounts.js';
import { candidateRequestId, MAX_REQUEST_ID_ATTEMPTS } from '../services/requestIds.js';
import { victimLabel, incidentIdPrefix, incidentId } from '../services/incidents.js';
import { MOVING_PHASES as TRIP_MOVING_PHASES, etaMinutes } from '../services/tracking/phases.js';

const ER_DUP_ENTRY = 1062;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;
const IDEMPOTENCY_KEY_TTL_HOURS = 24; // see IDEMPOTENCY_KEY_TTL_MS in memoryStore.js
const HOSPITAL_PATIENTS_COMPLETED_HOURS = 24; // see HOSPITAL_PATIENTS_COMPLETED_MS in memoryStore.js

// DOCTOR shift columns are TIME; the API exposes "HH:MM".
const DOCTOR_COLUMNS = `d.doctor_id, d.hospital_id, d.full_name, d.specialization, d.availability_status,
  TIME_FORMAT(d.shift_start, '%H:%i') AS shift_start, TIME_FORMAT(d.shift_end, '%H:%i') AS shift_end,
  d.created_at, COALESCE(h.hospital_name, 'Unknown') AS hospital_name`;

// The case's usable ambulance: assigned to it AND on the road (see lifecycle.js ON_ROAD_AMBULANCE_STATUSES).
const ASSIGNED_AMBULANCE_SQL = `(SELECT a.ambulance_id FROM Ambulance a WHERE a.assigned_request_id = r.request_id
   AND a.status IN (${ON_ROAD_AMBULANCE_STATUSES.map(s => `'${s}'`).join(', ')}) ORDER BY a.ambulance_id LIMIT 1) AS assigned_ambulance_id`;

// The hospital holding the case and the one with a pending referral (list column for the UI; same as memory).
const REFERRAL_HOSPITALS_SQL = `(SELECT ha.hospital_id FROM HospitalAcceptance ha WHERE ha.request_id = r.request_id AND ha.status = 'ACCEPTED'
   ORDER BY ha.responded_at DESC, ha.created_at DESC, ha.acceptance_id DESC LIMIT 1) AS accepted_hospital_id,
  (SELECT ha.hospital_id FROM HospitalAcceptance ha WHERE ha.request_id = r.request_id AND ha.status = 'PENDING'
   ORDER BY ha.created_at DESC, ha.acceptance_id DESC LIMIT 1) AS pending_hospital_id`;

const USER_COLUMNS = 'user_id, username, password_hash, role, hospital_id, ambulance_id, patient_id, display_name, is_active, is_demo, token_version';
// Never the hash: what the admin API returns.
const ACCOUNT_COLUMNS = 'user_id, username, role, hospital_id, ambulance_id, patient_id, display_name, is_active, is_demo, last_login, created_at';
const ACCOUNT_FIELDS = ['role', 'hospital_id', 'ambulance_id', 'patient_id', 'display_name', 'is_active'];
const normaliseAccount = row => (row ? { ...row, is_active: Number(row.is_active) ? 1 : 0, is_demo: Number(row.is_demo) ? 1 : 0 } : null);

/**
 * SQL condition (on EmergencyRequest r) for a case scope from server/services/accessPolicy.js; same rules as
 * MemoryStore._visible. Returns { sql, params }.
 */
function scopeCondition(scope) {
  switch (scope?.kind ?? 'all') {
    case 'all':
      return { sql: '1 = 1', params: [] };
    case 'hospital':
      return {
        sql: `EXISTS (SELECT 1 FROM HospitalAcceptance hs WHERE hs.request_id = r.request_id AND hs.hospital_id = ?
                AND hs.status IN (?))`,
        params: [scope.hospitalId, scope.statuses ?? ['PENDING', 'ACCEPTED']]
      };
    case 'user':
      return scope.ambulanceId
        ? {
          sql: '(r.created_by = ? OR EXISTS (SELECT 1 FROM Ambulance au WHERE au.assigned_request_id = r.request_id AND au.ambulance_id = ?))',
          params: [scope.userId, scope.ambulanceId]
        }
        : { sql: 'r.created_by = ?', params: [scope.userId] };
    case 'patient':
      return scope.patientId ? { sql: 'r.patient_id = ?', params: [scope.patientId] } : { sql: '1 = 0', params: [] };
    default:
      return { sql: '1 = 0', params: [] };
  }
}

function withTransport(request) {
  if (!request) return null;
  const assigned = request.assigned_ambulance_id ?? null;
  return { ...request, assigned_ambulance_id: assigned, transport_required: transportRequired(request.status, assigned, request.arrived_at) };
}

// AmbulanceTrip columns as the stores return them (the generated active_* columns stay internal).
export const TRIP_COLUMNS = `trip_id, request_id, ambulance_id, hospital_id, start_lat, start_lng, speed_kmh, route_to_patient, route_to_hospital,
  route_source, phase, progress, current_lat, current_lng, eta_seconds, paused, is_demo, created_by, version, created_at, started_at,
  arrived_patient_at, picked_up_at, arrived_hospital_at, completed_at, updated_at`;
const TRIP_MUTABLE = ['phase', 'progress', 'current_lat', 'current_lng', 'eta_seconds', 'paused', 'started_at', 'arrived_patient_at',
  'picked_up_at', 'arrived_hospital_at', 'completed_at'];
const TRIP_TIMESTAMPS = ['created_at', 'started_at', 'arrived_patient_at', 'picked_up_at', 'arrived_hospital_at', 'completed_at', 'updated_at'];

/** A trip row in the in-memory shape: numbers, 0/1 flags, ISO timestamps, routes as arrays. */
function mapTrip(row) {
  if (!row) return null;
  const route = value => (typeof value === 'string' ? JSON.parse(value) : value);
  const trip = {
    ...row,
    route_to_patient: route(row.route_to_patient),
    route_to_hospital: route(row.route_to_hospital),
    speed_kmh: Number(row.speed_kmh),
    progress: Number(row.progress),
    eta_seconds: row.eta_seconds === null ? null : Number(row.eta_seconds),
    paused: Number(row.paused) ? 1 : 0,
    is_demo: Number(row.is_demo) ? 1 : 0,
    version: Number(row.version)
  };
  for (const key of TRIP_TIMESTAMPS) trip[key] = row[key] instanceof Date ? row[key].toISOString() : (row[key] ?? null);
  return trip;
}

/** Internal signal: the Idempotency-Key already exists, so the create must replay instead of insert. */
class IdempotentReplay extends Error {}

function mapRequest(row) {
  if (!row) return null;
  let types = row.required_resources;
  if (typeof types === 'string') {
    try { types = JSON.parse(types); } catch { types = []; }
  }
  if (!Array.isArray(types)) types = [];
  // active_bed_key is the internal generated column behind the unique-bed rule (migration 011); never returned.
  const { required_resources: _raw, active_bed_key: _bedKey, ...rest } = row;
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
  startBackgroundWorkers({ sweepIntervalMs = 5000, purgeIntervalMs = 3_600_000 } = {}) {
    this._stopSweeper?.();
    const stopExpiry = this.lockingEngine.startExpirySweeper(sweepIntervalMs);
    const purge = setInterval(() => {
      this.purgeExpiredIdempotencyKeys().catch(err => console.error('[MYSQL] Idempotency key purge failed:', err.message));
    }, purgeIntervalMs);
    purge.unref?.();
    this._stopSweeper = () => { stopExpiry(); clearInterval(purge); };
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
      if (err instanceof LockError) throw new StoreError(err.code === 'NOT_FOUND' ? 404 : 409, err.message, err.code, err.safety ?? null);
      if (err.errno === ER_LOCK_WAIT_TIMEOUT || err.errno === ER_LOCK_DEADLOCK) {
        throw new StoreError(409, 'The resource is busy. Please retry.');
      }
      throw err;
    }
  }

  // ── Accounts (SystemUser) ──────────────────────────────────────────────────
  /** The account row (with its bcrypt hash) for a login. `username` has a binary collation: exact, case-sensitive. */
  async findUserByUsername(username) {
    return this._row(`SELECT ${USER_COLUMNS} FROM SystemUser WHERE username = ?`, [username]);
  }

  async getUser(userId) {
    return this._row(`SELECT ${USER_COLUMNS} FROM SystemUser WHERE user_id = ?`, [userId]);
  }

  /** How many active demo accounts exist (a production server warns about them at start-up). */
  async countDemoUsers() {
    return Number((await this._row('SELECT COUNT(*) AS n FROM SystemUser WHERE is_demo = 1 AND is_active = 1')).n);
  }

  // ── Account management (Batch 6 admin API) ─────────────────────────────────
  /** Accounts without password hashes, ordered by user_id. { total, users } */
  async listUsers({ role, active, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (role !== undefined) { where.push('role = ?'); params.push(role); }
    if (active !== undefined) { where.push('is_active = ?'); params.push(active ? 1 : 0); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ n }]] = await this.pool.query(`SELECT COUNT(*) AS n FROM SystemUser ${clause}`, params);
    const rows = await this._rows(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser ${clause} ORDER BY user_id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { total: Number(n), users: rows.map(normaliseAccount) };
  }

  async getAccount(userId) {
    return normaliseAccount(await this._row(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser WHERE user_id = ?`, [userId]));
  }

  async getPatient(patientId) {
    return this._row('SELECT * FROM Patient WHERE patient_id = ?', [patientId]);
  }

  /** Patients for the admin's account linking: id, name, age, gender only; optional case-insensitive id/name search. */
  async listPatients({ q, limit = 50, offset = 0 } = {}) {
    const like = q ? `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
    const clause = like ? 'WHERE LOWER(patient_id) LIKE LOWER(?) OR LOWER(full_name) LIKE LOWER(?)' : '';
    const params = like ? [like, like] : [];
    const [[{ n }]] = await this.pool.query(`SELECT COUNT(*) AS n FROM Patient ${clause}`, params);
    const patients = await this._rows(
      `SELECT patient_id, full_name, age, gender FROM Patient ${clause} ORDER BY patient_id LIMIT ? OFFSET ?`, [...params, limit, offset]
    );
    return { total: Number(n), patients: patients.map(p => ({ ...p, age: p.age === null ? null : Number(p.age) })) };
  }

  /**
   * Raw rows for GET /analytics/my-registrations (server/services/registrationReport.js): the non-demo cases registered
   * by `createdBy` in [fromMs, toMs), their milestone audit rows, and hospital names. Same shape as MemoryStore's. Times
   * leave MySQL as epoch values; the SQL range is widened by a day and the exact half-open window is applied here.
   */
  async getRegistrations({ createdBy, fromMs, toMs, eventTypes }) {
    const lo = Math.floor(fromMs / 1000);
    const hi = Math.ceil(toMs / 1000);
    const rows = await this._rows(
      `SELECT r.request_id, r.patient_id, p.full_name, p.age, p.gender, r.emergency_type, r.priority, r.status,
              ROUND(UNIX_TIMESTAMP(r.request_time) * 1000) AS registered_ms
       FROM EmergencyRequest r LEFT JOIN Patient p ON p.patient_id = r.patient_id
       WHERE r.created_by = ? AND r.is_demo = 0
         AND r.request_time >= FROM_UNIXTIME(?) - INTERVAL 1 DAY AND r.request_time < FROM_UNIXTIME(?) + INTERVAL 1 DAY`,
      [createdBy, lo, hi]
    );
    const requests = rows.map(r => ({ ...r, age: r.age === null ? null : Number(r.age), priority: Number(r.priority), registered_ms: Number(r.registered_ms) }))
      .filter(r => r.registered_ms >= fromMs && r.registered_ms < toMs);
    const events = requests.length ? (await this._rows(
      `SELECT request_id, event_type, new_state, hospital_id, metadata, history_id,
              COALESCE(event_time_ms, ROUND(UNIX_TIMESTAMP(event_time) * 1000)) AS ms
       FROM EmergencyHistory WHERE request_id IN (?) AND event_type IN (?)`,
      [requests.map(r => r.request_id), eventTypes]
    )).map(e => ({ ...e, ms: Number(e.ms), history_id: Number(e.history_id) })) : [];
    const hospitals = await this._rows('SELECT hospital_id, hospital_name FROM Hospital');
    return { requests, events, hospitals };
  }

  /** A successful login (bookkeeping only: token_version is not touched). */
  async recordLogin(userId) {
    await this.pool.query('UPDATE SystemUser SET last_login = NOW() WHERE user_id = ?', [userId]);
  }

  /** user_ids of the active PATIENT accounts of one patient (patient:case_update recipients). */
  async listPatientAccountIds(patientId) {
    return (await this._rows("SELECT user_id FROM SystemUser WHERE role = 'PATIENT' AND patient_id = ? AND is_active = 1", [patientId])).map(r => r.user_id);
  }

  async _auditAccount(conn, event, actor, user, metadata, previous = null, next = null) {
    await this.lockingEngine.audit(conn, {
      request_id: null, hospital_id: null, event_type: event, previous_state: previous, new_state: next,
      actor_role: actor.role, actor_id: actor.id, metadata: { user_id: user.user_id, username: user.username, ...metadata }
    });
  }

  /** Create an account (row already validated). Throws StoreError(409) on a taken username. */
  /** { isDemo }: only the tracking demo's set-up creates a demo account this way (never in production). */
  async createUser(row, actor, { isDemo = false } = {}) {
    try {
      return await this._guard(() => this._tx(async conn => {
        await conn.query(
          `INSERT INTO SystemUser (user_id, username, password_hash, role, hospital_id, ambulance_id, patient_id, display_name, is_active, is_demo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [row.user_id, row.username, row.password_hash, row.role, row.hospital_id ?? null, row.ambulance_id ?? null, row.patient_id ?? null, row.display_name,
            isDemo ? 1 : 0]
        );
        const [[user]] = await conn.query(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser WHERE user_id = ?`, [row.user_id]);
        await this._auditAccount(conn, 'USER_CREATED', actor, user,
          { role: user.role, hospital_id: user.hospital_id, ambulance_id: user.ambulance_id, patient_id: user.patient_id }, null, user.role);
        return normaliseAccount(user);
      }));
    } catch (err) {
      if (err.errno === ER_DUP_ENTRY) throw new StoreError(409, `Username "${row.username}" is already taken.`);
      throw err;
    }
  }

  /**
   * Apply validated changes in ONE transaction. The active non-demo ADMIN rows are locked first (FOR UPDATE), so two
   * concurrent demotions cannot both pass the last-admin check. `check(before, after, activeRealAdmins)` returns a
   * refusal { status, message } or null. Returns the account, or null when it does not exist.
   */
  async updateUser(userId, changes, actor, check = () => null) {
    return this._guard(() => this._tx(async conn => {
      const [admins] = await conn.query("SELECT user_id FROM SystemUser WHERE role = 'ADMIN' AND is_active = 1 AND is_demo = 0 FOR UPDATE");
      const [[before]] = await conn.query(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser WHERE user_id = ? FOR UPDATE`, [userId]);
      if (!before) return null;
      const current = normaliseAccount(before);
      const after = { ...current, ...changes };
      const refusal = check(current, normaliseAccount(after), admins.length);
      if (refusal) throw new StoreError(refusal.status ?? 409, refusal.message);
      const fields = ACCOUNT_FIELDS.filter(f => changes[f] !== undefined);
      // Decided against the row locked above (FOR UPDATE), in this transaction: a concurrent edit cannot skip the bump.
      const revokeTokens = changeEndsSessions(current, changes);
      const diff = Object.fromEntries(fields.filter(f => (current[f] ?? null) !== (changes[f] ?? null)).map(f => [f, [current[f] ?? null, changes[f] ?? null]]));
      const sets = [...fields.map(f => `${f} = ?`), ...(revokeTokens ? ['token_version = token_version + 1'] : [])];
      if (sets.length) {
        await conn.query(`UPDATE SystemUser SET ${sets.join(', ')} WHERE user_id = ?`, [...fields.map(f => changes[f]), userId]);
      }
      await this._auditAccount(conn, 'USER_UPDATED', actor, current, { changes: diff, sessions_revoked: revokeTokens }, diff.role?.[0] ?? null, diff.role?.[1] ?? null);
      const [[user]] = await conn.query(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser WHERE user_id = ?`, [userId]);
      return normaliseAccount(user);
    }));
  }

  async setUserPassword(userId, passwordHash, actor) {
    return this._guard(() => this._tx(async conn => {
      const [[user]] = await conn.query(`SELECT ${ACCOUNT_COLUMNS} FROM SystemUser WHERE user_id = ? FOR UPDATE`, [userId]);
      if (!user) return null;
      // A demo account given a real password becomes a real one (as scripts/user-create.js does).
      // Every older token is refused from now on (token_version).
      await conn.query('UPDATE SystemUser SET password_hash = ?, is_demo = 0, token_version = token_version + 1 WHERE user_id = ?', [passwordHash, userId]);
      await this._auditAccount(conn, 'USER_PASSWORD_RESET', actor, user, {});
      return normaliseAccount({ ...user, is_demo: 0 });
    }));
  }

  /** Active accounts that are not demo accounts (a production server refuses to start without one). */
  async countUsableAdmins() {
    return Number((await this._row(`SELECT COUNT(*) AS n FROM SystemUser WHERE ${REAL_ADMIN_SQL}`)).n); // usable, non-demo ADMIN accounts
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
      // Lock order (docs/lock-order.md): the per-hospital lock, then the resource row. The row lock is held
      // for the whole read-validate-write, so a concurrent referral lock cannot slip between the two.
      await this.lockingEngine.lockHospital(conn, hospitalId);
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
      // D5-A: the edit is allowed even if it leaves the hospital unsafe; that is recorded and alerted instead.
      const safety = await this.lockingEngine.refreshSafety(conn, hospitalId, { actor, cause: `capacity edit ${resource.resource_type}` });
      const [[updated]] = await conn.query('SELECT * FROM MedicalResource WHERE resource_id = ?', [resource.resource_id]);
      return { ...updated, safety: safety && { safe: safety.safe, safety_state: safety.safety_state, explanation: safety.explanation } };
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
          // Per-hospital lock first: a new doctor is a change to that hospital's specialist pool.
          await this.lockingEngine.lockHospital(conn, hospital_id);
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

  /**
   * Lock a doctor for an administrative change: the doctor's hospital first, then the doctor row (global
   * lock order). Refuses (409) while the doctor is reserved for / assigned to a case: that state is owned
   * by the referral lifecycle. With `requireNoHistory` it also refuses a doctor with any assignment history
   * (DoctorAssignment keeps it; ON DELETE RESTRICT). Returns the locked row, or null when the doctor does not exist.
   */
  async _lockDoctorForEdit(conn, doctorId, action, { requireNoHistory = false } = {}) {
    const [[pre]] = await conn.query('SELECT hospital_id FROM Doctor WHERE doctor_id = ?', [doctorId]);
    if (!pre) return null;
    await this.lockingEngine.lockHospital(conn, pre.hospital_id);
    const [rows] = await conn.query('SELECT * FROM Doctor WHERE doctor_id = ? FOR UPDATE', [doctorId]);
    if (!rows.length) return null;
    // Every writer of DoctorAssignment holds this hospital's lock, so this read is current.
    const [active] = await conn.query(
      "SELECT request_id FROM DoctorAssignment WHERE doctor_id = ? AND status IN ('LOCKED', 'COMMITTED') LIMIT 1", [doctorId]
    );
    if (active.length) {
      throw new StoreError(409, `Doctor ${doctorId} ${action} while ${rows[0].availability_status} for case ${active[0].request_id}.`);
    }
    if (requireNoHistory) {
      const [history] = await conn.query('SELECT 1 AS found FROM DoctorAssignment WHERE doctor_id = ? LIMIT 1', [doctorId]);
      if (history.length) {
        throw new StoreError(409, `Doctor ${doctorId} ${action}: they have case assignment history. Set them OFF_DUTY instead.`);
      }
    }
    return rows[0];
  }

  async updateDoctorStatus(doctorId, availabilityStatus, actor) {
    return this._guard(() => this._tx(async conn => {
      const doctor = await this._lockDoctorForEdit(conn, doctorId, 'cannot change status');
      if (!doctor) return null;
      const previous = doctor.availability_status;
      await conn.query('UPDATE Doctor SET availability_status = ? WHERE doctor_id = ?', [availabilityStatus, doctorId]);
      await this.lockingEngine.audit(conn, {
        hospital_id: doctor.hospital_id, event_type: 'DOCTOR_STATUS_CHANGED', previous_state: previous,
        new_state: availabilityStatus, actor_role: actor.role, actor_id: actor.id,
        metadata: { doctorId, full_name: doctor.full_name }
      });
      return { doctor_id: doctorId, previous_status: previous, new_status: availabilityStatus };
    }));
  }

  async updateDoctorShift(doctorId, { shift_start, shift_end }, actor = { role: 'SYSTEM', id: null }) {
    const SHIFT_SQL = "SELECT hospital_id, full_name, TIME_FORMAT(shift_start, '%H:%i') AS shift_start, TIME_FORMAT(shift_end, '%H:%i') AS shift_end FROM Doctor WHERE doctor_id = ?";
    return this._guard(() => this._tx(async conn => {
      const [rows] = await conn.query(`${SHIFT_SQL} FOR UPDATE`, [doctorId]);
      if (!rows.length) return null;
      const before = rows[0];
      if (shift_start) await conn.query('UPDATE Doctor SET shift_start = ? WHERE doctor_id = ?', [shift_start, doctorId]);
      if (shift_end) await conn.query('UPDATE Doctor SET shift_end = ? WHERE doctor_id = ?', [shift_end, doctorId]);
      const [[doctor]] = await conn.query(SHIFT_SQL, [doctorId]);
      // X11: a shift change is recorded like every other roster change (same event as the in-memory store).
      await this.lockingEngine.audit(conn, {
        hospital_id: before.hospital_id, event_type: 'DOCTOR_SHIFT_CHANGED',
        previous_state: `${before.shift_start}-${before.shift_end}`, new_state: `${doctor.shift_start}-${doctor.shift_end}`,
        actor_role: actor.role, actor_id: actor.id, metadata: { doctorId, full_name: before.full_name }
      });
      return { doctor_id: doctorId, shift_start: doctor.shift_start, shift_end: doctor.shift_end };
    }));
  }

  async removeDoctor(doctorId, actor) {
    return this._guard(() => this._tx(async conn => {
      const removed = await this._lockDoctorForEdit(conn, doctorId, 'cannot be removed', { requireNoHistory: true });
      if (!removed) return null;
      await conn.query('DELETE FROM Doctor WHERE doctor_id = ?', [doctorId]);
      await this.lockingEngine.audit(conn, {
        hospital_id: removed.hospital_id, event_type: 'DOCTOR_REMOVED', previous_state: removed.availability_status,
        new_state: null, actor_role: 'ADMIN', actor_id: actor.id, metadata: { doctorId, full_name: removed.full_name }
      });
      return removed;
    }));
  }

  // ── Emergencies ────────────────────────────────────────────────────────────
  /** Case visibility for a scope from server/services/accessPolicy.js (see scopeCondition). */
  async _visible(requestId, scope) {
    if ((scope?.kind ?? 'all') === 'all') return true;
    const condition = scopeCondition(scope);
    const row = await this._row(
      `SELECT 1 AS found FROM EmergencyRequest r WHERE r.request_id = ? AND ${condition.sql}`, [requestId, ...condition.params]
    );
    return Boolean(row);
  }

  async caseVisible(requestId, scope) {
    return this._visible(requestId, scope);
  }

  async listRequests({ status, scope } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('r.status = ?'); params.push(status.toUpperCase()); }
    if ((scope?.kind ?? 'all') !== 'all') {
      const condition = scopeCondition(scope);
      where.push(condition.sql);
      params.push(...condition.params);
    }
    const requests = (await this._rows(
      `SELECT r.*, ${ASSIGNED_AMBULANCE_SQL}, ${REFERRAL_HOSPITALS_SQL} FROM EmergencyRequest r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.priority ASC, r.request_time ASC, r.request_id ASC`,
      params
    )).map(row => withTransport(mapRequest(row)));
    if (!requests.length) return [];

    const patients = await this._rows('SELECT * FROM Patient WHERE patient_id IN (?)', [[...new Set(requests.map(r => r.patient_id))]]);
    const byId = new Map(patients.map(p => [p.patient_id, p]));
    return requests.map(r => ({ ...r, patient: byId.get(r.patient_id) }));
  }

  async getRequest(requestId) {
    return mapRequest(await this._row('SELECT * FROM EmergencyRequest WHERE request_id = ?', [requestId]));
  }

  async getRequestDetail(requestId, { scope } = {}) {
    // ONE scoped query decides "visible": a case that exists but is not in scope and a case that does not exist take
    // exactly the same path (no extra query that would let timing reveal whether a request id exists).
    const condition = scopeCondition(scope);
    const request = withTransport(mapRequest(await this._row(
      `SELECT r.*, ${ASSIGNED_AMBULANCE_SQL} FROM EmergencyRequest r WHERE r.request_id = ? AND ${condition.sql}`,
      [requestId, ...condition.params]
    )));
    if (!request) return null;
    const [patient, allocations, acceptances, auditEvents] = await Promise.all([
      this._row('SELECT * FROM Patient WHERE patient_id = ?', [request.patient_id]),
      this._rows('SELECT * FROM ResourceAllocation WHERE request_id = ? ORDER BY allocated_at, allocation_id', [requestId]),
      this._rows('SELECT * FROM HospitalAcceptance WHERE request_id = ? ORDER BY created_at, acceptance_id', [requestId]),
      this._rows('SELECT * FROM EmergencyHistory WHERE request_id = ? ORDER BY history_id', [requestId])
    ]);
    return { request, patient: patient || undefined, allocations, acceptances, auditEvents };
  }

  /** Returns null when the case is not visible to the scope; otherwise the (possibly empty) trail. */
  async listRequestAudit(requestId, { scope } = {}) {
    if (!(await this._visible(requestId, scope))) return null;
    return this._rows('SELECT * FROM EmergencyHistory WHERE request_id = ? ORDER BY event_time, history_id', [requestId]);
  }

  /**
   * idempotency: { key, endpoint, fingerprint } or null. The key row is inserted FIRST, in the same
   * transaction as the case: a concurrent duplicate blocks on the primary key until this commits, then
   * fails with a duplicate key and replays the original (or proceeds, if this one rolled back).
   */
  async createRequest({ patient, request }, actor, { idempotency = null, fixed = null } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      // fixed (the tracking demo's sample case only): exactly these ids, an existing patient row re-used (see MemoryStore).
      const patientId = fixed?.patientId ?? `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
      // Four digits keep the familiar REQ-#### format; widen after repeated collisions (server/services/requestIds.js).
      const requestId = fixed?.requestId ?? candidateRequestId(attempt);
      try {
        return await this._guard(() => this._tx(async conn => {
          if (idempotency) {
            // A key older than 24 h is absent (same rule as the in-memory store), even before the hourly purge runs.
            await conn.query(
              'DELETE FROM IdempotencyKey WHERE actor_id = ? AND endpoint = ? AND idem_key = ? AND created_at < NOW() - INTERVAL ? HOUR',
              [String(actor.id ?? ''), idempotency.endpoint, idempotency.key, IDEMPOTENCY_KEY_TTL_HOURS]
            );
            try {
              await conn.query(
                'INSERT INTO IdempotencyKey (actor_id, endpoint, idem_key, request_hash, resource_id) VALUES (?, ?, ?, ?, ?)',
                [String(actor.id ?? ''), idempotency.endpoint, idempotency.key, idempotency.fingerprint, requestId]
              );
            } catch (err) {
              if (err.errno === ER_DUP_ENTRY) throw new IdempotentReplay();
              throw err;
            }
          }
          const claim = await this._insertCase(conn, { patient, request }, actor, {
            requestId, patientId, isDemo: Boolean(fixed?.isDemo), reusePatient: Boolean(fixed)
          });
          return { request_id: requestId, patient_id: patientId, status: 'WAITING', replayed: false, claim: describeClaim(claim) };
        }));
      } catch (err) {
        if (err instanceof IdempotentReplay) return this._replayCreate(actor, idempotency);
        if (fixed && err.errno === ER_DUP_ENTRY) throw new StoreError(409, `Request ${fixed.requestId} already exists.`, 'EXISTS');
        if (err.errno === ER_DUP_ENTRY && attempt < MAX_REQUEST_ID_ATTEMPTS - 1) continue; // id collision: nothing was committed
        throw err;
      }
    }
  }

  /**
   * Insert one new case inside the caller's transaction: its patient (unless `reusePatient` and it exists), the request
   * (WAITING), its REQUEST_CREATED audit row and its maximum claim. Shared by createRequest and createIncident; returns
   * the claim. Same rows as MemoryStore._writeCase.
   */
  async _insertCase(conn, { patient, request }, actor, { requestId, patientId, isDemo = false, reusePatient = false, incident = null }) {
    const [[existingPatient]] = reusePatient ? await conn.query('SELECT 1 AS found FROM Patient WHERE patient_id = ? FOR UPDATE', [patientId]) : [[]];
    if (!existingPatient) {
      await conn.query(
        `INSERT INTO Patient (patient_id, full_name, age, gender, emergency_type, triage_priority, contact_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [patientId, patient.full_name, patient.age, patient.gender, patient.emergency_type, patient.triage_priority, patient.contact_phone]
      );
    }
    await conn.query(
      `INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, required_specialist,
                                     priority, pickup_lat, pickup_lng, clinical_notes, status, created_by, is_demo,
                                     incident_id, incident_seq, triage_category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?, ?)`,
      [requestId, patientId, request.emergency_type, JSON.stringify(request.required_resource_types), request.required_specialist,
        request.priority, request.pickup_lat, request.pickup_lng, request.clinical_notes, actor.id ?? null, isDemo ? 1 : 0,
        incident?.incident_id ?? null, incident?.incident_seq ?? null, incident?.triage_category ?? null]
    );
    await this.lockingEngine.audit(conn, {
      request_id: requestId, event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING',
      actor_role: actor.role, actor_id: actor.id,
      metadata: {
        patient_name: String(patient.full_name).trim(),
        emergency_type: request.emergency_type,
        triage_priority: request.priority,
        required_resource_types: request.required_resource_types,
        required_specialist: request.required_specialist,
        ...(incident ? { incident_id: incident.incident_id, triage_category: incident.triage_category } : {})
      }
    });
    // The maximum claim, fixed at intake (Banker's option A, D2-a4).
    const claim = buildClaim(request.emergency_type, { resourceTypes: request.required_resource_types || [], specialist: request.required_specialist });
    for (const row of claimRows(claim)) {
      await conn.query('INSERT INTO RequestClaim (request_id, stage_no, resource_type, quantity) VALUES (?, ?, ?, ?)',
        [requestId, row.stage_no, row.resource_type, row.quantity]);
    }
    return claim;
  }

  // ── Mass-casualty incidents (Batch 8 P1; same rows and rules as MemoryStore) ───────────────────────────────
  // Each call is ONE transaction: the incident row, every victim (Patient + EmergencyRequest + claim + REQUEST_CREATED),
  // the INCIDENT_CREATED / VICTIMS_REGISTERED audit rows and the Idempotency-Key row commit together or not at all.
  // The key row records "<incident_id>#<first seq>-<last seq>", so a replay returns exactly the victims it created.

  /** Insert the Idempotency-Key row first (a concurrent duplicate waits, then replays); IdempotentReplay on a duplicate. */
  async _claimIdempotencyKey(conn, actor, idempotency, resourceId) {
    await conn.query(
      'DELETE FROM IdempotencyKey WHERE actor_id = ? AND endpoint = ? AND idem_key = ? AND created_at < NOW() - INTERVAL ? HOUR',
      [String(actor.id ?? ''), idempotency.endpoint, idempotency.key, IDEMPOTENCY_KEY_TTL_HOURS]
    );
    try {
      await conn.query('INSERT INTO IdempotencyKey (actor_id, endpoint, idem_key, request_hash, resource_id) VALUES (?, ?, ?, ?, ?)',
        [String(actor.id ?? ''), idempotency.endpoint, idempotency.key, idempotency.fingerprint, resourceId]);
    } catch (err) {
      if (err.errno === ER_DUP_ENTRY) throw new IdempotentReplay();
      throw err;
    }
  }

  async _replayIncident(actor, idempotency) {
    const record = await this._row('SELECT request_hash, resource_id FROM IdempotencyKey WHERE actor_id = ? AND endpoint = ? AND idem_key = ?',
      [String(actor.id ?? ''), idempotency.endpoint, idempotency.key]);
    if (!record) throw new StoreError(409, 'A request with this Idempotency-Key is still in progress. Please retry.');
    if (record.request_hash !== idempotency.fingerprint) throw new StoreError(422, 'This Idempotency-Key was already used for a different request.');
    const [incident, range] = String(record.resource_id).split('#');
    const [from, to] = (range ?? '1-0').split('-').map(Number);
    const rows = await this._rows('SELECT request_id FROM EmergencyRequest WHERE incident_id = ? AND incident_seq BETWEEN ? AND ? ORDER BY incident_seq',
      [incident, from, to]);
    return { incident_id: incident, request_ids: rows.map(r => r.request_id), replayed: true };
  }

  /** Insert the victims (the caller holds the Incident row lock); returns { requestIds, first, last }. */
  async _insertVictims(conn, incident, victims, actor, isDemo) {
    const [[{ last }]] = await conn.query('SELECT COALESCE(MAX(incident_seq), 0) AS last FROM EmergencyRequest WHERE incident_id = ?', [incident.incident_id]);
    const first = Number(last) + 1;
    const requestIds = [];
    for (const [i, v] of victims.entries()) {
      let requestId = null;
      for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS && requestId === null; attempt += 1) {
        const candidate = candidateRequestId(attempt);
        if (requestIds.includes(candidate)) continue;
        const [[taken]] = await conn.query('SELECT 1 AS taken FROM EmergencyRequest WHERE request_id = ?', [candidate]);
        if (!taken) requestId = candidate;
      }
      if (requestId === null) throw new Error(`Could not allocate a unique request id after ${MAX_REQUEST_ID_ATTEMPTS} attempts.`);
      const seq = first + i;
      await this._insertCase(conn, { patient: { ...v.patient, full_name: v.patient.full_name ?? victimLabel(seq) }, request: v.request }, actor, {
        requestId, patientId: `PAT-${uuidv4().slice(0, 6).toUpperCase()}`, isDemo,
        incident: { incident_id: incident.incident_id, incident_seq: seq, triage_category: v.triage_category }
      });
      requestIds.push(requestId);
    }
    if (victims.length) {
      await this.lockingEngine.audit(conn, {
        request_id: null, event_type: 'VICTIMS_REGISTERED', previous_state: null, new_state: null, actor_role: actor.role, actor_id: actor.id,
        metadata: { incident_id: incident.incident_id, count: victims.length, request_ids: requestIds, first_seq: first, last_seq: first + victims.length - 1 }
      });
    }
    return { requestIds, first, last: first + victims.length - 1 };
  }

  /** Retry a whole incident transaction after an id collision with a concurrent writer (nothing was committed). */
  async _incidentTx(idempotency, actor, work) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this._guard(() => this._tx(work));
      } catch (err) {
        if (err instanceof IdempotentReplay) return this._replayIncident(actor, idempotency);
        if (err.errno === ER_DUP_ENTRY && attempt < 4) continue;
        throw err;
      }
    }
  }

  /** See MemoryStore.createIncident. */
  async createIncident(fields, victims, actor, { idempotency = null, isDemo = false } = {}) {
    return this._incidentTx(idempotency, actor, async conn => {
      const prefix = incidentIdPrefix();
      const [[latest]] = await conn.query('SELECT incident_id FROM Incident WHERE incident_id LIKE ? ORDER BY incident_id DESC LIMIT 1', [`${prefix}%`]);
      const row = {
        incident_id: incidentId(prefix, latest ? (Number(latest.incident_id.slice(prefix.length)) || 0) + 1 : 1), title: fields.title,
        incident_type: fields.incident_type, location_text: fields.location_text ?? null, location_lat: fields.location_lat, location_lng: fields.location_lng,
        description: fields.description ?? null, estimated_victims: fields.estimated_victims ?? null, vehicles_involved: fields.vehicles_involved ?? null,
        severity: fields.severity, occurred_at: fields.occurred_at ? new Date(fields.occurred_at) : null, created_by: actor.id ?? null, is_demo: isDemo ? 1 : 0
      };
      if (idempotency) await this._claimIdempotencyKey(conn, actor, idempotency, `${row.incident_id}#1-${victims.length}`);
      await conn.query(
        `INSERT INTO Incident (incident_id, title, incident_type, location_text, location_lat, location_lng, description, estimated_victims,
                               vehicles_involved, severity, occurred_at, created_by, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.incident_id, row.title, row.incident_type, row.location_text, row.location_lat, row.location_lng, row.description, row.estimated_victims,
          row.vehicles_involved, row.severity, row.occurred_at, row.created_by, row.is_demo]
      );
      await this.lockingEngine.audit(conn, {
        request_id: null, event_type: 'INCIDENT_CREATED', previous_state: null, new_state: null, actor_role: actor.role, actor_id: actor.id,
        metadata: { incident_id: row.incident_id, title: row.title, incident_type: row.incident_type, severity: row.severity, is_demo: Boolean(isDemo) }
      });
      const { requestIds } = await this._insertVictims(conn, row, victims, actor, isDemo);
      return { incident_id: row.incident_id, request_ids: requestIds, replayed: false };
    });
  }

  /** See MemoryStore.addIncidentVictims. The Incident row lock serialises concurrent additions (stable numbering). */
  async addIncidentVictims(incidentIdValue, victims, actor, { idempotency = null } = {}) {
    return this._incidentTx(idempotency, actor, async conn => {
      const [[incident]] = await conn.query('SELECT incident_id, is_demo FROM Incident WHERE incident_id = ? FOR UPDATE', [incidentIdValue]);
      if (!incident) throw new StoreError(404, 'Incident not found.');
      const [[{ last }]] = await conn.query('SELECT COALESCE(MAX(incident_seq), 0) AS last FROM EmergencyRequest WHERE incident_id = ?', [incidentIdValue]);
      if (idempotency) await this._claimIdempotencyKey(conn, actor, idempotency, `${incidentIdValue}#${Number(last) + 1}-${Number(last) + victims.length}`);
      const { requestIds } = await this._insertVictims(conn, incident, victims, actor, Number(incident.is_demo) === 1);
      return { incident_id: incidentIdValue, request_ids: requestIds, replayed: false };
    });
  }

  async listIncidents() {
    return this._rows(
      `SELECT i.*, (SELECT COUNT(*) FROM EmergencyRequest r WHERE r.incident_id = i.incident_id) AS victim_count
       FROM Incident i ORDER BY i.created_at DESC, i.incident_id DESC`
    );
  }

  async getIncident(incidentIdValue) {
    return this._row('SELECT * FROM Incident WHERE incident_id = ?', [incidentIdValue]);
  }

  async findDemoIncident() {
    return this._row('SELECT * FROM Incident WHERE is_demo = 1 ORDER BY created_at, incident_id LIMIT 1');
  }

  // ── Hospital patient board (Batch 8) ──────────────────────────────────────
  /** Same rows and order as MemoryStore.listHospitalPatients. */
  async listHospitalPatients(hospitalId) {
    const rows = await this._rows(
      `SELECT r.request_id, p.full_name AS patient_name, p.age, p.gender, r.priority AS triage_priority, r.emergency_type, r.status,
              r.incident_id, ${ASSIGNED_AMBULANCE_SQL},
              (SELECT t.phase FROM AmbulanceTrip t WHERE t.request_id = r.request_id ORDER BY t.created_at DESC, t.trip_id DESC LIMIT 1) AS trip_phase,
              ha.responded_at AS accepted_at, r.updated_at, r.triage_category,
              r.arrived_at, r.bed_label, r.bed_allocated_at, r.treatment_started_at, r.treatment_completed_at
       FROM EmergencyRequest r
       JOIN Patient p ON p.patient_id = r.patient_id
       JOIN HospitalAcceptance ha ON ha.acceptance_id = (
         SELECT h2.acceptance_id FROM HospitalAcceptance h2 WHERE h2.request_id = r.request_id AND h2.status = 'ACCEPTED'
         ORDER BY h2.responded_at DESC, h2.created_at DESC, h2.acceptance_id DESC LIMIT 1)
       WHERE ha.hospital_id = ?
         AND (r.status IN ('ALLOCATED', 'IN_TREATMENT') OR (r.status = 'COMPLETED' AND r.updated_at >= NOW() - INTERVAL ? HOUR))
       ORDER BY (r.status = 'COMPLETED') ASC, r.priority ASC, r.request_id ASC`,
      [hospitalId, HOSPITAL_PATIENTS_COMPLETED_HOURS]
    );
    const iso = t => (t == null ? null : (t instanceof Date ? t : new Date(t)).toISOString());
    return rows.map(r => ({
      request_id: r.request_id, patient_name: r.patient_name, age: r.age, gender: r.gender, triage_priority: Number(r.triage_priority),
      emergency_type: r.emergency_type, status: r.status, incident_id: r.incident_id ?? null, triage_category: r.triage_category ?? null,
      ambulance_id: r.assigned_ambulance_id ?? null, trip_phase: r.trip_phase ?? null, accepted_at: iso(r.accepted_at), updated_at: iso(r.updated_at),
      ...MySqlStore.milestones(r)
    }));
  }

  async _replayCreate(actor, idempotency) {
    const record = await this._row(
      'SELECT request_hash, resource_id FROM IdempotencyKey WHERE actor_id = ? AND endpoint = ? AND idem_key = ?',
      [String(actor.id ?? ''), idempotency.endpoint, idempotency.key]
    );
    if (!record) throw new StoreError(409, 'A request with this Idempotency-Key is still in progress. Please retry.');
    if (record.request_hash !== idempotency.fingerprint) {
      throw new StoreError(422, 'This Idempotency-Key was already used for a different request.');
    }
    // X11: a replay reports the case as it is NOW (it may have been referred or allocated since).
    const created = await this._row('SELECT patient_id, status FROM EmergencyRequest WHERE request_id = ?', [record.resource_id]);
    return { request_id: record.resource_id, patient_id: created?.patient_id ?? null, status: created?.status ?? 'WAITING', replayed: true };
  }

  /** Idempotency keys only need to outlive client retries; drop them after a day. */
  async purgeExpiredIdempotencyKeys(maxAgeHours = IDEMPOTENCY_KEY_TTL_HOURS) {
    const [result] = await this.pool.query('DELETE FROM IdempotencyKey WHERE created_at < NOW() - INTERVAL ? HOUR', [maxAgeHours]);
    return result.affectedRows;
  }

  /** options: see MemoryStore.transitionRequestStatus (Batch 8 hospital steps). */
  async transitionRequestStatus(requestId, newStatus, actor, options = {}) {
    let result;
    try {
      result = await this._engine(() => this.lockingEngine.transitionRequest(requestId, newStatus, { role: actor.role, id: actor.id }, options));
    } catch (err) {
      // Same wording as the in-memory store so the API contract is identical in both modes.
      if (err instanceof StoreError && err.status === 404) throw new StoreError(404, 'Request not found.');
      throw err;
    }
    // Atomic: there is no partially-applied state to report, so no lock-cleanup failure can occur.
    return { previous: result.previous, status: result.status, unchanged: result.unchanged, lockCleanupError: null,
      released_allocations: result.released_allocations, released_specialists: result.released_specialists };
  }

  // ── Hospital treatment steps (Batch 8, P0): same contracts as MemoryStore ──
  /** Lock the case row and check `hospitalId` holds it (latest ACCEPTED referral); 404 otherwise. */
  async _lockHeldCase(conn, requestId, hospitalId) {
    const [[request]] = await conn.query(
      `SELECT request_id, status, arrived_at, bed_label, bed_hospital_id, bed_allocated_at, treatment_started_at, treatment_completed_at
       FROM EmergencyRequest WHERE request_id = ? FOR UPDATE`, [requestId]);
    const [[holder]] = await conn.query(
      `SELECT hospital_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'ACCEPTED'
       ORDER BY responded_at DESC, created_at DESC, acceptance_id DESC LIMIT 1`, [requestId]);
    if (!request || !hospitalId || holder?.hospital_id !== hospitalId) throw new StoreError(404, 'Emergency request not found.');
    return request;
  }

  static milestones(r) {
    const iso = t => (t == null ? null : (t instanceof Date ? t : new Date(t)).toISOString());
    return { arrived_at: iso(r.arrived_at), bed_label: r.bed_label ?? null, bed_allocated_at: iso(r.bed_allocated_at),
      treatment_started_at: iso(r.treatment_started_at), treatment_completed_at: iso(r.treatment_completed_at) };
  }

  async _milestonesOf(conn, requestId) {
    const [[row]] = await conn.query(
      'SELECT status, arrived_at, bed_label, bed_allocated_at, treatment_started_at, treatment_completed_at FROM EmergencyRequest WHERE request_id = ?', [requestId]);
    return { status: row.status, milestones: MySqlStore.milestones(row) };
  }

  async confirmArrival(requestId, hospitalId, actor) {
    return this._guard(() => this._tx(async conn => {
      const request = await this._lockHeldCase(conn, requestId, hospitalId);
      if (request.arrived_at) return { unchanged: true, status: request.status, milestones: MySqlStore.milestones(request), released_seats: [] };
      if (request.status !== 'ALLOCATED') throw new StoreError(409, `Arrival can only be confirmed for an ALLOCATED case; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
      await conn.query('UPDATE EmergencyRequest SET arrived_at = NOW(3) WHERE request_id = ?', [requestId]);
      // Lock order: the EmergencyRequest row (above), then the case's seat rows.
      const [seats] = await conn.query(
        'SELECT assignment_id, ambulance_id FROM AmbulanceAssignment WHERE request_id = ? AND released_at IS NULL ORDER BY assignment_id FOR UPDATE', [requestId]);
      if (seats.length) {
        await conn.query(
          "UPDATE AmbulanceAssignment SET handed_over_at = NOW(3), released_at = NOW(3), release_reason = 'HANDOVER' WHERE request_id = ? AND released_at IS NULL", [requestId]);
      }
      const [[onRoad]] = await conn.query(
        `SELECT ambulance_id FROM Ambulance WHERE assigned_request_id = ? AND status IN (?) ORDER BY ambulance_id LIMIT 1`, [requestId, ON_ROAD_AMBULANCE_STATUSES]);
      await this.lockingEngine.audit(conn, {
        request_id: requestId, hospital_id: hospitalId, event_type: 'PATIENT_ARRIVED', previous_state: request.status, new_state: request.status,
        actor_role: actor.role, actor_id: actor.id,
        metadata: { released_seats: seats.map(a => a.ambulance_id), ambulance_id: onRoad?.ambulance_id ?? null }
      });
      return { unchanged: false, ...(await this._milestonesOf(conn, requestId)), released_seats: seats.map(a => a.ambulance_id) };
    }));
  }

  async allocateBed(requestId, hospitalId, bedLabel, actor) {
    try {
      return await this._guard(() => this._tx(async conn => {
        const request = await this._lockHeldCase(conn, requestId, hospitalId);
        if (request.bed_label) {
          if (request.bed_label.toUpperCase() === bedLabel.toUpperCase()) {
            return { unchanged: true, status: request.status, milestones: MySqlStore.milestones(request), bed_resource: await this._bedResource(conn, requestId, hospitalId) };
          }
          throw new StoreError(409, `${requestId} already has bed ${request.bed_label}.`, 'BED_ALREADY_ALLOCATED');
        }
        if (request.status !== 'ALLOCATED') throw new StoreError(409, `A bed can only be allocated to an ALLOCATED case; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
        if (!request.arrived_at) throw new StoreError(409, 'Confirm the patient\'s arrival before allocating a bed.', 'INVALID_TRANSITION');
        // uq_active_bed (generated active_bed_key) refuses a label held by another open case at this hospital, even
        // when two desks allocate it at the same moment: the second insert into the unique index waits, then fails.
        await conn.query('UPDATE EmergencyRequest SET bed_label = ?, bed_hospital_id = ?, bed_allocated_at = NOW(3) WHERE request_id = ?',
          [bedLabel, hospitalId, requestId]);
        const bedResource = await this._bedResource(conn, requestId, hospitalId);
        await this.lockingEngine.audit(conn, {
          request_id: requestId, hospital_id: hospitalId, event_type: 'BED_ALLOCATED', previous_state: null, new_state: bedLabel,
          actor_role: actor.role, actor_id: actor.id, metadata: { bed_label: bedLabel, bed_resource: bedResource }
        });
        return { unchanged: false, ...(await this._milestonesOf(conn, requestId)), bed_resource: bedResource };
      }));
    } catch (err) {
      if (err.errno === ER_DUP_ENTRY) throw new StoreError(409, `Bed ${bedLabel} is already allocated to another open case at this hospital.`, 'BED_TAKEN');
      throw err;
    }
  }

  async _bedResource(conn, requestId, hospitalId) {
    const [[row]] = await conn.query(
      `SELECT 1 AS found FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
       WHERE ra.request_id = ? AND ra.hospital_id = ? AND ra.status = 'COMMITTED' AND mr.resource_type = 'ICU_BED' LIMIT 1`, [requestId, hospitalId]);
    return row ? 'ICU_BED' : null;
  }

  async addTreatmentNote(requestId, hospitalId, note, actor) {
    return this._guard(() => this._tx(async conn => {
      const request = await this._lockHeldCase(conn, requestId, hospitalId);
      if (request.status !== 'IN_TREATMENT') throw new StoreError(409, `Notes can only be added while the case is IN_TREATMENT; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
      const updateId = `TU-${uuidv4().slice(0, 12).toUpperCase()}`;
      await conn.query('INSERT INTO TreatmentUpdate (update_id, request_id, hospital_id, author_id, note) VALUES (?, ?, ?, ?, ?)',
        [updateId, requestId, hospitalId, actor.id ?? null, note]);
      await this.lockingEngine.audit(conn, {
        request_id: requestId, hospital_id: hospitalId, event_type: 'TREATMENT_NOTE', previous_state: request.status, new_state: request.status,
        actor_role: actor.role, actor_id: actor.id, metadata: { update_id: updateId, note }
      });
      const [[row]] = await conn.query('SELECT * FROM TreatmentUpdate WHERE update_id = ?', [updateId]);
      return MySqlStore.noteOut(row);
    }));
  }

  static noteOut(row) {
    return { update_id: row.update_id, request_id: row.request_id, hospital_id: row.hospital_id, author_id: row.author_id ?? null, note: row.note,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at };
  }

  /** See MemoryStore.setDispatchAmbulance. */
  async setDispatchAmbulance(requestId, ambulanceId, actor) {
    return this._guard(() => this._tx(async conn => {
      const [[request]] = await conn.query('SELECT status, dispatch_ambulance_id FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
      if (!request) throw new StoreError(404, 'Emergency request not found.');
      if (!['NEW', 'WAITING', 'MATCHING'].includes(request.status)) throw new StoreError(409, `${requestId} is ${request.status}: it can no longer be dispatched.`);
      if ((request.dispatch_ambulance_id ?? null) === ambulanceId) return { unchanged: true };
      await conn.query('UPDATE EmergencyRequest SET dispatch_ambulance_id = ? WHERE request_id = ?', [ambulanceId, requestId]);
      await this.lockingEngine.audit(conn, {
        request_id: requestId, event_type: 'DISPATCH_PLANNED', previous_state: request.dispatch_ambulance_id ?? null, new_state: ambulanceId,
        actor_role: actor.role, actor_id: actor.id, metadata: { ambulance_id: ambulanceId }
      });
      return { unchanged: false };
    }));
  }

  async listTreatmentNotes(requestId) {
    return (await this._rows('SELECT * FROM TreatmentUpdate WHERE request_id = ? ORDER BY created_at, update_id', [requestId])).map(MySqlStore.noteOut);
  }

  async countCommittedAllocations() {
    return (await this._rows(
      `SELECT ra.hospital_id, mr.resource_type, COUNT(*) AS occupied FROM ResourceAllocation ra
       JOIN MedicalResource mr ON mr.resource_id = ra.resource_id WHERE ra.status = 'COMMITTED'
       GROUP BY ra.hospital_id, mr.resource_type ORDER BY ra.hospital_id, mr.resource_type`))
      .map(r => ({ hospital_id: r.hospital_id, resource_type: r.resource_type, occupied: Number(r.occupied) }));
  }

  // ── Referrals ──────────────────────────────────────────────────────────────
  async hasPendingAcceptance(requestId) {
    const row = await this._row("SELECT 1 AS found FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' LIMIT 1", [requestId]);
    return Boolean(row);
  }

  /** Take the 90s soft-lock (the engine also marks the case MATCHING in the same transaction). */
  async acquireReferralLock(hospitalId, requestId, resourceTypes, { initiatedBy = null } = {}) {
    return this._engine(() => this.lockingEngine.acquireSoftLock(hospitalId, requestId, resourceTypes, { initiatedBy }));
  }

  async commitReferral(acceptanceId, actorId) {
    return this._engine(() => this.lockingEngine.commitAllocation(acceptanceId, actorId));
  }

  async rejectReferral(acceptanceId, reason, actorId) {
    return this._engine(() => this.lockingEngine.rejectAndFailover(acceptanceId, reason, actorId));
  }

  /** Move an allocated case to its next treatment stage (D2-a6). Throws StoreError(409, with `safety`) if refused. */
  async advanceStage(requestId, actor) {
    return this._engine(() => this.lockingEngine.advanceStage(requestId, actor));
  }

  /** Full audit hash-chain verification (Phase 3 Step 5, AC8). */
  async verifyAuditChain() {
    return this.lockingEngine.verifyAuditChain();
  }

  /** The hospital's Banker's state and verdict; null if the hospital does not exist. */
  async getHospitalSafety(hospitalId) {
    return this._engine(() => this.lockingEngine.getHospitalSafety(hospitalId));
  }

  /** The case's claim per stage and its current stage; null if the case does not exist. */
  async getClaim(requestId) {
    const request = await this._row('SELECT request_id, current_stage, emergency_type, required_resources, required_specialist FROM EmergencyRequest WHERE request_id = ?', [requestId]);
    if (!request) return null;
    const stages = claimFromRows(await this._rows('SELECT stage_no, resource_type, quantity FROM RequestClaim WHERE request_id = ?', [requestId]));
    return { request_id: requestId, current_stage: Number(request.current_stage || 1), recorded: Boolean(stages), stages: stages ? describeClaim(stages) : [] };
  }

  async getActiveLocks() {
    return this.lockingEngine.getActiveLocks();
  }

  async getAcceptance(acceptanceId) {
    return this._row('SELECT * FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]);
  }

  async listAcceptances({ hospitalId, initiatedBy } = {}) {
    const where = [];
    const params = [];
    if (hospitalId !== undefined) { where.push('hospital_id = ?'); params.push(hospitalId); }
    if (initiatedBy !== undefined) { where.push('initiated_by = ?'); params.push(initiatedBy); }
    return this._rows(
      `SELECT * FROM HospitalAcceptance ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, acceptance_id`, params
    );
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
  async listAmbulances({ status, hospitalId, ambulanceId } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status.toUpperCase()); }
    if (hospitalId) { where.push('a.hospital_id = ?'); params.push(hospitalId); }
    if (ambulanceId) { where.push('a.ambulance_id = ?'); params.push(ambulanceId); }
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

      // A unit going back to station or out of service leaves its case, and the audit row is written on
      // that case. Lock the case row first here too, so this path keeps the global lock order.
      const unassigning = status === 'AVAILABLE' || status === 'MAINTENANCE';
      let releasedFrom = null;
      if (unassigning) {
        const [[current]] = await conn.query('SELECT assigned_request_id FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
        releasedFrom = current?.assigned_request_id ?? null;
        if (releasedFrom) await conn.query('SELECT request_id FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [releasedFrom]);
      }

      const [ambulances] = await conn.query('SELECT * FROM Ambulance WHERE ambulance_id = ? FOR UPDATE', [ambulanceId]);
      if (!ambulances.length) throw new StoreError(404, 'Ambulance not found.');
      const amb = ambulances[0];
      if (unassigning && (amb.assigned_request_id ?? null) !== releasedFrom) {
        throw new StoreError(409, 'The ambulance assignment changed concurrently. Please retry.');
      }

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
      // Back at station, or out of service: either way the unit no longer serves its case, which must
      // then be able to receive a replacement.
      if (unassigning) { sets.push('assigned_request_id = NULL', 'destination_hospital_id = NULL'); }
      if (current_lat !== undefined) { sets.push('current_lat = ?'); params.push(current_lat); }
      if (current_lng !== undefined) { sets.push('current_lng = ?'); params.push(current_lng); }
      if (eta_mins !== undefined) { sets.push('eta_mins = ?'); params.push(eta_mins); }
      await conn.query(`UPDATE Ambulance SET ${sets.join(', ')} WHERE ambulance_id = ?`, [...params, ambulanceId]);

      // A unit leaving a case is recorded on that case's own trail, so the loss of transport is visible there.
      await this.lockingEngine.audit(conn, {
        request_id: status === 'DISPATCHED' ? request_id : releasedFrom, hospital_id: amb.hospital_id,
        event_type: 'AMBULANCE_STATUS_CHANGED', previous_state: amb.status, new_state: status,
        actor_role: actor.role, actor_id: actor.id,
        metadata: { ambulance_id: amb.ambulance_id, vehicle_number: amb.vehicle_number, released_from_request: releasedFrom }
      });
      const [[updated]] = await conn.query('SELECT * FROM Ambulance WHERE ambulance_id = ?', [ambulanceId]);
      return updated;
    }));
  }

  // ── Ambulance trips (migration 010: the live-tracking demo) ───────────────
  // Lock order inside these transactions: EmergencyRequest -> Hospital -> Ambulance -> AmbulanceTrip -> AuditChainHead
  // (last, in the engine's _tx). At most one active trip per ambulance and per case: checked here for a clear message,
  // guaranteed by the unique keys on the generated columns (a duplicate key becomes the same 409).
  async createTrip(row, { audit = [] } = {}) {
    return this._guard(() => this._tx(async conn => {
      await conn.query('SELECT request_id FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [row.request_id]);
      await conn.query('SELECT hospital_id FROM Hospital WHERE hospital_id = ? FOR SHARE', [row.hospital_id]);
      const [[unit]] = await conn.query('SELECT assigned_request_id, status FROM Ambulance WHERE ambulance_id = ? FOR UPDATE', [row.ambulance_id]);
      if (!unit || unit.assigned_request_id !== row.request_id || !ON_ROAD_AMBULANCE_STATUSES.includes(unit.status)) {
        throw new StoreError(409, `Ambulance ${row.ambulance_id} is not dispatched to ${row.request_id}.`, 'UNIT_NOT_ASSIGNED');
      }
      const [active] = await conn.query(
        'SELECT ambulance_id, request_id FROM AmbulanceTrip WHERE completed_at IS NULL AND (ambulance_id = ? OR request_id = ?) FOR UPDATE',
        [row.ambulance_id, row.request_id]);
      if (active.some(t => t.ambulance_id === row.ambulance_id)) throw new StoreError(409, `Ambulance ${row.ambulance_id} already has an active trip.`, 'TRIP_ACTIVE');
      if (active.length) throw new StoreError(409, `Case ${row.request_id} already has an active trip.`, 'TRIP_ACTIVE');
      await conn.query('UPDATE Ambulance SET current_lat = ?, current_lng = ?, eta_mins = ? WHERE ambulance_id = ?',
        [row.current_lat, row.current_lng, etaMinutes(row.eta_seconds ?? null), row.ambulance_id]);
      try {
        await conn.query(
          `INSERT INTO AmbulanceTrip (trip_id, request_id, ambulance_id, hospital_id, start_lat, start_lng, speed_kmh, route_to_patient,
                                      route_to_hospital, route_source, phase, progress, current_lat, current_lng, eta_seconds, paused, is_demo, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPATCHED', 0, ?, ?, ?, 0, ?, ?)`,
          [row.trip_id, row.request_id, row.ambulance_id, row.hospital_id, row.start_lat, row.start_lng, row.speed_kmh,
            JSON.stringify(row.route_to_patient), JSON.stringify(row.route_to_hospital), row.route_source,
            row.current_lat, row.current_lng, row.eta_seconds ?? null, row.is_demo ? 1 : 0, row.created_by ?? null]);
      } catch (err) {
        if (err.errno === ER_DUP_ENTRY) throw new StoreError(409, 'The ambulance or the case already has an active trip.', 'TRIP_ACTIVE');
        throw err;
      }
      for (const entry of audit) await this.lockingEngine.audit(conn, entry);
      const [[created]] = await conn.query(`SELECT ${TRIP_COLUMNS} FROM AmbulanceTrip WHERE trip_id = ?`, [row.trip_id]);
      return mapTrip(created);
    }));
  }

  async getTrip(tripId) {
    return mapTrip(await this._row(`SELECT ${TRIP_COLUMNS} FROM AmbulanceTrip WHERE trip_id = ?`, [tripId]));
  }

  /** Newest first. Filters: hospitalId, ambulanceId, requestId, activeOnly (completed_at IS NULL). */
  async listTrips({ hospitalId, ambulanceId, requestId, activeOnly = false } = {}) {
    const where = activeOnly ? ['completed_at IS NULL'] : [];
    const params = [];
    if (hospitalId !== undefined) { where.push('hospital_id = ?'); params.push(hospitalId); }
    if (ambulanceId !== undefined) { where.push('ambulance_id = ?'); params.push(ambulanceId); }
    if (requestId !== undefined) { where.push('request_id = ?'); params.push(requestId); }
    const rows = await this._rows(
      `SELECT ${TRIP_COLUMNS} FROM AmbulanceTrip ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, trip_id DESC`, params);
    return rows.map(mapTrip);
  }

  /** Active, unpaused trips on a moving leg (what the tracking engine advances each tick). */
  async listMovingTrips() {
    const rows = await this._rows(
      `SELECT ${TRIP_COLUMNS} FROM AmbulanceTrip WHERE completed_at IS NULL AND paused = 0 AND phase IN (?)`, [TRIP_MOVING_PHASES]);
    return rows.map(mapTrip);
  }

  /** See MemoryStore.updateTrip: optimistic (version), atomic with the unit's position and the audit rows. */
  async updateTrip(tripId, expectedVersion, changes, { audit = [], unitPosition = null } = {}) {
    const keys = Object.keys(changes);
    const unknown = keys.filter(k => !TRIP_MUTABLE.includes(k));
    if (unknown.length) throw new Error(`updateTrip: not a mutable trip column: ${unknown.join(', ')}`);
    return this._guard(() => this._tx(async conn => {
      const [[ids]] = await conn.query('SELECT ambulance_id, request_id FROM AmbulanceTrip WHERE trip_id = ?', [tripId]);
      if (!ids) throw new StoreError(404, 'Trip not found.');
      const [[unit]] = await conn.query('SELECT assigned_request_id, status FROM Ambulance WHERE ambulance_id = ? FOR UPDATE', [ids.ambulance_id]);
      const [[current]] = await conn.query('SELECT version FROM AmbulanceTrip WHERE trip_id = ? FOR UPDATE', [tripId]);
      if (Number(current.version) !== expectedVersion) throw new StoreError(409, 'The trip changed concurrently. Please retry.', 'TRIP_CONFLICT');
      const unitServes = Boolean(unit) && unit.assigned_request_id === ids.request_id && ON_ROAD_AMBULANCE_STATUSES.includes(unit.status);
      if (unitPosition && unitServes) {
        await conn.query('UPDATE Ambulance SET current_lat = ?, current_lng = ?, eta_mins = ? WHERE ambulance_id = ?',
          [unitPosition.lat, unitPosition.lng, unitPosition.eta_mins, ids.ambulance_id]);
      }
      try {
        await conn.query(`UPDATE AmbulanceTrip SET ${[...keys.map(k => `${k} = ?`), 'version = version + 1'].join(', ')} WHERE trip_id = ?`,
          [...keys.map(k => (typeof changes[k] === 'boolean' ? Number(changes[k]) : changes[k])), tripId]);
      } catch (err) {
        if (err.errno === ER_DUP_ENTRY) throw new StoreError(409, 'The ambulance or the case already has another active trip.', 'TRIP_ACTIVE');
        throw err;
      }
      for (const entry of audit) await this.lockingEngine.audit(conn, entry);
      const [[updated]] = await conn.query(`SELECT ${TRIP_COLUMNS} FROM AmbulanceTrip WHERE trip_id = ?`, [tripId]);
      return { trip: mapTrip(updated), unitServes };
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
      // is_demo of each referral's case: demo cases stay out of the live response-time KPI, as out of the history (S1).
      this._rows(`SELECT a.acceptance_id, a.hospital_id, a.status, a.response_time_sec, COALESCE(r.is_demo, 0) AS is_demo
                  FROM HospitalAcceptance a LEFT JOIN EmergencyRequest r ON r.request_id = a.request_id`)
    ]);
    return { hospitals, medicalResources, doctors, ambulances, emergencyRequests, hospitalAcceptances };
  }

  /**
   * Recorded rows for historical analytics (Phase 3 Step 6) in the window [fromMs, toMs), epoch milliseconds. Same
   * shape as MemoryStore.getAnalyticsHistory. Every read runs in ONE read-only consistent snapshot, so capacity,
   * allocations and referrals agree with each other. Times leave MySQL as epoch values (UNIX_TIMESTAMP, which does
   * not depend on the session time zone); the SQL range is widened by a day for the index and the exact half-open
   * window is applied here in epoch milliseconds, so time-zone and DST conversion cannot move a boundary.
   * Demo cases (is_demo = 1, S1) are not observations: they, their referrals and their audit timings are left out.
   */
  async getAnalyticsHistory({ fromMs, toMs }) {
    const lo = Math.floor(fromMs / 1000);
    const hi = Math.ceil(toMs / 1000);
    const num = v => (v === null || v === undefined ? null : Number(v));
    const inWindow = v => v !== null && Number.isFinite(v) && v >= fromMs && v < toMs;
    const conn = await this.pool.getConnection();
    let rows;
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const q = async (sql, params = []) => (await conn.query(sql, params))[0];
      const coarse = col => `${col} >= FROM_UNIXTIME(?) - INTERVAL 1 DAY AND ${col} < FROM_UNIXTIME(?) + INTERVAL 1 DAY`;
      rows = {
        requests: await q(
          `SELECT request_id, emergency_type, priority, pickup_lat, pickup_lng, required_resources,
                  ROUND(UNIX_TIMESTAMP(request_time) * 1000) AS request_ms
           FROM EmergencyRequest WHERE is_demo = 0 AND ${coarse('request_time')}`, [lo, hi]),
        acceptances: await q(
          `SELECT a.request_id, a.hospital_id, a.status, ROUND(UNIX_TIMESTAMP(a.created_at) * 1000) AS created_ms,
                  ROUND(UNIX_TIMESTAMP(a.responded_at) * 1000) AS responded_ms
           FROM HospitalAcceptance a JOIN EmergencyRequest r ON r.request_id = a.request_id
           WHERE r.is_demo = 0 AND ${coarse('a.created_at')}`, [lo, hi]),
        timings: await q(
          `SELECT h.request_id,
                  MIN(CASE WHEN h.event_type = 'REQUEST_CREATED' THEN COALESCE(h.event_time_ms, ROUND(UNIX_TIMESTAMP(h.event_time) * 1000)) END) AS created_ms,
                  MIN(CASE WHEN h.event_type = 'ALLOCATION_COMMITTED' THEN COALESCE(h.event_time_ms, ROUND(UNIX_TIMESTAMP(h.event_time) * 1000)) END) AS allocated_ms
           FROM EmergencyHistory h JOIN EmergencyRequest r ON r.request_id = h.request_id
           WHERE h.event_type IN ('REQUEST_CREATED', 'ALLOCATION_COMMITTED') AND r.is_demo = 0 AND ${coarse('r.request_time')}
           GROUP BY h.request_id`, [lo, hi]),
        hospitals: await q('SELECT hospital_id, hospital_name, emergency_status, acceptance_rate, avg_response_sec FROM Hospital ORDER BY hospital_id'),
        resources: await q('SELECT hospital_id, resource_type, total_capacity, available_capacity, locked_capacity FROM MedicalResource ORDER BY hospital_id, resource_type'),
        allocations: await q("SELECT hospital_id, request_id, status FROM ResourceAllocation WHERE status = 'COMMITTED'")
      };
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    const requests = rows.requests.map(r => ({
      request_id: r.request_id, request_ms: num(r.request_ms), emergency_type: r.emergency_type, priority: num(r.priority),
      pickup_lat: r.pickup_lat ?? null, pickup_lng: r.pickup_lng ?? null,
      required_resource_types: mapRequest(r).required_resource_types
    })).filter(r => inWindow(r.request_ms));
    const ids = new Set(requests.map(r => r.request_id));
    return {
      requests,
      acceptances: rows.acceptances
        .map(a => ({ request_id: a.request_id, hospital_id: a.hospital_id, status: a.status, created_ms: num(a.created_ms), responded_ms: num(a.responded_ms) }))
        .filter(a => inWindow(a.created_ms)),
      allocationTimes: rows.timings
        .map(t => ({ request_id: t.request_id, created_ms: num(t.created_ms), allocated_ms: num(t.allocated_ms) }))
        .filter(t => ids.has(t.request_id) && t.created_ms !== null && t.allocated_ms !== null),
      hospitals: rows.hospitals.map(h => ({ ...h, acceptance_rate: num(h.acceptance_rate), avg_response_sec: num(h.avg_response_sec) })),
      resources: rows.resources.map(r => ({ ...r })),
      allocations: rows.allocations.map(a => ({ ...a }))
    };
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
         (SELECT COALESCE(SUM(available_capacity - locked_capacity), 0) FROM MedicalResource WHERE resource_type = 'ICU_BED') AS icu_available,
         (SELECT COALESCE(SUM(available_capacity - locked_capacity), 0) FROM MedicalResource WHERE resource_type = 'VENTILATOR') AS ventilators_available,
         (SELECT COUNT(*) FROM Hospital WHERE emergency_status = 'OPEN') AS hospitals_open,
         (SELECT COUNT(*) FROM Ambulance WHERE status = 'AVAILABLE') AS ambulances_available,
         (SELECT COUNT(*) FROM HospitalAcceptance WHERE status = 'PENDING') AS active_locks`
    );
    return {
      active_emergencies: Number(row.active_emergencies), critical_p1: Number(row.critical_p1),
      // The /analytics/dashboard names of the same two figures (kept alongside the old names for older clients).
      critical_p1_waiting: Number(row.critical_p1),
      icu_available: Number(row.icu_available), ventilators_available: Number(row.ventilators_available),
      hospitals_open: Number(row.hospitals_open), ambulances_available: Number(row.ambulances_available),
      available_ambulances: Number(row.ambulances_available),
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
