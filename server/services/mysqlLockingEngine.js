// server/services/mysqlLockingEngine.js
// MySQL-backed referral lock lifecycle (InnoDB transactions + SELECT ... FOR UPDATE).
//
// This is the database counterpart of services/lockingEngine.js, used by server/db/mysqlStore.js
// when DB_USE_MEMORY=false. It is verified by tests/mysql_locking.test.js against a real MySQL server.
//
// Mapping of the OS/DBMS concepts:
//   per-request mutex      -> SELECT ... FOR UPDATE on the EmergencyRequest row
//   per-hospital mutex     -> SELECT ... FOR UPDATE on the Hospital row (Phase 3 Step 3)
//   specialist reservation -> Doctor row FOR UPDATE + a DoctorAssignment row (one active per doctor)
//   resource mutex         -> SELECT/UPDATE on MedicalResource rows
//   deadlock avoidance     -> every path follows the global lock order in docs/lock-order.md
//                             (case -> hospital -> doctor -> resources by type -> ambulance); a retry
//                             on MySQL's deadlock error (1213) is only a backstop
//   90s TTL soft-lock      -> HospitalAcceptance (PENDING) + ResourceAllocation (LOCKED) rows with a
//                             persisted lock_expires_at, compared with the database clock (NOW())
//   atomic commit/cancel   -> one transaction each; nothing is half-applied
//
// Callers pass a mysql2 pool. All values are bound as parameters (no string-built SQL).

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ALLOWED_TRANSITIONS, TERMINAL_STATES, MATCHING_STATES, ON_ROAD_AMBULANCE_STATUSES } from './lifecycle.js';
import { ExecutionHooks } from './executionHooks.js';
import { EXCLUSIVE_SPECIALISTS } from './emergencyRequirements.js';
import {
  claimFromRows, singleStageClaim, stageOf, physicalTypes, exclusiveSpecialistOf
} from './clinicalPathways.js';
import { buildHospitalState, admissionDecision, advanceDecision, evaluateHospital, summarize } from './hospitalSafety.js';
import { chainEntries, verifyLedger, normalizeAuditEntry, GENESIS_HASH } from './auditChain.js';
import { UNIT_IN_AREA_SQL } from './operatingArea.js';

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
  constructor({ pool, hooks = new ExecutionHooks() }) {
    super();
    if (!pool) throw new Error('MySqlLockingEngine requires a mysql2 pool.');
    this.pool = pool;
    // Test-only pause points (see executionHooks.js). Inactive unless a test installs a handler.
    this.hooks = hooks;
    // Audit-chain write cost (AC9): time from requesting the chain head to the head update, per transaction.
    this.auditStats = { flushes: 0, rows: 0, latenciesMs: [] };
  }

  /** Pause at a named point if a test installed a handler there (no-op otherwise). */
  async _pause(point, context) {
    if (this.hooks.active(point)) await this.hooks.run(point, { backend: 'mysql', ...context });
  }

  // ── Transaction helper ─────────────────────────────────────────────────────
  // Each attempt is a fresh transaction on a fresh connection: `work(conn)` is re-run from scratch,
  // so nothing computed by a rolled-back attempt (rows read, audit entries queued) survives into the next.
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
        conn.txAttempt = attempt;
        const result = await work(conn);
        // The audit rows this transaction buffered are chained as its LAST step, under the chain head lock (AC1/AC2).
        const chained = await this._flushAudits(conn);
        await this._pause('tx:beforeCommit', { attempt });
        await conn.commit();
        // Audit events are announced only once their transaction is durable.
        chained.forEach(row => this._notify('audit', row));
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* connection may already be gone */ }
        if (err.errno === ER_LOCK_DEADLOCK && attempt < DEADLOCK_RETRIES) {
          await this._pause('tx:deadlockRetry', { attempt, errno: err.errno });
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

  /**
   * Record an audit event for the caller's transaction. It is only BUFFERED here: _tx chains and writes the buffer
   * as the transaction's last step (see _flushAudits), so a rolled-back or retried attempt leaves nothing behind
   * and a retry rebuilds its records from scratch (AC4).
   */
  async _audit(conn, entry) {
    if (!conn.pendingAudits) throw new Error('audit() must be called inside an engine transaction.');
    // Non-scalar fields are refused here (A6), with the same rules as the in-memory db.auditLog.
    const fields = normalizeAuditEntry(entry);
    const eventTimeMs = Date.now();
    conn.pendingAudits.push({ ...fields, event_time_ms: eventTimeMs, event_time: new Date(eventTimeMs).toISOString() });
  }

  /**
   * Chain and write this transaction's buffered audit rows. AuditChainHead is locked FOR UPDATE as the LAST lock
   * and held until commit, so chain order = commit order and concurrent writers queue here (AC2/AC7). The rows and
   * the head move commit or roll back together: no gap, no orphaned hash (AC5).
   */
  async _flushAudits(conn) {
    const entries = conn.pendingAudits;
    if (!entries.length) return [];
    const started = performance.now();
    const [heads] = await conn.query('SELECT chain_seq, head_hash FROM AuditChainHead WHERE id = 1 FOR UPDATE');
    if (!heads.length) throw new Error('AuditChainHead is missing: apply migration 006 (npm run db:migrate).');
    const { rows, head } = chainEntries({ chain_seq: Number(heads[0].chain_seq), hash: heads[0].head_hash }, entries);
    for (const r of rows) {
      // event_time is derived on the server from the hashed millisecond, so client/server time zones cannot skew it.
      await conn.query(
        `INSERT INTO EmergencyHistory (request_id, hospital_id, event_type, previous_state, new_state, actor_role, actor_id, metadata,
                                       event_time, event_time_ms, chain_seq, prev_hash, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?, ?, ?)`,
        [r.request_id, r.hospital_id, r.event_type, r.previous_state, r.new_state, r.actor_role, r.actor_id,
          r.metadata === null ? null : JSON.stringify(r.metadata), r.event_time_ms, r.event_time_ms, r.chain_seq, r.prev_hash, r.row_hash]
      );
    }
    await conn.query('UPDATE AuditChainHead SET chain_seq = ?, head_hash = ? WHERE id = 1', [head.chain_seq, head.hash]);
    const s = this.auditStats;
    s.flushes += 1;
    s.rows += rows.length;
    if (s.latenciesMs.length < 100000) s.latenciesMs.push(performance.now() - started);
    return rows;
  }

  /**
   * Full-chain verification (AC8). Rows and head are read in ONE consistent snapshot (REPEATABLE READ, read-only),
   * so a writer committing meanwhile cannot produce a false head mismatch. Returns the verification, the head as
   * { chain_seq, hash } for a future external checkpoint (AC10), and how many rows predate the chain.
   */
  async verifyAuditChain() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      // event_time_check_ms: the displayed event_time as epoch ms (UNIX_TIMESTAMP of a TIMESTAMP column does not depend
      // on the session time zone), compared with the hashed event_time_ms (A2).
      const [rows] = await conn.query(
        `SELECT history_id, chain_seq, prev_hash, row_hash, event_time_ms, request_id, hospital_id, event_type, previous_state,
                new_state, actor_role, actor_id, metadata, ROUND(UNIX_TIMESTAMP(event_time) * 1000) AS event_time_check_ms
         FROM EmergencyHistory WHERE chain_seq IS NOT NULL ORDER BY chain_seq`
      );
      const [[head]] = await conn.query('SELECT chain_seq, head_hash, legacy_max_history_id, legacy_count FROM AuditChainHead WHERE id = 1');
      // Unchained rows (A3): the legacy (pre-chain) set was recorded ONCE in the head by migration 007 (highest
      // history_id and count). Any unchained row above that id is a break, and so is a different count at or below
      // it (a row inserted with an explicit id into a gap, or a deleted legacy row). Deriving "legacy" from the
      // first chained row instead would accept a row slipped into an id gap below it.
      const legacyMax = head?.legacy_max_history_id == null ? null : Number(head.legacy_max_history_id);
      const [[legacy]] = legacyMax === null ? [[{ n: 0 }]] : await conn.query(
        'SELECT COUNT(*) AS n FROM EmergencyHistory WHERE chain_seq IS NULL AND history_id <= ?', [legacyMax]
      );
      const [after] = await conn.query(
        'SELECT history_id FROM EmergencyHistory WHERE chain_seq IS NULL AND (? IS NULL OR history_id > ?) ORDER BY history_id', [legacyMax, legacyMax]
      );
      await conn.query('COMMIT');
      const stored = head ? { chain_seq: Number(head.chain_seq), hash: head.head_hash } : { chain_seq: 0, hash: GENESIS_HASH };
      return {
        ...verifyLedger({
          chained: rows, head: stored, legacyUnchained: Number(legacy.n), legacyRecorded: head ? Number(head.legacy_count) : 0,
          unchainedAfterChain: after.map(r => ({ history_id: Number(r.history_id) }))
        }),
        stored_head: stored,
        // The recorded legacy set (migration 007), reported so an external checkpoint can pin it alongside the head.
        legacy_mark: { max_history_id: legacyMax, count: head ? Number(head.legacy_count) : 0 }
      };
    } catch (err) {
      // A5: never hand a connection with an open transaction back to the pool.
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ── Per-hospital lock (level 2 of docs/lock-order.md) ──────────────────────
  /**
   * Lock one Hospital row FOR UPDATE: the per-hospital mutex. Every writer of that hospital's doctors,
   * resources or specialist assignments holds it, so they are serialised per hospital while unrelated
   * hospitals proceed in parallel. Returns the row, or null if the hospital does not exist.
   */
  async lockHospital(conn, hospitalId) {
    const [rows] = await conn.query('SELECT hospital_id, emergency_status FROM Hospital WHERE hospital_id = ? FOR UPDATE', [hospitalId]);
    return rows[0] || null;
  }

  /** Lock several hospitals in ascending hospital_id order (the only way to hold more than one). */
  async _lockHospitals(conn, hospitalIds) {
    const ids = [...new Set(hospitalIds.filter(Boolean))].sort();
    for (const id of ids) await this.lockHospital(conn, id);
    return ids;
  }

  // ── Acquire (soft-lock) ────────────────────────────────────────────────────
  async acquireSoftLock(hospitalId, requestId, resourceTypes = ['ICU_BED'], { initiatedBy = null } = {}) {
    const types = this._normalizeTypes(resourceTypes);
    let lock;
    try {
      lock = await this._tx(conn => this._acquire(conn, hospitalId, requestId, types, { initiatedBy }));
    } catch (err) {
      if (err instanceof LockError && err.code === 'UNSAFE') await this._recordUnsafeRefusal(requestId, hospitalId, err.safety);
      throw err;
    }
    this._notify('lock_acquired', this._publicLock(lock));
    return lock;
  }

  // ── Claims and the Banker's state (Phase 3 Step 4) ─────────────────────────
  /** The case's recorded claim, or null for a case created before claims existed (legacy single stage). */
  async _loadClaim(conn, requestId) {
    const [rows] = await conn.query('SELECT stage_no, resource_type, quantity FROM RequestClaim WHERE request_id = ? ORDER BY stage_no, resource_type', [requestId]);
    return claimFromRows(rows);
  }

  /**
   * One hospital's Banker's state. Plain reads: the caller holds the hospital's lock, and every writer of this
   * hospital's resources, allocations, assignments and doctors holds it too, so the reads are one consistent state.
   */
  async _hospitalState(conn, hospitalId) {
    const [resources] = await conn.query('SELECT resource_type, available_capacity, locked_capacity FROM MedicalResource WHERE hospital_id = ?', [hospitalId]);
    const [doctors] = await conn.query(
      "SELECT specialization, COUNT(*) AS n FROM Doctor WHERE hospital_id = ? AND availability_status = 'AVAILABLE' AND specialization IN (?) GROUP BY specialization",
      [hospitalId, EXCLUSIVE_SPECIALISTS]
    );
    const [units] = await conn.query(
      `SELECT ra.request_id, mr.resource_type, COUNT(*) AS n FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
       WHERE ra.hospital_id = ? AND ra.status IN ('LOCKED', 'COMMITTED') GROUP BY ra.request_id, mr.resource_type`, [hospitalId]
    );
    const [specialists] = await conn.query(
      `SELECT da.request_id, d.specialization AS resource_type, COUNT(*) AS n FROM DoctorAssignment da JOIN Doctor d ON d.doctor_id = da.doctor_id
       WHERE da.hospital_id = ? AND da.status IN ('LOCKED', 'COMMITTED') GROUP BY da.request_id, d.specialization`, [hospitalId]
    );
    const held = new Map();
    for (const row of [...units, ...specialists]) {
      if (!held.has(row.request_id)) held.set(row.request_id, {});
      held.get(row.request_id)[row.resource_type] = Number(row.n);
    }
    const ids = [...held.keys()];
    let stagesById = new Map();
    let stageById = new Map();
    if (ids.length) {
      const [claims] = await conn.query('SELECT request_id, stage_no, resource_type, quantity FROM RequestClaim WHERE request_id IN (?)', [ids]);
      const [requests] = await conn.query('SELECT request_id, current_stage FROM EmergencyRequest WHERE request_id IN (?)', [ids]);
      stagesById = new Map(ids.map(id => [id, claimFromRows(claims.filter(c => c.request_id === id))]));
      stageById = new Map(requests.map(r => [r.request_id, Number(r.current_stage || 1)]));
    }
    return buildHospitalState({
      resources,
      specialistsAvailable: Object.fromEntries(doctors.map(d => [d.specialization, Number(d.n)])),
      cases: ids.map(id => ({ id, stages: stagesById.get(id), currentStage: stageById.get(id) ?? 1, held: held.get(id) }))
    });
  }

  /** A refusal with its Banker's explanation (code UNSAFE for a safety refusal). */
  _refusal(decision, hospitalId) {
    const unsafe = decision.reason === 'UNSAFE' || decision.reason === 'HOSPITAL_UNSAFE';
    const err = new LockError(`${hospitalId}: ${decision.explanation}`, unsafe ? 'UNSAFE' : null);
    err.safety = { hospital_id: hospitalId, ...summarize(decision) };
    return err;
  }

  /** Audit a safety refusal on the case (D4-a3/a5); its own transaction, since the refused one rolled back. */
  async _recordUnsafeRefusal(requestId, hospitalId, safety) {
    try {
      await this._tx(async conn => {
        const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
        if (!requests.length) return;
        await this._audit(conn, {
          request_id: requestId, hospital_id: hospitalId, event_type: 'ADMISSION_REFUSED_UNSAFE',
          previous_state: requests[0].status, new_state: requests[0].status, metadata: { safety }
        });
      });
    } catch (err) {
      console.error(`[MYSQL-LOCK] Could not audit the unsafe refusal of ${requestId}:`, err.message);
    }
  }

  /**
   * Re-evaluate a hospital whose lock the caller holds, and record a change of its SAFE/UNSAFE flag with an
   * UNSAFE_STATE (+ alert) or SAFE_STATE_RESTORED audit event (D5-A). With onlyIfUnsafe it does nothing for a
   * hospital flagged SAFE (release paths: a release can only make a hospital safer). Returns the report or null.
   */
  async refreshSafety(conn, hospitalId, { onlyIfUnsafe = false, actor = { role: 'SYSTEM', id: null }, cause = null } = {}) {
    const [[flag]] = await conn.query('SELECT safety_state FROM Hospital WHERE hospital_id = ?', [hospitalId]);
    if (!flag || (onlyIfUnsafe && flag.safety_state !== 'UNSAFE')) return null;
    const report = evaluateHospital(await this._hospitalState(conn, hospitalId));
    const next = report.safe ? 'SAFE' : 'UNSAFE';
    if (next !== flag.safety_state) {
      await conn.query('UPDATE Hospital SET safety_state = ? WHERE hospital_id = ?', [next, hospitalId]);
      await this._audit(conn, {
        request_id: null, hospital_id: hospitalId, event_type: next === 'UNSAFE' ? 'UNSAFE_STATE' : 'SAFE_STATE_RESTORED',
        previous_state: flag.safety_state, new_state: next, actor_role: actor.role, actor_id: actor.id,
        metadata: { cause, explanation: report.explanation, unfinished: report.unfinished, available: report.available }
      });
      if (next === 'UNSAFE') {
        await conn.query("INSERT INTO Alert (hospital_id, request_id, alert_type, message) VALUES (?, NULL, 'RESOURCE_CRITICAL', ?)",
          [hospitalId, `UNSAFE_STATE at ${hospitalId}: ${report.explanation}`.slice(0, 500)]);
      }
    }
    return { ...report, safety_state: next, changed: next !== flag.safety_state };
  }

  /** GET /hospitals/:id/safety: a consistent report, read under a shared hospital lock (writers hold it exclusively). */
  async getHospitalSafety(hospitalId) {
    return this._tx(async conn => {
      const [rows] = await conn.query('SELECT hospital_id, safety_state FROM Hospital WHERE hospital_id = ? FOR SHARE', [hospitalId]);
      if (!rows.length) return null;
      return { hospital_id: hospitalId, safety_state: rows[0].safety_state, ...evaluateHospital(await this._hospitalState(conn, hospitalId)) };
    });
  }

  _normalizeTypes(resourceTypes) {
    const types = [...new Set(resourceTypes.map(type => String(type).trim().toUpperCase()))].sort();
    if (types.some(type => !VALID_RESOURCE_TYPES.includes(type))) {
      throw new LockError('Unsupported resource type requested.');
    }
    return types;
  }

  /** initiatedBy: the user who sent the referral (a failover passes on the ended referral's), recorded on the row. */
  async _acquire(conn, hospitalId, requestId, types, { initiatedBy = null } = {}) {
    // 1. Per-request mutex: every mutator of this request's lock state starts here.
    //    Lock order (docs/lock-order.md): EmergencyRequest -> HospitalAcceptance (case-owned) -> Hospital
    //    (the per-hospital lock) -> Doctor -> MedicalResource (sorted by type).
    const [requests] = await conn.query('SELECT status, required_specialist, current_stage FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
    await this._pause('acquire:requestLocked', { requestId, hospitalId, attempt: conn.txAttempt });
    if (!requests.length) throw new LockError(`Emergency request ${requestId} not found.`, 'NOT_FOUND');
    const { status, required_specialist: specialist } = requests[0];
    // The stage to admit comes from the claim recorded at intake. A case without one (created before claims
    // existed, or inserted directly) is a legacy single-stage case claiming the requested types.
    const stageNo = Number(requests[0].current_stage || 1);
    const stages = (await this._loadClaim(conn, requestId)) ?? singleStageClaim(types, specialist);
    const stage = stageOf(stages, stageNo);
    types = physicalTypes(stage);
    const exclusive = exclusiveSpecialistOf(stage);
    if (!MATCHING_STATES.includes(status)) {
      throw new LockError(`Request ${requestId} is ${status} and cannot receive a referral.`);
    }

    const [pending] = await conn.query(
      "SELECT acceptance_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING' FOR UPDATE", [requestId]
    );
    if (pending.length) throw new LockError(`Request ${requestId} already has an active referral lock.`);

    // 2. The per-hospital lock. Eligibility, specialist and capacity are checked while holding it, so a
    //    concurrent closure, doctor change or competing referral to this hospital is serialised with this
    //    one instead of slipping in after an unlocked pre-check. Other hospitals are not blocked.
    const hospital = await this.lockHospital(conn, hospitalId);
    await this._pause('acquire:hospitalLocked', { requestId, hospitalId, attempt: conn.txAttempt });
    if (!hospital) throw new LockError(`Hospital ${hospitalId} not found.`, 'NOT_FOUND');
    if (hospital.emergency_status === 'CLOSED') throw new LockError(`Hospital ${hospitalId} is CLOSED and cannot receive a referral.`);

    // 3. Specialist. An exclusive one (D3-B: the trauma surgeon) is reserved for this referral: the lowest
    //    AVAILABLE doctor_id is locked and later marked RESERVED. Any other required specialist is only checked:
    //    a consultant, or an exclusive one this stage's claim does not reserve (a legacy claim), exactly as the
    //    in-memory engine's eligibility check does.
    let specialistId = null;
    if (exclusive) {
      const [doctors] = await conn.query(
        `SELECT doctor_id FROM Doctor WHERE hospital_id = ? AND specialization = ? AND availability_status = 'AVAILABLE'
         ORDER BY doctor_id LIMIT 1 FOR UPDATE`,
        [hospitalId, exclusive]
      );
      if (!doctors.length) throw new LockError(`Required specialist ${exclusive} is not available at ${hospitalId}.`);
      specialistId = doctors[0].doctor_id;
    } else if (specialist) {
      const [doctors] = await conn.query(
        "SELECT doctor_id FROM Doctor WHERE hospital_id = ? AND specialization = ? AND availability_status = 'AVAILABLE' LIMIT 1 FOR SHARE",
        [hospitalId, specialist]
      );
      if (!doctors.length) throw new LockError(`Required specialist ${specialist} is not available at ${hospitalId}.`);
    }

    // 4. Resource rows, always in sorted type order (global lock ordering => no lock cycles). Checked here,
    //    written only after the safety check below, so a refusal changes nothing (G9).
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
      resourceIds.push(row.resource_id);
    }

    // 5. Banker's safety check (option A): the hospital must stay SAFE with this case admitted at its stage,
    //    counting what every other case here still needs for its remaining stages (D2-a8). D4-A: no exemption.
    const decision = admissionDecision(await this._hospitalState(conn, hospitalId), { id: requestId, stages, currentStage: stageNo });
    await this._pause('acquire:safetyChecked', { requestId, hospitalId, granted: decision.granted, attempt: conn.txAttempt });
    if (!decision.granted) throw this._refusal(decision, hospitalId);
    for (const resourceId of resourceIds) {
      await conn.query(
        'UPDATE MedicalResource SET locked_capacity = locked_capacity + 1, version_lock = version_lock + 1 WHERE resource_id = ?',
        [resourceId]
      );
    }

    // 6. Persist the handshake. The expiry uses the database clock, not the app clock.
    const acceptanceId = `ACC-${uuidv4().slice(0, 8).toUpperCase()}`;
    await conn.query(
      `INSERT INTO HospitalAcceptance (acceptance_id, request_id, hospital_id, status, lock_expires_at, initiated_by)
       VALUES (?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
      [acceptanceId, requestId, hospitalId, SOFT_LOCK_TTL_SEC, initiatedBy]
    );
    for (const resourceId of resourceIds) {
      await conn.query(
        "INSERT INTO ResourceAllocation (allocation_id, request_id, hospital_id, resource_id, status, stage_no) VALUES (?, ?, ?, ?, 'LOCKED', ?)",
        [`ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`, requestId, hospitalId, resourceId, stageNo]
      );
    }
    if (specialistId) {
      // The doctor row is already locked (step 3). uq_active_doctor makes a second active assignment
      // for the same doctor impossible even if a future path forgot the lock.
      await conn.query("UPDATE Doctor SET availability_status = 'RESERVED' WHERE doctor_id = ?", [specialistId]);
      await conn.query(
        `INSERT INTO DoctorAssignment (assignment_id, doctor_id, request_id, hospital_id, acceptance_id, stage_no, status)
         VALUES (?, ?, ?, ?, ?, ?, 'LOCKED')`,
        [`DA-${uuidv4().slice(0, 8).toUpperCase()}`, specialistId, requestId, hospitalId, acceptanceId, stageNo]
      );
    }
    await conn.query("UPDATE EmergencyRequest SET status = 'MATCHING' WHERE request_id = ?", [requestId]);
    await this._audit(conn, {
      request_id: requestId, hospital_id: hospitalId, event_type: 'LOCK_ACQUIRED',
      previous_state: status, new_state: 'PENDING_ACCEPTANCE',
      metadata: { acceptanceId, resourceIds, stage: stageNo, safetySequence: decision.safety.sequence, ...(specialistId ? { specialistId } : {}) }
    });

    const [[expiry]] = await conn.query(
      'SELECT UNIX_TIMESTAMP(lock_expires_at) * 1000 AS expires_ms FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]
    );
    return {
      acceptanceId, requestId, hospitalId, resourceIds, resourceTypes: types, specialistId, stage: stageNo,
      expiresAt: Number(expiry.expires_ms), remainingSec: SOFT_LOCK_TTL_SEC, status: 'PENDING'
    };
  }

  _publicLock(lock) {
    return {
      acceptanceId: lock.acceptanceId, requestId: lock.requestId, hospitalId: lock.hospitalId,
      resourceIds: lock.resourceIds, resourceTypes: lock.resourceTypes, specialistId: lock.specialistId ?? null,
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

  /**
   * Give a pending referral's holds back: its reserved specialist, then its soft-locked capacity
   * (resource rows in sorted type order). Takes the hospital lock first, per the global order.
   */
  async _releaseSoftLocks(conn, requestId, hospitalId) {
    await this.lockHospital(conn, hospitalId);
    await this._releaseAssignments(conn, requestId, hospitalId, 'LOCKED');
    const allocations = await this._lockedAllocations(conn, requestId, hospitalId, 'LOCKED');
    for (const allocation of allocations) {
      await conn.query(
        'UPDATE MedicalResource SET locked_capacity = locked_capacity - 1, version_lock = version_lock + 1 WHERE resource_id = ? AND locked_capacity > 0',
        [allocation.resource_id]
      );
    }
    await this._setAllocations(conn, allocations, 'RELEASED');
    await this.refreshSafety(conn, hospitalId, { onlyIfUnsafe: true, cause: 'release' });
    return allocations.map(a => a.resource_type);
  }

  /**
   * Release the case's specialist assignments in `status` (LOCKED or COMMITTED) at `hospitalId`
   * (every hospital when null): each doctor returns to AVAILABLE (only from a state the assignment put it
   * in) and the assignment becomes RELEASED. Caller holds the case lock and the hospital lock(s).
   * Doctor rows are updated in ascending doctor_id. Returns the released doctor ids.
   */
  async _releaseAssignments(conn, requestId, hospitalId, status) {
    const [rows] = await conn.query(
      `SELECT assignment_id, doctor_id FROM DoctorAssignment
       WHERE request_id = ? AND status = ? AND (? IS NULL OR hospital_id = ?) ORDER BY doctor_id`,
      [requestId, status, hospitalId, hospitalId]
    );
    if (!rows.length) return [];
    const heldStates = status === 'LOCKED' ? ['RESERVED'] : ['ASSIGNED', 'IN_PROCEDURE'];
    for (const row of rows) {
      await conn.query(
        "UPDATE Doctor SET availability_status = 'AVAILABLE' WHERE doctor_id = ? AND availability_status IN (?)",
        [row.doctor_id, heldStates]
      );
    }
    await conn.query(
      "UPDATE DoctorAssignment SET status = 'RELEASED', released_at = NOW(3) WHERE assignment_id IN (?)",
      [rows.map(r => r.assignment_id)]
    );
    return rows.map(r => r.doctor_id);
  }

  /** Lock the request row, then the acceptance row, in that order. */
  async _lockRequestAndAcceptance(conn, acceptanceId) {
    const [pre] = await conn.query('SELECT request_id, hospital_id, initiated_by FROM HospitalAcceptance WHERE acceptance_id = ?', [acceptanceId]);
    if (!pre.length) return null;
    const { request_id: requestId, hospital_id: hospitalId, initiated_by: initiatedBy } = pre[0];
    const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
    const [acceptances] = await conn.query(
      'SELECT status, (lock_expires_at <= NOW()) AS expired FROM HospitalAcceptance WHERE acceptance_id = ? FOR UPDATE', [acceptanceId]
    );
    return {
      requestId, hospitalId, initiatedBy,
      requestStatus: requests[0]?.status,
      acceptanceStatus: acceptances[0]?.status,
      expired: Boolean(acceptances[0]?.expired)
    };
  }

  // ── Commit (hospital accepts) ──────────────────────────────────────────────
  async commitAllocation(acceptanceId, actorId = 'HOSPITAL_DESK') {
    const outcome = await this._tx(async conn => {
      const ctx = await this._lockRequestAndAcceptance(conn, acceptanceId);
      await this._pause('commit:requestLocked', { requestId: ctx?.requestId, acceptanceId, attempt: conn.txAttempt });
      // A retry whose first response was lost: report the committed outcome, change nothing.
      if (ctx?.acceptanceStatus === 'ACCEPTED') return { replay: await this._acceptedOutcome(conn, acceptanceId, ctx) };
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
      // Only a case in MATCHING can be allocated (L3, same rule and wording as the in-memory engine). Every path that
      // moves a case out of MATCHING also ends its pending referral, so this is a guard against a manual edit.
      if (ctx.requestStatus !== 'MATCHING') {
        throw new LockError(`Request ${requestId} is ${ctx.requestStatus}; only a case in MATCHING can be allocated.`);
      }

      // The per-hospital lock, then the reserved specialist (doctor row), then resources.
      await this.lockHospital(conn, hospitalId);
      const [reserved] = await conn.query(
        "SELECT assignment_id, doctor_id FROM DoctorAssignment WHERE acceptance_id = ? AND status = 'LOCKED'", [acceptanceId]
      );
      const specialistId = reserved[0]?.doctor_id ?? null;
      if (specialistId) {
        await conn.query("UPDATE Doctor SET availability_status = 'ASSIGNED' WHERE doctor_id = ?", [specialistId]);
        await conn.query(
          "UPDATE DoctorAssignment SET status = 'COMMITTED', committed_at = NOW(3) WHERE assignment_id = ?", [reserved[0].assignment_id]
        );
      }

      const allocations = await this._lockedAllocations(conn, requestId, hospitalId, 'LOCKED');
      for (const allocation of allocations) {
        // L4(c): the soft-locked unit must still be there (locked >= 1, available >= locked). Corrupt counters are a
        // refusal (409, rolled back) on both backends, not a CHECK-constraint failure here and a silent clamp there.
        const [updated] = await conn.query(
          `UPDATE MedicalResource
           SET available_capacity = available_capacity - 1, locked_capacity = locked_capacity - 1, version_lock = version_lock + 1
           WHERE resource_id = ? AND locked_capacity >= 1 AND available_capacity >= locked_capacity`,
          [allocation.resource_id]
        );
        if (updated.affectedRows !== 1) {
          throw new LockError(`Capacity of ${allocation.resource_type} at ${hospitalId} is inconsistent (no soft-locked unit to commit); referral ${acceptanceId} cannot be accepted.`);
        }
      }
      await this._setAllocations(conn, allocations, 'COMMITTED');
      await conn.query("UPDATE EmergencyRequest SET status = 'ALLOCATED' WHERE request_id = ?", [requestId]);

      // Prefer the unit the admin chose at dispatch (Batch 8), then a unit stationed at the accepting facility; SKIP
      // LOCKED keeps concurrent accepts from fighting over (or double-assigning) the same unit.
      const [[{ dispatch_ambulance_id: preferred } = {}]] = await conn.query('SELECT dispatch_ambulance_id FROM EmergencyRequest WHERE request_id = ?', [requestId]);
      const [units] = await conn.query(
        `SELECT ambulance_id FROM Ambulance WHERE status = 'AVAILABLE' AND ${UNIT_IN_AREA_SQL}
         ORDER BY (ambulance_id <=> ?) DESC, (hospital_id = ?) DESC, ambulance_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [preferred ?? null, hospitalId]
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
        metadata: { acceptanceId, ambulance_id: ambulanceId, specialist_id: specialistId }
      });
      return { result: { acceptanceId, requestId, hospitalId, status: 'ACCEPTED', ambulance_id: ambulanceId, specialist_id: specialistId } };
    });

    if (outcome.replay) return outcome.replay;
    if (outcome.refused) {
      this._notify('lock_released', { ...outcome.cancelled, status: 'CANCELLED', reason: outcome.refused });
      throw new LockError(outcome.refused);
    }
    this._notify('allocation_committed', outcome.result);
    return outcome.result;
  }

  /**
   * Outcome of an already-accepted referral, for a retried accept. Only the referral that still holds
   * the case's allocation qualifies; the ambulance is the case's current on-road unit (a replacement,
   * if the original was swapped). Read-only: no allocation, assignment, audit row or event.
   */
  async _acceptedOutcome(conn, acceptanceId, { requestId, hospitalId, requestStatus }) {
    if (!['ALLOCATED', 'IN_TREATMENT'].includes(requestStatus)) {
      throw new LockError(`Referral ${acceptanceId} was accepted, but request ${requestId} is now ${requestStatus}.`);
    }
    const [holders] = await conn.query(
      "SELECT DISTINCT hospital_id FROM ResourceAllocation WHERE request_id = ? AND status = 'COMMITTED'", [requestId]
    );
    const [others] = await conn.query(
      "SELECT 1 FROM HospitalAcceptance WHERE request_id = ? AND status = 'ACCEPTED' AND acceptance_id <> ? LIMIT 1",
      [requestId, acceptanceId]
    );
    // A stage that holds no resources (e.g. a GENERAL case) has no allocation rows: then only another hospital holding
    // something disqualifies the replay (round 2, item 3).
    if (others.length || holders.some(r => r.hospital_id !== hospitalId)) {
      throw new LockError(`Referral ${acceptanceId} does not hold the allocation for request ${requestId}.`);
    }
    const [units] = await conn.query(
      'SELECT ambulance_id FROM Ambulance WHERE assigned_request_id = ? AND status IN (?) ORDER BY ambulance_id LIMIT 1',
      [requestId, ON_ROAD_AMBULANCE_STATUSES]
    );
    const [specialists] = await conn.query(
      "SELECT doctor_id FROM DoctorAssignment WHERE acceptance_id = ? AND status = 'COMMITTED' LIMIT 1", [acceptanceId]
    );
    return {
      acceptanceId, requestId, hospitalId, status: 'ACCEPTED', ambulance_id: units[0]?.ambulance_id || null,
      specialist_id: specialists[0]?.doctor_id ?? null, replayed: true
    };
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
      await this._pause('reject:requestLocked', { requestId: ctx?.requestId, acceptanceId, attempt: conn.txAttempt });
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
      return { requestId: ctx.requestId, hospitalId: ctx.hospitalId, types, initiatedBy: ctx.initiatedBy };
    });

    const next = await this._failoverAfterCommit(released.requestId, released.types, { initiatedBy: released.initiatedBy });
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
  async _failoverAfterCommit(requestId, types, { initiatedBy = null } = {}) {
    try {
      return await this._failover(requestId, types, { initiatedBy });
    } catch (err) {
      console.error(`[MYSQL-LOCK] Failover for ${requestId} failed after commit; the case stays queued:`, err.message);
      return null;
    }
  }

  /**
   * Pick the next suitable facility on the server. Candidate selection reads without locks;
   * _acquire re-validates everything under row locks, so a stale candidate just fails and is skipped.
   */
  async _failover(requestId, types, { initiatedBy = null } = {}) {
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

    let firstUnsafe = null;
    for (const candidate of candidates) {
      try {
        // The failover referral belongs to whoever sent the one it replaces (B1-R1).
        const lock = await this._tx(conn => this._acquire(conn, candidate.hospital_id, requestId, types, { initiatedBy }));
        this._notify('lock_acquired', this._publicLock(lock));
        return lock;
      } catch (err) {
        if (!(err instanceof LockError)) throw err; // a competing request took it, or the case changed: try the next
        if (err.code === 'UNSAFE') {
          await this._recordUnsafeRefusal(requestId, candidate.hospital_id, err.safety);
          firstUnsafe ??= err.safety;
        }
      }
    }
    // Nobody can take it. The case is already WAITING (see _requeue), or MATCHING because a referral was
    // placed meanwhile; either way it is correct, so it is not overwritten here. If a hospital refused it as
    // unsafe, the command centre is alerted and the case's trail says why (D4-a3; an alert and an audit event
    // only, no automatic action, D4-a4).
    if (firstUnsafe) await this._escalate(requestId, firstUnsafe);
    return null;
  }

  async _escalate(requestId, safety) {
    try {
      await this._tx(async conn => {
        const [requests] = await conn.query('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
        if (!requests.length || !MATCHING_STATES.includes(requests[0].status)) return;
        await this._audit(conn, {
          request_id: requestId, hospital_id: safety.hospital_id, event_type: 'ADMISSION_ESCALATED',
          previous_state: requests[0].status, new_state: requests[0].status, metadata: { reason: 'NO_SAFE_HOSPITAL', safety }
        });
        await conn.query("INSERT INTO Alert (hospital_id, request_id, alert_type, message) VALUES (NULL, ?, 'SYSTEM', ?)",
          [requestId, `ESCALATION: no hospital can admit ${requestId} safely; blocked at ${safety.hospital_id}. ${safety.explanation}`.slice(0, 500)]);
      });
    } catch (err) {
      console.error(`[MYSQL-LOCK] Escalation for ${requestId} failed:`, err.message);
    }
  }

  // ── TTL expiry ─────────────────────────────────────────────────────────────
  /** Expire one lock if (and only if) its database-clock expiry has passed. Returns true if it acted. */
  async expireLock(acceptanceId) {
    const outcome = await this._tx(async conn => {
      const ctx = await this._lockRequestAndAcceptance(conn, acceptanceId);
      await this._pause('expire:requestLocked', { requestId: ctx?.requestId, acceptanceId, attempt: conn.txAttempt });
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
      return { requestId: ctx.requestId, hospitalId: ctx.hospitalId, types, initiatedBy: ctx.initiatedBy };
    });
    if (!outcome) return false;

    const next = await this._failoverAfterCommit(outcome.requestId, outcome.types, { initiatedBy: outcome.initiatedBy });
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
    await this._pause('stranded:scanned', { requestIds: rows.map(r => r.request_id) });
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
  async transitionRequest(requestId, newStatus, actor = { role: 'ADMIN', id: null }, options = {}) {
    // options (Batch 8, the hospital steps; same contract as MemoryStore.transitionRequestStatus): guard(row) checked
    // under the row lock after the lifecycle check; treatmentEvent / hospitalId: the extra audit rows.
    const outcome = await this._tx(async conn => {
      const [requests] = await conn.query(
        'SELECT status, arrived_at, bed_label, treatment_started_at FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
      if (!requests.length) throw new LockError(`Emergency request ${requestId} not found.`, 'NOT_FOUND');
      const previous = requests[0].status;
      if (previous === newStatus) return { previous, unchanged: true, cancelled: [] };
      if (!ALLOWED_TRANSITIONS[previous]?.includes(newStatus)) {
        throw new LockError(`Invalid lifecycle transition: ${previous} -> ${newStatus}.`, 'INVALID_TRANSITION');
      }
      const refusal = options.guard?.(requests[0]);
      if (refusal) throw new LockError(refusal, 'INVALID_TRANSITION');
      // Milestones follow the status (any path): treatment started on IN_TREATMENT, completed on IN_TREATMENT -> COMPLETED.
      await conn.query(
        `UPDATE EmergencyRequest SET status = ?,
           treatment_started_at = IF(? = 'IN_TREATMENT', COALESCE(treatment_started_at, NOW(3)), treatment_started_at),
           treatment_completed_at = IF(? = 'COMPLETED' AND ? = 'IN_TREATMENT', NOW(3), treatment_completed_at)
         WHERE request_id = ?`, [newStatus, newStatus, newStatus, previous, requestId]);
      // The request row is locked and its new status written (not yet committed).
      await this._pause('transition:statusRecorded', { requestId, previous, newStatus, attempt: conn.txAttempt });

      const terminal = TERMINAL_STATES.includes(newStatus);
      const releasesHolds = terminal || (previous === 'MATCHING' && newStatus === 'WAITING');
      let lockedHospitals = [];
      if (releasesHolds || newStatus === 'IN_TREATMENT') {
        // Every hospital this case holds anything at, locked up front in ascending order (level 2), so
        // the doctor and resource updates below never take a hospital lock after a doctor/resource lock.
        const [held] = await conn.query(
          `SELECT hospital_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'
           UNION SELECT hospital_id FROM ResourceAllocation WHERE request_id = ? AND status IN ('LOCKED', 'COMMITTED')
           UNION SELECT hospital_id FROM DoctorAssignment WHERE request_id = ? AND status IN ('LOCKED', 'COMMITTED')`,
          [requestId, requestId, requestId]
        );
        lockedHospitals = await this._lockHospitals(conn, held.map(r => r.hospital_id));
      }
      if (newStatus === 'IN_TREATMENT') {
        // The assigned specialist starts the procedure.
        const [assigned] = await conn.query(
          "SELECT doctor_id FROM DoctorAssignment WHERE request_id = ? AND status = 'COMMITTED' ORDER BY doctor_id", [requestId]
        );
        for (const row of assigned) {
          await conn.query(
            "UPDATE Doctor SET availability_status = 'IN_PROCEDURE' WHERE doctor_id = ? AND availability_status = 'ASSIGNED'", [row.doctor_id]
          );
        }
      }
      let cancelled = [];
      if (terminal || (previous === 'MATCHING' && newStatus === 'WAITING')) {
        cancelled = await this._cancelPending(conn, requestId, `Request ${newStatus}`);
      }
      let released = 0;
      let capped = 0;
      let releasedSpecialists = [];
      if (terminal) {
        // The case's assigned specialists become available again (doctor rows before resource rows).
        releasedSpecialists = await this._releaseAssignments(conn, requestId, null, 'COMMITTED');
        // Committed allocations go back to the hospital (sorted by type, like every other path).
        const [committed] = await conn.query(
          `SELECT ra.allocation_id, ra.resource_id, mr.resource_type
           FROM ResourceAllocation ra JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
           WHERE ra.request_id = ? AND ra.status = 'COMMITTED' ORDER BY mr.resource_type`,
          [requestId]
        );
        for (const allocation of committed) {
          // Never above total capacity: if the hospital reduced its capacity while this unit was in use,
          // the returned unit no longer exists and is not handed out again. The cap is recorded below.
          const [[row]] = await conn.query(
            'SELECT available_capacity, total_capacity FROM MedicalResource WHERE resource_id = ? FOR UPDATE',
            [allocation.resource_id]
          );
          if (row && row.available_capacity >= row.total_capacity) capped += 1;
          await conn.query(
            `UPDATE MedicalResource SET available_capacity = LEAST(available_capacity + 1, total_capacity),
                                        version_lock = version_lock + 1
             WHERE resource_id = ?`,
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
      if (terminal) for (const id of lockedHospitals) await this.refreshSafety(conn, id, { onlyIfUnsafe: true, cause: 'release' });
      await this._audit(conn, {
        request_id: requestId, event_type: 'STATUS_CHANGED', previous_state: previous, new_state: newStatus,
        actor_role: actor.role, actor_id: actor.id,
        metadata: {
          released_allocations: released, capped_releases: capped,
          ...(releasedSpecialists.length ? { released_specialists: releasedSpecialists } : {})
        }
      });
      if (options.treatmentEvent) {
        const [[bed]] = await conn.query('SELECT bed_label FROM EmergencyRequest WHERE request_id = ?', [requestId]);
        await this._audit(conn, {
          request_id: requestId, hospital_id: options.hospitalId ?? null, event_type: options.treatmentEvent, previous_state: previous,
          new_state: newStatus, actor_role: actor.role, actor_id: actor.id, metadata: { bed_label: bed?.bed_label ?? null }
        });
        if (terminal && (released || releasedSpecialists.length)) {
          await this._audit(conn, {
            request_id: requestId, hospital_id: options.hospitalId ?? null, event_type: 'RESOURCE_RELEASED', previous_state: 'COMMITTED',
            new_state: 'RELEASED', actor_role: actor.role, actor_id: actor.id,
            metadata: { released_allocations: released, capped_releases: capped, released_specialists: releasedSpecialists }
          });
        }
      }
      return { previous, unchanged: false, cancelled, released, releasedSpecialists };
    });
    outcome.cancelled.forEach(item => this._notify('lock_released', { ...item, status: 'CANCELLED', reason: `Request ${newStatus}` }));
    return {
      requestId, previous: outcome.previous, status: newStatus, unchanged: outcome.unchanged,
      cancelledLocks: outcome.cancelled.map(item => item.acceptanceId),
      released_allocations: outcome.released ?? 0, released_specialists: outcome.releasedSpecialists ?? []
    };
  }

  // ── Stage advance (D2-a6/a7/a9) ────────────────────────────────────────────
  /**
   * Move an allocated case to its next treatment stage in ONE transaction: release what the new stage no longer
   * needs (for TRAUMA/POLYTRAUMA the OT and the surgeon) and allocate what it adds (the ICU bed, ventilator),
   * only if capacity exists and the hospital stays SAFE. On refusal nothing changes; the refusal is audited and
   * the caller may retry later (no automatic re-try queue in this phase).
   */
  async advanceStage(requestId, actor = { role: 'ADMIN', id: null }) {
    const outcome = await this._tx(async conn => {
      const [requests] = await conn.query('SELECT status, current_stage FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [requestId]);
      await this._pause('advance:requestLocked', { requestId, attempt: conn.txAttempt });
      if (!requests.length) throw new LockError(`Emergency request ${requestId} not found.`, 'NOT_FOUND');
      const { status } = requests[0];
      const from = Number(requests[0].current_stage || 1);
      const to = from + 1;
      if (!['ALLOCATED', 'IN_TREATMENT'].includes(status)) {
        throw new LockError(`Request ${requestId} is ${status}; only an allocated case can advance its treatment stage.`, 'INVALID_TRANSITION');
      }
      const stages = await this._loadClaim(conn, requestId);
      const next = stages && stageOf(stages, to);
      if (!next) throw new LockError(`Request ${requestId} has no stage ${to} in its claim.`, 'INVALID_TRANSITION');
      const [accepted] = await conn.query(
        "SELECT hospital_id FROM HospitalAcceptance WHERE request_id = ? AND status = 'ACCEPTED' ORDER BY responded_at DESC, acceptance_id DESC LIMIT 1", [requestId]
      );
      if (!accepted.length) throw new LockError(`Request ${requestId} has no accepted referral.`);
      const hospitalId = accepted[0].hospital_id;
      await this.lockHospital(conn, hospitalId);
      await this._pause('advance:hospitalLocked', { requestId, hospitalId, attempt: conn.txAttempt });

      // What the case holds, and what changes between the stages.
      const committed = await this._lockedAllocations(conn, requestId, hospitalId, 'COMMITTED');
      const [assigned] = await conn.query(
        `SELECT da.assignment_id, da.doctor_id, d.specialization FROM DoctorAssignment da JOIN Doctor d ON d.doctor_id = da.doctor_id
         WHERE da.request_id = ? AND da.hospital_id = ? AND da.status = 'COMMITTED' ORDER BY da.doctor_id`, [requestId, hospitalId]
      );
      const wants = next.units;
      const releaseAllocations = [];
      const kept = {};
      for (const a of committed) {
        kept[a.resource_type] = (kept[a.resource_type] || 0) + 1;
        if (kept[a.resource_type] > (wants[a.resource_type] || 0)) releaseAllocations.push(a);
      }
      const releaseDoctors = assigned.filter(d => !wants[d.specialization]);
      const acquireTypes = physicalTypes(next).filter(t => (kept[t] || 0) < wants[t]);
      const newSpecialist = exclusiveSpecialistOf(next);
      const needsSpecialist = newSpecialist && !assigned.some(d => d.specialization === newSpecialist);

      // Doctor rows, then resource rows (sorted): the global order.
      for (const d of releaseDoctors) await conn.query('SELECT doctor_id FROM Doctor WHERE doctor_id = ? FOR UPDATE', [d.doctor_id]);
      let newDoctor = null;
      if (needsSpecialist) {
        const [rows] = await conn.query(
          `SELECT doctor_id FROM Doctor WHERE hospital_id = ? AND specialization = ? AND availability_status = 'AVAILABLE'
           ORDER BY doctor_id LIMIT 1 FOR UPDATE`, [hospitalId, newSpecialist]
        );
        newDoctor = rows[0]?.doctor_id ?? null;
      }
      const touched = [...new Set([...releaseAllocations.map(a => a.resource_type), ...acquireTypes])].sort();
      const rowByType = {};
      for (const type of touched) {
        const [rows] = await conn.query(
          'SELECT resource_id, available_capacity, locked_capacity, total_capacity FROM MedicalResource WHERE hospital_id = ? AND resource_type = ? FOR UPDATE',
          [hospitalId, type]
        );
        rowByType[type] = rows[0] ?? null;
      }

      // Decide first, write after (G9).
      const release = {};
      for (const a of releaseAllocations) release[a.resource_type] = (release[a.resource_type] || 0) + 1;
      for (const d of releaseDoctors) release[d.specialization] = (release[d.specialization] || 0) + 1;
      const decision = advanceDecision(await this._hospitalState(conn, hospitalId), { id: requestId, stages, toStage: to, release });
      const missingRow = acquireTypes.find(t => !rowByType[t]);
      if (!decision.granted || missingRow || (needsSpecialist && !newDoctor)) {
        const refusal = decision.granted
          ? { ...decision, granted: false, reason: 'INSUFFICIENT', explanation: `Refused: ${missingRow ?? newSpecialist} is not available at ${hospitalId}.` }
          : decision;
        await this._audit(conn, {
          request_id: requestId, hospital_id: hospitalId, event_type: 'STAGE_ADVANCE_REFUSED', previous_state: `STAGE_${from}`, new_state: `STAGE_${from}`,
          actor_role: actor.role, actor_id: actor.id, metadata: { from, to, safety: { hospital_id: hospitalId, ...summarize(refusal) } }
        });
        return { refused: refusal, hospitalId };
      }

      for (const a of releaseAllocations) {
        const row = rowByType[a.resource_type];
        await conn.query(
          'UPDATE MedicalResource SET available_capacity = LEAST(available_capacity + 1, total_capacity), version_lock = version_lock + 1 WHERE resource_id = ?',
          [row.resource_id]
        );
      }
      await this._setAllocations(conn, releaseAllocations, 'RELEASED');
      const allocated = [];
      for (const type of acquireTypes) {
        const row = rowByType[type];
        await conn.query('UPDATE MedicalResource SET available_capacity = available_capacity - 1, version_lock = version_lock + 1 WHERE resource_id = ?', [row.resource_id]);
        await conn.query(
          "INSERT INTO ResourceAllocation (allocation_id, request_id, hospital_id, resource_id, status, stage_no) VALUES (?, ?, ?, ?, 'COMMITTED', ?)",
          [`ALLOC-${uuidv4().slice(0, 8).toUpperCase()}`, requestId, hospitalId, row.resource_id, to]
        );
        allocated.push(type);
      }
      for (const d of releaseDoctors) {
        await conn.query("UPDATE Doctor SET availability_status = 'AVAILABLE' WHERE doctor_id = ? AND availability_status IN ('ASSIGNED', 'IN_PROCEDURE')", [d.doctor_id]);
        await conn.query("UPDATE DoctorAssignment SET status = 'RELEASED', released_at = NOW(3) WHERE assignment_id = ?", [d.assignment_id]);
      }
      if (newDoctor) {
        await conn.query('UPDATE Doctor SET availability_status = ? WHERE doctor_id = ?', [status === 'IN_TREATMENT' ? 'IN_PROCEDURE' : 'ASSIGNED', newDoctor]);
        await conn.query(
          `INSERT INTO DoctorAssignment (assignment_id, doctor_id, request_id, hospital_id, acceptance_id, stage_no, status, committed_at)
           VALUES (?, ?, ?, ?, NULL, ?, 'COMMITTED', NOW(3))`,
          [`DA-${uuidv4().slice(0, 8).toUpperCase()}`, newDoctor, requestId, hospitalId, to]
        );
      }
      await conn.query('UPDATE EmergencyRequest SET current_stage = ? WHERE request_id = ?', [to, requestId]);
      const result = {
        requestId, hospitalId, previous_stage: from, current_stage: to,
        released: releaseAllocations.map(a => a.resource_type), allocated,
        released_specialists: releaseDoctors.map(d => d.doctor_id), assigned_specialist: newDoctor
      };
      await this._audit(conn, {
        request_id: requestId, hospital_id: hospitalId, event_type: 'STAGE_ADVANCED', previous_state: `STAGE_${from}`, new_state: `STAGE_${to}`,
        actor_role: actor.role, actor_id: actor.id,
        metadata: { ...result, safetySequence: decision.safety.sequence }
      });
      await this.refreshSafety(conn, hospitalId, { onlyIfUnsafe: true, cause: 'stage advance' });
      return { result };
    });
    if (outcome.refused) throw this._refusal(outcome.refused, outcome.hospitalId);
    this._notify('stage_advanced', outcome.result);
    return outcome.result;
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
