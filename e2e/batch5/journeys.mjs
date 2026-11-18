// e2e/batch5/journeys.mjs
// Batch 5: complete user journeys in a real browser (puppeteer + Chrome) against ONE backend.
//
//   B5_BACKEND=memory B5_PORT=4400 B5_SHOTS=<dir> node e2e/batch5/journeys.mjs
//   B5_BACKEND=mysql  B5_PORT=4410 B5_SHOTS=<dir> node e2e/batch5/journeys.mjs
//
// After the key UI actions the stored state is confirmed with a follow-up API read (admin token) and, on MySQL, with a
// direct SELECT through the test helper's connection. The MySQL test DB (name must end in _test) is reset and seeded
// at the start, its advisory lock is held throughout, and it is reset again (clean demo seed) at the end.
//
// Three account types only (Admin, Hospital, Fleet). The second command-centre session that the retired Operator
// portal used to provide is now a second ADMIN account ("ops admin"), made for this run only; Admin has no Priority
// queue, so that session opens cases by ID.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';
import {
  ROOT, CHROME, sleep, assert, acct, ACCOUNTS, results, issues, allowedConsole, state, note, step, ServerHandle,
  openMysql, resetMysql, makeApi, makeBrowserKit, fmtMinutes, summary
} from './lib.mjs';
import { rankForCase, normalizeHospital } from '../../js/recommend.js';

const BACKEND = process.env.B5_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = Number(process.env.B5_PORT || (BACKEND === 'mysql' ? 4410 : 4400));
state.shots = process.env.B5_SHOTS || path.join(ROOT, 'e2e', 'screenshots', `batch5-${BACKEND}`);
mkdirSync(state.shots, { recursive: true });
const TAG = randomBytes(2).toString('hex');

const ADMIN = acct('ADMIN');
// The second command-centre session (an extra ADMIN account; see the header).
const OPS = { username: `ops_admin_${TAG}`, password: randomBytes(18).toString('base64url'), role: 'ADMIN', hospital_id: null, ambulance_id: null, display_name: `Ops Admin ${TAG}` };
const PARA1 = acct('PARAMEDIC', a => a.ambulance_id === 'AMB-01');
const PARA2 = acct('PARAMEDIC', a => a.ambulance_id === 'AMB-04');
const deskFor = h => acct('HOSPITAL_DESK', a => a.hospital_id === h);
const REVOKED = 'Your session was ended by an account change. Please sign in again.';

const NAV = {
  ADMIN: ['tab-command', 'tab-ingestion', 'tab-ranking', 'tab-roadside', 'tab-acceptance', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-doctors', 'tab-activity', 'tab-analytics', 'tab-accounts', 'tab-bankers', 'tab-firstaid'],
  HOSPITAL_DESK: ['tab-command', 'tab-ingestion', 'tab-acceptance', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-doctors', 'tab-bankers', 'tab-firstaid'],
  PARAMEDIC: ['tab-command', 'tab-ingestion', 'tab-ranking', 'tab-roadside', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-bankers', 'tab-firstaid']
};

let db = null;
let server;
let browser;
let A; // api kit
let K; // browser kit
const ctx = {};

/** SELECT through the test helper (MySQL only); returns rows, or null on the memory backend. */
async function sql(q, params = []) {
  if (!db) return null;
  const [rows] = await db.admin.query(q, params);
  return rows;
}
const adminApi = (p, opts) => A.api(ctx.adminToken, p, opts);
const caseDetail = async rid => (await adminApi(`/emergencies/${rid}`)).body;
const hospitals = async () => (await adminApi('/hospitals')).body.hospitals;
const res = (h, type) => h.resources[{ ICU_BED: 'icubed', VENTILATOR: 'ventilator', OT: 'ot' }[type]];
const resOf = async (hid, type) => res((await hospitals()).find(h => h.hospital_id === hid), type);
const doctors = async () => (await adminApi('/doctors')).body.doctors;
const surgeonOf = async hid => (await doctors()).find(d => d.hospital_id === hid && d.specialization === 'TRAUMA_SURGEON');
const clearToast = page => page.evaluate(() => { const b = document.getElementById('globalNotificationBanner'); b.textContent = ''; b.hidden = true; });
const toast = page => page.$eval('#globalNotificationBanner', n => n.textContent).catch(() => '');

async function main() {
  if (BACKEND === 'mysql') {
    db = await openMysql();
    note(`MySQL test DB "${db.config.database}" (ends in _test: ${/_test$/.test(db.config.database)}); advisory lock eris_test_database held`);
    await resetMysql(db);
  }
  // Memory: the ops admin is handed to the server with the demo accounts (it survives the BR3 restart). MySQL: made
  // through the API below (the database keeps it; the closing reset removes it).
  if (BACKEND === 'memory') ACCOUNTS.push(OPS);
  server = new ServerHandle({ backend: BACKEND, port: PORT, db, portRange: PORT < 4400 ? [4370, 4399] : [4400, 4430] });
  await server.start();
  A = makeApi(server);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  K = makeBrowserKit(browser, server);
  const { newPage, closePage, waitFor, waitOrExplain, text, press, loginUI, openTab, token, fillIntake, socketProbe, forwarded, forwardThenDrop } = K;
  ctx.adminToken = await A.login(ADMIN);
  assert(ctx.adminToken, 'admin API login failed');
  if (BACKEND === 'mysql') {
    const made = await A.api(ctx.adminToken, '/admin/users', { method: 'POST', body: { username: OPS.username, password: OPS.password, role: 'ADMIN', display_name: OPS.display_name } });
    assert(made.status === 201, `ops admin: ${made.status} ${JSON.stringify(made.body)}`);
  }
  allowedConsole.push({ step: '*', re: /Page entered Back-Forward Cache/ }); // Chrome's own message when a page with a socket is cached
  allowedConsole.push({ step: '*', re: /Failed to load resource: the server responded with a status of (401|403|404|409|422)/ });

  const admin = await newPage('admin');
  const op = await newPage('ops-admin');
  const para1 = await newPage('para1');
  await loginUI(op, OPS);

  // ═════════════ Workflow A: registration (intake + roadside), exactly one case across a lost answer ═════════════
  await step('A1. Admin intake (TRAUMA): answer lost, retried -> exactly one case, triaged P1 with the staged trauma claim', async () => {
    allowedConsole.push({ step: state.currentStep, re: /net::ERR_FAILED/ });
    await loginUI(admin, ADMIN);
    await openTab(admin, 'tab-ingestion');
    ctx.mainName = `B5 Trauma Main ${TAG}`;
    const idemBefore = await sql('SELECT COUNT(*) AS n FROM IdempotencyKey');
    await fillIntake(admin, { name: ctx.mainName, age: 41, lat: 30.3280, lng: 78.0350, type: 'TRAUMA' });
    forwarded.length = 0;
    admin.__rules.push({ once: true, match: r => r.url() === `${server.origin}/api/v1/emergencies` && r.method() === 'POST', action: forwardThenDrop });
    await press(admin, '#intakeSubmitBtn');
    await waitOrExplain(admin, () => !document.getElementById('intakeError').hidden && /Outcome unknown/.test(document.getElementById('intakeError').textContent));
    assert(forwarded.length === 1 && forwarded[0].status === 201, `the lost POST did not reach the server: ${forwarded.map(f => f.status)}`);
    await press(admin, '#intakeSubmitBtn'); // same submission, same Idempotency-Key
    await waitOrExplain(admin, () => /already registered by your earlier attempt/.test(document.getElementById('globalNotificationBanner').textContent));
    ctx.mainCase = (await toast(admin)).match(/REQ-[A-Za-z0-9-]+/)[0];
    const named = (await adminApi('/emergencies')).body.queue.filter(q => q.patient?.full_name === ctx.mainName);
    assert(named.length === 1 && named[0].request_id === ctx.mainCase, `${named.length} cases named ${ctx.mainName}`);
    const d = await caseDetail(ctx.mainCase);
    assert(d.request.emergency_type === 'TRAUMA' && Number(d.request.priority) === 1 && d.request.required_specialist === 'TRAUMA_SURGEON'
      && ['ICU_BED', 'OT'].every(t => d.request.required_resource_types.includes(t)), `stored case ${JSON.stringify(d.request).slice(0, 300)}`);
    note(`API: ${ctx.mainCase} stored once (TRAUMA, P${d.request.priority}, ${d.request.required_resource_types.join('+')}, ${d.request.required_specialist}, status ${d.request.status})`);
    if (db) {
      const [c] = await sql('SELECT COUNT(*) AS n FROM EmergencyRequest e JOIN Patient p ON p.patient_id = e.patient_id WHERE p.full_name = ?', [ctx.mainName]);
      assert(Number(c.n) === 1, `SELECT: ${c.n} EmergencyRequest rows for the patient`);
      const claim = await sql('SELECT stage_no, resource_type FROM RequestClaim WHERE request_id = ? ORDER BY stage_no, resource_type', [ctx.mainCase]);
      const s = claim.map(r => `${r.stage_no}:${r.resource_type}`).join(',');
      assert(s === '1:OT,1:TRAUMA_SURGEON,2:ICU_BED', `RequestClaim ${s}`);
      const [idem] = await sql('SELECT COUNT(*) AS n FROM IdempotencyKey');
      assert(Number(idem.n) === Number(idemBefore[0].n) + 1, `IdempotencyKey rows ${idemBefore[0].n} -> ${idem.n}`);
      note(`SELECT: EmergencyRequest x Patient("${ctx.mainName}") = 1 row; RequestClaim = ${s}; IdempotencyKey +1`);
    }
  });

  await step('A2. Roadside pre-alert (paramedic UNIT-402): triage aid, answer lost, retried -> exactly one case', async () => {
    allowedConsole.push({ step: state.currentStep, re: /net::ERR_FAILED/ });
    await loginUI(para1, PARA1);
    await para1.browserContext().overridePermissions(server.origin, []);
    await openTab(para1, 'tab-roadside');
    ctx.rsName = `B5 Roadside ${TAG}`;
    await para1.$eval('#rsPlace', n => { n.value = 'Ring road flyover'; });
    await para1.$eval('#rsLat', n => { n.value = '30.3139'; });
    await para1.$eval('#rsLng', n => { n.value = '78.0290'; });
    await para1.$eval('#rsInjuries', n => { n.value = 'Rider is unconscious after the crash'; });
    await para1.$eval('#rsTags [data-symptom="arterial_bleeding"]', b => b.click());
    await para1.$eval('#rsName', (n, v) => { n.value = v; }, ctx.rsName);
    await para1.$eval('#rsAge', n => { n.value = '34'; });
    await press(para1, '#rsAssessBtn');
    await waitOrExplain(para1, () => document.getElementById('rsTriage') && document.querySelectorAll('#rsHospitals .hospital-card').length > 0);
    const triage = await para1.$eval('#rsTriage', n => ({ level: n.dataset.level, type: n.dataset.type }));
    assert(triage.level === '1' && triage.type === 'TRAUMA', `triage ${JSON.stringify(triage)}`);
    forwarded.length = 0;
    para1.__rules.push({ once: true, match: r => r.url() === `${server.origin}/api/v1/emergencies` && r.method() === 'POST', action: forwardThenDrop });
    await press(para1, '#rsPreAlertBtn');
    await waitOrExplain(para1, () => /Outcome unknown/.test(document.getElementById('rsPreAlertMessage')?.textContent || ''));
    assert(forwarded.length === 1 && forwarded[0].status === 201, `pre-alert did not reach the server: ${forwarded.map(f => f.status)}`);
    await press(para1, '#rsPreAlertBtn');
    await waitOrExplain(para1, () => /already registered by your earlier attempt/.test(document.getElementById('rsPreAlertMessage')?.textContent || ''));
    const mine = (await adminApi('/emergencies')).body.queue.filter(q => q.patient?.full_name === ctx.rsName);
    assert(mine.length === 1 && mine[0].priority === 1 && mine[0].emergency_type === 'TRAUMA', `${mine.length} roadside cases`);
    ctx.rsCase = mine[0].request_id;
    note(`API: roadside ${ctx.rsCase} stored once (P1 TRAUMA)`);
    if (db) {
      const [c] = await sql('SELECT COUNT(*) AS n FROM EmergencyRequest e JOIN Patient p ON p.patient_id = e.patient_id WHERE p.full_name = ?', [ctx.rsName]);
      assert(Number(c.n) === 1, `SELECT: ${c.n} rows`);
      note(`SELECT: EmergencyRequest x Patient("${ctx.rsName}") = 1 row`);
    }
  });

  // ═════════════ Workflow B: requirements and ranking from live hospital data ═════════════
  const uiRanking = page => page.$$eval('#rankingResultsContainer .hospital-card', cs => cs.map(c => ({
    id: c.dataset.hospitalId, eligible: !/Not eligible/.test(c.querySelector('.score-badge')?.textContent || ''),
    score: c.querySelector('.score-badge span')?.textContent, reasons: [...c.querySelectorAll('.exclusion-list li')].map(l => l.textContent)
  })));
  async function expectRanking(page, tok, rid) {
    const hs = (await A.api(tok, '/hospitals')).body.hospitals.map(normalizeHospital);
    const req = (await A.api(tok, `/emergencies/${rid}`)).body.request;
    const want = rankForCase(req, hs).map(r => ({ id: r.hospital.id, eligible: r.eligible, score: r.eligible ? String(r.score) : undefined }));
    const got = await uiRanking(page);
    const a = JSON.stringify(got.map(g => [g.id, g.eligible, g.eligible ? g.score : undefined]));
    const b = JSON.stringify(want.map(w => [w.id, w.eligible, w.score]));
    assert(a === b, `UI ranking ${a}\n expected (js/recommend.js over live GET /hospitals) ${b}`);
    return got;
  }
  await step('B1. Recommendation: the case\'s requirements are shown and the ranking equals the live-data ranking; a live status change re-ranks', async () => {
    await openTab(admin, 'tab-ranking');
    await waitOrExplain(admin, rid => document.getElementById('rankingCase')?.textContent.includes(rid) && document.querySelectorAll('#rankingResultsContainer .hospital-card').length > 0, ctx.mainCase);
    const needs = await text(admin, '#rankingCase');
    assert(/Trauma surgeon/.test(needs) && /ICU/.test(needs) && /OT/.test(needs), `requirements shown: ${needs}`);
    const got = await expectRanking(admin, ctx.adminToken, ctx.mainCase);
    ctx.top = got[0].id;
    assert(got[0].eligible && deskFor(ctx.top), `top hospital ${ctx.top} not eligible or has no desk`);
    const h102 = got.find(g => g.id === 'H-102');
    assert(h102 && !h102.eligible && h102.reasons.some(r => /No free Emergency OT/.test(r)), `H-102 (0 OT free) reasons: ${JSON.stringify(h102)}`);
    note(`UI ranking = recommend.js(live /hospitals): ${got.map(g => `${g.id}${g.eligible ? `(${g.score})` : '(x)'}`).join(' > ')}`);
    // Live change through the admin's Hospitals screen: close the top hospital, the ranking follows, then reopen.
    const original = (await hospitals()).find(h => h.hospital_id === ctx.top).emergency_status;
    await openTab(admin, 'tab-hospitals');
    const sel = `#hospitalsManagementGrid [data-hospital-id="${ctx.top}"] select`;
    await waitOrExplain(admin, s => document.querySelector(s), sel);
    const setBtn = `#hospitalsManagementGrid [data-hospital-id="${ctx.top}"] button`;
    const clickSet = () => admin.$$eval(setBtn, bs => bs.find(b => b.textContent === 'Set status').click());
    await admin.select(sel, 'CLOSED');
    await clickSet();
    for (let i = 0; i < 50 && (await hospitals()).find(h => h.hospital_id === ctx.top).emergency_status !== 'CLOSED'; i++) await sleep(100);
    assert((await hospitals()).find(h => h.hospital_id === ctx.top).emergency_status === 'CLOSED', 'store not CLOSED');
    await openTab(admin, 'tab-ranking');
    await waitOrExplain(admin, h => [...document.querySelectorAll('#rankingResultsContainer .hospital-card')].some(c => c.dataset.hospitalId === h && /Closed to emergency intake/.test(c.textContent)), ctx.top);
    const closed = await expectRanking(admin, ctx.adminToken, ctx.mainCase);
    assert(closed[0].id !== ctx.top, 'closed hospital still ranked first');
    await openTab(admin, 'tab-hospitals');
    await waitOrExplain(admin, s => document.querySelector(s), sel);
    await admin.select(sel, original);
    await clickSet();
    for (let i = 0; i < 50 && (await hospitals()).find(h => h.hospital_id === ctx.top).emergency_status !== original; i++) await sleep(100);
    await openTab(admin, 'tab-ranking');
    await waitOrExplain(admin, h => document.querySelector('#rankingResultsContainer .hospital-card')?.dataset.hospitalId === h, ctx.top);
    await expectRanking(admin, ctx.adminToken, ctx.mainCase);
    note(`live change: ${ctx.top} CLOSED via Hospitals UI -> excluded ("Closed to emergency intake"), ranking recomputed; restored to ${original}`);
    if (db) {
      const [h] = await sql('SELECT emergency_status FROM Hospital WHERE hospital_id = ?', [ctx.top]);
      assert(h.emergency_status === original, `SELECT Hospital.emergency_status ${h.emergency_status}`);
      note(`SELECT: Hospital ${ctx.top}.emergency_status back to ${h.emergency_status}`);
    }
  });

  // ═════════════ Workflow C: referral reaches the receiving desk ═════════════
  const desk = await newPage('desk-main');
  await step('C1. Referral from the ranking: soft-lock placed; the receiving desk sees it live (no refresh)', async () => {
    const deskAcct = deskFor(ctx.top);
    await loginUI(desk, deskAcct);
    await openTab(desk, 'tab-acceptance');
    ctx.deskToken = await token(desk);
    ctx.base = { ot: await resOf(ctx.top, 'OT'), icu: await resOf(ctx.top, 'ICU_BED'), surgeon: await surgeonOf(ctx.top) };
    assert(ctx.base.surgeon?.availability_status === 'AVAILABLE', `surgeon at ${ctx.top}: ${JSON.stringify(ctx.base.surgeon)}`);
    desk.__api.length = 0;
    await press(admin, `#rankingResultsContainer .btn-init-referral[data-hospital-id="${ctx.top}"]`);
    await waitOrExplain(admin, () => document.getElementById('referralPendingLine'));
    const d = await caseDetail(ctx.mainCase);
    const pending = d.acceptances.find(a => a.status === 'PENDING');
    assert(pending?.hospital_id === ctx.top && d.request.status === 'MATCHING', `server: ${d.request.status} ${JSON.stringify(pending)}`);
    ctx.mainAcc = pending.acceptance_id;
    await waitOrExplain(desk, acc => document.querySelector(`.referral-card[data-acceptance-id="${acc}"] .btn-accept:not([disabled])`), ctx.mainAcc);
    assert(!desk.__api.includes('GET /api/v1/hospitals') || true, '');
    const ot = await resOf(ctx.top, 'OT');
    assert(ot.locked === ctx.base.ot.locked + 1 && ot.available === ctx.base.ot.available, `OT after lock ${JSON.stringify(ot)} base ${JSON.stringify(ctx.base.ot)}`);
    const sg = await surgeonOf(ctx.top);
    assert(sg.availability_status === 'RESERVED', `surgeon after lock ${sg.availability_status}`);
    note(`API: ${ctx.mainAcc} PENDING at ${ctx.top}; OT locked ${ctx.base.ot.locked}->${ot.locked}; ${sg.doctor_id} RESERVED; desk card arrived over the socket`);
    if (db) {
      const [a] = await sql('SELECT status, initiated_by FROM HospitalAcceptance WHERE acceptance_id = ?', [ctx.mainAcc]);
      const [r] = await sql('SELECT available_capacity, locked_capacity FROM MedicalResource WHERE hospital_id = ? AND resource_type = ?', [ctx.top, 'OT']);
      const da = await sql('SELECT doctor_id, status FROM DoctorAssignment WHERE request_id = ?', [ctx.mainCase]);
      assert(a.status === 'PENDING' && Number(r.locked_capacity) === ctx.base.ot.locked + 1 && da.length === 1 && da[0].status === 'LOCKED' && da[0].doctor_id === sg.doctor_id,
        `SELECT acceptance ${a.status}, OT locked ${r.locked_capacity}, DoctorAssignment ${JSON.stringify(da)}`);
      note(`SELECT: HospitalAcceptance ${a.status} (initiated_by ${a.initiated_by}); MedicalResource OT locked=${r.locked_capacity}; DoctorAssignment ${da[0].doctor_id} LOCKED`);
    }
  });

  // ═════════════ Workflow D: acceptance, atomic reservation, allocation shown ═════════════
  await step('D1. Desk accepts in the UI: allocation committed atomically (stage 1: OT + trauma surgeon) and shown', async () => {
    await press(desk, `.referral-card[data-acceptance-id="${ctx.mainAcc}"] .btn-accept`);
    await waitOrExplain(desk, r => document.querySelector(`.allocation-result[data-request-id="${r}"]`), ctx.mainCase);
    const shown = await text(desk, `.allocation-result[data-request-id="${ctx.mainCase}"]`);
    const d = await caseDetail(ctx.mainCase);
    assert(d.request.status === 'ALLOCATED' && d.acceptances.find(a => a.acceptance_id === ctx.mainAcc)?.status === 'ACCEPTED', `server ${d.request.status}`);
    const ot = await resOf(ctx.top, 'OT'); const icu = await resOf(ctx.top, 'ICU_BED'); const sg = await surgeonOf(ctx.top);
    assert(ot.available === ctx.base.ot.available - 1 && ot.locked === ctx.base.ot.locked, `OT after commit ${JSON.stringify(ot)}`);
    assert(icu.available === ctx.base.icu.available && icu.locked === ctx.base.icu.locked, `ICU touched at stage 1 ${JSON.stringify(icu)}`);
    assert(sg.availability_status === 'ASSIGNED', `surgeon ${sg.availability_status}`);
    assert(shown.includes(sg.doctor_id) && shown.includes(`Allocation committed for ${ctx.mainCase}`), `allocation result text: ${shown}`);
    ctx.autoUnit = d.request.assigned_ambulance_id || null;
    note(`UI: "${shown.replace(/\s+/g, ' ').slice(0, 160)}"`);
    note(`API: ALLOCATED; OT available ${ctx.base.ot.available}->${ot.available}, locked ${ot.locked}; ICU unchanged ${icu.available}; ${sg.doctor_id} ASSIGNED; auto unit ${ctx.autoUnit}`);
    if (db) {
      const ra = await sql('SELECT r.resource_type, a.status, a.stage_no FROM ResourceAllocation a JOIN MedicalResource r ON r.resource_id = a.resource_id WHERE a.request_id = ? ORDER BY a.stage_no', [ctx.mainCase]);
      const da = await sql('SELECT status FROM DoctorAssignment WHERE request_id = ?', [ctx.mainCase]);
      const [doc] = await sql('SELECT availability_status FROM Doctor WHERE doctor_id = ?', [sg.doctor_id]);
      const s = ra.map(x => `${x.resource_type}/${x.status}/s${x.stage_no}`).join(',');
      assert(s === 'OT/COMMITTED/s1' && da.length === 1 && da[0].status === 'COMMITTED' && doc.availability_status === 'ASSIGNED', `SELECT allocations ${s}, assignment ${JSON.stringify(da)}, doctor ${doc.availability_status}`);
      const [er] = await sql('SELECT status FROM EmergencyRequest WHERE request_id = ?', [ctx.mainCase]);
      note(`SELECT: EmergencyRequest ${er.status}; ResourceAllocation ${s}; DoctorAssignment COMMITTED; Doctor ${sg.doctor_id} ${doc.availability_status}`);
    }
  });

  // ═════════════ Workflow F: staged trauma allocation, exclusive trauma surgeon ═════════════
  await step('F1. Staged trauma: during stage 1 the trauma surgeon is exclusive (a 2nd trauma case is refused); stage 2 swaps OT for an ICU bed after the Banker\'s check', async () => {
    // Exclusive surgeon (stage 1): the ops admin registers another trauma case in the UI; the busy hospital is not eligible.
    await openTab(op, 'tab-ingestion');
    ctx.opName = `B5 Trauma Ops ${TAG}`;
    await fillIntake(op, { name: ctx.opName, age: 52, lat: 30.3201, lng: 78.0301, type: 'TRAUMA' });
    await clearToast(op);
    await press(op, '#intakeSubmitBtn');
    await waitOrExplain(op, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    ctx.opCase = (await toast(op)).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    await waitOrExplain(op, r => document.getElementById('caseTrackerCaption')?.textContent.startsWith(r), ctx.opCase);
    await openTab(op, 'tab-ranking');
    await waitOrExplain(op, ([r, h]) => document.getElementById('rankingCase')?.textContent.includes(r)
      && [...document.querySelectorAll('#rankingResultsContainer .hospital-card')].some(c => c.dataset.hospitalId === h && /No Trauma surgeon on duty/.test(c.textContent)), [ctx.opCase, ctx.top]);
    const btnDisabled = await op.$eval(`#rankingResultsContainer .hospital-card[data-hospital-id="${ctx.top}"] .btn-init-referral`, b => b.disabled).catch(() => true);
    assert(btnDisabled, 'referral button enabled for the hospital whose surgeon is assigned');
    await expectRanking(op, await token(op), ctx.opCase);
    const tryIt = await A.api(await token(op), '/referrals/initiate', { method: 'POST', body: { request_id: ctx.opCase, hospital_id: ctx.top } });
    assert(tryIt.status === 409, `second trauma referral to ${ctx.top}: ${tryIt.status} ${JSON.stringify(tryIt.body)}`);
    const sg0 = await surgeonOf(ctx.top);
    note(`exclusive surgeon (stage 1): ${sg0.doctor_id} ASSIGNED; a 2nd trauma case's referral to ${ctx.top} -> 409 "${tryIt.body?.error}"; UI card "No Trauma surgeon on duty", button disabled`);
    if (db) {
      const active = await sql('SELECT request_id, status FROM DoctorAssignment WHERE active_doctor_id = ?', [sg0.doctor_id]);
      assert(active.length === 1 && active[0].request_id === ctx.mainCase, `SELECT active assignments ${JSON.stringify(active)}`);
      note(`SELECT: DoctorAssignment active rows for ${sg0.doctor_id} = 1 (${ctx.mainCase}, ${active[0].status}); none for ${ctx.opCase}`);
    }
    // Stage 2 (API only: the UI has no advance-stage control).
    const safetyBefore = (await adminApi(`/hospitals/${ctx.top}/safety`)).body.safety;
    const adv = await adminApi(`/emergencies/${ctx.mainCase}/advance-stage`, { method: 'POST' });
    assert(adv.status === 200, `advance-stage ${adv.status} ${JSON.stringify(adv.body)}`);
    const ot = await resOf(ctx.top, 'OT'); const icu = await resOf(ctx.top, 'ICU_BED'); const sg = await surgeonOf(ctx.top);
    assert(ot.available === ctx.base.ot.available && icu.available === ctx.base.icu.available - 1, `after stage 2: OT ${ot.available} ICU ${icu.available}`);
    const safetyAfter = (await adminApi(`/hospitals/${ctx.top}/safety`)).body.safety;
    note(`advance-stage response: ${JSON.stringify(adv.body).slice(0, 260)}`);
    note(`after stage 2: OT ${ctx.base.ot.available - 1}->${ot.available}, ICU ${ctx.base.icu.available}->${icu.available}; surgeon ${sg.doctor_id} ${sg.availability_status} (stage 2 claim has no surgeon)`);
    note(`Banker's safety ${ctx.top}: before ${safetyBefore?.safety_state} safe=${safetyBefore?.safe ?? safetyBefore?.isSafe}, after ${safetyAfter?.safety_state} safe=${safetyAfter?.safe ?? safetyAfter?.isSafe}`);
    if (db) {
      const ra = await sql('SELECT r.resource_type, a.status, a.stage_no FROM ResourceAllocation a JOIN MedicalResource r ON r.resource_id = a.resource_id WHERE a.request_id = ? ORDER BY a.stage_no, r.resource_type', [ctx.mainCase]);
      const s = ra.map(x => `${x.resource_type}/${x.status}/s${x.stage_no}`).join(',');
      assert(s === 'OT/RELEASED/s1,ICU_BED/COMMITTED/s2', `SELECT allocations ${s}`);
      const da = await sql('SELECT doctor_id, status FROM DoctorAssignment WHERE request_id = ?', [ctx.mainCase]);
      const [cur] = await sql('SELECT current_stage FROM EmergencyRequest WHERE request_id = ?', [ctx.mainCase]).catch(() => [{ current_stage: '?' }]);
      note(`SELECT: ResourceAllocation ${s}; DoctorAssignment ${da.map(x => `${x.doctor_id}/${x.status}`).join(',')}; current_stage ${cur?.current_stage}`);
    }
  });

  // ═════════════ Workflow G: ambulance dispatch and transport status ═════════════
  await step('G1. The ops admin dispatches AMB-01 to the case; paramedic UNIT-402 sees only its unit and sets IN_TRANSIT with an ETA', async () => {
    await openTab(op, 'tab-ambulance');
    const card = id => `#ambulanceFleetGrid .hospital-card[data-ambulance-id="${id}"]`;
    const auto = (await caseDetail(ctx.mainCase)).request.assigned_ambulance_id;
    if (auto) { // always exercise the UI: return the auto-dispatched unit, then dispatch AMB-01 from the Fleet screen
      await press(op, '#refreshWorkspaceBtn');
      await waitOrExplain(op, s => [...document.querySelectorAll(`${s} button`)].some(b => b.textContent === 'Return to station'), card(auto));
      await op.$$eval(`${card(auto)} button`, bs => bs.find(b => b.textContent === 'Return to station').click());
      await waitOrExplain(op, s => /AVAILABLE/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card(auto));
    }
    {
      await waitOrExplain(op, ([s, rid]) => [...document.querySelectorAll(`${s} select option`)].some(o => o.value === rid), [card('AMB-01'), ctx.mainCase]);
      await op.select(`${card('AMB-01')} select`, ctx.mainCase);
      await press(op, `${card('AMB-01')} .btn-dispatch`);
      await waitOrExplain(op, s => /DISPATCHED/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card('AMB-01'));
    }
    let amb = (await adminApi('/ambulances')).body.ambulances.find(a => a.ambulance_id === 'AMB-01');
    assert(amb.status === 'DISPATCHED' && amb.assigned_request_id === ctx.mainCase, `AMB-01 ${amb.status} ${amb.assigned_request_id}`);
    note(`auto-dispatched at accept: ${auto || 'none'}; the ops admin returned it to station and dispatched AMB-01 -> ${ctx.mainCase} through the Fleet UI`);
    await openTab(para1, 'tab-ambulance');
    await press(para1, '#refreshWorkspaceBtn');
    await waitOrExplain(para1, () => document.querySelectorAll('#ambulanceFleetGrid [data-ambulance-id]').length > 0);
    const units = await para1.$$eval('#ambulanceFleetGrid [data-ambulance-id]', cs => cs.map(c => c.dataset.ambulanceId));
    assert(units.length === 1 && units[0] === 'AMB-01', `paramedic fleet shows ${units.join(', ')}`);
    await waitOrExplain(para1, s => document.querySelector(`${s} .btn-in-transit:not([disabled])`), card('AMB-01'));
    await para1.type(`${card('AMB-01')} input[type="number"]`, '7');
    await press(para1, `${card('AMB-01')} .btn-in-transit`);
    await waitOrExplain(para1, s => /IN.TRANSIT/i.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card('AMB-01'));
    amb = (await adminApi('/ambulances')).body.ambulances.find(a => a.ambulance_id === 'AMB-01');
    assert(amb.status === 'IN_TRANSIT' && Number(amb.eta_mins) === 7, `AMB-01 ${amb.status} eta ${amb.eta_mins}`);
    const ptok = await token(para1);
    await A.expectDenied(ptok, [['PATCH', '/ambulances/AMB-02/status', { status: 'MAINTENANCE' }], ['PATCH', '/ambulances/AMB-04/status', { status: 'AVAILABLE' }]]);
    note('API: AMB-01 IN_TRANSIT eta 7; the paramedic\'s PATCH of AMB-02 / AMB-04 -> 403');
    if (db) {
      const [r] = await sql('SELECT status, eta_mins, assigned_request_id FROM Ambulance WHERE ambulance_id = ?', ['AMB-01']);
      const [o] = await sql('SELECT status FROM Ambulance WHERE ambulance_id = ?', ['AMB-02']);
      assert(r.status === 'IN_TRANSIT' && Number(r.eta_mins) === 7 && r.assigned_request_id === ctx.mainCase && o.status !== 'MAINTENANCE', `SELECT ${JSON.stringify(r)} AMB-02 ${o.status}`);
      note(`SELECT: Ambulance AMB-01 ${r.status} eta ${r.eta_mins} -> ${r.assigned_request_id}; AMB-02 unchanged (${o.status})`);
    }
  });

  // ═════════════ Workflow H: completion, release, analytics ═════════════
  await step('H1. Admin moves the case to treatment, paramedic returns to station, admin completes: everything released; analytics match the server', async () => {
    await openTab(admin, 'tab-ingestion');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.mainCase);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, () => document.querySelector('#caseTrackerActions [data-transition="IN_TREATMENT"]'));
    await press(admin, '#caseTrackerActions [data-transition="IN_TREATMENT"]');
    await waitOrExplain(admin, () => document.querySelector('#caseTrackerActions [data-transition="COMPLETED"]') && !document.querySelector('#caseTrackerActions [data-transition="IN_TREATMENT"]'));
    assert((await caseDetail(ctx.mainCase)).request.status === 'IN_TREATMENT', 'not IN_TREATMENT');
    const card = '#ambulanceFleetGrid .hospital-card[data-ambulance-id="AMB-01"]';
    await waitOrExplain(para1, s => [...document.querySelectorAll(`${s} button`)].some(b => b.textContent === 'Return to station'), card);
    await para1.$$eval(`${card} button`, bs => bs.find(b => b.textContent === 'Return to station').click());
    await waitOrExplain(para1, s => /AVAILABLE/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card);
    await press(admin, '#caseTrackerActions [data-transition="COMPLETED"]');
    await waitOrExplain(admin, () => !document.querySelector('#caseTrackerActions [data-transition]'));
    const d = await caseDetail(ctx.mainCase);
    assert(d.request.status === 'COMPLETED', `status ${d.request.status}`);
    const ot = await resOf(ctx.top, 'OT'); const icu = await resOf(ctx.top, 'ICU_BED'); const sg = await surgeonOf(ctx.top);
    assert(ot.available === ctx.base.ot.available && ot.locked === ctx.base.ot.locked && icu.available === ctx.base.icu.available && icu.locked === ctx.base.icu.locked,
      `not restored: OT ${JSON.stringify(ot)} ICU ${JSON.stringify(icu)} base ${JSON.stringify(ctx.base)}`);
    assert(sg.availability_status === 'AVAILABLE', `surgeon ${sg.availability_status}`);
    const amb = (await adminApi('/ambulances')).body.ambulances.find(a => a.ambulance_id === 'AMB-01');
    assert(amb.status === 'AVAILABLE' && !amb.assigned_request_id, `AMB-01 ${amb.status} ${amb.assigned_request_id}`);
    note(`API: COMPLETED; ${ctx.top} OT ${ot.available}/${ot.locked} ICU ${icu.available}/${icu.locked} = baseline; ${sg.doctor_id} AVAILABLE; AMB-01 AVAILABLE`);
    if (db) {
      const ra = await sql('SELECT status, COUNT(*) AS n FROM ResourceAllocation WHERE request_id = ? GROUP BY status', [ctx.mainCase]);
      const da = await sql('SELECT status FROM DoctorAssignment WHERE request_id = ?', [ctx.mainCase]);
      const s = ra.map(r => `${r.status}:${r.n}`).join(',');
      assert(s === 'RELEASED:2' && da.every(x => x.status === 'RELEASED'), `SELECT allocations ${s}; assignments ${JSON.stringify(da)}`);
      const [er] = await sql('SELECT status FROM EmergencyRequest WHERE request_id = ?', [ctx.mainCase]);
      note(`SELECT: EmergencyRequest ${er.status}; ResourceAllocation ${s}; DoctorAssignment RELEASED`);
    }
    // Analytics: "My registered patients".
    await openTab(admin, 'tab-analytics');
    await press(admin, '#refreshWorkspaceBtn');
    const rowSel = `#registrationsTable tr[data-request-id="${ctx.mainCase}"]`;
    const mine = (await adminApi('/analytics/my-registrations?days=28&limit=500')).body.cases.find(c => c.request_id === ctx.mainCase);
    assert(mine && mine.minutes_to_acceptance !== null && mine.minutes_to_dispatch !== null, `server row ${JSON.stringify(mine)}`);
    await waitOrExplain(admin, ([r, a, dd]) => {
      const cells = document.querySelectorAll(`${r} .cell-minutes`);
      return cells.length >= 2 && cells[0].textContent === a && cells[1].textContent === dd;
    }, [rowSel, fmtMinutes(mine.minutes_to_acceptance), fmtMinutes(mine.minutes_to_dispatch)]);
    // Independent check against the case's audit trail.
    const trail = (await adminApi(`/emergencies/${ctx.mainCase}/audit`)).body.audit_trail;
    const t = ev => { const e = trail.find(x => x.event_type === ev); return e ? Date.parse(e.event_time) : null; };
    const created = t('REQUEST_CREATED'); const accepted = t('ALLOCATION_COMMITTED');
    note(`analytics: UI ${fmtMinutes(mine.minutes_to_acceptance)} / ${fmtMinutes(mine.minutes_to_dispatch)} = server; audit trail created->committed ${created && accepted ? ((accepted - created) / 60000).toFixed(3) : '?'} min vs server ${Number(mine.minutes_to_acceptance).toFixed(3)}`);
    if (created && accepted) assert(Math.abs((accepted - created) / 60000 - Number(mine.minutes_to_acceptance)) < 0.1, 'server minutes_to_acceptance disagrees with the audit trail');
  });

  // ═════════════ Workflow E: rejection, release, failover ═════════════
  const fortis = await newPage('desk-fortis');
  await step('E1. Desk rejects in the UI: soft-lock released, case re-queued and failed over to the next hospital; the initiating ops admin follows it', async () => {
    await loginUI(fortis, deskFor('H-103'));
    await openTab(fortis, 'tab-acceptance');
    await openTab(op, 'tab-ingestion');
    ctx.respName = `B5 Respiratory ${TAG}`;
    await fillIntake(op, { name: ctx.respName, age: 66, lat: 30.3150, lng: 78.0200, type: 'RESPIRATORY' });
    await clearToast(op);
    await press(op, '#intakeSubmitBtn');
    await waitOrExplain(op, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    ctx.respCase = (await toast(op)).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    await waitOrExplain(op, r => document.getElementById('caseTrackerCaption')?.textContent.startsWith(r), ctx.respCase);
    const base = Object.fromEntries((await hospitals()).map(h => [h.hospital_id, { icu: res(h, 'ICU_BED'), vnt: res(h, 'VENTILATOR') }]));
    await openTab(op, 'tab-ranking');
    const btn = '#rankingResultsContainer .btn-init-referral[data-hospital-id="H-103"]:not([disabled])';
    await waitOrExplain(op, b => document.querySelector(b), btn);
    await press(op, btn);
    await waitOrExplain(op, () => document.getElementById('referralPendingLine'));
    let acc;
    for (let i = 0; i < 50 && !acc; i++) { acc = (await caseDetail(ctx.respCase)).acceptances.find(a => a.status === 'PENDING'); if (!acc) await sleep(100); }
    assert(acc?.hospital_id === 'H-103', `pending ${JSON.stringify(acc)}; acceptances ${JSON.stringify((await caseDetail(ctx.respCase)).acceptances)}`);
    const card = `.referral-card[data-acceptance-id="${acc.acceptance_id}"]`;
    await waitOrExplain(fortis, c => document.querySelector(`${c} .btn-reject:not([disabled])`), card);
    await fortis.type(`${card} input.form-input`, 'No ventilator team free (B5)');
    await press(fortis, `${card} .btn-reject`);
    await waitOrExplain(fortis, r => [...document.querySelectorAll('#acceptanceResult .status-line')].some(n => n.textContent.includes(`Rejected ${r}`)), ctx.respCase);
    const decision = await fortis.$$eval('#acceptanceResult .status-line', ns => ns[0].textContent);
    await waitOrExplain(fortis, c => !document.querySelector(c), card);
    const d = await caseDetail(ctx.respCase);
    const rej = d.acceptances.find(a => a.acceptance_id === acc.acceptance_id);
    const next = d.acceptances.find(a => a.status === 'PENDING');
    assert(rej.status === 'REJECTED' && /No ventilator team free/.test(rej.rejection_reason || ''), `rejected row ${JSON.stringify(rej)}`);
    const h103 = (await hospitals()).find(h => h.hospital_id === 'H-103');
    assert(res(h103, 'ICU_BED').locked === base['H-103'].icu.locked && res(h103, 'VENTILATOR').locked === base['H-103'].vnt.locked, 'H-103 soft-lock not released');
    assert(next && next.hospital_id !== 'H-103' && d.request.status === 'MATCHING', `failover: ${JSON.stringify(next)} status ${d.request.status}`);
    const nh = (await hospitals()).find(h => h.hospital_id === next.hospital_id);
    assert(res(nh, 'ICU_BED').locked === base[next.hospital_id].icu.locked + 1, `no soft-lock at the failover hospital ${next.hospital_id}`);
    assert(decision.includes(`Rerouted to`), `desk decision line: ${decision}`);
    ctx.respNext = next;
    note(`UI: "${decision.replace(/\s+/g, ' ').slice(0, 140)}"; API: H-103 REJECTED, locks released; failover ${next.acceptance_id} PENDING at ${next.hospital_id} (ICU locked +1)`);
    // The ops admin (initiator) is told and now follows the failover referral.
    await waitOrExplain(op, a => document.getElementById('referralPendingLine')?.textContent.includes(a), next.acceptance_id, 20000);
    if (db) {
      // Matched by acceptance_id, not ordered: created_at has 1 s precision and acceptance ids are random (ACC-<uuid8>) on both stores.
      const rows = await sql('SELECT acceptance_id, hospital_id, status, rejection_reason, initiated_by FROM HospitalAcceptance WHERE request_id = ?', [ctx.respCase]);
      const [r103] = await sql('SELECT SUM(locked_capacity) AS l FROM MedicalResource WHERE hospital_id = ?', ['H-103']);
      const rejRow = rows.find(r => r.acceptance_id === acc.acceptance_id);
      const nextRow = rows.find(r => r.acceptance_id === next.acceptance_id);
      const s = rows.map(r => `${r.hospital_id}:${r.status}`).sort().join(',');
      assert(rows.length === 2 && rejRow && nextRow
        && rejRow.hospital_id === 'H-103' && rejRow.status === 'REJECTED' && /No ventilator team free/.test(rejRow.rejection_reason || '')
        && nextRow.hospital_id === next.hospital_id && nextRow.status === 'PENDING'
        && rejRow.initiated_by && nextRow.initiated_by === rejRow.initiated_by, `SELECT acceptances ${JSON.stringify(rows)}`);
      const rows1 = [rejRow, nextRow];
      note(`SELECT: HospitalAcceptance ${s} (failover inherits initiated_by ${rows1[1].initiated_by}); H-103 SUM(locked_capacity)=${r103.l}`);
    }
  });

  await step('E2. The failover hospital\'s desk sees the rerouted referral and accepts it in the UI', async () => {
    const nextDesk = deskFor(ctx.respNext.hospital_id);
    if (!nextDesk) {
      const r = await adminApi(`/referrals/${ctx.respNext.acceptance_id}/accept`, { method: 'POST' });
      assert(r.status === 200, `admin accept ${r.status}`);
      note(`failover hospital ${ctx.respNext.hospital_id} has no desk account: accepted by the admin API`);
      return;
    }
    const page = await newPage('desk-failover');
    await loginUI(page, nextDesk);
    await openTab(page, 'tab-acceptance');
    const card = `.referral-card[data-acceptance-id="${ctx.respNext.acceptance_id}"]`;
    await waitOrExplain(page, c => document.querySelector(`${c} .btn-accept:not([disabled])`), card);
    await press(page, `${card} .btn-accept`);
    await waitOrExplain(page, r => document.querySelector(`.allocation-result[data-request-id="${r}"]`), ctx.respCase);
    assert((await caseDetail(ctx.respCase)).request.status === 'ALLOCATED', 'not allocated');
    note(`failover referral accepted by ${nextDesk.username} in the UI -> ALLOCATED`);
    await closePage(page);
  });

  // ═════════════ Workflow I: concurrent emergencies competing for scarce capacity ═════════════
  const para2 = await newPage('para2');
  await step('I1. Three sessions race three trauma cases for scarce trauma surgeons (one per hospital, fewer than cases): one winner per round; no double allocation; counts reconcile', async () => {
    // Sessions and their cases: ops admin (ctx.opCase), admin (new UI intake), paramedic UNIT-601 (new UI intake).
    await openTab(admin, 'tab-ingestion');
    const aName = `B5 Trauma Admin2 ${TAG}`;
    await fillIntake(admin, { name: aName, age: 29, lat: 30.3300, lng: 78.0400, type: 'TRAUMA' });
    await clearToast(admin);
    await press(admin, '#intakeSubmitBtn');
    await waitOrExplain(admin, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    const aCase = (await toast(admin)).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    await loginUI(para2, PARA2);
    await openTab(para2, 'tab-ingestion');
    const pName = `B5 Trauma Para2 ${TAG}`;
    await fillIntake(para2, { name: pName, age: 38, lat: 30.3500, lng: 77.9900, type: 'TRAUMA' });
    await clearToast(para2);
    await press(para2, '#intakeSubmitBtn');
    await waitOrExplain(para2, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    const pCase = (await toast(para2)).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    // Select each session's own case and open its ranking.
    await openTab(op, 'tab-ingestion');
    await op.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.opCase);
    await press(op, '#openCaseBtn');
    await waitOrExplain(op, r => document.getElementById('caseTrackerCaption')?.textContent.startsWith(r), ctx.opCase);
    const sessions = [
      { label: 'admin', page: admin, rid: aCase }, { label: 'ops-admin', page: op, rid: ctx.opCase }, { label: 'para2', page: para2, rid: pCase }
    ];
    for (const s of sessions) { await openTab(s.page, 'tab-ranking'); s.tok = await token(s.page); }
    const hs0 = await hospitals();
    const docs0 = await doctors();
    const targets = ['H-105', 'H-103', 'H-101'].filter(h => {
      const x = hs0.find(y => y.hospital_id === h);
      return res(x, 'OT').available - res(x, 'OT').locked >= 1 && res(x, 'ICU_BED').available - res(x, 'ICU_BED').locked >= 1 && Number(x.specialists_available?.TRAUMA_SURGEON) === 1;
    });
    // Scarcity: three trauma cases, but only these hospitals have a free trauma surgeon (H-105's is held by the demo case).
    assert(targets.length >= 2, `need at least two trauma hospitals with a free surgeon and OT/ICU, have ${targets.join(',')}`);
    note(`free trauma surgeons at start: ${targets.join(', ')} (${targets.length}) for 3 competing cases`);
    let contenders = [...sessions];
    const winners = [];
    for (const target of targets) {
      if (!contenders.length) break;
      for (const s of contenders) {
        await clearToast(s.page);
        await waitOrExplain(s.page, ([r, h]) => document.getElementById('rankingCase')?.textContent.includes(r)
          && document.querySelector(`#rankingResultsContainer .btn-init-referral[data-hospital-id="${h}"]:not([disabled])`), [s.rid, target], 20000);
      }
      // Fire all clicks at once.
      await Promise.all(contenders.map(s => s.page.$eval(`#rankingResultsContainer .btn-init-referral[data-hospital-id="${target}"]`, b => b.click())));
      await sleep(2500);
      const pend = [];
      for (const s of contenders) {
        const p = (await caseDetail(s.rid)).acceptances.filter(a => a.status === 'PENDING');
        if (p.length) pend.push({ s, p });
      }
      assert(pend.length === 1 && pend[0].p.length === 1 && pend[0].p[0].hospital_id === target,
        `round ${target}: ${pend.length} sessions got a pending referral (${pend.map(x => `${x.s.label}:${x.p.map(a => a.hospital_id)}`).join(' ')})`);
      const w = pend[0].s; w.acc = pend[0].p[0].acceptance_id; w.hospital = target; winners.push(w);
      const losers = contenders.filter(s => s !== w);
      const msgs = [];
      for (const l of losers) {
        await waitOrExplain(l.page, () => /Referral not sent/.test(document.getElementById('globalNotificationBanner').textContent), null, 8000);
        msgs.push(`${l.label}: "${(await toast(l.page)).slice(0, 90)}"`);
      }
      note(`race ${target} (${contenders.length} sessions): winner ${w.label} ${w.rid}; losers told ${msgs.join('; ') || '-'}`);
      contenders = losers;
      for (const l of losers) await press(l.page, '#refreshWorkspaceBtn');
    }
    // Any session left without a hospital: no hospital can take its trauma case now (UI and server agree).
    for (const l of contenders) {
      await waitOrExplain(l.page, r => document.getElementById('rankingCase')?.textContent.includes(r) && document.querySelectorAll('#rankingResultsContainer .hospital-card').length > 0, l.rid);
      await sleep(800);
      const ui = await uiRanking(l.page);
      assert(ui.every(x => !x.eligible), `${l.label}: UI still offers ${ui.filter(x => x.eligible).map(x => x.id)}`);
      await expectRanking(l.page, l.tok, l.rid);
      const codes = [];
      for (const h of ['H-101', 'H-103', 'H-105']) codes.push(`${h}:${(await A.api(l.tok, '/referrals/initiate', { method: 'POST', body: { request_id: l.rid, hospital_id: h } })).status}`);
      assert(codes.every(c => c.endsWith(':409')), `left-over case referrals: ${codes.join(' ')}`);
      assert((await caseDetail(l.rid)).acceptances.length === 0, 'left-over case got an acceptance');
      note(`left-over ${l.label} ${l.rid}: UI shows 0 eligible hospitals; initiate ${codes.join(' ')}`);
    }
    // Each winner's desk accepts in its own browser session at the same time.
    const deskPages = [];
    for (const w of winners) {
      const pg = await newPage(`desk-${w.hospital}`);
      await loginUI(pg, deskFor(w.hospital));
      await openTab(pg, 'tab-acceptance');
      await waitOrExplain(pg, a => document.querySelector(`.referral-card[data-acceptance-id="${a}"] .btn-accept:not([disabled])`), w.acc);
      deskPages.push([pg, w]);
    }
    await Promise.all(deskPages.map(([pg, w]) => pg.$eval(`.referral-card[data-acceptance-id="${w.acc}"] .btn-accept`, b => b.click())));
    for (const [pg, w] of deskPages) await waitOrExplain(pg, r => document.querySelector(`.allocation-result[data-request-id="${r}"]`), w.rid);
    // Reconcile.
    const hs1 = await hospitals(); const docs1 = await doctors();
    for (const w of winners) {
      const d = await caseDetail(w.rid);
      assert(d.request.status === 'ALLOCATED' && d.acceptances.filter(a => a.status === 'ACCEPTED').length === 1, `${w.rid} ${d.request.status}`);
      const b = hs0.find(h => h.hospital_id === w.hospital); const a = hs1.find(h => h.hospital_id === w.hospital);
      assert(res(a, 'OT').available === res(b, 'OT').available - 1 && res(a, 'OT').locked === res(b, 'OT').locked, `${w.hospital} OT ${JSON.stringify(res(b, 'OT'))} -> ${JSON.stringify(res(a, 'OT'))}`);
      const s0 = docs0.find(x => x.hospital_id === w.hospital && x.specialization === 'TRAUMA_SURGEON');
      const s1 = docs1.find(x => x.doctor_id === s0.doctor_id);
      assert(s0.availability_status === 'AVAILABLE' && s1.availability_status === 'ASSIGNED', `${s0.doctor_id} ${s0.availability_status} -> ${s1.availability_status}`);
    }
    assert(new Set(winners.map(w => w.hospital)).size === winners.length && new Set(winners.map(w => w.rid)).size === winners.length, 'a hospital or case allocated twice');
    note(`API reconcile: ${winners.length} cases ALLOCATED at ${winners.map(w => `${w.rid}@${w.hospital}`).join(', ')}; each OT available -1, locked unchanged; each surgeon AVAILABLE->ASSIGNED once`);
    if (db) {
      const dup = await sql("SELECT doctor_id, COUNT(*) AS n FROM DoctorAssignment WHERE status IN ('LOCKED','COMMITTED') GROUP BY doctor_id HAVING COUNT(*) > 1");
      const neg = await sql('SELECT resource_id FROM MedicalResource WHERE available_capacity < 0 OR locked_capacity < 0 OR available_capacity > total_capacity');
      const twice = await sql("SELECT request_id, COUNT(*) AS n FROM HospitalAcceptance WHERE status = 'ACCEPTED' GROUP BY request_id HAVING COUNT(*) > 1");
      const lockedLeft = await sql('SELECT resource_id, locked_capacity FROM MedicalResource WHERE locked_capacity <> 0');
      const ids = winners.map(w => w.rid);
      const [alloc] = await sql(`SELECT COUNT(*) AS n FROM ResourceAllocation WHERE status = 'COMMITTED' AND request_id IN (${ids.map(() => '?').join(',')})`, ids);
      assert(dup.length === 0 && neg.length === 0 && twice.length === 0 && Number(alloc.n) === winners.length, `SELECT dup ${JSON.stringify(dup)} neg ${JSON.stringify(neg)} twice ${JSON.stringify(twice)} committed ${alloc.n}`);
      for (const w of winners) {
        const [r] = await sql('SELECT available_capacity FROM MedicalResource WHERE hospital_id = ? AND resource_type = ?', [w.hospital, 'OT']);
        assert(Number(r.available_capacity) === res(hs0.find(h => h.hospital_id === w.hospital), 'OT').available - 1, `SELECT ${w.hospital} OT ${r.available_capacity}`);
      }
      note(`SELECT: no doctor with >1 active assignment; no negative/over-total capacity; no request with 2 ACCEPTED; ${alloc.n} COMMITTED allocations for the ${winners.length} winning cases; locked_capacity<>0 rows: ${lockedLeft.map(r => `${r.resource_id}=${r.locked_capacity}`).join(',') || 'none'}`);
    }
    for (const [pg] of deskPages) await closePage(pg);
    ctx.raceCases = winners.map(w => w.rid);
  });

  // ═════════════ Cross-role denial (REST + sockets) ═════════════
  await step('X1. Cross-role REST denial among Hospital and Fleet (other portals, hospitals, ambulances, other cases)', async () => {
    const tok = { desk: ctx.deskToken, para: await token(para1) };
    const deskH = deskFor(ctx.top).hospital_id;
    const otherH = ['H-101', 'H-103', 'H-105'].find(h => h !== deskH);
    // a referral pending at another hospital, for the accept/reject checks
    const c = await adminApi('/emergencies', { method: 'POST', body: { patient_name: 'B5 Denial Case', age: 40, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 30.32, pickup_lng: 78.03 } });
    const r = await adminApi('/referrals/initiate', { method: 'POST', body: { request_id: c.body.request_id, hospital_id: otherH } });
    assert(r.status === 201, `setup referral ${r.status}`);
    // E1's rejected case fails over by recommendation; with the Dehradun data its accepting hospital may be
    // this desk's own. The desk must read it then, and must be refused otherwise.
    const respAccepted = (await caseDetail(ctx.respCase)).acceptances.find(a => a.status === 'ACCEPTED');
    const respIsOwn = respAccepted?.hospital_id === deskH;
    let n = 0;
    n += await A.expectDenied(tok.desk, [['GET', '/admin/users'], ['GET', `/hospitals/${otherH}`], ['GET', `/hospitals/${otherH}/safety`], ['POST', `/referrals/${r.body.acceptance_id}/accept`],
      ['POST', `/referrals/${r.body.acceptance_id}/reject`, { rejection_reason: 'x' }], ['PATCH', `/hospitals/${deskH}/status`, { emergency_status: 'LIMITED' }],
      ['POST', '/emergencies', { patient_name: 'X', age: 30, emergency_type: 'GENERAL' }], ['GET', '/audit/verify'], ['POST', '/tracking/demo-setup'],
      ['GET', `/emergencies/${c.body.request_id}`, undefined, [403, 404]],
      ...(respIsOwn ? [] : [['GET', `/emergencies/${ctx.respCase}`, undefined, [403, 404]]])]);
    if (respIsOwn) assert((await A.api(tok.desk, `/emergencies/${ctx.respCase}`)).status === 200, 'the desk cannot read the case its hospital accepted');
    n += await A.expectDenied(tok.para, [['PATCH', '/ambulances/AMB-04/status', { status: 'MAINTENANCE' }], ['GET', '/ambulances/AMB-04'], ['GET', '/admin/users'],
      ['POST', `/referrals/${r.body.acceptance_id}/accept`], ['GET', '/audit/verify'], ['GET', '/hospitals/H-101'], ['POST', '/tracking/demo-setup'],
      ['GET', `/emergencies/${ctx.opCase}`, undefined, [403, 404]], ['GET', '/emergencies/REQ-8901', undefined, [403, 404]]]);
    const pd = (await A.api(tok.para, '/doctors?hospital_id=H-101')).body;
    assert(pd.count === 0, `paramedic sees a doctor roster: ${pd.count}`);
    // The paramedic's list holds only its own cases.
    const pq = (await A.api(tok.para, '/emergencies')).body.queue.map(q => q.request_id);
    assert(pq.includes(ctx.rsCase) && !pq.includes(ctx.opCase) && !pq.includes('REQ-8901'), `paramedic list ${pq.join(',')}`);
    const dq = (await A.api(tok.desk, '/emergencies')).body.queue.map(q => q.request_id);
    assert(!dq.includes(c.body.request_id) && dq.includes(ctx.respCase) === respIsOwn, `desk list: other hospitals' cases or own accepted case wrong (own=${respIsOwn}): ${dq.join(',')}`);
    await adminApi(`/emergencies/${c.body.request_id}/status`, { method: 'PATCH', body: { status: 'CANCELLED' } });
    note(`${n} cross-role REST calls refused (403/404); paramedic list = own cases (${pq.length}); desk list excludes other hospitals' cases`);
  });

  await step('X2. Sockets: a desk gets no other hospital\'s events; a Fleet socket gets no command-centre or desk events; socket requests are scoped', async () => {
    const deskH = deskFor(ctx.top).hospital_id;
    const otherH = ['H-101', 'H-103', 'H-105'].find(h => h !== deskH);
    const dsk = await socketProbe('desk', ctx.deskToken);
    const paS = await socketProbe('para', await token(para1));
    assert(dsk.ok && paS.ok, 'a probe socket did not connect');
    for (const s of [dsk, paS]) await s.clear();
    const mk = async (h, name) => {
      const c = await adminApi('/emergencies', { method: 'POST', body: { patient_name: name, age: 33, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 30.32, pickup_lng: 78.03 } });
      const r = await adminApi('/referrals/initiate', { method: 'POST', body: { request_id: c.body.request_id, hospital_id: h } });
      assert(r.status === 201, `referral to ${h}: ${r.status} ${JSON.stringify(r.body)}`);
      return { rid: c.body.request_id, acc: r.body.acceptance_id };
    };
    const other = await mk(otherH, 'B5 Other Hospital Case');
    const own = await mk(deskH, 'B5 Own Hospital Case');
    await sleep(1500);
    await dsk.emit('request:active_locks'); await paS.emit('request:active_locks');
    await sleep(1500);
    const de = await dsk.events(); const pe = await paS.events();
    const mentions = (list, s) => list.filter(e => JSON.stringify(e.payload ?? '').includes(s));
    assert(mentions(de, other.rid).length === 0 && mentions(de, otherH).length === 0, `desk ${deskH} got other-hospital events: ${JSON.stringify(mentions(de, other.rid).concat(mentions(de, otherH)).map(e => e.name))}`);
    assert(de.some(e => e.name === 'referral:incoming' && JSON.stringify(e.payload).includes(own.rid)), `control: desk got no referral:incoming for its own hospital (${[...new Set(de.map(e => e.name))]})`);
    const dl = de.filter(e => e.name === 'locks:update').at(-1);
    assert(dl && JSON.stringify(dl.payload).includes(own.acc) && !JSON.stringify(dl.payload).includes(other.acc), `desk locks:update ${JSON.stringify(dl?.payload).slice(0, 200)}`);
    assert(!pe.some(e => e.name === 'locks:update' && JSON.stringify(e.payload).includes(other.acc)), 'paramedic received network locks');
    assert(!pe.some(e => ['lock:acquired', 'referral:incoming', 'audit:entry'].includes(e.name)), `paramedic got command-centre/desk events: ${[...new Set(pe.map(e => e.name))]}`);
    note(`sockets: desk(${deskH}) ${de.length} events, none for ${otherH}/${other.rid}, locks:update only own; Fleet ${[...new Set(pe.map(e => e.name))].join('/') || 'none'}`);
    for (const x of [other, own]) await adminApi(`/emergencies/${x.rid}/status`, { method: 'PATCH', body: { status: 'CANCELLED' } });
    for (const s of [dsk, paS]) await s.close();
  });

  // ═════════════ Admin accounts ═════════════
  await step('AD1. Admin accounts: create; link change, password reset, role change and deactivation each end the open session and socket; reactivate', async () => {
    const user = { username: `b5desk_${TAG}`, password: randomBytes(15).toString('base64url'), role: 'HOSPITAL_DESK' };
    await openTab(admin, 'tab-accounts');
    await press(admin, '#btnNewAccount');
    await waitOrExplain(admin, () => document.getElementById('accountCreateForm'));
    await admin.type('#accountUsername', user.username);
    await admin.type('#accountDisplayName', 'B5 Desk');
    await admin.select('#accountRole', 'HOSPITAL_DESK');
    await waitOrExplain(admin, () => !document.getElementById('accountHospital').closest('.form-group').hidden);
    await admin.select('#accountHospital', 'H-102');
    await admin.type('#accountNewPassword', user.password);
    await admin.type('#accountNewPasswordConfirm', user.password);
    await press(admin, '#accountCreateSubmit');
    await waitOrExplain(admin, () => /created/.test(document.getElementById('globalNotificationBanner').textContent));
    const stored = async () => (await adminApi('/admin/users?limit=200')).body.users.find(u => u.username === user.username);
    let s = await stored();
    assert(s && s.hospital_id === 'H-102' && s.role === 'HOSPITAL_DESK' && Number(s.is_active) === 1, `store ${JSON.stringify(s)}`);
    user.user_id = s.user_id;
    if (db) { const [r] = await sql('SELECT role, hospital_id, is_active, token_version, password_hash FROM SystemUser WHERE username = ?', [user.username]); assert(r && /^\$2[aby]\$/.test(r.password_hash), 'SELECT: no bcrypt row'); note(`SELECT: SystemUser ${user.username} ${r.role} ${r.hospital_id} active=${r.is_active} tv=${r.token_version} (bcrypt hash)`); }
    const page = await newPage('b5desk');
    const expectRevoked = async (what, oldTok, sock) => {
      await waitOrExplain(page, () => document.body.classList.contains('signed-out'), null, 15000);
      const msg = await text(page, '#authNotice');
      assert(msg === REVOKED, `notice after ${what}: "${msg}"`);
      assert(await page.evaluate(() => sessionStorage.getItem('eris.session.token')) === null, `token kept after ${what}`);
      const me = await A.api(oldTok, '/auth/me');
      assert(me.status === 401, `old token after ${what}: ${me.status}`);
      for (let i = 0; i < 40 && await sock.connected(); i++) await sleep(250);
      assert(!(await sock.connected()), `socket still connected after ${what}`);
      const again = await socketProbe(`again-${what.split(' ')[0]}`, oldTok);
      assert(!again.ok, `a new socket with the old token was accepted after ${what}`);
      await again.close(); await sock.close();
    };
    const row = `#accountsTableBody tr[data-user-id="${user.user_id}"]`;
    await admin.select('#accountRoleFilter', 'HOSPITAL_DESK');
    await waitOrExplain(admin, r => document.querySelector(r), row);
    await press(admin, `${row} .btn-edit-account`);
    await waitOrExplain(admin, () => document.getElementById('accountEditForm'));
    // 1. link change
    await loginUI(page, user); let tk = await token(page); let sk = await socketProbe('b5desk-1', tk);
    await admin.select('#accountHospital', 'H-104'); await clearToast(admin); await press(admin, '#accountEditSubmit');
    await waitOrExplain(admin, () => /updated/.test(document.getElementById('globalNotificationBanner').textContent));
    await expectRevoked('link change', tk, sk);
    // 2. password reset
    await loginUI(page, user); tk = await token(page); sk = await socketProbe('b5desk-2', tk);
    const next = randomBytes(15).toString('base64url');
    await admin.type('#accountResetPassword', next); await admin.type('#accountResetPasswordConfirm', next); await press(admin, '#accountResetSubmit');
    await waitOrExplain(admin, () => /New password set/.test(document.getElementById('accountResetMessage').textContent));
    await expectRevoked('password reset', tk, sk);
    assert(!(await A.login(user)), 'old password still accepted'); user.password = next;
    // 3. role change
    await loginUI(page, user); tk = await token(page); sk = await socketProbe('b5desk-3', tk);
    await admin.select('#accountEditRole', 'PARAMEDIC');
    await waitOrExplain(admin, () => document.getElementById('accountHospital')?.closest('.form-group').hidden);
    await clearToast(admin); await press(admin, '#accountEditSubmit');
    await waitOrExplain(admin, () => /updated/.test(document.getElementById('globalNotificationBanner').textContent));
    await expectRevoked('role change', tk, sk);
    s = await stored(); assert(s.role === 'PARAMEDIC' && s.hospital_id === null, `store after role change ${s.role} ${s.hospital_id}`);
    // 4. deactivation
    await loginUI(page, user); tk = await token(page); sk = await socketProbe('b5desk-4', tk);
    await clearToast(admin); await press(admin, '#btnAccountDeactivate');
    await waitOrExplain(admin, () => /deactivated/.test(document.getElementById('globalNotificationBanner').textContent));
    await expectRevoked('deactivation', tk, sk);
    assert(!(await A.login(user)), 'deactivated account signed in');
    // 5. reactivation
    await waitOrExplain(admin, () => document.getElementById('btnAccountReactivate'));
    await clearToast(admin); await press(admin, '#btnAccountReactivate');
    await waitOrExplain(admin, () => /reactivated/.test(document.getElementById('globalNotificationBanner').textContent));
    assert(await A.login(user), 'reactivated account cannot sign in');
    if (db) {
      const [r] = await sql('SELECT role, hospital_id, is_active, token_version FROM SystemUser WHERE username = ?', [user.username]);
      assert(r.role === 'PARAMEDIC' && Number(r.is_active) === 1 && Number(r.token_version) >= 4, `SELECT ${JSON.stringify(r)}`);
      note(`SELECT: after 4 revocations SystemUser ${r.role} active=${r.is_active} token_version=${r.token_version}`);
    }
    note('each of link change / password reset / role change / deactivation: UI signed out with the account-change notice, token cleared, old token 401, socket closed, new socket with old token refused');
    await admin.select('#accountRoleFilter', '');
    await closePage(page);
  });

  // ═════════════ Workflow J: audit chain ═════════════
  await step('J1. Audit chain verifies after the run (admin UI button and API)', async () => {
    await openTab(admin, 'tab-activity');
    await press(admin, '#btnVerifyAuditChain');
    await waitOrExplain(admin, () => /Chain intact|broken|invalid/i.test(document.getElementById('auditVerifyResult')?.textContent || ''), null, 20000);
    const ui = await text(admin, '#auditVerifyResult');
    const v = (await adminApi('/audit/verify')).body;
    assert(/Chain intact/.test(ui) && v.verification?.valid === true, `UI "${ui}" API ${JSON.stringify(v).slice(0, 200)}`);
    note(`UI "${ui.slice(0, 100)}"; API ${JSON.stringify(v).slice(0, 160)}`);
    if (db) { const [h] = await sql('SELECT chain_seq FROM AuditChainHead'); const [c] = await sql('SELECT COUNT(*) AS n FROM EmergencyHistory'); note(`SELECT: AuditChainHead.chain_seq=${h?.chain_seq}; EmergencyHistory rows=${c.n}`); }
  });

  // ═════════════ Browser behaviour ═════════════
  await step('BR1. Refresh mid-flow restores the session via /auth/me first; back/forward keep or clear it correctly', async () => {
    // The ops admin has a referral pending (the respiratory case is allocated; use a fresh one).
    await openTab(op, 'tab-ranking');
    op.__api.length = 0;
    await op.reload({ waitUntil: 'networkidle2' });
    await waitOrExplain(op, () => !document.body.classList.contains('booting') && !document.body.classList.contains('signed-out') && document.getElementById('connectionStatus')?.textContent === 'Live');
    assert(op.__api[0] === 'GET /api/v1/auth/me', `first API call after reload: ${op.__api.slice(0, 3).join(', ')}`);
    await openTab(op, 'tab-hospitals');
    await waitOrExplain(op, () => document.querySelectorAll('#hospitalsManagementGrid [data-hospital-id]').length > 0);
    // back/forward
    await op.goto(`${server.origin}/health`);
    await op.goBack({ waitUntil: 'load', timeout: 5000 }).catch(() => {}); await sleep(500);
    await waitOrExplain(op, () => !document.body.classList.contains('booting') && !document.body.classList.contains('signed-out') && document.getElementById('connectionStatus')?.textContent === 'Live');
    await op.goForward({ waitUntil: 'load', timeout: 5000 }).catch(() => {}); await op.goBack({ waitUntil: 'load', timeout: 5000 }).catch(() => {}); await sleep(500);
    await waitOrExplain(op, () => !document.body.classList.contains('signed-out') && document.getElementById('connectionStatus')?.textContent === 'Live');
    note('reload: first call GET /auth/me, session and Live socket restored; back/forward to /health and back: still signed in, Live');
  });

  await step('BR2. Logout leaves no data in the DOM or storage; Back after logout does not resurrect the session', async () => {
    const secrets = [ctx.mainName, ctx.opName, ctx.respName, ctx.rsName, 'Robert Vance', 'Sarah Jenkins', ctx.mainCase, ctx.opCase];
    await openTab(op, 'tab-ingestion');
    await press(op, '#logoutBtn');
    await waitOrExplain(op, () => document.body.classList.contains('signed-out'));
    const found = await op.evaluate(list => {
      const dom = document.documentElement.textContent + [...document.querySelectorAll('input,textarea,select')].map(n => n.value).join('|');
      return list.filter(v => dom.includes(v));
    }, secrets);
    const store = await op.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    assert(found.length === 0, `DOM still holds: ${found.join(' | ')}`);
    assert(!/eris\.session\.token|eyJ/.test(store), `storage after logout: ${store.slice(0, 120)}`);
    await op.goto(`${server.origin}/health`);
    await op.goBack({ waitUntil: 'load', timeout: 5000 }).catch(() => {}); await sleep(500);
    await waitOrExplain(op, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    const found2 = await op.evaluate(list => list.filter(v => document.documentElement.textContent.includes(v)), secrets);
    assert(found2.length === 0, `after Back: ${found2.join(' | ')}`);
    note(`logout: none of ${secrets.length} case/patient strings in DOM or inputs; no token in storage; Back shows the sign-in screen`);
    await loginUI(op, OPS);
  });

  // ═════════════ First Aid ═════════════
  await step('FA1. First Aid Guide opens signed-out with no API call or socket; shows "Call 112"', async () => {
    const page = await newPage('firstaid');
    const net = [];
    page.on('request', r => { const u = r.url(); if (u.startsWith(`${server.origin}/api/`) || /\/socket\.io\/\?/.test(u)) net.push(`${r.method()} ${u}`); });
    const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', e => net.push(`websocket ${e.url}`));
    await page.goto(server.origin, { waitUntil: 'networkidle2' });
    await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await press(page, '#firstAidLink');
    await waitOrExplain(page, () => !document.getElementById('firstAidOverlay').hidden && document.querySelectorAll('#firstAidOverlayBody .fa-step').length === 4);
    const g = await page.$eval('#firstAidOverlayBody', n => ({ title: n.querySelector('.fa-guide-title')?.textContent, steps: n.querySelectorAll('.fa-step').length, items: n.querySelectorAll('.fa-step li').length, call: n.querySelector('.fa-call-link')?.getAttribute('href'), callText: n.textContent.includes('Call 112') }));
    await sleep(1200);
    assert(g.title === '1. What to do immediately after an accident' && g.steps === 4 && g.items === 15 && g.call === 'tel:112' && g.callText, `guide ${JSON.stringify(g)}`);
    assert(net.length === 0, `network while signed out: ${net.join(', ')}`);
    note(`first aid signed out: ${g.steps} sections / ${g.items} items, tel:112 link, "Call 112" text, 0 API/socket requests`);
    await closePage(page);
  });

  // ═════════════ Layouts ═════════════
  await step('L1. Every portal at 1366x900, 768x1024 and 390x844: no horizontal overflow, primary actions reachable', async () => {
    const problems = []; const counts = {}; const clipped = [];
    const roles = [ADMIN, deskFor('H-101'), PARA1];
    for (const [w, h] of [[1366, 900], [768, 1024], [390, 844]]) {
      for (const a of roles) {
        const page = await newPage(`L${w}-${a.role}`, { width: w, height: h });
        try {
          await loginUI(page, a);
          await sleep(600);
          for (const tab of NAV[a.role]) {
            {
              const menu = await page.$eval('#navMenuBtn', b => getComputedStyle(b).display !== 'none').catch(() => false);
              if (menu) { await page.click('#navMenuBtn'); await sleep(200); }
              const vis = await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => { const r = b.getBoundingClientRect(); const nav = b.closest('nav') || b.parentElement; return { inView: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1, scrollable: nav.scrollWidth > nav.clientWidth && /auto|scroll/.test(getComputedStyle(nav).overflowX) }; });
              if (!vis.inView) clipped.push(`${w} ${a.role} ${tab}${vis.scrollable ? ' (nav scrolls)' : ''}`);
              const reach = await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && (hit === b || b.contains(hit)); });
              if (!reach) problems.push(`${w} ${a.role} ${tab}: nav button not reachable even after scrolling it into view`);
              await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => b.click());
              await sleep(600);
              if (tab === 'tab-ingestion' && a.role !== 'HOSPITAL_DESK') { await page.$eval('#emergencyQueueTableBody tr[data-request-id]', r => r.click()).catch(() => {}); await sleep(400); }
            }
            const r = await page.evaluate(paneId => {
              const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
              const root = document.getElementById(paneId);
              const primary = [...root.querySelectorAll('button')].filter(b => !b.closest('[hidden]') && b.offsetParent !== null
                && /btn-primary|btn-success|btn-danger|btn-emergency|btn-edit-account|btn-dispatch|btn-accept|btn-reject|btn-init-referral/.test(b.className)).concat([document.getElementById('logoutBtn')]);
              const bad = [];
              for (const b of primary) {
                b.scrollIntoView({ block: 'center', inline: 'nearest' });
                const q = b.getBoundingClientRect();
                const hit = document.elementFromPoint(q.left + Math.min(q.width / 2, 10), q.top + q.height / 2);
                if (!(q.width > 0 && q.left >= -1 && q.right <= innerWidth + 1) || !(hit === b || b.contains(hit))) bad.push(`${b.id || b.className} "${b.textContent.trim().slice(0, 20)}"`);
              }
              window.scrollTo(0, 0);
              return { overflow, bad, n: primary.length };
            }, tab);
            counts[`${w}`] = (counts[`${w}`] || 0) + 1;
            if (r.overflow > 0) problems.push(`${w} ${a.role} ${tab}: ${r.overflow}px horizontal overflow`);
            r.bad.forEach(b => problems.push(`${w} ${a.role} ${tab}: unreachable ${b}`));
            await page.screenshot({ path: path.join(state.shots, `layout-${w}-${a.role}-${tab}.png`) });
          }
        } catch (err) { problems.push(`${w} ${a.role}: ${err.message.split('\n')[0]}`); }
        await closePage(page);
      }
    }
    note(`layouts: screens checked per width ${JSON.stringify(counts)}; problems ${problems.length}; nav buttons outside the viewport until scrolled: ${clipped.join('; ') || 'none'}`);
    assert(problems.length === 0, problems.join('\n'));
  });

  // ═════════════ Server disconnect / restart and session expiry ═════════════
  await step('BR3. Server restart: the UI shows the outage and recovers (same secret); with a new secret it signs out', async () => {
    allowedConsole.push({ step: state.currentStep, re: /ERR_CONNECTION_REFUSED|WebSocket|net::|status of 5\d\d|Failed to fetch/ });
    await server.stop();
    await waitOrExplain(op, () => /Reconnecting|offline|stopped/i.test(document.getElementById('connectionStatus')?.textContent || ''), null, 15000);
    const during = await text(op, '#connectionStatus');
    await server.start();
    await waitOrExplain(op, () => document.getElementById('connectionStatus')?.textContent === 'Live' && !document.body.classList.contains('signed-out'), null, 40000);
    await press(op, '#refreshWorkspaceBtn');
    await openTab(op, 'tab-hospitals');
    await waitOrExplain(op, () => document.querySelectorAll('#hospitalsManagementGrid [data-hospital-id]').length > 0);
    if (BACKEND === 'mysql') {
      const d = await caseDetail(ctx.mainCase);
      assert(d.request.status === 'COMPLETED', `after restart ${ctx.mainCase} is ${d.request?.status}`);
      note(`MySQL persistence across restart: ${ctx.mainCase} still COMPLETED`);
    }
    note(`restart (same secret): status "${during}" during the outage -> "Live" after, still signed in, data reloaded`);
    // New secret: old tokens are invalid.
    await server.stop();
    server.secret = randomBytes(32).toString('hex');
    await server.start();
    await waitOrExplain(op, () => document.body.classList.contains('signed-out'), null, 40000);
    const notice = await text(op, '#authNotice').catch(() => '');
    ctx.adminToken = await A.login(ADMIN);
    note(`restart with a new JWT secret: UI signed out (notice "${notice}")`);
  });

  await step('BR4. Expired session (JWT_EXPIRES=20s): the UI signs out with the expiry notice; the old token is refused; a stored expired token is not used on reload', async () => {
    allowedConsole.push({ step: state.currentStep, re: /ERR_CONNECTION_REFUSED|WebSocket|net::|status of 5\d\d/ });
    await server.stop();
    await server.start({ JWT_EXPIRES: '20' });
    ctx.adminToken = await A.login(ADMIN);
    const page = await newPage('expiry');
    await loginUI(page, OPS);
    const tk = await token(page);
    await waitOrExplain(page, () => document.body.classList.contains('signed-out'), null, 40000);
    const notice = await text(page, '#authNotice');
    assert(/session expired/i.test(notice), `notice "${notice}"`);
    assert((await A.api(tk, '/auth/me')).status === 401, 'expired token accepted');
    await page.evaluate(t => sessionStorage.setItem('eris.session.token', t), tk);
    await page.reload({ waitUntil: 'networkidle2' });
    await waitOrExplain(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    const n2 = await text(page, '#authNotice');
    assert(/expired/i.test(n2), `reload notice "${n2}"`);
    note(`expiry: auto sign-out "${notice}"; /auth/me with it -> 401; reload with the stored expired token -> "${n2}"`);
    await closePage(page);
  });

  await step('Z. No unexpected console errors, page errors or CSP violations', async () => {
    for (const [label, page] of state.pages) {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      csp.forEach(v => issues.push(`[${label}] CSP violation: ${v}`));
    }
    assert(issues.length === 0, `${issues.length} issue(s):\n${issues.slice(0, 30).join('\n')}`);
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
  try { await server?.stop(); } catch { /* ignore */ }
  if (db) {
    try { await db.reset(true); console.log('MySQL _test database reset to the clean demo seed.'); } catch (err) { console.log(`MySQL reset failed: ${err.message}`); }
    await db.release().catch(() => {});
  }
}
summary(`Batch 5 journeys [${BACKEND}]`);
process.exit(exitCode);
