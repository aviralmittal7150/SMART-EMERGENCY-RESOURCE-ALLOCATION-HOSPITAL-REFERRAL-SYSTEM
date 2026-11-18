// e2e/tracking.mjs
// Ambulance live-tracking demo, end to end in a real browser, with the three account types (Admin, Hospital, Fleet):
//   Admin loads the sample trip (twice: no duplicate; its unit is crewed by a Fleet login, shown as "Fleet login") →
//   Admin sees it on the map → Admin starts → the marker follows the server's positions (no jump) for Admin, the trip's
//   Fleet crew and the destination Hospital → ARRIVED_AT_PATIENT → Pause / Resume → Fleet confirms the pickup → to the
//   hospital → ARRIVED_AT_HOSPITAL → Fleet completes (the Hospital view follows live) → Reset → Start again; role
//   limits; retired Operator/Patient logins refused; 390/768 layouts; zero CSP violations.
//
//   TRK_BACKEND=memory TRK_PORT=4370 TRK_SHOTS=<dir> node e2e/tracking.mjs
// The harness (server, accounts with per-run passwords, browser kit) is e2e/batch5/lib.mjs.

import path from 'node:path';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';
import {
  ROOT, CHROME, sleep, assert, acct, ACCOUNTS, results, issues, allowedConsole, state, note, step, ServerHandle, openMysql, resetMysql,
  makeApi, makeBrowserKit, summary
} from './batch5/lib.mjs';

const BACKEND = process.env.TRK_BACKEND === 'mysql' ? 'mysql' : 'memory';
// Routing: 'fake' = a local OSRM-compatible fake (road routes, route_source 'osrm'); 'off' = no routing ('simulated').
// A test never calls the public routing service.
const ROUTING = process.env.TRK_ROUTING === 'off' ? 'off' : 'fake';
const FAKE_OSRM_PORT = Number(process.env.TRK_FAKE_OSRM_PORT || 4382);
const EXPECT_SOURCE = ROUTING === 'fake' ? 'osrm' : 'simulated';
const PORT = Number(process.env.TRK_PORT || 4370);
const reserved = p => [3000, 4000, 5050, 5060, 5070].includes(p) || (p >= 4310 && p <= 4360) || (p >= 4400 && p <= 4430);
if (reserved(PORT)) throw new Error(`Port ${PORT} is reserved.`);
state.shots = process.env.TRK_SHOTS || path.join(ROOT, 'e2e', 'screenshots', `tracking-${BACKEND}`);
mkdirSync(state.shots, { recursive: true });

const ADMIN = acct('ADMIN');
const MOVING = ['EN_ROUTE_TO_PATIENT', 'EN_ROUTE_TO_HOSPITAL'];
const parseLL = s => (s ? s.split(',').map(Number) : null);
const ll = p => [Number(p.lat), Number(p.lng)];
const km = (a, b) => { const t = x => (x * Math.PI) / 180; const h = Math.sin(t(b[0] - a[0]) / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(t(b[1] - a[1]) / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); };
const currentStepName = () => state.currentStep;
const randomPart = () => Math.random().toString(36).slice(2, 12);
const same6 = (a, b) => a && b && a[0].toFixed(6) === b[0].toFixed(6) && a[1].toFixed(6) === b[1].toFixed(6);

let browser; let server; let db = null; let fakeOsrm = null;
const fakeOsrmRequests = [];

/** An OSRM-compatible fake: a route bowed slightly off the straight line, as a road would be. Loopback only. */
function startFakeOsrm() {
  fakeOsrm = http.createServer((req, res) => {
    const m = /^\/route\/v1\/driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)/.exec(req.url || '');
    fakeOsrmRequests.push(req.url);
    if (!m) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'InvalidUrl' })); }
    const [lng1, lat1, lng2, lat2] = m.slice(1).map(Number);
    const n = 24; const coordinates = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n; const bow = Math.sin(Math.PI * k) * 0.004; // ~400 m off the straight line at mid-leg
      coordinates.push([lng1 + (lng2 - lng1) * k + bow, lat1 + (lat2 - lat1) * k]);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates } }] }));
  });
  return new Promise((resolve, reject) => { fakeOsrm.once('error', reject); fakeOsrm.listen(FAKE_OSRM_PORT, '127.0.0.1', resolve); });
}
async function main() {
  if (BACKEND === 'mysql') { db = await openMysql(); await resetMysql(db); }
  server = new ServerHandle({ backend: BACKEND, port: PORT, db, portRange: [4370, 4399] });
  // Faster simulated time for the test only (the server refuses it in production): ticks of 500 ms, 5 s per second.
  if (ROUTING === 'fake') await startFakeOsrm();
  // SIMULATED_TRANSPORT off: this suite drives the trips itself ("Create demo trip" for a freshly accepted case); with the
  // Batch 8 development default (on) the accept already starts a trip, so that case could never get a demo trip (409).
  await server.start({ TRACKING_TICK_MS: '500', TRACKING_TIME_SCALE: '5', SIMULATED_TRANSPORT: 'off',
    ROUTING_URL: ROUTING === 'fake' ? `http://127.0.0.1:${FAKE_OSRM_PORT}` : 'off', ROUTING_TIMEOUT_MS: '2000' });
  const { api, login, expectDenied } = makeApi(server);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const kit = makeBrowserKit(browser, server);
  const { newPage, waitFor, waitOrExplain, text, press, loginUI, openTab } = kit;
  const ctx = {};
  ctx.adminToken = await login(ADMIN);
  const getTrip = async (id, token = ctx.adminToken) => (await api(token, `/tracking/trips/${id}`)).body?.trip;
  /** The marker position the page shows now, the trip phase and progress shown. */
  const shown = page => page.evaluate(() => ({
    amb: document.getElementById('trackingMap')?.dataset.ambulance || null,
    phase: document.getElementById('trackingTripDetails')?.dataset.phase || null,
    progress: Number((document.getElementById('trackingProgress')?.textContent || '').replace('%', '')),
    paused: /paused/.test(document.getElementById('trackingPhase')?.textContent || '')
  }));
  const buttonState = page => page.$$eval('#trackingControls button', bs => Object.fromEntries(bs.map(b => [b.dataset.action, !b.disabled])));

  // ── Admin: the sample trip, twice ──
  const admin = await newPage('admin');
  await step('T1. Admin loads the sample demo trip twice: one trip, reset and re-used, no duplicate', async () => {
    await loginUI(admin, ADMIN);
    await openTab(admin, 'tab-tracking');
    await press(admin, '#btnTrackingSample');
    await waitOrExplain(admin, () => document.getElementById('trackingTripDetails'));
    const first = (await api(ctx.adminToken, '/tracking/trips')).body.trips;
    await press(admin, '#btnTrackingSample');
    await waitOrExplain(admin, () => /Sample demo trip ready/.test(document.getElementById('trackingMessage').textContent));
    const second = (await api(ctx.adminToken, '/tracking/trips')).body.trips;
    const demos = second.filter(t => t.is_demo);
    assert(demos.length === 1 && second.length === first.length && demos[0].trip_id === first.find(t => t.is_demo)?.trip_id, `trips after two loads: ${JSON.stringify(second.map(t => [t.trip_id, t.is_demo]))}`);
    ctx.trip = demos[0];
    assert(ctx.trip.route_source === EXPECT_SOURCE, `route_source ${ctx.trip.route_source}, expected ${EXPECT_SOURCE} (routing ${ROUTING})`);
    assert(ROUTING === 'fake' ? fakeOsrmRequests.length >= 2 : fakeOsrmRequests.length === 0, `fake routing service saw ${fakeOsrmRequests.length} request(s)`);
    if (ROUTING === 'fake') assert(ctx.trip.route_to_patient.length > 10 && ctx.trip.route_to_hospital.length > 10, 'the road route has too few points');
    const options = await admin.$$eval('#trackingTripSelect option', os => os.map(o => o.value).filter(Boolean));
    assert(options.length === second.length && options.includes(ctx.trip.trip_id), `selector shows ${options.length} trips; server ${second.length}`);
    // The sample's unit is crewed by a Fleet login (the demo's UNIT-402 on AMB-01), and the admin is told which one.
    const expectedCrew = ACCOUNTS.filter(a => a.role === 'PARAMEDIC' && a.ambulance_id === ctx.trip.ambulance.ambulance_id).map(a => a.username).sort();
    assert(ctx.trip.ambulance.ambulance_id === 'AMB-01' && expectedCrew.includes('UNIT-402') && JSON.stringify(ctx.trip.crew) === JSON.stringify(expectedCrew),
      `sample unit ${ctx.trip.ambulance.ambulance_id}, crew ${JSON.stringify(ctx.trip.crew)} (expected ${JSON.stringify(expectedCrew)})`);
    await waitOrExplain(admin, id => document.getElementById('trackingTripDetails')?.dataset.tripId === id, ctx.trip.trip_id);
    const shownCrew = await text(admin, '#trackingCrew');
    assert(shownCrew === expectedCrew.join(', ') && /Fleet login/.test(await text(admin, '#trackingTripDetails')), `Fleet login shown: "${shownCrew}"`);
    assert((await text(admin, '#trackingMessage')).includes(`signing in as ${expectedCrew.join(', ')} (Fleet)`), 'the ready message does not name the Fleet login');
    // No Operator or Patient account exists any more (the sample no longer creates patient_demo).
    const users = (await api(ctx.adminToken, '/admin/users?limit=200')).body.users;
    const retired = users.filter(u => ['DISPATCHER', 'PATIENT'].includes(u.role) || ['dispatch_ops', 'patient_demo', 'patient_vance', 'patient_jenkins'].includes(u.username));
    assert(users.length > 0 && retired.length === 0, `retired accounts present: ${retired.map(u => `${u.username}/${u.role}`).join(', ')}`);
    note(`sample trip ${ctx.trip.trip_id}: ${ctx.trip.request_id} ambulance ${ctx.trip.ambulance.ambulance_id} (Fleet ${ctx.trip.crew.join(', ')}) → ${ctx.trip.hospital.name}; route ${ctx.trip.route_source}`);
  });

  await step('T1b. Admin assigns an ambulance with "Create demo trip": validation, start defaulted to the unit\'s position, hospital read-only; the trip is stored and runs', async () => {
    allowedConsole.push({ step: currentStepName(), re: /status of 409/ }); // the deliberate second create
    // An allocated case with a pickup, accepted by H-102 (the referral path, through the API).
    const c = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: { patient_name: 'Form Trip Patient', age: 52, emergency_type: 'GENERAL', triage_priority: 2, pickup_lat: 30.2672, pickup_lng: 78.0300 } });
    assert(c.status === 201, `case ${c.status}`);
    const init = await api(ctx.adminToken, '/referrals/initiate', { method: 'POST', body: { request_id: c.body.request_id, hospital_id: 'H-102' } });
    assert(init.status === 201, `referral ${init.status} ${JSON.stringify(init.body)}`);
    assert((await api(ctx.adminToken, `/referrals/${init.body.acceptance_id}/accept`, { method: 'POST' })).status === 200, 'accept');
    const rid = c.body.request_id;
    const units = (await api(ctx.adminToken, '/ambulances')).body.ambulances;
    const busy = new Set((await api(ctx.adminToken, '/tracking/trips')).body.trips.filter(t => !t.completed).map(t => t.ambulance.ambulance_id));
    const caseUnit = (await api(ctx.adminToken, `/emergencies/${rid}`)).body.request.assigned_ambulance_id;
    const unit = units.find(u => u.ambulance_id === caseUnit && !busy.has(u.ambulance_id)) || units.find(u => !busy.has(u.ambulance_id) && u.current_lat !== null);
    assert(unit, 'no ambulance free for a second trip');
    await press(admin, '#refreshWorkspaceBtn');
    try {
      await waitFor(admin, r => [...document.querySelectorAll('#trkCase option')].some(o => o.value === r), rid);
    } catch {
      const seen = await admin.evaluate(() => ({ options: [...document.querySelectorAll('#trkCase option')].map(o => o.value), ready: document.getElementById('trackingAdmin').dataset.ready }));
      const item = (await api(ctx.adminToken, '/emergencies')).body.queue.find(q => q.request_id === rid);
      throw new Error(`case ${rid} not offered: form ${JSON.stringify(seen)}; server ${JSON.stringify(item && { s: item.status, h: item.accepted_hospital_id, lat: item.pickup_lat })}`);
    }
    await admin.select('#trkCase', rid);
    const hosp = (await api(ctx.adminToken, '/hospitals')).body.hospitals.find(h => h.hospital_id === 'H-102');
    const shownHosp = await text(admin, '#trkHospital');
    assert(shownHosp.includes(hosp.hospital_name) && shownHosp.includes(Number(hosp.location_lat).toFixed(5)), `read-only destination: ${shownHosp}`);
    await admin.select('#trkAmbulance', unit.ambulance_id);
    const start = await admin.evaluate(() => [document.getElementById('trkStartLat').value, document.getElementById('trkStartLng').value]);
    assert(Number(start[0]) === Number(unit.current_lat) && Number(start[1]) === Number(unit.current_lng), `start ${start} is not the unit's position ${unit.current_lat},${unit.current_lng}`);
    // Client-side validation first: nothing is sent.
    await admin.$eval('#trkSpeed', n => { n.value = '5'; });
    admin.__api.length = 0;
    await press(admin, '#btnTrackingCreate');
    await waitOrExplain(admin, () => /Speed must be/.test(document.getElementById('trkFormError').textContent));
    assert(!admin.__api.some(c2 => c2.startsWith('POST /api/v1/tracking/demo-trips')), 'an invalid form was sent');
    await admin.$eval('#trkSpeed', n => { n.value = '90'; });
    await press(admin, '#btnTrackingCreate');
    await waitOrExplain(admin, r => new RegExp(`Demo trip created for ${r}`).test(document.getElementById('trackingMessage').textContent), rid);
    const trip = (await api(ctx.adminToken, '/tracking/trips')).body.trips.find(t => t.request_id === rid && !t.completed);
    assert(trip && trip.ambulance.ambulance_id === unit.ambulance_id && trip.speed_kmh === 90 && trip.hospital.hospital_id === 'H-102'
      && same6(ll(trip.start), [Number(unit.current_lat), Number(unit.current_lng)]) && trip.phase === 'DISPATCHED', `stored trip ${JSON.stringify(trip && { a: trip.ambulance, s: trip.start, v: trip.speed_kmh, h: trip.hospital.hospital_id, p: trip.phase })}`);
    // A second create for the same case is refused by the server, and the form shows why.
    await press(admin, '#btnTrackingCreate');
    await waitOrExplain(admin, () => /^Not created:/.test(document.getElementById('trkFormError').textContent));
    // It runs: Start from the admin's controls, progress rises, then reset.
    await admin.select('#trackingTripSelect', trip.trip_id);
    await waitOrExplain(admin, id => document.getElementById('trackingTripDetails')?.dataset.tripId === id, trip.trip_id);
    await press(admin, '#trackingControls button[data-action="start"]');
    await waitOrExplain(admin, () => Number(document.getElementById('trackingProgress').textContent.replace('%', '')) > 0, null, 30000);
    await press(admin, '#trackingControls button[data-action="reset"]');
    await waitOrExplain(admin, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'DISPATCHED');
    ctx.formTrip = trip;
    note(`form trip ${trip.trip_id}: ${rid} with ${unit.ambulance_id} → H-102 at 90 km/h, start = unit position`);
  });

  // ── Admin drives the demo from here on; the trip's Fleet crew and the destination Hospital follow it live ──
  const op = admin;
  await step('T2. Admin sees the sample trip on the map: ambulance, pickup and hospital markers and both routes, at the server\'s coordinates', async () => {
    await waitOrExplain(op, id => [...document.querySelectorAll('#trackingTripSelect option')].some(o => o.value === id), ctx.trip.trip_id);
    await op.select('#trackingTripSelect', ctx.trip.trip_id);
    await waitOrExplain(op, id => document.getElementById('trackingTripDetails')?.dataset.tripId === id, ctx.trip.trip_id);
    await waitOrExplain(op, () => { const d = document.getElementById('trackingMap')?.dataset; return d?.ambulance && d.pickup && d.hospital; });
    const t = await getTrip(ctx.trip.trip_id);
    const m = await op.$eval('#trackingMap', n => ({ ...n.dataset }));
    assert(same6(parseLL(m.pickup), ll(t.pickup)) && same6(parseLL(m.hospital), [t.hospital.lat, t.hospital.lng].map(Number)) && same6(parseLL(m.ambulance), ll(t.current)),
      `map ${JSON.stringify(m)} vs server pickup ${JSON.stringify(t.pickup)} hospital ${t.hospital.lat},${t.hospital.lng} current ${JSON.stringify(t.current)}`);
    const layers = await op.evaluate(() => ({
      amb: document.querySelectorAll('#trackingMap .trk-ambulance').length, pickup: document.querySelectorAll('#trackingMap .trk-pickup').length,
      hospital: document.querySelectorAll('#trackingMap .trk-hospital').length,
      toPatient: document.querySelectorAll('#trackingMap path.trk-line-to-patient').length, toHospital: document.querySelectorAll('#trackingMap path.trk-line-to-hospital').length,
      imgs: [...document.querySelectorAll('#trackingMap img.leaflet-marker-icon')].length
    }));
    assert(layers.amb === 1 && layers.pickup === 1 && layers.hospital === 1 && layers.toPatient === 1 && layers.toHospital === 1 && layers.imgs === 0, `map layers ${JSON.stringify(layers)}`);
    const labels = await text(op, '#tab-tracking');
    assert(/Simulated position — not real GPS/.test(labels) && labels.includes(t.route_source === 'osrm' ? 'Road route (OSRM)' : 'Simulated route'), 'route / simulated labels');
    const details = await text(op, '#trackingTripDetails');
    for (const v of [t.request_id, t.ambulance.ambulance_id, t.patient.full_name, ...ctx.trip.crew]) assert(details.includes(v), `details lack ${v}`);
    const b = await buttonState(op);
    assert(b.start && !b.pickup && !b.complete && !b.pause && !b.resume, `controls before start: ${JSON.stringify(b)}`);
    // OpenStreetMap refuses tile requests without a Referer ("Access blocked" tiles that still load as images), so the
    // request itself is checked: every tile asks the single tile host and names this page's origin.
    await waitOrExplain(op, () => document.querySelectorAll('#trackingMap img.leaflet-tile').length > 0);
    const tileHosts = await op.$$eval('#trackingMap img.leaflet-tile', ims => [...new Set(ims.map(i => new URL(i.src).host))]);
    assert(JSON.stringify(tileHosts) === JSON.stringify(['tile.openstreetmap.org']), `tile hosts ${tileHosts.join(', ')}`);
    assert(op.__tiles.length > 0 && op.__tiles.every(r => r === `${server.origin}/`), `tile Referer headers: ${JSON.stringify([...new Set(op.__tiles)])}`);
    note(`map tiles: ${op.__tiles.length} requests to tile.openstreetmap.org, Referer ${server.origin}/`);
  });

  await step('T2b. The trip\'s Fleet crew and the destination Hospital open their live views before the start', async () => {
    const crew = acct('PARAMEDIC', a => ctx.trip.crew.includes(a.username) && a.ambulance_id === ctx.trip.ambulance.ambulance_id);
    assert(crew, `no Fleet login crews ${ctx.trip.ambulance.ambulance_id}`);
    ctx.crew = crew;
    ctx.paraPage = await newPage('fleet');
    await loginUI(ctx.paraPage, crew);
    await openTab(ctx.paraPage, 'tab-tracking');
    await waitOrExplain(ctx.paraPage, id => document.getElementById('trackingTripDetails')?.dataset.tripId === id && document.getElementById('trackingMap').dataset.ambulance, ctx.trip.trip_id);
    const desk = acct('HOSPITAL_DESK', a => a.hospital_id === ctx.trip.hospital.hospital_id);
    assert(desk, `no Hospital login for ${ctx.trip.hospital.hospital_id}`);
    ctx.desk = desk;
    ctx.deskPage = await newPage('hospital');
    await loginUI(ctx.deskPage, desk);
    await openTab(ctx.deskPage, 'tab-tracking');
    await waitOrExplain(ctx.deskPage, id => [...document.querySelectorAll('#trackingTripSelect option')].some(o => o.value === id), ctx.trip.trip_id);
    await ctx.deskPage.select('#trackingTripSelect', ctx.trip.trip_id);
    await waitOrExplain(ctx.deskPage, id => document.getElementById('trackingTripDetails')?.dataset.tripId === id && document.getElementById('trackingMap').dataset.ambulance, ctx.trip.trip_id);
    note(`Fleet ${crew.username} (${crew.ambulance_id}) and Hospital ${desk.username} (${desk.hospital_id}) follow ${ctx.trip.trip_id}`);
  });

  /** Follow the trip on the admin page until `until(phase)`; check movement, sync and no jumps (Fleet and Hospital too). */
  async function follow(until, { timeout = 150000, pauseAt = null } = {}) {
    const samples = []; const serverPositions = []; const paraSamples = []; const deskSamples = [];
    const t0 = Date.now(); let paused = false;
    while (Date.now() - t0 < timeout) {
      const s = await shown(op);
      samples.push({ ...s, at: Date.now() });
      if (ctx.paraPage) paraSamples.push(await shown(ctx.paraPage));
      if (ctx.deskPage) deskSamples.push(await shown(ctx.deskPage));
      if (samples.length % 4 === 0) { const t = await getTrip(ctx.trip.trip_id); serverPositions.push({ cur: ll(t.current), phase: t.phase, progress: t.progress }); }
      if (pauseAt && !paused && s.progress >= pauseAt && MOVING.includes(s.phase)) { paused = true; await pauseResume(); }
      if (until(s.phase)) break;
      await sleep(250);
    }
    return { samples, serverPositions, paraSamples, deskSamples };
  }
  /** A live view (Fleet, Hospital) moved with the trip: several positions, no jump. */
  function checkLive(label, list, from, to) {
    const pts = list.map(x => parseLL(x.amb)).filter(Boolean);
    const distinct = new Set(pts.map(p => p.map(v => v.toFixed(5)).join(','))).size;
    assert(distinct >= 3, `${label}: the live view took only ${distinct} distinct positions during the leg`);
    const legKm = km(from, to);
    const maxJump = Math.max(...pts.slice(1).map((p, i) => km(pts[i], p)));
    assert(maxJump < legKm * 0.5, `${label}: the live view jumped ${maxJump.toFixed(3)} km (leg ${legKm.toFixed(3)} km)`);
    note(`${label}: ${distinct} distinct live positions, largest move ${maxJump.toFixed(3)} km`);
  }
  async function pauseResume() {
    await waitOrExplain(op, () => !document.querySelector('#trackingControls button[data-action="pause"]').disabled);
    await press(op, '#trackingControls button[data-action="pause"]');
    await waitOrExplain(op, () => /paused/.test(document.getElementById('trackingPhase').textContent));
    const a = (await getTrip(ctx.trip.trip_id)).current; const ua = (await shown(op)).amb;
    await sleep(2500);
    const b = (await getTrip(ctx.trip.trip_id)).current; const ub = (await shown(op)).amb;
    assert(same6(ll(a), ll(b)) && ua === ub, `moved while paused: server ${JSON.stringify(a)}→${JSON.stringify(b)}, UI ${ua}→${ub}`);
    const btn = await buttonState(op);
    assert(btn.resume && !btn.pause, `controls while paused: ${JSON.stringify(btn)}`);
    await press(op, '#trackingControls button[data-action="resume"]');
    await waitOrExplain(op, () => !/paused/.test(document.getElementById('trackingPhase').textContent));
    ctx.pausedChecked = true;
  }
  function checkLeg(samples, serverPositions, from, to, label) {
    const pts = samples.map(s => parseLL(s.amb)).filter(Boolean);
    const distinct = new Set(pts.map(p => p.map(v => v.toFixed(5)).join(','))).size;
    assert(distinct >= 4, `${label}: the marker took only ${distinct} distinct positions (it should move over several ticks)`);
    const steps = serverPositions.slice(1).map((p, i) => km(serverPositions[i].cur, p.cur)).filter(d => d > 0);
    const legKm = km(from, to);
    const maxJump = Math.max(...pts.slice(1).map((p, i) => km(pts[i], p)));
    assert(maxJump < legKm * 0.5, `${label}: the marker jumped ${maxJump.toFixed(3)} km in one sample (leg ${legKm.toFixed(3)} km)`);
    let prog = -1;
    for (const s of samples.filter(x => MOVING.includes(x.phase))) {
      assert(s.progress >= prog, `${label}: progress went back ${prog} → ${s.progress}`);
      prog = s.progress;
    }
    note(`${label}: ${samples.length} samples, ${distinct} distinct marker positions, largest sample move ${maxJump.toFixed(3)} km of a ${legKm.toFixed(3)} km leg, ${steps.length} server steps`);
  }

  await step('T3. Admin starts: the marker follows the server over several ticks (no jump, progress monotonic) for Admin, Fleet and Hospital; Pause stops it, Resume continues; ARRIVED_AT_PATIENT at the pickup', async () => {
    const before = await getTrip(ctx.trip.trip_id);
    await press(op, '#trackingControls button[data-action="start"]');
    await waitOrExplain(op, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'EN_ROUTE_TO_PATIENT');
    const b = await buttonState(op);
    assert(!b.start && !b.pickup && b.pause, `controls while moving: ${JSON.stringify(b)}`);
    const { samples, serverPositions, paraSamples, deskSamples } = await follow(p => p === 'ARRIVED_AT_PATIENT', { pauseAt: 30 });
    assert(ctx.pausedChecked, 'pause/resume was not exercised');
    const t = await getTrip(ctx.trip.trip_id);
    assert(t.phase === 'ARRIVED_AT_PATIENT', `server phase ${t.phase}`);
    checkLeg(samples, serverPositions, ll(before.current), ll(t.pickup), 'to patient');
    checkLive('Fleet, to patient', paraSamples, ll(before.current), ll(t.pickup));
    checkLive('Hospital, to patient', deskSamples, ll(before.current), ll(t.pickup));
    for (const page of [ctx.paraPage, ctx.deskPage]) await waitOrExplain(page, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'ARRIVED_AT_PATIENT');
    await waitOrExplain(op, p => document.getElementById('trackingMap').dataset.ambulance === `${p[0].toFixed(6)},${p[1].toFixed(6)}`, ll(t.current));
    assert(same6(ll(t.current), ll(t.pickup)), `arrived at ${JSON.stringify(t.current)}, pickup ${JSON.stringify(t.pickup)}`);
    const btn = await buttonState(op);
    assert(btn.pickup && !btn.complete && !btn.start, `controls at the patient: ${JSON.stringify(btn)}`);
  });

  await step('T4. Fleet confirms the pickup → the ambulance moves to the hospital (Admin, Fleet and Hospital views) → ARRIVED_AT_HOSPITAL → Fleet completes the trip; the Hospital view shows it completed', async () => {
    const at = await getTrip(ctx.trip.trip_id);
    const pb = await buttonState(ctx.paraPage);
    assert(pb.pickup && !pb.complete && !pb.start, `Fleet controls at the patient: ${JSON.stringify(pb)}`);
    await press(ctx.paraPage, '#trackingControls button[data-action="pickup"]');
    const { samples, serverPositions, paraSamples, deskSamples } = await follow(p => p === 'ARRIVED_AT_HOSPITAL');
    const t = await getTrip(ctx.trip.trip_id);
    assert(t.phase === 'ARRIVED_AT_HOSPITAL', `server phase ${t.phase}`);
    checkLeg(samples.filter(s => s.phase !== 'ARRIVED_AT_PATIENT'), serverPositions, ll(at.current), [t.hospital.lat, t.hospital.lng].map(Number), 'to hospital');
    assert(same6(ll(t.current), [t.hospital.lat, t.hospital.lng].map(Number)), `arrived at ${JSON.stringify(t.current)} not the hospital`);
    const hosp = [t.hospital.lat, t.hospital.lng].map(Number);
    checkLive('Fleet, to hospital', paraSamples.filter(x => x.phase !== 'ARRIVED_AT_PATIENT'), ll(at.current), hosp);
    checkLive('Hospital, to hospital', deskSamples.filter(x => x.phase !== 'ARRIVED_AT_PATIENT'), ll(at.current), hosp);
    assert(deskSamples.some(x => x.phase === 'EN_ROUTE_TO_HOSPITAL'), 'the Hospital view never showed the ambulance on its way');
    const btn = await buttonState(op);
    assert(btn.complete && !btn.pickup, `controls at the hospital: ${JSON.stringify(btn)}`);
    await waitOrExplain(ctx.paraPage, () => !document.querySelector('#trackingControls button[data-action="complete"]').disabled);
    await press(ctx.paraPage, '#trackingControls button[data-action="complete"]');
    for (const page of [op, ctx.deskPage]) await waitOrExplain(page, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'COMPLETED');
    // A Fleet login lists only its unit's active trips (server scope), so the completed trip leaves the Fleet's list.
    await waitOrExplain(ctx.paraPage, id => ![...document.querySelectorAll('#trackingTripSelect option')].some(o => o.value === id), ctx.trip.trip_id);
    const done = await getTrip(ctx.trip.trip_id);
    assert(done.completed === true && done.timestamps.completed_at, `store not completed: ${JSON.stringify({ phase: done.phase, completed: done.completed })}`);
    const b2 = await buttonState(op);
    assert(!b2.start && !b2.pickup && !b2.complete && !b2.pause && b2.reset, `controls after completion: ${JSON.stringify(b2)}`);
  });

  await step('T5. Admin resets the demo and starts again: the trip runs again from its start (repeatable)', async () => {
    await press(op, '#trackingControls button[data-action="reset"]');
    await waitOrExplain(op, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'DISPATCHED');
    const t = await getTrip(ctx.trip.trip_id);
    assert(t.phase === 'DISPATCHED' && same6(ll(t.current), ll(t.start)), `after reset: ${t.phase} at ${JSON.stringify(t.current)}`);
    await waitOrExplain(op, p => document.getElementById('trackingMap').dataset.ambulance === `${p[0].toFixed(6)},${p[1].toFixed(6)}`, ll(t.start));
    await press(op, '#trackingControls button[data-action="start"]');
    await waitOrExplain(op, () => document.getElementById('trackingTripDetails')?.dataset.phase === 'EN_ROUTE_TO_PATIENT');
    await waitOrExplain(op, () => Number(document.getElementById('trackingProgress').textContent.replace('%', '')) > 0, null, 30000);
    await press(op, '#trackingControls button[data-action="pause"]');
  });

  // ── Role limits ──
  await step('T6. Fleet: only its own unit\'s trip, with only Start, Patient Picked Up and Complete', async () => {
    const crew = ctx.crew;
    const para = ctx.paraPage;
    const tok = await kit.token(para);
    const mine = (await api(tok, '/tracking/trips')).body.trips;
    assert(mine.every(t => t.ambulance.ambulance_id === crew.ambulance_id), `Fleet list has other units: ${mine.map(t => t.ambulance.ambulance_id)}`);
    assert(mine.every(t => !('crew' in t)), 'the crew list is sent to a Fleet login');
    await sleep(800);
    const opts = await para.$$eval('#trackingTripSelect option', os => os.map(o => o.value).filter(Boolean));
    assert(JSON.stringify(opts.sort()) === JSON.stringify(mine.map(t => t.trip_id).sort()), `Fleet selector ${opts} vs server ${mine.map(t => t.trip_id)}`);
    if (mine.length) {
      const actions = await para.$$eval('#trackingControls button', bs => bs.map(b => b.dataset.action));
      assert(JSON.stringify(actions) === JSON.stringify(['start', 'pickup', 'complete']), `Fleet controls: ${actions}`);
    }
    await expectDenied(tok, [['POST', `/tracking/trips/${ctx.trip.trip_id}/pause`], ['POST', `/tracking/trips/${ctx.trip.trip_id}/reset`], ['POST', '/tracking/demo-setup'], ['POST', '/tracking/demo-trips', {}]], [403, 404]);
    note(`Fleet ${crew.username} (${crew.ambulance_id}) sees ${mine.length} trip(s)`);
  });

  await step('T7. Hospital: sees the trip coming to its hospital, read-only with an ETA; another hospital does not', async () => {
    const desk = ctx.deskPage;
    assert((await desk.$$('#trackingControls button')).length === 0, 'the Hospital has trip controls');
    assert(/ETA/.test(await text(desk, '#trackingTripDetails')), 'no ETA shown to the Hospital');
    const deskTok = await kit.token(desk);
    await expectDenied(deskTok, [['POST', `/tracking/trips/${ctx.trip.trip_id}/start`], ['POST', `/tracking/trips/${ctx.trip.trip_id}/pickup`], ['POST', '/tracking/demo-setup']], [403, 404]);
    const other = await login(acct('HOSPITAL_DESK', a => a.hospital_id !== ctx.trip.hospital.hospital_id));
    const theirs = (await api(other, '/tracking/trips')).body.trips;
    assert(!theirs.some(t => t.trip_id === ctx.trip.trip_id), 'another hospital sees the trip');
  });

  await step('T8. Another Fleet unit neither sees the trip nor can drive it', async () => {
    const other = acct('PARAMEDIC', a => a.ambulance_id && a.ambulance_id !== ctx.trip.ambulance.ambulance_id);
    assert(other, 'no second Fleet login');
    const tok = await login(other);
    const theirs = (await api(tok, '/tracking/trips')).body.trips;
    assert(!theirs.some(t => t.trip_id === ctx.trip.trip_id), `${other.username} sees the trip`);
    await expectDenied(tok, [['GET', `/tracking/trips/${ctx.trip.trip_id}`], ['POST', `/tracking/trips/${ctx.trip.trip_id}/start`], ['POST', `/tracking/trips/${ctx.trip.trip_id}/pickup`], ['POST', `/tracking/trips/${ctx.trip.trip_id}/complete`]], [403, 404]);
  });

  await step('T9. Fleet and Hospital are not offered the admin demo controls; the retired Operator and Patient logins cannot sign in', async () => {
    for (const page of [ctx.paraPage, ctx.deskPage]) {
      const hidden = await page.evaluate(() => { const n = document.getElementById('trackingAdmin'); return !n || Boolean(n.closest('[hidden]')); });
      assert(hidden, `${page.__label} is offered the admin demo controls`);
    }
    for (const username of ['dispatch_ops', 'patient_demo', 'patient_vance', 'patient_jenkins']) {
      const r = await api(null, '/auth/login', { method: 'POST', body: { username, password: `not-a-password-${randomPart()}` }, as: `retired-${username}` });
      assert(r.status === 401, `${username}: login answered ${r.status}`);
    }
  });

  await step('T10. Mobile 390x844 and 768x1024: the map is full width with a usable height, details and controls below, no horizontal overflow (Admin, Fleet)', async () => {
    const problems = [];
    for (const [w, h] of [[390, 844], [768, 1024]]) {
      for (const a of [ADMIN, ctx.crew]) {
        const page = await newPage(`m${w}-${a.role}`, { width: w, height: h });
        try {
          await loginUI(page, a);
          await openTab(page, 'tab-tracking');
          await waitFor(page, id => [...document.querySelectorAll('#trackingTripSelect option')].some(o => o.value === id), ctx.trip.trip_id);
          await page.select('#trackingTripSelect', ctx.trip.trip_id);
          await waitOrExplain(page, () => document.getElementById('trackingMap')?.dataset.ambulance);
          const r = await page.evaluate(() => {
            const m = document.getElementById('trackingMap').getBoundingClientRect();
            const side = document.querySelector('.tracking-side')?.getBoundingClientRect();
            return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, w: m.width, h: m.height, vw: innerWidth, vh: innerHeight,
              below: side ? side.top >= m.bottom - 1 : false };
          });
          if (r.overflow > 0) problems.push(`${w} ${a.role}: ${r.overflow}px overflow`);
          if (r.w < r.vw - 80) problems.push(`${w} ${a.role}: map ${Math.round(r.w)}px wide of ${r.vw}`);
          if (r.h < Math.min(240, r.vh * 0.28)) problems.push(`${w} ${a.role}: map only ${Math.round(r.h)}px tall`);
          if (!r.below) problems.push(`${w} ${a.role}: details not stacked below the map`);
          await page.screenshot({ path: path.join(state.shots, `tracking-${w}-${a.role}.png`) });
        } catch (err) { problems.push(`${w} ${a.role}: ${err.message.split('\n')[0]}`); }
        await kit.closePage(page);
      }
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await step('T10b. Logout leaves no tracking state in the DOM (no position, trip, case or patient), for Admin, Fleet and Hospital', async () => {
    const secrets = [ctx.trip.trip_id, ctx.trip.request_id, ctx.trip.patient.full_name, ctx.trip.ambulance.ambulance_id,
      `${Number(ctx.trip.pickup.lat).toFixed(6)},${Number(ctx.trip.pickup.lng).toFixed(6)}`, ctx.formTrip?.trip_id, ctx.formTrip?.request_id].filter(Boolean);
    for (const page of [op, ctx.paraPage, ctx.deskPage]) {
      await press(page, '#logoutBtn');
      await waitFor(page, () => document.body.classList.contains('signed-out'));
      const found = await page.evaluate(list => {
        const attrs = [...document.querySelectorAll('*')].flatMap(n => [...n.attributes].map(a => a.value)).join('\n');
        const values = [...document.querySelectorAll('input, select, textarea')].map(n => n.value).join('\n');
        const dom = document.documentElement.textContent;
        const map = document.getElementById('trackingMap');
        return { leaked: list.filter(v => dom.includes(v) || attrs.includes(v) || values.includes(v)), map: map ? JSON.stringify({ ...map.dataset }) : '{}' };
      }, secrets);
      assert(found.leaked.length === 0 && found.map === '{}', `${page.__label} after logout still holds: ${found.leaked.join(', ')} ${found.map}`);
    }
  });

  await step('T11. No console errors, page errors or CSP violations', async () => {
    for (const [label, page] of state.pages) {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      csp.forEach(v => issues.push(`[${label}] CSP violation: ${v}`));
    }
    assert(issues.length === 0, `${issues.length} issue(s):\n${issues.slice(0, 20).join('\n')}`);
  });
}

let exitCode = 1;
try {
  await main();
  exitCode = results.every(r => r.ok) ? 0 : 1;
} catch (err) {
  console.log(`ABORT ${err.stack || err.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  await server?.stop();
  try { await db?.release?.(); } catch { /* ignore */ }
  fakeOsrm?.close();
}
summary(`Tracking demo [${BACKEND}, routing ${ROUTING}]`);
process.exit(exitCode);
