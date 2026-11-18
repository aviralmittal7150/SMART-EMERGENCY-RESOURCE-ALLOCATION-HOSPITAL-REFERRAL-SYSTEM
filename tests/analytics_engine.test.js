// Analytics engine (server/services/analyticsEngine.js, Phase 3 Step 6): pure functions, no database. Every expected
// value below is derived by hand in the comment next to it, not computed with the code under test. Fictional data.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, DAY_MS, AnalyticsInputError, percentile, summarizeSample, gatedRate, gridCell, resolveHistoryWindow,
  resolveForecastWindow, dailyBuckets, demandTrends, responseTimes, hospitalPerformance, forecastSeries, forecastReport
} from '../server/services/analyticsEngine.js';

const HOUR = 3_600_000;
const D0 = Date.UTC(2026, 1, 2); // 2026-02-02T00:00:00Z (a Monday)

test('thresholds are the approved D8-a2 values', () => {
  assert.deepEqual({ ...THRESHOLDS }, { forecastMinDays: 14, forecastMinEvents: 30, minObservations: 20 });
});

test('nearest-rank percentiles and the 20-observation minimum', () => {
  // [10,20,30,40]: p50 -> rank ceil(2.0)=2 -> 20; p90 -> rank ceil(3.6)=4 -> 40; p0 -> rank 1 -> 10.
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
  assert.equal(percentile([10, 20, 30, 40], 60), 30); // rank ceil(2.4) = 3 (rounding would give rank 2)
  // 1..20 (shuffled): mean 210/20 = 10.5; p50 rank 10 -> 10; p90 rank 18 -> 18; p95 rank 19 -> 19.
  const twenty = [7, 3, 20, 1, 15, 9, 12, 2, 18, 5, 11, 4, 16, 8, 19, 6, 14, 10, 17, 13];
  assert.deepEqual(summarizeSample(twenty), { status: 'ok', sample_size: 20, mean: 10.5, p50: 10, p90: 18, p95: 19, min: 1, max: 20 });
  // 1..26: mean 351/26 = 13.5; p50 rank 13 -> 13; p90 rank ceil(23.4) = 24 -> 24; p95 rank ceil(24.7) = 25 -> 25.
  assert.deepEqual(summarizeSample(Array.from({ length: 26 }, (_, i) => 26 - i)), { status: 'ok', sample_size: 26, mean: 13.5, p50: 13, p90: 24, p95: 25, min: 1, max: 26 });
  assert.deepEqual(summarizeSample(twenty.slice(1)), { status: 'insufficient_data', sample_size: 19, required: 20 });
  // Non-numbers are not observations: only the 1 counts.
  assert.deepEqual(summarizeSample([1, NaN, null, '3', undefined], 1), { status: 'ok', sample_size: 1, mean: 1, p50: 1, p90: 1, p95: 1, min: 1, max: 1 });
  assert.deepEqual(summarizeSample([]), { status: 'insufficient_data', sample_size: 0, required: 20 });
  // Rates: 15/20 = 0.75; 19 decisions are below the minimum.
  assert.deepEqual(gatedRate(15, 20), { status: 'ok', sample_size: 20, value: 0.75 });
  assert.deepEqual(gatedRate(19, 19), { status: 'insufficient_data', sample_size: 19, required: 20 });
});

test('location grid: 0.01-degree cells by south-west corner, exact on DECIMAL values, unknown when missing', () => {
  // Float traps (checked in Node): 30.33 / 0.01 = 3032.9999999999995, 78.07 / 0.01 = 7806.999999999999,
  // 1.13 / 0.01 = 112.99999999999999, so a plain floor would give 30.32, 78.06 and 1.12.
  assert.equal(gridCell('30.3300000', '78.0700000'), '30.33,78.07');
  assert.equal(gridCell(30.33, 78.07), '30.33,78.07');
  assert.equal(gridCell(1.13, -1.13), '1.13,-1.13');
  assert.equal(gridCell(30.31, 78.03), '30.31,78.03');
  assert.equal(gridCell(30.3165, 78.0429), '30.31,78.04');
  assert.equal(gridCell(28.6, 77.2), '28.60,77.20');
  assert.equal(gridCell(-0.005, 0.005), '-0.01,0.00'); // floor goes south/west for negative coordinates
  assert.equal(gridCell(null, 78), 'unknown');
  assert.equal(gridCell('', ''), 'unknown');
  assert.equal(gridCell(undefined, 1), 'unknown');
  assert.equal(gridCell('n/a', 1), 'unknown');
});

test('history window: resolved on the server in epoch ms, half-open, validated', () => {
  const now = D0 + 10 * DAY_MS + 5 * HOUR;
  assert.deepEqual(resolveHistoryWindow({}, now), { fromMs: now - 28 * DAY_MS, toMs: now });
  assert.deepEqual(resolveHistoryWindow({ days: '7' }, now), { fromMs: now - 7 * DAY_MS, toMs: now });
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(D0), to_ms: String(D0 + DAY_MS) }, now), { fromMs: D0, toMs: D0 + DAY_MS });
  assert.deepEqual(resolveHistoryWindow({ days: '2', to_ms: String(D0 + 2 * DAY_MS) }, now), { fromMs: D0, toMs: D0 + 2 * DAY_MS });
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(D0), to_ms: String(D0 + 366 * DAY_MS) }, now).toMs, D0 + 366 * DAY_MS);
  const bad = [
    { from_ms: 'abc' }, { from_ms: '-5' }, { from_ms: '1.5' }, { to_ms: '1e12' }, { days: '0' }, { days: '367' }, { days: ['1', '2'] },
    { from_ms: String(D0), days: '3' },
    { from_ms: String(D0), to_ms: String(D0) },
    { from_ms: String(D0 + 1), to_ms: String(D0) },
    // 366 days and one whole second (D0 + 366 d + 1 ms floors to exactly 366 days, which is allowed: see below)
    { from_ms: String(D0), to_ms: String(D0 + 366 * DAY_MS + 1000) }
  ];
  for (const q of bad) assert.throws(() => resolveHistoryWindow(q, now), AnalyticsInputError, JSON.stringify(q));
});

test('history window bounds are floored to whole seconds (S3); the floored window is what is returned', () => {
  const T = D0 + 5 * HOUR; // whole second
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(T + 700), to_ms: String(T + 10_500) }, 0), { fromMs: T, toMs: T + 10_000 });
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(T + 999), to_ms: String(T + 1999) }, 0), { fromMs: T, toMs: T + 1000 });
  // now = T + 10.250 s: to_ms defaults to T + 10 s and days counts back from there.
  assert.deepEqual(resolveHistoryWindow({ days: '1' }, T + 10_250), { fromMs: T + 10_000 - DAY_MS, toMs: T + 10_000 });
  assert.deepEqual(resolveHistoryWindow({}, T + 10_250), { fromMs: T + 10_000 - 28 * DAY_MS, toMs: T + 10_000 });
  // 366 days + 1 ms floors to exactly 366 days: allowed.
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(D0), to_ms: String(D0 + 366 * DAY_MS + 1) }, 0), { fromMs: D0, toMs: D0 + 366 * DAY_MS });
  // Both bounds inside one second: empty after flooring, refused (not widened) with its own message.
  const sameSecond = 'The window must span at least one whole second after flooring to seconds (from_ms and to_ms fall in the same second).';
  assert.throws(() => resolveHistoryWindow({ from_ms: String(T + 100), to_ms: String(T + 900) }, 0), err => err instanceof AnalyticsInputError && err.message === sameSecond);
  assert.throws(() => resolveHistoryWindow({ from_ms: String(T), to_ms: String(T + 999) }, 0), err => err.message === sameSecond);
  // Bounds in the wrong order (or equal) keep the plain message.
  for (const [from, to] of [[T + 900, T + 100], [T + 500, T + 500], [T + 2000, T]]) {
    assert.throws(() => resolveHistoryWindow({ from_ms: String(from), to_ms: String(to) }, 0),
      err => err instanceof AnalyticsInputError && err.message === 'from_ms must be earlier than to_ms.', `${from} ${to}`);
  }
  // One whole second apart after flooring is enough.
  assert.deepEqual(resolveHistoryWindow({ from_ms: String(T + 999), to_ms: String(T + 1000) }, 0), { fromMs: T, toMs: T + 1000 });
});

test('unknown query parameters are refused with AnalyticsInputError on both resolvers (S7)', () => {
  assert.throws(() => resolveHistoryWindow({ from: String(D0) }, D0 + DAY_MS), err => err instanceof AnalyticsInputError
    && err.message === 'Unknown query parameter: from (allowed: from_ms, to_ms, days).');
  assert.throws(() => resolveHistoryWindow({ days: '2', as_of_ms: '0', zz: '1' }, D0 + DAY_MS), /Unknown query parameters: as_of_ms, zz/);
  assert.throws(() => resolveForecastWindow({ horizon: '3' }, D0), err => err instanceof AnalyticsInputError
    && err.message === 'Unknown query parameter: horizon (allowed: as_of_ms, history_days, horizon_days).');
  assert.throws(() => resolveForecastWindow({ days: '3' }, D0), /Unknown query parameter: days/);
  // Every allowed parameter is accepted.
  assert.doesNotThrow(() => resolveHistoryWindow({ to_ms: String(D0 + DAY_MS), days: '1' }, 0));
  assert.doesNotThrow(() => resolveHistoryWindow({ from_ms: String(D0), to_ms: String(D0 + DAY_MS) }, 0));
  assert.doesNotThrow(() => resolveForecastWindow({ as_of_ms: String(D0), history_days: '7', horizon_days: '3' }, 0));
});

test('forecast window: complete UTC days before as_of; the day containing as_of is excluded', () => {
  const asOf = D0 + 14 * DAY_MS + 13.5 * HOUR; // 2026-02-16T13:30Z
  assert.deepEqual(resolveForecastWindow({ as_of_ms: String(asOf) }, 0),
    { asOfMs: asOf, fromMs: D0 - 14 * DAY_MS, toMs: D0 + 14 * DAY_MS, historyDays: 28, horizonDays: 7 });
  assert.deepEqual(resolveForecastWindow({ history_days: '14', horizon_days: '3' }, asOf),
    { asOfMs: asOf, fromMs: D0, toMs: D0 + 14 * DAY_MS, historyDays: 14, horizonDays: 3 });
  for (const q of [{ horizon_days: '0' }, { horizon_days: '15' }, { history_days: '0' }, { as_of_ms: 'now' }]) {
    assert.throws(() => resolveForecastWindow(q, asOf), AnalyticsInputError, JSON.stringify(q));
  }
});

test('boundaries: an event at from_ms counts, one at to_ms does not; partial days are flagged', () => {
  const w = { fromMs: D0 + 6 * HOUR, toMs: D0 + 2 * DAY_MS + 6 * HOUR };
  const at = ms => ({ request_ms: ms, emergency_type: 'GENERAL', priority: 3, required_resource_types: [] });
  const requests = [at(w.fromMs - 1), at(w.fromMs), at(D0 + DAY_MS + 12 * HOUR), at(w.toMs - 1), at(w.toMs)];
  const d = demandTrends(requests, w);
  assert.equal(d.total_cases, 3);
  assert.deepEqual(d.daily, [
    { day: '2026-02-02', cases: 1, partial: true },  // window starts at 06:00
    { day: '2026-02-03', cases: 1, partial: false },
    { day: '2026-02-04', cases: 1, partial: true }   // window ends at 06:00 (exclusive); 05:59:59.999 counts
  ]);
  // A day-aligned window has no partial days, and empty days are zero, not missing.
  assert.deepEqual(dailyBuckets({ fromMs: D0, toMs: D0 + 2 * DAY_MS }, []),
    [{ day: '2026-02-02', cases: 0, partial: false }, { day: '2026-02-03', cases: 0, partial: false }]);
});

test('demand trends tally by type, priority, location cell and resource units requested', () => {
  const w = { fromMs: D0, toMs: D0 + DAY_MS };
  const r = (h, type, priority, lat, lng, units) => ({ request_ms: D0 + h * HOUR, emergency_type: type, priority, pickup_lat: lat, pickup_lng: lng, required_resource_types: units });
  const d = demandTrends([
    r(1, 'CARDIAC', 1, 30.3165, 78.0429, ['ICU_BED', 'VENTILATOR']),
    r(2, 'TRAUMA', 2, '30.3300000', '78.0700000', ['ICU_BED', 'OT']),
    r(3, 'CARDIAC', 1, null, null, ['ICU_BED']),
    r(30, 'TRAUMA', 2, null, null, ['OT']) // next day: outside the window
  ], w);
  assert.equal(d.total_cases, 3);
  assert.deepEqual(d.by_emergency_type, { CARDIAC: 2, TRAUMA: 1 });
  assert.deepEqual(d.by_priority, { 1: 2, 2: 1 });
  assert.deepEqual(d.by_location, { '30.31,78.04': 1, '30.33,78.07': 1, unknown: 1 });
  assert.deepEqual(d.resource_units_requested, { ICU_BED: 3, OT: 1, VENTILATOR: 1 });
  assert.equal(d.location_grid_degrees, 0.01);
});

test('response times use recorded timestamps only; expired, pending and cancelled referrals are not responses', () => {
  const w = { fromMs: D0, toMs: D0 + DAY_MS };
  const t0 = D0 + HOUR;
  // 20 answered referrals taking 5, 10, ..., 100 s: mean 1050/20 = 52.5; p50 rank 10 -> 50; p90 rank 18 -> 90; p95 rank 19 -> 95.
  const answered = Array.from({ length: 20 }, (_, i) => ({ hospital_id: 'H-1', status: i % 4 ? 'ACCEPTED' : 'REJECTED', created_ms: t0, responded_ms: t0 + (i + 1) * 5000 }));
  const others = [
    { hospital_id: 'H-1', status: 'EXPIRED', created_ms: t0, responded_ms: t0 + 90_000 },
    { hospital_id: 'H-1', status: 'EXPIRED', created_ms: t0, responded_ms: t0 + 90_000 },
    { hospital_id: 'H-1', status: 'PENDING', created_ms: t0, responded_ms: null },
    { hospital_id: 'H-1', status: 'CANCELLED', created_ms: t0, responded_ms: t0 + 1000 },
    { hospital_id: 'H-1', status: 'ACCEPTED', created_ms: D0 - 1, responded_ms: D0 + 1000 } // created before the window
  ];
  const allocations = [
    { created_ms: t0, allocated_ms: t0 + 60_000 }, { created_ms: t0, allocated_ms: t0 + 120_000 }, { created_ms: t0, allocated_ms: t0 + 30_000 },
    { created_ms: t0, allocated_ms: t0 - 1 },          // allocated before created: not a duration, dropped
    { created_ms: D0 - HOUR, allocated_ms: D0 + HOUR } // intake before the window
  ];
  const rt = responseTimes([...answered, ...others], allocations, w);
  assert.deepEqual(rt.referral_response_sec, { status: 'ok', sample_size: 20, mean: 52.5, p50: 50, p90: 90, p95: 95, min: 5, max: 100 });
  assert.equal(rt.referrals_timed_out, 2);
  assert.deepEqual(rt.intake_to_allocation_sec, { status: 'insufficient_data', sample_size: 3, required: 20 });
  assert.deepEqual(rt.not_recorded, ['ambulance travel and arrival times (no arrival timestamp is recorded)']);
  // One fewer answered referral is below the minimum.
  assert.deepEqual(responseTimes([...answered.slice(1), ...others], [], w).referral_response_sec, { status: 'insufficient_data', sample_size: 19, required: 20 });
});

test('hospital performance: observed rates from referrals, priors labelled as configuration, totals = sum of hospitals', () => {
  const w = { fromMs: D0, toMs: D0 + DAY_MS };
  const acc = (hospital_id, status, n) => Array.from({ length: n }, () => ({ hospital_id, status, created_ms: D0 + HOUR, responded_ms: status === 'PENDING' ? null : D0 + HOUR + 10_000 }));
  const acceptances = [
    // H-1: decided = 15 + 4 + 1 = 20 -> 15/20 = 0.75 (its configured prior is 0.95: not used)
    ...acc('H-1', 'ACCEPTED', 15), ...acc('H-1', 'REJECTED', 4), ...acc('H-1', 'EXPIRED', 1), ...acc('H-1', 'PENDING', 2), ...acc('H-1', 'CANCELLED', 3),
    // H-2: decided = 3 -> insufficient
    ...acc('H-2', 'ACCEPTED', 2), ...acc('H-2', 'REJECTED', 1),
    { hospital_id: 'H-2', status: 'ACCEPTED', created_ms: D0 + DAY_MS, responded_ms: D0 + DAY_MS + 1 } // at to_ms: outside
  ];
  const hospitals = [
    { hospital_id: 'H-2', hospital_name: 'Fictional Two', emergency_status: 'LIMITED', acceptance_rate: 0.5, avg_response_sec: 90 },
    { hospital_id: 'H-1', hospital_name: 'Fictional One', emergency_status: 'OPEN', acceptance_rate: 0.95, avg_response_sec: 30 }
  ];
  const resources = [
    { hospital_id: 'H-1', resource_type: 'ICU_BED', total_capacity: 10, available_capacity: 6, locked_capacity: 2 }, // in_use 4, locked 2, free 4
    { hospital_id: 'H-1', resource_type: 'OT', total_capacity: 2, available_capacity: 2, locked_capacity: 0 },       // free 2
    { hospital_id: 'H-2', resource_type: 'ICU_BED', total_capacity: 5, available_capacity: 5, locked_capacity: 1 }   // locked 1, free 4
  ];
  const allocations = [
    { hospital_id: 'H-1', request_id: 'REQ-1', status: 'COMMITTED' }, { hospital_id: 'H-1', request_id: 'REQ-1', status: 'COMMITTED' },
    { hospital_id: 'H-1', request_id: 'REQ-2', status: 'COMMITTED' }, { hospital_id: 'H-2', request_id: 'REQ-3', status: 'RELEASED' }
  ];
  const p = hospitalPerformance({ hospitals, acceptances, resources, allocations }, w);
  const [h1, h2] = p.hospitals;
  assert.deepEqual(p.hospitals.map(h => h.hospital_id), ['H-1', 'H-2']);
  assert.deepEqual(h1.referrals, { received: 25, accepted: 15, rejected: 4, expired: 1, pending: 2, cancelled: 3 });
  assert.deepEqual(h1.observed_acceptance_rate, { status: 'ok', sample_size: 20, value: 0.75 });
  assert.deepEqual(h1.referral_response_sec, { status: 'insufficient_data', sample_size: 19, required: 20 }); // 15 + 4 answered
  assert.deepEqual(h1.current, { capacity: { total: 12, in_use: 4, soft_locked: 2, free: 6 }, active_cases: 2 });
  assert.deepEqual(h1.configured_ranking_prior, { acceptance_rate: 0.95, avg_response_sec: 30, note: 'configured value used to rank failover candidates (D8b); not an observation' });
  assert.deepEqual(h2.observed_acceptance_rate, { status: 'insufficient_data', sample_size: 3, required: 20 });
  assert.deepEqual(h2.current, { capacity: { total: 5, in_use: 0, soft_locked: 1, free: 4 }, active_cases: 0 });
  // All hospitals: 28 received; decided 17 + 5 + 1 = 23 -> 17/23 = 0.73913 -> 0.739.
  assert.deepEqual(p.all_hospitals.referrals, { received: 28, accepted: 17, rejected: 5, expired: 1, pending: 2, cancelled: 3 });
  assert.deepEqual(p.all_hospitals.observed_acceptance_rate, { status: 'ok', sample_size: 23, value: 0.739 });
  assert.deepEqual(p.all_hospitals.current, { capacity: { total: 17, in_use: 4, soft_locked: 3, free: 10 }, active_cases: 2 });
  for (const k of Object.keys(p.all_hospitals.referrals)) assert.equal(p.all_hospitals.referrals[k], h1.referrals[k] + h2.referrals[k], k);
  for (const k of Object.keys(p.all_hospitals.current.capacity)) assert.equal(p.all_hospitals.current.capacity[k], h1.current.capacity[k] + h2.current.capacity[k], k);
});

const WEEK = [1, 2, 3, 4, 5, 6, 9]; // 30 events a week
const seriesOf = (values, firstDayMs = D0) => values.map((value, i) => ({ day: new Date(firstDayMs + i * DAY_MS).toISOString().slice(0, 10), value }));

test('forecast: hand-derived back-test errors and points for two identical weeks', () => {
  const f = forecastSeries(seriesOf([...WEEK, ...WEEK]), 7);
  // Back-test days are indices 7..13, actual = WEEK.
  //  seasonal-naive predicts the same weekday a week earlier = WEEK exactly -> MAE 0.
  //  naive predicts the previous day: [9,1,2,3,4,5,6] -> |errors| 8,1,1,1,1,1,3 = 16 -> 16/7 = 2.2857 -> 2.286.
  //  7-day mean of any 7 consecutive days = 30/7 = 4.2857; |errors| vs WEEK sum to 14.2857 -> /7 = 2.0408 -> 2.041.
  assert.deepEqual(f, {
    status: 'ok',
    sample: { days: 14, events: 60, first_day: '2026-02-02', last_day: '2026-02-15' },
    backtest: { days: 7, seasonal_naive_mae: 0, moving_average_7d_mae: 2.041, naive_baseline_mae: 2.286, better_than_naive: { seasonal_naive: true, moving_average_7d: true } },
    points: WEEK.map((v, k) => ({ day: `2026-02-${16 + k}`, seasonal_naive: v, moving_average_7d: 4.29 }))
  });
  // Beyond a week the seasonal pattern repeats: day 9 of the horizon (2026-02-24) is a Tuesday -> 2.
  assert.deepEqual(forecastSeries(seriesOf([...WEEK, ...WEEK]), 9).points.at(-1), { day: '2026-02-24', seasonal_naive: 2, moving_average_7d: 4.29 });
});

test('forecast thresholds: 13 days or 29 events is insufficient; ties with the naive baseline are not "better"', () => {
  // 13 days (first Monday dropped), 59 events.
  assert.deepEqual(forecastSeries(seriesOf([...WEEK.slice(1), ...WEEK]), 7),
    { status: 'insufficient_data', sample: { days: 13, events: 59, first_day: '2026-02-02', last_day: '2026-02-14' }, required: { days: 14, events: 30 } });
  // 14 days, 13 x 2 + 3 = 29 events.
  const flat = Array(13).fill(2);
  assert.equal(forecastSeries(seriesOf([...flat, 3]), 7).status, 'insufficient_data');
  // 14 days, 13 x 2 + 4 = 30 events: every method predicts 2 for the last day (actual 4) -> MAE 2/7 = 0.286 each.
  const ok = forecastSeries(seriesOf([...flat, 4]), 7);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.backtest, { days: 7, seasonal_naive_mae: 0.286, moving_average_7d_mae: 0.286, naive_baseline_mae: 0.286, better_than_naive: { seasonal_naive: false, moving_average_7d: false } });
  assert.deepEqual(forecastSeries([], 7), { status: 'insufficient_data', sample: { days: 0, events: 0, first_day: null, last_day: null }, required: { days: 14, events: 30 } });
});

test('forecast report: history starts at the first recorded case; the as_of day and earlier empty days do not count', () => {
  const fw = resolveForecastWindow({ as_of_ms: String(D0 + 14 * DAY_MS + 13.5 * HOUR) }, 0); // [D0 - 14 d, D0 + 14 d)
  const requests = [];
  [...WEEK, ...WEEK].forEach((n, day) => {
    for (let i = 0; i < n; i += 1) requests.push({ request_ms: D0 + day * DAY_MS + 10 * HOUR, required_resource_types: ['ICU_BED'] });
  });
  requests.push({ request_ms: fw.toMs - 1, required_resource_types: ['ICU_BED'] }); // 2026-02-15T23:59:59.999: counts on the last day
  for (let i = 0; i < 5; i += 1) requests.push({ request_ms: fw.toMs + i, required_resource_types: ['ICU_BED'] }); // the as_of day: excluded
  const r = forecastReport(requests, fw, ['VENTILATOR', 'ICU_BED']);
  assert.equal(r.kind, 'forecast');
  assert.equal(r.history_window.from_ms, D0 - 14 * DAY_MS);
  assert.equal(r.history_window.to_ms, D0 + 14 * DAY_MS);
  // 14 days from the first case (not 28 from the window start), 60 + 1 events; the last day has 9 + 1 = 10.
  assert.deepEqual(r.cases_per_day.sample, { days: 14, events: 61, first_day: '2026-02-02', last_day: '2026-02-15' });
  assert.equal(r.cases_per_day.points[6].seasonal_naive, 10);
  assert.deepEqual(Object.keys(r.resource_units_requested_per_day), ['ICU_BED', 'VENTILATOR']);
  assert.deepEqual(r.resource_units_requested_per_day.ICU_BED.sample, r.cases_per_day.sample);
  assert.deepEqual(r.resource_units_requested_per_day.VENTILATOR,
    { status: 'insufficient_data', sample: { days: 14, events: 0, first_day: '2026-02-02', last_day: '2026-02-15' }, required: { days: 14, events: 30 } });
  // Sparse history: 40 cases, all in the last 10 days of a 28-day window -> 10 days of history -> insufficient.
  const sparse = Array.from({ length: 40 }, (_, i) => ({ request_ms: D0 + (4 + (i % 10)) * DAY_MS, required_resource_types: [] }));
  assert.deepEqual(forecastReport(sparse, fw).cases_per_day,
    { status: 'insufficient_data', sample: { days: 10, events: 40, first_day: '2026-02-06', last_day: '2026-02-15' }, required: { days: 14, events: 30 } });
  // No cases at all.
  assert.deepEqual(forecastReport([], fw).cases_per_day.sample, { days: 0, events: 0, first_day: null, last_day: null });
});
