// server/services/analyticsEngine.js
// Historical analytics and forecasting over RECORDED events (Phase 3 Step 6, decisions D8-A and D8b-A). Pure: no
// I/O, no clock. The stores supply rows (getAnalyticsHistory) and the route supplies "now"; everything here is a
// function of those inputs, so both backends produce identical results from identical rows.
//
// Rules (approved assumptions D8-a1..a8, D8b-a1..a3; see docs/analytics.md):
//  - Only recorded rows are used. Nothing is seeded, simulated, interpolated or assumed (D8-a1).
//  - Seeded Hospital.acceptance_rate / avg_response_sec are CONFIGURED RANKING PRIORS (D8b). They are returned only
//    under `configured_ranking_prior`, never as an observation.
//  - Below a minimum sample a statistic is { status: 'insufficient_data', sample_size, required } (D8-a2). The
//    minimums are configured policy, not statistical facts.
//  - Observed metrics (kind 'observed') and forecasts (kind 'forecast') are separate reports. A forecast states its
//    method, assumptions and back-test error (D8-a3, D8-a4).
//  - Time is epoch milliseconds throughout. A window is half-open, [from_ms, to_ms). Days are UTC calendar days.

export const THRESHOLDS = Object.freeze({
  forecastMinDays: 14,     // D8-a2: days of history before any forecast
  forecastMinEvents: 30,   // D8-a2: events in that history
  minObservations: 20      // D8-a2: observations before a percentile (also applied to means and rates; see docs)
});

// Input bounds for the query parameters (protect the server; not statistical thresholds).
export const LIMITS = Object.freeze({ defaultWindowDays: 28, maxWindowDays: 366, defaultHorizonDays: 7, maxHorizonDays: 14 });

export const BACKTEST_DAYS = 7;
export const GRID_DEGREES = 0.01;
export const DAY_MS = 86_400_000;

export class AnalyticsInputError extends Error {}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const isoTime = ms => new Date(ms).toISOString();
export const startOfUtcDay = ms => Math.floor(ms / DAY_MS) * DAY_MS;
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const mean = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
const sortedObject = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const inWindow = (ms, w) => typeof ms === 'number' && Number.isFinite(ms) && ms >= w.fromMs && ms < w.toMs;

// ── Query parameters → window (server-side, epoch ms) ────────────────────────────────────────────────────────────
function parseMs(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) throw new AnalyticsInputError(`${name} must be a non-negative integer (epoch milliseconds).`);
  return Number(value);
}
function parseCount(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new AnalyticsInputError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

/** Refuse query parameters the endpoint does not define: a misspelt bound must not silently fall back to a default. */
function rejectUnknown(query, allowed) {
  const unknown = Object.keys(query ?? {}).filter(k => !allowed.includes(k)).sort();
  if (unknown.length) {
    throw new AnalyticsInputError(`Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (allowed: ${allowed.join(', ')}).`);
  }
}
export const HISTORY_PARAMS = Object.freeze(['from_ms', 'to_ms', 'days']);
export const FORECAST_PARAMS = Object.freeze(['as_of_ms', 'history_days', 'horizon_days']);

/** Floor an epoch-ms instant to its whole second. */
export const floorToSecond = ms => Math.floor(ms / 1000) * 1000;

/**
 * Window for observed history: [from_ms, to_ms). Either from_ms or days (default 28) sets the start; to_ms defaults
 * to now. Both are resolved on the server in epoch milliseconds and then FLOORED TO WHOLE SECONDS (S3): some MySQL
 * times are stored to the second (HospitalAcceptance.created_at, truncated by CURRENT_TIMESTAMP) while the in-memory
 * store keeps milliseconds. With whole-second bounds B, `t >= B` and `t < B` give the same answer for t and for t
 * truncated to its second, so both stores put every event on the same side of each bound. The response echoes the
 * floored window.
 */
export function resolveHistoryWindow(query, nowMs) {
  rejectUnknown(query, HISTORY_PARAMS);
  const fromParam = parseMs(query.from_ms, 'from_ms');
  const askedToMs = parseMs(query.to_ms, 'to_ms') ?? nowMs;
  const toMs = floorToSecond(askedToMs);
  if (fromParam !== undefined && query.days !== undefined) throw new AnalyticsInputError('Give from_ms or days, not both.');
  const days = parseCount(query.days, 'days', 1, LIMITS.maxWindowDays, LIMITS.defaultWindowDays);
  const fromMs = fromParam !== undefined ? floorToSecond(fromParam) : toMs - days * DAY_MS;
  if (fromMs < 0) throw new AnalyticsInputError('The window starts before 1970.');
  if (fromParam !== undefined && fromParam < askedToMs && fromMs >= toMs) {
    throw new AnalyticsInputError('The window must span at least one whole second after flooring to seconds (from_ms and to_ms fall in the same second).');
  }
  if (fromMs >= toMs) throw new AnalyticsInputError('from_ms must be earlier than to_ms.');
  if (toMs - fromMs > LIMITS.maxWindowDays * DAY_MS) throw new AnalyticsInputError(`The window may span at most ${LIMITS.maxWindowDays} days.`);
  return { fromMs, toMs };
}

/**
 * Window for a forecast: the history_days COMPLETE UTC days before as_of_ms (default now). The day containing
 * as_of_ms is excluded, because a partial day would read as low demand. Its bounds are UTC midnights, so they are
 * already whole seconds.
 */
export function resolveForecastWindow(query, nowMs) {
  rejectUnknown(query, FORECAST_PARAMS);
  const asOfMs = parseMs(query.as_of_ms, 'as_of_ms') ?? nowMs;
  const historyDays = parseCount(query.history_days, 'history_days', 1, LIMITS.maxWindowDays, LIMITS.defaultWindowDays);
  const horizonDays = parseCount(query.horizon_days, 'horizon_days', 1, LIMITS.maxHorizonDays, LIMITS.defaultHorizonDays);
  const toMs = startOfUtcDay(asOfMs);
  const fromMs = toMs - historyDays * DAY_MS;
  if (fromMs < 0) throw new AnalyticsInputError('The history window starts before 1970.');
  return { asOfMs, fromMs, toMs, historyDays, horizonDays };
}

const describeWindow = w => ({ from_ms: w.fromMs, to_ms: w.toMs, from: isoTime(w.fromMs), to: isoTime(w.toMs), bounds: '[from_ms, to_ms), UTC' });

// ── Statistics ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Nearest-rank percentile of an ascending array (p in 0..100). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];
}

/** Summary statistics, or insufficient_data below the configured minimum (D8-a2). */
export function summarizeSample(values, minN = THRESHOLDS.minObservations) {
  const clean = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length < minN) return { status: 'insufficient_data', sample_size: clean.length, required: minN };
  return {
    status: 'ok', sample_size: clean.length,
    mean: round(mean(clean)), p50: round(percentile(clean, 50)), p90: round(percentile(clean, 90)), p95: round(percentile(clean, 95)),
    min: round(clean[0]), max: round(clean.at(-1))
  };
}

/** A proportion, or insufficient_data below the configured minimum. */
export function gatedRate(numerator, denominator, minN = THRESHOLDS.minObservations) {
  if (denominator < minN) return { status: 'insufficient_data', sample_size: denominator, required: minN };
  return { status: 'ok', sample_size: denominator, value: round(numerator / denominator, 3) };
}

// ── Location grid (D8-a6) ────────────────────────────────────────────────────────────────────────────────────────
/**
 * The 0.01-degree cell containing a pickup point, labelled by its south-west corner ("30.31,78.03"); "unknown" when
 * a coordinate is missing. Coordinates are DECIMAL(10,7), so they are snapped on integer 1e-7 degree units: plain
 * floating point would put 30.33 into the 30.32 cell (30.33 / 0.01 = 3032.9999999999995 in IEEE-754 doubles).
 */
export function gridCell(lat, lng) {
  const units = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1e7) : null;
  };
  const la = units(lat);
  const ln = units(lng);
  if (la === null || ln === null) return 'unknown';
  const cell = u => (Math.floor(u / 1e5) / 100).toFixed(2); // 1e5 units of 1e-7 degree = 0.01 degree
  return `${cell(la)},${cell(ln)}`;
}

// ── Observed history ─────────────────────────────────────────────────────────────────────────────────────────────
/** Every UTC day the window touches, zero-filled; `partial` marks a day the window covers only in part. */
export function dailyBuckets(window, eventsMs) {
  const counts = new Map();
  for (const ms of eventsMs) counts.set(startOfUtcDay(ms), (counts.get(startOfUtcDay(ms)) || 0) + 1);
  const out = [];
  for (let d = startOfUtcDay(window.fromMs); d < window.toMs; d += DAY_MS) {
    out.push({ day: isoDay(d), cases: counts.get(d) || 0, partial: d < window.fromMs || d + DAY_MS > window.toMs });
  }
  return out;
}

const tally = (rows, key) => sortedObject(rows.reduce((m, r) => { const k = String(key(r)); m[k] = (m[k] || 0) + 1; return m; }, {}));

/** Emergency volume (observed): per UTC day, by type, priority, location cell and resource units requested. */
export function demandTrends(requests, window) {
  const rows = requests.filter(r => inWindow(r.request_ms, window));
  const units = {};
  for (const r of rows) for (const t of r.required_resource_types || []) units[t] = (units[t] || 0) + 1;
  return {
    total_cases: rows.length,
    daily: dailyBuckets(window, rows.map(r => r.request_ms)),
    by_emergency_type: tally(rows, r => r.emergency_type),
    by_priority: tally(rows, r => r.priority),
    by_location: tally(rows, r => gridCell(r.pickup_lat, r.pickup_lng)),
    location_grid_degrees: GRID_DEGREES,
    resource_units_requested: sortedObject(units)
  };
}

const ANSWERED = ['ACCEPTED', 'REJECTED'];
const responseSec = a => (a.responded_ms - a.created_ms) / 1000;
const isAnswered = a => ANSWERED.includes(a.status) && Number.isFinite(a.created_ms) && Number.isFinite(a.responded_ms);
const referralCounts = rows => {
  const n = s => rows.filter(a => a.status === s).length;
  return { received: rows.length, accepted: n('ACCEPTED'), rejected: n('REJECTED'), expired: n('EXPIRED'), pending: n('PENDING'), cancelled: n('CANCELLED') };
};
// A hospital decided a referral when it accepted, rejected or let it time out. PENDING is undecided; CANCELLED means
// the case ended before the hospital could decide, so neither counts towards the observed acceptance rate.
const acceptanceRate = c => gatedRate(c.accepted, c.accepted + c.rejected + c.expired);

/**
 * Response times from recorded timestamps only (D8-a5): referral response = responded_at - created_at of an
 * ACCEPTED or REJECTED referral; intake to allocation = first REQUEST_CREATED to first ALLOCATION_COMMITTED audit event.
 */
export function responseTimes(acceptances, allocationTimes, window) {
  const rows = acceptances.filter(a => inWindow(a.created_ms, window));
  const timings = allocationTimes.filter(t => inWindow(t.created_ms, window) && Number.isFinite(t.allocated_ms) && t.allocated_ms >= t.created_ms);
  return {
    referral_response_sec: summarizeSample(rows.filter(isAnswered).map(responseSec)),
    referrals_timed_out: rows.filter(a => a.status === 'EXPIRED').length,
    intake_to_allocation_sec: summarizeSample(timings.map(t => (t.allocated_ms - t.created_ms) / 1000)),
    not_recorded: ['ambulance travel and arrival times (no arrival timestamp is recorded)']
  };
}

const capacityOf = resources => {
  const sum = f => resources.reduce((s, r) => s + Number(f(r)), 0);
  return {
    total: sum(r => r.total_capacity),
    in_use: sum(r => r.total_capacity - r.available_capacity),
    soft_locked: sum(r => r.locked_capacity),
    free: sum(r => r.available_capacity - r.locked_capacity)
  };
};
const activeCases = allocations => new Set(allocations.filter(a => a.status === 'COMMITTED').map(a => a.request_id)).size;

/**
 * Per-hospital performance and the total across hospitals. Referral figures are observed within the window;
 * capacity and active cases are the current state (`current`). Seeded priors are labelled as configuration.
 */
export function hospitalPerformance({ hospitals, acceptances, resources, allocations }, window) {
  const rows = acceptances.filter(a => inWindow(a.created_ms, window));
  const perHospital = [...hospitals].sort((a, b) => (a.hospital_id < b.hospital_id ? -1 : 1)).map(h => {
    const mine = rows.filter(a => a.hospital_id === h.hospital_id);
    const counts = referralCounts(mine);
    return {
      hospital_id: h.hospital_id,
      hospital_name: h.hospital_name,
      emergency_status: h.emergency_status,
      referrals: counts,
      observed_acceptance_rate: acceptanceRate(counts),
      referral_response_sec: summarizeSample(mine.filter(isAnswered).map(responseSec)),
      current: {
        capacity: capacityOf(resources.filter(r => r.hospital_id === h.hospital_id)),
        active_cases: activeCases(allocations.filter(a => a.hospital_id === h.hospital_id))
      },
      configured_ranking_prior: {
        acceptance_rate: h.acceptance_rate ?? null,
        avg_response_sec: h.avg_response_sec ?? null,
        note: 'configured value used to rank failover candidates (D8b); not an observation'
      }
    };
  });
  const counts = referralCounts(rows);
  return {
    hospitals: perHospital,
    all_hospitals: {
      hospital_count: hospitals.length,
      referrals: counts,
      observed_acceptance_rate: acceptanceRate(counts),
      current: { capacity: capacityOf(resources), active_cases: activeCases(allocations) }
    }
  };
}

/** The observed-history report (GET /analytics/history). `data` is the result of store.getAnalyticsHistory. */
export function historyReport(data, window, nowMs) {
  const performance = hospitalPerformance(data, window);
  return {
    kind: 'observed',
    window: describeWindow(window),
    current_state_as_of_ms: nowMs,
    thresholds: THRESHOLDS,
    demand: demandTrends(data.requests, window),
    response_times: responseTimes(data.acceptances, data.allocationTimes, window),
    hospitals: performance.hospitals,
    all_hospitals: performance.all_hospitals
  };
}

// ── Forecast ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Forecast a daily series (FORECAST, not an observation). series: [{ day, value }], consecutive complete UTC days.
 * Needs >= forecastMinDays days and >= forecastMinEvents events; otherwise insufficient_data with the actual sample.
 */
export function forecastSeries(series, horizonDays) {
  const values = series.map(p => p.value);
  const events = values.reduce((s, v) => s + v, 0);
  const sample = { days: series.length, events, first_day: series[0]?.day ?? null, last_day: series.at(-1)?.day ?? null };
  if (series.length < THRESHOLDS.forecastMinDays || events < THRESHOLDS.forecastMinEvents) {
    return { status: 'insufficient_data', sample, required: { days: THRESHOLDS.forecastMinDays, events: THRESHOLDS.forecastMinEvents } };
  }
  const seasonal = i => values[i - 7];
  const movingAverage = i => mean(values.slice(i - 7, i));
  const naive = i => values[i - 1];
  // Back-test: predict each of the last BACKTEST_DAYS days from the days before it (>= 14 days, so 7 prior days exist).
  const start = values.length - BACKTEST_DAYS;
  const mae = predict => mean(values.slice(start).map((actual, k) => Math.abs(predict(start + k) - actual)));
  const raw = { seasonal: mae(seasonal), movingAverage: mae(movingAverage), naive: mae(naive) };
  const lastDayMs = Date.parse(`${series.at(-1).day}T00:00:00Z`);
  const recentMean = mean(values.slice(-7));
  return {
    status: 'ok',
    sample,
    backtest: {
      days: BACKTEST_DAYS,
      seasonal_naive_mae: round(raw.seasonal, 3),
      moving_average_7d_mae: round(raw.movingAverage, 3),
      naive_baseline_mae: round(raw.naive, 3),
      better_than_naive: { seasonal_naive: raw.seasonal < raw.naive, moving_average_7d: raw.movingAverage < raw.naive }
    },
    points: Array.from({ length: horizonDays }, (_, k) => ({
      day: isoDay(lastDayMs + (k + 1) * DAY_MS),
      seasonal_naive: values[values.length - 7 + (k % 7)],
      moving_average_7d: round(recentMean)
    }))
  };
}

/**
 * The forecast report (GET /analytics/forecast): daily cases and daily resource units requested, per type. History
 * starts at the first UTC day in the window with a recorded case: days before the first case are not evidence of
 * zero demand, so they do not count towards the 14-day minimum.
 */
export function forecastReport(requests, fw, resourceTypes = []) {
  const rows = requests.filter(r => inWindow(r.request_ms, fw)).sort((a, b) => a.request_ms - b.request_ms);
  const firstDay = rows.length ? startOfUtcDay(rows[0].request_ms) : fw.toMs;
  const days = [];
  for (let d = firstDay; d < fw.toMs; d += DAY_MS) days.push(d);
  const byDay = new Map();
  for (const r of rows) {
    const d = startOfUtcDay(r.request_ms);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const series = valueOf => days.map(d => ({ day: isoDay(d), value: (byDay.get(d) || []).reduce((s, r) => s + valueOf(r), 0) }));
  const types = [...new Set([...resourceTypes, ...rows.flatMap(r => r.required_resource_types || [])])].sort();
  return {
    kind: 'forecast',
    as_of_ms: fw.asOfMs,
    history_window: describeWindow(fw),
    horizon_days: fw.horizonDays,
    thresholds: THRESHOLDS,
    method: 'seasonal-naive (same weekday last week) and 7-day moving average, back-tested on the last 7 observed days against the naive (previous day) baseline',
    assumptions: [
      'demand repeats weekly (seasonal-naive) or stays near its last-7-day level (moving average)',
      'no external drivers (events, weather, holidays) are modelled',
      'UTC calendar days; the day containing as_of_ms is excluded as incomplete',
      'history starts at the first recorded case in the window'
    ],
    cases_per_day: forecastSeries(series(() => 1), fw.horizonDays),
    resource_units_requested_per_day: Object.fromEntries(types.map(t => [
      t, forecastSeries(series(r => (r.required_resource_types || []).filter(x => x === t).length), fw.horizonDays)
    ])),
    not_forecast: ['resource availability: needs a length-of-stay / release-time model, which is not built (see docs/analytics.md)']
  };
}
