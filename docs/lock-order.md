# Global lock order

Every transaction that takes locks in the referral system takes them in **one global order**. If every
transaction acquires locks in the same total order, no two transactions can each hold a lock the other is
waiting for, so the lock waits between our own code paths can never form a cycle (no deadlock). This
document is the reference. `server/services/lockOrder.js` encodes it as ranks, and the lock-order checker
enforces it in the tests and in the stress harness (`sim/`).

## The hierarchy

| Level | Lock | MySQL (InnoDB, READ COMMITTED) | In-memory backend | Rank |
| :--- | :--- | :--- | :--- | :---: |
| 1 | **Case** | `EmergencyRequest` row `FOR UPDATE` | per-request promise chain (`_withRequestLock`) | 10 |
| 1a | **Case-owned rows** | `HospitalAcceptance`, `ResourceAllocation`, `DoctorAssignment` rows of that case | (plain objects; covered by the case lock) | none: valid any time after level 1 |
| 2 | **Hospital** | `Hospital` row `FOR UPDATE` (the per-hospital lock) | per-hospital FIFO mutex (`acquireHospitalLock`) | 30 |
| 3 | **Doctors** | `Doctor` rows `FOR UPDATE` / `FOR SHARE`, ascending `doctor_id` | covered by the hospital mutex (doctor state changes are synchronous) | 40 |
| 4 | **Resources** | `MedicalResource` rows `FOR UPDATE`, ascending `resource_type` | FIFO row mutex per resource (`acquireResourceLock`) | 50 |
| 5 | **Ambulance** | `Ambulance` rows: `FOR UPDATE SKIP LOCKED` (auto-dispatch), `FOR UPDATE` by id (manual dispatch) | (synchronous) | 60 |
| 6 | **Audit chain head** (Phase 3 Step 5) | `AuditChainHead` row `FOR UPDATE`, always the **last** lock: the transaction's buffered audit rows are chained and written, the head moves, then `COMMIT` | synchronous append at the commit point (the head is the last row) | 90 |

### Rules

1. **Ascending only.** Within a transaction a new lock's level is never lower than a level already held.
   Re-locking a row the transaction already holds (for example the `UPDATE` of a locked `EmergencyRequest`)
   is not a new acquisition.
2. **Case-owned rows** belong to one case. They are only locked by a transaction that already holds that
   case's `EmergencyRequest` row, so the case lock serialises every access to them.
3. **One hospital per transaction.** No operation locks two hospitals at once (transfers between hospitals are
   out of scope). Should one ever need to, it must lock them in ascending `hospital_id` order (the
   `_lockHospitals` helper already sorts).
4. **Writers that do not touch a case start at level 2**: capacity edits, hospital status, adding/changing/
   removing doctors. They never lock an `EmergencyRequest` row afterwards.
5. **Within a level** rows are locked in ascending key order (`doctor_id`, `resource_type`).
6. **Failover is a separate transaction.** Rejection and TTL expiry commit first; the search for the next
   hospital starts a new transaction (so one transaction never holds two hospitals).

### Not ordered (cannot take part in a wait cycle)

- **Plain reads.** Under READ COMMITTED they take no row locks: candidate selection, analytics, status pages.
- **Inserts of new rows**: `EmergencyHistory`, `Alert`, `Patient`, `IdempotencyKey`, and new
  `HospitalAcceptance` / `ResourceAllocation` / `DoctorAssignment` rows. Their foreign-key checks take
  shared locks only on parent rows that the transaction already holds (case, hospital, doctor, resource),
  or that it does not need to wait for (an `Alert` insert in its own autocommit statement).
- **`SKIP LOCKED` / `NOWAIT`**: never wait, so they cannot close a cycle (they are still recorded as held).
- **Migration runner**: its own connection, serialised by a MySQL advisory lock, outside request traffic.

## Transaction boundaries (MySQL)

| Operation | One transaction, locks in order |
| :--- | :--- |
| Intake (`createRequest`) | inserts only |
| Soft-lock (`_acquire`) | case → pending referrals (case-owned) → claim (plain read) → **hospital** → exclusive specialist doctor (`TRAUMA_SURGEON`) or shared check of a consultant → resources of the case's **current stage** (sorted) → **Banker's safety check** (plain reads, consistent under the hospital lock) → writes → inserts → case status. A refusal is thrown before any write. |
| Accept (`commitAllocation`) | case → referral → **hospital** → reserved doctor (→ ASSIGNED) → resources → allocations → case status → ambulance (`SKIP LOCKED`) → referral status |
| Reject (`rejectAndFailover`) | case → referral → **hospital** → reserved doctor (→ AVAILABLE) → resources → referral status → requeue. *Failover: a new transaction per candidate (soft-lock above).* |
| TTL expiry (`expireLock`) | as reject; failover in new transactions |
| Stage advance (`advanceStage`, Step 4) | case → accepted referral (plain read) → **hospital** → released surgeon / new specialist doctor rows → resources of both stages (sorted) → Banker's check → (refused: audit only) or writes: allocations, doctors, assignments, case `current_stage` → hospital safety flag (re-lock of the held row) |
| Every audit-writing transaction (Step 5) | ... its own locks ... → **AuditChainHead** `FOR UPDATE` (last) → chained `EmergencyHistory` inserts → head update → COMMIT. A rollback or deadlock retry discards the buffered rows and the head move together. |
| Unsafe-refusal audit / escalation (Step 4) | its own transaction after the refused one rolled back: case → inserts (audit row; escalation also an `Alert`) |
| Lifecycle transition (`transitionRequest`) | case → **hospital(s)** holding the case's referral / allocations / assignments (sorted) → committed doctors (terminal: → AVAILABLE; `IN_TREATMENT`: → IN_PROCEDURE) → pending referrals released (doctors, resources) → committed resources → allocations → ambulance |
| Stranded-case recovery | case → pending referrals (read under lock) → case status |
| Capacity edit | **hospital** → resource row → hospital safety flag (D5-A: re-evaluate, `UNSAFE_STATE` / `SAFE_STATE_RESTORED` audit, alert) |
| Hospital safety report (`/hospitals/:id/safety`) | **hospital** `FOR SHARE` (waits for any writer of that hospital) → plain reads |
| Hospital status | **hospital** |
| Doctor add / status / remove | **hospital** → doctor row (status/remove refuse a doctor with an active case assignment; remove also refuses one with any assignment history, which `ON DELETE RESTRICT` keeps) |
| Doctor shift | doctor row only (does not change availability) |
| Ambulance status | case (dispatch, or the case a unit leaves) → ambulance |

## Deadlock-cycle audit

A wait cycle needs two transactions that each hold a lock the other waits for. Against the rules above:

- **Different cases, same hospital.** Both lock their own case, then wait for the same hospital row.
  One waits for the other; neither holds anything the first needs (cases differ). No cycle.
- **Case operation vs hospital-only writer** (capacity edit, doctor change, hospital status). The writer
  holds the hospital (and then lower-level rows) and never asks for a case row. The case operation may wait
  for the hospital. No cycle.
- **Same case.** The case row serialises them completely.
- **Accept vs manual ambulance dispatch.** Both lock the case first (dispatch locks the case before the
  unit), and auto-dispatch uses `SKIP LOCKED`.
- **Exclusive surgeon.** A doctor's reservation, assignment and release only happen under that doctor's
  hospital lock, and the `DoctorAssignment` unique key on the active doctor (`uq_active_doctor`) is only
  inserted by a transaction already holding that doctor's row. The duplicate-key check therefore never waits.
- **Gap and next-key locks.** READ COMMITTED disables gap locking except for foreign-key and duplicate-key
  checks. The one new case is a doctor removal: its `ON DELETE RESTRICT` check scans `DoctorAssignment` for
  that doctor (always empty, because removal is refused first otherwise) and may gap-lock the index around
  it, briefly delaying a reservation of a *different* doctor. The removing transaction then only inserts
  its audit row and commits, waiting for nothing, so it cannot close a cycle.

Residual risk: InnoDB can still report a deadlock for reasons outside this model (for example internal
index-page locks under extreme load). `_tx` retries such a transaction from scratch (errno 1213, bounded
retries). `tests/mysql_deadlock_retry.test.js` forces a real deadlock to prove that path.

## In-memory backend

The in-memory store runs on one Node.js thread. Synchronous code cannot interleave, so the locks only
matter across `await` points:

- Soft-lock acquisition holds the request lock, then the **hospital mutex**, then resource mutexes
  (sorted), and re-validates the case and hospital after waiting.
- Capacity edits and doctor changes take the hospital mutex. 
- Specialist reservation happens synchronously after the mutex waits, so the reserved surgeon is always the
  lowest `doctor_id` still `AVAILABLE` at that moment; lifecycle transitions move or release specialists
  synchronously too.
- Step 4: the Banker's check runs after every mutex wait, in the synchronous section, and nothing is applied
  before it passes. A stage advance takes the request lock → hospital mutex → resource mutexes of both stages
  (sorted). Capacity edits are now validated under the hospital and resource mutexes (D5 race fix).
- Accept, release, expiry and cancellation run their state changes synchronously (no `await` inside), so
  they are atomic without holding a mutex.
- A lifecycle transition (`transitionRequestStatus`) validates and writes the new status while holding the
  request lock, and drops pending referrals with the locked variant of the cancellation, as MySQL's
  `transitionRequest` does under the `EmergencyRequest` row lock. An accept, rejection, failover or expiry of
  the same case runs entirely before or entirely after it, so both backends pick the same winner in these
  races (`tests/contract/allocation.contract.js`, the L1–L4 scenarios).
- The soft-lock acquisition marks the case `MATCHING` inside its synchronous section and refuses a case that
  is not `NEW`/`WAITING`/`MATCHING`; an accept requires the case to be `MATCHING` and the lock unexpired.
  Rejection and expiry re-queue the case (`MATCHING` → `WAITING`) and write their audit row before the
  failover, as on MySQL, and the memory store's background worker runs the stranded-case recovery
  (`requeueStrandedRequests`) as MySQL's sweeper does.

Remaining difference: in memory, `expireLock` on a live lock expires it at once (the TTL timer, the
background worker and the stress harness call it), while MySQL acts only once `lock_expires_at` has passed.

## How it is enforced

- `server/services/lockOrder.js`: ranks and the checker (MySQL: per transaction, from the SQL; in-memory:
  per async operation, with key order).
- `tests/contract/*`: every scenario on both backends asserts zero lock-order violations.
  `specialists.contract.js` forces the interleavings with execution hooks and proves blocking without
  sleeps: in memory from the hospital mutex's waiter queue; in MySQL from a `FOR UPDATE NOWAIT` probe
  (errno 3572 while held) and from `information_schema.PROCESSLIST`, where a competing transaction is still
  executing its hospital `FOR UPDATE` (an uncontended one returns at once).
- `sim/`: every stress-harness run fails on any lock-order violation.
- `tests/lock_order.test.js`: the checker rejects deliberate violations, so a clean result means something.
