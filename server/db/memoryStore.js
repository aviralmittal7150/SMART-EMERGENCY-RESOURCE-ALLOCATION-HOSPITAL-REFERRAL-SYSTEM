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

// Setting a unit to one of these ends its assignment to a case.
const UNASSIGNING_STATUSES = ['AVAILABLE', 'MAINTENANCE'];

export class MemoryStore extends EventEmitter {
  constructor({ db = defaultDb, lockingEngine = defaultEngine } = {}) {
    super();
    this.mode = 'memory';
    this.db = db;
    this.lockingEngine = lockingEngine;
    this._idempotencyKeys = new Map(); // `${actor}\0${endpoint}\0${key}` -> { fingerprint, request_id, patient_id }
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
    }, intervalMs);
    timer.unref?.();
    this._stopWorker = () => clearInterval(timer);
  }

  async ping() { return true; }

  async close() {
    this._stopWorker?.();
    this._stopWorker = null;
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

    const nextTotal = total === undefined ? resource.total_capacity : Number(total);
    const nextAvailable = available === undefined ? resource.available_capacity : Number(available);
    if (!Number.isInteger(nextTotal) || !Number.isInteger(nextAvailable)
      || nextTotal < 0 || nextAvailable < 0
      || nextAvailable > nextTotal
      || nextAvailable < resource.locked_capacity) {
      throw new StoreError(400, 'Capacity must be whole numbers with 0 <= locked <= available <= total.');
    }

    let release;
    const previousCapacity = `${resource.total_capacity}:${resource.available_capacity}`;
    try {
      release = await this.db.acquireResourceLock(resource.resource_id, 3000);
      resource.total_capacity = nextTotal;
      resource.available_capacity = nextAvailable;
      resource.version_lock += 1;
    } catch (error) {
      throw new StoreError(409, error.message);
    } finally {
      release?.();
    }

    this.db.auditLog({
      request_id: null, hospital_id: hospitalId, event_type: 'RESOURCE_CAPACITY_UPDATED',
      previous_state: previousCapacity, new_state: `${nextTotal}:${nextAvailable}`,
      actor_role: actor.role, actor_id: actor.id, metadata: { resource_type: resource.resource_type }
    });
    return resource;
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

  async addDoctor({ hospital_id, full_name, specialization, shift_start, shift_end }, actor) {
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
    return doctor;
  }

  async updateDoctorStatus(doctorId, availabilityStatus, actor) {
    const doctor = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!doctor) return null;
    const previous = doctor.availability_status;
    doctor.availability_status = availabilityStatus;
    this.db.auditLog({
      request_id: null, hospital_id: doctor.hospital_id, event_type: 'DOCTOR_STATUS_CHANGED',
      previous_state: previous, new_state: availabilityStatus, actor_role: actor.role, actor_id: actor.id,
      metadata: { doctorId: doctor.doctor_id, full_name: doctor.full_name }
    });
    return { doctor_id: doctor.doctor_id, previous_status: previous, new_status: availabilityStatus };
  }

  async updateDoctorShift(doctorId, { shift_start, shift_end }) {
    const doctor = this.db.doctors.find(d => d.doctor_id === doctorId);
    if (!doctor) return null;
    if (shift_start) doctor.shift_start = shift_start;
    if (shift_end) doctor.shift_end = shift_end;
    return { doctor_id: doctor.doctor_id, shift_start: doctor.shift_start, shift_end: doctor.shift_end };
  }

  async removeDoctor(doctorId, actor) {
    const idx = this.db.doctors.findIndex(d => d.doctor_id === doctorId);
    if (idx === -1) return null;
    const [removed] = this.db.doctors.splice(idx, 1);
    this.db.auditLog({
      request_id: null, hospital_id: removed.hospital_id, event_type: 'DOCTOR_REMOVED',
      previous_state: removed.availability_status, new_state: null, actor_role: 'ADMIN', actor_id: actor.id,
      metadata: { doctorId: removed.doctor_id, full_name: removed.full_name }
    });
    return removed;
  }

  // ── Emergencies ────────────────────────────────────────────────────────────
  // hospitalScope: a hospital desk only sees cases that were referred to its own facility.
  _visible(requestId, hospitalScope) {
    if (!hospitalScope) return true;
    return this.db.hospitalAcceptances.some(a => a.request_id === requestId && a.hospital_id === hospitalScope);
  }

  async listRequests({ status, hospitalScope } = {}) {
    let requests = this.db.emergencyRequests.filter(r => this._visible(r.request_id, hospitalScope));
    if (status) requests = requests.filter(r => r.status === status.toUpperCase());
    requests.sort((a, b) => (a.priority !== b.priority)
      ? a.priority - b.priority
      : new Date(a.request_time) - new Date(b.request_time));
    return requests.map(r => ({ ...this._withTransport(r), patient: this.db.patients.find(p => p.patient_id === r.patient_id) }));
  }

  /** The case as shown to clients, with its usable ambulance (if any) and whether transport is still needed. */
  _withTransport(request) {
    const unit = this.db.ambulances.find(a => a.assigned_request_id === request.request_id && ON_ROAD_STATUSES.includes(a.status));
    const assigned = unit?.ambulance_id ?? null;
    return { ...request, assigned_ambulance_id: assigned, transport_required: transportRequired(request.status, assigned) };
  }

  async getRequest(requestId) {
    return this.db.emergencyRequests.find(r => r.request_id === requestId) || null;
  }

  async getRequestDetail(requestId, { hospitalScope } = {}) {
    const request = await this.getRequest(requestId);
    if (!request || !this._visible(requestId, hospitalScope)) return null;
    return {
      request: this._withTransport(request),
      patient: this.db.patients.find(p => p.patient_id === request.patient_id),
      allocations: this.db.resourceAllocations.filter(a => a.request_id === requestId),
      acceptances: this.db.hospitalAcceptances.filter(a => a.request_id === requestId),
      auditEvents: this.db.emergencyHistory.filter(h => h.request_id === requestId)
    };
  }

  /** Returns null when the case is not visible to the scope; otherwise the (possibly empty) trail. */
  async listRequestAudit(requestId, { hospitalScope } = {}) {
    if (!this._visible(requestId, hospitalScope)) return null;
    return this.db.emergencyHistory
      .filter(h => h.request_id === requestId)
      .sort((a, b) => new Date(a.event_time) - new Date(b.event_time));
  }

  /**
   * idempotency: { key, endpoint, fingerprint } or null. A repeated key with the same fingerprint returns
   * the case it created ({ ..., replayed: true }); with a different fingerprint it is refused (422).
   * Check and insert run without an await in between, so concurrent duplicates cannot both create.
   */
  async createRequest({ patient, request }, actor, { idempotency = null } = {}) {
    const idemKey = idempotency && `${actor.id}\u0000${idempotency.endpoint}\u0000${idempotency.key}`;
    if (idemKey) {
      const previous = this._idempotencyKeys.get(idemKey);
      if (previous) {
        if (previous.fingerprint !== idempotency.fingerprint) {
          throw new StoreError(422, 'This Idempotency-Key was already used for a different request.');
        }
        return { request_id: previous.request_id, patient_id: previous.patient_id, status: 'WAITING', replayed: true };
      }
    }

    const patientId = `PAT-${uuidv4().slice(0, 6).toUpperCase()}`;
    let requestId;
    do {
      requestId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
    } while (this.db.emergencyRequests.some(r => r.request_id === requestId));

    const now = new Date().toISOString();
    this.db.patients.push({ patient_id: patientId, ...patient, created_at: now });
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
      request_time: now,
      updated_at: now
    });
    this.db.auditLog({
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
    if (idemKey) {
      this._idempotencyKeys.set(idemKey, { fingerprint: idempotency.fingerprint, request_id: requestId, patient_id: patientId });
    }
    return { request_id: requestId, patient_id: patientId, status: 'WAITING', replayed: false };
  }

  async transitionRequestStatus(requestId, newStatus, actor) {
    const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
    if (!request) throw new StoreError(404, 'Request not found.');

    const previous = request.status;
    if (previous === newStatus) return { previous, status: newStatus, unchanged: true, lockCleanupError: null };
    if (!canTransition(previous, newStatus)) {
      throw new StoreError(409, `Invalid lifecycle transition: ${previous} -> ${newStatus}.`);
    }
    request.status = newStatus;
    request.updated_at = new Date().toISOString();

    let lockCleanupError = null;
    const isTerminal = TERMINAL_STATES.includes(newStatus);
    // Returning a matching case to the queue abandons its pending handshake too.
    if (isTerminal || (previous === 'MATCHING' && newStatus === 'WAITING')) {
      // The new status is already recorded (synchronously), so any queued acceptance for a
      // terminal request is refused by the locking engine. If the cleanup fails we still release
      // committed resources below, then report it; a leftover lock cannot be committed and
      // expires at its TTL.
      try {
        await this.lockingEngine.cancelPendingForRequest(requestId, `Request ${newStatus}`);
      } catch (err) {
        lockCleanupError = err;
        console.error('[LIFECYCLE]', err.message);
        this.db.auditLog({
          request_id: requestId, event_type: 'LOCK_CLEANUP_FAILED', previous_state: previous, new_state: newStatus,
          actor_role: 'SYSTEM', metadata: { error: err.message }
        });
      }
    }

    if (isTerminal) {
      this.db.resourceAllocations
        .filter(a => a.request_id === requestId && a.status === 'COMMITTED')
        .forEach(alloc => {
          alloc.status = 'RELEASED';
          alloc.released_at = new Date().toISOString();
          const resource = this.db.medicalResources.find(r => r.resource_id === alloc.resource_id);
          if (resource) {
            resource.available_capacity += 1;
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
    }

    this.db.auditLog({
      request_id: requestId, event_type: 'STATUS_CHANGED', previous_state: previous, new_state: newStatus,
      actor_role: actor.role, actor_id: actor.id
    });
    return { previous, status: newStatus, unchanged: false, lockCleanupError };
  }

  // ── Referrals ──────────────────────────────────────────────────────────────
  async hasPendingAcceptance(requestId) {
    return this.db.hospitalAcceptances.some(a => a.request_id === requestId && a.status === 'PENDING');
  }

  /** Take the 90s soft-lock and mark the case MATCHING. Throws StoreError(409) if the lock is refused. */
  async acquireReferralLock(hospitalId, requestId, resourceTypes) {
    let lock;
    try {
      lock = await this.lockingEngine.acquireSoftLock(hospitalId, requestId, resourceTypes);
    } catch (err) {
      throw new StoreError(409, err.message);
    }
    const request = this.db.emergencyRequests.find(r => r.request_id === requestId);
    if (request) {
      request.status = 'MATCHING';
      request.updated_at = new Date().toISOString();
    }
    return lock;
  }

  /** Hospital accepts: commit the allocation atomically. Throws StoreError(409) if it cannot. */
  async commitReferral(acceptanceId, actorId) {
    try {
      return await this.lockingEngine.commitAllocation(acceptanceId, actorId);
    } catch (err) {
      throw new StoreError(409, err.message);
    }
  }

  /** Hospital declines: release the lock and fail over. Throws StoreError(409) if it cannot. */
  async rejectReferral(acceptanceId, reason, actorId) {
    try {
      return await this.lockingEngine.rejectAndFailover(acceptanceId, reason, actorId);
    } catch (err) {
      throw new StoreError(409, err.message);
    }
  }

  async getActiveLocks() {
    return this.lockingEngine.getActiveLocks();
  }

  async getAcceptance(acceptanceId) {
    return this.db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId) || null;
  }

  async listAcceptances({ hospitalId } = {}) {
    return hospitalId
      ? this.db.hospitalAcceptances.filter(a => a.hospital_id === hospitalId)
      : [...this.db.hospitalAcceptances];
  }

  async createAlert({ hospital_id, request_id, alert_type, message }) {
    const alert = {
      alert_id: this.db.alerts.length + 1,
      hospital_id, request_id, alert_type, message,
      status: 'UNREAD',
      created_at: new Date().toISOString()
    };
    this.db.alerts.push(alert);
    return alert;
  }

  // ── Ambulances ─────────────────────────────────────────────────────────────
  async listAmbulances({ status, hospitalId } = {}) {
    let ambulances = [...this.db.ambulances];
    if (status) ambulances = ambulances.filter(a => a.status === status.toUpperCase());
    if (hospitalId) ambulances = ambulances.filter(a => a.hospital_id === hospitalId);
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

  // ── Analytics & live KPIs ──────────────────────────────────────────────────
  async getAnalyticsData() {
    return {
      hospitals: this.db.hospitals,
      medicalResources: this.db.medicalResources,
      doctors: this.db.doctors,
      ambulances: this.db.ambulances,
      emergencyRequests: this.db.emergencyRequests,
      hospitalAcceptances: this.db.hospitalAcceptances
    };
  }

  async listAudit({ eventType, hospitalId, limit = 100 } = {}) {
    let events = [...this.db.emergencyHistory];
    if (eventType) events = events.filter(e => e.event_type === eventType);
    if (hospitalId) events = events.filter(e => e.hospital_id === hospitalId);
    events.sort((a, b) => new Date(b.event_time) - new Date(a.event_time));
    return events.slice(0, limit);
  }

  async getKpis() {
    const icu = this.db.medicalResources.filter(r => r.resource_type === 'ICU_BED');
    const vents = this.db.medicalResources.filter(r => r.resource_type === 'VENTILATOR');
    return {
      active_emergencies: this.db.emergencyRequests.filter(r => !TERMINAL_STATES.includes(r.status)).length,
      critical_p1: this.db.emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length,
      icu_available: icu.reduce((s, r) => s + r.available_capacity, 0),
      ventilators_available: vents.reduce((s, r) => s + r.available_capacity, 0),
      hospitals_open: this.db.hospitals.filter(h => h.emergency_status === 'OPEN').length,
      ambulances_available: this.db.ambulances.filter(a => a.status === 'AVAILABLE').length,
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
