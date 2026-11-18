// Analytics contract (Phase 3 Step 6, D8-A / D8b-A), run unchanged against the in-memory store
// (tests/contract_memory.test.js) and the MySQL store (tests/contract_mysql.test.js). Both backends must turn the
// same recorded rows into the SAME report, equal to values derived by hand below: that is the parity check.
// Rows are inserted at explicit whole-second epoch times (MySQL TIMESTAMP keeps seconds). Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';
import { historyReport, forecastReport, resolveForecastWindow, resolveHistoryWindow, DAY_MS } from '../../server/services/analyticsEngine.js';
import { HOSPITALS, RESOURCE_TYPES } from './fixture.js';

const HOUR = 3_600_000;
const D0 = Date.UTC(2026, 1, 2); // 2026-02-02T00:00:00Z
const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-CONTRACT-EMS' };
const DESK = 'U-CONTRACT-DESK-A';
const insufficient = n => ({ status: 'insufficient_data', sample_size: n, required: 20 });
const PRIOR_NOTE = 'configured value used to rank failover candidates (D8b); not an observation';

export function registerAnalyticsContract(b) {
  const label = name => `[${b.name}] analytics: ${name}`;
  test.beforeEach(() => b.reset());
  test.afterEach(() => {
    b.hooks.clear();
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });

  // Window [02-02 06:00, 02-04 06:00): two partial days around one full day.
  const W = { fromMs: D0 + 6 * HOUR, toMs: D0 + 2 * DAY_MS + 6 * HOUR };
  const req = (request_id, request_ms, emergency_type, priority, pickup_lat, pickup_lng, required_resource_types) =>
    ({ request_id, request_ms, emergency_type, priority, pickup_lat, pickup_lng, required_resource_types });
  const FIXTURE = {
    requests: [
      req('REQ-F01', W.fromMs - 1000, 'TRAUMA', 2, null, null, ['OT']),                         // 05:59:59, before the window
      req('REQ-F02', W.fromMs, 'CARDIAC', 1, 30.3165, 78.0429, ['ICU_BED', 'VENTILATOR']),      // exactly from_ms: in
      req('REQ-F03', D0 + DAY_MS + 12 * HOUR, 'TRAUMA', 2, 30.33, 78.07, ['ICU_BED', 'OT']),    // float trap cell
      req('REQ-F04', W.toMs - 1000, 'CARDIAC', 1, null, null, ['ICU_BED']),                       // 05:59:59 on the last day: in
      req('REQ-F05', W.toMs, 'TRAUMA', 2, null, null, ['OT'])                                     // exactly to_ms: out
    ],
    acceptances: [
      { acceptance_id: 'ACC-F1', request_id: 'REQ-F02', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: W.fromMs + 60_000, responded_ms: W.fromMs + 90_000 },          // 30 s
      { acceptance_id: 'ACC-F2', request_id: 'REQ-F03', hospital_id: 'H-B', status: 'REJECTED', created_ms: D0 + DAY_MS + 12 * HOUR + 10_000, responded_ms: D0 + DAY_MS + 12 * HOUR + 55_000 }, // 45 s
      { acceptance_id: 'ACC-F3', request_id: 'REQ-F03', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: D0 + DAY_MS + 12 * HOUR + 100_000, responded_ms: D0 + DAY_MS + 12 * HOUR + 160_000 }, // 60 s
      { acceptance_id: 'ACC-F4', request_id: 'REQ-F04', hospital_id: 'H-A', status: 'EXPIRED', created_ms: D0 + 2 * DAY_MS + 5 * HOUR, responded_ms: D0 + 2 * DAY_MS + 5 * HOUR + 90_000 },
      { acceptance_id: 'ACC-F5', request_id: 'REQ-F04', hospital_id: 'H-B', status: 'PENDING', created_ms: D0 + 2 * DAY_MS + 5 * HOUR + 200_000, responded_ms: null },
      { acceptance_id: 'ACC-F6', request_id: 'REQ-F01', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: W.fromMs - 500_000, responded_ms: W.fromMs - 400_000 }  // before the window
    ],
    events: [
      { request_id: 'REQ-F02', event_type: 'REQUEST_CREATED', event_ms: W.fromMs },
      { request_id: 'REQ-F02', event_type: 'ALLOCATION_COMMITTED', event_ms: W.fromMs + 90_000 },                 // 90 s
      { request_id: 'REQ-F02', event_type: 'ALLOCATION_COMMITTED', event_ms: W.fromMs + 900_000 },                // later stage: first one counts
      { request_id: 'REQ-F03', event_type: 'REQUEST_CREATED', event_ms: D0 + DAY_MS + 12 * HOUR },
      { request_id: 'REQ-F03', event_type: 'ALLOCATION_COMMITTED', event_ms: D0 + DAY_MS + 12 * HOUR + 160_000 },  // 160 s
      { request_id: 'REQ-F01', event_type: 'REQUEST_CREATED', event_ms: W.fromMs - 1000 },                        // request outside the window
      { request_id: 'REQ-F01', event_type: 'ALLOCATION_COMMITTED', event_ms: W.fromMs + 1000 }
    ]
  };

  test(label('stored rows round-trip at exact epoch-ms times and the half-open window is applied identically'), async () => {
    await b.insertAnalyticsFixture(FIXTURE);
    const data = await b.store.getAnalyticsHistory(W);
    assert.deepEqual(data.requests.map(r => [r.request_id, r.request_ms]).sort(),
      [['REQ-F02', W.fromMs], ['REQ-F03', D0 + DAY_MS + 12 * HOUR], ['REQ-F04', W.toMs - 1000]]);
    assert.deepEqual(data.acceptances.map(a => a.created_ms).sort((x, y) => x - y),
      [W.fromMs + 60_000, D0 + DAY_MS + 12 * HOUR + 10_000, D0 + DAY_MS + 12 * HOUR + 100_000, D0 + 2 * DAY_MS + 5 * HOUR, D0 + 2 * DAY_MS + 5 * HOUR + 200_000]);
    assert.deepEqual(data.allocationTimes.sort((x, y) => (x.request_id < y.request_id ? -1 : 1)), [
      { request_id: 'REQ-F02', created_ms: W.fromMs, allocated_ms: W.fromMs + 90_000 },
      { request_id: 'REQ-F03', created_ms: D0 + DAY_MS + 12 * HOUR, allocated_ms: D0 + DAY_MS + 12 * HOUR + 160_000 }
    ]);
  });

  test(label('history report equals the hand-derived values: demand, response times, per-hospital and all-hospital totals'), async () => {
    await b.insertAnalyticsFixture(FIXTURE);
    await b.setCapacity('H-A', 'ICU_BED', { total: 4, available: 3, locked: 1 }); // in_use 1, locked 1, free 2
    await b.setCapacity('H-B', 'OT', { total: 2 });                               // free 2
    const report = historyReport(await b.store.getAnalyticsHistory(W), W, D0 + 10 * DAY_MS);
    assert.equal(report.kind, 'observed');
    assert.deepEqual(report.window, { from_ms: W.fromMs, to_ms: W.toMs, from: '2026-02-02T06:00:00.000Z', to: '2026-02-04T06:00:00.000Z', bounds: '[from_ms, to_ms), UTC' });
    assert.deepEqual(report.demand, {
      total_cases: 3,
      daily: [{ day: '2026-02-02', cases: 1, partial: true }, { day: '2026-02-03', cases: 1, partial: false }, { day: '2026-02-04', cases: 1, partial: true }],
      by_emergency_type: { CARDIAC: 2, TRAUMA: 1 },
      by_priority: { 1: 2, 2: 1 },
      by_location: { '30.31,78.04': 1, '30.33,78.07': 1, unknown: 1 },
      location_grid_degrees: 0.01,
      resource_units_requested: { ICU_BED: 3, OT: 1, VENTILATOR: 1 }
    });
    assert.deepEqual(report.response_times, {
      referral_response_sec: insufficient(3),     // 30, 45, 60 s
      referrals_timed_out: 1,
      intake_to_allocation_sec: insufficient(2),  // 90, 160 s
      not_recorded: ['ambulance travel and arrival times (no arrival timestamp is recorded)']
    });
    const byId = Object.fromEntries(report.hospitals.map(h => [h.hospital_id, h]));
    assert.deepEqual(report.hospitals.map(h => h.hospital_id), ['H-A', 'H-B', 'H-C', 'H-D']);
    assert.deepEqual(byId['H-A'].referrals, { received: 3, accepted: 2, rejected: 0, expired: 1, pending: 0, cancelled: 0 });
    assert.deepEqual(byId['H-A'].observed_acceptance_rate, insufficient(3));
    assert.deepEqual(byId['H-A'].current, { capacity: { total: 4, in_use: 1, soft_locked: 1, free: 2 }, active_cases: 0 });
    assert.deepEqual(byId['H-B'].referrals, { received: 2, accepted: 0, rejected: 1, expired: 0, pending: 1, cancelled: 0 });
    assert.deepEqual(byId['H-B'].observed_acceptance_rate, insufficient(1));
    assert.deepEqual(byId['H-B'].current.capacity, { total: 2, in_use: 0, soft_locked: 0, free: 2 });
    assert.deepEqual(byId['H-C'].referrals, { received: 0, accepted: 0, rejected: 0, expired: 0, pending: 0, cancelled: 0 });
    // Seeded priors appear only as labelled configuration (D8b), with the fixture's values.
    for (const h of HOSPITALS) {
      assert.deepEqual(byId[h.hospital_id].configured_ranking_prior, { acceptance_rate: h.acceptance_rate, avg_response_sec: h.avg_response_sec, note: PRIOR_NOTE });
    }
    assert.deepEqual(report.all_hospitals, {
      hospital_count: 4,
      referrals: { received: 5, accepted: 2, rejected: 1, expired: 1, pending: 1, cancelled: 0 },
      observed_acceptance_rate: insufficient(4),
      current: { capacity: { total: 6, in_use: 1, soft_locked: 1, free: 4 }, active_cases: 0 }
    });
  });

  test(label('forecast from stored rows: two recorded weeks give the hand-derived back-test; sparse types are insufficient'), async () => {
    const WEEK = [1, 2, 3, 4, 5, 6, 9];
    const requests = [];
    [...WEEK, ...WEEK].forEach((n, day) => {
      for (let i = 0; i < n; i += 1) requests.push(req(`REQ-W${day}-${i}`, D0 + day * DAY_MS + (10 * HOUR) + i * 1000, 'GENERAL', 3, null, null, ['ICU_BED']));
    });
    requests.push(req('REQ-ASOF', D0 + 14 * DAY_MS + HOUR, 'GENERAL', 3, null, null, ['ICU_BED'])); // on the as_of day: excluded
    await b.insertAnalyticsFixture({ requests });
    const fw = resolveForecastWindow({ as_of_ms: String(D0 + 14 * DAY_MS + 13.5 * HOUR) }, 0);
    const data = await b.store.getAnalyticsHistory(fw);
    const f = forecastReport(data.requests, fw, [...new Set(data.resources.map(r => r.resource_type))]);
    // Same series as the unit test: MAE seasonal 0, 7-day mean 2.041, naive 2.286.
    assert.deepEqual(f.cases_per_day, {
      status: 'ok',
      sample: { days: 14, events: 60, first_day: '2026-02-02', last_day: '2026-02-15' },
      backtest: { days: 7, seasonal_naive_mae: 0, moving_average_7d_mae: 2.041, naive_baseline_mae: 2.286, better_than_naive: { seasonal_naive: true, moving_average_7d: true } },
      points: WEEK.map((v, k) => ({ day: `2026-02-${16 + k}`, seasonal_naive: v, moving_average_7d: 4.29 }))
    });
    assert.deepEqual(Object.keys(f.resource_units_requested_per_day), [...RESOURCE_TYPES].sort());
    assert.deepEqual(f.resource_units_requested_per_day.ICU_BED, f.cases_per_day);
    for (const t of ['OT', 'VENTILATOR']) {
      assert.deepEqual(f.resource_units_requested_per_day[t],
        { status: 'insufficient_data', sample: { days: 14, events: 0, first_day: '2026-02-02', last_day: '2026-02-15' }, required: { days: 14, events: 30 } });
    }
  });

  test(label('an empty ledger reports zeros and insufficient_data, never an invented value'), async () => {
    const report = historyReport(await b.store.getAnalyticsHistory(W), W, D0);
    assert.equal(report.demand.total_cases, 0);
    assert.deepEqual(report.demand.by_location, {});
    assert.deepEqual(report.response_times.referral_response_sec, insufficient(0));
    assert.deepEqual(report.all_hospitals.observed_acceptance_rate, insufficient(0));
    const fw = resolveForecastWindow({ as_of_ms: String(D0) }, 0);
    assert.equal(forecastReport((await b.store.getAnalyticsHistory(fw)).requests, fw).cases_per_day.status, 'insufficient_data');
  });

  test(label('demo cases, their referrals and their audit timings are left out of history and forecasts (S1)'), async () => {
    const day = n => D0 + n * DAY_MS;
    await b.insertAnalyticsFixture({
      requests: [
        { ...req('REQ-8901', day(1) + 10 * HOUR, 'CARDIAC', 1, 30.3165, 78.0429, ['ICU_BED']), is_demo: true },
        { ...req('REQ-8902', day(1) + 11 * HOUR, 'TRAUMA', 2, null, null, ['OT']), is_demo: true },
        req('REQ-R01', day(2) + 9 * HOUR, 'STROKE', 2, null, null, ['ICU_BED'])
      ],
      acceptances: [
        { acceptance_id: 'ACC-D1', request_id: 'REQ-8901', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: day(1) + 10 * HOUR + 10_000, responded_ms: day(1) + 10 * HOUR + 40_000 },
        { acceptance_id: 'ACC-D2', request_id: 'REQ-8902', hospital_id: 'H-B', status: 'REJECTED', created_ms: day(1) + 11 * HOUR + 10_000, responded_ms: day(1) + 11 * HOUR + 20_000 },
        { acceptance_id: 'ACC-R1', request_id: 'REQ-R01', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: day(2) + 9 * HOUR + 5000, responded_ms: day(2) + 9 * HOUR + 65_000 }
      ],
      events: [
        { request_id: 'REQ-8901', event_type: 'REQUEST_CREATED', event_ms: day(1) + 10 * HOUR },
        { request_id: 'REQ-8901', event_type: 'ALLOCATION_COMMITTED', event_ms: day(1) + 10 * HOUR + 40_000 },
        { request_id: 'REQ-R01', event_type: 'REQUEST_CREATED', event_ms: day(2) + 9 * HOUR },
        { request_id: 'REQ-R01', event_type: 'ALLOCATION_COMMITTED', event_ms: day(2) + 9 * HOUR + 65_000 }
      ]
    });
    const w = { fromMs: D0, toMs: day(3) };
    const data = await b.store.getAnalyticsHistory(w);
    assert.deepEqual(data.requests.map(r => r.request_id), ['REQ-R01']);
    assert.deepEqual(data.acceptances.map(a => a.request_id), ['REQ-R01']);
    assert.deepEqual(data.allocationTimes, [{ request_id: 'REQ-R01', created_ms: day(2) + 9 * HOUR, allocated_ms: day(2) + 9 * HOUR + 65_000 }]);
    const report = historyReport(data, w, day(3));
    assert.equal(report.demand.total_cases, 1);
    assert.deepEqual(report.demand.by_emergency_type, { STROKE: 1 });
    assert.deepEqual(report.all_hospitals.referrals, { received: 1, accepted: 1, rejected: 0, expired: 0, pending: 0, cancelled: 0 });
    // Forecast over [2026-01-06, 2026-02-05): only the real case counts, so history starts on its day (2026-02-04).
    const fw = resolveForecastWindow({ as_of_ms: String(day(3) + HOUR) }, 0);
    const f = forecastReport((await b.store.getAnalyticsHistory(fw)).requests, fw);
    assert.deepEqual(f.cases_per_day.sample, { days: 1, events: 1, first_day: '2026-02-04', last_day: '2026-02-04' });
  });

  test(label('sub-second window parity: floored bounds put each event on the same side on both stores (S3)'), async () => {
    const T = D0 + 6 * HOUR; // a whole second
    // Asked: [T + 0.5 s, T + 10.5 s). Resolved (floored): [T, T + 10 s).
    const w = resolveHistoryWindow({ from_ms: String(T + 500), to_ms: String(T + 10_500) }, 0);
    assert.deepEqual(w, { fromMs: T, toMs: T + 10_000 });
    await b.insertAnalyticsFixture({
      requests: [
        req('REQ-S1', T + 200, 'CARDIAC', 1, null, null, ['ICU_BED']),       // before the asked from_ms, inside the floored window
        req('REQ-S2', T + 5_999, 'CARDIAC', 1, null, null, ['ICU_BED']),     // inside either way
        req('REQ-S3', T + 10_300, 'CARDIAC', 1, null, null, ['ICU_BED']),    // before the asked to_ms, outside the floored window
        req('REQ-S4', T + 10_700, 'CARDIAC', 1, null, null, ['ICU_BED'])     // T+10.7 s with to_ms T+10.5 s: outside on both
      ],
      // Referral times are whole seconds on MySQL: .300 is stored as its own second there (and truncated by
      // CURRENT_TIMESTAMP in real use), milliseconds in memory. The floored bounds treat both the same.
      acceptances: [
        { acceptance_id: 'ACC-S1', request_id: 'REQ-S2', hospital_id: 'H-A', status: 'ACCEPTED', created_ms: T + 9_300, responded_ms: T + 39_300 },
        { acceptance_id: 'ACC-S2', request_id: 'REQ-S2', hospital_id: 'H-B', status: 'REJECTED', created_ms: T + 10_300, responded_ms: T + 20_300 }
      ]
    });
    const data = await b.store.getAnalyticsHistory(w);
    // Request times round-trip to the millisecond on both stores (MySQL request_time is TIMESTAMP(3), migration 007).
    assert.deepEqual(data.requests.map(r => [r.request_id, r.request_ms]).sort(), [['REQ-S1', T + 200], ['REQ-S2', T + 5_999]]);
    assert.deepEqual(data.acceptances.map(a => a.hospital_id), ['H-A']);
    const report = historyReport(data, w, T + DAY_MS);
    assert.equal(report.demand.total_cases, 2);
    assert.deepEqual(report.window, { from_ms: T, to_ms: T + 10_000, from: '2026-02-02T06:00:00.000Z', to: '2026-02-02T06:00:10.000Z', bounds: '[from_ms, to_ms), UTC' });
  });

  test(label('live operations: a real case, referral and allocation are reported from their recorded events'), async () => {
    for (const type of ['ICU_BED', 'VENTILATOR']) await b.setCapacity('H-A', type, { total: 2 });
    const before = Date.now() - 2000;
    const r = resolveEmergencyRequirements('RESPIRATORY');
    const { request_id: id } = await b.store.createRequest({
      patient: { full_name: 'Fictional Analytics Live', age: 50, gender: 'UNKNOWN', emergency_type: 'RESPIRATORY', triage_priority: 2, contact_phone: null },
      request: { emergency_type: 'RESPIRATORY', required_resource_types: r.resourceTypes, required_specialist: r.specialist, priority: 2, pickup_lat: 30.3165, pickup_lng: 78.0429, clinical_notes: '' }
    }, PARAMEDIC);
    const lock = await b.store.acquireReferralLock('H-A', id, ['ICU_BED', 'VENTILATOR']);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    const w = { fromMs: before, toMs: Date.now() + 2000 };
    const chainBefore = await b.store.verifyAuditChain();
    const data = await b.store.getAnalyticsHistory(w);
    assert.equal(data.allocationTimes.length, 1);
    assert.ok(data.allocationTimes[0].allocated_ms >= data.allocationTimes[0].created_ms, 'allocation after intake');
    const report = historyReport(data, w, Date.now());
    assert.equal(report.demand.total_cases, 1);
    assert.deepEqual(report.demand.by_location, { '30.31,78.04': 1 });
    assert.deepEqual(report.demand.resource_units_requested, Object.fromEntries([...r.resourceTypes].sort().map(t => [t, 1])));
    assert.deepEqual(report.response_times.referral_response_sec, insufficient(1));
    assert.deepEqual(report.response_times.intake_to_allocation_sec, insufficient(1));
    const ha = report.hospitals.find(h => h.hospital_id === 'H-A');
    assert.deepEqual(ha.referrals, { received: 1, accepted: 1, rejected: 0, expired: 0, pending: 0, cancelled: 0 });
    assert.deepEqual(ha.current, { capacity: { total: 4, in_use: 2, soft_locked: 0, free: 2 }, active_cases: 1 });
    assert.equal(report.all_hospitals.current.active_cases, 1);
    // Reading analytics never writes: the audit chain is valid and has the same length as before the read.
    const chainAfter = await b.store.verifyAuditChain();
    assert.equal(chainAfter.valid, true);
    assert.equal(chainAfter.checked, chainBefore.checked);
    assert.deepEqual(chainAfter.head, chainBefore.head);
  });
}
