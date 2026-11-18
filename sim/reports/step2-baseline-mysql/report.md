# Stress harness report: mass-casualty v1 (Phase 3 Step 2 baseline)

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

- Commit `c5b1b741a59a6426db861b9b9a2a7194fff77e4f`
- Node v22.20.0, darwin 27.0.0 (arm64), 8 × Apple M2, 16 GB RAM
- Backend: mysql, MySQL 9.6.0, lower_case_table_names=2, pool 20 connections, lock wait timeout 10s, READ-COMMITTED

## Results (median, with min–max across runs)

- Wall time: 121.4 (116.6–206.1) ms · throughput: 4981.8 (2920.6–5197.1) operations/s
- Cases that obtained a referral lock: 38 of 120 · allocated: 36 (36–37)
- Conflicts: deadlock retries 0 · busy refusals 0

| Operation | Attempts | OK | p50 ms | p95 ms | p99 ms | max ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| accept | 29 (28–29) | 29 (28–29) | 5.49 (4.33–8.3) | 15.04 (10.2–17.14) | 15.76 (11.31–18.3) | 15.76 (11.31–18.3) |
| accept_failover | 8 (7–8) | 8 (7–8) | 2.1 (1.75–2.25) | 3.29 (2.75–3.31) | 3.29 (2.75–3.31) | 3.29 (2.75–3.31) |
| cancel | 19 | 19 | 3.93 (3.45–5.77) | 6.36 (6.04–9.17) | 6.36 (6.04–9.17) | 6.36 (6.04–9.17) |
| complete | 19 (18–19) | 19 (18–19) | 4.58 (3.68–6.01) | 8.74 (7.36–10.16) | 8.74 (7.36–10.16) | 8.74 (7.36–10.16) |
| create | 120 | 120 | 3.35 (2.69–4.87) | 4.99 (4.63–38.55) | 5.9 (5.53–40.17) | 7.55 (5.95–43.82) |
| expire | 3 | 3 | 15.89 (12.17–16.99) | 17.73 (14.87–19.67) | 17.73 (14.87–19.67) | 17.73 (14.87–19.67) |
| initiate | 382 (382–383) | 38 | 3.25 (3.09–4.52) | 12.98 (11.65–17.96) | 17.94 (14.59–25.72) | 20.63 (18.07–30.34) |
| reject | 6 (6–7) | 6 (6–7) | 11.24 (10–14.25) | 15.9 (12.58–20.26) | 15.9 (12.58–20.26) | 15.9 (12.58–20.26) |
| treat | 19 (18–19) | 19 (18–19) | 2.65 (2.2–4.3) | 4.77 (3.97–6.65) | 4.77 (3.97–6.65) | 4.77 (3.97–6.65) |

## Refusals by reason (per run)

| Run | Operation | Reasons |
| ---: | :--- | :--- |
| 1 | initiate | hospital_closed 62, specialist_unavailable 107, no_capacity 175 |
| 2 | initiate | specialist_unavailable 107, hospital_closed 62, no_capacity 175 |
| 3 | initiate | specialist_unavailable 108, hospital_closed 62, no_capacity 175 |

## Safety checks (per run)

| Run | Invariant violations | Lock-order violations (acquisitions checked) | Unexpected errors | Final state |
| ---: | ---: | ---: | ---: | :--- |
| 1 | 0 | 0 (2377) | 0 | WAITING 70, CANCELLED 19, COMPLETED 18, ALLOCATED 13; units committed 23, soft-locked 0 |
| 2 | 0 | 0 (2406) | 0 | WAITING 69, CANCELLED 19, COMPLETED 19, ALLOCATED 13; units committed 23, soft-locked 0 |
| 3 | 0 | 0 (2424) | 0 | WAITING 70, ALLOCATED 12, CANCELLED 19, COMPLETED 19; units committed 21, soft-locked 0 |

## Measurement notes

- Latency is wall-clock time per store call measured in-process with performance.now(); it includes connection-pool queueing.
- The lock-order checker is installed during runs (small overhead on every SQL statement / in-memory lock).
- The workload is identical across runs (same fingerprint); which case wins a contested unit is not, hence the spread.
