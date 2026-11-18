// server/services/lockingEngine.js
// OS-Grade Concurrency & Mutual Exclusion Engine
// Implements soft-locks with 90-second TTL and atomic commit semantics

import { EventEmitter } from 'events';
import { db } from '../db/seed.js';
import { v4 as uuidv4 } from 'uuid';
import { ON_ROAD_AMBULANCE_STATUSES } from './lifecycle.js';
import { EXCLUSIVE_SPECIALISTS } from './emergencyRequirements.js';
import { claimFromRows, singleStageClaim, stageOf, physicalTypes, exclusiveSpecialistOf } from './clinicalPathways.js';
import { buildHospitalState, admissionDecision, advanceDecision, evaluateHospital, summarize } from './hospitalSafety.js';
import { ExecutionHooks } from './executionHooks.js';
import { memoryLockOrderActive, runInLockScope, noteLockAcquired, noteLockReleased } from './lockOrder.js';
import { unitInArea } from './operatingArea.js';

const SOFT_LOCK_TTL_MS = 90_000; // 90 seconds
const TERMINAL_REQUEST_STATES = ['CANCELLED', 'COMPLETED'];
// Only requests still looking for a facility may receive (or fail over to) a referral.
const MATCHING_REQUEST_STATES = ['NEW', 'WAITING', 'MATCHING'];

/**
 * An expected, business-level refusal (the in-memory counterpart of mysqlLockingEngine's LockError). Failover skips a
 * candidate that refuses; any other error (a mutex timeout, a bug) stops the failover, as on MySQL.
 */
export class LockRefusal extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'LockRefusal';
    this.code = code;
  }
}

class LockingEngine extends EventEmitter {
  constructor() {
    super();
    // Map of resourceId -> { acceptanceId, requestId, hospitalId, expiresAt, timerId }
    this._activeLocks = new Map();
    // Referral initiation and commitment are request-scoped critical sections.
    // Resource mutexes alone are insufficient because a request can reserve
    // different hospitals concurrently before either acceptance is recorded.
    this._requestLocks = new Map();
    // Test-only pause points (see executionHooks.js). Inactive unless a test installs a handler.
    this.hooks = new ExecutionHooks();
  }

  /**
   * Run `operation` after the named pause point. With no handler installed this is exactly
   * `operation()`: no extra await, so production interleavings are unchanged.
   */
  _hooked(point, context, operation) {
    return this.hooks.active(point)
      ? this.hooks.run(point, { backend: 'memory', ...context }).then(operation)
      : operation();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Acquire Soft Lock — Simulates SELECT ... FOR UPDATE with TTL
  // Implements mutual exclusion: only one lock per resource at a time
  // ─────────────────────────────────────────────────────────────────────────
  async acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED'], { initiatedBy = null } = {}) {
    try {
      return await this._withRequestLock(requestId, () => this._hooked('acquire:requestLocked', { requestId, hospitalId },
        () => this._acquireSoftLock(hospitalId, requestId, resourceTypes, { initiatedBy })));
    } catch (err) {
      // A safety refusal is recorded on the case (D4-a3/a5); the refused attempt itself changed nothing.
      if (err.code === 'UNSAFE') this.recordUnsafeRefusal(requestId, hospitalId, err.safety);
      throw err;
    }
  }

  /** initiatedBy: the user who sent the referral (a failover passes on the ended referral's), recorded on the row. */
  async _acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED'], { initiatedBy = null } = {}) {
    const releaseFns = [];
    const lockedResources = [];
    const normalizedTypes = [...new Set(resourceTypes.map(type => String(type).trim().toUpperCase()))].sort();

    if (normalizedTypes.some(type => !['ICU_BED', 'VENTILATOR', 'OT'].includes(type))) {
      throw new LockRefusal('Unsupported resource type requested.');
    }

    this._assertRequestAllocatable(requestId);
    this._assertHospitalEligible(hospitalId, requestId);

    const duplicateRequest = [...this._activeLocks.values()].find(lock => lock.requestId === requestId);
    if (duplicateRequest) {
      throw new LockRefusal(`Request ${requestId} already has an active referral lock.`);
    }

    // The stage to admit comes from the claim recorded at intake. A case without one (created before claims
    // existed, or by a low-level test) is a legacy single-stage case claiming the requested types.
    const requestRow = db.emergencyRequests.find(r => r.request_id === requestId);
    const stageNo = requestRow?.current_stage ?? 1;
    const stages = this._claimOf(requestId) ?? singleStageClaim(normalizedTypes, requestRow?.required_specialist ?? null);
    const stage = stageOf(stages, stageNo);
    const stageTypes = physicalTypes(stage);
    const exclusive = exclusiveSpecialistOf(stage);

    let lockRecord;
    let previousStatus = 'WAITING'; // a synthetic request id (low-level tests) has no row
    let reservedDoctor = null;
    let reservation = null;
    let decision;
    try {
      // Per-hospital lock (docs/lock-order.md, level 2): serialises this hospital's capacity and doctor
      // changes; other hospitals proceed independently.
      releaseFns.push(await db.acquireHospitalLock(hospitalId, 3000));
      if (this.hooks.active('acquire:hospitalLocked')) {
        await this.hooks.run('acquire:hospitalLocked', { backend: 'memory', requestId, hospitalId });
      }

      const candidates = [];
      for (const rType of stageTypes) {
        const resource = db.medicalResources.find(
          r => r.hospital_id === hospitalId && r.resource_type === rType
        );
        if (!resource) throw new LockRefusal(`Resource ${rType} not found for hospital ${hospitalId}`);
        // Acquire OS mutex (SELECT ... FOR UPDATE simulation)
        releaseFns.push(await db.acquireResourceLock(resource.resource_id, 3000));
        candidates.push(resource);
      }

      // From here to registering the lock everything is synchronous: nothing can interleave. Waiting for the
      // mutexes can yield for real time, during which the request may have been cancelled, the hospital
      // closed or its specialist gone off duty, so all of it is re-checked now.
      this._assertRequestAllocatable(requestId);
      this._assertHospitalEligible(hospitalId, requestId);
      // available_capacity is the committed inventory; locked_capacity the part reserved by pending handshakes.
      for (const resource of candidates) {
        if (resource.available_capacity - resource.locked_capacity <= 0) {
          throw new LockRefusal(`No available ${resource.resource_type} at ${hospitalId}`);
        }
      }
      // Exclusive specialist (D3-B): the lowest-id AVAILABLE one at this hospital.
      if (exclusive) {
        reservedDoctor = db.doctors
          .filter(d => d.hospital_id === hospitalId && d.specialization === exclusive && d.availability_status === 'AVAILABLE')
          .sort((a, b) => a.doctor_id.localeCompare(b.doctor_id))[0] || null;
        if (!reservedDoctor) throw new LockRefusal(`Required specialist ${exclusive} is not available at ${hospitalId}.`);
      }
      // Banker's safety check (option A), computed before anything is applied (G9).
      decision = admissionDecision(this._hospitalState(hospitalId), { id: requestId, stages, currentStage: stageNo });
      if (!decision.granted) throw this._refusal(decision, hospitalId);
      for (const resource of candidates) {
        resource.locked_capacity += 1;
        resource.version_lock += 1;
        lockedResources.push(resource);
      }

      const acceptanceId = `ACC-${uuidv4().slice(0, 8).toUpperCase()}`;
      const expiresAt = Date.now() + SOFT_LOCK_TTL_MS;

      if (reservedDoctor) {
        reservation = {
          assignment_id: `DA-${uuidv4().slice(0, 8).toUpperCase()}`, doctor_id: reservedDoctor.doctor_id,
          request_id: requestId, hospital_id: hospitalId, acceptance_id: acceptanceId, stage_no: stageNo,
          status: 'LOCKED', reserved_at: new Date().toISOString(), committed_at: null, released_at: null
        };
        db.doctorAssignments.push(reservation);
        reservedDoctor.availability_status = 'RESERVED';
      }

      lockRecord = {
        acceptanceId,
        requestId,
        hospitalId,
        resourceIds: lockedResources.map(r => r.resource_id),
        resourceTypes: stageTypes,
        specialistId: reservedDoctor?.doctor_id ?? null,
        stage: stageNo,
        expiresAt,
        remainingSec: 90,
        status: 'PENDING'
      };

      // Store in HospitalAcceptance
      db.hospitalAcceptances.push({
        acceptance_id: acceptanceId,
        request_id: requestId,
        hospital_id: hospitalId,
        status: 'PENDING',
        lock_expires_at: new Date(expiresAt).toISOString(),
        created_at: new Date().toISOString(),
        initiated_by: initiatedBy
      });

      // ── TTL Countdown ──
      let elapsed = 0;
      const countdownTimer = setInterval(() => {
        elapsed += 1;
        lockRecord.remainingSec = Math.max(0, 90 - elapsed);
        // A throw escaping this callback would crash the process and skip the expiry below.
        this._afterApplied(`Tick for ${acceptanceId}`, () => this.emit('lock_tick', this._toPublicLock(lockRecord)));

        if (elapsed >= 90) {
          clearInterval(countdownTimer);
          this._handleTimeout(lockRecord).catch(err => console.error('[LOCK] TTL handling failed:', err.message));
        }
      }, 1000);

      lockRecord.timerId = countdownTimer;
      this._activeLocks.set(acceptanceId, { ...lockRecord, releaseFns, lockedResources, countdownTimer });
      // L1: the case becomes MATCHING in this same synchronous section (as MySQL's _acquire does in its
      // transaction), so no other operation can observe the lock without the status or the reverse.
      const request = db.emergencyRequests.find(r => r.request_id === requestId);
      if (request) {
        previousStatus = request.status;
        request.status = 'MATCHING';
        request.updated_at = new Date().toISOString();
      }
    } catch (err) {
      // Release any acquired OS mutexes on partial failure
      releaseFns.forEach(fn => { try { fn(); } catch(_) {} });
      // Rollback any partial soft-locks
      lockedResources.forEach(r => {
        if (r.locked_capacity > 0) {
          r.locked_capacity -= 1;
          r.version_lock += 1;
        }
      });
      if (reservation) {
        db.doctorAssignments.splice(db.doctorAssignments.indexOf(reservation), 1);
        if (reservedDoctor?.availability_status === 'RESERVED') reservedDoctor.availability_status = 'AVAILABLE';
      }
      db.persist?.();
      throw err;
    }

    // The lock is registered and now owns the reserved capacity; only its own
    // release (commit / reject / cancel / TTL) may give it back. Rolling back here
    // would leave a live lock whose expiry later frees another request's bed.
    // Release the OS mutexes; the application-level lock is maintained.
    releaseFns.forEach(fn => fn());

    const { acceptanceId } = lockRecord;
    this._afterApplied(`Acquired ${acceptanceId}`, () => {
      db.auditLog({
        request_id: requestId,
        hospital_id: hospitalId,
        event_type: 'LOCK_ACQUIRED',
        previous_state: previousStatus,
        new_state: 'PENDING_ACCEPTANCE',
        actor_role: 'SYSTEM',
        metadata: { acceptanceId, resourceIds: lockRecord.resourceIds, specialistId: lockRecord.specialistId, stage: stageNo, safetySequence: decision.safety.sequence }
      });
      db.persist?.();
    });
    this._afterApplied(`Acquired ${acceptanceId}`, () => this.emit('lock_acquired', this._toPublicLock(lockRecord)));
    return lockRecord;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Commit Allocation — ACID atomic transaction on ACCEPT
  // ─────────────────────────────────────────────────────────────────────────
  async commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    // Once committed the lock entry is gone; a retried accept is serialized on the acceptance's request.
    const requestId = this._activeLocks.get(acceptanceId)?.requestId
      || db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId)?.request_id;
    if (!requestId) throw new Error(`No active lock found for acceptance ${acceptanceId}`);

    return this._withRequestLock(requestId, () => this._hooked('commit:requestLocked', { requestId, acceptanceId },
      () => this._commitAllocation(acceptanceId, actorId)));
  }

  async _commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) return this._acceptedOutcome(acceptanceId);

    // A cancelled/completed request must never be allocated. Free the soft-lock
    // here too, in case cancellation was recorded but its cleanup is still queued.
    const blocking = this._terminalRequestStatus(lockEntry.requestId);
    if (blocking) {
      this._cancelEntry(lockEntry, `Request is ${blocking}`);
      throw new Error(`Request ${lockEntry.requestId} is ${blocking} and cannot be allocated.`);
    }
    // L4(a): past its expiry the lock cannot be accepted, even if its timer has not fired yet (MySQL compares
    // lock_expires_at with NOW()). The lock stays for the expiry path to release and fail over.
    if (Date.now() >= lockEntry.expiresAt) throw new LockRefusal(`Referral lock ${acceptanceId} has expired.`);
    // L3: only a case in MATCHING can be allocated (as on MySQL). Nothing is changed by a refusal.
    const req = db.emergencyRequests.find(r => r.request_id === lockEntry.requestId);
    if (req && req.status !== 'MATCHING') {
      throw new LockRefusal(`Request ${lockEntry.requestId} is ${req.status}; only a case in MATCHING can be allocated.`);
    }
    // L4(c): the soft-locked unit must still be there (locked >= 1, available >= locked). Corrupt counters are
    // refused before anything changes, on both backends, instead of being clamped silently.
    const corrupt = lockEntry.lockedResources.find(r => r.locked_capacity < 1 || r.available_capacity < r.locked_capacity);
    if (corrupt) throw new LockRefusal(this._corruptCapacityMessage(corrupt.resource_type, lockEntry.hospitalId, acceptanceId));

    clearInterval(lockEntry.countdownTimer);

    const { requestId, hospitalId, lockedResources } = lockEntry;

    // ACID atomic update
    lockedResources.forEach(resource => {
      // Atomic: committed_capacity = available - 1, locked -= 1 (validated above, so never below zero)
      resource.available_capacity -= 1;
      resource.locked_capacity    -= 1;
      resource.version_lock       += 1;

      // ResourceAllocation record
      db.resourceAllocations.push({
        allocation_id: `ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`,
        request_id:    requestId,
        hospital_id:   hospitalId,
        resource_id:   resource.resource_id,
        status:        'COMMITTED',
        stage_no:      lockEntry.stage ?? 1,
        allocated_at:  new Date().toISOString()
      });
    });

    // A reserved exclusive specialist becomes ASSIGNED to the accepted case (D3-B).
    const assignment = db.doctorAssignments.find(a => a.acceptance_id === acceptanceId && a.status === 'LOCKED');
    if (assignment) {
      assignment.status = 'COMMITTED';
      assignment.committed_at = new Date().toISOString();
      const doctor = db.doctors.find(d => d.doctor_id === assignment.doctor_id);
      if (doctor) doctor.availability_status = 'ASSIGNED';
    }

    // Update EmergencyRequest status
    if (req) {
      req.status = 'ALLOCATED';
      req.updated_at = new Date().toISOString();
    }

    // Prefer a unit stationed at the accepting facility. Only fall back to a
    // regional available unit when the destination has no local unit.
    // Batch 8 (P-0.3): the unit the admin chose at dispatch comes first, if it is still AVAILABLE.
    // Only units in the operating area (Dehradun): a unit whose known position is elsewhere is never sent (Batch 8 P-0).
    const preferred = req?.dispatch_ambulance_id ?? null;
    const usable = item => item.status === 'AVAILABLE' && unitInArea(item);
    const ambulance = (preferred && db.ambulances.find(item => usable(item) && item.ambulance_id === preferred))
      || db.ambulances.find(item => usable(item) && item.hospital_id === hospitalId)
      || db.ambulances.find(usable);
    if (ambulance) {
      ambulance.status = 'DISPATCHED';
      ambulance.assigned_request_id = requestId;
      ambulance.destination_hospital_id = hospitalId;
      ambulance.updated_at = new Date().toISOString();
    }

    // Update HospitalAcceptance
    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc) {
      acc.status = 'ACCEPTED';
      acc.responded_at = new Date().toISOString();
      acc.response_time_sec = SOFT_LOCK_TTL_MS / 1000 - this._remainingSec(lockEntry);
    }

    this._activeLocks.delete(acceptanceId);

    // The allocation is applied; from here on a failure must not be reported as a failed accept.
    this._afterApplied(`Committed ${acceptanceId}`, () => {
      db.auditLog({
        request_id: requestId,
        hospital_id: hospitalId,
        event_type: 'ALLOCATION_COMMITTED',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'ALLOCATED',
        actor_role: 'HOSPITAL_DESK',
        actor_id: actorId,
        metadata: { acceptanceId, ambulance_id: ambulance?.ambulance_id || null, specialist_id: assignment?.doctor_id ?? null }
      });
      db.persist?.();
    });

    const result = {
      acceptanceId,
      requestId,
      hospitalId,
      status: 'ACCEPTED',
      ambulance_id: ambulance?.ambulance_id || null,
      specialist_id: assignment?.doctor_id ?? null
    };
    this._afterApplied(`Committed ${acceptanceId}`, () => this.emit('allocation_committed', result));
    return result;
  }

  /**
   * Outcome of an already-accepted referral, for a retried accept whose first response was lost.
   * Only the referral that still holds the case's allocation qualifies; the ambulance is the case's
   * current on-road unit. Read-only: no allocation, assignment, audit entry or event.
   */
  _acceptedOutcome(acceptanceId) {
    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc?.status !== 'ACCEPTED') throw new Error(`No active lock found for acceptance ${acceptanceId}`);
    const { request_id: requestId, hospital_id: hospitalId } = acc;

    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    if (!['ALLOCATED', 'IN_TREATMENT'].includes(request?.status)) {
      throw new Error(`Referral ${acceptanceId} was accepted, but request ${requestId} is now ${request?.status}.`);
    }
    const holders = new Set(db.resourceAllocations
      .filter(a => a.request_id === requestId && a.status === 'COMMITTED').map(a => a.hospital_id));
    const otherAccepted = db.hospitalAcceptances
      .some(a => a.request_id === requestId && a.status === 'ACCEPTED' && a.acceptance_id !== acceptanceId);
    // A stage that holds no resources (e.g. a GENERAL case) has no allocation rows: then only another hospital holding
    // something disqualifies the replay (round 2, item 3).
    if (otherAccepted || [...holders].some(h => h !== hospitalId)) {
      throw new Error(`Referral ${acceptanceId} does not hold the allocation for request ${requestId}.`);
    }
    const unit = db.ambulances
      .filter(a => a.assigned_request_id === requestId && ON_ROAD_AMBULANCE_STATUSES.includes(a.status))
      .sort((a, b) => a.ambulance_id.localeCompare(b.ambulance_id))[0];
    const specialist = db.doctorAssignments.find(a => a.acceptance_id === acceptanceId && a.status === 'COMMITTED');
    return {
      acceptanceId, requestId, hospitalId, status: 'ACCEPTED', ambulance_id: unit?.ambulance_id || null,
      specialist_id: specialist?.doctor_id ?? null, replayed: true
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Release Lock — On REJECT, release soft-lock and failover
  // ─────────────────────────────────────────────────────────────────────────
  async rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock for ${acceptanceId}`);

    return this._withRequestLock(lockEntry.requestId, () => this._hooked('reject:requestLocked',
      { requestId: lockEntry.requestId, acceptanceId },
      () => this._rejectAndFailover(acceptanceId, rejectionReason, actorId)));
  }

  async _rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock for ${acceptanceId}`);

    clearInterval(lockEntry.countdownTimer);
    this._releaseSoftLocks(lockEntry);
    this._releaseReservation(lockEntry);

    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc) {
      acc.status = 'REJECTED';
      acc.rejection_reason = rejectionReason;
      acc.responded_at = new Date().toISOString();
    }

    this._activeLocks.delete(acceptanceId);
    // Only now: the hospital's state is built from _activeLocks, so re-evaluating before the delete would count
    // the released units twice (held by the rejected lock AND back in Available), as expiry/cancel already avoid.
    this.refreshSafety(lockEntry.hospitalId, { onlyIfUnsafe: true, cause: 'release' });
    // As on MySQL (L4-d): the case is re-queued and the rejection recorded BEFORE the failover, with the same
    // event name, states and metadata; the failover's own LOCK_ACQUIRED follows it.
    this._requeue(lockEntry.requestId);
    this._afterApplied(`Rejected ${acceptanceId}`, () => {
      db.auditLog({
        request_id: lockEntry.requestId,
        hospital_id: lockEntry.hospitalId,
        event_type: 'LOCK_REJECTED',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'REJECTED',
        actor_role: 'HOSPITAL_DESK',
        actor_id: actorId,
        metadata: { acceptanceId, rejectionReason }
      });
      db.persist?.();
    });
    const nextLock = await this._tryFailover(lockEntry);

    const result = {
      acceptanceId,
      requestId: lockEntry.requestId,
      hospitalId: lockEntry.hospitalId,
      status: 'REJECTED',
      next_acceptance_id: nextLock?.acceptanceId || null,
      next_hospital_id: nextLock?.hospitalId || null
    };
    this._afterApplied(`Rejected ${acceptanceId}`, () => this.emit('lock_released', result));
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-08: TTL Expiry Background Worker
  // ─────────────────────────────────────────────────────────────────────────
  async _handleTimeout(lockRecord) {
    return this._withRequestLock(lockRecord.requestId, () => this._hooked('expire:requestLocked',
      { requestId: lockRecord.requestId, acceptanceId: lockRecord.acceptanceId },
      () => this._handleTimeoutLocked(lockRecord)));
  }

  async _handleTimeoutLocked(lockRecord) {
    // Claim the lock exactly once: if a commit, rejection or cancellation got
    // here first the entry is gone and there is nothing left to release.
    const entry = this._activeLocks.get(lockRecord.acceptanceId);
    if (!entry) return;
    this._activeLocks.delete(lockRecord.acceptanceId);
    clearInterval(entry.countdownTimer);
    this._releaseSoftLocksRaw(entry.lockedResources);
    this._releaseReservation(entry);
    this.refreshSafety(entry.hospitalId, { onlyIfUnsafe: true, cause: 'release' });

    this._expireAcceptance(lockRecord.requestId, lockRecord.hospitalId, lockRecord.acceptanceId);
    const nextLock = await this._tryFailover(lockRecord);
    this._emitExpired(lockRecord, nextLock);
  }

  /** Mark an acceptance EXPIRED, re-queue its case and record it: the same rows, order and audit entry as MySQL. */
  _expireAcceptance(requestId, hospitalId, acceptanceId) {
    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc) {
      acc.status = 'EXPIRED';
      acc.responded_at = new Date().toISOString();
      acc.response_time_sec = 90;
    }
    this._requeue(requestId);
    this._afterApplied(`Expired ${acceptanceId}`, () => {
      db.auditLog({
        request_id: requestId,
        hospital_id: hospitalId,
        event_type: 'LOCK_TTL_EXPIRED_FAILOVER',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'EXPIRED',
        actor_role: 'SYSTEM',
        metadata: { acceptanceId }
      });
      db.persist?.();
    });
  }

  _emitExpired({ acceptanceId, requestId, hospitalId }, nextLock) {
    this._afterApplied(`Expired ${acceptanceId}`, () => this.emit('lock_expired', {
      acceptanceId, requestId, hospitalId,
      nextAcceptanceId: nextLock?.acceptanceId || null,
      nextHospitalId: nextLock?.hospitalId || null
    }));
  }

  async expireLock(acceptanceId) {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (lockEntry) {
      await this._handleTimeout(lockEntry);
      return true;
    }

    // A PENDING record with no live lock (e.g. one left behind by a crash). As on MySQL: once its expiry has
    // passed it is expired under the case lock, the case re-queued and failed over; before that, nothing happens.
    // (Memory keeps no per-referral record of soft-locked units without the live lock, so there is nothing to give back.)
    const requestId = db.hospitalAcceptances.find(item => item.acceptance_id === acceptanceId)?.request_id;
    if (!requestId) return false;
    const expired = await this._withRequestLock(requestId, () => this._hooked('expire:requestLocked', { requestId, acceptanceId }, () => {
      if (this._activeLocks.has(acceptanceId)) return null; // a live lock appeared: the normal path handles it
      const acceptance = db.hospitalAcceptances.find(item => item.acceptance_id === acceptanceId);
      if (acceptance?.status !== 'PENDING' || Date.now() < new Date(acceptance.lock_expires_at).getTime()) return null;
      this._expireAcceptance(requestId, acceptance.hospital_id, acceptanceId);
      return this._tryFailover({ acceptanceId, requestId, hospitalId: acceptance.hospital_id, resourceTypes: this._currentStageTypes(requestId) })
        .then(nextLock => ({ hospitalId: acceptance.hospital_id, nextLock }));
    }));
    if (!expired) return false;
    this._emitExpired({ acceptanceId, requestId, hospitalId: expired.hospitalId }, expired.nextLock);
    return true;
  }

  /** The physical types of the case's CURRENT stage (as MySQL's failover uses the types the ended referral held). */
  _currentStageTypes(requestId) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    const legacyTypes = [...(request?.required_resource_types ?? request?.required_resources ?? [])];
    const stages = this._claimOf(requestId) ?? singleStageClaim(legacyTypes, request?.required_specialist ?? null);
    return physicalTypes(stageOf(stages, request?.current_stage ?? 1));
  }

  /**
   * Put a case whose pending referral just ended back in the queue (MATCHING -> WAITING), before its failover, as
   * MySQL's _requeue does in the releasing transaction. Only an acquire moves a case to MATCHING; a terminal or
   * allocated case is left untouched. Synchronous; the caller holds the request lock.
   */
  _requeue(requestId) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    if (request?.status === 'MATCHING') {
      request.status = 'WAITING';
      request.updated_at = new Date().toISOString();
    }
  }

  /**
   * Recovery (as MySQL's requeueStrandedRequests): a case is MATCHING only while it has a pending referral. One
   * without is put back in the queue, re-checked under its request lock. Returns how many moved.
   */
  async requeueStrandedRequests() {
    const hasPending = requestId => db.hospitalAcceptances.some(a => a.request_id === requestId && a.status === 'PENDING')
      || [...this._activeLocks.values()].some(lock => lock.requestId === requestId);
    const stranded = db.emergencyRequests.filter(r => r.status === 'MATCHING' && !hasPending(r.request_id)).map(r => r.request_id);
    // Test-only pause point between the unlocked scan and the per-case re-check (no-op unless a test installs it).
    if (this.hooks.active('stranded:scanned')) await this.hooks.run('stranded:scanned', { backend: 'memory', requestIds: stranded });
    let moved = 0;
    for (const requestId of stranded) {
      try {
        const requeued = await this._withRequestLock(requestId, async () => {
          const request = db.emergencyRequests.find(r => r.request_id === requestId);
          if (request?.status !== 'MATCHING' || hasPending(requestId)) return false;
          this._requeue(requestId);
          this._afterApplied(`Re-queued ${requestId}`, () => {
            db.auditLog({ request_id: requestId, event_type: 'STRANDED_MATCHING_REQUEUED', previous_state: 'MATCHING', new_state: 'WAITING', actor_role: 'SYSTEM' });
            db.persist?.();
          });
          return true;
        });
        if (requeued) moved += 1;
      } catch (err) {
        console.error(`[LOCK] Failed to re-queue ${requestId}:`, err.message);
      }
    }
    return moved;
  }

  /**
   * Choose the next suitable facility after a rejection or timeout. The selection happens on the server, not from a
   * client-supplied hospital ID. Same policy as MySQL's _failoverAfterCommit (L4-b): the release is already applied,
   * so a failover failure never fails the rejection/expiry; it is logged and the case stays queued (WAITING).
   */
  async _tryFailover(lockEntry) {
    try {
      return await this._failover(lockEntry);
    } catch (err) {
      console.error(`[LOCK] Failover for ${lockEntry.requestId} failed; the case stays queued:`, err.message);
      this._requeue(lockEntry.requestId);
      return null;
    }
  }

  async _failover(lockEntry) {
    const request = db.emergencyRequests.find(r => r.request_id === lockEntry.requestId);
    if (!request) return null; // Synthetic IDs are used by low-level unit tests.
    // Never revive a request that was cancelled, completed or otherwise moved on
    // (e.g. already allocated) while this referral was pending.
    if (!MATCHING_REQUEST_STATES.includes(request.status)) return null;

    const attemptedHospitals = new Set(
      db.hospitalAcceptances
        .filter(acceptance => acceptance.request_id === lockEntry.requestId)
        .map(acceptance => acceptance.hospital_id)
    );

    const candidates = db.hospitals
      .filter(h => !attemptedHospitals.has(h.hospital_id) && h.emergency_status !== 'CLOSED')
      .filter(h => {
        const resourcesAvailable = lockEntry.resourceTypes.every(type => {
          const resource = db.medicalResources.find(
            item => item.hospital_id === h.hospital_id && item.resource_type === type
          );
          return resource && resource.available_capacity - resource.locked_capacity > 0;
        });
        if (!resourcesAvailable) return false;
        if (!request.required_specialist) return true;
        return db.doctors.some(doctor => doctor.hospital_id === h.hospital_id
          && doctor.specialization === request.required_specialist
          && doctor.availability_status === 'AVAILABLE');
      })
      .sort((a, b) => (b.acceptance_rate - a.acceptance_rate) || (a.avg_response_sec - b.avg_response_sec));

    // The failover referral belongs to whoever sent the one it replaces (B1-R1: they are notified about it).
    const initiatedBy = db.hospitalAcceptances.find(a => a.acceptance_id === lockEntry.acceptanceId)?.initiated_by ?? null;
    let firstUnsafe = null;
    for (const candidate of candidates) {
      try {
        // Callers already hold the request-scoped lock, so use the unlocked
        // variant; re-entering _withRequestLock would deadlock on itself.
        // The acquire itself marks the case MATCHING (L1).
        return await this._acquireSoftLock(
          candidate.hospital_id,
          lockEntry.requestId,
          lockEntry.resourceTypes,
          { initiatedBy }
        );
      } catch (err) {
        // A business refusal (a concurrent request claimed this candidate, it is unsafe, the case changed): try
        // the next. Anything else (a mutex timeout, a bug) stops the failover, as on MySQL (L4-b).
        if (!(err instanceof LockRefusal)) throw err;
        if (err.code === 'UNSAFE') {
          this.recordUnsafeRefusal(lockEntry.requestId, candidate.hospital_id, err.safety);
          firstUnsafe ??= err.safety;
        }
      }
    }

    // Nobody can take it: the case is already WAITING (re-queued by the caller), as on MySQL.
    this._requeue(lockEntry.requestId);
    // D4-a3/a4: nobody can admit it safely -> an alert and an audit event, no automatic action.
    if (firstUnsafe) {
      this._afterApplied(`Escalation for ${lockEntry.requestId}`, () => {
        db.auditLog({
          request_id: lockEntry.requestId, hospital_id: firstUnsafe.hospital_id, event_type: 'ADMISSION_ESCALATED',
          previous_state: request.status, new_state: request.status, actor_role: 'SYSTEM',
          metadata: { reason: 'NO_SAFE_HOSPITAL', safety: firstUnsafe }
        });
        this._alert({ hospital_id: null, request_id: lockEntry.requestId, alert_type: 'SYSTEM',
          message: `ESCALATION: no hospital can admit ${lockEntry.requestId} safely; blocked at ${firstUnsafe.hospital_id}. ${firstUnsafe.explanation}` });
      });
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel every pending referral for a request that is being CANCELLED or
  // COMPLETED. Releases soft-locks and never triggers failover.
  // ─────────────────────────────────────────────────────────────────────────
  async cancelPendingForRequest(requestId, reason = 'Request cancelled') {
    return this._withRequestLock(requestId, () => this._hooked('cancel:requestLocked', { requestId },
      async () => this.cancelPendingLocked(requestId, reason)));
  }

  /**
   * The body of cancelPendingForRequest for a caller that ALREADY holds the request lock (a lifecycle transition,
   * L2); taking it again would wait for itself. Synchronous.
   */
  cancelPendingLocked(requestId, reason = 'Request cancelled') {
    const cancelled = [];
    const failures = [];
    for (const entry of [...this._activeLocks.values()].filter(lock => lock.requestId === requestId)) {
      // One failing entry must not strand the others' capacity.
      try {
        if (this._cancelEntry(entry, reason)) cancelled.push(entry.acceptanceId);
      } catch (err) {
        failures.push(`${entry.acceptanceId}: ${err.message}`);
      }
    }
    // Pending records with no live lock (e.g. left by an earlier crash) are closed too.
    db.hospitalAcceptances
      .filter(a => a.request_id === requestId && a.status === 'PENDING')
      .forEach(a => {
        a.status = 'CANCELLED';
        a.rejection_reason = reason;
        a.responded_at = new Date().toISOString();
      });
    if (cancelled.length) db.persist?.();
    if (failures.length) {
      // Surface the failure to the caller. Any lock left behind cannot be
      // committed (terminal-state guards) and is released by its 90s TTL.
      throw new Error(`Pending lock cleanup failed for request ${requestId}: ${failures.join('; ')}`);
    }
    return cancelled;
  }

  /** Run `operation` holding the case's request lock (store-level lifecycle transitions, L2). */
  withRequestLock(requestId, operation) {
    return this._withRequestLock(requestId, operation);
  }

  /**
   * Tear down one active lock. The delete() acts as the claim: whichever of
   * timeout / commit / reject / cancel runs first wins, so capacity is never
   * released twice and the timer is always cleared.
   */
  _cancelEntry(entry, reason) {
    if (!this._activeLocks.delete(entry.acceptanceId)) return false;
    clearInterval(entry.countdownTimer);
    this._releaseSoftLocksRaw(entry.lockedResources);
    this._releaseReservation(entry);
    this.refreshSafety(entry.hospitalId, { onlyIfUnsafe: true, cause: 'release' });

    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === entry.acceptanceId);
    if (acc) {
      acc.status = 'CANCELLED';
      acc.rejection_reason = reason;
      acc.responded_at = new Date().toISOString();
    }

    // Capacity is already released and the lock removed. A failing audit write or
    // event listener must not abort the caller halfway, so report it loudly instead.
    this._afterApplied(`Cancelled ${entry.acceptanceId}`, () => {
      db.auditLog({
        request_id: entry.requestId,
        hospital_id: entry.hospitalId,
        event_type: 'LOCK_CANCELLED',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'CANCELLED', // as MySQL's _cancelAcceptance
        actor_role: 'SYSTEM',
        metadata: { acceptanceId: entry.acceptanceId, reason }
      });

      this.emit('lock_released', {
        acceptanceId: entry.acceptanceId,
        requestId: entry.requestId,
        hospitalId: entry.hospitalId,
        status: 'CANCELLED',
        reason
      });
    });
    return true;
  }

  /**
   * Run audit / persistence / notification work for a state change that is already
   * applied. Failing here must neither undo nor misreport that change, so log it.
   */
  _afterApplied(label, step) {
    try {
      step();
    } catch (err) {
      console.error(`[LOCK] ${label} but audit/notification failed:`, err.message);
    }
  }

  // The per-lock countdown counter lives on a different object than the stored entry,
  // so derive the remaining time from the absolute expiry instead.
  _corruptCapacityMessage(resourceType, hospitalId, acceptanceId) {
    return `Capacity of ${resourceType} at ${hospitalId} is inconsistent (no soft-locked unit to commit); referral ${acceptanceId} cannot be accepted.`;
  }

  _remainingSec(entry) {
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  _terminalRequestStatus(requestId) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    return request && TERMINAL_REQUEST_STATES.includes(request.status) ? request.status : null;
  }

  // L1: only a case still looking for a facility (NEW / WAITING / MATCHING) may receive a referral, as on MySQL.
  // An ALLOCATED or IN_TREATMENT case is refused here, not only by the route's pre-check.
  _assertRequestAllocatable(requestId) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    if (request && !MATCHING_REQUEST_STATES.includes(request.status)) {
      throw new LockRefusal(`Request ${requestId} is ${request.status} and cannot receive a referral.`);
    }
  }

  // A referral may only target an open hospital that has the case's required specialist on duty.
  // The route pre-checks this too, but only this check runs where nothing can interleave.
  _assertHospitalEligible(hospitalId, requestId) {
    const hospital = db.hospitals.find(h => h.hospital_id === hospitalId);
    if (hospital?.emergency_status === 'CLOSED') {
      throw new LockRefusal(`Hospital ${hospitalId} is CLOSED and cannot receive a referral.`);
    }
    const specialist = db.emergencyRequests.find(r => r.request_id === requestId)?.required_specialist;
    if (specialist && !db.doctors.some(d => d.hospital_id === hospitalId
      && d.specialization === specialist && d.availability_status === 'AVAILABLE')) {
      throw new LockRefusal(`Required specialist ${specialist} is not available at ${hospitalId}.`);
    }
  }

  _releaseSoftLocks(lockEntry) {
    this._releaseSoftLocksRaw(lockEntry.lockedResources);
  }

  /** Give back the exclusive specialist reserved by a pending referral (no-op if none). Synchronous. */
  _releaseReservation(entry) {
    const assignment = db.doctorAssignments.find(a => a.acceptance_id === entry.acceptanceId && a.status === 'LOCKED');
    if (!assignment) return null;
    assignment.status = 'RELEASED';
    assignment.released_at = new Date().toISOString();
    const doctor = db.doctors.find(d => d.doctor_id === assignment.doctor_id);
    if (doctor?.availability_status === 'RESERVED') doctor.availability_status = 'AVAILABLE';
    return assignment.doctor_id;
  }

  _releaseSoftLocksRaw(resources) {
    resources.forEach(resource => {
      if (resource.locked_capacity > 0) {
        resource.locked_capacity -= 1;
        resource.version_lock += 1;
      }
    });
  }

  // ── Claims and the Banker's state (Phase 3 Step 4) ─────────────────────────
  /** The case's recorded claim, or null for a case without one (legacy single stage). */
  _claimOf(requestId) {
    return claimFromRows((db.requestClaims || []).filter(c => c.request_id === requestId));
  }

  /** One hospital's Banker's state (synchronous: call it where nothing can interleave). */
  _hospitalState(hospitalId) {
    const held = new Map();
    const add = (id, type) => {
      if (!held.has(id)) held.set(id, {});
      held.get(id)[type] = (held.get(id)[type] || 0) + 1;
    };
    for (const entry of this._activeLocks.values()) {
      if (entry.hospitalId === hospitalId) for (const r of entry.lockedResources ?? []) add(entry.requestId, r.resource_type);
    }
    for (const a of db.resourceAllocations) {
      if (a.hospital_id !== hospitalId || a.status !== 'COMMITTED') continue;
      const type = db.medicalResources.find(r => r.resource_id === a.resource_id)?.resource_type;
      if (type) add(a.request_id, type);
    }
    for (const a of db.doctorAssignments) {
      if (a.hospital_id !== hospitalId || !['LOCKED', 'COMMITTED'].includes(a.status)) continue;
      const spec = db.doctors.find(d => d.doctor_id === a.doctor_id)?.specialization;
      if (spec) add(a.request_id, spec);
    }
    const specialistsAvailable = Object.fromEntries(EXCLUSIVE_SPECIALISTS.map(s => [s,
      db.doctors.filter(d => d.hospital_id === hospitalId && d.specialization === s && d.availability_status === 'AVAILABLE').length]));
    return buildHospitalState({
      resources: db.medicalResources.filter(r => r.hospital_id === hospitalId),
      specialistsAvailable,
      cases: [...held.keys()].map(id => ({
        id, stages: this._claimOf(id),
        currentStage: db.emergencyRequests.find(r => r.request_id === id)?.current_stage ?? 1,
        held: held.get(id)
      }))
    });
  }

  _refusal(decision, hospitalId) {
    const err = new LockRefusal(`${hospitalId}: ${decision.explanation}`,
      decision.reason === 'UNSAFE' || decision.reason === 'HOSPITAL_UNSAFE' ? 'UNSAFE' : null);
    err.safety = { hospital_id: hospitalId, ...summarize(decision) };
    return err;
  }

  /** Audit a safety refusal on the case (D4-a3/a5). */
  recordUnsafeRefusal(requestId, hospitalId, safety) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    if (!request) return;
    this._afterApplied(`Unsafe refusal of ${requestId}`, () => db.auditLog({
      request_id: requestId, hospital_id: hospitalId, event_type: 'ADMISSION_REFUSED_UNSAFE',
      previous_state: request.status, new_state: request.status, actor_role: 'SYSTEM', metadata: { safety }
    }));
  }

  _alert({ hospital_id, request_id, alert_type, message }) {
    db.alerts.push({
      alert_id: db.alerts.length + 1, hospital_id, request_id, alert_type, message: String(message).slice(0, 500),
      status: 'UNREAD', created_at: new Date().toISOString()
    });
  }

  /**
   * Re-evaluate a hospital and record a change of its SAFE/UNSAFE flag (D5-A): UNSAFE_STATE + an alert, or
   * SAFE_STATE_RESTORED. Synchronous. With onlyIfUnsafe it does nothing for a hospital flagged SAFE.
   */
  refreshSafety(hospitalId, { onlyIfUnsafe = false, actor = { role: 'SYSTEM', id: null }, cause = null } = {}) {
    const hospital = db.hospitals.find(h => h.hospital_id === hospitalId);
    if (!hospital) return null;
    const current = hospital.safety_state ?? 'SAFE';
    if (onlyIfUnsafe && current !== 'UNSAFE') return null;
    const report = evaluateHospital(this._hospitalState(hospitalId));
    const next = report.safe ? 'SAFE' : 'UNSAFE';
    if (next !== current) {
      hospital.safety_state = next;
      this._afterApplied(`Safety flag of ${hospitalId}`, () => {
        db.auditLog({
          request_id: null, hospital_id: hospitalId, event_type: next === 'UNSAFE' ? 'UNSAFE_STATE' : 'SAFE_STATE_RESTORED',
          previous_state: current, new_state: next, actor_role: actor.role, actor_id: actor.id,
          metadata: { cause, explanation: report.explanation, unfinished: report.unfinished, available: report.available }
        });
        if (next === 'UNSAFE') this._alert({ hospital_id: hospitalId, request_id: null, alert_type: 'RESOURCE_CRITICAL', message: `UNSAFE_STATE at ${hospitalId}: ${report.explanation}` });
      });
    }
    return { ...report, safety_state: next, changed: next !== current };
  }

  getHospitalSafety(hospitalId) {
    const hospital = db.hospitals.find(h => h.hospital_id === hospitalId);
    if (!hospital) return null;
    return { hospital_id: hospitalId, safety_state: hospital.safety_state ?? 'SAFE', ...evaluateHospital(this._hospitalState(hospitalId)) };
  }

  // ── Stage advance (D2-a6/a7/a9) ────────────────────────────────────────────
  async advanceStage(requestId, actor = { role: 'ADMIN', id: null }) {
    return this._withRequestLock(requestId, () => this._hooked('advance:requestLocked', { requestId },
      () => this._advanceStage(requestId, actor)));
  }

  async _advanceStage(requestId, actor) {
    const notFound = () => Object.assign(new Error(`Emergency request ${requestId} not found.`), { code: 'NOT_FOUND' });
    const check = () => {
      const request = db.emergencyRequests.find(r => r.request_id === requestId);
      if (!request) throw notFound();
      if (!['ALLOCATED', 'IN_TREATMENT'].includes(request.status)) {
        throw new Error(`Request ${requestId} is ${request.status}; only an allocated case can advance its treatment stage.`);
      }
      const stages = this._claimOf(requestId);
      const from = request.current_stage ?? 1;
      if (!stages || !stageOf(stages, from + 1)) throw new Error(`Request ${requestId} has no stage ${from + 1} in its claim.`);
      const accepted = db.hospitalAcceptances.filter(a => a.request_id === requestId && a.status === 'ACCEPTED').at(-1);
      if (!accepted) throw new Error(`Request ${requestId} has no accepted referral.`);
      return { request, stages, from, to: from + 1, hospitalId: accepted.hospital_id };
    };
    const first = check();
    const releaseFns = [];
    try {
      releaseFns.push(await db.acquireHospitalLock(first.hospitalId, 3000));
      if (this.hooks.active('advance:hospitalLocked')) {
        await this.hooks.run('advance:hospitalLocked', { backend: 'memory', requestId, hospitalId: first.hospitalId });
      }
      // Lock every resource type either stage uses (sorted), then re-check: a transition may have moved the case meanwhile.
      const types = [...new Set([...physicalTypes(stageOf(first.stages, first.from)), ...physicalTypes(stageOf(first.stages, first.to))])].sort();
      for (const type of types) {
        const r = db.medicalResources.find(x => x.hospital_id === first.hospitalId && x.resource_type === type);
        if (r) releaseFns.push(await db.acquireResourceLock(r.resource_id, 3000));
      }
      const { request, stages, from, to, hospitalId } = check(); // synchronous from here on
      if (from !== first.from || hospitalId !== first.hospitalId) throw new Error(`Request ${requestId} changed while waiting; please retry.`);
      const next = stageOf(stages, to);
      const wants = next.units;
      const committed = db.resourceAllocations
        .filter(a => a.request_id === requestId && a.hospital_id === hospitalId && a.status === 'COMMITTED')
        .map(a => ({ allocation: a, resource: db.medicalResources.find(r => r.resource_id === a.resource_id) }))
        .sort((a, b) => a.resource.resource_type.localeCompare(b.resource.resource_type));
      const kept = {};
      const releaseAllocations = committed.filter(({ resource }) => {
        kept[resource.resource_type] = (kept[resource.resource_type] || 0) + 1;
        return kept[resource.resource_type] > (wants[resource.resource_type] || 0);
      });
      const assigned = db.doctorAssignments.filter(a => a.request_id === requestId && a.hospital_id === hospitalId && a.status === 'COMMITTED')
        .map(a => ({ assignment: a, doctor: db.doctors.find(d => d.doctor_id === a.doctor_id) }));
      const releaseDoctors = assigned.filter(({ doctor }) => !wants[doctor?.specialization]);
      const acquireTypes = physicalTypes(next).filter(t => (kept[t] || 0) < wants[t]);
      const newSpecialist = exclusiveSpecialistOf(next);
      const newDoctor = newSpecialist && !assigned.some(({ doctor }) => doctor?.specialization === newSpecialist)
        ? db.doctors.filter(d => d.hospital_id === hospitalId && d.specialization === newSpecialist && d.availability_status === 'AVAILABLE')
          .sort((a, b) => a.doctor_id.localeCompare(b.doctor_id))[0] || 'MISSING'
        : null;

      const release = {};
      for (const { resource } of releaseAllocations) release[resource.resource_type] = (release[resource.resource_type] || 0) + 1;
      for (const { doctor } of releaseDoctors) release[doctor.specialization] = (release[doctor.specialization] || 0) + 1;
      let decision = advanceDecision(this._hospitalState(hospitalId), { id: requestId, stages, toStage: to, release });
      const missing = acquireTypes.find(t => !db.medicalResources.some(r => r.hospital_id === hospitalId && r.resource_type === t)) ?? (newDoctor === 'MISSING' ? newSpecialist : null);
      if (decision.granted && missing) decision = { ...decision, granted: false, reason: 'INSUFFICIENT', explanation: `Refused: ${missing} is not available at ${hospitalId}.` };
      if (!decision.granted) {
        const err = this._refusal(decision, hospitalId);
        this._afterApplied(`Stage advance refused for ${requestId}`, () => db.auditLog({
          request_id: requestId, hospital_id: hospitalId, event_type: 'STAGE_ADVANCE_REFUSED', previous_state: `STAGE_${from}`, new_state: `STAGE_${from}`,
          actor_role: actor.role, actor_id: actor.id, metadata: { from, to, safety: err.safety }
        }));
        throw err;
      }

      const now = new Date().toISOString();
      for (const { allocation, resource } of releaseAllocations) {
        allocation.status = 'RELEASED';
        allocation.released_at = now;
        resource.available_capacity = Math.min(resource.available_capacity + 1, resource.total_capacity);
        resource.version_lock += 1;
      }
      for (const type of acquireTypes) {
        const resource = db.medicalResources.find(r => r.hospital_id === hospitalId && r.resource_type === type);
        resource.available_capacity -= 1;
        resource.version_lock += 1;
        db.resourceAllocations.push({
          allocation_id: `ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`, request_id: requestId, hospital_id: hospitalId,
          resource_id: resource.resource_id, status: 'COMMITTED', stage_no: to, allocated_at: now
        });
      }
      for (const { assignment, doctor } of releaseDoctors) {
        assignment.status = 'RELEASED';
        assignment.released_at = now;
        if (doctor && ['ASSIGNED', 'IN_PROCEDURE'].includes(doctor.availability_status)) doctor.availability_status = 'AVAILABLE';
      }
      if (newDoctor && newDoctor !== 'MISSING') {
        newDoctor.availability_status = request.status === 'IN_TREATMENT' ? 'IN_PROCEDURE' : 'ASSIGNED';
        db.doctorAssignments.push({
          assignment_id: `DA-${uuidv4().slice(0, 8).toUpperCase()}`, doctor_id: newDoctor.doctor_id, request_id: requestId, hospital_id: hospitalId,
          acceptance_id: null, stage_no: to, status: 'COMMITTED', reserved_at: now, committed_at: now, released_at: null
        });
      }
      request.current_stage = to;
      request.updated_at = now;
      const result = {
        requestId, hospitalId, previous_stage: from, current_stage: to,
        released: releaseAllocations.map(({ resource }) => resource.resource_type), allocated: acquireTypes,
        released_specialists: releaseDoctors.map(({ assignment }) => assignment.doctor_id),
        assigned_specialist: newDoctor && newDoctor !== 'MISSING' ? newDoctor.doctor_id : null
      };
      this.refreshSafety(hospitalId, { onlyIfUnsafe: true, cause: 'stage advance' });
      this._afterApplied(`Stage advanced for ${requestId}`, () => {
        db.auditLog({
          request_id: requestId, hospital_id: hospitalId, event_type: 'STAGE_ADVANCED', previous_state: `STAGE_${from}`, new_state: `STAGE_${to}`,
          actor_role: actor.role, actor_id: actor.id, metadata: { ...result, safetySequence: decision.safety.sequence }
        });
        db.persist?.();
      });
      this._afterApplied(`Stage advanced for ${requestId}`, () => this.emit('stage_advanced', result));
      return result;
    } finally {
      releaseFns.reverse().forEach(fn => fn());
    }
  }

  getActiveLocks() {
    const result = [];
    for (const [id, entry] of this._activeLocks) {
      result.push({
        acceptanceId: id,
        requestId:    entry.requestId,
        hospitalId:   entry.hospitalId,
        remainingSec: this._remainingSec(entry),
        status:       entry.status,
        resourceTypes: entry.resourceTypes
      });
    }
    return result;
  }

  async _withRequestLock(requestId, operation) {
    const previous = this._requestLocks.get(requestId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this._requestLocks.set(requestId, queued);

    await previous;
    try {
      // Lock-order checking (tests / harness only) keeps the original path when not installed.
      if (!memoryLockOrderActive()) return await operation();
      return await runInLockScope(`request ${requestId}`, async () => {
        noteLockAcquired('EmergencyRequest', requestId);
        try {
          return await operation();
        } finally {
          noteLockReleased('EmergencyRequest', requestId);
        }
      });
    } finally {
      release();
      if (this._requestLocks.get(requestId) === queued) this._requestLocks.delete(requestId);
    }
  }

  _toPublicLock(lockRecord) {
    return {
      acceptanceId: lockRecord.acceptanceId,
      requestId: lockRecord.requestId,
      hospitalId: lockRecord.hospitalId,
      resourceIds: lockRecord.resourceIds,
      resourceTypes: lockRecord.resourceTypes,
      specialistId: lockRecord.specialistId ?? null,
      expiresAt: lockRecord.expiresAt,
      remainingSec: lockRecord.remainingSec,
      status: lockRecord.status
    };
  }
}

export const lockingEngine = new LockingEngine();
export default lockingEngine;
