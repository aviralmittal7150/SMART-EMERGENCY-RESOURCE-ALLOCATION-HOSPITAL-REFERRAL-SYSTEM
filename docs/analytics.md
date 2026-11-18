# Historical analytics and forecasting (Phase 3 Step 6)

Decisions D8-A (real events only, `insufficient_data` below a minimum sample) and D8b-A (seeded hospital values stay
configured ranking priors). Code: `server/services/analyticsEngine.js` (pure arithmetic), `getAnalyticsHistory` in
`server/db/memoryStore.js` and `server/db/mysqlStore.js` (rows), routes in `server/routes/analytics.js`.

## Endpoints

Both are new and **ADMIN only**. The four existing endpoints (`/dashboard`, `/referrals`, `/audit`, `/resources`)
are unchanged and keep their response shapes (D8-a8); `tests/analytics_routes.test.js` pins those shapes.

| Endpoint | Returns | Query (all optional) |
|---|---|---|
| `GET /api/v1/analytics/history` | `history`, kind `observed` | `from_ms` and `to_ms` (epoch ms), or `days` (1–366, default 28) ending at `to_ms` (default now) |
| `GET /api/v1/analytics/forecast` | `forecast`, kind `forecast` | `as_of_ms` (default now), `history_days` (1–366, default 28), `horizon_days` (1–14, default 7) |

History bounds are floored to whole seconds (see Time below: it keeps the two stores in agreement), and the response
echoes the floored window. That is the only adjustment; every other invalid input is answered `400` with a reason. An
unknown query parameter is invalid input too (`400`, naming it and the allowed ones): a misspelt bound such as `from=`
must not quietly fall back to the default window. Bounds that are in order but fall in the same second are refused
(`400`, "the window must span at least one whole second after flooring to seconds") rather than widened. The 366-day and 14-day limits protect the server; they are input bounds, not statistical thresholds.

## Time

- Every window is resolved **on the server, in epoch milliseconds**, and is half-open: `[from_ms, to_ms)`. An event
  at `from_ms` counts; an event at `to_ms` does not.
- History bounds are **floored to whole seconds** (`from_ms=1770000000700` becomes `1770000000000`), and the response
  echoes the floored window. Why: `HospitalAcceptance.created_at` (and `responded_at`) is stored to the second on
  MySQL, truncated by `CURRENT_TIMESTAMP`, while the in-memory store keeps milliseconds. For a whole-second bound B,
  `t >= B` and `t < B` give the same answer for t and for t truncated to its second, so both stores place every event
  on the same side of each bound. A millisecond bound could split one event between the stores. Forecast bounds are
  UTC midnights, so already whole seconds.
- Days are **UTC** calendar days. A day the window only partly covers is marked `partial: true`.
- MySQL returns times as epoch values (`UNIX_TIMESTAMP`), which do not depend on the session time zone. The SQL range
  is widened by one day so it can use the indexes (`EmergencyRequest.idx_request_time`, and
  `HospitalAcceptance.idx_created_at`, added by migration 007), and the exact window is then applied in milliseconds, so time-zone
  or daylight-saving conversion cannot move a boundary.
- All MySQL reads of one report run in a single read-only consistent snapshot, so capacity, allocations and referrals
  agree with each other.
- Precision: since migration 007, `EmergencyRequest.request_time` is `TIMESTAMP(3)` (milliseconds) on MySQL, as in
  memory. Referral times (`HospitalAcceptance.created_at` / `responded_at`) stay whole seconds on MySQL, so referral
  response times can differ by under a second between the stores. Audit events carry `event_time_ms` on both
  (pre-chain MySQL rows fall back to `event_time`).

## Demo cases

The demo seed's three fictional cases (`REQ-8901`..`8903`) are marked `is_demo` (migration 007 on MySQL, the seed in
memory). Observed history and forecasts leave out demo cases, their referrals and their audit timings: a fresh demo
database reports zero observed cases. Current capacity (`hospitals[].current`) is the live state and is not filtered.

## Observed history (`kind: 'observed'`)

| Section | Source | Definition |
|---|---|---|
| `demand` | `EmergencyRequest` created in the window | cases per UTC day (zero-filled), by emergency type, priority, location cell, and resource units requested |
| `demand.by_location` | pickup coordinates | 0.01-degree cell named by its south-west corner (`"30.31,78.04"`); missing coordinates count as `"unknown"` (D8-a6). Snapped on integer 1e-7-degree units, because floating point puts 30.33 in the 30.32 cell (30.33 / 0.01 = 3032.9999999999995) |
| `response_times.referral_response_sec` | `HospitalAcceptance` created in the window | `responded_at − created_at` of ACCEPTED and REJECTED referrals (D8-a5) |
| `response_times.referrals_timed_out` | same | EXPIRED referrals: counted, never treated as a response time |
| `response_times.intake_to_allocation_sec` | audit events | first `REQUEST_CREATED` to first `ALLOCATION_COMMITTED` of each case created in the window |
| `hospitals[].referrals` | `HospitalAcceptance` | received, accepted, rejected, expired, pending, cancelled |
| `hospitals[].observed_acceptance_rate` | same | accepted ÷ (accepted + rejected + expired). PENDING is undecided; CANCELLED means the case ended before the hospital could decide |
| `hospitals[].current` | `MedicalResource`, `ResourceAllocation` | **current state** (not windowed): capacity `total / in_use / soft_locked / free`, and cases with committed allocations |
| `hospitals[].configured_ranking_prior` | `Hospital.acceptance_rate`, `avg_response_sec` | seeded configuration used to rank failover candidates (D8b). **Never an observation** |
| `all_hospitals` | all of the above | totals across hospitals; referral counts and capacity equal the sum of the per-hospital figures |

Not recorded, so not reported: ambulance travel and arrival times (there is no arrival timestamp).

## Minimum samples (D8-a2)

| Statistic | Minimum | Below it |
|---|---|---|
| Forecast | 14 days of history **and** 30 events | `{ status: 'insufficient_data', sample: { days, events, first_day, last_day }, required }` |
| Percentiles (p50, p90, p95), and with them mean, min, max | 20 observations | `{ status: 'insufficient_data', sample_size, required: 20 }` |
| Observed acceptance rate | 20 decided referrals | same |

These are configured policy, not statistical facts. Applying the 20-observation minimum to means and acceptance rates
(not only to percentiles) is an extension of D8-a2 that needs approval.

Percentiles use the nearest-rank method: the value at rank `ceil(p/100 × n)` of the sorted sample.

## Forecast (`kind: 'forecast'`)

- **Series:** cases per day, and resource units requested per day for each resource type.
- **History:** the `history_days` complete UTC days before `as_of_ms`. The day containing `as_of_ms` is excluded,
  because a partial day would read as low demand. History **starts at the first recorded case in the window**: days
  before the first case are not evidence of zero demand, so they do not count towards the 14-day minimum.
- **Method (D8-a4):** seasonal-naive (the same weekday last week) and the 7-day moving average. Both are back-tested on
  the last 7 observed days, against the naive baseline (the previous day), by mean absolute error. A tie with the
  baseline is reported as not better. No dependencies were added.
- **Assumptions** (returned with every forecast): weekly repetition or a stable recent level; no external drivers
  (events, weather, holidays); UTC days.
- **Not forecast:** resource *availability*. That needs a length-of-stay / release-time model, which is not built.
  The forecast covers resource *demand* (units requested), and current free capacity is in the observed report.

## Tests

| File | What it proves |
|---|---|
| `tests/analytics_engine.test.js` | hand-derived values: percentiles, gating at 19/20, grid cells (including the float trap), window parsing and validation (whole-second flooring, unknown parameters), half-open boundaries, partial days, tallies, response times, rates, totals = sum of hospitals, forecast back-test errors (0 / 2.041 / 2.286), the 13-day and 29-event cut-offs, ties, the as_of day exclusion and history trimming |
| `tests/contract/analytics.contract.js` | **parity**: the same stored rows give the same hand-derived report on the in-memory store and on MySQL, including exact epoch-ms round-trips, both window boundaries, two recorded weeks for the forecast, an empty ledger, and a real case/referral/allocation; reading analytics leaves the audit chain unchanged |
| `tests/analytics_routes.test.js` | HTTP on the in-memory store: ADMIN only, server-side window, 400 on invalid input, observed and forecast kept apart, priors only as labelled configuration, existing endpoint shapes unchanged |
| `tests/mysql_routes.test.js` | the real server on MySQL: `/history` agrees with SQL counts for the same window, priors match the `Hospital` row, capacity totals match `MedicalResource` |

Fixtures are explicit rows inside the tests, in the in-memory store or the `*_test` database. Nothing is added to the
demo seed (D8-a7).

## Limitations

- With today's data almost every statistic is `insufficient_data`. That is the intended behaviour under D8-A.
- `/analytics/referrals` and `/analytics/dashboard` keep their earlier definitions (D8-a8). `acceptance_rate` there is
  an ungated percentage whose denominator includes PENDING, and `avg_referral_response_sec` is 0 when nothing is
  recorded. The new `/history` report is the gated, documented version.
- `/history` and `/forecast` are ADMIN only; a per-hospital view for hospital desks is not built.
- Each report is computed on request from raw rows; nothing is cached or pre-aggregated. A 366-day window over a
  large ledger has not been benchmarked.
- History windows use the time a referral was *created*, so a referral created just before `from_ms` and answered
  inside the window is not counted.
