// e2e/batch5/lib.mjs
// Shared harness for the Batch 5 end-to-end journeys (memory and MySQL backends).
//
// - Accounts mirror the demo accounts (server/db/demoUsers.js: same usernames, roles and links) with RANDOM per-run
//   passwords that never leave this process except as bcrypt hashes (memory: on e2e/e2e-server.mjs's stdin; MySQL:
//   an UPDATE of SystemUser.password_hash in the _test database). No password is printed.
// - MySQL: only the helper's test database (tests/helpers/mysqlTestDb.js). Its name must end in "_test"; the helper's
//   advisory lock is held for the whole session (other agents run MySQL tests concurrently).
// - Ports 4400-4430 only.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { DEMO_USERS } from '../../server/db/demoUsers.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function assert(cond, message) { if (!cond) throw new Error(message); }

export function checkPort(p, [lo, hi] = [4400, 4430]) {
  if (!(p >= lo && p <= hi)) throw new Error(`Port ${p} is outside the allowed range ${lo}-${hi}.`);
  return p;
}

// ── Accounts ────────────────────────────────────────────────────────────────
export const ACCOUNTS = DEMO_USERS.map(u => ({
  username: u.username, password: randomBytes(18).toString('base64url'), role: u.role, hospital_id: u.hospital_id ?? null,
  ambulance_id: u.ambulance_id ?? null, patient_id: u.patient_id ?? null, display_name: u.display_name,
  // The Fleet logins keep the seed's demo flag: the sample tracking trip only uses a unit crewed by a demo Fleet login.
  // The other accounts are not flagged, so the rules for real accounts (e.g. the last real admin) apply as before.
  is_demo: u.role === 'PARAMEDIC' ? 1 : 0
}));
export const acct = (role, pred = () => true) => ACCOUNTS.find(a => a.role === role && pred(a));

// ── Results ─────────────────────────────────────────────────────────────────
export const results = [];
export const issues = [];
export const evidence = [];
export const allowedConsole = [];
export const state = { currentStep: 'setup', shots: null, pages: [] };
export const note = line => { evidence.push(`[${state.currentStep.split(' ')[0]}] ${line}`); };

export async function step(name, fn) {
  state.currentStep = name;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message, ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    for (const [label, page] of state.pages) {
      await page.screenshot({ path: path.join(state.shots, `fail-${name.split(' ')[0].replace(/[^\w.-]/g, '')}-${label}.png`) }).catch(() => {});
    }
  }
}

// ── Server ──────────────────────────────────────────────────────────────────
export class ServerHandle {
  constructor({ backend, port, db, portRange }) {
    this.backend = backend; this.port = checkPort(port, portRange); this.db = db; this.proc = null; this.log = '';
    this.secret = randomBytes(32).toString('hex');
  }
  get origin() { return `http://127.0.0.1:${this.port}`; }
  env(extra = {}) {
    const common = {
      PORT: String(this.port), JWT_SECRET: this.secret, NODE_ENV: 'development', LOGIN_RATE_LIMIT: '1000',
      LOGIN_IP_RATE_LIMIT: '1000', SOCKET_RECHECK_MS: '2000', TRUST_PROXY: '1', API_RATE_LIMIT: '5000',
      ROUTING_URL: 'off', // tests never call the public routing service; a run may point it at a local fake
      ...extra
    };
    if (this.backend === 'memory') {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_') && !k.startsWith('DB_') && k !== 'JWT_EXPIRES'));
      return { ...base, DB_USE_MEMORY: 'true', ...common };
    }
    const c = this.db.config;
    assert(/_test$/.test(c.database), `refusing: database "${c.database}" does not end in _test`);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'JWT_EXPIRES'));
    return { ...base, DB_USE_MEMORY: 'false', DB_HOST: c.host, DB_PORT: String(c.port), DB_NAME: c.database, DB_USER: c.user, DB_PASS: c.password ?? '', ...common };
  }
  async start(extra = {}) {
    this.log = '';
    const env = this.env(extra);
    if (this.backend === 'memory') {
      this.proc = spawn(process.execPath, ['e2e/e2e-server.mjs'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.stdin.end(JSON.stringify(ACCOUNTS));
    } else {
      this.proc = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    this.proc.stdout.on('data', d => { this.log += d; });
    this.proc.stderr.on('data', d => { this.log += d; });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${this.origin}/health`)).ok) return; } catch { /* starting */ }
      if (this.proc.exitCode !== null) throw new Error(`Server exited early (${this.proc.exitCode}):\n${this.log.slice(-1500)}`);
      await sleep(150);
    }
    throw new Error(`Server did not become healthy:\n${this.log.slice(-1500)}`);
  }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const done = new Promise(r => this.proc.once('exit', r));
    this.proc.kill('SIGTERM');
    await Promise.race([done, sleep(5000)]);
    if (this.proc.exitCode === null) { this.proc.kill('SIGKILL'); await Promise.race([done, sleep(2000)]); }
  }
}

/** MySQL: open the helper's test DB (lock held until release), verify the name, reset + seed, set per-run passwords. */
export async function openMysql() {
  process.chdir(ROOT); // the helper reads .env.local relative to the working directory
  const { openTestDatabase } = await import('../../tests/helpers/mysqlTestDb.js');
  const db = await openTestDatabase();
  if (db.skip) throw new Error(`MySQL test database unavailable: ${db.skip}`);
  assert(/_test$/.test(db.config.database), `refusing: database name does not end in _test`);
  return db;
}
export async function resetMysql(db) {
  assert(/_test$/.test(db.config.database), 'refusing reset: not a _test database');
  await db.reset(true);
  for (const a of ACCOUNTS) {
    const [r] = await db.admin.query('UPDATE SystemUser SET password_hash = ? WHERE username = ?', [bcrypt.hashSync(a.password, 10), a.username]);
    assert(r.affectedRows === 1, `demo account ${a.username} missing after the seed`);
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
const ips = new Map();
export const clientIp = key => { if (!ips.has(key)) ips.set(key, `10.78.${Math.floor(ips.size / 250)}.${(ips.size % 250) + 1}`); return ips.get(key); };
export function makeApi(server) {
  async function api(token, p, { method = 'GET', body, as, headers = {} } = {}) {
    const r = await fetch(`${server.origin}/api/v1${p}`, {
      method, headers: { 'X-Forwarded-For': clientIp(as || token || 'anonymous'), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: parsed, headers: r.headers };
  }
  async function login(a, password = a.password) {
    const r = await api(null, '/auth/login', { method: 'POST', body: { username: a.username, password }, as: a.username });
    return r.status === 200 ? r.body.token : null;
  }
  async function expectDenied(token, calls, codes = [403]) {
    const wrong = [];
    for (const [method, p, body, allowed = codes] of calls) {
      const r = await api(token, p, { method, body });
      if (!allowed.includes(r.status)) wrong.push(`${method} ${p} -> ${r.status} (expected ${allowed.join('/')})`);
    }
    assert(wrong.length === 0, `not refused:\n${wrong.join('\n')}`);
    return calls.length;
  }
  return { api, login, expectDenied };
}

// ── Browser ─────────────────────────────────────────────────────────────────
export const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export function makeBrowserKit(browser, server) {
  const ORIGIN = () => server.origin;
  async function newPage(label, { width = 1366, height = 900 } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page.__label = label;
    page.__api = [];
    page.on('request', r => { if (r.url().startsWith(`${ORIGIN()}/api/v1/`)) page.__api.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const full = `${msg.text()} ${msg.location()?.url || ''}`;
      if (allowedConsole.some(a => (a.step === '*' || a.step === state.currentStep) && a.re.test(full))) return;
      issues.push(`[${label}] [${state.currentStep}] console.error: ${full}`);
    });
    page.on('pageerror', err => issues.push(`[${label}] [${state.currentStep}] pageerror: ${err.message}`));
    page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : (issues.push(`[${label}] dialog ${d.message()}`), d.dismiss())));
    await page.setRequestInterception(true);
    const ip = clientIp(`page:${label}`);
    page.__rules = [];
    page.__tiles = []; // the Referer of each map-tile request
    page.on('request', r => {
      const rule = page.__rules.find(x => x.match(r));
      if (rule) { if (rule.once) page.__rules.splice(page.__rules.indexOf(rule), 1); return rule.action(r, ip); }
      if (/^https:\/\/tile\.openstreetmap\.org\//.test(r.url())) { page.__tiles.push(r.headers().referer ?? null); } // OSM blocks tiles with no Referer
      if (/^https:\/\/tile\.openstreetmap\.org\//.test(r.url())) return r.respond({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
      if (r.url().startsWith(ORIGIN())) return r.continue({ headers: { ...r.headers(), 'x-forwarded-for': ip } });
      return r.continue();
    });
    state.pages.push([label, page]);
    return page;
  }
  async function closePage(page) {
    const i = state.pages.findIndex(([, p]) => p === page);
    if (i >= 0) state.pages.splice(i, 1);
    await page.browserContext().close().catch(() => {});
  }
  const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
  async function waitOrExplain(page, fn, arg, timeout = 15000) {
    try { return await waitFor(page, fn, arg, timeout); } catch (err) {
      const seen = await page.evaluate(() => ({
        tab: document.querySelector('.tab-pane.active')?.id, toast: document.getElementById('globalNotificationBanner')?.textContent,
        errors: [...document.querySelectorAll('.form-error:not([hidden])')].map(n => n.textContent), signedOut: document.body.classList.contains('signed-out'),
        conn: document.getElementById('connectionStatus')?.textContent, notice: document.getElementById('authNotice')?.textContent
      })).catch(() => ({}));
      throw new Error(`${err.message.split('\n')[0]}; page ${page.__label} showed ${JSON.stringify(seen)}`);
    }
  }
  const text = (page, sel) => page.$eval(sel, n => n.textContent.trim());
  const press = (page, sel) => page.$eval(sel, b => b.click());
  async function loginUI(page, a) {
    await page.goto(ORIGIN(), { waitUntil: 'networkidle2' });
    await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await waitFor(page, () => document.activeElement?.id === 'loginUsername');
    await page.type('#loginUsername', a.username);
    await page.type('#loginPassword', a.password);
    page.__api.length = 0;
    await page.click('#loginSubmitBtn');
    await waitOrExplain(page, () => !document.body.classList.contains('signed-out'));
    await waitOrExplain(page, () => document.getElementById('connectionStatus')?.textContent === 'Live', null, 10000);
  }
  async function openTab(page, tab) {
    await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => b.click());
    await waitFor(page, t => document.getElementById(t)?.classList.contains('active'), tab);
  }
  const token = page => page.evaluate(() => sessionStorage.getItem('eris.session.token'));
  async function fillIntake(page, { name, age, lat, lng, type }) {
    await page.$eval('#emergencyIntakeForm', f => f.reset());
    await page.type('#patientName', name);
    await page.type('#patientAge', String(age));
    await page.type('#pickupLat', String(lat));
    await page.type('#pickupLng', String(lng));
    if (type) await page.select('#emergencyTypeSelect', type);
  }
  /** A raw Socket.IO client in its own page, recording every event (and its own disconnects). */
  async function socketProbe(label, tok) {
    const page = await newPage(`sock-${label}`);
    await page.goto(`${ORIGIN()}/health`);
    await page.addScriptTag({ url: `${ORIGIN()}/socket.io/socket.io.min.js` });
    const ok = await page.evaluate((origin, t) => new Promise(resolve => {
      window.__events = [];
      const s = window.io(origin, { auth: { token: t }, transports: ['websocket'], forceNew: true, reconnection: false });
      window.__sock = s;
      s.onAny((name, payload) => window.__events.push({ name, payload, at: Date.now() }));
      s.on('connect', () => resolve(true));
      s.on('disconnect', reason => window.__events.push({ name: '__disconnect', payload: reason, at: Date.now() }));
      s.on('connect_error', e => { window.__events.push({ name: '__connect_error', payload: e.message }); resolve(false); });
      setTimeout(() => resolve(false), 8000);
    }), ORIGIN(), tok);
    return {
      page, ok,
      events: () => page.evaluate(() => window.__events),
      clear: () => page.evaluate(() => { window.__events = []; }),
      emit: (name, payload) => page.evaluate((n, p) => window.__sock.emit(n, p), name, payload),
      connected: () => page.evaluate(() => window.__sock.connected),
      close: () => closePage(page)
    };
  }
  /** Rule action: deliver the request to the server from Node, then fail it in the browser (the answer is lost). */
  const forwarded = [];
  async function forwardThenDrop(req, ip) {
    const headers = { ...req.headers(), 'x-forwarded-for': ip };
    ['host', 'connection', 'content-length', 'origin', 'referer'].forEach(h => delete headers[h]);
    const r = await fetch(req.url(), { method: req.method(), headers, body: req.postData() });
    forwarded.push({ url: req.url(), status: r.status, body: await r.text() });
    return req.abort('failed');
  }
  return { newPage, closePage, waitFor, waitOrExplain, text, press, loginUI, openTab, token, fillIntake, socketProbe, forwarded, forwardThenDrop };
}

export const fmtMinutes = v => `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} min`;

export function summary(label) {
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${label}: ${passed}/${results.length} steps passed.`);
  if (issues.length) console.log(`Browser issues (${issues.length}):\n  ${issues.slice(0, 40).join('\n  ')}`);
  console.log(`\nEvidence (${evidence.length} lines):\n  ${evidence.join('\n  ')}`);
}
