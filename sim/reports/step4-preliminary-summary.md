# Phase 3 Step 4: preliminary harness results (NOT a performance comparison)

**Status: preliminary.** Measured on 2026-11-07 on **battery power**. The Step 2 baseline was measured on AC
power, and the Step 3 benchmark against that baseline is still pending. The timings below must not be read as
a performance comparison. The functional results (placements, refusal reasons, safety) do not depend on power.

- Workload: `sim/scenarios/mass-casualty-v1.json`, fingerprint `1d2074a8…22ce1`, identical to the baseline,
  3 runs per backend, run with the exact Step 2 command.
- Baseline files unchanged: `step2-baseline-mysql/report.json` `102b2f98…`, `step2-baseline-memory/report.json` `73c7cecb…`.
- Generated comparisons (environment differences listed): `step4-preliminary-comparison-{mysql,memory}/comparison.md`.
- The candidate includes the Step 3 changes (per-hospital lock, exclusive trauma surgeon) as well as Step 4,
  so a difference against the Step 2 baseline cannot be attributed to Step 4 alone.

## Functional results (both backends, every run)

| | Step 2 baseline | Step 4 (preliminary) |
| :--- | :--- | :--- |
| Cases placed / 120 | 38 | 38 |
| Cases allocated (median) | MySQL 36, memory 35 | MySQL 36, memory 36 |
| Referral refusals per run: no capacity | ~175 | 89 |
| Referral refusals per run: specialist unavailable | ~107 | ~193 |
| Referral refusals per run: hospital closed | 62 | 62 |
| Referral refusals per run: unsafe (Banker's) | (did not exist) | 0 |
| P1 cases never placed | (not recorded) | 0.7 (70%) |
| Invariant / lock-order violations | 0 / 0 | 0 / 0 (incl. the new BANKER_UNSAFE and CLAIM_EXCEEDED) |
| Deadlock retries / busy refusals | 0 / 0 | 0 / 0 |

**Reading it.** The admission bottleneck (ICU beds) is unchanged, so 38 cases are placed either way. The refusal
mix moved: TRAUMA/POLYTRAUMA stage 1 no longer soft-locks an ICU bed (D2-B), so fewer attempts fail on ICU
capacity. More attempts now fail on the trauma surgeon, who is exclusive since Step 3 (D3-B). The Banker's check
refused nothing in this workload: every admission it saw left its hospital safe. It is exercised by the contract
suites, not by this scenario. The 70% P1 not-placed share is driven by capacity and specialists, not by unsafe
refusals (0). These are the D4-a6 inputs for judging a future override.

## Timings (battery, not comparable)

MySQL median p50 / p95 per operation, baseline → Step 4: initiate 3.25 / 12.98 → 2.98 / 19.92 ms;
accept 5.49 / 15.04 → 6.66 / 11.03 ms; complete 4.58 / 8.74 → 5.09 / 10.21 ms. In-memory figures are in
the comparison files. Rerun on AC, after the Step 3 benchmark, before drawing conclusions.
