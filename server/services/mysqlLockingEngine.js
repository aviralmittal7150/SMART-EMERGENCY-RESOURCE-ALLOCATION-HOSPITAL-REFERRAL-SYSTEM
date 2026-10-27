// server/services/mysqlLockingEngine.js
// MySQL-backed referral lock lifecycle (InnoDB transactions + SELECT ... FOR UPDATE).
//
// This is the database counterpart of services/lockingEngine.js, used by server/db/mysqlStore.js
// when DB_USE_MEMORY=false. It is verified by tests/mysql_locking.test.js against a real MySQL server.
//
// Mapping of the OS/DBMS concepts:
//   per-request mutex      -> SELECT ... FOR UPDATE on the EmergencyRequest row
//   resource mutex         -> SELECT/UPDATE on MedicalResource rows
//   deadlock avoidance     -> rows are always locked in sorted resource-type order; a retry on
//                             MySQL's deadlock error (1213) is only a backstop
//   90s TTL soft-lock      -> HospitalAcceptance (PENDING) + ResourceAllocation (LOCKED) rows with a
//                             persisted lock_expires_at, compared with the database clock (NOW())
//   atomic commit/cancel   -> one transaction each; nothing is half-applied
//
// Callers pass a mysql2 pool. All values are bound as parameters (no string-built SQL).

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ALLOWED_TRANSITIONS, TERMINAL_STATES, MATCHING_STATES } from './lifecycle.js';

export const SOFT_LOCK_TTL_SEC = 90;
const VALID_RESOURCE_TYPES = ['ICU_BED', 'VENTILATOR', 'OT'];
const ER_LOCK_DEADLOCK = 1213;
const DEADLOCK_RETRIES = 4;

/** Expected, business-level refusal (as opposed to an infrastructure failure). */
export class LockError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'LockError';
    this.code = code; // NOT_FOUND | INVALID_TRANSITION | null
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class MySqlLockingEngine extends EventEmitter {
  constructor({ pool }) {
    super();
    if (!pool) throw new Error('MySqlLockingEngine requires a mysql2 pool.');
    this.pool = pool;
  }

  // ── Transaction helper ─────────────────────────────────────────────────────
  async _tx(work) {
    for (let attempt = 0; ; attempt += 1) {
      const conn = await this.pool.getConnection();
      try {
        // READ COMMITTED: plain reads always see the latest committed rows. With REPEATABLE READ the
        // first plain SELECT would pin a snapshot taken *before* the request-row lock is held, and
        // later reads could miss what the previous lock holder just committed. Row locks (FOR UPDATE,
        // UPDATE) provide the mutual exclusion; this level also takes fewer gap locks.
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();
        conn.pendingAudits = [];
        const result = await work(conn);
        await conn.commit();
        // Audit events are announced only once their transaction is durable.
        conn.pendingAudits.forEach(entry => this._notify('audit', entry));
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* connection may already be gone */ }
        if (err.errno === ER_LOCK_DEADLOCK && attempt < DEADLOCK_RETRIES) {
          await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10));
          continue;
        }
        throw err;
      } finally {
        conn.release();
      }
    }
  }

  /**
   * Announce an event for work that is already committed. A throwing listener is logged, never
   * turned into a failure of an operation that happened (the caller would retry or give up on it).
   */
  _notify(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      console.error(`[MYSQL-LOCK] '${event}' listener failed after commit:`, err.message);
    }
  }

  /** Run `work(conn)` in a READ COMMITTED transaction (deadlock-retried; audit events emitted after commit). */
  transaction(work) {
    return this._tx(work);
  }

  /** Write an audit row inside the caller's transaction. */
  audit(conn, entry) {
    return this._audit(conn, entry);
  }

  async _audit(conn, entry) {
    conn.pendingAudits?.push({ ...entry, event_time: new Date().toISOString() });
    await conn.query(
      `INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, previous_state, new_state, actor_role, actor_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.request_id ?? null, entry.hospital_id ?? null, entry.event_type,
        entry.previous_state ?? null, entry.new_state ?? null,
        entry.actor_role || 'SYSTEM', entry.actor_id ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      ]
    );
  }

  // ── Acquire (soft-lock) ────────────────────────────────────────────────────
  async acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED']) {
    const types = this._normalizeTypes(resourceTypes);
    const lock = await this._tx(conn => this._acquire(conn, hospitalId, requestId, types));
    this._notify('lock_acquired', this._publicLock(lock));
    return lock;
  }

  _normalizeTypes(resourceTypes) {
    const types = [...new Set(resourceTypes.map(type => String(type).trim().toUpperCase()))].sort();
    if (types.some(type => !VALID_RESOURCE_TYPES.includes(type))) {
      throw new LockError('Unsupported resource type requested.');
    }
    return types;
  }

  async _acquire(conn, hospitalId, requestId, types) {
    // 1. Per-request mutex: every mutator of this request's lock state starts here.
  //    Lock order: EmergencyRequest -> HospitalAcceptance -> Hospital (shared) -> Doctor (shared)
  //    -> MedicalResource (sorted by type). Other writers of Hospital / Doctor hold only that one row.
    const [requests] = await conn.query('SELECT status, required_specialist FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
    if (!requests.length) throw new LockError(`Emergency request ${requestId} not found.`, 'NOT_FOUND');
    const { status, required_specialist: specialist } = requests[0];
    if (!MATCHING_STATES.includes(status)) {
      throw new LockError(`Request ${requestId} is ${status} and cannot receive a referral.`);
    }

    const [pending] = await conn.query(
      "SELECT acceptance_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' FOR UPDATE", [requestId]
    );
    if (pending.length) throw new LockError(`Request ${requestId} already has an active referral lock.`);

    // Hospital eligibility, checked under shared locks so a concurrent closure or specialist going off
    // duty is serialised with this referral instead of slipping in after an unlocked pre-check.
    const [hospitals] = await conn.query('SELECT emergency_status FROM Hospital WHERE hospital_id = ? FOR SHARE', [hospitalId]);
    if (!hospitals.length) throw new LockError(`Hospital ${hospitalId} not found.`, 'NOT_FOUND');
    if (hospitals[0].emergency_status === 'CLOSED') throw new LockError(`Hospital ${hospitalId} is CLOSED and cannot receive a referral.`);
    if (specialist) {
      const [doctors] = await conn.query(
        "SELECT doctor_id FROM Doctor WHERE hospital_id = ? AND specialization = ? AND availability_status = 'AVAILABLE' LIMIT 1 FOR SHARE",
        [hospitalId, specialist]
      );
      if (!doctors.length) throw new LockError(`Required specialist ${specialist} is not available at ${hospitalId}.`);
    }

    // 2. Resource rows, always in sorted type order (global lock ordering => no lock cycles).
    const resourceIds = [];
    for (const type of types) {
      const [rows] = await conn.query(
        `SELECT resource_id, available_capacity, locked_capacity FROM MedicalResource
         WHERE hospital_id = ? AND resource_type = ? FOR UPDATE`,
        [hospitalId, type]
      );
      if (!rows.length) throw new LockError(`Resource ${type} not found for hospital ${hospitalId}`);
      const row = rows[0];
      if (row.available_capacity - row.locked_capacity <= 0) {
        throw new LockError(`No available ${type} at ${hospitalId}`);
      }
      await conn.query(
        'UPDATE MedicalResource SET locked_capacity = locked_capacity + 1, version_lock = version_lock + 1 WHERE resource_id = ?',
        [row.resource_id]
      );
      resourceIds.push(row.resource_id);
    }

    // 3. Persist the handshake. The expiry uses the database clock, not the app clock.
    const acceptanceId = `ACC-${uuidv4().slice(0, 8).toUpperCase()}`;
    await conn.query(
      `INSERT INTO HospitalAcceptance (acceptance_id, request_id, hospital_id, status, lock_expires_at)
       VALUES (?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [acceptanceId, requestId, hospitalId, SOFT_LOCK_TTL_SEC]
    );
    for (const resourceId of resourceIds) {
      await conn.query(
        "INSERT INTO ResourceAllocation (allocation_id, request_id, hospital_id, resource_id, status) VALUES (?, ?, ?, ?, 'LOCKED')",
        [`ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`, requestId, hospitalId, resourceId]
      );
    }
    await conn.query("UPDATE EmergencyRequest SET status = 'MATCHING' WHERE request_id = ?", [requestId]);
    await this._audit(conn, {
      request_id: requestId, hospital_id: hospitalId, event_type: 'LOCK_ACQUIRED',
      previous_state: status, new_state: 'PENDING_ACCEPTANCE', metadata: { acceptanceId, resourceIds }
    });

    const [[expiry]] = await conn.query(
      'SELECT UNIX_TIMESTAMP(lock_expires_at) * 1000 AS expires_ms FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]
    );
    return {
      acceptanceId, requestId, hospitalId, resourceIds, resourceTypes: types,
      expiresAt: Number(expiry.expires_ms), remainingSec: SOFT_LOCK_TTL_SEC, status: 'PENDING'
    };
  }

  _publicLock(lock) {
    return {
      acceptanceId: lock.acceptanceId, requestId: lock.requestId, hospitalId: lock.hospitalId,
      resourceIds: lock.resourceIds, resourceTypes: lock.resourceTypes,
      expiresAt: lock.expiresAt, remainingSec: lock.remainingSec, status: lock.status
    };
  }

  // ── Shared helpers (always called inside a transaction holding the request row) ──
  async _lockedAllocations(conn, requestId, hospitalId, status = 'LOCKED') {
    const [rows] = await conn.query(
      `SELECT ra.allocation_id, ra.resource_id, mr.resource_type
       FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
       WHERE ra.request_id = ? AND ra.hospital_id = ? AND ra.status = ?
       ORDER BY mr.resource_type`,
      [requestId, hospitalId, status]
    );
    return rows;
  }

  async _setAllocations(conn, allocations, status) {
    if (!allocations.length) return;
    await conn.query(
      'UPDATE ResourceAllocation SET status = ?, released_at = IF(? = \'RELEASED\', NOW(), released_at) WHERE allocation_id IN (?)',
      [status, status, allocations.map(a => a.allocation_id)]
    );
  }

  /** Give the soft-locked capacity back. Resource rows are touched in sorted type order. */
  async _releaseSoftLocks(conn, requestId, hospitalId) {
    const allocations = await this._lockedAllocations(conn, requestId, hospitalId, 'LOCKED');
    for (const allocation of allocations) {
      await conn.query(
        'UPDATE MedicalResource SET locked_capacity = locked_capacity - 1, version_lock = version_lock + 1 WHERE resource_id = ? AND locked_capacity > 0',
        [allocation.resource_id]
      );
    }
    await this._setAllocations(conn, allocations, 'RELEASED');
    return allocations.map(a => a.resource_type);
  }

  /** Lock the request row, then the acceptance row, in that order. */
  async _lockRequestAndAcceptance(conn, acceptanceId) {
    const [pre] = await conn.query('SELECT request_id, hospital_id FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]);
    if (!pre.length) return null;
    const { request_id: requestId, hospital_id: hospitalId } = pre[0];
    const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
    const [acceptances] = await conn.query(
      'SELECT status, (lock_expires_at <= NOW()) AS expired FROM HospitalAcceptance WHERE acceptance_id = ? FOR UPDATE', [acceptanceId]
    );
    return {
      requestId, hospitalId,
      requestStatus: requests[0]?.status,
      acceptanceStatus: acceptances[0]?.status,
      expired: Boolean(acceptances[0]?.expired)
    };
  }

  // ── Commit (hospital accepts) ──────────────────────────────────────────────
  async commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    const outcome = await this._tx(async conn => {
      const ctx = await this._lockRequestAndAcceptance(conn, acceptanceId);
      if (!ctx || ctx.acceptanceStatus !== 'PENDING') {
        throw new LockError(`No active lock found for acceptance ${acceptanceId}`);
      }
      const { requestId, hospitalId } = ctx;

      // A cancelled/completed request must never be allocated. Free the lock in this same
      // transaction and report the refusal after it commits (throwing here would roll back the release).
      if (TERMINAL_STATES.includes(ctx.requestStatus)) {
        await this._cancelAcceptance(conn, acceptanceId, requestId, hospitalId, `Request is ${ctx.requestStatus}`);
        return { refused: `Request ${requestId} is ${ctx.requestStatus} and cannot be allocated.`, cancelled: { acceptanceId, requestId, hospitalId } };
      }
      if (ctx.expired) throw new LockError(`Referral lock ${acceptanceId} has expired.`);

      const allocations = await this._lockedAllocations(conn, requestId, hospitalId, 'LOCKED');
      for (const allocation of allocations) {
        await conn.query(
          `UPDATE MedicalResource
           SET available_capacity = available_capacity - 1, locked_capacity = locked_capacity - 1, version_lock = version_lock + 1
           WHERE resource_id = ?`,
          [allocation.resource_id]
        );
      }
      await this._setAllocations(conn, allocations, 'COMMITTED');
      await conn.query("UPDATE EmergencyRequest SET status = 'ALLOCATED' WHERE request_id = ?", [requestId]);

      // Prefer a unit stationed at the accepting facility; SKIP LOCKED keeps concurrent accepts
      // from fighting over (or double-assigning) the same unit.
      const [units] = await conn.query(
        `SELECT ambulance_id FROM Ambulance WHERE status = 'AVAILABLE'
         ORDER BY (hospital_id = ?) DESC, ambulance_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [hospitalId]
      );
      const ambulanceId = units[0]?.ambulance_id || null;
      if (ambulanceId) {
        await conn.query(
          "UPDATE Ambulance SET status = 'DISPATCHED', assigned_request_id = ?, destination_hospital_id = ? WHERE ambulance_id = ?",
          [requestId, hospitalId, ambulanceId]
        );
      }
      await conn.query(
        `UPDATE HospitalAcceptance
         SET status = 'ACCEPTED', responded_at = NOW(), response_time_sec = TIMESTAMPDIFF(SECOND, created_at, NOW())
         WHERE acceptance_id = ?`,
        [acceptanceId]
      );
      await this._audit(conn, {
        request_id: requestId, hospital_id: hospitalId, event_type: 'ALLOCATION_COMMITTED',
        previous_state: 'PENDING_ACCEPTANCE', new_state: 'ALLOCATED', actor_role: 'HOSPITAL_DESK', actor_id: actorId,
        metadata: { acceptanceId, ambulance_id: ambulanceId }
      });
      return { result: { acceptanceId, requestId, hospitalId, status: 'ACCEPTED', ambulance_id: ambulanceId } };
    });

    if (outcome.refused) {
      this._notify('lock_released', { ...outcome.cancelled, status: 'CANCELLED', reason: outcome.refused });
      throw new LockError(outcome.refused);
    }
    this._notify('allocation_committed', outcome.result);
    return outcome.result;
  }

  async _cancelAcceptance(conn, acceptanceId, requestId, hospitalId, reason) {
    await this._releaseSoftLocks(conn, requestId, hospitalId);
    await conn.query(
      "UPDATE HospitalAcceptance SET status = 'CANCELLED', rejection_reason = ?, responded_at = NOW() WHERE acceptance_id = ?",
      [reason, acceptanceId]
    );
    await this._audit(conn, {
      request_id: requestId, hospital_id: hospitalId, event_type: 'LOCK_CANCELLED',
      previous_state: 'PENDING_ACCEPTANCE', new_state: 'CANCELLED', metadata: { acceptanceId, reason }
    });
  }

  // ── Reject (hospital declines) + failover ──────────────────────────────────
  async rejectAndFailover(acceptanceId, rejectionReason = 'Hospital rejected referral', actorId = 'HOSPITAL_DESK') {
    const released = await this._tx(async conn => {
      const ctx = await this._lockRequestAndAcceptance(conn, acceptanceId);
      if (!ctx || ctx.acceptanceStatus !== 'PENDING') throw new LockError(`No active lock for ${acceptanceId}`);
      const types = await this._releaseSoftLocks(conn, ctx.requestId, ctx.hospitalId);
      await conn.query(
        "UPDATE HospitalAcceptance SET status = 'REJECTED', rejection_reason = ?, responded_at = NOW() WHERE acceptance_id = ?",
        [rejectionReason, acceptanceId]
      );
      await this._requeue(conn, ctx.requestId);
      await this._audit(conn, {
        request_id: ctx.requestId, hospital_id: ctx.hospitalId, event_type: 'LOCK_REJECTED',
        previous_state: 'PENDING_ACCEPTANCE', new_state: 'REJECTED', actor_role: 'HOSPITAL_DESK', actor_id: actorId,
        metadata: { acceptanceId, rejectionReason }
      });
      return { requestId: ctx.requestId, hospitalId: ctx.hospitalId, types };
    });

    const next = await this._failoverAfterCommit(released.requestId, released.types);
    const result = {
      acceptanceId, requestId: released.requestId, hospitalId: released.hospitalId, status: 'REJECTED',
      next_acceptance_id: next?.acceptanceId || null, next_hospital_id: next?.hospitalId || null
    };
    this._notify('lock_released', result);
    return result;
  }

  /**
   * Put a case whose pending referral just ended back in the queue, in the same transaction that ended
   * it (the request row is already locked). Failover runs after that commit, so if it never happens
   * (crash, lost connection) the case is WAITING and visible, not stuck in MATCHING with no referral.
   * Only _acquire moves a case to MATCHING. A terminal or allocated case is left untouched.
   */
  async _requeue(conn, requestId) {
    await conn.query("UPDATE EmergencyRequest SET status = 'WAITING' WHERE request_id = ? AND status = 'MATCHING'", [requestId]);
  }

  /** Failover for work that is already committed: a failure is logged and reported as "no next hospital". */
  async _failoverAfterCommit(requestId, types) {
    try {
      return await this._failover(requestId, types);
    } catch (err) {
      console.error(`[MYSQL-LOCK] Failover for ${requestId} failed after commit; the case stays queued:`, err.message);
      return null;
    }
  }

  /**
   * Pick the next suitable facility on the server. Candidate selection reads without locks;
   * _acquire re-validates everything under row locks, so a stale candidate just fails and is skipped.
   */
  async _failover(requestId, types) {
    const [requests] = await this.pool.query('SELECT status, required_specialist FROM EmergencyRequest WHERE request_id = ?', [requestId]);
    if (!requests.length || !MATCHING_STATES.includes(requests[0].status)) return null;
    const specialist = requests[0].required_specialist || null;

    const params = [requestId];
    let resourceClause = '';
    if (types.length) {
      resourceClause = `AND (SELECT COUNT(*) FROM MedicalResource mr WHERE mr.hospital_id = h.hospital_id
                              AND mr.resource_type IN (?) AND mr.available_capacity - mr.locked_capacity > 0) = ?`;
      params.push(types, types.length);
    }
    let specialistClause = '';
    if (specialist) {
      specialistClause = `AND EXISTS (SELECT 1 FROM Doctor d WHERE d.hospital_id = h.hospital_id
                                      AND d.specialization = ? AND d.availability_status = 'AVAILABLE')`;
      params.push(specialist);
    }
    const [candidates] = await this.pool.query(
      `SELECT h.hospital_id FROM Hospital h
       WHERE h.emergency_status <> 'CLOSED'
         AND h.hospital_id NOT IN (SELECT hospital_id FROM HospitalAcceptance WHERE request_id = ?)
         ${resourceClause} ${specialistClause}
       ORDER BY h.acceptance_rate DESC, h.avg_response_sec ASC, h.hospital_id`,
      params
    );

    for (const candidate of candidates) {
      try {
        const lock = await this._tx(conn => this._acquire(conn, candidate.hospital_id, requestId, types));
        this._notify('lock_acquired', this._publicLock(lock));
        return lock;
      } catch (err) {
        if (!(err instanceof LockError)) throw err; // a competing request took it, or the case changed: try the next
      }
    }
    // Nobody can take it. The case is already WAITING (see _requeue), or MATCHING because a referral was
    // placed meanwhile; either way it is correct, so it is not overwritten here.
    return null;
  }

  // ── TTL expiry ─────────────────────────────────────────────────────────────
  /** Expire one lock if (and only if) its database-clock expiry has passed. Returns true if it acted. */
  async expireLock(acceptanceId) {
    const outcome = await this._tx(async conn => {
      const ctx = await this._lockRequestAndAcceptance(conn, acceptanceId);
      if (!ctx || ctx.acceptanceStatus !== 'PENDING' || !ctx.expired) return null;
      const types = await this._releaseSoftLocks(conn, ctx.requestId, ctx.hospitalId);
      await conn.query(
        "UPDATE HospitalAcceptance SET status = 'EXPIRED', responded_at = NOW(), response_time_sec = ? WHERE acceptance_id = ?",
        [SOFT_LOCK_TTL_SEC, acceptanceId]
      );
      await this._requeue(conn, ctx.requestId);
      await this._audit(conn, {
        request_id: ctx.requestId, hospital_id: ctx.hospitalId, event_type: 'LOCK_TTL_EXPIRED_FAILOVER',
        previous_state: 'PENDING_ACCEPTANCE', new_state: 'EXPIRED', metadata: { acceptanceId }
      });
      return { requestId: ctx.requestId, hospitalId: ctx.hospitalId, types };
    });
    if (!outcome) return false;

    const next = await this._failoverAfterCommit(outcome.requestId, outcome.types);
    this._notify('lock_expired', {
      acceptanceId, requestId: outcome.requestId, hospitalId: outcome.hospitalId,
      nextAcceptanceId: next?.acceptanceId || null, nextHospitalId: next?.hospitalId || null
    });
    return true;
  }

  /** Sweep every expired pending lock. One failure does not stop the rest. */
  async expireStaleLocks() {
    const [rows] = await this.pool.query(
      "SELECT acceptance_id FROM HospitalAcceptance WHERE status = 'PENDING' AND lock_expires_at <= NOW() ORDER BY lock_expires_at"
    );
    let expired = 0;
    for (const { acceptance_id: acceptanceId } of rows) {
      try {
        if (await this.expireLock(acceptanceId)) expired += 1;
      } catch (err) {
        console.error(`[MYSQL-LOCK] Failed to expire ${acceptanceId}:`, err.message);
      }
    }
    return expired;
  }

  /**
   * Recovery: a case is MATCHING only while it has a pending referral. One without (left by a crash
   * between a rejection and its failover in older versions, or by a manual edit) is put back in the
   * queue so it is visible again. Each case is re-checked under its row lock. Returns how many moved.
   */
  async requeueStrandedRequests() {
    const [rows] = await this.pool.query(
      `SELECT r.request_id FROM EmergencyRequest r WHERE r.status = 'MATCHING'
         AND NOT EXISTS (SELECT 1 FROM HospitalAcceptance ha WHERE ha.request_id = r.request_id AND ha.status = 'PENDING')`
    );
    let moved = 0;
    for (const { request_id: requestId } of rows) {
      try {
        const requeued = await this._tx(async conn => {
          const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
          if (requests[0]?.status !== 'MATCHING') return false;
          const [pending] = await conn.query(
            "SELECT acceptance_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' FOR UPDATE", [requestId]
          );
          if (pending.length) return false;
          await this._requeue(conn, requestId);
          await this._audit(conn, {
            request_id: requestId, event_type: 'STRANDED_MATCHING_REQUEUED', previous_state: 'MATCHING', new_state: 'WAITING'
          });
          return true;
        });
        if (requeued) moved += 1;
      } catch (err) {
        console.error(`[MYSQL-LOCK] Failed to re-queue ${requestId}:`, err.message);
      }
    }
    return moved;
  }

  /** Background sweeper (replaces the in-process 90s timers; survives restarts). Returns a stop function. */
  startExpirySweeper(intervalMs = 5000) {
    const timer = setInterval(() => {
      this.expireStaleLocks()
        .then(() => this.requeueStrandedRequests())
        .catch(err => console.error('[MYSQL-LOCK] Sweep failed:', err.message));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ── Cancel / complete ──────────────────────────────────────────────────────
  /** Drop every pending referral for a request without failover. Used inside closeRequest and standalone. */
  async cancelPendingForRequest(requestId, reason = 'Request cancelled') {
    const cancelled = await this._tx(conn => this._cancelPending(conn, requestId, reason));
    cancelled.forEach(item => this._notify('lock_released', { ...item, status: 'CANCELLED', reason }));
    return cancelled.map(item => item.acceptanceId);
  }

  async _cancelPending(conn, requestId, reason) {
    const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
    if (!requests.length) return [];
    const [pending] = await conn.query(
      "SELECT acceptance_id, hospital_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' FOR UPDATE", [requestId]
    );
    const cancelled = [];
    for (const row of pending) {
      await this._cancelAcceptance(conn, row.acceptance_id, requestId, row.hospital_id, reason);
      cancelled.push({ acceptanceId: row.acceptance_id, requestId, hospitalId: row.hospital_id });
    }
    return cancelled;
  }

  /**
   * Move a request to CANCELLED or COMPLETED in ONE transaction (thin wrapper over transitionRequest).
   */
  async closeRequest(requestId, newStatus, actor = { role: 'ADMIN', id: null }) {
    if (!TERMINAL_STATES.includes(newStatus)) {
      throw new LockError(`closeRequest only handles CANCELLED or COMPLETED, not ${newStatus}.`);
    }
    return this.transitionRequest(requestId, newStatus, actor);
  }

  /**
   * Apply any lifecycle transition in ONE transaction. Terminal moves also drop pending locks, release
   * committed resources and free the ambulance; returning a matching case to the queue drops its
   * pending lock. All of it happens or none of it does.
   */
  async transitionRequest(requestId, newStatus, actor = { role: 'ADMIN', id: null }) {
    const outcome = await this._tx(async conn => {
      const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
      if (!requests.length) throw new LockError(`Emergency request ${requestId} not found.`, 'NOT_FOUND');
      const previous = requests[0].status;
      if (previous === newStatus) return { previous, unchanged: true, cancelled: [] };
      if (!ALLOWED_TRANSITIONS[previous]?.includes(newStatus)) {
        throw new LockError(`Invalid lifecycle transition: ${previous} -> ${newStatus}.`, 'INVALID_TRANSITION');
      }
      await conn.query('UPDATE EmergencyRequest SET status = ? WHERE request_id = ?', [newStatus, requestId]);

      const terminal = TERMINAL_STATES.includes(newStatus);
      let cancelled = [];
      if (terminal || (previous === 'MATCHING' && newStatus === 'WAITING')) {
        cancelled = await this._cancelPending(conn, requestId, `Request ${newStatus}`);
      }
      let released = 0;
      if (terminal) {
        // Committed allocations go back to the hospital (sorted by type, like every other path).
        const [committed] = await conn.query(
          `SELECT ra.allocation_id, ra.resource_id, mr.resource_type
           FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
           WHERE ra.request_id = ? AND ra.status = 'COMMITTED' ORDER BY mr.resource_type`,
          [requestId]
        );
        for (const allocation of committed) {
          await conn.query(
            'UPDATE MedicalResource SET available_capacity = available_capacity + 1, version_lock = version_lock + 1 WHERE resource_id = ?',
            [allocation.resource_id]
          );
        }
        await this._setAllocations(conn, committed, 'RELEASED');
        released = committed.length;
        // Units serving the case leave it; only those on the road return to the pool. A unit that is out
        // of service (MAINTENANCE) stays out, or the next accept would auto-dispatch it.
        await conn.query(
          `UPDATE Ambulance SET status = IF(status IN ('DISPATCHED', 'IN_TRANSIT'), 'AVAILABLE', status),
                                assigned_request_id = NULL, destination_hospital_id = NULL
           WHERE assigned_request_id = ?`,
          [requestId]
        );
      }
      await this._audit(conn, {
        request_id: requestId, event_type: 'STATUS_CHANGED', previous_state: previous, new_state: newStatus,
        actor_role: actor.role, actor_id: actor.id, metadata: { released_allocations: released }
      });
      return { previous, unchanged: false, cancelled };
    });
    outcome.cancelled.forEach(item => this._notify('lock_released', { ...item, status: 'CANCELLED', reason: `Request ${newStatus}` }));
    return {
      requestId, previous: outcome.previous, status: newStatus, unchanged: outcome.unchanged,
      cancelledLocks: outcome.cancelled.map(item => item.acceptanceId)
    };
  }

  // ── Read side ──────────────────────────────────────────────────────────────
  async getActiveLocks() {
    const [rows] = await this.pool.query(
      `SELECT ha.acceptance_id, ha.request_id, ha.hospital_id,
              GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), ha.lock_expires_at)) AS remaining_sec,
              (SELECT GROUP_CONCAT(mr.resource_type ORDER BY mr.resource_type)
                 FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
                WHERE ra.request_id = ha.request_id AND ra.hospital_id = ha.hospital_id AND ra.status = 'LOCKED') AS resource_types
       FROM HospitalAcceptance ha WHERE ha.status = 'PENDING' ORDER BY ha.created_at, ha.acceptance_id`
    );
    return rows.map(row => ({
      acceptanceId: row.acceptance_id, requestId: row.request_id, hospitalId: row.hospital_id,
      remainingSec: Number(row.remaining_sec), status: 'PENDING',
      resourceTypes: row.resource_types ? row.resource_types.split(',') : []
    }));
  }
}

export default MySqlLockingEngine;
