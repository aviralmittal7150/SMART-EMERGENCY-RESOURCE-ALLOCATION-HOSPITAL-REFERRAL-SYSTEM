# Harness comparison: mass-casualty v1 (memory)

- Workload fingerprint (identical in both): `1d2074a8e526aa0d3e56666b59e91e8d47b008d4b3c2977fd8f6a8bc9fe22ce1`
- Baseline: Phase 3 Step 2 baseline (in-memory reference) — 3 runs, 2026-11-06T10:52:42.603Z, commit `c5b1b741a59a6426db861b9b9a2a7194fff77e4f`
- Candidate: Phase 3 Step 4 PRELIMINARY (battery power; not comparable to the AC baseline) — 3 runs, 2026-11-07T13:15:58.423Z, commit `73f0398c9f1057aa6f827b4b845eddce4e4c7fcc` (dirty; tree SHA-256 `f61e2620e738d8e53a6e614cbe9ab5efb1cbbb185496d39f77da201b759b16eb`)

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
| backend.backend | memory | memory | yes |
| backend.database | in-memory demo store | in-memory demo store | yes |

## Headline (min / **median** / max across runs; delta of medians)

| Metric | Baseline | Candidate | Δ median |
| :--- | :--- | :--- | :--- |
| throughputOpsPerSec | 26958.7 / **45046.2** / 54039.6 | 18973.4 / **28063.3** / 32669.8 | -16982.9 (-37.7%) |
| wallMs | 11.1 / **13.3** / 22.2 | 18.5 / **21.6** / 31.9 | +8.3 (+62.4%) |
| casesPlaced | 38 / **38** / 38 | 38 / **38** / 38 | +0 (+0%) |
| casesAllocated | 35 / **35** / 35 | 36 / **36** / 36 | +1 (+2.9%) |
| deadlockRetries | 0 / **0** / 0 | 0 / **0** / 0 | +0 |
| busyRefusals | 0 / **0** / 0 | 0 / **0** / 0 | +0 |
| lockAcquisitionsChecked | 695 | 823 | +128 (+18.4%) |

## Per operation (medians across runs)

| Operation | Attempts b→c | OK b→c | p50 ms b→c | p95 ms b→c | p99 ms b→c | max ms b→c |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| accept | 29 → 29 | 29 → 29 | 0.36 → 0.43 | 0.44 → 0.46 | 0.44 → 0.47 | 0.44 → 0.47 |
| accept_failover | 6 → 7 | 6 → 7 | 0.05 → 0.06 | 0.06 → 0.07 | 0.06 → 0.07 | 0.06 → 0.07 |
| cancel | 19 → 19 | 19 → 19 | 0.12 → 0.13 | 0.22 → 0.24 | 0.22 → 0.24 | 0.22 → 0.24 |
| complete | 17 → 20 | 17 → 20 | 0.15 → 0.17 | 0.17 → 0.2 | 0.17 → 0.2 | 0.17 → 0.2 |
| create | 120 → 120 | 120 → 120 | 0.08 → 0.09 | 0.17 → 0.17 | 0.18 → 0.22 | 0.18 → 0.22 |
| expire | 3 → 3 | 3 → 3 | 0.48 → 0.82 | 0.52 → 1.62 | 0.52 → 1.62 | 0.52 → 1.62 |
| initiate | 381 → 382 | 38 → 38 | 0.38 → 0.41 | 1.55 → 2.74 | 2.95 → 3.55 | 3.33 → 4.55 |
| reject | 6 → 6 | 6 → 6 | 0.25 → 0.94 | 0.48 → 1.26 | 0.48 → 1.26 | 0.48 → 1.26 |
| treat | 17 → 20 | 17 → 20 | 0.03 → 0.04 | 0.06 → 0.07 | 0.06 → 0.08 | 0.06 → 0.08 |

## Refusals per run, by reason (mean across runs)

| Operation | Baseline | Candidate |
| :--- | :--- | :--- |
| initiate | {"specialist_unavailable":107,"hospital_closed":62,"no_capacity":174} | {"specialist_unavailable":193,"hospital_closed":62,"no_capacity":89} |

## Phase wall time (ms, medians)

| Phase | Baseline | Candidate | Δ |
| :--- | :--- | :--- | :--- |
| intake | 0.9 | 1 | +0.1 (+11.1%) |
| referral | 10.7 | 13.8 | +3.1 (+29%) |
| decision | 0.8 | 2.1 | +1.3 (+162.5%) |
| discharge | 0.5 | 0.7 | +0.2 (+40%) |

## Final state (medians) and safety

- Final state: baseline {"unitsCommitted":23,"unitsSoftLocked":0,"ambulancesOnRoad":5}; candidate {"unitsCommitted":19,"unitsSoftLocked":0,"ambulancesOnRoad":5}
- Safety per run, baseline: [{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true}]
- Safety per run, candidate: [{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true},{"invariantViolations":0,"lockOrderViolations":0,"unexpectedErrors":0,"passed":true}]
