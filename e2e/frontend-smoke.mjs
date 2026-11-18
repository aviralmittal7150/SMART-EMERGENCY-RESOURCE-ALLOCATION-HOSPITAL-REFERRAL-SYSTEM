// e2e/frontend-smoke.mjs
// Real-browser smoke test of the ERIS UI against a throwaway in-memory server.
//
//   node e2e/frontend-smoke.mjs            (E2E_PORT=4310 by default; never 3000/4000)
//
// - Starts `node server/server.js` with DB_USE_MEMORY=true, a random JWT secret generated here, on E2E_PORT.
// - The browser talks to the server through a tiny reverse proxy (E2E_PORT+1) that adds the strict
//   Content-Security-Policy below to HTML responses (unless the server already sends one) and passes WebSocket
//   upgrades through. The test fails on any console error, page error, CSP violation or alert() dialog.
// - Accounts: the server keeps only bcrypt hashes, so this test makes its own. It mirrors the demo accounts' roles,
//   hospitals and units (server/db/demoUsers.js) with random per-run passwords, hands them to e2e/e2e-server.mjs on
//   stdin, and that wrapper hashes them into the in-memory store before starting the server. No password is printed,
//   stored on disk, or put in an environment variable or argv.
// - Screenshots go to e2e/screenshots/.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { DEMO_USERS } from '../server/db/demoUsers.js'; // roles, hospitals and units only (it holds no passwords)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 4310);
if ([3000, 4000].includes(PORT)) throw new Error('Ports 3000 and 4000 are reserved for other processes.');
const PROXY_PORT = PORT + 1;
if ([3000, 4000].includes(PROXY_PORT)) throw new Error('Ports 3000 and 4000 are reserved for other processes.');
const API_ORIGIN = `http://localhost:${PORT}`;   // the ERIS server (Node-side API checks)
const ORIGIN = `http://127.0.0.1:${PROXY_PORT}`; // what the browser loads: the same server behind a CSP-adding proxy
const SHOTS = path.join(ROOT, 'e2e', 'screenshots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "style-src 'self' https://fonts.googleapis.com https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const XSS_NAME = '<img src=x onerror=alert(1)>';
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

mkdirSync(SHOTS, { recursive: true });

// ── Demo accounts from the server source (values stay in memory) ──────────────
function e2eAccounts() {
  const out = DEMO_USERS.map(u => ({
    username: `e2e_${u.username}`, password: randomBytes(18).toString('base64url'), role: u.role,
    hospital_id: u.hospital_id ?? null, ambulance_id: u.ambulance_id ?? null, patient_id: u.patient_id ?? null, display_name: u.display_name
  }));
  if (!out.some(a => a.role === 'ADMIN') || out.filter(a => a.role === 'PARAMEDIC').length < 2) throw new Error('Unexpected account layout in server/db/demoUsers.js');
  return out;
}
const ACCOUNTS = e2eAccounts();
const account = (roleName, hospitalId) => ACCOUNTS.find(a => a.role === roleName && (!hospitalId || a.hospital_id === hospitalId));

// ── Result bookkeeping ──────────────────────────────────────────────────────
const results = [];
const issues = []; // console errors, page errors, CSP violations, dialogs
let currentStep = 'setup';
const allowedConsole = []; // { step, re } expected browser messages for deliberate failure tests

async function step(name, fn) {
  currentStep = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
    const tag = name.split('.')[0];
    for (const [label, page] of openPages) {
      try {
        await page.screenshot({ path: path.join(SHOTS, `fail-${tag}-${label}.png`) });
        const toast = await page.$eval('#globalNotificationBanner', n => (n.hidden ? '' : n.textContent)).catch(() => '');
        if (toast) console.log(`      [${label}] toast: ${toast}`);
        console.log(`      [${label}] last click: ${await page.evaluate(() => window.__lastClick || '-')}`);
      } catch { /* page closed */ }
    }
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

// ── Server ────────────────────────────────────────────────────────────────────
let server;
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_SECRET: randomBytes(32).toString('hex'), NODE_ENV: 'development',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', // the run signs in ~40 times from one address
    // The /api limiter allows 300 requests a minute per client. Each browser page here is its own user, so the proxy
    // hop is trusted and every page sends its own X-Forwarded-For (newPage); the limiter itself stays on.
    TRUST_PROXY: '1', ROUTING_URL: 'off', // no public routing service from a test server
    // Step 9 tests the paramedic's MANUAL dispatch and ETA; the automatic simulated transport (on by default in
    // development) would race it and overwrite the ETA. tracking.mjs and batch8.mjs cover the automatic path.
    SIMULATED_TRANSPORT: 'off' };
  delete env.JWT_EXPIRES; // the server default; a shell value must not shorten sessions mid-run
  server = spawn(process.execPath, ['e2e/e2e-server.mjs'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stdin.end(JSON.stringify(ACCOUNTS));
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${API_ORIGIN}/health`); if (r.ok) return; } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${log.slice(-2000)}`);
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Server did not become healthy:\n${log.slice(-2000)}`);
}
function stopServer() {
  if (server && server.exitCode === null) server.kill('SIGTERM');
}

let proxy;
function startProxy() {
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: req.headers }, upRes => {
      const headers = { ...upRes.headers };
      if (String(headers['content-type'] || '').includes('text/html')) {
        serverSendsCsp = Boolean(headers['content-security-policy']);
        if (!serverSendsCsp) headers['content-security-policy'] = CSP;
      }
      res.writeHead(upRes.statusCode, headers);
      upRes.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(PROXY_PORT, '127.0.0.1', resolve); });
}

async function apiLogin(acct) {
  const r = await fetch(`${API_ORIGIN}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
  const body = await r.json();
  if (r.status !== 200 || !body.token) throw new Error(`API login for ${acct.role} failed: ${r.status}`);
  return body.token;
}

async function api(token, p, opts = {}) {
  const r = await fetch(`${API_ORIGIN}/api/v1${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.66.1.1', ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

// ── Browser helpers ───────────────────────────────────────────────────────────
let browser;
const openPages = [];
let serverSendsCsp = null;
const pageRules = new WeakMap(); // page -> [{ match(req) -> bool, action(req) }]

async function newPage(label) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('click', e => { const t = e.target; window.__lastClick = `${t.tagName}#${t.id}.${t.className} "${(t.textContent || '').trim().slice(0, 40)}"`; }, true);
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`));
  });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const loc = msg.location()?.url || '';
    const full = `${text} ${loc}`;
    if (allowedConsole.some(a => a.step === currentStep && a.re.test(full))) return;
    issues.push(`[${label}] [${currentStep}] console.error: ${full}`);
  });
  page.on('pageerror', err => issues.push(`[${label}] [${currentStep}] pageerror: ${err.message}`));
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') return dialog.accept();
    issues.push(`[${label}] [${currentStep}] unexpected ${dialog.type()} dialog: ${dialog.message()}`);
    return dialog.dismiss();
  });
  pageRules.set(page, []);
  openPages.push([label, page]);
  const clientAddress = `10.66.0.${openPages.length}`; // this page's own client address (see TRUST_PROXY above)
  await page.setRequestInterception(true);
  page.on('request', async req => {
    try {
      const url = req.url();
      for (const rule of pageRules.get(page)) {
        if (rule.match(req)) { rule.once && pageRules.get(page).splice(pageRules.get(page).indexOf(rule), 1); return rule.action(req); }
      }
      if (/^https:\/\/tile\.openstreetmap\.org\//.test(url)) {
        return req.respond({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
      }
      if (url.startsWith(ORIGIN)) return req.continue({ headers: { ...req.headers(), 'x-forwarded-for': clientAddress } });
      return req.continue();
    } catch (err) {
      issues.push(`[${label}] interception error: ${err.message}`);
      try { await req.abort(); } catch { /* already handled */ }
    }
  });
  return page;
}

async function cspViolations(page) {
  try { return await page.evaluate(() => window.__csp || []); } catch { return []; }
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
const text = (page, sel) => page.$eval(sel, n => n.textContent.trim());
const isSignedOut = page => page.evaluate(() => document.body.classList.contains('signed-out'));

async function login(page, acct) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
  await loginInPlace(page, acct);
}

/** Sign in through the portal of the page as it is (no navigation), so JavaScript still running from the previous
 *  session in this document keeps running. */
async function loginInPlace(page, acct) {
  await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
  await waitFor(page, () => document.activeElement?.id === 'loginUsername'); // the portal focuses it; type only after
  await page.$eval('#loginUsername', n => { n.value = ''; });
  await page.$eval('#loginPassword', n => { n.value = ''; });
  await page.type('#loginUsername', acct.username);
  await page.type('#loginPassword', acct.password);
  await page.click('#loginSubmitBtn');
  await waitFor(page, () => !document.body.classList.contains('signed-out'));
  await waitFor(page, () => document.getElementById('connectionStatus')?.textContent === 'Live', null, 10000);
}

async function openTab(page, tabId) {
  await page.click(`.nav-tab-btn[data-tab="${tabId}"]`);
  await waitFor(page, id => document.getElementById(id)?.classList.contains('active'), tabId);
}

async function fillIntake(page, { name, age, lat, lng, notes }) {
  await page.$eval('#emergencyIntakeForm', f => f.reset());
  await page.type('#patientName', name);
  await page.type('#patientAge', String(age));
  if (lat !== undefined) { await page.type('#pickupLat', String(lat)); await page.type('#pickupLng', String(lng)); }
  if (notes) await page.type('#emergencyNotes', notes);
  const got = await page.evaluate(() => ({ name: document.getElementById('patientName').value, age: document.getElementById('patientAge').value, active: document.activeElement?.id }));
  if (got.name !== name || got.age !== String(age)) {
    await shot(page, 'debug-fill');
    throw new Error(`form fill failed: ${JSON.stringify(got)}`);
  }
}

// Test hook: record the text of every Blob the page turns into a download URL (CSV exports).
const captureBlobs = page => page.evaluate(() => {
  if (window.__blobs) return;
  window.__blobs = [];
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => { blob.text().then(t => window.__blobs.push(t)); return original(blob); };
});

/** Interception action: deliver the request to the server from Node, then fail it in the browser, so the server
 *  acts on it but the page never sees the answer (a response lost on the way back). */
const forwarded = [];
async function forwardThenDrop(req) {
  const u = new URL(req.url());
  const headers = { ...req.headers() };
  ['host', 'connection', 'content-length', 'origin', 'referer'].forEach(h => delete headers[h]);
  const r = await fetch(`${API_ORIGIN}${u.pathname}${u.search}`, { method: req.method(), headers, body: req.postData() });
  forwarded.push({ path: u.pathname, status: r.status, body: await r.text() });
  return req.abort('failed');
}

/** Hold a request until release() is called; `held` resolves when the browser has sent it. */
function holdRule(match) {
  let release; let markHeld;
  const gate = new Promise(r => { release = r; });
  const held = new Promise(r => { markHeld = r; });
  return { release: () => release(), held, rule: { once: true, match, action: async r => { markHeld(); await gate; return r.continue(); } } };
}

/** Hold every matching request (not once) until release(); later ones pass straight through. */
function holdAllRule(match) {
  let release;
  const gate = new Promise(r => { release = r; });
  return { release: () => release(), rule: { match, action: async r => { await gate; return r.continue(); } } };
}

const toastText = page => page.$eval('#globalNotificationBanner', n => (n.hidden ? '' : n.textContent));

async function createCaseViaApi(token, name, extra = {}) {
  const r = await api(token, '/emergencies', { method: 'POST', body: JSON.stringify({ patient_name: name, age: 40, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 30.321, pickup_lng: 78.031, ...extra }) });
  assert(r.status === 201, `API create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.request_id;
}

const queueRowIds = page => page.$$eval('#emergencyQueueTableBody tr[data-request-id]', rows => rows.map(r => r.dataset.requestId));

// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  await startServer();
  await startProxy();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });

  const paramedicAcct = account('PARAMEDIC');
  const adminAcct = account('ADMIN');
  const ctx = {};

  const para = await newPage('paramedic');

  await step('1. Sign-in portal shown first; no workspace data without a session', async () => {
    await para.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await waitFor(para, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    const visible = await para.$eval('#authPortalModal', n => getComputedStyle(n).display !== 'none');
    assert(visible, 'login portal not visible');
    const rows = await para.$$eval('#emergencyQueueTableBody tr', r => r.length);
    assert(rows === 0, `queue has ${rows} rows before sign-in`);
    assert(!(await para.$('#quickLoginAdmin')), 'demo role switcher still present');
    await shot(para, '01-login');
  });

  await step('2. Fleet (paramedic) signs in; queue matches GET /emergencies (no mock data)', async () => {
    await login(para, paramedicAcct);
    const title = await text(para, '#userRoleTitle');
    assert(/\(Fleet\)/.test(title), `role badge is "${title}"`);
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
    assert(ctx.paraToken, 'token not in sessionStorage');
    assert(await para.evaluate(() => localStorage.getItem('eris.auth.session')) === null, 'token found in localStorage');
    // The queue is scoped (a paramedic sees the cases they registered or their unit serves), so it may be empty: wait
    // for the loaded state, rows or the empty message, never the loading one.
    await waitFor(para, () => document.querySelector('#emergencyQueueTableBody tr[data-request-id]')
      || document.querySelector('#emergencyQueueTableBody .state-msg:not(.is-loading):not(.is-error)'));
    await para.select('#emergencyStatusFilter', 'ALL');
    const ids = await queueRowIds(para);
    const server = await api(ctx.paraToken, '/emergencies');
    assert(ids.length === server.body.count, `UI shows ${ids.length} cases, server has ${server.body.count}`);
    assert(server.body.queue.every(q => ids.includes(q.request_id)), 'UI queue ids differ from server');
    assert(await para.$eval('#nav-acceptance', n => n.hidden), 'acceptance tab visible to paramedic');
    assert(await para.$eval('#nav-activity', n => n.hidden), 'audit tab visible to paramedic');
  });

  await step('3. Paramedic registers patient + emergency (XSS name renders as text)', async () => {
    const before = (await api(ctx.paraToken, '/emergencies')).body.count;
    await fillIntake(para, { name: XSS_NAME, age: 58, lat: 30.3200, lng: 78.0300, notes: 'Chest pain, ST elevation, SpO2 89%' });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => document.querySelector('#emergencyQueueTableBody tr[aria-selected="true"]'));
    ctx.requestId = await para.$eval('#emergencyQueueTableBody tr[aria-selected="true"]', r => r.dataset.requestId);
    const after = (await api(ctx.paraToken, '/emergencies')).body;
    assert(after.count === before + 1, `server count ${before} -> ${after.count}`);
    const created = after.queue.find(q => q.request_id === ctx.requestId);
    assert(created && created.patient.full_name === XSS_NAME, 'created case not found on server');
    const cell = await para.$eval(`#emergencyQueueTableBody tr[data-request-id="${ctx.requestId}"] .patient-name`, n => ({ text: n.textContent, imgs: n.querySelectorAll('img').length }));
    assert(cell.text === XSS_NAME && cell.imgs === 0, `patient cell rendered "${cell.text}" with ${cell.imgs} img`);
    assert((await para.$$('#emergencyQueueTable img')).length === 0, 'an <img> exists inside the queue table');
    await waitFor(para, () => document.querySelector('#lifecycleTracker .state-step.active')?.dataset.state === 'WAITING');
    await waitFor(para, () => /Request Created/i.test(document.getElementById('caseAuditTable')?.textContent || ''));
    const caption = await para.$eval('#caseTrackerCaption', n => ({ text: n.textContent, imgs: n.querySelectorAll('img').length }));
    assert(caption.text.includes(XSS_NAME) && caption.imgs === 0, `tracker caption rendered "${caption.text}" with ${caption.imgs} img`);
    assert((await para.$$('#caseTrackerPanel img')).length === 0, 'an <img> exists inside the case tracker');
    const statusCell = await para.$eval(`#emergencyQueueTableBody tr[data-request-id="${ctx.requestId}"]`, r => r.textContent);
    assert(/WAITING/i.test(statusCell), 'queue row does not show WAITING');
    await shot(para, '02-intake-queue-tracker');
  });

  await step('4. Recommendation uses the selected case\'s requirements and specialist availability (paramedic)', async () => {
    await para.click('#btnFindHospitals');
    await waitFor(para, () => document.getElementById('tab-ranking').classList.contains('active'));
    await waitFor(para, () => document.querySelectorAll('#rankingResultsContainer .hospital-card').length > 0);
    const needs = await text(para, '#rankingCase');
    assert(/ICU bed/.test(needs) && /Ventilator/.test(needs) && /Cardiologist/.test(needs), `case requirements not shown: ${needs}`);
    assert(needs.includes(XSS_NAME), `recommendation does not show the patient name as text: ${needs}`);
    assert((await para.$$('#tab-ranking img')).length === 0, 'an <img> exists inside the recommendation');
    // Paramedics get no doctor roster (GET /hospitals sends `specialists_available` counts instead): availability must
    // still come through, and agree with the server's counts.
    const hs = (await api(ctx.paraToken, '/hospitals')).body.hospitals;
    assert(hs.every(h => !('doctors' in h)) && hs.some(h => h.specialists_available?.CARDIOLOGIST > 0), 'unexpected GET /hospitals shape for a paramedic');
    const shown = await para.$$eval('#rankingResultsContainer .hospital-card', cards => cards.map(c => ({
      id: c.dataset.hospitalId, spec: [...c.querySelectorAll('.resource-capsule')].find(x => /Specialist/.test(x.textContent))?.querySelector('.capsule-val')?.textContent })));
    for (const h of hs) {
      const want = h.specialists_available.CARDIOLOGIST > 0 ? 'On duty' : 'Not available';
      const got = shown.find(x => x.id === h.hospital_id)?.spec;
      assert(got === want, `${h.hospital_id}: cardiologist shown "${got}", server count ${h.specialists_available.CARDIOLOGIST}`);
    }
    const top = await para.$eval('#rankingResultsContainer .hospital-card', c => ({ id: c.dataset.hospitalId, eligible: !!c.querySelector('.btn-init-referral:not([disabled])') }));
    assert(top.eligible, 'top-ranked hospital is not eligible');
    ctx.hospitalId = top.id;
    const closedRow = await para.$$eval('#rankingResultsContainer .hospital-card', cards => cards.filter(c => c.querySelector('.exclusion-list')).length);
    assert(closedRow > 0, 'no hospital was excluded (expected some without free ICU/vent/cardiologist)');
    await shot(para, '03-recommendation');
  });

  await step('5. Paramedic initiates referral (POST /referrals/initiate) with live countdown', async () => {
    await para.click(`#rankingResultsContainer .hospital-card[data-hospital-id="${ctx.hospitalId}"] .btn-init-referral`);
    await waitFor(para, () => document.getElementById('referralPendingLine'));
    const t1 = await para.$eval('#referralPendingLine [data-deadline]', n => n.textContent);
    assert(/^\d+s$/.test(t1), `countdown text "${t1}"`);
    const detail = (await api(ctx.paraToken, `/emergencies/${ctx.requestId}`)).body;
    assert(detail.request.status === 'MATCHING', `server status ${detail.request.status}`);
    ctx.acceptanceId = detail.acceptances.find(a => a.status === 'PENDING')?.acceptance_id;
    assert(ctx.acceptanceId, 'no pending acceptance on server');
    await shot(para, '04-referral-pending');
  });

  const deskAcct = account('HOSPITAL_DESK', ctx.hospitalId);
  const desk = await newPage('desk');

  await step('6. Desk of that hospital sees the referral in the acceptance console with a countdown', async () => {
    assert(deskAcct, `no desk account for ${ctx.hospitalId}`);
    await login(desk, deskAcct);
    await waitFor(desk, () => document.getElementById('tab-acceptance').classList.contains('active'));
    const sel = `.referral-card[data-acceptance-id="${ctx.acceptanceId}"]`;
    await waitFor(desk, s => document.querySelector(s), sel);
    await waitFor(desk, s => /^\d+s$/.test(document.querySelector(`${s} .countdown`)?.textContent || ''), sel);
    const c1 = parseInt(await desk.$eval(`${sel} .countdown`, n => n.textContent), 10);
    await new Promise(r => setTimeout(r, 2200));
    const c2 = parseInt(await desk.$eval(`${sel} .countdown`, n => n.textContent), 10);
    assert(c2 < c1, `countdown did not decrease (${c1} -> ${c2})`);
    await waitFor(desk, s => document.querySelector(`${s} .patient-name`), sel);
    const name = await desk.$eval(`${sel} .patient-name`, n => ({ text: n.textContent, imgs: n.querySelectorAll('img').length }));
    assert(name.text.includes(XSS_NAME) && name.imgs === 0, 'patient name not rendered as text in acceptance console');
    assert(await desk.$eval('#intakePanel', n => n.hidden), 'intake form visible to hospital desk');
    await shot(desk, '05-acceptance-console');
  });

  await step('7. Desk accepts; allocation result shown from the server response', async () => {
    // Until step 8 sees the notification, every read of this case by the paramedic is held: the poll fallback cannot
    // tell them, only the server's referral:status event can.
    ctx.caseReads = holdAllRule(r => r.method() === 'GET' && r.url().startsWith(`${ORIGIN}/api/v1/emergencies/${ctx.requestId}`));
    pageRules.get(para).push(ctx.caseReads.rule);
    await desk.click(`.referral-card[data-acceptance-id="${ctx.acceptanceId}"] .btn-accept`);
    const sel = `.allocation-result[data-request-id="${ctx.requestId}"]`;
    await waitFor(desk, s => document.querySelector(s), sel);
    const txt = await text(desk, sel);
    ctx.autoAmbulance = await desk.$eval(sel, n => n.dataset.ambulanceId);
    assert(/^AMB-/.test(ctx.autoAmbulance) && txt.includes(`Ambulance: ${ctx.autoAmbulance}`), `allocation result has no ambulance: ${txt}`);
    assert(txt.includes('Hospital:'), 'allocation result lacks the hospital');
    const detail = (await api(ctx.paraToken, `/emergencies/${ctx.requestId}`)).body;
    assert(detail.request.status === 'ALLOCATED', `server status ${detail.request.status}`);
    assert(detail.request.assigned_ambulance_id === ctx.autoAmbulance, 'UI ambulance differs from server');
    await waitFor(desk, s => !document.querySelector(s), `.referral-card[data-acceptance-id="${ctx.acceptanceId}"]`);
    await shot(desk, '06-allocation-result');
  });

  await step('8. Paramedic is told of the acceptance by referral:status (case reads held), then the tracker shows it', async () => {
    try {
      await waitFor(para, r => new RegExp(`Your referral ${r} was accepted`).test(document.getElementById('commandActivityFeed')?.textContent || ''), ctx.requestId, 8000);
      const toast = await toastText(para);
      assert(toast.includes(ctx.requestId) && /accepted/.test(toast), `no acceptance toast: "${toast}"`);
    } finally {
      pageRules.get(para).splice(pageRules.get(para).indexOf(ctx.caseReads.rule), 1);
      ctx.caseReads.release();
    }
    await waitFor(para, () => document.getElementById('referralAcceptedLine'), null, 12000);
    const line = await text(para, '#referralAcceptedLine');
    assert(line.includes(ctx.autoAmbulance), `accepted line lacks ambulance: ${line}`);
  });

  await step('9. Paramedic dispatches their own unit (the only one they see) to the case: dispatch, in transit, ETA', async () => {
    const own = paramedicAcct.ambulance_id;
    const adminToken = await apiLogin(adminAcct);
    const card = id => `.hospital-card[data-ambulance-id="${id}"]`;
    // Set-up through the API as admin: release the auto-dispatched unit (the case then needs transport) and make sure
    // the paramedic's own unit is free.
    for (const id of new Set([ctx.autoAmbulance, own])) {
      const r = await api(adminToken, `/ambulances/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'AVAILABLE' }) });
      assert(r.status === 200, `admin could not release ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert((await api(ctx.paraToken, `/emergencies/${ctx.requestId}`)).body.request.transport_required === true, 'case does not report transport_required after release');
    await openTab(para, 'tab-ambulance');
    await para.click('#refreshWorkspaceBtn');
    await waitFor(para, ([s, rid]) => [...document.querySelectorAll(`${s} select option`)].some(o => o.value === rid), [card(own), ctx.requestId]);
    const units = await para.$$eval('#ambulanceFleetGrid [data-ambulance-id]', cs => cs.map(c => c.dataset.ambulanceId));
    assert(units.length === 1 && units[0] === own, `paramedic fleet shows ${units.join(', ')} (expected only ${own})`);
    await para.select(`${card(own)} select`, ctx.requestId);
    await para.$eval(`${card(own)} .btn-dispatch`, b => b.click());
    await waitFor(para, s => /DISPATCHED/i.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card(own));
    await para.type(`${card(own)} input[type=number]`, '7');
    await para.$eval(`${card(own)} .btn-in-transit`, b => b.click());
    await waitFor(para, s => /IN TRANSIT/i.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card(own));
    const amb = (await api(ctx.paraToken, '/ambulances')).body.ambulances.find(a => a.ambulance_id === own);
    assert(amb.status === 'IN_TRANSIT' && amb.assigned_request_id === ctx.requestId && amb.eta_mins === 7, `server unit state ${JSON.stringify({ s: amb.status, r: amb.assigned_request_id, e: amb.eta_mins })}`);
    ctx.unit = own;
    assert(await para.$eval('#nav-doctors', n => n.hidden), 'specialist roster tab offered to a paramedic (the server gives them none)');
    await shot(para, '07-fleet-dispatch');
  });

  await step('10. Case tracker reflects allocation, transport and audit trail', async () => {
    await openTab(para, 'tab-ingestion');
    await para.click(`#emergencyQueueTableBody tr[data-request-id="${ctx.requestId}"]`);
    await waitFor(para, () => document.querySelector('#lifecycleTracker .state-step.active')?.dataset.state === 'ALLOCATED');
    await waitFor(para, u => (document.getElementById('caseAmbulance')?.textContent || '').includes(u) && /In transit/i.test(document.getElementById('caseAmbulance').textContent), ctx.unit);
    const audit = await text(para, '#caseAuditTable');
    for (const ev of ['Request Created', 'Allocation Committed', 'Ambulance Status Changed']) assert(new RegExp(ev, 'i').test(audit), `audit trail lacks ${ev}`);
    assert((await para.$$('#caseAllocations tbody tr')).length > 0, 'no committed allocation rows');
    await para.$eval('#caseTrackerPanel', n => n.scrollIntoView());
    await shot(para, '08-case-tracker');
  });

  if (process.env.E2E_EXPIRY === '1') {
    await step('10b. Unanswered referral expires: desk card closes, paramedic is told, server fails over', async () => {
      await openTab(para, 'tab-ingestion');
      await fillIntake(para, { name: 'Expiry Test', age: 61, lat: 30.3250, lng: 78.0350 });
      await para.click('#intakeSubmitBtn');
      await waitFor(para, prev => { const r = document.querySelector('#emergencyQueueTableBody tr[aria-selected="true"]'); return r && r.dataset.requestId !== prev; }, ctx.requestId);
      const rid = await para.$eval('#emergencyQueueTableBody tr[aria-selected="true"]', r => r.dataset.requestId);
      await waitFor(para, () => document.getElementById('btnFindHospitals'));
      await para.click('#btnFindHospitals');
      const btn = `#rankingResultsContainer .hospital-card[data-hospital-id="${ctx.hospitalId}"] .btn-init-referral:not([disabled])`;
      await waitFor(para, b => document.querySelector(b), btn);
      await para.click(btn);
      await waitFor(para, () => document.getElementById('referralPendingLine'));
      const acc = (await api(ctx.paraToken, `/emergencies/${rid}`)).body.acceptances.find(a => a.status === 'PENDING');
      const card = `.referral-card[data-acceptance-id="${acc.acceptance_id}"]`;
      await waitFor(desk, c => document.querySelector(c), card);
      // From now until the card is removed, record (synchronously, on every DOM change) whether it ever showed
      // "Expired" with all its buttons disabled. The UI paints that as soon as its own clock or the server's
      // referral:expired says so, before the reload that removes the card; nothing here depends on sampling timing.
      await desk.evaluate(c => {
        window.__expiry = { painted: false, removed: false };
        const check = () => {
          const node = document.querySelector(c);
          if (!node) { window.__expiry.removed = true; return; }
          const cd = node.querySelector('.countdown');
          if (cd?.textContent === 'Expired' && [...node.querySelectorAll('button')].every(b => b.disabled)) window.__expiry.painted = true;
        };
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      }, card);
      await waitFor(desk, () => window.__expiry.removed, null, 130000); // the server's hold is 90 s
      const seen = await desk.evaluate(() => window.__expiry);
      assert(seen.painted, 'the card was removed without ever showing "Expired" with its buttons disabled');
      await waitFor(para, r => new RegExp(`${r}.*did not answer in time`).test(document.getElementById('commandActivityFeed')?.textContent || ''), rid, 20000);
      const detail = (await api(ctx.paraToken, `/emergencies/${rid}`)).body;
      assert(detail.acceptances.find(a => a.acceptance_id === acc.acceptance_id)?.status === 'EXPIRED', 'server did not mark the referral EXPIRED');
      await waitFor(para, a => /Expired/i.test(document.querySelector('#caseTrackerBody')?.textContent || '') || document.getElementById('referralPendingLine'), acc.acceptance_id, 15000);
    });
  }

  const admin = await newPage('admin');

  await step('11. Admin: KPIs from /analytics/dashboard, audit history for the case, chain verification', async () => {
    await login(admin, adminAcct);
    ctx.adminToken = await admin.evaluate(() => sessionStorage.getItem('eris.session.token'));
    const dash = (await api(ctx.adminToken, '/analytics/dashboard')).body.dashboard.kpis;
    await waitFor(admin, v => document.getElementById('kpiActiveEmergencies').textContent === String(v), dash.active_emergencies);
    const icu = await text(admin, '#kpiIcuAvailable');
    assert(icu === String(dash.icu_available), `ICU KPI ${icu} vs server ${dash.icu_available}`);
    await waitFor(admin, () => /^\d+$/.test(document.getElementById('kpiReferralsAccepted').textContent));
    await shot(admin, '09-command-center');
    await openTab(admin, 'tab-activity');
    await waitFor(admin, rid => document.querySelector(`#auditLedgerTableBody tr[data-request-id="${rid}"]`), ctx.requestId);
    await admin.click('#btnVerifyAuditChain');
    await waitFor(admin, () => document.getElementById('auditVerifyStatus'));
    const verdict = await text(admin, '#auditVerifyStatus');
    assert(/Chain intact/.test(verdict), `verification: ${verdict}`);
    await shot(admin, '10-audit-verified');
    await captureBlobs(admin);
    await admin.click('#btnExportAuditLedgerCsv');
    await waitFor(admin, () => window.__blobs.length > 0);
    const csv = await admin.evaluate(() => window.__blobs.at(-1));
    assert(csv.startsWith('"history_id","chain_seq"') && csv.includes(ctx.requestId), 'audit CSV lacks the case');
  });

  await step('12. Admin: My registered patients shows the admin\'s own case, averages below the minimum as insufficient data, a guarded CSV; map uses real coordinates', async () => {
    // The admin registers a case (its name looks like a spreadsheet formula: the CSV must neutralise it).
    const name = '=HYPERLINK("x")';
    const created = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: JSON.stringify({ patient_name: name, age: 70, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 30.3400, pickup_lng: 78.0500 }) });
    assert(created.status === 201, `admin case not created: ${created.status}`);
    const rid = created.body.request_id;
    await openTab(admin, 'tab-analytics');
    await admin.click('#refreshWorkspaceBtn');
    await waitFor(admin, r => document.querySelector(`#registrationsTable tr[data-request-id="${r}"]`), rid);
    const row = await admin.$eval(`#registrationsTable tr[data-request-id="${rid}"]`, r => ({ name: r.querySelector('.patient-name').textContent, minutes: [...r.querySelectorAll('.cell-minutes')].map(c => c.textContent) }));
    assert(row.name === name && row.minutes.every(m => m === 'Not yet'), `registration row: ${JSON.stringify(row)}`);
    const server = (await api(ctx.adminToken, '/analytics/my-registrations?days=28')).body;
    const summary = await text(admin, '#registrationsSummary');
    assert(summary.includes(`${server.summary.count} case`) && new RegExp(`Insufficient data \\(${server.summary.sample_size.acceptance} of ${server.summary.minimum_sample}\\)`).test(summary), `summary: ${summary}`);
    await shot(admin, '11-my-registrations');
    await admin.click('#btnExportRegistrationsCsv');
    await waitFor(admin, () => window.__blobs.length > 1);
    const csv = await admin.evaluate(() => window.__blobs.at(-1));
    assert(csv.startsWith('"request_id","patient_name"') && csv.includes(rid) && csv.includes(`"'=HYPERLINK(""x"")"`) && /insufficient_data \(\d+ of \d+\)/.test(csv), 'registrations CSV lacks the case, the formula guard or the insufficient_data marker');
    await openTab(admin, 'tab-map');
    const hasLeaflet = await admin.evaluate(() => typeof window.L !== 'undefined');
    assert(hasLeaflet, 'Leaflet did not load (SRI/CSP?)');
    await waitFor(admin, () => document.querySelectorAll('#leafletMapContainer path.leaflet-interactive').length >= 6);
    const markers = await admin.$$eval('#leafletMapContainer path.leaflet-interactive', p => p.length);
    const hospitalsCount = (await api(ctx.adminToken, '/hospitals')).body.count;
    const ambCount = (await api(ctx.adminToken, '/ambulances')).body.ambulances.filter(a => a.current_lat != null).length;
    assert(markers >= hospitalsCount + ambCount, `map markers ${markers} < hospitals ${hospitalsCount} + ambulances ${ambCount}`);
    await waitFor(admin, () => document.querySelectorAll('#leafletMapContainer path.map-incident').length > 0);
    const pop = await admin.evaluate(async rid => {
      for (const p of document.querySelectorAll('#leafletMapContainer path.map-incident')) {
        const b = p.getBoundingClientRect();
        p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }));
        await new Promise(r => setTimeout(r, 60));
        const c = document.querySelector('#leafletMapContainer .leaflet-popup-content');
        if (c && c.textContent.includes(rid)) return { text: c.textContent, imgs: c.querySelectorAll('img').length };
      }
      return null;
    }, ctx.requestId);
    assert(pop, `no incident popup for ${ctx.requestId}`);
    assert(pop.text.includes(XSS_NAME) && pop.imgs === 0, `map popup rendered "${pop.text}" with ${pop.imgs} img`);
    await shot(admin, '12-map');
  });

  await step('13. Reload keeps the session, validated with /auth/me before any data call', async () => {
    const calls = [];
    const record = r => { if (r.url().startsWith(`${ORIGIN}/api/v1/`)) calls.push(new URL(r.url()).pathname); };
    para.on('request', record);
    try {
      await para.reload({ waitUntil: 'networkidle2' });
      await waitFor(para, () => !document.body.classList.contains('booting'));
      assert(!(await isSignedOut(para)), 'signed out after reload');
      assert(/\(Fleet\)/.test(await text(para, '#userRoleTitle')), 'role badge lost after reload');
      await waitFor(para, () => document.querySelectorAll('#emergencyQueueTableBody tr[data-request-id]').length > 0);
    } finally {
      para.off('request', record);
    }
    assert(calls.includes('/api/v1/auth/me'), `/auth/me was not requested on reload (API calls: ${calls.slice(0, 5).join(', ')})`);
    assert(calls[0] === '/api/v1/auth/me', `first API call after reload was ${calls[0]}, not /auth/me`);
  });

  await step('13b. A failing GET shows an error with Retry (never an empty list); Retry recovers', async () => {
    allowedConsole.push({ step: currentStep, re: /status of 500/ });
    const failing = { match: r => r.url() === `${ORIGIN}/api/v1/ambulances` && r.method() === 'GET',
      action: r => r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated fleet outage' }) }) };
    pageRules.get(para).push(failing);
    try {
      await para.reload({ waitUntil: 'networkidle2' });
      await waitFor(para, () => !document.body.classList.contains('booting') && !document.body.classList.contains('signed-out'));
      await waitFor(para, () => document.querySelector('#ambulanceFleetGrid .state-msg.is-error'));
      const err = await para.$eval('#ambulanceFleetGrid', n => ({ text: n.textContent, retry: [...n.querySelectorAll('button')].some(b => b.textContent === 'Retry'), cards: n.querySelectorAll('[data-ambulance-id]').length }));
      assert(/Could not load/.test(err.text) && /Simulated fleet outage/.test(err.text) && err.retry && err.cards === 0, `fleet error state: ${JSON.stringify(err)}`);
      assert(!(await para.$eval('#dataSourceBanner', n => n.hidden)), 'data banner not shown for the failed load');
      assert(/ambulances/.test(await text(para, '#dataBannerText')), 'data banner does not name the failed resource');
    } finally {
      pageRules.get(para).splice(pageRules.get(para).indexOf(failing), 1);
    }
    await para.$eval('#ambulanceFleetGrid', n => [...n.querySelectorAll('button')].find(b => b.textContent === 'Retry').click());
    await waitFor(para, () => document.querySelectorAll('#ambulanceFleetGrid [data-ambulance-id]').length > 0);
    await waitFor(para, () => document.getElementById('dataSourceBanner').hidden);
  });

  await step('14. Logout clears token, socket and data', async () => {
    await para.click('#logoutBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    assert(await para.evaluate(() => sessionStorage.getItem('eris.session.token')) === null, 'token still stored');
    assert((await para.$$('#emergencyQueueTableBody tr')).length === 0, 'queue rows remain after logout');
    assert(await text(para, '#kpiActiveEmergencies') === '—', 'KPI value remains after logout');
    assert(await toastText(para) === '', `notification banner still visible after logout: ${await toastText(para)}`);
    await para.reload({ waitUntil: 'networkidle2' });
    await waitFor(para, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await shot(para, '13-after-logout');
  });

  await step('15a. A 401 mid-session returns to the sign-in portal', async () => {
    allowedConsole.push({ step: currentStep, re: /status of 401/ });
    await login(para, paramedicAcct);
    pageRules.get(para).push({ once: true, match: r => r.url().startsWith(`${ORIGIN}/api/v1/hospitals`) && r.method() === 'GET',
      action: r => r.respond({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Token invalid or expired. Please re-authenticate.' }) }) });
    await para.click('#refreshWorkspaceBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    const notice = await text(para, '#authNotice');
    assert(/expired or is no longer valid/.test(notice), `notice: ${notice}`);
    assert(await para.evaluate(() => sessionStorage.getItem('eris.session.token')) === null, 'token kept after 401');
  });

  await step('15b. A stored token the server rejects is not used after reload', async () => {
    allowedConsole.push({ step: currentStep, re: /status of 401/ });
    const forged = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify({ role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'invalidsignature'].join('.');
    await para.evaluate(t => sessionStorage.setItem('eris.session.token', t), forged);
    await para.reload({ waitUntil: 'networkidle2' });
    await waitFor(para, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    assert(/no longer valid/.test(await text(para, '#authNotice')), 'no invalid-session notice');
    assert((await para.$$('#emergencyQueueTableBody tr')).length === 0, 'data rendered for a forged token');
  });

  await step('16. Network failure on intake shows an error and creates nothing; retry is idempotent', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED|ERR_INTERNET_DISCONNECTED/ });
    await login(para, paramedicAcct);
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
    await para.select('#emergencyStatusFilter', 'ALL');
    await waitFor(para, () => document.querySelectorAll('#emergencyQueueTableBody tr[data-request-id]').length > 0);
    const before = (await api(ctx.paraToken, '/emergencies')).body.count;
    const rowsBefore = (await queueRowIds(para)).length;
    pageRules.get(para).push({ once: true, match: r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST', action: r => r.abort('failed') });
    await fillIntake(para, { name: 'Network Failure Test', age: 33 });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => !document.getElementById('intakeError').hidden);
    const err = await text(para, '#intakeError');
    assert(/Outcome unknown/.test(err) && !/Nothing was saved/.test(err), `error text: ${err}`);
    assert((await api(ctx.paraToken, '/emergencies')).body.count === before, 'server created a case on a failed request');
    assert((await queueRowIds(para)).length === rowsBefore, 'a local case appeared in the queue');
    await shot(para, '14-network-error');
    await para.click('#intakeSubmitBtn'); // same form content: same Idempotency-Key
    await waitFor(para, () => document.getElementById('intakeError').hidden);
    await waitFor(para, n => document.querySelectorAll('#emergencyQueueTableBody tr[data-request-id]').length === n, rowsBefore + 1);
    assert((await api(ctx.paraToken, '/emergencies')).body.count === before + 1, 'retry did not create exactly one case');
  });

  await step('16b. Intake answer lost after the server registered the case; an edited resubmit does not register it twice', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED|status of 422/ });
    const before = (await api(ctx.paraToken, '/emergencies')).body.count;
    forwarded.length = 0;
    pageRules.get(para).push({ once: true, match: r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST', action: forwardThenDrop });
    await fillIntake(para, { name: 'Lost Answer Test', age: 44, lat: 30.3300, lng: 78.0400 });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => !document.getElementById('intakeError').hidden);
    const first = await text(para, '#intakeError');
    assert(/Outcome unknown/.test(first) && !/Nothing was saved/.test(first), `error after a lost answer: ${first}`);
    assert(forwarded.length === 1 && forwarded[0].status === 201, `the POST did not reach the server: ${JSON.stringify(forwarded)}`);
    assert((await api(ctx.paraToken, '/emergencies')).body.count === before + 1, 'the forwarded POST did not create the case');
    // The user edits the form, then submits again.
    await para.$eval('#patientAge', n => { n.value = ''; });
    await para.type('#patientAge', '45');
    await para.click('#intakeSubmitBtn');
    await waitFor(para, prev => {
      const e = document.getElementById('intakeError');
      const toast = document.getElementById('globalNotificationBanner');
      return (!e.hidden && e.textContent !== prev) || (!toast.hidden && /Registered|already registered/.test(toast.textContent));
    }, first);
    const after = (await api(ctx.paraToken, '/emergencies')).body;
    const named = after.queue.filter(q => q.patient.full_name === 'Lost Answer Test').length;
    assert(after.count === before + 1 && named === 1, `server has ${after.count - before} new case(s), ${named} named "Lost Answer Test" (expected exactly 1)`);
    const second = await para.$eval('#intakeError', n => (n.hidden ? '' : n.textContent));
    assert(/^Your edits were not saved: an earlier attempt may already have registered this case/.test(second) && /check the queue/i.test(second), `error after the edited resubmit (expected the 422 answer): "${second}"`);
  });

  await step('16c. A referral initiated before logout leaks nothing into the next user\'s session', async () => {
    const otherPara = ACCOUNTS.filter(a => a.role === 'PARAMEDIC')[1];
    assert(otherPara, 'a second paramedic account is needed');
    const rid = await createCaseViaApi(ctx.paraToken, 'Cross Session Patient');
    await para.select('#emergencyStatusFilter', 'ALL');
    await para.click('#refreshWorkspaceBtn'); // the API-created case reaches the queue now, not at the next KPI broadcast
    await waitFor(para, r => document.querySelector(`#emergencyQueueTableBody tr[data-request-id="${r}"]`), rid);
    await para.$eval(`#emergencyQueueTableBody tr[data-request-id="${rid}"]`, r => r.click());
    await waitFor(para, () => document.getElementById('btnFindHospitals'));
    await para.$eval('#btnFindHospitals', b => b.click());
    const btn = '#rankingResultsContainer .btn-init-referral:not([disabled])';
    await waitFor(para, b => document.querySelector(b), btn);
    const hold = holdRule(r => r.url() === `${ORIGIN}/api/v1/referrals/initiate` && r.method() === 'POST');
    pageRules.get(para).push(hold.rule);
    await para.$eval(btn, b => b.click());
    await hold.held;
    await para.click('#logoutBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    await loginInPlace(para, otherPara);
    const caseCalls = [];
    const record = r => { if (r.url().includes(`/api/v1/emergencies/${rid}`)) caseCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    para.on('request', record);
    let status;
    try {
      const answered = para.waitForResponse(r => r.url() === `${ORIGIN}/api/v1/referrals/initiate`, { timeout: 10000 });
      hold.release();
      status = (await answered).status();
      const until = Date.now() + 5500; // longer than one 4 s referral poll
      while (Date.now() < until) {
        const toast = await toastText(para);
        assert(!toast.includes(rid) && !/Referral sent/.test(toast), `the next user saw the previous user's toast: "${toast}"`);
        await new Promise(r => setTimeout(r, 250));
      }
    } finally {
      para.off('request', record);
    }
    assert(status === 201, `the held initiate was answered ${status}; the test needs it to succeed`);
    const feed = await para.$eval('#commandActivityFeed', n => n.textContent);
    assert(!feed.includes(rid) && !/You referred/.test(feed), `the next user's activity feed has the previous user's referral: ${feed.slice(0, 160)}`);
    assert(caseCalls.length === 0, `the next user's session requested the previous user's case (tracked/loaded): ${caseCalls.join(', ')}`);
    assert(/\(Fleet\)/.test(await text(para, '#userRoleTitle')), 'second user not signed in');
  });

  await step('16d. Logout hides the notification banner at once', async () => {
    await para.click('#logoutBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    await loginInPlace(para, paramedicAcct);
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
    assert(/Signed in as/.test(await toastText(para)), 'no sign-in toast to test with');
    await para.click('#logoutBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    assert(await toastText(para) === '', `banner still visible after logout: ${await toastText(para)}`);
    await new Promise(r => setTimeout(r, 300));
    assert(await toastText(para) === '', 'banner reappeared after logout');
  });

  await step('16e. Desk accept commits but its answer is lost: the UI checks and ends with the real ALLOCATED result', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED/ });
    // An ICU bed is requested so the accept commits an allocation: the server replays only an accept that holds one.
    const rid = await createCaseViaApi(ctx.paraToken, 'Lost Accept Patient', { required_resources: ['ICU_BED'] });
    const init = await api(ctx.paraToken, '/referrals/initiate', { method: 'POST', body: JSON.stringify({ request_id: rid, hospital_id: ctx.hospitalId }) });
    assert(init.status === 201, `initiate for the lost-accept case failed: ${init.status} ${JSON.stringify(init.body)}`);
    const aid = init.body.acceptance_id;
    const card = `.referral-card[data-acceptance-id="${aid}"]`;
    await openTab(desk, 'tab-acceptance');
    await waitFor(desk, c => document.querySelector(`${c} .btn-accept:not([disabled])`), card);
    forwarded.length = 0;
    const acceptUrl = `${ORIGIN}/api/v1/referrals/${aid}/accept`;
    const retry = holdRule(r => r.url() === acceptUrl && r.method() === 'POST');
    pageRules.get(desk).push({ once: true, match: r => r.url() === acceptUrl && r.method() === 'POST', action: forwardThenDrop }, retry.rule);
    await desk.$eval(`${card} .btn-accept`, b => b.click()); // in-page: a live re-render cannot detach it mid-click
    await waitFor(desk, r => /outcome unknown/i.test(document.querySelector(`#acceptanceResult .decision-unknown[data-request-id="${r}"]`)?.textContent || ''), rid);
    assert(forwarded.length === 1 && forwarded[0].status === 200, `the accept did not reach the server: ${JSON.stringify(forwarded.map(f => f.status))}`);
    assert((await api(ctx.paraToken, `/emergencies/${rid}`)).body.request.status === 'ALLOCATED', 'server did not commit the forwarded accept');
    assert(!(await desk.$(`#acceptanceResult .decision-failed[data-request-id="${rid}"]`)), 'a lost answer was shown as a failure');
    await Promise.race([retry.held, new Promise((_, rej) => setTimeout(() => rej(new Error('the UI never re-checked the outcome')), 10000))]);
    retry.release();
    const sel = `#acceptanceResult .allocation-result[data-request-id="${rid}"]`;
    await waitFor(desk, s => document.querySelector(s), sel);
    const detail = (await api(ctx.paraToken, `/emergencies/${rid}`)).body;
    assert(detail.request.status === 'ALLOCATED', `server status ${detail.request.status}`);
    const shownAmb = await desk.$eval(sel, n => n.dataset.ambulanceId);
    assert(shownAmb === (detail.request.assigned_ambulance_id || ''), `UI ambulance "${shownAmb}" vs server "${detail.request.assigned_ambulance_id}"`);
    assert(!(await desk.$(`#acceptanceResult .decision-unknown[data-request-id="${rid}"]`)), 'outcome still shown as unknown');
    assert(!(await desk.$(`#acceptanceResult .decision-failed[data-request-id="${rid}"]`)), 'the committed accept is shown as failed');
    assert(!/failed/i.test(await toastText(desk)), `toast reports a failure: ${await toastText(desk)}`);
  });

  await step('16f. Intake answer lost, retry answered 429, edited resubmit: still exactly one case, never "Not registered"', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED|status of 429|status of 422/ });
    await loginInPlace(para, paramedicAcct);
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
    const name = 'Rate Limited Retry Test';
    const before = (await api(ctx.paraToken, '/emergencies')).body.count;
    forwarded.length = 0;
    const isCreate = r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST';
    pageRules.get(para).push({ once: true, match: isCreate, action: forwardThenDrop });
    await fillIntake(para, { name, age: 52, lat: 30.3310, lng: 78.0410 });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => /Outcome unknown/.test(document.getElementById('intakeError').textContent) && !document.getElementById('intakeError').hidden);
    assert(forwarded.length === 1 && forwarded[0].status === 201, `the POST did not reach the server: ${JSON.stringify(forwarded.map(f => f.status))}`);
    // The retry is answered by the /api rate limiter.
    pageRules.get(para).push({ once: true, match: isCreate,
      action: r => r.respond({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests, please try again later.' }) }) });
    await para.$eval('#intakeError', n => { n.textContent = ''; });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => { const e = document.getElementById('intakeError'); return !e.hidden && e.textContent !== ''; });
    const after429 = await text(para, '#intakeError');
    assert(/Outcome unknown/.test(after429) && !/Not registered/.test(after429), `error after a 429: ${after429}`);
    // The user edits the age and submits again.
    await para.$eval('#patientAge', n => { n.value = ''; });
    await para.type('#patientAge', '53');
    await para.$eval('#intakeError', n => { n.textContent = ''; });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => {
      const e = document.getElementById('intakeError'); const t = document.getElementById('globalNotificationBanner');
      return (!e.hidden && e.textContent !== '') || (!t.hidden && /Registered|already registered/.test(t.textContent));
    });
    const after = (await api(ctx.paraToken, '/emergencies')).body;
    const named = after.queue.filter(q => q.patient.full_name === name).length;
    assert(after.count === before + 1 && named === 1, `server has ${after.count - before} new case(s), ${named} named "${name}" (expected exactly 1)`);
    const last = await para.$eval('#intakeError', n => (n.hidden ? '' : n.textContent));
    assert(/^Your edits were not saved: an earlier attempt may already have registered this case/.test(last) && !/Not registered/.test(last), `error after the edited resubmit (expected the 422 answer): "${last}"`);
  });

  await step('16g. Logout while an intake outcome is unknown warns on the sign-in screen and after re-login', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED/ });
    pageRules.get(para).push({ once: true, match: r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST', action: r => r.abort('failed') });
    await fillIntake(para, { name: 'Unknown At Logout', age: 30 });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => /Outcome unknown/.test(document.getElementById('intakeError').textContent) && !document.getElementById('intakeError').hidden);
    await para.click('#logoutBtn');
    await waitFor(para, () => document.body.classList.contains('signed-out'));
    const notice = await text(para, '#authNotice');
    assert(/may already have been saved/.test(notice) && /check the queue/.test(notice), `sign-in notice: "${notice}"`);
    await loginInPlace(para, paramedicAcct);
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
    const shown = await para.$eval('#intakeError', n => (n.hidden ? '' : n.textContent));
    assert(/may already have been saved/.test(shown), `no warning after re-login: "${shown}"`);
  });

  await step('16h. An accept held open across logout leaks nothing into the next desk\'s session', async () => {
    const otherDesk = ACCOUNTS.find(a => a.role === 'HOSPITAL_DESK' && a.hospital_id !== ctx.hospitalId);
    assert(otherDesk, 'a desk of another hospital is needed');
    const rid = await createCaseViaApi(ctx.paraToken, 'Held Accept Patient');
    const init = await api(ctx.paraToken, '/referrals/initiate', { method: 'POST', body: JSON.stringify({ request_id: rid, hospital_id: ctx.hospitalId }) });
    assert(init.status === 201, `initiate failed: ${init.status} ${JSON.stringify(init.body)}`);
    const aid = init.body.acceptance_id;
    const card = `.referral-card[data-acceptance-id="${aid}"]`;
    await openTab(desk, 'tab-acceptance');
    await desk.click('#refreshWorkspaceBtn');
    await waitFor(desk, c => document.querySelector(`${c} .btn-accept:not([disabled])`), card);
    const acceptUrl = `${ORIGIN}/api/v1/referrals/${aid}/accept`;
    const hold = holdRule(r => r.url() === acceptUrl && r.method() === 'POST');
    pageRules.get(desk).push(hold.rule);
    await desk.$eval(`${card} .btn-accept`, b => b.click());
    await hold.held;
    await desk.click('#logoutBtn');
    await waitFor(desk, () => document.body.classList.contains('signed-out'));
    await loginInPlace(desk, otherDesk);
    const caseCalls = [];
    const record = r => { if (r.url().includes(`/api/v1/emergencies/${rid}`)) caseCalls.push(new URL(r.url()).pathname); };
    desk.on('request', record);
    let status;
    try {
      const answered = desk.waitForResponse(r => r.url() === acceptUrl, { timeout: 10000 });
      hold.release();
      status = (await answered).status();
      const until = Date.now() + 2500;
      while (Date.now() < until) {
        const toast = await toastText(desk);
        assert(!toast.includes(rid) && !/Accepted|failed|unknown/i.test(toast), `the next desk saw the previous desk's toast: "${toast}"`);
        await new Promise(r => setTimeout(r, 200));
      }
    } finally {
      desk.off('request', record);
    }
    assert(status === 200, `the held accept was answered ${status}; the test needs it to commit`);
    const decisions = await desk.$eval('#acceptanceResult', n => n.textContent);
    assert(!decisions.includes(rid), `the next desk's decision list has the previous desk's accept: ${decisions.slice(0, 160)}`);
    assert(caseCalls.length === 0, `the next desk's session requested the previous desk's case: ${caseCalls.join(', ')}`);
    await desk.click('#logoutBtn');
    await waitFor(desk, () => document.body.classList.contains('signed-out'));
    await loginInPlace(desk, deskAcct);
  });

  await step('16i. Audit verification held open across logout leaks nothing into the next session', async () => {
    await openTab(admin, 'tab-activity');
    const hold = holdRule(r => r.url() === `${ORIGIN}/api/v1/audit/verify` && r.method() === 'GET');
    pageRules.get(admin).push(hold.rule);
    await admin.click('#btnVerifyAuditChain');
    await hold.held;
    await admin.click('#logoutBtn');
    await waitFor(admin, () => document.body.classList.contains('signed-out'));
    await loginInPlace(admin, ACCOUNTS.filter(a => a.role === 'PARAMEDIC')[1]);
    const answered = admin.waitForResponse(r => r.url() === `${ORIGIN}/api/v1/audit/verify`, { timeout: 10000 });
    hold.release();
    assert((await answered).status() === 200, 'the held verification failed');
    await new Promise(r => setTimeout(r, 500));
    const leaked = await admin.$eval('#auditVerifyResult', n => n.textContent.trim());
    assert(leaked === '', `the next user's page shows the previous admin's verification: "${leaked.slice(0, 120)}"`);
  });

  await step('16j. Sign-in never moves the cursor while the user types (3 logout/login cycles)', async () => {
    for (let i = 0; i < 3; i++) {
      // Sign out and put the cursor in the password field in the same task, as a fast user would; then let every
      // deferred focus run. The portal must leave the cursor where the user put it.
      const active = await para.evaluate(async () => {
        document.getElementById('logoutBtn').click();
        document.getElementById('loginPassword').focus();
        await new Promise(r => setTimeout(r, 120));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return document.activeElement?.id;
      });
      assert(active === 'loginPassword', `cycle ${i + 1}: focus moved to "${active}" while the user was in the password field`);
      await para.focus('#loginUsername');
      await loginInPlace(para, paramedicAcct);
    }
    ctx.paraToken = await para.evaluate(() => sessionStorage.getItem('eris.session.token'));
  });

  await step('16k. A 400 after a lost answer keeps the earlier-registration warning and the key; resubmit makes no duplicate', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED|status of 400|status of 422/ });
    const name = 'Refused After Lost Answer';
    const before = (await api(ctx.paraToken, '/emergencies')).body.count;
    forwarded.length = 0;
    const isCreate = r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST';
    pageRules.get(para).push({ once: true, match: isCreate, action: forwardThenDrop });
    await openTab(para, 'tab-ingestion');
    await fillIntake(para, { name, age: 61, lat: 30.3320, lng: 78.0430 });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => /Outcome unknown/.test(document.getElementById('intakeError').textContent) && !document.getElementById('intakeError').hidden);
    assert(forwarded.length === 1 && forwarded[0].status === 201, `the POST did not reach the server: ${JSON.stringify(forwarded.map(f => f.status))}`);
    pageRules.get(para).push({ once: true, match: isCreate,
      action: r => r.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'age must be an integer from 0 to 130.' }) }) });
    await para.$eval('#intakeError', n => { n.textContent = ''; });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => { const e = document.getElementById('intakeError'); return !e.hidden && e.textContent !== ''; });
    const after400 = await text(para, '#intakeError');
    assert(/earlier attempt may already have registered this case/.test(after400) && !/^Not registered/.test(after400), `error after a 400: ${after400}`);
    await para.$eval('#patientAge', n => { n.value = ''; });
    await para.type('#patientAge', '62');
    await para.$eval('#intakeError', n => { n.textContent = ''; });
    await para.click('#intakeSubmitBtn');
    await waitFor(para, () => {
      const e = document.getElementById('intakeError'); const t = document.getElementById('globalNotificationBanner');
      return (!e.hidden && e.textContent !== '') || (!t.hidden && /Registered|already registered/.test(t.textContent));
    });
    const after = (await api(ctx.paraToken, '/emergencies')).body;
    const named = after.queue.filter(q => q.patient.full_name === name).length;
    assert(after.count === before + 1 && named === 1, `server has ${after.count - before} new case(s), ${named} named "${name}" (expected exactly 1)`);
  });

  await step('16l. Desk rejects a referral: the decision shows, the card closes, and nothing reads the case it no longer sees', async () => {
    const rid = await createCaseViaApi(ctx.paraToken, 'Rejected Referral Patient');
    const init = await api(ctx.paraToken, '/referrals/initiate', { method: 'POST', body: JSON.stringify({ request_id: rid, hospital_id: ctx.hospitalId }) });
    assert(init.status === 201, `initiate failed: ${init.status} ${JSON.stringify(init.body)}`);
    const card = `.referral-card[data-acceptance-id="${init.body.acceptance_id}"]`;
    await openTab(desk, 'tab-acceptance');
    await desk.click('#refreshWorkspaceBtn');
    await waitFor(desk, c => document.querySelector(`${c} .btn-reject:not([disabled])`) && document.querySelector(`${c} .patient-name`), card);
    await desk.type(`${card} input.form-input`, 'No ICU bed free (e2e)');
    const reads = [];
    const record = r => { if (r.url().includes(`/api/v1/emergencies/${rid}`)) reads.push(r.url()); };
    desk.on('request', record);
    try {
      await desk.$eval(`${card} .btn-reject`, b => b.click());
      await waitFor(desk, r => [...document.querySelectorAll('#acceptanceResult .status-line')].some(n => n.textContent.includes(`Rejected ${r}`)), rid);
      await waitFor(desk, c => !document.querySelector(c), card);
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      desk.off('request', record);
    }
    const detail = (await api(ctx.paraToken, `/emergencies/${rid}`)).body;
    assert(detail.acceptances.find(a => a.acceptance_id === init.body.acceptance_id)?.status === 'REJECTED', 'server did not record the rejection');
    assert(reads.length === 0, `the desk read a case it no longer sees: ${reads.join(', ')}`);
  });

  await step('17. No console errors, page errors, CSP violations or alert dialogs', async () => {
    for (const [label, page] of [['paramedic', para], ['desk', desk], ['admin', admin]]) {
      (await cspViolations(page)).forEach(v => issues.push(`[${label}] CSP violation: ${v}`));
    }
    assert(issues.length === 0, `${issues.length} issue(s):\n      ${issues.join('\n      ')}`);
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
  stopServer();
  proxy?.close();
  proxy?.closeAllConnections?.();
}
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed. CSP source: ${serverSendsCsp === null ? 'n/a' : serverSendsCsp ? 'server header' : 'injected by test'}.`);
process.exit(exitCode);
