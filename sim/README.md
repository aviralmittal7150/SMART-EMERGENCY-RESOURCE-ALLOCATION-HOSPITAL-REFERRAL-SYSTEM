# Mass-casualty stress harness (Phase 3, issue #24)

Drives the real referral engines with a reproducible, concurrent emergency workload and checks, after every
phase, that no resource was double-allocated, leaked or left inconsistent. It replaces the earlier
browser-only "stress test" with measurements taken from actual execution.

## Safety

- **MySQL runs use only the dedicated `*_test` database** configured in `.env.local` (`MYSQL_TEST_*`).
  `tests/helpers/mysqlTestDb.js` refuses any database whose name does not end in `_test`, and the harness
  recreates that database's schema on every run. It never connects to `DB_*` (the application database).
- The harness takes the same advisory lock as the MySQL test suites, so it never runs concurrently with them.
- All hospitals, patients and numbers in the scenarios are fictional.

## Running it

```bash
npm run sim:smoke                         # small scenario, 1 run, MySQL (used in CI)
npm run sim:baseline -- --out <dir>       # mass-casualty-v1, 3 runs, MySQL; writes <dir>/report.{json,md}
node sim/cli.js --scenario sim/scenarios/mass-casualty-v1.json --backend memory --runs 3
```

The exit code is 1 if any run has an invariant violation, a lock-order violation or an unexpected error.

## What one run does

All randomness is decided up front from the scenario seed (`sim/lib/plan.js`): emergency types and
priorities, the order in which each case tries hospitals, each desk's decision and each case's outcome.
The run then executes the plan through the store interface used by the API routes, with at most
`concurrency` operations in flight:

1. **intake**: every case is registered.
2. **referral**: each case tries hospitals in its planned order until a 90 s soft-lock succeeds.
3. **decision**: the desk accepts, rejects or lets the lock expire. Locks placed by automatic
   failover after a rejection or expiry are then accepted.
4. **discharge**: allocated cases are completed (via `IN_TREATMENT`) or cancelled; some are kept.

After each phase `sim/lib/invariants.js` checks the database (or in-memory) state. Throughout, the
lock-order checker (`server/services/lockOrder.js`) checks every transaction.

| Invariant | Meaning |
| :--- | :--- |
| `CAPACITY_BOUNDS` | 0 ≤ locked ≤ available ≤ total for every resource |
| `LOCKED_MISMATCH` | `locked_capacity` equals the units held by pending referrals |
| `DOUBLE_ALLOCATION` / `IN_USE_MISMATCH` | committed units never exceed total, and total − available equals the committed units (nothing leaked or counted twice) |
| `MULTIPLE_PENDING` / `MATCHING_STATE` / `ORPHAN_SOFT_LOCK` | a case has at most one pending referral; MATCHING means exactly one; no soft-lock without a referral |
| `ALLOCATION_HOSPITALS` / `ALLOCATION_COUNT` / `UNEXPECTED_ALLOCATION` / `TERMINAL_HOLDS` | allocated cases hold one unit per required type at exactly one hospital; others hold nothing |
| `MULTIPLE_AMBULANCES` / `AMBULANCE_STATE` / `AMBULANCE_STALE_ASSIGNMENT` | at most one on-road unit per case, only for allocated cases, none left on closed cases |

## Report contents

- **What ran:** scenario file, SHA-256 of the scenario and of the fixture, the **workload fingerprint**
  (SHA-256 of the plan) and the planned mix.
- **Where it ran:** commit (and whether the tree was dirty); Node, OS, CPU, RAM; MySQL version, case
  sensitivity, pool size, lock-wait timeout and isolation. No hostnames, usernames or credentials.
- **Per operation:** attempts, successes, refusals by reason, and latency p50/p95/p99/max.
- **Overall:** throughput, cases placed and allocated, deadlock retries, busy refusals, per-phase timings.
- **Safety:** invariant violations, lock-order violations (with the number of acquisitions checked) and
  unexpected errors, per run.
- **Spread:** every run's raw numbers, plus min / median / max across runs.

## Reproducibility and comparisons

- The workload is identical whenever the fingerprint is identical. `tests/sim_unit.test.js` pins the
  fingerprints of the committed scenarios. If plan generation must change, add a **new scenario
  version** instead of editing an existing one, so earlier baselines stay comparable.
- Which case wins a contested unit, the latencies, and the conflict counts depend on scheduling. That's
  why runs are repeated and reported with their spread. Compare medians and ranges, not single runs.
- To compare a later step with the baseline, rerun the **same scenario file** on the same machine and
  backend (`npm run sim:baseline -- --out sim/reports/<step>`), and compare against
  `sim/reports/step2-baseline/`. A changed fingerprint means the comparison is invalid.

## Limitations

- **Store level, not HTTP.** The harness calls the store interface in-process. Express, authentication,
  JSON parsing and the per-IP rate limiter are not part of the measured latency.
- **One client process.** Real parallelism is bounded by the pool size (`poolSize`, default 20)
  and by the single Node process issuing requests.
- **Checker overhead.** The lock-order checker adds a small overhead to every statement. It stays on,
  because the run's safety verdict depends on it.
- **Not portable.** Latencies are machine-specific. Baselines are only comparable on the same machine,
  MySQL version and configuration recorded in the report.
- **Expiry is forced.** Expiry is triggered by backdating the persisted lock time (MySQL) or calling
  the engine directly (in-memory), not by waiting 90 s.
