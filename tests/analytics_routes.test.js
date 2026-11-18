// Analytics endpoints through HTTP (Phase 3 Step 6): the new ADMIN-only /history and /forecast, their server-side
// windows and input validation, and the unchanged shapes of the four existing endpoints the frontend uses
// (js/api.js: getDashboard, getReferrals, getAudit, getResources). Real Express routers in-process on the in-memory
// store and its demo seed. Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { memoryTokenFor } from './helpers/testUsers.js';
import analyticsRoutes from '../server/routes/analytics.js';

const app = express();
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);
let server;
let base;
test.before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => new Promise(r => server.close(r)));

const DAY = 86_400_000;
const token = (role, hospital_id = null) => memoryTokenFor(db, { user_id: `U-${role}-${hospital_id ?? 'ALL'}`, role, hospital_id });
const ADMIN = token('ADMIN');
const get = async (path, t = ADMIN) => {
  const r = await fetch(`${base}/api/v1/analytics${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  return { status: r.status, body: await r.json() };
};

test('history and forecast are ADMIN only', async () => {
  for (const path of ['/history', '/forecast']) {
    assert.equal((await get(path, null)).status, 401, path);
    assert.equal((await get(path, token('HOSPITAL_DESK', db.hospitals[0].hospital_id))).status, 403, path);
    assert.equal((await get(path, token('PARAMEDIC'))).status, 403, path);
    assert.equal((await get(path)).status, 200, path);
  }
});

test('the history window is computed on the server in epoch ms (default 28 days ending now)', async () => {
  const before = Date.now();
  const { body } = await get('/history');
  const after = Date.now();
  const w = body.history.window;
  // to_ms is the server clock at the request, floored to its whole second (S3).
  assert.ok(w.to_ms >= Math.floor(before / 1000) * 1000 && w.to_ms <= after, 'to_ms is the server clock at the request');
  assert.equal(w.to_ms % 1000, 0, 'floored to a whole second');
  assert.equal(w.to_ms - w.from_ms, 28 * DAY);
  assert.equal(w.bounds, '[from_ms, to_ms), UTC');
  const one = (await get('/history?days=1')).body.history.window;
  assert.equal(one.to_ms - one.from_ms, DAY);
  const fixed = (await get('/history?from_ms=1770000000000&to_ms=1770086400000')).body.history.window;
  assert.deepEqual([fixed.from_ms, fixed.to_ms, fixed.from], [1770000000000, 1770086400000, '2026-02-02T02:40:00.000Z']);
  // Sub-second bounds are floored, and the response echoes the floored window.
  const floored = (await get('/history?from_ms=1770000000700&to_ms=1770086400999')).body.history.window;
  assert.deepEqual([floored.from_ms, floored.to_ms, floored.to], [1770000000000, 1770086400000, '2026-02-03T02:40:00.000Z']);
});

test('unknown query parameters are answered 400 with the parameter named (S7)', async () => {
  const h = await get('/history?from=1770000000000');
  assert.equal(h.status, 400);
  assert.equal(h.body.error, 'Unknown query parameter: from (allowed: from_ms, to_ms, days).');
  const f = await get('/forecast?as_of=1770000000000');
  assert.equal(f.status, 400);
  assert.equal(f.body.error, 'Unknown query parameter: as_of (allowed: as_of_ms, history_days, horizon_days).');
});

test('invalid windows are rejected with 400 and a reason, never silently adjusted', async () => {
  for (const q of ['from_ms=abc', 'days=0', 'days=367', 'days=1&days=2', 'from_ms=1770000000000&days=2', 'from_ms=1770086400000&to_ms=1770000000000',
    `from_ms=1770000000000&to_ms=${1770000000000 + 367 * DAY}`]) {
    const res = await get(`/history?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.success, false, q);
    assert.match(res.body.error, /\w/, q);
  }
  for (const q of ['horizon_days=15', 'horizon_days=0', 'history_days=400', 'as_of_ms=yesterday']) {
    assert.equal((await get(`/forecast?${q}`)).status, 400, q);
  }
});

test('observed history and forecast are separate reports; the sparse demo data yields insufficient_data, not numbers', async () => {
  const { body: h } = await get('/history');
  assert.equal(h.history.kind, 'observed');
  assert.ok(!JSON.stringify(h).includes('"points"') && !('forecast' in h), 'no forecast inside observed history');
  const { body: f } = await get('/forecast');
  assert.equal(f.forecast.kind, 'forecast');
  assert.ok(!('hospitals' in f.forecast) && !('demand' in f.forecast), 'no observed metrics inside the forecast');
  assert.equal(f.forecast.cases_per_day.status, 'insufficient_data');
  assert.deepEqual(f.forecast.cases_per_day.required, { days: 14, events: 30 });
  assert.match(f.forecast.method, /seasonal-naive/);
  assert.deepEqual(f.forecast.not_forecast, ['resource availability: needs a length-of-stay / release-time model, which is not built (see docs/analytics.md)']);
  // as_of_ms is honoured and the as_of day is excluded: history ends at that UTC midnight.
  const asOf = Date.UTC(2026, 1, 16, 13, 30);
  const pinned = (await get(`/forecast?as_of_ms=${asOf}&history_days=14&horizon_days=3`)).body.forecast;
  assert.deepEqual([pinned.history_window.from_ms, pinned.history_window.to_ms, pinned.horizon_days], [Date.UTC(2026, 1, 2), Date.UTC(2026, 1, 16), 3]);
});

test('seeded hospital priors are returned only as labelled configuration, never as observed performance (D8b)', async () => {
  const { body } = await get('/history');
  // S1: the fresh demo seed has three cases, all marked is_demo, so nothing is observed demand. The window is pinned
  // to contain their request_time (stamped when the seed loaded), so they are excluded by the flag, not by timing.
  const seeded = db.emergencyRequests.filter(r => r.is_demo === 1);
  assert.deepEqual(seeded.map(r => r.request_id), ['REQ-8901', 'REQ-8902', 'REQ-8903'], 'the demo seed marks its three cases');
  const toMs = Math.max(...seeded.map(r => Date.parse(r.request_time))) + 60_000;
  const demoWindow = (await get(`/history?days=1&to_ms=${toMs}`)).body.history;
  assert.ok(seeded.every(r => Date.parse(r.request_time) >= demoWindow.window.from_ms && Date.parse(r.request_time) < demoWindow.window.to_ms),
    'the demo cases lie inside the window');
  assert.equal(demoWindow.demand.total_cases, 0, 'demo cases are not counted as observed demand');
  for (const seeded of db.hospitals) {
    const h = body.history.hospitals.find(x => x.hospital_id === seeded.hospital_id);
    assert.deepEqual(h.configured_ranking_prior, {
      acceptance_rate: seeded.acceptance_rate, avg_response_sec: seeded.avg_response_sec,
      note: 'configured value used to rank failover candidates (D8b); not an observation'
    });
    // The demo seed has no recorded referral, so the observed rate is gated on an empty sample and carries no value
    // at all (in particular, not the seeded prior).
    assert.deepEqual(h.observed_acceptance_rate, { status: 'insufficient_data', sample_size: 0, required: 20 });
    assert.deepEqual(h.referrals, { received: 0, accepted: 0, rejected: 0, expired: 0, pending: 0, cancelled: 0 });
  }
});

test('the existing endpoints keep their response shapes (D8-a8)', async () => {
  const keys = o => Object.keys(o).sort();
  const dash = (await get('/dashboard')).body;
  assert.deepEqual(keys(dash), ['dashboard', 'success']);
  assert.deepEqual(keys(dash.dashboard), ['hospital_statuses', 'kpis', 'timestamp']);
  assert.deepEqual(keys(dash.dashboard.kpis), ['active_emergencies', 'available_ambulances', 'available_doctors', 'avg_referral_response_sec', 'critical_p1_waiting',
    'hospitals_closed', 'hospitals_limited', 'hospitals_open', 'icu_available', 'icu_locked', 'icu_total', 'ot_available', 'ventilators_available', 'ventilators_total']);
  assert.deepEqual(keys(dash.dashboard.hospital_statuses[0]), ['capacity_color', 'emergency_status', 'hospital_id', 'hospital_name', 'icu_available', 'icu_total']);
  const ref = (await get('/referrals')).body;
  assert.deepEqual(keys(ref), ['by_hospital', 'success', 'summary']);
  assert.deepEqual(keys(ref.summary), ['accepted', 'cancelled', 'expired', 'pending', 'rejected', 'total']);
  assert.deepEqual(keys(ref.by_hospital[0]), ['acceptance_rate', 'accepted', 'cancelled', 'expired', 'hospital_id', 'hospital_name', 'rejected', 'total']);
  const res = (await get('/resources')).body;
  assert.deepEqual(keys(res), ['success', 'utilization']);
  assert.deepEqual(keys(res.utilization[0]), ['hospital_id', 'hospital_name', 'resources']);
  assert.deepEqual(keys(Object.values(res.utilization[0].resources)[0]), ['available', 'in_use', 'locked', 'total', 'utilization_pct']);
  const audit = (await get('/audit')).body;
  assert.deepEqual(keys(audit), ['audit_trail', 'count', 'success']);
});
