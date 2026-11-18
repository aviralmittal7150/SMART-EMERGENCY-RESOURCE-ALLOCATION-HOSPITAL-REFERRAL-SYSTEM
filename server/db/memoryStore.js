// server/db/memoryStore.js
// In-memory implementation of the data-store interface (see server/db/store.js).
//
// DEMO MODE ONLY: data lives in process memory, is lost on restart, and cannot be shared between
// processes. Each method performs its whole check-then-write sequence synchronously (no await in
// the middle), so an operation is atomic with respect to other requests, exactly as the route
// handlers were before this logic moved here.

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { db as defaultDb } from './seed.js';
import { lockingEngine as defaultEngine } from '../services/lockingEngine.js';
import { canTransition, TERMINAL_STATES, ON_ROAD_AMBULANCE_STATUSES as ON_ROAD_STATUSES, transportRequired } from '../services/lifecycle.js';
import { StoreError } from './storeErrors.js';
import { buildClaim, claimRows, claimFromRows, describeClaim } from '../services/clinicalPathways.js';
import { realAdminUsable, changeEndsSessions } from '../services/accounts.js';
import { MOVING_PHASES as TRIP_MOVING_PHASES, etaMinutes } from '../services/tracking/phases.js';
import { candidateRequestId, MAX_REQUEST_ID_ATTEMPTS, RequestIdExhaustedError } from '../services/requestIds.js';
import { victimLabel, incidentIdPrefix, incidentId } from '../services/incidents.js';

// Setting a unit to one of these ends its assignment to a case.
const UNASSIGNING_STATUSES = ['AVAILABLE', 'MAINTENANCE'];

// Idempotency keys only need to outlive client retries: like MySQL (purgeExpiredIdempotencyKeys and the expired-key
// delete in createRequest), a key older than this is treated as absent.
export const IDEMPOTENCY_KEY_TTL_MS = 24 * 3_600_000;
// GET /hospitals/:id/patients keeps a COMPLETED case on the board for this long after its last change.
export const HOSPITAL_PATIENTS_COMPLETED_MS = 24 * 3_600_000;
// The EmergencyRequest columns added by migration 011 (incident link, triage category, treatment milestones), null until set.
export const CASE_DEFAULTS = Object.freeze({
  incident_id: null, incident_seq: null, triage_category: null, arrived_at: null, bed_label: null, bed_hospital_id: null,
  bed_allocated_at: null, treatment_started_at: null, treatment_completed_at: null, dispatch_ambulance_id: null
});

/** An engine refusal as the store's business error, keeping the Banker's explanation (`safety`). */
const toStoreError = err => new StoreError(err.code === 'NOT_FOUND' ? 404 : 409, err.message, err.code ?? null, err.safety ?? null);

export class MemoryStore extends EventEmitter {
  constructor({ db = defaultDb, lockingEngine = defaultEngine } = {}) {
    super();
    this.mode = 'memory';
    this.db = db;
    this.lockingEngine = lockingEngine;
    this._idempotencyKeys = new Map(); // `${actor}\0${endpoint}\0${key}` -> { fingerprint, request_id, patient_id, created_ms }
    db.on('audit', entry => this.emit('audit', entry));
  }

  /**
   * Belt-and-braces sweeper for the in-memory demo store: the locking engine's own timers expire
   * locks, this catches any straggler. Emits 'lock_cleanup' for each one it handles.
   */
  startBackgroundWorkers({ intervalMs = 30_000 } = {}) {
    this._stopWorker?.();
    const timer = setInterval(async () => {
      const stale = this.db.hospitalAcceptances.filter(a => a.status === 'PENDING'
        && Date.now() > new Date(a.lock_expires_at).getTime() + 5000); // 5s grace period
      for (const acceptance of stale) {
        console.log(`[WORKER] Cleaning up stale soft-lock: ${acceptance.acceptance_id}`);
        // An unhandled rejection here would terminate the whole API process.
        try {
          await this.lockingEngine.expireLock(acceptance.acceptance_id);
          this.emit('lock_cleanup', acceptance);
        } catch (err) {
          console.error(`[WORKER] Failed to expire ${acceptance.acceptance_id}:`, err.message);
        }
      }
      // Then, as MySQL's sweeper does: a MATCHING case with no pending referral goes back to the queue (L2).
      try {
        await this.lockingEngine.requeueStrandedRequests();
      } catch (err) {
        console.error('[WORKER] Stranded-case recovery failed:', err.message);
      }
    }, intervalMs);
    timer.unref?.();
    this._stopWorker = () => clearInterval(timer);
  }

  async ping() { return true; }

  async close() {
    this._stopWorker?.();
    this._stopWorker = null;
  }

  // ── Accounts (SystemUser) ──────────────────────────────────────────────────
  /** The account row (with its bcrypt hash) for a login; exact, case-sensitive match as on MySQL (binary collation). */
  async findUserByUsername(username) {
    const user = (this.db.systemUsers ?? []).find(u => u.username === username);
    return user ? { ...user } : null;
  }

  async getUser(userId) {
    const user = (this.db.systemUsers ?? []).find(u => u.user_id === userId);
    return user ? { ...user } : null;
  }

  /** How many active demo accounts exist (a production server warns about them at start-up). */
  async countDemoUsers() {
    return (this.db.systemUsers ?? []).filter(u => Number(u.is_demo) === 1 && u.is_active).length;
  }

  // ── Account management (Batch 6 admin API) ─────────────────────────────────
  _publicAccount(u) {
    const { password_hash: _hash, token_version: _version, ...rest } = u;
    return { patient_id: null, hospital_id: null, ambulance_id: null, last_login: null, ...rest,
      is_active: Number(u.is_active) ? 1 : 0, is_demo: Number(u.is_demo) ? 1 : 0 };
  }

  /** Accounts without password hashes, ordered by user_id. { total, users } */
  async listUsers({ role, active, limit = 50, offset = 0 } = {}) {
    const rows = (this.db.systemUsers ?? [])
      .filter(u => (role === undefined || u.role === role) && (active === undefined || Boolean(Number(u.is_active)) === active))
      .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
    return { total: rows.length, users: rows.slice(offset, offset + limit).map(u => this._publicAccount(u)) };
  }

  async getAccount(userId) {
    const user = (this.db.systemUsers ?? []).find(u => u.user_id === userId);
    return user ? this._publicAccount(user) : null;
  }

  async getPatient(patientId) {
    return this.db.patients.find(p => p.patient_id === patientId) || null;
  }

  /** Patients for the admin's account linking: id, name, age, gender only; optional case-insensitive id/name search. */
  async listPatients({ q, limit = 50, offset = 0 } = {}) {
    const needle = q ? q.toLowerCase() : null;
    const rows = this.db.patients
      .filter(p => !needle || p.patient_id.toLowerCase().includes(needle) || String(p.full_name).toLowerCase().includes(needle))
      .sort((a, b) => (a.patient_id < b.patient_id ? -1 : a.patient_id > b.patient_id ? 1 : 0));
    return {
      total: rows.length,
      patients: rows.slice(offset, offset + limit).map(p => ({ patient_id: p.patient_id, full_name: p.full_name, age: p.age, gender: p.gender }))
    };
  }

  /**
   * Raw rows for GET /analytics/my-registrations (server/services/registrationReport.js): the non-demo cases registered
   * by `createdBy` in [fromMs, toMs), their milestone audit rows, and hospital names. Same shape as MySqlStore's.
   */
  async getRegistrations({ createdBy, fromMs, toMs, eventTypes }) {
    const ms = t => (t === null || t === undefined ? null : typeof t === 'number' ? t : Date.parse(t));
    const requests = this.db.emergencyRequests
      .filter(r => r.created_by != null && r.created_by === createdBy && Number(r.is_demo ?? 0) !== 1)
      .map(r => {
        const p = this.db.patients.find(x => x.patient_id === r.patient_id) || {};
        return { request_id: r.request_id, patient_id: r.patient_id, full_name: p.full_name ?? null, age: p.age ?? null, gender: p.gender ?? null,
          emergency_type: r.emergency_type, priority: r.priority, status: r.status, registered_ms: ms(r.request_time) };
      })
      .filter(r => r.registered_ms !== null && r.registered_ms >= fromMs && r.registered_ms < toMs);
    const ids = new Set(requests.map(r => r.request_id));
    const events = this.db.emergencyHistory
      .filter(h => ids.has(h.request_id) && eventTypes.includes(h.event_type))
      .map(h => ({ request_id: h.request_id, event_type: h.event_type, new_state: h.new_state ?? null, hospital_id: h.hospital_id ?? null,
        metadata: h.metadata ?? null, ms: h.event_time_ms ?? ms(h.event_time), history_id: Number(h.history_id) }));
    return { requests, events, hospitals: this.db.hospitals.map(h => ({ hospital_id: h.hospital_id, hospital_name: h.hospital_name })) };
  }

  /** A successful login (bookkeeping only: token_version is not touched). */
  async recordLogin(userId) {
    const user = (this.db.systemUsers ?? []).find(u => u.user_id === userId);
    if (user) user.last_login = new Date().toISOString();
  }

  /** user_ids of the active PATIENT accounts of one patient (patient:case_update recipients). */
  async listPatientAccountIds(patientId) {
    return (this.db.systemUsers ?? []).filter(u => u.role === 'PATIENT' && u.patient_id === patientId && Number(u.is_active)).map(u => u.user_id);
  }

  _activeRealAdmins() {
    return (this.db.systemUsers ?? []).filter(u => u.role === 'ADMIN' && Number(u.is_active) && Number(u.is_demo) !== 1);
  }

  _auditAccount(event, actor, user, metadata, previous = null, next = null) {
    this.db.auditLog({
      request_id: null, hospital_id: null, event_type: event, previous_state: previous, new_state: next,
      actor_role: actor.role, actor_id: actor.id, metadata: { user_id: user.user_id, username: user.username, ...metadata }
    });
  }

  /** Create an account (row already validated by accountShapeProblem and link checks). Throws StoreError(409) on a taken username. */
  /** { isDemo }: only the tracking demo's set-up creates a demo account this way (never in production). */
  async createUser(row, actor, { isDemo = false } = {}) {
    const users = (this.db.systemUsers ??= []);
    if (users.some(u => u.username === row.username)) throw new StoreError(409, `Username "${row.username}" is already taken.`);
    if (users.some(u => u.user_id === row.user_id)) throw new StoreError(409, 'User id collision; please retry.');
    const user = { patient_id: null, hospital_id: null, ambulance_id: null, ...row, is_active: 1, is_demo: isDemo ? 1 : 0,
      created_at: new Date().toISOString(), last_login: null };
    users.push(user);
    this._auditAccount('USER_CREATED', actor, user, { role: user.role, hospital_id: user.hospital_id, ambulance_id: user.ambulance_id, patient_id: user.patient_id }, null, user.role);
    return this._publicAccount(user);
  }

  /**
   * Apply validated changes. `check(before, after)` returns a refusal message or null; it runs here, synchronously, so
   * the last-admin rule is evaluated against the state the change is applied to. Returns the account or null if absent.
   */
  async updateUser(userId, changes, actor, check = () => null) {
    const user = (this.db.systemUsers ?? []).find(u => u.user_id === userId);
    if (!user) return null;
    const after = { ...user, ...changes };
    const refusal = check(this._publicAccount(user), this._publicAccount(after), this._activeRealAdmins().length);
    if (refusal) throw new StoreError(refusal.status ?? 409, refusal.message);
    const diff = Object.fromEntries(Object.keys(changes).filter(k => (user[k] ?? null) !== (changes[k] ?? null)).map(k => [k, [user[k] ?? null, changes[k] ?? null]]));
    // Decided here, synchronously against the stored object, not from the caller's earlier read.
    const revokeTokens = changeEndsSessions(user, changes);
    Object.assign(user, changes);
    if (revokeTokens) user.token_version = Number(user.token_version ?? 0) + 1; // every older token is refused
    this._auditAccount('USER_UPDATED', actor, user, { changes: diff, sessions_revoked: revokeTokens }, diff.role?.[0] ?? null, diff.role?.[1] ?? null);
    return this._publicAccount(user);
  }

  async setUserPassword(userId, passwordHash, actor) {
    const user = (this.db.systemUsers ?? []).find(u => u.user_id === userId);
    if (!user) return null;
    user.password_hash = passwordHash;
    user.token_version = Number(user.token_version ?? 0) + 1; // every older token is refused
    user.is_demo = 0; // a demo account given a real password becomes a real one (as scripts/user-create.js does)
    this._auditAccount('USER_PASSWORD_RESET', actor, user, {});
    return this._publicAccount(user);
  }

  /** Active accounts that are not demo accounts (a production server refuses to start without one). */
  async countUsableAdmins() {
    return (this.db.systemUsers ?? []).filter(realAdminUsable).length; // usable, non-demo ADMIN accounts
  }

  // ── Hospitals & resources ──────────────────────────────────────────────────
  async listHospitals({ status } = {}) {
    const all = [...this.db.hospitals];
    return status ? all.filter(h => h.emergency_status === status.toUpperCase()) : all;
  }

  async getHospital(hospitalId) {
    return this.db.hospitals.find(h => h.hospital_id === hospitalId) || null;
  }

  async listResources(hospitalId) {
    return hospitalId
      ? this.db.medicalResources.filter(r => r.hospital_id === hospitalId)
      : [...this.db.medicalResources];
  }

  async countActiveAllocations(hospitalId) {
    return this.db.resourceAllocations.filter(a => a.hospital_id === hospitalId && a.status !== 'RELEASED').length;
  }

  async updateHospitalStatus(hospitalId, emergencyStatus, actor) {
    const hospital = this.db.hospitals.find(h => h.hospital_id === hospitalId);
    if (!hospital) return null;
    const previous = hospital.emergency_status;
    hospital.emergency_status = emergencyStatus;
    this.db.auditLog({
      request_id: null, hospital_id: hospital.hospital_id, event_type: 'HOSPITAL_STATUS_CHANGED',
      previous_state: previous, new_state: emergencyStatus, actor_role: 'ADMIN', actor_id: actor.id
    });
    return { hospital_id: hospital.hospital_id, emergency_status: emergencyStatus };
  }

  async updateResourceCapacity(hospitalId, resourceType, { total, available }, actor) {
    const resource = this.db.medicalResources.find(
      r => r.hospital_id === hospitalId && r.resource_type === String(resourceType).toUpperCase()
    );
    if (!resource) throw new StoreError(404, 'Resource not found.');

    const releaseFns = [];
    try {
      // Lock order (docs/lock-order.md): hospital, then resource.
      releaseFns.push(await this.db.acquireHospitalLock(hospitalId, 3000));
      releaseFns.push(await this.db.acquireResourceLock(resource.resource_id, 3000));
    } catch (error) {
      releaseFns.reverse().forEach(fn => fn());
      throw new StoreError(409, error.message);
    }
    try {
      // Validated only now, under both locks (D5 race fix): a referral that soft-locked a unit while this
      // edit waited has raised locked_capacity, and the edit must be checked against that, not a stale read.
      // Everything from here to the end is synchronous.
      const nextTotal = total === undefined ? resource.total_capacity : Number(total);
      const nextAvailable = available === undefined ? resource.available_capacity : Number(available);
      if (!Number.isInteger(nextTotal) || !Number.isInteger(nextAvailable)
        || nextTotal < 0 || nextAvailable < 0
        || nextAvailable > nextTotal
        || nextAvailable < resource.locked_capacity) {
        throw new StoreError(400, 'Capacity must be whole numbers with 0 <= locked <= available <= total.');
      }
      const previousCapacity = `${resource.total_capacity}:${resource.available_capacity}`;
      resource.total_capacity = nextTotal;
      resource.available_capacity = nextAvailable;
      resource.version_lock += 1;
      this.db.auditLog({
        request_id: null, hospital_id: hospitalId, event_type: 'RESOURCE_CAPACITY_UPDATED',
        previous_state: previousCapacity, new_state: `${nextTotal}:${nextAvailable}`,
        actor_role: actor.role, actor_id: actor.id, metadata: { resource_type: resource.resource_type }
      });
      // D5-A: the edit is allowed even if it leaves the hospital unsafe; that is recorded and alerted instead.
      const safety = this.lockingEngine.refreshSafety(hospitalId, { actor, cause: `capacity edit ${resource.resource_type}` });
      return { ...resource, safety: safety && { safe: safety.safe, safety_state: safety.safety_state, explanation: safety.explanation } };
    } finally {
      releaseFns.reverse().forEach(fn => fn());
    }
  }

  // ── Doctors ────────────────────────────────────────────────────────────────
  _withHospitalName(doctor) {
    return { ...doctor, hospital_name: this.db.hospitals.find(h => h.hospital_id === doctor.hospital_id)?.hospital_name || 'Unknown' };
  }

  async listDoctors({ hospitalId, specialization, availabilityStatus } = {}) {
    let doctors = [...this.db.doctors];
    if (hospitalId) doctors = doctors.filter(d => d.hospital_id === hospitalId);
    if (specialization) doctors = doctors.filter(d => d.specialization === specialization.toUpperCase());
    if (availabilityStatus) doctors = doctors.filter(d => d.availability_status === availabilityStatus.toUpperCase());
    return doctors.map(d => this._withHospitalName(d));
  }

  async getDoctor(doctorId) {
    const doctor = this.db.doctors.find(d => d.doctor_id === doctorId);
    return doctor ? this._withHospitalName(doctor) : null;
  }

  async hasAvailableSpecialist(hospitalId, specialization) {
    return this.db.doctors.some(d => d.hospital_id === hospitalId
      && d.specialization === specialization && d.availability_status === 'AVAILABLE');
  }

  /** The doctor's active reservation / assignment (LOCKED or COMMITTED), if any. */
  _activeAssignment(doctorId) {
    return this.db.doctorAssignments.find(a => a.doctor_id === doctorId && ['LOCKED', 'COMMITTED'].includes(a.status)) || null;
  }

  /** Runs fn while holding the hospital's mutex (level 2 of docs/lock-order.md). */
  async _withHospitalLock(hospitalId, fn) {
    let release;
    try {
      release = await this.db.acquireHospitalLock(hospitalId, 3000);
    } catch (error) {
      throw new StoreError(409, error.message);
    }
    try {
      return fn();
    } finally {
      release();
    }
  }

  async addDoctor(input, actor) {
    return this._withHospitalLock(input.hospital_id, () => this._addDoctorLocked(input, actor));
  }

  _addDoctorLocked({ hospital_id, full_name, specialization, shift_start, shift_end }, actor) {
    const next = this.db.doctors.reduce((max, d) => Math.max(max, Number(String(d.doctor_id).replace(/\D/g, '')) || 0), 0) + 1;
    const doctor = {
      doctor_id: `DR-${String(next).padStart(3, '0')}`,
      hospital_id, full_name,
      specialization: specialization.toUpperCase(),
      availability_status: 'AVAILABLE',
      shift_start: shift_start || '08:00',
      shift_end: shift_end || '20:00',
      created_at: new Date().toISOString()
    };
    this.db.doctors.push(doctor);
    this.db.auditLog({
      request_id: null, hospital_id, event_type: 'DOCTOR_ADDED', previous_state: null, new_state: 'AVAILABLE',
      actor_role: actor.role, actor_id: actor.id,
      metadata: { doctorId: doctor.doctor_id, full_name, specialization }
    });
    return this._withHospitalName(doctor); // same shape as MySQL (DOCTOR_COLUMNS includes hospital_name)
  }

  async updateDoctorStatus(doctorId, availabilityStatus, actor) {
    const found = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!found) return null;
    return this._withHospitalLock(found.hospital_id, () => this._updateDoctorStatusLocked(doctorId, availabilityStatus, actor));
  }

  _updateDoctorStatusLocked(doctorId, availabilityStatus, actor) {
    const doctor = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!doctor) return null;
    const active = this._activeAssignment(doctorId);
    if (active) {
      // Same wording as MySqlStore._lockDoctorForEdit.
      throw new StoreError(409, `Doctor ${doctorId} cannot change status while ${doctor.availability_status} for case ${active.request_id}.`);
    }
    const previous = doctor.availability_status;
    doctor.availability_status = availabilityStatus;
    this.db.auditLog({
      request_id: null, hospital_id: doctor.hospital_id, event_type: 'DOCTOR_STATUS_CHANGED',
      previous_state: previous, new_state: availabilityStatus, actor_role: actor.role, actor_id: actor.id,
      metadata: { doctorId: doctor.doctor_id, full_name: doctor.full_name }
    });
    return { doctor_id: doctor.doctor_id, previous_status: previous, new_status: availabilityStatus };
  }

  async updateDoctorShift(doctorId, { shift_start, shift_end }, actor = { role: 'SYSTEM', id: null }) {
    const doctor = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!doctor) return null;
    const previous = `${doctor.shift_start}-${doctor.shift_end}`;
    if (shift_start) doctor.shift_start = shift_start;
    if (shift_end) doctor.shift_end = shift_end;
    // X11: a shift change is recorded like every other roster change.
    this.db.auditLog({
      request_id: null, hospital_id: doctor.hospital_id, event_type: 'DOCTOR_SHIFT_CHANGED',
      previous_state: previous, new_state: `${doctor.shift_start}-${doctor.shift_end}`,
      actor_role: actor.role, actor_id: actor.id, metadata: { doctorId: doctor.doctor_id, full_name: doctor.full_name }
    });
    return { doctor_id: doctor.doctor_id, shift_start: doctor.shift_start, shift_end: doctor.shift_end };
  }

  async removeDoctor(doctorId, actor) {
    const found = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!found) return null;
    return this._withHospitalLock(found.hospital_id, () => this._removeDoctorLocked(doctorId, actor));
  }

  _removeDoctorLocked(doctorId, actor) {
    const idx = this.db.doctors.findIndex(d => d.doctor_id === doctorId);
    if (idx === -1) return null;
    const active = this._activeAssignment(doctorId);
    if (active) {
      throw new StoreError(409, `Doctor ${doctorId} cannot be removed while ${this.db.doctors[idx].availability_status} for case ${active.request_id}.`);
    }
    // Mirrors MySQL (DoctorAssignment.doctor_id ON DELETE RESTRICT): assignment history outlives removal.
    if (this.db.doctorAssignments.some(a => a.doctor_id === doctorId)) {
      throw new StoreError(409, `Doctor ${doctorId} cannot be removed: they have case assignment history. Set them OFF_DUTY instead.`);
    }
    const [removed] = this.db.doctors.splice(idx, 1);
    this.db.auditLog({
      request_id: null, hospital_id: removed.hospital_id, event_type: 'DOCTOR_REMOVED',
      previous_state: removed.availability_status, new_state: null, actor_role: 'ADMIN', actor_id: actor.id,
      metadata: { doctorId: removed.doctor_id, full_name: removed.full_name }
    });
    return removed;
  }

  // ── Emergencies ────────────────────────────────────────────────────────────
  /**
   * Case visibility for a scope from server/services/accessPolicy.js (same rules as MySqlStore.caseVisible):
   * 'all'; 'hospital' = a PENDING or ACCEPTED referral to that hospital (a rejected, expired or cancelled one does not
   * count); 'user' = registered by that user, or the user's ambulance is assigned to it; anything else = nothing.
   */
  _visible(requestId, scope = { kind: 'all' }) {
    switch (scope?.kind ?? 'all') {
      case 'all':
        return true;
      case 'hospital':
        return this.db.hospitalAcceptances.some(a => a.request_id === requestId && a.hospital_id === scope.hospitalId
          && (scope.statuses ?? ['PENDING', 'ACCEPTED']).includes(a.status));
      case 'user': {
        const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
        if (request && request.created_by != null && request.created_by === scope.userId) return true;
        return Boolean(scope.ambulanceId) && this.db.ambulances.some(a => a.ambulance_id === scope.ambulanceId && a.assigned_request_id === requestId);
      }
      case 'patient': {
        const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
        return Boolean(scope.patientId) && request?.patient_id === scope.patientId;
      }
      default:
        return false;
    }
  }

  async caseVisible(requestId, scope) {
    return this._visible(requestId, scope);
  }

  async listRequests({ status, scope } = {}) {
    let requests = this.db.emergencyRequests.filter(r => this._visible(r.request_id, scope));
    if (status) requests = requests.filter(r => r.status === status.toUpperCase());
    // Same order as MySQL: ORDER BY priority ASC, request_time ASC, request_id ASC (the last breaks same-millisecond ties).
    requests.sort((a, b) => (a.priority - b.priority)
      || (new Date(a.request_time) - new Date(b.request_time))
      || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0));
    // The hospital holding the case and the one with a pending referral (UI list column; same as MySQL).
    const hospitalWith = (requestId, status) => this.db.hospitalAcceptances
      .findLast(a => a.request_id === requestId && a.status === status)?.hospital_id ?? null;
    return requests.map(r => ({
      ...this._withTransport(r),
      accepted_hospital_id: hospitalWith(r.request_id, 'ACCEPTED'),
      pending_hospital_id: hospitalWith(r.request_id, 'PENDING'),
      patient: this.db.patients.find(p => p.patient_id === r.patient_id)
    }));
  }

  /** The case as shown to clients, with its usable ambulance (if any) and whether transport is still needed. */
  _withTransport(request) {
    const unit = this.db.ambulances.find(a => a.assigned_request_id === request.request_id && ON_ROAD_STATUSES.includes(a.status));
    const assigned = unit?.ambulance_id ?? null;
    // The migration 011 columns are null on cases that predate them (seed rows), as on MySQL.
    return { ...CASE_DEFAULTS, ...request, assigned_ambulance_id: assigned, transport_required: transportRequired(request.status, assigned, request.arrived_at) };
  }

  async getRequest(requestId) {
    return this.db.emergencyRequests.find(r => r.request_id === requestId) || null;
  }

  async getRequestDetail(requestId, { scope } = {}) {
    const request = await this.getRequest(requestId);
    if (!request || !this._visible(requestId, scope)) return null;
    return {
      request: this._withTransport(request),
      patient: this.db.patients.find(p => p.patient_id === request.patient_id),
      allocations: this.db.resourceAllocations.filter(a => a.request_id === requestId),
      acceptances: this.db.hospitalAcceptances.filter(a => a.request_id === requestId),
      auditEvents: this.db.emergencyHistory.filter(h => h.request_id === requestId)
    };
  }

  /** Returns null when the case is not visible to the scope; otherwise the (possibly empty) trail. */
  async listRequestAudit(requestId, { scope } = {}) {
    if (!this._visible(requestId, scope)) return null;
    return this.db.emergencyHistory
      .filter(h => h.request_id === requestId)
      .sort((a, b) => new Date(a.event_time) - new Date(b.event_time));
  }

  /**
   * idempotency: { key, endpoint, fingerprint } or null. A repeated key with the same fingerprint returns
   * the case it created ({ ..., replayed: true }); with a different fingerprint it is refused (422).
   * Check and insert run without an await in between, so concurrent duplicates cannot both create.
   * fixed: { requestId, patientId, isDemo } (the tracking demo's sample case only): exactly these ids, the patient row
   * re-used when it already exists; an existing request id is refused (409, code EXISTS). No idempotency key then.
   */
  async createRequest({ patient, request }, actor, { idempotency = null, fixed = null } = {}) {
    const idemKey = idempotency && `${actor.id}\u0000${idempotency.endpoint}\u0000${idempotency.key}`;
    if (idemKey) {
      let previous = this._idempotencyKeys.get(idemKey);
      if (previous && Date.now() - previous.created_ms >= IDEMPOTENCY_KEY_TTL_MS) {
        this._idempotencyKeys.delete(idemKey); // expired: absent, as on MySQL
        previous = null;
      }
      if (previous) {
        if (previous.fingerprint !== idempotency.fingerprint) {
          throw new StoreError(422, 'This Idempotency-Key was already used for a different request.');
        }
        // X11: a replay reports the case as it is NOW (it may have been referred or allocated since).
        const current = this.db.emergencyRequests.find(r => r.request_id === previous.request_id);
        return { request_id: previous.request_id, patient_id: previous.patient_id, status: current?.status ?? 'WAITING', replayed: true };
      }
    }

    const patientId = fixed?.patientId ?? `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
    // X8: the same candidates and the same bounded number of attempts as MySQL (server/services/requestIds.js).
    let requestId = null;
    if (fixed) {
      if (this.db.emergencyRequests.some(r => r.request_id === fixed.requestId)) {
        throw new StoreError(409, `Request ${fixed.requestId} already exists.`, 'EXISTS');
      }
      requestId = fixed.requestId;
    }
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS && requestId === null; attempt += 1) {
      const candidate = candidateRequestId(attempt);
      if (!this.db.emergencyRequests.some(r => r.request_id === candidate)) requestId = candidate;
    }
    if (requestId === null) throw new RequestIdExhaustedError();

    const now = new Date().toISOString();
    const claim = this._writeCase({ patient, request }, actor, {
      requestId, patientId, now, isDemo: Boolean(fixed?.isDemo), reusePatient: Boolean(fixed)
    });
    if (idemKey) {
      this._idempotencyKeys.set(idemKey, { fingerprint: idempotency.fingerprint, request_id: requestId, patient_id: patientId, created_ms: Date.now() });
    }
    return { request_id: requestId, patient_id: patientId, status: 'WAITING', replayed: false, claim: describeClaim(claim) };
  }

  /**
   * Write one new case synchronously: its patient (unless `reusePatient` and it exists), the request (WAITING), its
   * maximum claim and its REQUEST_CREATED audit row. Shared by createRequest and createIncident; returns the claim.
   */
  _writeCase({ patient, request }, actor, { requestId, patientId, now, isDemo = false, reusePatient = false, incident = null }) {
    if (!(reusePatient && this.db.patients.some(p => p.patient_id === patientId))) {
      this.db.patients.push({ patient_id: patientId, ...patient, created_at: now });
    }
    this.db.emergencyRequests.push({
      request_id: requestId,
      patient_id: patientId,
      emergency_type: request.emergency_type,
      required_resource_types: request.required_resource_types,
      required_resources: request.required_resource_types,
      required_specialist: request.required_specialist,
      priority: request.priority,
      pickup_lat: request.pickup_lat,
      pickup_lng: request.pickup_lng,
      clinical_notes: request.clinical_notes,
      status: 'WAITING',
      current_stage: 1,
      is_demo: isDemo ? 1 : 0,
      created_by: actor.id ?? null,
      ...CASE_DEFAULTS,
      incident_id: incident?.incident_id ?? null,
      incident_seq: incident?.incident_seq ?? null,
      triage_category: incident?.triage_category ?? null,
      request_time: now,
      updated_at: now
    });
    // The maximum claim, fixed at intake (Banker's option A, D2-a4).
    const claim = buildClaim(request.emergency_type, { resourceTypes: request.required_resource_types || [], specialist: request.required_specialist });
    for (const row of claimRows(claim)) this.db.requestClaims.push({ request_id: requestId, ...row });
    this.db.auditLog({
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
    return claim;
  }

  // ── Mass-casualty incidents (Batch 8 P1; same rows and rules as MySqlStore) ─────────────────────────────────
  /** A live idempotency record for this actor/endpoint/key, or null; a different body with the key is refused (422). */
  _idempotencyRecord(idempotency, actor) {
    if (!idempotency) return { mapKey: null, previous: null };
    const mapKey = `${actor.id}\u0000${idempotency.endpoint}\u0000${idempotency.key}`;
    let previous = this._idempotencyKeys.get(mapKey);
    if (previous && Date.now() - previous.created_ms >= IDEMPOTENCY_KEY_TTL_MS) { this._idempotencyKeys.delete(mapKey); previous = null; }
    if (previous && previous.fingerprint !== idempotency.fingerprint) {
      throw new StoreError(422, 'This Idempotency-Key was already used for a different request.');
    }
    return { mapKey, previous };
  }

  /** Request ids for `n` new cases, unique among the stored cases and each other (refused before anything is written). */
  _newRequestIds(n) {
    const chosen = new Set();
    for (let i = 0; i < n; i += 1) {
      let id = null;
      for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS && id === null; attempt += 1) {
        const candidate = candidateRequestId(attempt);
        if (!chosen.has(candidate) && !this.db.emergencyRequests.some(r => r.request_id === candidate)) id = candidate;
      }
      if (id === null) throw new RequestIdExhaustedError();
      chosen.add(id);
    }
    return [...chosen];
  }

  /** Write the victims of `incident` (synchronous): numbered after its last victim, anonymous ones labelled MCI-NNN. */
  _writeVictims(incident, victims, actor, now, isDemo) {
    if (!victims.length) return [];
    const requestIds = this._newRequestIds(victims.length);
    const last = Math.max(0, ...this.db.emergencyRequests.filter(r => r.incident_id === incident.incident_id).map(r => Number(r.incident_seq) || 0));
    victims.forEach((v, i) => {
      const seq = last + i + 1;
      this._writeCase({ patient: { ...v.patient, full_name: v.patient.full_name ?? victimLabel(seq) }, request: v.request }, actor, {
        requestId: requestIds[i], patientId: `PAT-${uuidv4().slice(0, 6).toUpperCase()}`, now, isDemo,
        incident: { incident_id: incident.incident_id, incident_seq: seq, triage_category: v.triage_category }
      });
    });
    this.db.auditLog({
      request_id: null, event_type: 'VICTIMS_REGISTERED', previous_state: null, new_state: null, actor_role: actor.role, actor_id: actor.id,
      metadata: { incident_id: incident.incident_id, count: victims.length, request_ids: requestIds, first_seq: last + 1, last_seq: last + victims.length }
    });
    return requestIds;
  }

  /**
   * A new incident and (optionally) its first victims, all or nothing. victims: inputs from services/incidents.js
   * validateVictims. idempotency: as createRequest (a replay returns the original { incident_id, request_ids }).
   */
  async createIncident(fields, victims, actor, { idempotency = null, isDemo = false } = {}) {
    const { mapKey, previous } = this._idempotencyRecord(idempotency, actor);
    if (previous) return { incident_id: previous.resource_id, request_ids: previous.request_ids, replayed: true };
    const prefix = incidentIdPrefix();
    const used = this.db.incidents.filter(i => i.incident_id.startsWith(prefix)).map(i => Number(i.incident_id.slice(prefix.length)) || 0);
    const now = new Date().toISOString();
    const row = {
      incident_id: incidentId(prefix, Math.max(0, ...used) + 1), title: fields.title, incident_type: fields.incident_type,
      location_text: fields.location_text ?? null, location_lat: fields.location_lat, location_lng: fields.location_lng,
      description: fields.description ?? null, estimated_victims: fields.estimated_victims ?? null, vehicles_involved: fields.vehicles_involved ?? null,
      severity: fields.severity, occurred_at: fields.occurred_at ?? null, created_by: actor.id ?? null, created_at: now, is_demo: isDemo ? 1 : 0
    };
    this._newRequestIds(victims.length); // exhausted ids refuse the whole incident before anything is written
    this.db.incidents.push(row);
    this.db.auditLog({
      request_id: null, event_type: 'INCIDENT_CREATED', previous_state: null, new_state: null, actor_role: actor.role, actor_id: actor.id,
      metadata: { incident_id: row.incident_id, title: row.title, incident_type: row.incident_type, severity: row.severity, is_demo: Boolean(isDemo) }
    });
    const requestIds = this._writeVictims(row, victims, actor, now, isDemo);
    if (mapKey) this._idempotencyKeys.set(mapKey, { fingerprint: idempotency.fingerprint, resource_id: row.incident_id, request_ids: requestIds, created_ms: Date.now() });
    return { incident_id: row.incident_id, request_ids: requestIds, replayed: false };
  }

  /** More victims for an existing incident, all or nothing (404 when the incident does not exist). */
  async addIncidentVictims(incidentIdValue, victims, actor, { idempotency = null } = {}) {
    const { mapKey, previous } = this._idempotencyRecord(idempotency, actor);
    if (previous) return { incident_id: previous.resource_id, request_ids: previous.request_ids, replayed: true };
    const incident = this.db.incidents.find(i => i.incident_id === incidentIdValue);
    if (!incident) throw new StoreError(404, 'Incident not found.');
    const requestIds = this._writeVictims(incident, victims, actor, new Date().toISOString(), Number(incident.is_demo) === 1);
    if (mapKey) this._idempotencyKeys.set(mapKey, { fingerprint: idempotency.fingerprint, resource_id: incident.incident_id, request_ids: requestIds, created_ms: Date.now() });
    return { incident_id: incident.incident_id, request_ids: requestIds, replayed: false };
  }

  /** Every incident, newest first, with its victim count. */
  async listIncidents() {
    const counts = new Map();
    for (const r of this.db.emergencyRequests) if (r.incident_id) counts.set(r.incident_id, (counts.get(r.incident_id) ?? 0) + 1);
    return [...this.db.incidents]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.incident_id < b.incident_id ? 1 : -1)))
      .map(i => ({ ...i, victim_count: counts.get(i.incident_id) ?? 0 }));
  }

  async getIncident(incidentIdValue) {
    const row = this.db.incidents.find(i => i.incident_id === incidentIdValue);
    return row ? { ...row } : null;
  }

  /** The demo incident (P1-E), or null. */
  async findDemoIncident() {
    const row = this.db.incidents.find(i => Number(i.is_demo) === 1);
    return row ? { ...row } : null;
  }

  // ── Hospital patient board (Batch 8) ──────────────────────────────────────
  /**
   * The cases `hospitalId` holds (its latest ACCEPTED referral) that are ALLOCATED or IN_TREATMENT, or COMPLETED in the
   * last 24 hours; open cases first, then by priority and request_id. Same rows as MySqlStore.listHospitalPatients.
   */
  async listHospitalPatients(hospitalId) {
    const cutoff = Date.now() - HOSPITAL_PATIENTS_COMPLETED_MS;
    const iso = t => (t == null ? null : new Date(t).toISOString());
    const rows = [];
    for (const r of this.db.emergencyRequests) {
      const accepted = this.db.hospitalAcceptances.findLast(a => a.request_id === r.request_id && a.status === 'ACCEPTED');
      if (accepted?.hospital_id !== hospitalId) continue;
      const open = r.status === 'ALLOCATED' || r.status === 'IN_TREATMENT';
      if (!open && !(r.status === 'COMPLETED' && Date.parse(r.updated_at) >= cutoff)) continue;
      const p = this.db.patients.find(x => x.patient_id === r.patient_id) ?? {};
      const trip = (this.db.ambulanceTrips ?? []).filter(t => t.request_id === r.request_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.trip_id < b.trip_id ? 1 : -1)))[0];
      rows.push({
        request_id: r.request_id, patient_name: p.full_name ?? null, age: p.age ?? null, gender: p.gender ?? null,
        triage_priority: r.priority, emergency_type: r.emergency_type, status: r.status, incident_id: r.incident_id ?? null,
        triage_category: r.triage_category ?? null,
        ambulance_id: this._withTransport(r).assigned_ambulance_id, trip_phase: trip?.phase ?? null,
        accepted_at: iso(accepted.responded_at), updated_at: iso(r.updated_at), ...MemoryStore.milestones(r)
      });
    }
    return rows.sort((a, b) => ((a.status === 'COMPLETED') - (b.status === 'COMPLETED')) || (a.triage_priority - b.triage_priority)
      || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0));
  }

  /**
   * options (Batch 8, the hospital steps): { guard(caseRow) -> refusal message | null, checked under the request lock
   * after the lifecycle check (409); treatmentEvent: 'TREATMENT_STARTED' | 'TREATMENT_COMPLETED', an extra audit row
   * (and RESOURCE_RELEASED when a completion released anything); hospitalId: recorded on those rows }. Every
   * IN_TREATMENT move records treatment_started_at, and IN_TREATMENT -> COMPLETED treatment_completed_at (same as MySQL).
   */
  async transitionRequestStatus(requestId, newStatus, actor, options = {}) {
    if (!this.db.emergencyRequests.some(r => r.request_id === requestId)) throw new StoreError(404, 'Request not found.');
    // L2: validated and applied while holding the case's request lock, as MySQL's transitionRequest holds the
    // EmergencyRequest row: an accept, rejection, failover or expiry of this case runs entirely before or after it.
    return this.lockingEngine.withRequestLock(requestId, () => this._transitionLocked(requestId, newStatus, actor, options));
  }

  async _transitionLocked(requestId, newStatus, actor, options = {}) {
    const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
    if (!request) throw new StoreError(404, 'Request not found.');

    const previous = request.status;
    if (previous === newStatus) return { previous, status: newStatus, unchanged: true, lockCleanupError: null };
    if (!canTransition(previous, newStatus)) {
      throw new StoreError(409, `Invalid lifecycle transition: ${previous} -> ${newStatus}.`);
    }
    const refusal = options.guard?.({ ...CASE_DEFAULTS, ...request });
    if (refusal) throw new StoreError(409, refusal, 'INVALID_TRANSITION');
    const changedAt = new Date().toISOString();
    request.status = newStatus;
    request.updated_at = changedAt;
    if (newStatus === 'IN_TREATMENT') request.treatment_started_at ??= changedAt;
    if (newStatus === 'COMPLETED' && previous === 'IN_TREATMENT') request.treatment_completed_at = changedAt;
    // Test-only pause point: the new status is written and the request lock is held (as on MySQL).
    const hooks = this.lockingEngine.hooks;
    if (hooks?.active('transition:statusRecorded')) {
      await hooks.run('transition:statusRecorded', { backend: 'memory', requestId, previous, newStatus });
    }

    let lockCleanupError = null;
    const isTerminal = TERMINAL_STATES.includes(newStatus);
    // Returning a matching case to the queue abandons its pending handshake too.
    if (isTerminal || (previous === 'MATCHING' && newStatus === 'WAITING')) {
      // Under the request lock already held (the locked variant: re-taking the lock would wait for itself).
      // If the cleanup fails we still release committed resources below, then report it; a leftover lock
      // cannot be committed (commit requires MATCHING) and expires at its TTL.
      try {
        this.lockingEngine.cancelPendingLocked(requestId, `Request ${newStatus}`);
      } catch (err) {
        lockCleanupError = err;
        console.error('[LIFECYCLE]', err.message);
        this.db.auditLog({
          request_id: requestId, event_type: 'LOCK_CLEANUP_FAILED', previous_state: previous, new_state: newStatus,
          actor_role: 'SYSTEM', metadata: { error: err.message }
        });
      }
    }

    let released = 0;
    let capped = 0;
    const releasedSpecialists = [];
    const nowIso = new Date().toISOString();
    const committedSpecialists = this.db.doctorAssignments.filter(a => a.request_id === requestId && a.status === 'COMMITTED');
    if (newStatus === 'IN_TREATMENT') {
      for (const assignment of committedSpecialists) {
        const doctor = this.db.doctors.find(d => d.doctor_id === assignment.doctor_id);
        if (doctor && doctor.availability_status === 'ASSIGNED') doctor.availability_status = 'IN_PROCEDURE';
      }
    }
    const releasedAt = new Set();
    if (isTerminal) {
      for (const assignment of committedSpecialists) {
        releasedAt.add(assignment.hospital_id);
        assignment.status = 'RELEASED';
        assignment.released_at = nowIso;
        const doctor = this.db.doctors.find(d => d.doctor_id === assignment.doctor_id);
        if (doctor && ['ASSIGNED', 'IN_PROCEDURE'].includes(doctor.availability_status)) doctor.availability_status = 'AVAILABLE';
        releasedSpecialists.push(assignment.doctor_id);
      }
      this.db.resourceAllocations
        .filter(a => a.request_id === requestId && a.status === 'COMMITTED')
        .forEach(alloc => {
          alloc.status = 'RELEASED';
          alloc.released_at = new Date().toISOString();
          released += 1;
          releasedAt.add(alloc.hospital_id);
          const resource = this.db.medicalResources.find(r => r.resource_id === alloc.resource_id);
          if (resource) {
            // Never above total capacity: a unit removed from service while in use is not handed out again.
            if (resource.available_capacity >= resource.total_capacity) capped += 1;
            resource.available_capacity = Math.min(resource.available_capacity + 1, resource.total_capacity);
            resource.version_lock += 1;
          }
        });
      // Units serving the case leave it; only those on the road return to the pool. A unit that was
      // taken out of service (MAINTENANCE) stays out, or it would be auto-dispatched to the next case.
      this.db.ambulances
        .filter(a => a.assigned_request_id === requestId)
        .forEach(a => {
          if (ON_ROAD_STATUSES.includes(a.status)) a.status = 'AVAILABLE';
          delete a.assigned_request_id;
          delete a.destination_hospital_id;
          a.updated_at = new Date().toISOString();
        });
      // D5-a4: a hospital flagged UNSAFE becomes SAFE again once releases restore a safe state.
      for (const hospitalId of [...releasedAt].sort()) this.lockingEngine.refreshSafety(hospitalId, { onlyIfUnsafe: true, cause: 'release' });
    }

    this.db.auditLog({
      request_id: requestId, event_type: 'STATUS_CHANGED', previous_state: previous, new_state: newStatus,
      actor_role: actor.role, actor_id: actor.id, metadata: {
        released_allocations: released, capped_releases: capped,
        ...(releasedSpecialists.length ? { released_specialists: releasedSpecialists } : {})
      }
    });
    if (options.treatmentEvent) {
      this.db.auditLog({
        request_id: requestId, hospital_id: options.hospitalId ?? null, event_type: options.treatmentEvent, previous_state: previous,
        new_state: newStatus, actor_role: actor.role, actor_id: actor.id, metadata: { bed_label: request.bed_label ?? null }
      });
      if (isTerminal && (released || releasedSpecialists.length)) {
        this.db.auditLog({
          request_id: requestId, hospital_id: options.hospitalId ?? null, event_type: 'RESOURCE_RELEASED', previous_state: 'COMMITTED',
          new_state: 'RELEASED', actor_role: actor.role, actor_id: actor.id,
          metadata: { released_allocations: released, capped_releases: capped, released_specialists: releasedSpecialists }
        });
      }
    }
    return { previous, status: newStatus, unchanged: false, lockCleanupError, released_allocations: released, released_specialists: releasedSpecialists };
  }

  // ── Hospital treatment steps (Batch 8, P0) ─────────────────────────────────
  // Each runs synchronously under the case's request lock (as MySQL holds the EmergencyRequest row), re-checks that
  // `hospitalId` holds the case (its latest ACCEPTED referral; otherwise 404, like a missing case) and is audited.
  _heldCase(requestId, hospitalId) {
    const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
    const holder = request && this.db.hospitalAcceptances.findLast(a => a.request_id === requestId && a.status === 'ACCEPTED')?.hospital_id;
    if (!request || !hospitalId || holder !== hospitalId) throw new StoreError(404, 'Emergency request not found.');
    return request;
  }

  static milestones(r) {
    const iso = t => (t == null ? null : new Date(t).toISOString());
    return { arrived_at: iso(r.arrived_at), bed_label: r.bed_label ?? null, bed_allocated_at: iso(r.bed_allocated_at),
      treatment_started_at: iso(r.treatment_started_at), treatment_completed_at: iso(r.treatment_completed_at) };
  }

  /**
   * The receiving hospital confirms the patient arrived (ambulance handover): arrived_at, and every active ambulance seat
   * of the case is handed over and released. Only an ALLOCATED case; a repeat is { unchanged: true }.
   */
  async confirmArrival(requestId, hospitalId, actor) {
    this._heldCase(requestId, hospitalId);
    return this.lockingEngine.withRequestLock(requestId, () => {
      const request = this._heldCase(requestId, hospitalId);
      if (request.arrived_at) return { unchanged: true, status: request.status, milestones: MemoryStore.milestones(request), released_seats: [] };
      if (request.status !== 'ALLOCATED') throw new StoreError(409, `Arrival can only be confirmed for an ALLOCATED case; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
      const now = new Date().toISOString();
      request.arrived_at = now;
      request.updated_at = now;
      const seats = (this.db.ambulanceAssignments ?? []).filter(a => a.request_id === requestId && a.released_at == null);
      for (const seat of seats) Object.assign(seat, { handed_over_at: now, released_at: now, release_reason: 'HANDOVER' });
      this.db.auditLog({
        request_id: requestId, hospital_id: hospitalId, event_type: 'PATIENT_ARRIVED', previous_state: request.status, new_state: request.status,
        actor_role: actor.role, actor_id: actor.id,
        metadata: { released_seats: seats.map(a => a.ambulance_id), ambulance_id: this._withTransport(request).assigned_ambulance_id }
      });
      return { unchanged: false, status: request.status, milestones: MemoryStore.milestones(request), released_seats: seats.map(a => a.ambulance_id) };
    });
  }

  /**
   * Allocate a bed (free-text label) at the holding hospital to an arrived, ALLOCATED case. The label is unique among the
   * hospital's open cases (case-insensitive; 409 otherwise). A committed ICU_BED the case holds there is reported as
   * the bed's resource; otherwise the bed is not a tracked capacity unit (see README / report). Same label again: unchanged.
   */
  async allocateBed(requestId, hospitalId, bedLabel, actor) {
    this._heldCase(requestId, hospitalId);
    return this.lockingEngine.withRequestLock(requestId, () => {
      const request = this._heldCase(requestId, hospitalId);
      const key = bedLabel.toUpperCase();
      if (request.bed_label) {
        if (request.bed_label.toUpperCase() === key) return { unchanged: true, status: request.status, milestones: MemoryStore.milestones(request), bed_resource: this._bedResource(requestId, hospitalId) };
        throw new StoreError(409, `${requestId} already has bed ${request.bed_label}.`, 'BED_ALREADY_ALLOCATED');
      }
      if (request.status !== 'ALLOCATED') throw new StoreError(409, `A bed can only be allocated to an ALLOCATED case; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
      if (!request.arrived_at) throw new StoreError(409, 'Confirm the patient\'s arrival before allocating a bed.', 'INVALID_TRANSITION');
      const taken = this.db.emergencyRequests.find(r => r.request_id !== requestId && r.bed_label && r.bed_hospital_id === hospitalId
        && r.bed_label.toUpperCase() === key && !TERMINAL_STATES.includes(r.status));
      if (taken) throw new StoreError(409, `Bed ${bedLabel} is already allocated to another open case at this hospital.`, 'BED_TAKEN');
      const now = new Date().toISOString();
      Object.assign(request, { bed_label: bedLabel, bed_hospital_id: hospitalId, bed_allocated_at: now, updated_at: now });
      const bedResource = this._bedResource(requestId, hospitalId);
      this.db.auditLog({
        request_id: requestId, hospital_id: hospitalId, event_type: 'BED_ALLOCATED', previous_state: null, new_state: bedLabel,
        actor_role: actor.role, actor_id: actor.id, metadata: { bed_label: bedLabel, bed_resource: bedResource }
      });
      return { unchanged: false, status: request.status, milestones: MemoryStore.milestones(request), bed_resource: bedResource };
    });
  }

  /** 'ICU_BED' when the case holds a committed ICU bed at the hospital, else null. */
  _bedResource(requestId, hospitalId) {
    return this.db.resourceAllocations.some(a => a.request_id === requestId && a.hospital_id === hospitalId && a.status === 'COMMITTED'
      && this.db.medicalResources.find(r => r.resource_id === a.resource_id)?.resource_type === 'ICU_BED') ? 'ICU_BED' : null;
  }

  /** A progress note by the holding hospital, only while the case is IN_TREATMENT. */
  async addTreatmentNote(requestId, hospitalId, note, actor) {
    this._heldCase(requestId, hospitalId);
    return this.lockingEngine.withRequestLock(requestId, () => {
      const request = this._heldCase(requestId, hospitalId);
      if (request.status !== 'IN_TREATMENT') throw new StoreError(409, `Notes can only be added while the case is IN_TREATMENT; ${requestId} is ${request.status}.`, 'INVALID_TRANSITION');
      const row = { update_id: `TU-${uuidv4().slice(0, 12).toUpperCase()}`, request_id: requestId, hospital_id: hospitalId,
        author_id: actor.id ?? null, note, created_at: new Date().toISOString() };
      (this.db.treatmentUpdates ??= []).push(row);
      this.db.auditLog({
        request_id: requestId, hospital_id: hospitalId, event_type: 'TREATMENT_NOTE', previous_state: request.status, new_state: request.status,
        actor_role: actor.role, actor_id: actor.id, metadata: { update_id: row.update_id, note }
      });
      return { ...row };
    });
  }

  /**
   * Batch 8 (P-0.3): record the unit the admin chose when dispatching a case (null clears it); the accept's auto-dispatch
   * prefers it while it is AVAILABLE. Only a case still being matched (NEW / WAITING / MATCHING). Audited DISPATCH_PLANNED.
   */
  async setDispatchAmbulance(requestId, ambulanceId, actor) {
    return this.lockingEngine.withRequestLock(requestId, () => {
      const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
      if (!request) throw new StoreError(404, 'Emergency request not found.');
      if (!['NEW', 'WAITING', 'MATCHING'].includes(request.status)) throw new StoreError(409, `${requestId} is ${request.status}: it can no longer be dispatched.`);
      if ((request.dispatch_ambulance_id ?? null) === ambulanceId) return { unchanged: true };
      const previous = request.dispatch_ambulance_id ?? null;
      request.dispatch_ambulance_id = ambulanceId;
      this.db.auditLog({
        request_id: requestId, event_type: 'DISPATCH_PLANNED', previous_state: previous, new_state: ambulanceId,
        actor_role: actor.role, actor_id: actor.id, metadata: { ambulance_id: ambulanceId }
      });
      return { unchanged: false };
    });
  }

  /** The case's progress notes, oldest first. */
  async listTreatmentNotes(requestId) {
    return (this.db.treatmentUpdates ?? []).filter(u => u.request_id === requestId)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.update_id < b.update_id ? -1 : 1)))
      .map(u => ({ ...u }));
  }

  /** Committed allocations per hospital and resource type: [{ hospital_id, resource_type, occupied }]. */
  async countCommittedAllocations() {
    const counts = new Map();
    for (const a of this.db.resourceAllocations.filter(x => x.status === 'COMMITTED')) {
      const type = this.db.medicalResources.find(r => r.resource_id === a.resource_id)?.resource_type;
      if (!type) continue;
      const key = `${a.hospital_id}\u0000${type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, occupied]) => { const [hospital_id, resource_type] = key.split('\u0000'); return { hospital_id, resource_type, occupied }; })
      .sort((a, b) => (a.hospital_id + a.resource_type < b.hospital_id + b.resource_type ? -1 : 1));
  }

  // ── Referrals ──────────────────────────────────────────────────────────────
  async hasPendingAcceptance(requestId) {
    return this.db.hospitalAcceptances.some(a => a.request_id === requestId && a.status === 'PENDING');
  }

  /** Take the 90s soft-lock and mark the case MATCHING. Throws StoreError(409) if the lock is refused. */
  async acquireReferralLock(hospitalId, requestId, resourceTypes, { initiatedBy = null } = {}) {
    try {
      // The engine marks the case MATCHING inside its locked section (L1), as the MySQL engine does.
      return await this.lockingEngine.acquireSoftLock(hospitalId, requestId, resourceTypes, { initiatedBy });
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Hospital accepts: commit the allocation atomically. Throws StoreError(409) if it cannot. */
  async commitReferral(acceptanceId, actorId) {
    try {
      return await this.lockingEngine.commitAllocation(acceptanceId, actorId);
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Hospital declines: release the lock and fail over. Throws StoreError(409) if it cannot. */
  async rejectReferral(acceptanceId, reason, actorId) {
    try {
      return await this.lockingEngine.rejectAndFailover(acceptanceId, reason, actorId);
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Move an allocated case to its next treatment stage (D2-a6). Throws StoreError(409, with `safety`) if refused. */
  async advanceStage(requestId, actor) {
    try {
      return await this.lockingEngine.advanceStage(requestId, actor);
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Full audit hash-chain verification (Phase 3 Step 5, AC8). */
  async verifyAuditChain() {
    return this.db.verifyAuditChain();
  }

  /** The hospital's Banker's state and verdict; null if the hospital does not exist. */
  async getHospitalSafety(hospitalId) {
    return this.lockingEngine.getHospitalSafety(hospitalId);
  }

  /** The case's claim per stage and its current stage; null if the case does not exist. */
  async getClaim(requestId) {
    const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
    if (!request) return null;
    const stages = claimFromRows(this.db.requestClaims.filter(c => c.request_id === requestId));
    return { request_id: requestId, current_stage: request.current_stage ?? 1, recorded: Boolean(stages), stages: stages ? describeClaim(stages) : [] };
  }

  async getActiveLocks() {
    return this.lockingEngine.getActiveLocks();
  }

  async getAcceptance(acceptanceId) {
    return this.db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId) || null;
  }

  async listAcceptances({ hospitalId, initiatedBy } = {}) {
    return this.db.hospitalAcceptances
      .filter(a => (hospitalId === undefined || a.hospital_id === hospitalId)
        && (initiatedBy === undefined || (a.initiated_by != null && a.initiated_by === initiatedBy)))
      .map(a => ({ initiated_by: null, ...a }));
  }

  async createAlert({ hospital_id, request_id, alert_type, message }) {
    const alert = {
      alert_id: this.db.alerts.length + 1,
      hospital_id, request_id, alert_type,
      message: String(message).slice(0, 500), // Alert.message is VARCHAR(500) on MySQL, which truncates the same way
      status: 'UNREAD',
      created_at: new Date().toISOString()
    };
    this.db.alerts.push(alert);
    return alert;
  }

  // ── Ambulances ─────────────────────────────────────────────────────────────
  async listAmbulances({ status, hospitalId, ambulanceId } = {}) {
    let ambulances = [...this.db.ambulances];
    if (status) ambulances = ambulances.filter(a => a.status === status.toUpperCase());
    if (hospitalId) ambulances = ambulances.filter(a => a.hospital_id === hospitalId);
    if (ambulanceId) ambulances = ambulances.filter(a => a.ambulance_id === ambulanceId);
    return ambulances.map(a => ({
      ...a, hospital_name: this.db.hospitals.find(h => h.hospital_id === a.hospital_id)?.hospital_name
    }));
  }

  async getAmbulance(ambulanceId) {
    return this.db.ambulances.find(a => a.ambulance_id === ambulanceId) || null;
  }

  async ambulanceSummary() {
    const count = status => this.db.ambulances.filter(a => a.status === status).length;
    return {
      total: this.db.ambulances.length, available: count('AVAILABLE'), dispatched: count('DISPATCHED'),
      in_transit: count('IN_TRANSIT'), maintenance: count('MAINTENANCE')
    };
  }

  async updateAmbulanceStatus(ambulanceId, { status, request_id, current_lat, current_lng, eta_mins }, actor) {
    const amb = this.db.ambulances.find(a => a.ambulance_id === ambulanceId);
    if (!amb) throw new StoreError(404, 'Ambulance not found.');

    if (status === 'DISPATCHED') {
      if (!request_id) throw new StoreError(400, 'request_id is required when dispatching an ambulance.');
      const request = this.db.emergencyRequests.find(item => item.request_id === request_id);
      if (!request) throw new StoreError(404, 'Emergency request not found.');
      const accepted = this.db.hospitalAcceptances.some(a => a.request_id === request_id && a.status === 'ACCEPTED');
      if (!['ALLOCATED', 'IN_TREATMENT'].includes(request.status) || !accepted) {
        throw new StoreError(409, 'Ambulance dispatch requires an accepted emergency referral.');
      }
      if (amb.status !== 'AVAILABLE') throw new StoreError(409, 'Ambulance is not available for dispatch.');
      const alreadyAssigned = this.db.ambulances.find(a => a.ambulance_id !== amb.ambulance_id && a.assigned_request_id === request_id);
      if (alreadyAssigned) {
        throw new StoreError(409, `Request ${request_id} already has ambulance ${alreadyAssigned.ambulance_id} assigned.`);
      }
    }

    const previous = amb.status;
    const releasedFrom = UNASSIGNING_STATUSES.includes(status) ? amb.assigned_request_id ?? null : null;
    amb.status = status;
    if (status === 'DISPATCHED') amb.assigned_request_id = request_id;
    // Back at station, or out of service: either way the unit no longer serves its case, which must
    // then be able to receive a replacement.
    if (UNASSIGNING_STATUSES.includes(status)) {
      delete amb.assigned_request_id;
      delete amb.destination_hospital_id;
    }
    if (current_lat !== undefined) amb.current_lat = current_lat;
    if (current_lng !== undefined) amb.current_lng = current_lng;
    if (eta_mins !== undefined) amb.eta_mins = eta_mins;
    amb.updated_at = new Date().toISOString();

    // A unit leaving a case is recorded on that case's own trail, so the loss of transport is visible there.
    this.db.auditLog({
      request_id: status === 'DISPATCHED' ? request_id : releasedFrom, hospital_id: amb.hospital_id,
      event_type: 'AMBULANCE_STATUS_CHANGED', previous_state: previous, new_state: status,
      actor_role: actor.role, actor_id: actor.id,
      metadata: { ambulance_id: amb.ambulance_id, vehicle_number: amb.vehicle_number, released_from_request: releasedFrom }
    });
    return amb;
  }

  // ── Ambulance trips (migration 010: the live-tracking demo) ───────────────
  // Same contract as MySqlStore: rows with routes as [[lat, lng], ...], `version` checked and raised by every update,
  // at most one active trip (completed_at null) per ambulance and per case. Each method is synchronous inside.
  _tripOut(trip) {
    if (!trip) return null;
    return { ...trip, route_to_patient: trip.route_to_patient.map(p => [...p]), route_to_hospital: trip.route_to_hospital.map(p => [...p]) };
  }

  /** The reason another ACTIVE trip blocks `trip` (same ambulance or same case), or null. */
  _activeTripConflict(trip, excludeTripId = null) {
    const active = this.db.ambulanceTrips.filter(t => t.trip_id !== excludeTripId && t.completed_at == null);
    if (active.some(t => t.ambulance_id === trip.ambulance_id)) return `Ambulance ${trip.ambulance_id} already has an active trip.`;
    if (active.some(t => t.request_id === trip.request_id)) return `Case ${trip.request_id} already has an active trip.`;
    return null;
  }

  /** True while the unit is on the road for the case (DISPATCHED / IN_TRANSIT and assigned to it). */
  _unitServes(ambulanceId, requestId) {
    const unit = this.db.ambulances.find(a => a.ambulance_id === ambulanceId);
    return Boolean(unit) && unit.assigned_request_id === requestId && ON_ROAD_STATUSES.includes(unit.status);
  }

  _moveUnit(ambulanceId, { lat, lng, eta_mins }) {
    const unit = this.db.ambulances.find(a => a.ambulance_id === ambulanceId);
    unit.current_lat = lat;
    unit.current_lng = lng;
    unit.eta_mins = eta_mins;
    unit.updated_at = new Date().toISOString();
  }

  /** Insert a trip for a unit already dispatched to the case; its position becomes the unit's. Throws 409 otherwise. */
  async createTrip(row, { audit = [] } = {}) {
    if (!this._unitServes(row.ambulance_id, row.request_id)) {
      throw new StoreError(409, `Ambulance ${row.ambulance_id} is not dispatched to ${row.request_id}.`, 'UNIT_NOT_ASSIGNED');
    }
    const conflict = this._activeTripConflict(row);
    if (conflict) throw new StoreError(409, conflict, 'TRIP_ACTIVE');
    const now = new Date().toISOString();
    const trip = {
      phase: 'DISPATCHED', progress: 0, paused: 0, is_demo: 0, created_by: null, eta_seconds: null,
      started_at: null, arrived_patient_at: null, picked_up_at: null, arrived_hospital_at: null, completed_at: null,
      ...row, version: 0, created_at: now, updated_at: now
    };
    this.db.ambulanceTrips.push(trip);
    this._moveUnit(trip.ambulance_id, { lat: trip.current_lat, lng: trip.current_lng, eta_mins: etaMinutes(trip.eta_seconds) });
    for (const entry of audit) this.db.auditLog(entry);
    return this._tripOut(trip);
  }

  async getTrip(tripId) {
    return this._tripOut(this.db.ambulanceTrips.find(t => t.trip_id === tripId));
  }

  /** Newest first. Filters: hospitalId, ambulanceId, requestId, activeOnly (completed_at null). */
  async listTrips({ hospitalId, ambulanceId, requestId, activeOnly = false } = {}) {
    return this.db.ambulanceTrips
      .filter(t => (!activeOnly || t.completed_at == null)
        && (hospitalId === undefined || t.hospital_id === hospitalId)
        && (ambulanceId === undefined || t.ambulance_id === ambulanceId)
        && (requestId === undefined || t.request_id === requestId))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.trip_id < b.trip_id ? 1 : -1)))
      .map(t => this._tripOut(t));
  }

  /** Active, unpaused trips on a moving leg (what the tracking engine advances each tick). */
  async listMovingTrips() {
    return this.db.ambulanceTrips
      .filter(t => t.completed_at == null && !Number(t.paused) && TRIP_MOVING_PHASES.includes(t.phase))
      .map(t => this._tripOut(t));
  }

  /**
   * Apply `changes` if the trip is still at `expectedVersion` (else 409 TRIP_CONFLICT), raising the version; Date values
   * are timestamps. With `unitPosition` the unit's position follows, but only while it still serves the case.
   * Returns { trip, unitServes }.
   */
  async updateTrip(tripId, expectedVersion, changes, { audit = [], unitPosition = null } = {}) {
    const trip = this.db.ambulanceTrips.find(t => t.trip_id === tripId);
    if (!trip) throw new StoreError(404, 'Trip not found.');
    if (trip.version !== expectedVersion) throw new StoreError(409, 'The trip changed concurrently. Please retry.', 'TRIP_CONFLICT');
    if (changes.completed_at === null && trip.completed_at != null) {
      const conflict = this._activeTripConflict(trip, trip.trip_id);
      if (conflict) throw new StoreError(409, conflict, 'TRIP_ACTIVE');
    }
    const unitServes = this._unitServes(trip.ambulance_id, trip.request_id);
    if (unitPosition && unitServes) this._moveUnit(trip.ambulance_id, unitPosition);
    for (const [key, value] of Object.entries(changes)) trip[key] = value instanceof Date ? value.toISOString() : value;
    trip.version += 1;
    trip.updated_at = new Date().toISOString();
    for (const entry of audit) this.db.auditLog(entry);
    return { trip: this._tripOut(trip), unitServes };
  }

  // ── Analytics & live KPIs ──────────────────────────────────────────────────
  async getAnalyticsData() {
    return {
      hospitals: this.db.hospitals,
      medicalResources: this.db.medicalResources,
      doctors: this.db.doctors,
      ambulances: this.db.ambulances,
      emergencyRequests: this.db.emergencyRequests,
      // is_demo of each referral's case: demo cases stay out of the live response-time KPI, as out of the history (S1).
      hospitalAcceptances: this.db.hospitalAcceptances.map(a => ({
        ...a, is_demo: Number(this.db.emergencyRequests.find(r => r.request_id === a.request_id)?.is_demo ?? 0)
      }))
    };
  }

  /**
   * Recorded rows for historical analytics (Phase 3 Step 6) in the window [fromMs, toMs), epoch milliseconds. Same
   * shape as MySqlStore.getAnalyticsHistory; server/services/analyticsEngine.js does the arithmetic. Referral and
   * request rows are those created in the window; capacity and committed allocations are the current state.
   * Demo cases (is_demo, S1) are not observations: they, their referrals and their audit timings are left out.
   */
  async getAnalyticsHistory({ fromMs, toMs }) {
    const ms = t => (t === null || t === undefined ? null : typeof t === 'number' ? t : Date.parse(t));
    const inWindow = v => v !== null && Number.isFinite(v) && v >= fromMs && v < toMs;
    const demo = new Set(this.db.emergencyRequests.filter(r => Number(r.is_demo ?? 0) === 1).map(r => r.request_id));
    const requests = this.db.emergencyRequests
      .filter(r => !demo.has(r.request_id))
      .map(r => ({
        request_id: r.request_id, request_ms: ms(r.request_time), emergency_type: r.emergency_type, priority: r.priority,
        pickup_lat: r.pickup_lat ?? null, pickup_lng: r.pickup_lng ?? null,
        required_resource_types: [...(r.required_resource_types ?? r.required_resources ?? [])]
      }))
      .filter(r => inWindow(r.request_ms));
    const firstEvent = new Map(); // request_id -> { REQUEST_CREATED, ALLOCATION_COMMITTED } earliest event ms
    for (const h of this.db.emergencyHistory) {
      if (!h.request_id || (h.event_type !== 'REQUEST_CREATED' && h.event_type !== 'ALLOCATION_COMMITTED')) continue;
      const t = h.event_time_ms ?? ms(h.event_time);
      const seen = firstEvent.get(h.request_id) ?? {};
      if (seen[h.event_type] === undefined || t < seen[h.event_type]) seen[h.event_type] = t;
      firstEvent.set(h.request_id, seen);
    }
    return {
      requests,
      acceptances: this.db.hospitalAcceptances
        .filter(a => !demo.has(a.request_id))
        .map(a => ({ request_id: a.request_id, hospital_id: a.hospital_id, status: a.status, created_ms: ms(a.created_at), responded_ms: ms(a.responded_at) }))
        .filter(a => inWindow(a.created_ms)),
      allocationTimes: requests
        .map(r => ({ request_id: r.request_id, created_ms: firstEvent.get(r.request_id)?.REQUEST_CREATED ?? null, allocated_ms: firstEvent.get(r.request_id)?.ALLOCATION_COMMITTED ?? null }))
        .filter(t => t.created_ms !== null && t.allocated_ms !== null),
      hospitals: this.db.hospitals.map(h => ({
        hospital_id: h.hospital_id, hospital_name: h.hospital_name, emergency_status: h.emergency_status,
        acceptance_rate: h.acceptance_rate ?? null, avg_response_sec: h.avg_response_sec ?? null
      })),
      resources: this.db.medicalResources.map(r => ({
        hospital_id: r.hospital_id, resource_type: r.resource_type,
        total_capacity: r.total_capacity, available_capacity: r.available_capacity, locked_capacity: r.locked_capacity
      })),
      allocations: this.db.resourceAllocations.filter(a => a.status === 'COMMITTED')
        .map(a => ({ hospital_id: a.hospital_id, request_id: a.request_id, status: a.status }))
    };
  }

  async listAudit({ eventType, hospitalId, limit = 100 } = {}) {
    let events = [...this.db.emergencyHistory];
    if (eventType) events = events.filter(e => e.event_type === eventType);
    if (hospitalId) events = events.filter(e => e.hospital_id === hospitalId);
    // Same order as MySQL: ORDER BY event_time DESC, history_id DESC (newest first, ties newest-stored first).
    const time = e => (e.event_time instanceof Date ? e.event_time.getTime() : Date.parse(e.event_time));
    events.sort((a, b) => (time(b) - time(a)) || (Number(b.history_id) - Number(a.history_id)));
    return events.slice(0, limit);
  }

  async getKpis() {
    const icu = this.db.medicalResources.filter(r => r.resource_type === 'ICU_BED');
    const vents = this.db.medicalResources.filter(r => r.resource_type === 'VENTILATOR');
    return {
      active_emergencies: this.db.emergencyRequests.filter(r => !TERMINAL_STATES.includes(r.status)).length,
      critical_p1: this.db.emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length,
      // The /analytics/dashboard names of the same two figures (kept alongside the old names for older clients).
      critical_p1_waiting: this.db.emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length,
      // Free units: soft-locked units are counted inside available_capacity but already reserved.
      icu_available: icu.reduce((s, r) => s + r.available_capacity - r.locked_capacity, 0),
      ventilators_available: vents.reduce((s, r) => s + r.available_capacity - r.locked_capacity, 0),
      hospitals_open: this.db.hospitals.filter(h => h.emergency_status === 'OPEN').length,
      ambulances_available: this.db.ambulances.filter(a => a.status === 'AVAILABLE').length,
      available_ambulances: this.db.ambulances.filter(a => a.status === 'AVAILABLE').length,
      active_locks: (await this.lockingEngine.getActiveLocks()).length,
      timestamp: new Date().toISOString()
    };
  }

  async getSnapshotCounts() {
    return {
      hospitals: this.db.hospitals.length,
      ambulances: this.db.ambulances.filter(a => a.status === 'AVAILABLE').length,
      emergencies: this.db.emergencyRequests.filter(r => !TERMINAL_STATES.includes(r.status)).length,
      active_locks: (await this.lockingEngine.getActiveLocks()).length,
      server_time: new Date().toISOString()
    };
  }
}

export default MemoryStore;
