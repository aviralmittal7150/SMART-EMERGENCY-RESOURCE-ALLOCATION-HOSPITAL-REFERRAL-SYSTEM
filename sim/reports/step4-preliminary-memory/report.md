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
- Backend: memory

## Results (median, with min–max across runs)

- Wall time: 21.6 (18.5–31.9) ms · throughput: 28063.3 (18973.4–32669.8) operations/s
- Cases that obtained a referral lock: 38 of 120 · allocated: 36
- Conflicts: deadlock retries 0 · busy refusals 0
- Time from intake to allocation: p50 16.9 (15.66–25.13) ms · p95 18.39 (16.58–26.37) ms
- Priority 1: share of cases never placed 0.7 · referral attempts refused as unsafe 0 (D4-a6)

| Operation | Attempts | OK | p50 ms | p95 ms | p99 ms | max ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| accept | 29 | 29 | 0.43 (0.28–0.98) | 0.46 (0.3–1.08) | 0.47 (0.3–1.12) | 0.47 (0.3–1.12) |
| accept_failover | 7 | 7 | 0.06 (0.06–0.12) | 0.07 (0.06–0.13) | 0.07 (0.06–0.13) | 0.07 (0.06–0.13) |
| cancel | 19 | 19 | 0.13 (0.12–0.14) | 0.24 (0.18–0.84) | 0.24 (0.18–0.84) | 0.24 (0.18–0.84) |
| complete | 20 | 20 | 0.17 (0.15–0.27) | 0.2 (0.16–0.48) | 0.2 (0.16–0.49) | 0.2 (0.16–0.49) |
| create | 120 | 120 | 0.09 (0.09–0.1) | 0.17 (0.16–1.06) | 0.22 (0.18–1.34) | 0.22 (0.19–1.9) |
| expire | 3 | 3 | 0.82 (0.7–1.11) | 1.62 (1.01–1.78) | 1.62 (1.01–1.78) | 1.62 (1.01–1.78) |
| initiate | 382 | 38 | 0.41 (0.38–0.59) | 2.74 (2.6–3.95) | 3.55 (3.39–6.19) | 4.55 (3.48–8.34) |
| reject | 6 | 6 | 0.94 (0.75–1.24) | 1.26 (0.81–1.49) | 1.26 (0.81–1.49) | 1.26 (0.81–1.49) |
| treat | 20 | 20 | 0.04 (0.03–0.06) | 0.07 (0.05–0.17) | 0.08 (0.05–0.21) | 0.08 (0.05–0.21) |

## Refusals by reason (per run)

| Run | Operation | Reasons |
| ---: | :--- | :--- |
| 1 | initiate | specialist_unavailable 193, hospital_closed 62, no_capacity 89 |
| 2 | initiate | specialist_unavailable 193, hospital_closed 62, no_capacity 89 |
| 3 | initiate | specialist_unavailable 193, hospital_closed 62, no_capacity 89 |

## Safety checks (per run)

| Run | Invariant violations | Lock-order violations (acquisitions checked) | Unexpected errors | Final state |
| ---: | ---: | ---: | ---: | :--- |
| 1 | 0 | 0 (823) | 0 | CANCELLED 19, COMPLETED 20, ALLOCATED 11, WAITING 70; units committed 19, soft-locked 0 |
| 2 | 0 | 0 (823) | 0 | CANCELLED 19, COMPLETED 20, ALLOCATED 11, WAITING 70; units committed 19, soft-locked 0 |
| 3 | 0 | 0 (823) | 0 | CANCELLED 19, COMPLETED 20, ALLOCATED 11, WAITING 70; units committed 19, soft-locked 0 |

## Measurement notes

- Latency is wall-clock time per store call measured in-process with performance.now(); it includes connection-pool queueing.
- The lock-order checker is installed during runs (small overhead on every SQL statement / in-memory lock).
- The workload is identical across runs (same fingerprint); which case wins a contested unit is not, hence the spread.
