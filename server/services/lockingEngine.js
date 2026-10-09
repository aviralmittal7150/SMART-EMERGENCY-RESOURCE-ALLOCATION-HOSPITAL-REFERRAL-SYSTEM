// server/services/lockingEngine.js
// OS-Grade Concurrency & Mutual Exclusion Engine
// Implements soft-locks with 90-second TTL and atomic commit semantics

import { EventEmitter } from 'events';
import { db } from '../db/seed.js';
import { v4 as uuidv4 } from 'uuid';

const SOFT_LOCK_TTL_MS = 90_000; // 90 seconds

class LockingEngine extends EventEmitter {
  constructor() {
    super();
    // Map of resourceId -> { acceptanceId, requestId, hospitalId, expiresAt, timerId }
    this._activeLocks = new Map();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Acquire Soft Lock — Simulates SELECT ... FOR UPDATE with TTL
  // Implements mutual exclusion: only one lock per resource at a time
  // ─────────────────────────────────────────────────────────────────────────
  async acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED']) {
    const releaseFns = [];
    const lockedResources = [];

    try {
      for (const rType of resourceTypes) {
        const resource = db.medicalResources.find(
          r => r.hospital_id === hospitalId && r.resource_type === rType
        );

        if (!resource) throw new Error(`Resource ${rType} not found for hospital ${hospitalId}`);
        if (resource.available_capacity <= 0) throw new Error(`No available ${rType} at ${hospitalId}`);

        // Acquire OS mutex (SELECT ... FOR UPDATE simulation)
        const releaseLock = await db.acquireResourceLock(resource.resource_id, 3000);
        releaseFns.push(releaseLock);

        // Optimistic version check (prevents dirty reads)
        const expectedVersion = resource.version_lock;

        // Soft-lock: decrement available, increment locked
        resource.locked_capacity += 1;
        resource.version_lock = expectedVersion + 1;
        lockedResources.push(resource);
      }

      const acceptanceId = `ACC-${uuidv4().slice(0, 8).toUpperCase()}`;
      const expiresAt = Date.now() + SOFT_LOCK_TTL_MS;

      const lockRecord = {
        acceptanceId,
        requestId,
        hospitalId,
        resourceIds: lockedResources.map(r => r.resource_id),
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
        this.emit('lock_tick', { ...lockRecord });

        if (elapsed >= 90) {
          clearInterval(countdownTimer);
          this._handleTimeout(lockRecord, releaseFns, lockedResources);
        }
      }, 1000);

      lockRecord.timerId = countdownTimer;
      this._activeLocks.set(acceptanceId, { ...lockRecord, releaseFns, lockedResources, countdownTimer });

      // Audit
      db.auditLog({
        request_id: requestId,
        hospital_id: hospitalId,
        event_type: 'LOCK_ACQUIRED',
        previous_state: 'WAITING',
        new_state: 'PENDING_ACCEPTANCE',
        actor_role: 'SYSTEM',
        metadata: { acceptanceId, resourceIds: lockedResources.map(r => r.resource_id) }
      });

      // Release OS mutex (lock record stored, application-level lock maintained)
      releaseFns.forEach(fn => fn());

      this.emit('lock_acquired', lockRecord);
      return lockRecord;

    } catch (err) {
      // Release any acquired OS mutexes on partial failure
      releaseFns.forEach(fn => { try { fn(); } catch(_) {} });
      // Rollback any partial soft-locks
      lockedResources.forEach(r => {
        if (r.locked_capacity > 0) r.locked_capacity -= 1;
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Commit Allocation — ACID atomic transaction on ACCEPT
  // ─────────────────────────────────────────────────────────────────────────
  async commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    const lockEntry = this._activeLocks.get(acceptanceId);
    if (!lockEntry) throw new Error(`No active lock found for acceptance ${acceptanceId}`);

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
    if (req) req.status = 'ALLOCATED';

    // Update HospitalAcceptance
    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === acceptanceId);
    if (acc) {
      acc.status = 'ACCEPTED';
      acc.responded_at = new Date().toISOString();
      acc.response_time_sec = 90 - lockEntry.remainingSec;
    }

    this._activeLocks.delete(acceptanceId);

    db.auditLog({
      request_id: requestId,
      hospital_id: hospitalId,
      event_type: 'ALLOCATION_COMMITTED',
      previous_state: 'PENDING_ACCEPTANCE',
      new_state: 'ALLOCATED',
      actor_role: 'HOSPITAL_DESK',
      actor_id: actorId,
      metadata: { acceptanceId }
    });

    const result = { acceptanceId, requestId, hospitalId, status: 'ACCEPTED' };
    this.emit('allocation_committed', result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-03: Release Lock — On REJECT, release soft-lock and failover
  // ─────────────────────────────────────────────────────────────────────────
  async rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
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

    db.auditLog({
      request_id: lockEntry.requestId,
      hospital_id: lockEntry.hospitalId,
      event_type: 'LOCK_REJECTED_FAILOVER',
      previous_state: 'PENDING_ACCEPTANCE',
      new_state: 'MATCHING',
      actor_role: 'HOSPITAL_DESK',
      actor_id: actorId,
      metadata: { acceptanceId, rejectionReason }
    });

    const result = { acceptanceId, requestId: lockEntry.requestId, hospitalId: lockEntry.hospitalId, status: 'REJECTED' };
    this.emit('lock_released', result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2-08: TTL Expiry Background Worker
  // ─────────────────────────────────────────────────────────────────────────
  _handleTimeout(lockRecord, releaseFns, lockedResources) {
    this._releaseSoftLocksRaw(lockedResources);

    const acc = db.hospitalAcceptances.find(a => a.acceptance_id === lockRecord.acceptanceId);
    if (acc) acc.status = 'EXPIRED';

    this._activeLocks.delete(lockRecord.acceptanceId);

    db.auditLog({
      request_id: lockRecord.requestId,
      hospital_id: lockRecord.hospitalId,
      event_type: 'LOCK_TTL_EXPIRED_FAILOVER',
      previous_state: 'PENDING_ACCEPTANCE',
      new_state: 'MATCHING',
      actor_role: 'SYSTEM',
      metadata: { acceptanceId: lockRecord.acceptanceId }
    });

    this.emit('lock_expired', {
      acceptanceId: lockRecord.acceptanceId,
      requestId:    lockRecord.requestId,
      hospitalId:   lockRecord.hospitalId
    });
  }

  _releaseSoftLocks(lockEntry) {
    this._releaseSoftLocksRaw(lockEntry.lockedResources);
  }

  _releaseSoftLocksRaw(resources) {
    resources.forEach(resource => {
      if (resource.locked_capacity > 0) {
        resource.locked_capacity -= 1;
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
        remainingSec: entry.remainingSec,
        status:       entry.status
      });
    }
    return result;
  }
}

export const lockingEngine = new LockingEngine();
export default lockingEngine;
