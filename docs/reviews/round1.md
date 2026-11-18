# Review round 1: findings and dispositions

The reviewers were independent AI agents. Each was given the code and the intended design, not the implementer's
conclusions, and worked read-only on the frozen Phase 3 tree (digest `e7c43f93…`). Fixes go into
`ERIS-integration` only. Status values: **fix** (accepted, to implement), **done**, **decision** (the owner
decides), **doc** (documentation only), **defer** (reason given).

## Pre-existing gap found while triaging

| ID | Finding | Status |
|---|---|---|
| G0 | The published socket-scoping fix (`fix/realtime-socket-scoping`, d4fcd25) was never merged into the Phase 3 base, so every socket received network-wide audit, lock and KPI events | **done**: 3-way merged into `server/server.js` and `tests/socket_auth.test.js` (clean; tests pass) |

## (b) Audit chain, schema, migrations

| ID | Sev | Finding | Status |
|---|---|---|---|
| A1 | high | `db:init` on a database that already has `SchemaMigration` at a lower level records 004–006 as BASELINE without running their ALTERs | **fix**: refuse unless every migration is already recorded (point to `db:migrate`); `checkSchema` checks chain and stage columns |
| A2 | med-high | `event_time` (displayed and sorted) is not covered by the hash or checked against `event_time_ms` | **fix**: verification reports `EVENT_TIME_MISMATCH` |
| A3 | med | An unchained row inserted after chaining began passes as "legacy" | **fix**: `UNCHAINED_ROW` for any NULL-`chain_seq` row after the first chained row |
| A4 | low | Docs omit that the app's own credentials can append correctly hashed forged rows (no key) | **doc** |
| A5 | low | `verifyAuditChain` releases the connection without ROLLBACK on error | **fix** |
| A6 | low | Audit fields are not type-checked (a boolean hashes differently from how MySQL stores it) | **fix**: reject non-scalar fields early |
| A7 | low | Migrations README `--baseline` example is stale; `test:audit` runs the client ledger test only | **fix**: README; add `test:audit-chain` |

## (c) Store parity, analytics

| ID | Sev | Finding | Status |
|---|---|---|---|
| S1 | med | Seeded demo cases (REQ-8901..8903) are counted as observed demand | **fix**: `EmergencyRequest.is_demo` (migration 007), seeds set it, analytics excludes demo cases and their referrals |
| S2 | low-med | `listAudit` breaks ties oldest-first in memory and newest-first in MySQL | **fix** |
| S3 | low | Millisecond windows against second-precision MySQL timestamps can split the same event | **fix**: floor bounds to whole seconds (documented); `request_time` becomes `TIMESTAMP(3)` (007) |
| S4 | low | No index on `HospitalAcceptance.created_at`, though the docs claim one | **fix**: index in 007 |
| S5 | low | `addDoctor` response lacks `hospital_name` in memory | **fix** |
| S6 | low | Same-second queue ties are ordered by a random id on MySQL | **fix**: `TIMESTAMP(3)` `request_time` (007) |
| S7 | low | Idempotency keys are purged after 24 h only in MySQL; alert text is truncated only in MySQL; 409 messages differ; unknown analytics query parameters are silently ignored | **fix** |
| S-T | test | Tautological assertion in `analytics_routes.test.js`; the MySQL forecast assertion depends on shared DB content | **fix** |

## (d) APIs and security

| ID | Sev | Finding | Status |
|---|---|---|---|
| X1 | high | Sockets: every user joined `command_center` | **done** (G0) |
| X2 | high | Plaintext demo accounts active in every environment; bcrypt unused | **fix**: users in `SystemUser` with bcrypt hashes; demo accounts refused when `NODE_ENV=production` |
| X3 | high | Stored XSS: server strings rendered through `innerHTML`; CSP disabled | **fix** in the frontend phase: escape everywhere + strict CSP |
| X4 | med | Any paramedic can change any ambulance's status or unassign it | **fix**: paramedic accounts bound to an `ambulance_id`; only ADMIN and the owning desk otherwise |
| X5 | med | Inconsistent read scoping (`GET /hospitals` rosters, paramedic reads of all cases and referral history, `_visible` after any acceptance) | **fix**: one scoping policy for REST and sockets |
| X6 | med | Rate limits keyed by IP only, no `trust proxy`, sockets unthrottled | **fix** |
| X7 | low-med | Weak input validation (array query params → 500, objects stored, `age:""` → 0, boolean/exponent capacities, unbounded `rejection_reason`) | **fix**: strict validators, no new dependency unless needed |
| X8 | low | Memory request ids can be exhausted (9,000), so the loop hangs | **fix** |
| X9 | low | JWT `algorithms` not pinned, no minimum secret strength, hardcoded `expires_in` | **fix** |
| X10 | low | Dockerfile `node:20` + root; `.dockerignore` misses other `.env.*`; hardcoded API base URL | **fix** (URL in the frontend phase) |
| X11 | low | API inconsistencies: error shapes, 404 path, replay status, missing shift audit, idempotency key collation | **fix** |

## (a) Locking, concurrency, Banker's

The in-memory engine never awaits while it holds a lock, so the races below are reachable only through execution hooks or callers that skip the route checks. They are still real backend divergences, and the contract suite models real interleavings with those hooks.

| ID | Sev | Finding | Status |
|---|---|---|---|
| L1 | med | Memory engine grants a second referral to an ALLOCATED case (only the route pre-check prevents it), giving a double allocation across hospitals. MySQL refuses | **fix**: engine requires NEW/WAITING/MATCHING; the MATCHING write moves inside the synchronous lock section |
| L2 | med | Memory MATCHING→WAITING racing a rejection's failover leaves the case MATCHING with no lock; memory has no stranded-case recovery; docs claim the difference is harmless | **fix**: validate and write the transition inside the request lock (as MySQL does); add memory stranded-MATCHING recovery; correct `docs/lock-order.md` |
| L3 | med | Memory accept racing MATCHING→WAITING ends ALLOCATED while the audit says WAITING | **fix**: same as L2, and commit requires status MATCHING |
| L4 | low | Divergences: accept after expiry (memory allows until the timer fires), failover error handling, capacity clamp vs unguarded decrement, audit event names on reject/expire | **fix**: align on the MySQL behaviour and add parity tests |
| L-T1 | test | `concurrency_stress.test.js` passes with no mutex; it never calls the engine | **fix**: rewrite against the real engines, or relabel it |
| L-T2 | test | `locking.test.js`, `bankers.test.js` and `bankers_compound.test.js` test the browser modules (`js/`), not the server | **doc**: rename the scripts/labels; the server is covered by `bankers_engine` and the contract suites |
| L-T3 | test | No contract test for a transition racing an accept or a failover; "accept vs cancel" accepts a different winner per backend | **fix** |
| L-T4 | test | The MySQL lock-order checker records only per-table order (not key order within a level, nor JOIN tables) | **doc**: documented limitation; keep |
| L-T5 | test | Memory-only contract runs load `.env.local`, because `backends.js` imports the MySQL helper | **fix**: load lazily, only for the MySQL adapter |

## Batch 1: independent re-review findings (reviewer that did not write the batch)

| ID | Sev | Finding | Status |
|---|---|---|---|
| B1-R1 | med | After the G0 socket scoping, paramedics no longer get accept or timeout notices (`allocation:committed` and `lock:expired` now go to admins only); the UI also ignores `referral:accepted/rejected/expired` | **fix in batch 4**: per-requester socket room with a redacted event, plus frontend handlers. The security change stays |
| B1-R2 | low | A3 bypass: an unchained row inserted into an id gap below the first chained row counts as legacy | **fix**: legacy high-water mark and count recorded on `AuditChainHead` by 007 |
| B1-R3 | low | `docs/analytics.md` says nothing is adjusted, but bounds are floored; a sub-second window gets a misleading error | **fix** |
| B1-R4 | low | Same-millisecond queue ties: MySQL breaks them by `request_id`, memory by insertion order | **fix** |
| B1-R5 | info | Memory validates the audit entry after mutating its arrays (MySQL rolls back); no current caller is affected | **doc** |

## Batch 1 closure (2026-11-11)

- Second independent review of migration 007 and the verification logic: migration safety **PASS (conditional)**; verification logic **PASS with gaps**. Its test-gap finding (no test of the 007 "before the first chained row" boundary; that mutation survived) is **fixed**: a new MySQL test applies 001–006, writes chained rows and a late unchained row, then applies 007. The clean mutation now fails exactly that test. `verifyAuditChain` also reports `legacy_mark`.
- Accepted as known limitations, not fixed: ledgers with a late unchained row turn invalid after 007; deleting a case corrupts the chain (FK `ON DELETE SET NULL`, pre-existing since 006; no route deletes cases); in memory, legacy rows are identified by array position; MySQL 8.4 is not verified locally (the local server is 9.6; Linux CI covers 8.4).
- Final verification (guard-clean, exit 0): full suite 437/437, `test:mysql` 155/155, migrations 34/34, `sim:smoke` PASSED. Digest `83d8fb9c…`.

## Batches

1. Audit / migrations / stores / analytics (A1–A7, S1–S7, S-T): implementer running.
2. Locking parity (L1–L4, L-T1, L-T3, L-T5): after batch 1, because it shares `memoryStore.js`.
3. Security and API (X2, X4–X11): after batch 2, because it shares routes and stores.
4. Frontend wiring + XSS/CSP (X3, X10 URL) + the inventory items.

A fresh reviewer re-reviews each batch.
