# Stress harness report: mass-casualty v1 (Phase 3 Step 2 baseline (in-memory reference))

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
- Backend: memory

## Results (median, with min–max across runs)

- Wall time: 13.3 (11.1–22.2) ms · throughput: 45046.2 (26958.7–54039.6) operations/s
- Cases that obtained a referral lock: 38 of 120 · allocated: 35
- Conflicts: deadlock retries 0 · busy refusals 0

| Operation | Attempts | OK | p50 ms | p95 ms | p99 ms | max ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| accept | 29 | 29 | 0.36 (0.24–1.39) | 0.44 (0.31–1.46) | 0.44 (0.31–1.51) | 0.44 (0.31–1.51) |
| accept_failover | 6 | 6 | 0.05 (0.05–0.06) | 0.06 (0.05–0.07) | 0.06 (0.05–0.07) | 0.06 (0.05–0.07) |
| cancel | 19 | 19 | 0.12 (0.12–0.13) | 0.22 (0.15–0.67) | 0.22 (0.15–0.67) | 0.22 (0.15–0.67) |
| complete | 17 | 17 | 0.15 (0.13–0.21) | 0.17 (0.14–0.38) | 0.17 (0.14–0.38) | 0.17 (0.14–0.38) |
| create | 120 | 120 | 0.08 (0.06–0.08) | 0.17 (0.1–0.43) | 0.18 (0.12–0.44) | 0.18 (0.12–0.68) |
| expire | 3 | 3 | 0.48 (0.47–0.98) | 0.52 (0.48–1.44) | 0.52 (0.48–1.44) | 0.52 (0.48–1.44) |
| initiate | 381 | 38 | 0.38 (0.38–0.55) | 1.55 (0.97–2.18) | 2.95 (1.26–3.12) | 3.33 (1.49–3.74) |
| reject | 6 | 6 | 0.25 (0.21–0.28) | 0.48 (0.36–1.54) | 0.48 (0.36–1.54) | 0.48 (0.36–1.54) |
| treat | 17 | 17 | 0.03 (0.03–0.1) | 0.06 (0.05–0.16) | 0.06 (0.05–0.16) | 0.06 (0.05–0.16) |

## Refusals by reason (per run)

| Run | Operation | Reasons |
| ---: | :--- | :--- |
| 1 | initiate | specialist_unavailable 107, hospital_closed 62, no_capacity 174 |
| 2 | initiate | specialist_unavailable 107, hospital_closed 62, no_capacity 174 |
| 3 | initiate | specialist_unavailable 107, hospital_closed 62, no_capacity 174 |

## Safety checks (per run)

| Run | Invariant violations | Lock-order violations (acquisitions checked) | Unexpected errors | Final state |
| ---: | ---: | ---: | ---: | :--- |
| 1 | 0 | 0 (695) | 0 | CANCELLED 19, COMPLETED 17, ALLOCATED 13, WAITING 71; units committed 23, soft-locked 0 |
| 2 | 0 | 0 (695) | 0 | CANCELLED 19, COMPLETED 17, ALLOCATED 13, WAITING 71; units committed 23, soft-locked 0 |
| 3 | 0 | 0 (695) | 0 | CANCELLED 19, COMPLETED 17, ALLOCATED 13, WAITING 71; units committed 23, soft-locked 0 |

## Measurement notes

- Latency is wall-clock time per store call measured in-process with performance.now(); it includes connection-pool queueing.
- The lock-order checker is installed during runs (small overhead on every SQL statement / in-memory lock).
- The workload is identical across runs (same fingerprint); which case wins a contested unit is not, hence the spread.
