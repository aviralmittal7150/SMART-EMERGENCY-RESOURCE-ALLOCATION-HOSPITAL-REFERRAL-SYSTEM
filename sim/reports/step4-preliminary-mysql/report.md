# Stress harness report: mass-casualty v1 (Phase 3 Step 4 PRELIMINARY (battery power; not comparable to the AC baseline))

**Result: PASSED.** All runs: 0 invariant violations, 0 lock-order violations and 0 unexpected errors are required.

## What was run

| Item | Value |
| :--- | :--- |
| Scenario | `sim/scenarios/mass-casualty-v1.json` (seed 20261106, 120 cases, concurrency 24) |
| Scenario SHA-256 | `5555348842b8002d646c5857bf31698e6ac2953c3ced572231a361ce6e696e51` |
| Fixture SHA-256 | `acfba3c62e115cce2c2f647bfebfe781b3ccfd4aba31293b3e9b7513bb6f2e2c` |
| Workload fingerprint | `1d2074a8e526aa0d3e56666b59e91e8d47b008d4b3c2977fd8f6a8bc9fe22ce1` |
| Emergency types | CARDIAC 29, TRAUMA 30, RESPIRATORY 14, PEDIATRIC 5, STROKE 14, GENERAL 12, POLYTRAUMA 16 |
| Planned desk decisions | accept 84, expire 14, reject 22 |
| Planned outcomes | cancel 19, complete 59, keep 42 |
| Runs | 3 |

## Environment

- Commit `73f0398c9f1057aa6f827b4b845eddce4e4c7fcc` **(working tree had uncommitted changes; their SHA-256 `f61e2620e738d8e53a6e614cbe9ab5efb1cbbb185496d39f77da201b759b16eb`)**
- Node v22.20.0, darwin 27.0.0 (arm64), 8 × Apple M2, 16 GB RAM
- Backend: mysql, MySQL 9.6.0, lower_case_table_names=2, pool 20 connections, lock wait timeout 10s, READ-COMMITTED

## Results (median, with min–max across runs)

- Wall time: 170.2 (163.9–263.5) ms · throughput: 3577.9 (2295.9–3672.7) operations/s
- Cases that obtained a referral lock: 38 of 120 · allocated: 36 (36–37)
- Conflicts: deadlock retries 0 · busy refusals 0
- Time from intake to allocation: p50 120.98 (114.31–175.97) ms · p95 140.84 (134.12–195.08) ms
- Priority 1: share of cases never placed 0.7 · referral attempts refused as unsafe 0 (D4-a6)

| Operation | Attempts | OK | p50 ms | p95 ms | p99 ms | max ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| accept | 30 (29–30) | 30 (29–30) | 6.66 (6.43–8.44) | 11.03 (10.09–12.45) | 11.49 (10.23–13.66) | 11.49 (10.23–13.66) |
| accept_failover | 6 (6–8) | 6 (6–8) | 2.42 (2.19–2.63) | 3.62 (3.46–4.29) | 3.62 (3.46–4.29) | 3.62 (3.46–4.29) |
| cancel | 19 | 19 | 4.61 (3.32–5.01) | 8.49 (8.25–13) | 8.49 (8.25–13) | 8.49 (8.25–13) |
| complete | 19 (19–21) | 19 (19–21) | 5.09 (4.98–5.41) | 10.21 (9.66–11.87) | 10.21 (9.7–11.87) | 10.21 (9.7–11.87) |
| create | 120 | 120 | 3.73 (3.2–5.83) | 5.9 (4.98–32.54) | 6.84 (5.5–36.28) | 7.86 (5.81–38.06) |
| expire | 3 | 3 | 15.4 (14.49–16.19) | 18.7 (18.22–20.15) | 18.7 (18.22–20.15) | 18.7 (18.22–20.15) |
| initiate | 382 (381–384) | 38 | 2.98 (2.65–4.56) | 19.92 (17.58–25.15) | 32.23 (23.81–56.24) | 34.85 (25.18–56.47) |
| reject | 5 (5–6) | 5 (5–6) | 16.5 (16.25–16.59) | 19.06 (18.22–20.75) | 19.06 (18.22–20.75) | 19.06 (18.22–20.75) |
| treat | 19 (19–21) | 19 (19–21) | 2.96 (2.92–4.12) | 10.92 (9.36–13.9) | 10.92 (9.84–13.9) | 10.92 (9.84–13.9) |

## Refusals by reason (per run)

| Run | Operation | Reasons |
| ---: | :--- | :--- |
| 1 | initiate | hospital_closed 62, specialist_unavailable 194, no_capacity 90 |
| 2 | initiate | hospital_closed 62, specialist_unavailable 193, no_capacity 88 |
| 3 | initiate | hospital_closed 62, specialist_unavailable 193, no_capacity 89 |

## Safety checks (per run)

| Run | Invariant violations | Lock-order violations (acquisitions checked) | Unexpected errors | Final state |
| ---: | ---: | ---: | ---: | :--- |
| 1 | 0 | 0 (2395) | 0 | CANCELLED 19, WAITING 71, COMPLETED 19, ALLOCATED 11; units committed 19, soft-locked 0 |
| 2 | 0 | 0 (2379) | 0 | WAITING 70, ALLOCATED 12, COMPLETED 19, CANCELLED 19; units committed 21, soft-locked 0 |
| 3 | 0 | 0 (2443) | 0 | WAITING 69, CANCELLED 19, COMPLETED 21, ALLOCATED 11; units committed 19, soft-locked 0 |

## Measurement notes

- Latency is wall-clock time per store call measured in-process with performance.now(); it includes connection-pool queueing.
- The lock-order checker is installed during runs (small overhead on every SQL statement / in-memory lock).
- The workload is identical across runs (same fingerprint); which case wins a contested unit is not, hence the spread.
