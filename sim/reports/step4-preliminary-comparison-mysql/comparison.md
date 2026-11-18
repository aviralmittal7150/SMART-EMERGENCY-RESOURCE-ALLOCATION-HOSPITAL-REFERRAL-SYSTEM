# Harness comparison: mass-casualty v1 (mysql)

- Workload fingerprint (identical in both): `1d2074a8e526aa0d3e56666b59e91e8d47b008d4b3c2977fd8f6a8bc9fe22ce1`
- Baseline: Phase 3 Step 2 baseline — 3 runs, 2026-11-06T10:52:42.443Z, commit `c5b1b741a59a6426db861b9b9a2a7194fff77e4f`
- Candidate: Phase 3 Step 4 PRELIMINARY (battery power; not comparable to the AC baseline) — 3 runs, 2026-11-07T13:15:55.196Z, commit `73f0398c9f1057aa6f827b4b845eddce4e4c7fcc` (dirty; tree SHA-256 `f61e2620e738d8e53a6e614cbe9ab5efb1cbbb185496d39f77da201b759b16eb`)

## Environment

**Not identical.** Differences are marked; weigh the numbers below accordingly.

| Field | Baseline | Candidate | Same |
| :--- | :--- | :--- | :---: |
| node | v22.20.0 | v22.20.0 | yes |
| platform | darwin 27.0.0 | darwin 27.0.0 | yes |
| arch | arm64 | arm64 | yes |
| cpuModel | Apple M2 | Apple M2 | yes |
| cpuCount | 8 | 8 | yes |
| memoryGb | 16 | 16 | yes |
| powerSource | — | Battery Power | **no** |
| backend.backend | mysql | mysql | yes |
| backend.mysqlVersion | 9.6.0 | 9.6.0 | yes |
| backend.lowerCaseTableNames | 2 | 2 | yes |
| backend.databaseIsTest | true | true | yes |
| backend.poolSize | 20 | 20 | yes |
| backend.sessionLockWaitTimeoutSec | 10 | 10 | yes |
| backend.engineIsolation | READ-COMMITTED | READ-COMMITTED | yes |

## Headline (min / **median** / max across runs; delta of medians)

| Metric | Baseline | Candidate | Δ median |
| :--- | :--- | :--- | :--- |
| throughputOpsPerSec | 2920.6 / **4981.8** / 5197.1 | 2295.9 / **3577.9** / 3672.7 | -1403.9 (-28.2%) |
| wallMs | 116.6 / **121.4** / 206.1 | 163.9 / **170.2** / 263.5 | +48.8 (+40.2%) |
| casesPlaced | 38 / **38** / 38 | 38 / **38** / 38 | +0 (+0%) |
| casesAllocated | 36 / **36** / 37 | 36 / **36** / 37 | +0 (+0%) |
| deadlockRetries | 0 / **0** / 0 | 0 / **0** / 0 | +0 |
| busyRefusals | 0 / **0** / 0 | 0 / **0** / 0 | +0 |
| lockAcquisitionsChecked | 2406 | 2395 | -11 (-0.5%) |

## Per operation (medians across runs)

| Operation | Attempts b→c | OK b→c | p50 ms b→c | p95 ms b→c | p99 ms b→c | max ms b→c |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| accept | 29 → 30 | 29 → 30 | 5.49 → 6.66 | 15.04 → 11.03 | 15.76 → 11.49 | 15.76 → 11.49 |
| accept_failover | 8 → 6 | 8 → 6 | 2.1 → 2.42 | 3.29 → 3.62 | 3.29 → 3.62 | 3.29 → 3.62 |
| cancel | 19 → 19 | 19 → 19 | 3.93 → 4.61 | 6.36 → 8.49 | 6.36 → 8.49 | 6.36 → 8.49 |
| complete | 19 → 19 | 19 → 19 | 4.58 → 5.09 | 8.74 → 10.21 | 8.74 → 10.21 | 8.74 → 10.21 |
| create | 120 → 120 | 120 → 120 | 3.35 → 3.73 | 4.99 → 5.9 | 5.9 → 6.84 | 7.55 → 7.86 |
| expire | 3 → 3 | 3 → 3 | 15.89 → 15.4 | 17.73 → 18.7 | 17.73 → 18.7 | 17.73 → 18.7 |
| initiate | 382 → 382 | 38 → 38 | 3.25 → 2.98 | 12.98 → 19.92 | 17.94 → 32.23 | 20.63 → 34.85 |
| reject | 6 → 5 | 6 → 5 | 11.24 → 16.5 | 15.9 → 19.06 | 15.9 → 19.06 | 15.9 → 19.06 |
| treat | 19 → 19 | 19 → 19 | 2.65 → 2.96 | 4.77 → 10.92 | 4.77 → 10.92 | 4.77 → 10.92 |

## Refusals per run, by reason (mean across runs)

| Operation | Baseline | Candidate |
| :--- | :--- | :--- |
| initiate | {"hospital_closed":62,"specialist_unavailable":107.3,"no_capacity":175} | {"hospital_closed":62,"specialist_unavailable":193.3,"no_capacity":89} |

## Phase wall time (ms, medians)

| Phase | Baseline | Candidate | Δ |
| :--- | :--- | :--- | :--- |
| intake | 17.3 | 20.4 | +3.1 (+17.9%) |
| referral | 67 | 94.4 | +27.4 (+40.9%) |
| decision | 23.2 | 29.4 | +6.2 (+26.7%) |
| discharge | 11.6 | 17.6 | +6 (+51.7%) |

## Final state (medians) and safety

- Final state: baseline {"unitsCommitted":23,"unitsSoftLocked":0,"ambulancesOnRoad":4}; candidate {"unitsCommitted":19,"unitsSoftLocked":0,"ambulancesOnRoad":3}
- Safety per run, baseline: [{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true}]
- Safety per run, candidate: [{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true}]
