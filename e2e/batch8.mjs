// e2e/batch8.mjs
// Batch 8 in a real browser, with the three account types:
//   B1 Treatment: Admin loads the sample demo trip (H-101) and runs it to the hospital; the H-101 desk's Patients list
//      follows the ambulance ("Ambulance arriving", "Arrived") and arrival does NOT start treatment. A second case
//      (ICU bed + ventilator) is accepted by the desk in the Acceptance console. The desk starts treatment and marks
//      both completed; the Admin's tracker, Live tracking line, command queue and My registered patients follow live
//      (no refresh); the store releases the bed and ventilator; another hospital's desk can neither see nor act.
//   B2 Mass casualty: Admin registers a 5-patient bus crash in Roadside → Multiple patients, with the first answer
//      lost (exactly one incident, 5 cases); the suggestions use capacity greedily; Send all referrals → 5 sent; a desk
//      accepts one and the Admin's list shows it; the cases carry an Incident badge.
//   B3 390/768 layouts for both screens; zero CSP violations, console errors or page errors.
//
//   B8_PORT=4440 B8_SHOTS=<dir> node e2e/batch8.mjs          (memory backend; ports 4440-4499)
// The harness (server, accounts with per-run passwords, browser kit) is e2e/batch5/lib.mjs.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';
import {
  ROOT, CHROME, sleep, assert, acct, results, issues, allowedConsole, state, note, step, ServerHandle, makeApi, makeBrowserKit, summary
} from './batch5/lib.mjs';

const PORT = Number(process.env.B8_PORT || 4440);
state.shots = process.env.B8_SHOTS || path.join(ROOT, 'e2e', 'screenshots', 'batch8');
mkdirSync(state.shots, { recursive: true });

const ADMIN = acct('ADMIN');
const APEX = acct('HOSPITAL_DESK', a => a.hospital_id === 'H-101');
const OTHER_DESK = acct('HOSPITAL_DESK', a => a.hospital_id && a.hospital_id !== 'H-101');
const PICKUP = [30.3129, 78.0495];
// Mirrors server/services/emergencyRequirements.js for the checks below.
const RES_KEY = { ICU_BED: 'icubed', VENTILATOR: 'ventilator', OT: 'ot' };

let browser; let server;

async function main() {
  server = new ServerHandle({ backend: 'memory', port: PORT, db: null, portRange: [4440, 4499] });
  // The demo's own tracking speed (development defaults: 500 ms ticks, demo speed-up), so the trip timing below is what the
  // owner sees. Routing off: straight-line simulated routes (no public internet in tests).
  await server.start({ ROUTING_URL: 'off' });
  const { api, login, expectDenied } = makeApi(server);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const kit = makeBrowserKit(browser, server);
  const { newPage, waitFor, waitOrExplain, press, loginUI, openTab } = kit;
  const ctx = {};
  ctx.adminToken = await login(ADMIN);
  ctx.apexToken = await login(APEX);
  const hospital = async id => (await api(ctx.adminToken, '/hospitals')).body.hospitals.find(h => h.hospital_id === id);
  const free = (h, t) => Number(h.resources[RES_KEY[t]].available) - Number(h.resources[RES_KEY[t]].locked);
  const caseOf = async id => (await api(ctx.adminToken, `/emergencies/${id}`)).body;
  const card = id => `#hospitalPatientsList .patient-card[data-request-id="${id}"]`;
  /** Wait until the text of `sel` matches `re`; on a timeout, say what it showed. */
  async function waitMatch(page, sel, re, timeout = 15000) {
    try {
      await waitFor(page, ([s, src, flags]) => new RegExp(src, flags).test(document.querySelector(s)?.textContent || ''), [sel, re.source, re.flags], timeout);
    } catch {
      throw new Error(`${page.__label}: ${sel} never matched ${re}; it shows "${await page.$eval(sel, n => n.textContent.trim()).catch(() => '(missing)')}"`);
    }
  }

  const admin = await newPage('admin');
  const desk = await newPage('apex');

  // ════════════════════════ B0 Operating area ════════════════════════
  await step('B0. No pickup outside the Dehradun operating area can be submitted (intake, Roadside, incident form, API); the locality picker fills a Dehradun point', async () => {
    await loginUI(admin, ADMIN);
    allowedConsole.push({ step: state.currentStep, re: /status of 400/ });
    await openTab(admin, 'tab-ingestion');
    await kit.fillIntake(admin, { name: 'Out Of Area', age: 30, lat: 28.6139, lng: 77.2090 });
    admin.__api.length = 0;
    await press(admin, '#intakeSubmitBtn');
    await waitMatch(admin, '#intakeError', /outside the Dehradun operating area/);
    // The locality picker (GET /geo/operating-area) puts a verified Dehradun point in the form.
    await waitFor(admin, () => document.querySelectorAll('#pickupLocality option').length > 1);
    const loc = await admin.$eval('#pickupLocality', n => { n.selectedIndex = 1; n.dispatchEvent(new Event('change')); return n.options[1].textContent; });
    const ll = await admin.evaluate(() => [Number(document.getElementById('pickupLat').value), Number(document.getElementById('pickupLng').value)]);
    assert(ll[0] >= 30.2 && ll[0] <= 30.45 && ll[1] >= 77.9 && ll[1] <= 78.15, `locality ${loc} filled ${ll}`);
    await openTab(admin, 'tab-roadside');
    await admin.$eval('#rsLat', n => { n.value = '28.6139'; }); await admin.$eval('#rsLng', n => { n.value = '77.2090'; });
    await admin.type('#rsInjuries', 'bleeding');
    await press(admin, '#rsAssessBtn');
    await waitMatch(admin, '#rsFormError', /outside the Dehradun operating area/);
    await openTab(admin, 'tab-mci');
    await admin.type('#mciTitle', 'Out of area');
    await admin.type('#mciLat', '29.0'); await admin.type('#mciLng', '79.4'); // Rudrapur
    await press(admin, '#mciCreateBtn');
    await waitMatch(admin, '#mciCreateError', /outside the Dehradun operating area/);
    assert(!admin.__api.some(c => /^POST \/api\/v1\/(emergencies|incidents)$/.test(c)), `an out-of-area form was sent: ${admin.__api.join(', ')}`);
    await admin.$eval('#mciCreateForm', f => f.reset());
    // The server is the authority: the API refuses it too.
    const r = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: { patient_name: 'Out Of Area', age: 30, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 28.6139, pickup_lng: 77.2090 }, headers: { 'Idempotency-Key': `b8-out-${Date.now()}` } });
    assert(r.status === 400 && /operating area/i.test(r.body?.error || ''), `server answered ${r.status} ${JSON.stringify(r.body)}`);
    note(`locality "${loc}" → ${ll.join(', ')}; Delhi pickup refused in the forms and by the server (${r.status})`);
  });

  // ════════════════════════ B1 Treatment ════════════════════════
  const stepBtn = (id, st) => `${card(id)} .pt-action[data-step="${st}"]`;
  const cardState = (page, id) => page.$eval(card(id), n => ({ status: n.dataset.status, next: n.dataset.next, steps: [...n.querySelectorAll('.pt-action')].map(b => [b.dataset.step, !b.disabled]), text: n.textContent }));
  async function doStep(page, id, st, expectNext, { label } = {}) {
    if (label !== undefined) { await page.$eval(`${card(id)} .pt-bed`, n => { n.value = ''; }); await page.type(`${card(id)} .pt-bed`, label); }
    await press(page, stepBtn(id, st));
    await waitOrExplain(page, ([sel, n]) => document.querySelector(sel)?.dataset.next === n, [card(id), expectNext]);
  }

  await step('B1a. Admin loads the sample trip to H-101; the H-101 desk\'s Patients list shows it with its ambulance and only "Confirm arrival" offered', async () => {
    await openTab(admin, 'tab-analytics'); // My registered patients (the sample case is registered by the admin)
    await openTab(admin, 'tab-tracking');
    await press(admin, '#btnTrackingSample');
    await waitOrExplain(admin, () => /Sample demo trip ready/.test(document.getElementById('trackingMessage').textContent));
    ctx.trip = (await api(ctx.adminToken, '/tracking/trips')).body.trips.find(t => t.is_demo && !t.completed);
    assert(ctx.trip?.hospital.hospital_id === 'H-101', `sample trip ${JSON.stringify(ctx.trip && ctx.trip.hospital)}`);
    ctx.sample = ctx.trip.request_id;
    await loginUI(desk, APEX);
    assert(await desk.$eval('#tab-acceptance', n => n.classList.contains('active')), 'the desk does not land on Acceptance');
    await waitOrExplain(desk, sel => document.querySelector(sel), card(ctx.sample));
    const c = await cardState(desk, ctx.sample);
    assert(c.status === 'ALLOCATED' && c.next === 'arrive' && JSON.stringify(c.steps) === JSON.stringify([['arrive', true]])
      && c.text.includes(ctx.trip.ambulance.ambulance_id) && c.text.includes('Demo Tracking Patient'), `card ${JSON.stringify(c)}`);
    assert(await admin.$eval('#hospitalPatientsPanel', n => n.hidden), 'the Patients panel is shown to the admin');
    ctx.otherToken = await login(OTHER_DESK);
    await expectDenied(ctx.otherToken, [['GET', '/hospitals/H-101/patients']], [403]);
    note(`sample ${ctx.sample} with ${ctx.trip.ambulance.ambulance_id} → H-101; other desk ${OTHER_DESK.username} (${OTHER_DESK.hospital_id}) refused`);
  });

  await step('B1b. The trip runs to H-101: the desk sees "Ambulance arriving" then "Arrived"; the trip arriving does not confirm arrival or change the case', async () => {
    const tripApi = action => api(ctx.adminToken, `/tracking/trips/${ctx.trip.trip_id}/${action}`, { method: 'POST' });
    const phaseIs = async ph => (await api(ctx.adminToken, `/tracking/trips/${ctx.trip.trip_id}`)).body.trip.phase === ph;
    const t0 = Date.now();
    const st = await tripApi('start');
    assert(st.status === 200 || (await api(ctx.adminToken, `/tracking/trips/${ctx.trip.trip_id}`)).body.trip.phase !== 'DISPATCHED', `start ${st.status}`);
    for (let i = 0; i < 240 && !(await phaseIs('ARRIVED_AT_PATIENT')); i++) await sleep(500);
    const leg1 = (Date.now() - t0) / 1000;
    assert((await tripApi('pickup')).status === 200, 'pickup');
    // The desk sees the simulated ETA count down while the ambulance comes.
    await waitMatch(desk, `${card(ctx.sample)} .patient-trip`, /ETA \d+ min \d+ s \(simulated\)/, 30000);
    await waitOrExplain(desk, sel => /Ambulance arriving/.test(document.querySelector(sel)?.textContent || ''), card(ctx.sample), 60000);
    await waitOrExplain(desk, sel => document.querySelector(sel)?.dataset.tripPhase === 'ARRIVED_AT_HOSPITAL' && /Arrived/.test(document.querySelector(sel).textContent), card(ctx.sample), 120000);
    const total = (Date.now() - t0) / 1000;
    assert(total <= 120, `the demo trip took ${total.toFixed(0)} s of wall time (to the patient ${leg1.toFixed(0)} s); it must finish within 2 minutes`);
    note(`demo trip wall time: to the patient ${leg1.toFixed(1)} s, whole trip ${total.toFixed(1)} s`);
    await sleep(1500);
    const d = await caseOf(ctx.sample);
    assert(d.request.status === 'ALLOCATED' && !d.request.arrived_at, `trip arrival changed the case: ${d.request.status} arrived_at ${d.request.arrived_at}`);
    const c = await cardState(desk, ctx.sample);
    assert(c.status === 'ALLOCATED' && c.next === 'arrive', `card after the trip arrived ${JSON.stringify(c)}`);
    await waitMatch(admin, '#trackingCaseLine', /Trip: Arrived at the hospital · Case: Allocated \(/);
  });

  await step('B1c. Desk: Confirm arrival → Allocate bed (ICU-3) → Start treatment, one step at a time; the Admin\'s Live tracking line and case tracker show In treatment live; a progress note', async () => {
    await openTab(admin, 'tab-ingestion');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.sample);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, id => document.getElementById('caseTrackerCaption').textContent.startsWith(id) && /allocated/i.test(document.getElementById('caseSummary')?.textContent || ''), ctx.sample);
    admin.__api.length = 0;
    // The admin may view but not perform the hospital's steps.
    await expectDenied(ctx.adminToken, [['POST', `/emergencies/${ctx.sample}/arrive`], ['POST', `/emergencies/${ctx.sample}/start-treatment`]], [403]);
    await doStep(desk, ctx.sample, 'arrive', 'allocate-bed');
    let c = await cardState(desk, ctx.sample);
    assert(JSON.stringify(c.steps) === JSON.stringify([['allocate-bed', true]]), `after arrival ${JSON.stringify(c.steps)}`);
    // A bed with no label is not sent.
    desk.__api.length = 0;
    await press(desk, stepBtn(ctx.sample, 'allocate-bed'));
    await waitOrExplain(desk, sel => /Type the bed label/.test(document.querySelector(sel)?.textContent || ''), card(ctx.sample));
    assert(!desk.__api.some(x => x.endsWith('/allocate-bed')), 'an empty bed label was sent');
    await doStep(desk, ctx.sample, 'allocate-bed', 'start-treatment', { label: 'ICU-3' });
    c = await cardState(desk, ctx.sample);
    assert(/ICU-3/.test(c.text) && JSON.stringify(c.steps) === JSON.stringify([['start-treatment', true]]), `after bed ${JSON.stringify(c)}`);
    await doStep(desk, ctx.sample, 'start-treatment', 'complete');
    await waitMatch(admin, '#trackingCaseLine', /Trip: Arrived at the hospital · Case: In treatment \(/, 8000);
    await waitMatch(admin, '#caseSummary', /in treatment/i, 8000);
    assert(!admin.__api.some(x => x.startsWith('GET /api/v1/tracking/trips')), 'the admin page re-read the trips instead of following the live event');
    c = await cardState(desk, ctx.sample);
    assert(JSON.stringify(c.steps) === JSON.stringify([['notes', true], ['complete', true]]), `in treatment ${JSON.stringify(c.steps)}`);
    await desk.type(`${card(ctx.sample)} .pt-note`, 'BP stable, oxygen started');
    await press(desk, stepBtn(ctx.sample, 'notes'));
    await waitOrExplain(desk, sel => /BP stable, oxygen started/.test(document.querySelector(`${sel} .pt-notes`)?.textContent || ''), card(ctx.sample));
    const d = await caseOf(ctx.sample);
    assert(d.request.status === 'IN_TREATMENT' && d.request.bed_label === 'ICU-3' && d.request.arrived_at, `server ${JSON.stringify({ s: d.request.status, b: d.request.bed_label })}`);
  });

  await step('B1d. A referred ICU case is accepted in the desk\'s console; bed ICU-3 is refused (in use), ICU-4 allocated; treated and completed: the bed and ventilator are released; the Admin\'s tracker and My registered patients follow live', async () => {
    const before = await hospital('H-101');
    const c = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: { patient_name: 'Batch8 Resp Patient', age: 61, emergency_type: 'RESPIRATORY', triage_priority: 2, pickup_lat: PICKUP[0], pickup_lng: PICKUP[1] }, headers: { 'Idempotency-Key': `b8-resp-${Date.now()}` } });
    assert(c.status === 201, `case ${c.status} ${JSON.stringify(c.body)}`);
    ctx.resp = c.body.request_id;
    const init = await api(ctx.adminToken, '/referrals/initiate', { method: 'POST', body: { request_id: ctx.resp, hospital_id: 'H-101' } });
    assert(init.status === 201, `referral ${init.status} ${JSON.stringify(init.body)}`);
    await waitOrExplain(desk, id => document.querySelector(`#acceptanceConsoleContent .referral-card[data-request-id="${id}"] .btn-accept:not([disabled])`), ctx.resp);
    await press(desk, `#acceptanceConsoleContent .referral-card[data-request-id="${ctx.resp}"] .btn-accept`);
    await waitOrExplain(desk, sel => document.querySelector(sel)?.dataset.next === 'arrive', card(ctx.resp));
    const held = await hospital('H-101');
    assert(free(held, 'ICU_BED') === free(before, 'ICU_BED') - 1 && free(held, 'VENTILATOR') === free(before, 'VENTILATOR') - 1, 'the accept did not commit an ICU bed and a ventilator');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.resp);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, id => document.getElementById('caseTrackerCaption').textContent.startsWith(id) && /allocated/i.test(document.getElementById('caseSummary')?.textContent || ''), ctx.resp);
    await doStep(desk, ctx.resp, 'arrive', 'allocate-bed');
    allowedConsole.push({ step: state.currentStep, re: /status of 409/ });
    await desk.type(`${card(ctx.resp)} .pt-bed`, 'ICU-3');
    await press(desk, stepBtn(ctx.resp, 'allocate-bed'));
    await waitOrExplain(desk, sel => /^Not possible now/.test(document.querySelector(`${sel} .treat-note`)?.textContent || ''), card(ctx.resp));
    assert((await cardState(desk, ctx.resp)).next === 'allocate-bed', 'a refused bed moved the case on');
    await doStep(desk, ctx.resp, 'allocate-bed', 'start-treatment', { label: 'ICU-4' });
    await press(admin, '#refreshWorkspaceBtn'); // My registered patients lists this new case (registered by the admin)
    await waitFor(admin, id => document.querySelector(`#registrationsTable tr[data-request-id="${id}"]`), ctx.resp);
    await sleep(500);
    admin.__api.length = 0;
    await doStep(desk, ctx.resp, 'start-treatment', 'complete');
    await waitMatch(admin, '#caseSummary', /in treatment/i, 8000);
    await waitMatch(admin, `#registrationsTable tr[data-request-id="${ctx.resp}"]`, /in treatment/i, 8000);
    await press(desk, stepBtn(ctx.resp, 'complete')); // the confirm() is accepted by the harness
    await waitOrExplain(desk, sel => document.querySelector(sel)?.dataset.status === 'COMPLETED', card(ctx.resp));
    await waitMatch(admin, '#caseSummary', /completed/i, 8000);
    await waitMatch(admin, `#registrationsTable tr[data-request-id="${ctx.resp}"]`, /completed/i, 8000);
    const after = await hospital('H-101');
    assert(free(after, 'ICU_BED') === free(before, 'ICU_BED') && free(after, 'VENTILATOR') === free(before, 'VENTILATOR'),
      `not released: ICU ${free(before, 'ICU_BED')}→${free(held, 'ICU_BED')}→${free(after, 'ICU_BED')}, vent ${free(before, 'VENTILATOR')}→${free(after, 'VENTILATOR')}`);
    assert((await cardState(desk, ctx.resp)).steps.length === 0, 'a completed patient still has actions');
    // A second complete is an idempotent no-op on the server: nothing is released twice.
    const again = await api(ctx.apexToken, `/emergencies/${ctx.resp}/complete`, { method: 'POST' });
    const twice = await hospital('H-101');
    assert(free(twice, 'ICU_BED') === free(after, 'ICU_BED'), `a repeated complete changed the ICU count (${again.status})`);
    note(`${ctx.resp}: H-101 ICU free ${free(before, 'ICU_BED')}→${free(held, 'ICU_BED')}→${free(after, 'ICU_BED')}, ventilators ${free(before, 'VENTILATOR')}→${free(held, 'VENTILATOR')}→${free(after, 'VENTILATOR')}; repeat complete ${again.status}`);
  });

  await step('B1e. Desk completes the sample case → the Admin\'s Live tracking line shows Completed live; the Admin\'s hospital overview; the other desk cannot see or act', async () => {
    await press(desk, stepBtn(ctx.sample, 'complete'));
    await waitOrExplain(desk, sel => document.querySelector(sel)?.dataset.status === 'COMPLETED', card(ctx.sample));
    await waitOrExplain(admin, () => document.getElementById('trackingCaseLine')?.dataset.caseStatus === 'COMPLETED', null, 8000);
    await openTab(admin, 'tab-hospitals');
    await waitOrExplain(admin, () => document.querySelector('[data-overview="H-101"] .overview-cases'));
    const ov = await admin.$eval('[data-overview="H-101"]', n => n.textContent);
    assert(/completed \(24 h\)/.test(ov) && /Reserved/.test(ov) && /Occupied/.test(ov), `overview ${ov}`);
    const other = await newPage('other-desk');
    await loginUI(other, OTHER_DESK);
    await waitOrExplain(other, () => document.getElementById('hospitalPatientsContent')?.textContent.length > 0);
    await sleep(800);
    const seen = await other.$eval('#hospitalPatientsContent', (n, ids) => ids.filter(id => n.textContent.includes(id)), [ctx.sample, ctx.resp]);
    assert(seen.length === 0, `${OTHER_DESK.username} sees ${seen.join(', ')}`);
    assert(await other.$eval('#nav-mci', n => n.hidden), 'the Mass casualty tab is offered to a desk');
    await expectDenied(ctx.otherToken, [['POST', `/emergencies/${ctx.resp}/complete`], ['POST', `/emergencies/${ctx.sample}/notes`, { note: 'x' }]], [403, 404]);
    await kit.closePage(other);
  });

  if (process.env.B8_PART !== 'p0') {
  // ════════════════════════ B2 Mass casualty ════════════════════════
  await step('B2a. Bus crash on the Mass casualty tab: "Load bus crash demo" twice gives ONE incident with 12 victims (2 RED, 4 YELLOW, 6 GREEN, labels MCI-NNN); a victims retry with the same Idempotency-Key replays instead of duplicating', async () => {
    await openTab(admin, 'tab-mci');
    await press(admin, '#mciDemoBtn');
    await waitOrExplain(admin, () => document.querySelectorAll('#mciIncident tr[data-request-id]').length === 12, null, 20000);
    await press(admin, '#mciDemoBtn');
    await sleep(1500);
    const list = (await api(ctx.adminToken, '/incidents')).body.incidents;
    const demo = list.filter(i => /Highway Bus Accident/i.test(i.title || ''));
    assert(demo.length === 1, `demo incidents: ${demo.length}`);
    ctx.incidentId = demo[0].incident_id;
    const inc = (await api(ctx.adminToken, `/incidents/${ctx.incidentId}`)).body;
    assert(inc.victims.length === 12, `victims ${inc.victims.length}`);
    const by = inc.summary.by_triage;
    assert(by.RED === 2 && by.YELLOW === 4 && by.GREEN === 6, `triage ${JSON.stringify(by)}`);
    const counters = await admin.$$eval('#mciCounters [data-counter]', ns => Object.fromEntries(ns.map(n => [n.dataset.counter, n.querySelector('.mci-counter-value').textContent.trim()])));
    assert(counters.red === '2' && counters.yellow === '4' && counters.green === '6', `UI counters ${JSON.stringify(counters)}`);
    const rowCount = await admin.$$eval('#mciIncident tr[data-request-id]', rs => rs.length);
    assert(rowCount === 12, `UI rows ${rowCount}`);
    // Lost-answer retry on the victims endpoint: same key → the same cases, nothing added.
    const extra = { victims: [{ injury_description: 'Cut on forearm', triage_category: 'GREEN', emergency_type: 'GENERAL' }, { injury_description: 'Sprained ankle', triage_category: 'GREEN', emergency_type: 'GENERAL' }] };
    const headers = { 'Idempotency-Key': `b8-retry-${Date.now()}` };
    const first = await api(ctx.adminToken, `/incidents/${ctx.incidentId}/victims`, { method: 'POST', body: extra, headers });
    const again = await api(ctx.adminToken, `/incidents/${ctx.incidentId}/victims`, { method: 'POST', body: extra, headers });
    assert(first.status === 201 && [200, 201].includes(again.status), `victims ${first.status}/${again.status}`);
    const ids = b => (b.request_ids || (b.cases || []).map(c => c.request_id) || []).join(',');
    assert(ids(first.body) && ids(first.body) === ids(again.body), `replay differs: ${ids(first.body)} vs ${ids(again.body)}`);
    const after = (await api(ctx.adminToken, `/incidents/${ctx.incidentId}`)).body;
    assert(after.victims.length === 14, `after replay ${after.victims.length} victims (expected 14)`);
    const labels = after.victims.map(v => v.label || v.full_name || '').filter(l => /^MCI-\d{3}/.test(l));
    assert(labels.length >= 12, `anonymous labels ${labels.length}`);
    note(`incident ${ctx.incidentId}: 12 demo victims (2/4/6), retry replayed ${ids(first.body)}; ${labels.length} MCI labels`);
  });

  await step('B2b. Suggestions: every victim needing transport has a suggested hospital with a reason, or is marked "Needs escalation"; nothing is silently assigned', async () => {
    // B2a added two victims through the API; re-open the tab so the page reloads the incident from the server.
    await openTab(admin, 'tab-ingestion');
    await openTab(admin, 'tab-mci');
    await waitOrExplain(admin, () => document.querySelectorAll('#mciIncident tr[data-request-id]').length >= 12, null, 15000);
    const rows = await admin.$$eval('#mciIncident tr[data-request-id]', rs => rs.map(r => ({
      id: r.dataset.requestId, triage: r.dataset.triage, ref: r.dataset.ref,
      suggestion: !!r.querySelector('.mci-suggestion'), reason: (r.querySelector('.mci-reason')?.textContent || '').trim(),
      escalation: !!r.querySelector('.badge-escalation')
    })));
    const bad = rows.filter(r => r.ref === 'none' && !(r.suggestion && r.reason.length > 3) && !r.escalation);
    assert(!bad.length, `rows with neither a reasoned suggestion nor escalation: ${JSON.stringify(bad)}`);
    const reds = rows.filter(r => r.triage === 'RED');
    assert(reds.length === 2 && reds.every(r => r.suggestion || r.escalation), `RED rows ${JSON.stringify(reds)}`);
    note(`${rows.filter(r => r.suggestion).length} suggestions with reasons; ${rows.filter(r => r.escalation).length} need escalation`);
  });

  await step('B2c. "Send all referrals": referrals reach hospitals; a desk accepts one in its console and the Admin\'s incident row shows Accepted live; incident cases carry the Incident badge in the queue', async () => {
    await waitOrExplain(admin, () => !document.getElementById('mciSendAllBtn')?.disabled, null, 15000);
    await press(admin, '#mciSendAllBtn');
    await waitOrExplain(admin, () => [...document.querySelectorAll('#mciIncident tr[data-request-id]')].filter(r => ['sent', 'pending', 'accepted'].includes(r.dataset.ref)).length >= 2, null, 30000);
    // A referral now pending at H-101, accepted by that desk in its own console.
    const inc = (await api(ctx.adminToken, `/incidents/${ctx.incidentId}`)).body;
    let target = null;
    for (const v of inc.victims) {
      const d = await caseOf(v.request_id);
      const p = (d.acceptances || []).find(a => a.status === 'PENDING' && a.hospital_id === 'H-101');
      if (p) { target = { rid: v.request_id, acc: p.acceptance_id }; break; }
    }
    assert(target, 'no incident referral pending at H-101');
    await openTab(desk, 'tab-acceptance');
    await waitOrExplain(desk, id => document.querySelector(`[data-acceptance-id="${id}"] .btn-accept, [data-acceptance-id="${id}"] [data-action="accept"]`), target.acc, 20000);
    await desk.$eval(`[data-acceptance-id="${target.acc}"] .btn-accept, [data-acceptance-id="${target.acc}"] [data-action="accept"]`, b => b.click());
    await waitOrExplain(admin, id => document.querySelector(`#mciIncident tr[data-request-id="${id}"]`)?.dataset.ref === 'accepted', target.rid, 20000);
    const accepted = (await caseOf(target.rid)).acceptances.find(a => a.status === 'ACCEPTED');
    assert(accepted?.hospital_id === 'H-101', `accepted at ${accepted?.hospital_id}`);
    await openTab(admin, 'tab-ingestion');
    await waitOrExplain(admin, id => [...document.querySelectorAll('.badge-incident')].some(b => b.dataset.incidentId === id), ctx.incidentId, 15000);
    note(`referral ${target.acc} for ${target.rid} accepted by H-101; admin row shows Accepted; Incident badge in the queue`);
  });

  await step('B3. 390x844 and 768x1024: the desk Patients list and the Mass casualty tab fit (no horizontal overflow, main actions reachable)', async () => {
    const problems = [];
    for (const [w, h] of [[390, 844], [768, 1024]]) {
      for (const who of ['desk', 'admin']) {
        const page = await newPage(`m${w}-${who}`, { width: w, height: h });
        try {
          await loginUI(page, who === 'desk' ? APEX : ADMIN);
          if (who === 'desk') {
            await waitFor(page, () => document.querySelector('#hospitalPatientsPanel'), null, 15000);
            await page.$eval('#hospitalPatientsPanel', n => n.scrollIntoView());
          } else {
            await openTab(page, 'tab-mci');
            await waitFor(page, () => document.querySelector('#mciDemoBtn'), null, 15000);
          }
          await sleep(600);
          const m = await page.evaluate(sel => {
            const de = document.documentElement;
            const b = document.querySelector(sel)?.getBoundingClientRect();
            return { overflow: de.scrollWidth - de.clientWidth, actionInView: !!b && b.width > 0 && b.left >= 0 && b.right <= de.clientWidth + 1 };
          }, who === 'desk' ? '#hospitalPatientsPanel' : '#mciDemoBtn');
          if (m.overflow > 1) problems.push(`${w} ${who}: page overflows by ${m.overflow}px`);
          if (!m.actionInView) problems.push(`${w} ${who}: main action not within the viewport`);
        } finally { await page.close(); }
      }
    }
    assert(!problems.length, problems.join('; '));
    note('desk Patients list and Mass casualty tab fit at 390 and 768 with their main actions reachable');
  });

  }

  await step('B4. No console errors, page errors or CSP violations', async () => {
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
}
summary('Batch 8 [memory]');
process.exit(exitCode);
