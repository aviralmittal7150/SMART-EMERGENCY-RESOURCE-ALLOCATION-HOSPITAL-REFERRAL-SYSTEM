// server/services/lockingEngine.js
// OS-Grade Concurrency & Mutual Exclusion Engine
// Implements soft-locks with 90-second TTL and atomic commit semantics

import { EventEmitter } from 'events';
import { db } from '../db/seed.js';
import { v4 as uuidv4 } from 'uuid';

const SOFT_LOCK_TTL_MS = 90_000; // 90 seconds
const TERMINAL_REQUEST_STATES = ['CANCELLED', 'COMPLETED'];
// Only requests still looking for a facility may receive (or fail over to) a referral.
const MATCHING_REQUEST_STATES = ['NEW', 'WAITING', 'MATCHING'];

class LockingEngine extends EventEmitter {
  constructor() {
    super();
    // Map of resourceId -> { acceptanceId, requestId, hospitalId, expiresAt, timerId }
    this._activeLocks = new Map();
    // Referral initiation and commitment are request-scoped critical sections.
    // Resource mutexes alone are insufficient because a request can reserve
    // different hospitals concurrently before either acceptance is recorded.
    this._requestLocks = new Map();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Acquire Soft Lock — Simulates SELECT ... FOR UPDATE with TTL
  // Implements mutual exclusion: only one lock per resource at a time
  // ─────────────────────────────────────────────────────────────────────────
  async acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED']) {
    return this._withRequestLock(requestId, () => this._acquireSoftLock(hospitalId, requestId, resourceTypes));
  }

  async _acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED']) {
    const releaseFns = [];
    const lockedResources = [];
    const normalizedTypes = [...new Set(resourceTypes.map(type => String(type).trim().toUpperCase()))].sort();

    if (normalizedTypes.some(type => !['ICU_BED', 'VENTILATOR', 'OT'].includes(type))) {
      throw new Error('Unsupported resource type requested.');
    }

    this._assertRequestAllocatable(requestId);

    const duplicateRequest = [...this._activeLocks.values()].find(lock => lock.requestId === requestId);
    if (duplicateRequest) {
      throw new Error(`Request ${requestId} already has an active referral lock.`);
    }

    let lockRecord;
    try {
      for (const rType of normalizedTypes) {
        const resource = db.medicalResources.find(
          r => r.hospital_id === hospitalId && r.resource_type === rType
        );

        if (!resource) throw new Error(`Resource ${rType} not found for hospital ${hospitalId}`);

        // Acquire OS mutex (SELECT ... FOR UPDATE simulation)
        const releaseLock = await db.acquireResourceLock(resource.resource_id, 3000);
        releaseFns.push(releaseLock);

        // available_capacity is the committed inventory. locked_capacity is a
        // subset reserved by pending handshakes, so both must be considered
        // while the row mutex is held.
        if (resource.available_capacity - resource.locked_capacity <= 0) {
          throw new Error(`No available ${rType} at ${hospitalId}`);
        }

        // Optimistic version check (prevents dirty reads)
        const expectedVersion = resource.version_lock;

        // Soft-lock: decrement available, increment locked
        resource.locked_capacity += 1;
        resource.version_lock = expectedVersion + 1;
        lockedResources.push(resource);
      }

      // Waiting for the row mutexes can yield for real time, during which the
      // request may have been cancelled/completed. Re-check now that nothing
      // can interleave before the lock is registered; the catch block rolls back.
      this._assertRequestAllocatable(requestId);

      const acceptanceId = `ACC-${uuidv4().slice(0, 8).toUpperCase()}`;
      const expiresAt = Date.now() + SOFT_LOCK_TTL_MS;

      lockRecord = {
        acceptanceId,
        requestId,
        hospitalId,
        resourceIds: lockedResources.map(r => r.resource_id),
        resourceTypes: normalizedTypes,
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
        created_at: new Date().toISOString()
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
        previous_state: 'WAITING',
        new_state: 'PENDING_ACCEPTANCE',
        actor_role: 'SYSTEM',
        metadata: { acceptanceId, resourceIds: lockRecord.resourceIds }
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
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock found for acceptance ${acceptanceId}`);

    return this._withRequestLock(lockEntry.requestId, () => this._commitAllocation(acceptanceId, actorId));
  }

  async _commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock found for acceptance ${acceptanceId}`);

    // A cancelled/completed request must never be allocated. Free the soft-lock
    // here too, in case cancellation was recorded but its cleanup is still queued.
    const blocking = this._terminalRequestStatus(lockEntry.requestId);
    if (blocking) {
      this._cancelEntry(lockEntry, `Request is ${blocking}`);
      throw new Error(`Request ${lockEntry.requestId} is ${blocking} and cannot be allocated.`);
    }

    clearInterval(lockEntry.countdownTimer);

    const { requestId, hospitalId, lockedResources } = lockEntry;

    // ACID atomic update
    lockedResources.forEach(resource => {
      const releaseFn = lockEntry.releaseFns.shift();
      // Atomic: committed_capacity = available - 1, locked -= 1
      resource.available_capacity = Math.max(0, resource.available_capacity - 1);
      resource.locked_capacity    = Math.max(0, resource.locked_capacity - 1);
      resource.version_lock       += 1;

      // ResourceAllocation record
      db.resourceAllocations.push({
        allocation_id: `ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`,
        request_id:    requestId,
        hospital_id:   hospitalId,
        resource_id:   resource.resource_id,
        status:        'COMMITTED',
        allocated_at:  new Date().toISOString()
      });
    });

    // Update EmergencyRequest status
    const req = db.emergencyRequests.find(r => r.request_id === requestId);
    if (req) {
      req.status = 'ALLOCATED';
      req.updated_at = new Date().toISOString();
    }

    // Prefer a unit stationed at the accepting facility. Only fall back to a
    // regional available unit when the destination has no local unit.
    const ambulance = db.ambulances.find(item => item.status === 'AVAILABLE' && item.hospital_id === hospitalId)
      || db.ambulances.find(item => item.status === 'AVAILABLE');
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
        metadata: { acceptanceId, ambulance_id: ambulance?.ambulance_id || null }
      });
      db.persist?.();
    });

    const result = {
      acceptanceId,
      requestId,
      hospitalId,
      status: 'ACCEPTED',
      ambulance_id: ambulance?.ambulance_id || null
    };
    this._afterApplied(`Committed ${acceptanceId}`, () => this.emit('allocation_committed', result));
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Release Lock — On REJECT, release soft-lock and failover
  // ─────────────────────────────────────────────────────────────────────────
  async rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock for ${acceptanceId}`);

    return this._withRequestLock(lockEntry.requestId, () => this._rejectAndFailover(acceptanceId, rejectionReason, actorId));
  }

  async _rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock for ${acceptanceId}`);

    clearInterval(lockEntry.countdownTimer);
    this._releaseSoftLocks(lockEntry);

    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc) {
      acc.status = 'REJECTED';
      acc.rejection_reason = rejectionReason;
      acc.responded_at = new Date().toISOString();
    }

    this._activeLocks.delete(acceptanceId);
    const nextLock = await this._tryFailover(lockEntry);

    this._afterApplied(`Rejected ${acceptanceId}`, () => {
      db.auditLog({
        request_id: lockEntry.requestId,
        hospital_id: lockEntry.hospitalId,
        event_type: 'LOCK_REJECTED_FAILOVER',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'MATCHING',
        actor_role: 'HOSPITAL_DESK',
        actor_id: actorId,
        metadata: { acceptanceId, rejectionReason, nextAcceptanceId: nextLock?.acceptanceId || null }
      });
      db.persist?.();
    });

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
    return this._withRequestLock(lockRecord.requestId, () => this._handleTimeoutLocked(lockRecord));
  }

  async _handleTimeoutLocked(lockRecord) {
    // Claim the lock exactly once: if a commit, rejection or cancellation got
    // here first the entry is gone and there is nothing left to release.
    const entry = this._activeLocks.get(lockRecord.acceptanceId);
    if (!entry) return;
    this._activeLocks.delete(lockRecord.acceptanceId);
    clearInterval(entry.countdownTimer);
    this._releaseSoftLocksRaw(entry.lockedResources);

    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === lockRecord.acceptanceId);
    if (acc) {
      acc.status = 'EXPIRED';
      acc.responded_at = new Date().toISOString();
      acc.response_time_sec = 90;
    }

    const nextLock = await this._tryFailover(lockRecord);

    this._afterApplied(`Expired ${lockRecord.acceptanceId}`, () => {
      db.auditLog({
        request_id: lockRecord.requestId,
        hospital_id: lockRecord.hospitalId,
        event_type: 'LOCK_TTL_EXPIRED_FAILOVER',
        previous_state: 'PENDING_ACCEPTANCE',
        new_state: 'MATCHING',
        actor_role: 'SYSTEM',
        metadata: {
          acceptanceId: lockRecord.acceptanceId,
          nextAcceptanceId: nextLock?.acceptanceId || null
        }
      });
      db.persist?.();
    });

    this._afterApplied(`Expired ${lockRecord.acceptanceId}`, () => this.emit('lock_expired', {
      acceptanceId: lockRecord.acceptanceId,
      requestId:    lockRecord.requestId,
      hospitalId:   lockRecord.hospitalId,
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

    const acceptance = db.hospitalAcceptances.find(item => item.acceptance_id === acceptanceId);
    if (!acceptance || acceptance.status !== 'PENDING') return false;
    acceptance.status = 'EXPIRED';
    acceptance.responded_at = new Date().toISOString();
    acceptance.response_time_sec = 90;
    return false;
  }

  /**
   * Choose the next suitable facility after a rejection or timeout. The
   * selection happens on the server, not from a client-supplied hospital ID.
   */
  async _tryFailover(lockEntry) {
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

    for (const candidate of candidates) {
      try {
        // Callers already hold the request-scoped lock, so use the unlocked
        // variant; re-entering _withRequestLock would deadlock on itself.
        const nextLock = await this._acquireSoftLock(
          candidate.hospital_id,
          lockEntry.requestId,
          lockEntry.resourceTypes
        );
        request.status = 'MATCHING';
        request.updated_at = new Date().toISOString();
        return nextLock;
      } catch {
        // A concurrent request may have claimed this candidate; try the next.
      }
    }

    request.status = 'WAITING';
    request.updated_at = new Date().toISOString();
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel every pending referral for a request that is being CANCELLED or
  // COMPLETED. Releases soft-locks and never triggers failover.
  // ─────────────────────────────────────────────────────────────────────────
  async cancelPendingForRequest(requestId, reason = 'Request cancelled') {
    return this._withRequestLock(requestId, async () => {
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
    });
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
        new_state: db.emergencyRequests.find(r => r.request_id === entry.requestId)?.status || 'CANCELLED',
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
  _remainingSec(entry) {
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  _terminalRequestStatus(requestId) {
    const request = db.emergencyRequests.find(r => r.request_id === requestId);
    return request && TERMINAL_REQUEST_STATES.includes(request.status) ? request.status : null;
  }

  _assertRequestAllocatable(requestId) {
    const status = this._terminalRequestStatus(requestId);
    if (status) throw new Error(`Request ${requestId} is ${status} and cannot receive a referral.`);
  }

  _releaseSoftLocks(lockEntry) {
    this._releaseSoftLocksRaw(lockEntry.lockedResources);
  }

  _releaseSoftLocksRaw(resources) {
    resources.forEach(resource => {
      if (resource.locked_capacity > 0) {
        resource.locked_capacity -= 1;
        resource.version_lock += 1;
      }
    });
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
      return await operation();
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
      expiresAt: lockRecord.expiresAt,
      remainingSec: lockRecord.remainingSec,
      status: lockRecord.status
    };
  }
}

export const lockingEngine = new LockingEngine();
export default lockingEngine;
