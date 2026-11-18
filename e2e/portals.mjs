// e2e/portals.mjs
// Portal-by-portal browser test of ERIS with its three account types: Admin, Hospital (HOSPITAL_DESK) and Fleet
// (PARAMEDIC, the ambulance crew). The Operator and Patient portals were retired: they must not appear anywhere.
//
//   PORTALS_PORT=4370 node e2e/portals.mjs        (default 4370; reserved ports are refused)
//
// With a real browser against the in-memory backend:
//   (a) sign-in: the "Show password" toggle, and the lockout message after five wrong passwords;
//   (b) each portal's visible navigation is exactly that role's set, and its essential actions change the store
//       (checked with a follow-up API read as admin);
//   (c) cross-role denial among Admin, Hospital and Fleet, and force-shown hidden tabs load no restricted data;
//   (d) the First Aid Guide shows exactly the supplied text (sign-in screen, staff tab, roadside link).
// Then every portal's screens at 390x844 and 768x1024 (no horizontal overflow, primary actions reachable), and a final
// check for console errors, page errors and CSP violations (the server's own Content-Security-Policy header).
//
// Accounts: like frontend-smoke.mjs, this test mirrors the demo accounts' roles and links (server/db/demoUsers.js) with
// random per-run passwords, handed to e2e/e2e-server.mjs on stdin. No password is printed or stored.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { DEMO_USERS } from '../server/db/demoUsers.js'; // roles and links only (no passwords)
import { SYMPTOM_DATABASE } from '../js/symptom_triage.js'; // only to prove its unsourced first-aid text is never shown

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORTALS_PORT || 4370);
const reserved = p => [3000, 4000].includes(p) || (p >= 4140 && p <= 4260) || (p >= 4310 && p <= 4360);
if (reserved(PORT)) throw new Error(`Port ${PORT} is reserved for other processes.`);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// PORTALS_PART=main (portal sections, no mobile sweep) | mobile (setup + mobile sweep only) | all (default).
const PART = process.env.PORTALS_PART || 'all';
if (!['all', 'main', 'mobile'].includes(PART)) throw new Error(`PORTALS_PART must be all, main or mobile, not ${PART}`);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.PORTALS_SHOTS || path.join(ROOT, 'e2e', 'screenshots', 'portals');
mkdirSync(SHOTS, { recursive: true });
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// ── Accounts (random passwords, kept in memory only) ─────────────────────────
const ACCOUNTS = DEMO_USERS.map(u => ({
  username: `p_${u.username}`, password: randomBytes(18).toString('base64url'), role: u.role, hospital_id: u.hospital_id ?? null,
  ambulance_id: u.ambulance_id ?? null, patient_id: u.patient_id ?? null, display_name: u.display_name
}));
const acct = (role, pred = () => true) => ACCOUNTS.find(a => a.role === role && pred(a));
const ADMIN = acct('ADMIN');
const PARAMEDIC = acct('PARAMEDIC');
const SECOND_FLEET = acct('PARAMEDIC', a => a.username !== PARAMEDIC?.username);
for (const [name, a] of Object.entries({ ADMIN, PARAMEDIC, SECOND_FLEET })) if (!a) throw new Error(`No ${name} account in server/db/demoUsers.js`);
const RETIRED_LOGINS = ['dispatch_ops', 'patient_vance', 'patient_jenkins', 'patient_demo'];

// ── Bookkeeping ───────────────────────────────────────────────────────────────
const results = [];
const issues = [];
let currentStep = 'setup';
const allowedConsole = [];
async function step(name, fn) {
  currentStep = name;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    for (const [label, page] of pages) await page.screenshot({ path: path.join(SHOTS, `fail-${name.split(' ')[0]}-${label}.png`) }).catch(() => {});
  } finally {
    if (Date.now() - t0 > 60_000) console.log(`      (slow step: ${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Server ────────────────────────────────────────────────────────────────────
let server;
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_SECRET: randomBytes(32).toString('hex'), NODE_ENV: 'development',
    // The server's own lockout (5 wrong passwords per username and address) is kept: step L2 checks it. Every page and
    // API user here has its own address, and no other step fails a sign-in more than twice.
    LOGIN_RATE_LIMIT: '5', LOGIN_IP_RATE_LIMIT: '1000', SOCKET_RECHECK_MS: '2000',
    // The /api limiter allows 300 requests a minute per client address. Every portal user here would otherwise share
    // 127.0.0.1, so the server trusts one proxy hop and each user/page sends its own X-Forwarded-For (see clientIp).
    TRUST_PROXY: '1', ROUTING_URL: 'off' }; // no public routing service from a test server
  delete env.JWT_EXPIRES;
  server = spawn(process.execPath, ['e2e/e2e-server.mjs'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stdin.end(JSON.stringify(ACCOUNTS));
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${ORIGIN}/health`)).ok) return; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${log.slice(-2000)}`);
    await sleep(150);
  }
  throw new Error(`Server did not become healthy:\n${log.slice(-2000)}`);
}

/** A stable fake client address per user or page (10.77.x.y), so each behaves like its own client. */
const ips = new Map();
const clientIp = key => { if (!ips.has(key)) ips.set(key, `10.77.${Math.floor(ips.size / 250)}.${(ips.size % 250) + 1}`); return ips.get(key); };

async function api(token, p, { method = 'GET', body, as } = {}) {
  const r = await fetch(`${ORIGIN}/api/v1${p}`, { method, headers: { 'X-Forwarded-For': clientIp(as || token || 'anonymous'), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: parsed };
}
async function apiLogin(a, password = a.password) {
  const r = await api(null, '/auth/login', { method: 'POST', body: { username: a.username, password }, as: a.username });
  return r.status === 200 ? r.body.token : null;
}
/** Each [method, path, body?] must be refused with one of `codes` (default 403). */
async function expectDenied(token, calls, codes = [403]) {
  const wrong = [];
  for (const [method, p, body, allowed = codes] of calls) {
    const r = await api(token, p, { method, body });
    if (!allowed.includes(r.status)) wrong.push(`${method} ${p} -> ${r.status} (expected ${allowed.join('/')})`);
  }
  assert(wrong.length === 0, `not refused:\n${wrong.join('\n')}`);
}

// ── Browser ───────────────────────────────────────────────────────────────────
let browser;
const pages = [];
async function newPage(label, { width = 1366, height = 900 } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.__api = []; // every /api/v1 request this page made: "METHOD /path"
  page.on('request', r => { if (r.url().startsWith(`${ORIGIN}/api/v1/`)) page.__api.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const full = `${msg.text()} ${msg.location()?.url || ''}`;
    if (allowedConsole.some(a => (a.step === '*' || a.step === currentStep) && a.re.test(full))) return;
    issues.push(`[${label}] [${currentStep}] console.error: ${full}`);
  });
  page.on('pageerror', err => issues.push(`[${label}] [${currentStep}] pageerror: ${err.message}`));
  page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : (issues.push(`[${label}] dialog ${d.message()}`), d.dismiss())));
  await page.setRequestInterception(true);
  const ip = clientIp(`page:${label}`);
  page.__rules = []; // [{ once, match(req), action(req) }]
  page.on('request', r => {
    const rule = page.__rules.find(x => x.match(r));
    if (rule) { if (rule.once) page.__rules.splice(page.__rules.indexOf(rule), 1); return rule.action(r, ip); }
    if (/^https:\/\/tile\.openstreetmap\.org\//.test(r.url())) return r.respond({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
    // Same-origin requests only (a custom header on fonts would trigger CORS preflights): this page's own client address.
    if (r.url().startsWith(ORIGIN)) return r.continue({ headers: { ...r.headers(), 'x-forwarded-for': ip } });
    return r.continue();
  });
  pages.push([label, page]);
  return page;
}
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
/** Rule action: deliver the request to the server from Node, then fail it in the browser (the answer is lost). */
const forwarded = [];
async function forwardThenDrop(req, ip) {
  const headers = { ...req.headers(), 'x-forwarded-for': ip };
  ['host', 'connection', 'content-length', 'origin', 'referer'].forEach(h => delete headers[h]);
  const r = await fetch(req.url(), { method: req.method(), headers, body: req.postData() });
  forwarded.push({ url: req.url(), status: r.status, body: await r.text() });
  return req.abort('failed');
}
const fmtMinutes = v => `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} min`; // as the UI formats durations
const haversineKm = (a, b, c, d) => { const t = x => (x * Math.PI) / 180; const h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); };
const text = (page, sel) => page.$eval(sel, n => n.textContent.trim());
/** Click inside the page: puppeteer's mouse click scrolls the target under the sticky header and can hit a nav tab. */
const press = (page, sel) => page.$eval(sel, b => b.click());
/** waitFor, but a timeout says what the page showed instead. */
async function waitOrExplain(page, fn, arg, timeout = 15000) {
  try { return await waitFor(page, fn, arg, timeout); } catch (err) {
    const seen = await page.evaluate(() => ({
      tab: document.querySelector('.tab-pane.active')?.id, toast: document.getElementById('globalNotificationBanner')?.textContent,
      errors: [...document.querySelectorAll('.form-error:not([hidden])')].map(n => n.textContent), signedOut: document.body.classList.contains('signed-out')
    })).catch(() => ({}));
    throw new Error(`${err.message}; page showed ${JSON.stringify(seen)}`);
  }
}

async function loginUI(page, a) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
  await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
  await waitFor(page, () => document.activeElement?.id === 'loginUsername');
  await page.type('#loginUsername', a.username);
  await page.type('#loginPassword', a.password);
  page.__api.length = 0;
  await page.click('#loginSubmitBtn');
  await waitFor(page, () => !document.body.classList.contains('signed-out'));
  await waitFor(page, () => document.getElementById('connectionStatus')?.textContent === 'Live', null, 10000);
}
async function openTab(page, tab) {
  await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => b.click());
  await waitFor(page, t => document.getElementById(t)?.classList.contains('active'), tab);
}
/** The workspace tabs a user can see: [] when the staff navigation is not displayed at all. */
const visibleNav = page => page.evaluate(() => {
  const nav = document.getElementById('primaryNav');
  if (!nav || getComputedStyle(nav).display === 'none') return [];
  return [...nav.querySelectorAll('.nav-tab-btn')].filter(b => !b.hidden).map(b => b.dataset.tab);
});
async function expectNav(page, expected) {
  const got = await visibleNav(page);
  assert(JSON.stringify(got) === JSON.stringify(expected), `navigation is [${got.join(', ')}]\n expected [${expected.join(', ')}]`);
}
const RESTRICTED = [/\/api\/v1\/admin\//, /\/api\/v1\/audit\/verify/, /\/api\/v1\/analytics\/(history|forecast|audit|referrals)/, /\/accept$/, /\/reject$/, /\/api\/v1\/patient\//];
/** Unhide the given tabs' navigation, open each, and return the API requests that followed. */
async function forceShow(page, tabs) {
  page.__api.length = 0;
  for (const tab of tabs) {
    await page.evaluate(t => {
      document.getElementById('primaryNav')?.style.setProperty('display', 'flex');
      const b = document.querySelector(`.nav-tab-btn[data-tab="${t}"]`);
      if (b) { b.hidden = false; b.click(); }
    }, tab);
    await sleep(500);
  }
  await sleep(800);
  return [...page.__api];
}
async function fillIntake(page, { name, age, lat, lng }) {
  await page.$eval('#emergencyIntakeForm', f => f.reset());
  await page.type('#patientName', name);
  await page.type('#patientAge', String(age));
  await page.type('#pickupLat', String(lat));
  await page.type('#pickupLng', String(lng));
}

// The First Aid Guide, exactly as the project owner supplied it (also checked by tests/firstaid_content.test.js).
const FIRST_AID_TEXT = `1. What to do immediately after an accident
1. Ensure your own safety
   - Stop in a safe place.
   - Switch on hazard lights.
   - Watch out for traffic, fire, leaking fuel or electrical hazards.
   - Do not put yourself in danger.
2. Call emergency services
   - In India, dial 112 for emergency assistance.
   - Ask someone to call an ambulance.
   - Give your exact location, number of injured people and type of accident.
3. Check the injured person
   - Check whether they respond when you speak to them.
   - Check whether they are breathing normally.
   - Look for severe bleeding.
   - Do not shake them or unnecessarily move their neck.
4. Provide appropriate first aid
   - Control bleeding.
   - Protect the person's airway.
   - Keep them warm.
   - Follow the emergency operator's instructions.`;

/** Check a rendered First Aid Guide inside `root` (CSS selector): exactly the supplied text, the 112 note, nothing else. */
async function checkGuide(page, root) {
  const g = await page.$eval(root, n => ({
    note: n.querySelector('.fa-disclaimer')?.textContent,
    call: (() => { const a = n.querySelector('.fa-call-link'); const r = a?.getBoundingClientRect(); return a ? { href: a.getAttribute('href'), visible: r.width > 0 && r.height > 0 } : null; })(),
    title: n.querySelector('.fa-guide-title')?.textContent,
    sections: [...n.querySelectorAll('.fa-step')].map(s => [s.querySelector('.fa-step-title')?.textContent, [...s.querySelectorAll('li')].map(li => li.textContent)]),
    links: n.querySelectorAll('a').length,
    old: n.querySelectorAll('details, .fa-card, .fa-sources, .fa-version, .fa-refs').length,
    all: n.textContent
  }));
  assert(g.note === 'General guidance only. Call 112 in an emergency.', `note: ${g.note}`);
  assert(g.call?.href === 'tel:112' && g.call.visible, `call link: ${JSON.stringify(g.call)}`);
  const shown = [g.title, ...g.sections.flatMap(([h, items]) => [h, ...items.map(i => `   - ${i}`)])].join('\n');
  assert(shown === FIRST_AID_TEXT, `the guide differs from the supplied text:\n${shown}`);
  assert(g.links === 1 && g.old === 0, `extra content: ${g.links} links, ${g.old} old card/source elements`);
  const expectedChars = g.note.length + FIRST_AID_TEXT.replace(/\n( {3}- )?/g, '').length;
  assert(g.all.length === expectedChars, `the guide shows other text too (${g.all.length} characters, expected ${expectedChars})`);
}

const NAV = {
  ADMIN: ['tab-command', 'tab-ingestion', 'tab-ranking', 'tab-roadside', 'tab-mci', 'tab-acceptance', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-tracking', 'tab-doctors', 'tab-activity', 'tab-analytics', 'tab-accounts', 'tab-bankers', 'tab-firstaid'],
  HOSPITAL_DESK: ['tab-command', 'tab-ingestion', 'tab-acceptance', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-tracking', 'tab-doctors', 'tab-bankers', 'tab-firstaid'],
  PARAMEDIC: ['tab-command', 'tab-ingestion', 'tab-ranking', 'tab-roadside', 'tab-hospitals', 'tab-ambulance', 'tab-map', 'tab-tracking', 'tab-bankers', 'tab-firstaid']
};

async function stepMobile(deskAcct) {
  await step('M3. Desktop widths 1366x900 and 1024x768: every visible workspace tab is fully on screen and clickable, for every role', async () => {
    const problems = [];
    for (const [w, h] of [[1366, 900], [1024, 768]]) {
      for (const a of [ADMIN, deskAcct, PARAMEDIC]) {
        const page = await newPage(`nav-${w}-${a.role}`, { width: w, height: h });
        try {
          await loginUI(page, a);
          await sleep(400);
          const r = await page.evaluate(() => {
            const nav = document.getElementById('primaryNav');
            const shown = getComputedStyle(nav).display !== 'none';
            const tabs = [...nav.querySelectorAll('.nav-tab-btn')].filter(b => !b.hidden);
            const bad = shown ? tabs.filter(b => {
              const r = b.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return !(r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && (hit === b || b.contains(hit)));
            }).map(b => b.dataset.tab) : [];
            return { shown, count: tabs.length, bad, clipped: nav.scrollWidth - nav.clientWidth };
          });
          if (!r.shown) problems.push(`${w} ${a.role}: navigation hidden at a desktop width`);
          if (r.bad.length) problems.push(`${w} ${a.role}: tabs off screen or covered: ${r.bad.join(', ')}`);
          if (r.clipped > 1) problems.push(`${w} ${a.role}: navigation scrolls sideways by ${r.clipped}px`);
          await page.screenshot({ path: path.join(SHOTS, `nav-${w}-${a.role}.png`) });
        } catch (err) { problems.push(`${w} ${a.role}: ${err.message.split('\n')[0]}`); }
        await page.close();
        pages.splice(pages.findIndex(([, p]) => p === page), 1);
      }
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  await step('M2. Mobile: the First Aid Guide, signed out (dialog) and as Fleet (tab), at 390x844 and 768x1024 — no overflow, the call link reachable', async () => {
    const problems = [];
    for (const [w, h] of [[390, 844], [768, 1024]]) {
      for (const who of ['signed-out', 'PARAMEDIC']) {
        const page = await newPage(`m-fa-${w}-${who}`, { width: w, height: h });
        try {
          const root = who === 'PARAMEDIC' ? '#firstAidStaff' : '#firstAidOverlayBody';
          if (who === 'PARAMEDIC') { await loginUI(page, PARAMEDIC); await openTab(page, 'tab-firstaid'); }
          else { await page.goto(ORIGIN, { waitUntil: 'networkidle2' }); await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting')); await press(page, '#firstAidLink'); }
          await waitFor(page, r => document.querySelectorAll(`${r} .fa-step`).length === 4, root);
          const r = await page.evaluate(rootSel => {
            const call = document.querySelector(`${rootSel} .fa-call-link`).getBoundingClientRect();
            const close = rootSel === '#firstAidOverlayBody' ? document.getElementById('firstAidClose').getBoundingClientRect() : call;
            const box = rootSel === '#firstAidOverlayBody' ? document.querySelector('.firstaid-sheet') : document.getElementById(rootSel.slice(1));
            return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOverflow: box.scrollWidth - box.clientWidth,
              call: call.width > 0 && call.right <= innerWidth + 1, close: close.width > 0 && close.right <= innerWidth + 1 };
          }, root);
          if (r.overflow > 0 || r.sheetOverflow > 0) problems.push(`${w} ${who}: overflow ${r.overflow}/${r.sheetOverflow}px`);
          if (!r.call || !r.close) problems.push(`${w} ${who}: call link or Close not reachable`);
          await page.screenshot({ path: path.join(SHOTS, `mobile-firstaid-${w}-${who}.png`) });
        } catch (err) { problems.push(`${w} ${who}: ${err.message.split('\n')[0]}`); }
        await page.close();
        pages.splice(pages.findIndex(([, p]) => p === page), 1);
      }
    }
    assert(problems.length === 0, problems.join('\n'));
  });

  // ═══════════════════════════ Mobile ═══════════════════════════
  await step('M1. Mobile: every portal at 390x844 and 768x1024 — no horizontal overflow, primary actions reachable', async () => {
    const problems = [];
    const roles = [ADMIN, deskAcct, PARAMEDIC];
    for (const [w, h] of [[390, 844], [768, 1024]]) {
      for (const a of roles) {
        try { await mobileSweep(a, w, h); } catch (err) { problems.push(`${w} ${a.role}: ${err.message.split('\n')[0]}`); }
      }
    }
    assert(problems.length === 0, problems.join('\n'));

    async function mobileSweep(a, w, h) {
        const page = await newPage(`m${w}-${a.role}`, { width: w, height: h });
        await loginUI(page, a);
        await sleep(800);
        for (const tab of NAV[a.role]) {
          {
            const menu = await page.$eval('#navMenuBtn', b => getComputedStyle(b).display !== 'none').catch(() => false);
            if (menu) { await page.click('#navMenuBtn'); await sleep(200); }
            const reach = await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; });
            if (!reach) problems.push(`${w} ${a.role} ${tab}: nav button not reachable`);
            await page.$eval(`.nav-tab-btn[data-tab="${tab}"]`, b => b.click());
            await sleep(700);
            if (tab === 'tab-ingestion' && a.role !== 'HOSPITAL_DESK') { await page.$eval('#emergencyQueueTableBody tr[data-request-id]', r => r.click()).catch(() => {}); await sleep(500); }
          }
          const res = await page.evaluate(paneId => {
            const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const root = document.getElementById(paneId);
            const extra = [document.getElementById('logoutBtn')];
            const primary = [...root.querySelectorAll('button')].filter(b => !b.closest('[hidden]') && b.offsetParent !== null
              && /btn-primary|btn-success|btn-danger|btn-emergency|btn-edit-account|btn-dispatch|btn-accept|btn-reject|btn-init-referral/.test(b.className)).concat(extra);
            const bad = [];
            for (const b of primary) {
              b.scrollIntoView({ block: 'center', inline: 'nearest' });
              const r = b.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 10), r.top + r.height / 2);
              if (!(r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1) || !(hit === b || b.contains(hit))) bad.push(`${b.id || b.className} "${b.textContent.trim().slice(0, 20)}"`);
            }
            window.scrollTo(0, 0);
            return { overflow, bad, n: primary.length };
          }, tab);
          if (res.overflow > 0) problems.push(`${w} ${a.role} ${tab}: ${res.overflow}px horizontal overflow`);
          res.bad.forEach(b => problems.push(`${w} ${a.role} ${tab}: unreachable ${b}`));
          await page.screenshot({ path: path.join(SHOTS, `mobile-${w}-${a.role}-${tab}.png`) });
        }
        await page.close();
        pages.splice(pages.findIndex(([, p]) => p === page), 1);
    }
  });

}

async function stepFinal() {
  await step('Z. No console errors, page errors or CSP violations', async () => {
    for (const [label, page] of pages) {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      csp.forEach(v => issues.push(`[${label}] CSP violation: ${v}`));
    }
    assert(issues.length === 0, `${issues.length} issue(s):\n${issues.join('\n')}`);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  await startServer();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const ctx = {};
  ctx.adminToken = await apiLogin(ADMIN);
  assert(ctx.adminToken, 'admin API login failed');
  const tokens = {};
  tokens.PARAMEDIC = await apiLogin(PARAMEDIC);
  if (PART === 'mobile') { await stepMobile(acct('HOSPITAL_DESK')); await stepFinal(); return; }

  // ═══════════════════════════ Sign-in ═══════════════════════════
  await step('L1. Sign-in: "Show password" is an accessible toggle that shows and hides the password; it is hidden again after every submit and after logout', async () => {
    allowedConsole.push({ step: currentStep, re: /status of 401/ });
    const page = await newPage('login-toggle');
    await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    const look = () => page.evaluate(() => {
      const i = document.getElementById('loginPassword'); const b = document.getElementById('loginPasswordToggle');
      return { type: i.type, value: i.value, pressed: b.getAttribute('aria-pressed'), label: b.textContent, btnType: b.type, controls: b.getAttribute('aria-controls') };
    });
    let s = await look();
    assert(s.type === 'password' && s.pressed === 'false' && s.label === 'Show password' && s.btnType === 'button' && s.controls === 'loginPassword', `initial: ${JSON.stringify({ ...s, value: undefined })}`);
    await page.type('#loginUsername', ADMIN.username);
    await page.type('#loginPassword', 'wrong-password-1');
    await page.focus('#loginPasswordToggle');
    await page.keyboard.press('Enter'); // keyboard-operable
    s = await look();
    assert(s.type === 'text' && s.pressed === 'true' && s.label === 'Hide password' && s.value === 'wrong-password-1', `after Show: ${JSON.stringify({ ...s, value: s.value.length })}`);
    assert(await page.evaluate(() => document.body.classList.contains('signed-out')), 'the toggle submitted the form');
    await press(page, '#loginPasswordToggle');
    assert((await look()).type === 'password', 'Hide did not hide');
    // A submit (here a wrong password) hides it again.
    await press(page, '#loginPasswordToggle');
    await press(page, '#loginSubmitBtn');
    await waitOrExplain(page, () => !document.getElementById('authFormError').hidden && !document.getElementById('loginSubmitBtn').disabled);
    s = await look();
    assert(s.type === 'password' && s.pressed === 'false' && s.label === 'Show password', `after a failed submit: ${JSON.stringify({ ...s, value: undefined })}`);
    // A successful sign-in with the password shown, then logout: hidden and empty.
    await page.$eval('#loginPassword', n => { n.value = ''; });
    await page.type('#loginPassword', ADMIN.password);
    await press(page, '#loginPasswordToggle');
    await press(page, '#loginSubmitBtn');
    await waitOrExplain(page, () => !document.body.classList.contains('signed-out'));
    assert((await look()).type === 'password', 'the password is shown after a successful sign-in');
    // Even if the (hidden) toggle is switched on while signed in, logout hides the password again.
    await press(page, '#loginPasswordToggle');
    assert((await look()).type === 'text', 'control: the toggle did not switch while signed in');
    await press(page, '#logoutBtn');
    await waitFor(page, () => document.body.classList.contains('signed-out'));
    s = await look();
    assert(s.type === 'password' && s.pressed === 'false' && s.label === 'Show password' && s.value === '', `after logout: ${JSON.stringify({ ...s, value: s.value.length })}`);
    await page.close();
    pages.splice(pages.findIndex(([, p]) => p === page), 1);
  });

  await step('L2. Sign-in lockout: five wrong passwords for one username, then the sixth attempt (even the right password) shows "Too many attempts, try again later"', async () => {
    allowedConsole.push({ step: currentStep, re: /status of (401|429)/ });
    const page = await newPage('lockout');
    await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await page.type('#loginUsername', SECOND_FLEET.username);
    const attempt = async pw => {
      await page.$eval('#loginPassword', n => { n.value = ''; });
      await page.type('#loginPassword', pw);
      await page.evaluate(() => { const e = document.getElementById('authFormError'); e.hidden = true; e.textContent = ''; });
      await press(page, '#loginSubmitBtn');
      await waitOrExplain(page, () => !document.getElementById('authFormError').hidden && !document.getElementById('loginSubmitBtn').disabled);
      return text(page, '#authFormError');
    };
    for (let i = 1; i <= 5; i++) {
      const msg = await attempt(`wrong-password-${i}-${randomBytes(3).toString('hex')}`);
      assert(!/Too many attempts/.test(msg), `attempt ${i} already locked: ${msg}`);
    }
    const locked = await attempt(SECOND_FLEET.password);
    assert(locked.startsWith('Too many attempts, try again later.'), `sixth attempt: "${locked}"`);
    assert(await page.evaluate(() => document.body.classList.contains('signed-out')), 'signed in while locked');
    await page.close();
    pages.splice(pages.findIndex(([, p]) => p === page), 1);
  });

  // ═══════════════════════════ Admin ═══════════════════════════
  const admin = await newPage('admin');
  await step('A1. Admin: navigation is exactly the admin set, labelled Admin', async () => {
    await loginUI(admin, ADMIN);
    await expectNav(admin, NAV.ADMIN);
    assert(/\(Admin\)/.test(await text(admin, '#userRoleTitle')), 'role label');
  });

  await step('A2. Admin: Accounts lists the store\'s users, filters by role and pages through them', async () => {
    for (let i = 0; i < 20; i++) { // more than one page of 25 with the 8 demo accounts
      const r = await api(ctx.adminToken, '/admin/users', { method: 'POST', body: { username: `bulk_${i}_${randomBytes(3).toString('hex')}`, role: 'PARAMEDIC', password: randomBytes(12).toString('base64url') } });
      assert(r.status === 201, `bulk create ${r.status} ${JSON.stringify(r.body)}`);
    }
    const all = (await api(ctx.adminToken, '/admin/users?limit=200')).body;
    await openTab(admin, 'tab-accounts');
    await waitFor(admin, () => document.querySelectorAll('#accountsTableBody tr[data-user-id]').length > 0);
    const count = await text(admin, '#accountResultCount');
    assert(count === `1–25 of ${all.total} accounts`, `count "${count}" vs server total ${all.total}`);
    assert(!(await admin.$eval('#accountsNext', b => b.disabled)), 'Next is disabled with more than 25 accounts');
    await press(admin, '#accountsNext');
    await waitFor(admin, t => document.getElementById('accountResultCount').textContent === `26–${t} of ${t} accounts`, all.total);
    const page2 = await admin.$$eval('#accountsTableBody tr[data-user-id]', rs => rs.map(r => r.dataset.userId));
    assert(page2.every(id => all.users.slice(25).some(u => u.user_id === id)), 'page 2 rows differ from the server\'s second page');
    await admin.select('#accountRoleFilter', 'HOSPITAL_DESK');
    const desks = (await api(ctx.adminToken, '/admin/users?role=HOSPITAL_DESK')).body;
    await waitFor(admin, n => document.getElementById('accountResultCount').textContent === `1–${n} of ${n} accounts`, desks.total);
    const roles = await admin.$$eval('#accountsTableBody tr[data-user-id] td:nth-child(3)', ts => ts.map(t => t.textContent));
    assert(roles.length === desks.total && roles.every(r => r === 'Hospital'), `desk filter shows ${roles.join(', ')}`);
    await admin.select('#accountRoleFilter', '');
  });

  ctx.newDesk = { username: `desk_${randomBytes(4).toString('hex')}`, password: randomBytes(15).toString('base64url'), role: 'HOSPITAL_DESK' };
  await step('A3. Admin: creates a hospital-desk account in the UI; the store has it and it signs in', async () => {
    await press(admin, '#btnNewAccount');
    await waitFor(admin, () => document.getElementById('accountCreateForm'));
    await admin.type('#accountUsername', ctx.newDesk.username);
    await admin.type('#accountDisplayName', 'E2E Desk');
    await admin.select('#accountRole', 'HOSPITAL_DESK');
    await waitFor(admin, () => !document.getElementById('accountHospital').closest('.form-group').hidden);
    const roleOptions = await admin.$$eval('#accountRole option', os => os.map(o => [o.value, o.textContent]));
    assert(JSON.stringify(roleOptions) === JSON.stringify([['ADMIN', 'Admin'], ['HOSPITAL_DESK', 'Hospital'], ['PARAMEDIC', 'Fleet']]), `role options ${JSON.stringify(roleOptions)}`);
    assert(!(await admin.$('#accountPatient')) && !(await admin.$('#accountPatientSearch')), 'a patient picker is still in the form');
    assert(/At least 10 characters/.test(await text(admin, '#accountFormPanel')), 'password policy not shown');
    await admin.select('#accountHospital', 'H-102');
    await admin.type('#accountNewPassword', ctx.newDesk.password);
    await admin.type('#accountNewPasswordConfirm', ctx.newDesk.password);
    await press(admin, '#accountCreateSubmit');
    await waitOrExplain(admin, u => [...document.querySelectorAll('#accountsTableBody tr[data-username]')].some(r => r.dataset.username === u) || /created/.test(document.getElementById('globalNotificationBanner').textContent), ctx.newDesk.username);
    const stored = (await api(ctx.adminToken, '/admin/users?role=HOSPITAL_DESK&limit=200')).body.users.find(u => u.username === ctx.newDesk.username);
    assert(stored && stored.hospital_id === 'H-102' && Number(stored.is_active) === 1 && stored.display_name === 'E2E Desk', `store row ${JSON.stringify(stored)}`);
    ctx.newDesk.user_id = stored.user_id;
    const login = await api(null, '/auth/login', { method: 'POST', body: { username: ctx.newDesk.username, password: ctx.newDesk.password } });
    assert(login.status === 200 && login.body.user.role === 'HOSPITAL_DESK' && login.body.user.hospital_id === 'H-102', `new account login ${login.status}`);
    ctx.newDesk.token = login.body.token;
    const kept = await admin.evaluate(p => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + [...document.querySelectorAll('input')].map(i => i.value).join('|'), ctx.newDesk.password);
    assert(!kept.includes(ctx.newDesk.password), 'the password is still in an input or in browser storage');
  });

  const REVOKED = 'Your session was ended by an account change. Please sign in again.';
  /** The user's open browser session must end on its own (socket disconnect, /auth/me 401) with `message`. */
  async function expectSignedOutByChange(page, what, message = REVOKED) {
    try {
      await waitFor(page, () => document.body.classList.contains('signed-out'), null, 15000);
    } catch { throw new Error(`the user's open session was not signed out after ${what}`); }
    const notice = await text(page, '#authNotice');
    assert(message instanceof RegExp ? message.test(notice) : notice === message, `sign-in notice after ${what}: "${notice}"`);
    assert(await page.evaluate(() => sessionStorage.getItem('eris.session.token')) === null, `token kept after ${what}`);
  }
  /** Clear the notification banner, so the next wait for a toast sees a fresh one (not the previous action's). */
  const clearToast = page => page.evaluate(() => { const b = document.getElementById('globalNotificationBanner'); b.textContent = ''; b.hidden = true; });
  const storedUser = async id => (await api(ctx.adminToken, '/admin/users?limit=200')).body.users.find(u => u.user_id === id);

  await step('A4. Admin: a link change, password reset, role change and deactivation each end the user\'s open session; reactivation restores sign-in', async () => {
    allowedConsole.push({ step: currentStep, re: /status of 401/ });
    const user = await newPage('newdesk');
    await admin.select('#accountRoleFilter', 'HOSPITAL_DESK'); // a short list: the new account is on this page
    const row = `#accountsTableBody tr[data-user-id="${ctx.newDesk.user_id}"]`;
    await waitOrExplain(admin, r => document.querySelector(r), row);
    await press(admin, `${row} .btn-edit-account`);
    await waitOrExplain(admin, () => document.getElementById('accountEditForm'));

    // 1. Hospital-link change while the desk has the console open.
    await loginUI(user, ctx.newDesk);
    await admin.select('#accountHospital', 'H-103');
    await clearToast(admin);
    await press(admin, '#accountEditSubmit');
    await waitOrExplain(admin, () => /updated/.test(document.getElementById('globalNotificationBanner').textContent));
    assert((await storedUser(ctx.newDesk.user_id)).hospital_id === 'H-103', 'hospital not changed in the store');
    await expectSignedOutByChange(user, 'a hospital-link change');
    const old = await api(ctx.newDesk.token, '/auth/me');
    assert(old.status === 401 && old.body?.error === REVOKED, `a token issued before the change: ${old.status} ${old.body?.error}`);

    // 2. Password reset while signed in again.
    await loginUI(user, ctx.newDesk);
    const next = randomBytes(15).toString('base64url');
    await admin.type('#accountResetPassword', next);
    await admin.type('#accountResetPasswordConfirm', next);
    await press(admin, '#accountResetSubmit');
    await waitOrExplain(admin, () => /New password set/.test(document.getElementById('accountResetMessage').textContent));
    const resetMsg = await text(admin, '#accountResetMessage');
    assert(/open sessions were ended/.test(resetMsg) && !/keep working/.test(resetMsg), `reset message: "${resetMsg}"`);
    await expectSignedOutByChange(user, 'a password reset');
    assert((await api(null, '/auth/login', { method: 'POST', body: { username: ctx.newDesk.username, password: ctx.newDesk.password }, as: 'newdesk' })).status === 401, 'old password still works');
    ctx.newDesk.password = next;

    // 3. Role change (Hospital -> Fleet) while signed in again.
    await loginUI(user, ctx.newDesk);
    await admin.select('#accountEditRole', 'PARAMEDIC');
    await waitOrExplain(admin, () => document.getElementById('accountHospital')?.closest('.form-group').hidden);
    await clearToast(admin);
    await press(admin, '#accountEditSubmit');
    await waitOrExplain(admin, () => /updated/.test(document.getElementById('globalNotificationBanner').textContent));
    let stored = await storedUser(ctx.newDesk.user_id);
    assert(stored.role === 'PARAMEDIC' && stored.hospital_id === null, `store after the role change: ${stored.role} ${stored.hospital_id}`);
    await expectSignedOutByChange(user, 'a role change');

    // 4. Deactivation while signed in again (as the Fleet login it now is): the session ends, sign-in is refused.
    await loginUI(user, ctx.newDesk);
    assert(/\(Fleet\)/.test(await text(user, '#userRoleTitle')), 'the new role is not in effect after signing in again');
    const liveToken = await user.evaluate(() => sessionStorage.getItem('eris.session.token'));
    await clearToast(admin);
    await press(admin, '#btnAccountDeactivate');
    await waitOrExplain(admin, () => /deactivated/.test(document.getElementById('globalNotificationBanner').textContent));
    assert(Number((await storedUser(ctx.newDesk.user_id)).is_active) === 0, 'store still active');
    await expectSignedOutByChange(user, 'deactivation');
    assert((await api(liveToken, '/auth/me')).status === 401, 'the deactivated account\'s next request was not refused');
    assert((await api(null, '/auth/login', { method: 'POST', body: { username: ctx.newDesk.username, password: next }, as: 'newdesk' })).status === 401, 'a deactivated account signed in');

    // 5. Reactivation: the account signs in again.
    await waitOrExplain(admin, () => document.getElementById('btnAccountReactivate'));
    await clearToast(admin);
    await press(admin, '#btnAccountReactivate');
    await waitOrExplain(admin, () => /reactivated/.test(document.getElementById('globalNotificationBanner').textContent));
    stored = await storedUser(ctx.newDesk.user_id);
    assert(Number(stored.is_active) === 1, 'store not reactivated');
    ctx.newDesk.token = await apiLogin(ctx.newDesk);
    assert(ctx.newDesk.token, 'the reactivated account cannot sign in');
    await user.close();
    pages.splice(pages.findIndex(([, p]) => p === user), 1);
    await admin.select('#accountRoleFilter', '');
  });

  await step('A5. Admin: 409 and 400 are shown plainly and change nothing (taken username, self-deactivation, bad username)', async () => {
    allowedConsole.push({ step: currentStep, re: /status of (409|400)/ });
    const before = (await api(ctx.adminToken, '/admin/users?limit=1')).body.total;
    await press(admin, '#btnNewAccount');
    await waitFor(admin, () => document.getElementById('accountCreateForm'));
    await admin.select('#accountRole', 'PARAMEDIC');
    await admin.type('#accountUsername', ctx.newDesk.username);
    const pw = randomBytes(15).toString('base64url');
    await admin.type('#accountNewPassword', pw); await admin.type('#accountNewPasswordConfirm', pw);
    await press(admin, '#accountCreateSubmit');
    await waitFor(admin, () => !document.getElementById('accountFormError').hidden);
    const dup = await text(admin, '#accountFormError');
    assert(/^Not changed: .*already taken/.test(dup), `duplicate username message: "${dup}"`);
    await admin.$eval('#accountUsername', n => { n.value = 'bad name!'; });
    await admin.type('#accountNewPassword', pw); await admin.type('#accountNewPasswordConfirm', pw);
    await press(admin, '#accountCreateSubmit');
    await waitFor(admin, () => /^Not saved:/.test(document.getElementById('accountFormError').textContent));
    assert((await api(ctx.adminToken, '/admin/users?limit=1')).body.total === before, 'an account was created');
    // Self-deactivation: the server refuses with 409; the UI must say so and the admin stays active.
    await admin.select('#accountRoleFilter', 'ADMIN');
    const me = (await api(ctx.adminToken, '/auth/me')).body.user.user_id;
    const row = `#accountsTableBody tr[data-user-id="${me}"]`;
    await waitOrExplain(admin, r => document.querySelector(r), row);
    await admin.$eval(`${row} .btn-edit-account`, b => b.click());
    await waitFor(admin, () => document.getElementById('btnAccountDeactivate'));
    await press(admin, '#btnAccountDeactivate');
    await waitFor(admin, () => !document.getElementById('accountEditError').hidden);
    const self = await text(admin, '#accountEditError');
    assert(/^Not changed: .*cannot change your own role or deactivate/i.test(self), `self-deactivation message: "${self}"`);
    const stillActive = (await api(ctx.adminToken, '/admin/users?role=ADMIN')).body.users.find(u => u.user_id === me);
    assert(Number(stillActive.is_active) === 1, 'the admin was deactivated');
    await admin.select('#accountRoleFilter', '');
  });

  await step('A6. Admin: only Admin, Hospital and Fleet accounts exist and can be made; the server refuses Operator and Patient; the retired demo logins are gone', async () => {
    const filter = await admin.$$eval('#accountRoleFilter option', os => os.map(o => o.value));
    assert(JSON.stringify(filter) === JSON.stringify(['', 'ADMIN', 'HOSPITAL_DESK', 'PARAMEDIC']), `role filter ${filter.join(', ')}`);
    for (const role of ['DISPATCHER', 'PATIENT']) {
      const r = await api(ctx.adminToken, '/admin/users', { method: 'POST', body: { username: `retired_${role.toLowerCase()}_${randomBytes(3).toString('hex')}`, role, password: randomBytes(15).toString('base64url'), ...(role === 'PATIENT' ? { patient_id: 'PAT-001' } : {}) } });
      assert(r.status === 400, `creating a ${role} account answered ${r.status}`);
    }
    // A Fleet account with no unit needs no link change, so only the role itself can be refused.
    const plain = (await api(ctx.adminToken, '/admin/users?role=PARAMEDIC&limit=200')).body.users.find(u => !u.ambulance_id);
    assert(plain, 'no unlinked Fleet account to try a role change on');
    for (const role of ['DISPATCHER', 'PATIENT']) {
      const r = await api(ctx.adminToken, `/admin/users/${plain.user_id}`, { method: 'PATCH', body: { role } });
      assert(r.status === 400, `changing an account to ${role} answered ${r.status}`);
    }
    assert((await storedUser(plain.user_id)).role === 'PARAMEDIC', 'the refused role change changed the store');
    const users = (await api(ctx.adminToken, '/admin/users?limit=200')).body.users;
    const retired = users.filter(u => !['ADMIN', 'HOSPITAL_DESK', 'PARAMEDIC'].includes(u.role));
    assert(retired.length === 0, `accounts of retired types: ${retired.map(u => `${u.username}/${u.role}`).join(', ')}`);
    for (const username of RETIRED_LOGINS) {
      const r = await api(null, '/auth/login', { method: 'POST', body: { username, password: `not-a-password-${randomBytes(4).toString('hex')}` }, as: `retired-${username}` });
      assert(r.status === 401, `${username}: login answered ${r.status}`);
    }
  });

  await step('A7. Admin: registers a case in the UI and initiates a referral; the store has both', async () => {
    await openTab(admin, 'tab-ingestion');
    await fillIntake(admin, { name: 'Admin Intake Patient', age: 47, lat: 30.3201, lng: 78.0301 });
    await press(admin, '#intakeSubmitBtn');
    await waitOrExplain(admin, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    ctx.refCase = (await text(admin, '#globalNotificationBanner')).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    await waitOrExplain(admin, r => document.getElementById('caseTrackerCaption').textContent.startsWith(r) && document.getElementById('btnFindHospitals'), ctx.refCase);
    await admin.$eval('#btnFindHospitals', b => b.click());
    await waitFor(admin, () => document.querySelector('#rankingResultsContainer .btn-init-referral:not([disabled])'));
    ctx.refHospital = await admin.$eval('#rankingResultsContainer .btn-init-referral:not([disabled])', b => b.dataset.hospitalId);
    await admin.$eval('#rankingResultsContainer .btn-init-referral:not([disabled])', b => b.click());
    await waitFor(admin, () => document.getElementById('referralPendingLine'));
    const d = (await api(ctx.adminToken, `/emergencies/${ctx.refCase}`)).body;
    assert(d.request.status === 'MATCHING', `case status ${d.request.status}`);
    const pending = d.acceptances.find(a => a.status === 'PENDING');
    assert(pending && pending.hospital_id === ctx.refHospital, 'no pending referral to the chosen hospital');
    ctx.refAcceptance = pending.acceptance_id;
  });

  await step('C1. Cases: the admin has no Priority queue but opens any case by ID', async () => {
    await openTab(admin, 'tab-ingestion');
    const panels = await admin.$$eval('#tab-ingestion .panel-title', ts => ts.filter(t => !t.closest('[hidden]') && t.offsetParent !== null).map(t => t.textContent.trim()));
    assert(!panels.includes('Priority queue') && panels.includes('Open a case'), `admin Cases panels: ${panels.join(', ')}`);
    assert(await admin.$eval('#queuePanel', n => n.hidden && n.offsetParent === null), 'the queue panel is displayed for the admin');
    // A malformed ID is refused in place; a well-formed one opens the case in the tracker.
    await admin.$eval('#openCaseId', n => { n.value = 'not an id!'; });
    await press(admin, '#openCaseBtn');
    await waitFor(admin, () => !document.getElementById('openCaseError').hidden);
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.refCase);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, r => document.getElementById('caseTrackerCaption').textContent.startsWith(r) && document.querySelector('#lifecycleTracker .state-step.active'), ctx.refCase);
    assert(await admin.$eval('#openCaseError', n => n.hidden), 'error still shown after a valid ID');
  });

  // ═══════════════════════════ Hospital ═══════════════════════════
  const deskAcct = acct('HOSPITAL_DESK', a => a.hospital_id === ctx.refHospital);
  const desk = await newPage('desk');
  await step('H1. Hospital: navigation is exactly the Hospital set, labelled Hospital; its Cases tab keeps the Priority queue', async () => {
    assert(deskAcct, `no Hospital account for ${ctx.refHospital}`);
    await loginUI(desk, deskAcct);
    tokens.HOSPITAL_DESK = await desk.evaluate(() => sessionStorage.getItem('eris.session.token'));
    await expectNav(desk, NAV.HOSPITAL_DESK);
    assert(/\(Hospital · /.test(await text(desk, '#userRoleTitle')), 'role label is not Hospital');
    await openTab(desk, 'tab-ingestion');
    const panels = await desk.$$eval('#tab-ingestion .panel-title', ts => ts.filter(t => t.offsetParent !== null).map(t => t.textContent.trim()));
    assert(panels.includes('Priority queue') && !panels.includes('Open a case'), `Hospital Cases panels: ${panels.join(', ')}`);
    await openTab(desk, 'tab-acceptance');
  });

  await step('H2. Hospital: accepts the admin\'s referral; the store commits the allocation', async () => {
    const card = `.referral-card[data-acceptance-id="${ctx.refAcceptance}"]`;
    await waitFor(desk, c => document.querySelector(`${c} .btn-accept:not([disabled])`), card);
    await desk.$eval(`${card} .btn-accept`, b => b.click());
    await waitFor(desk, r => document.querySelector(`.allocation-result[data-request-id="${r}"]`), ctx.refCase);
    const d = (await api(ctx.adminToken, `/emergencies/${ctx.refCase}`)).body;
    assert(d.request.status === 'ALLOCATED' && d.acceptances.find(a => a.acceptance_id === ctx.refAcceptance)?.status === 'ACCEPTED', `server ${d.request.status}`);
  });

  await step('H3. Hospital: cross-role denial and force-shown tabs load nothing restricted', async () => {
    const other = ['H-101', 'H-102', 'H-103', 'H-104', 'H-105'].find(h => h !== deskAcct.hospital_id);
    await expectDenied(tokens.HOSPITAL_DESK, [
      ['GET', '/admin/users'], ['GET', `/hospitals/${other}`], ['PATCH', `/hospitals/${deskAcct.hospital_id}/status`, { emergency_status: 'LIMITED' }],
      ['POST', '/emergencies', { patient_name: 'X', age: 30, emergency_type: 'GENERAL' }], ['GET', '/analytics/history?days=28'], ['GET', '/audit/verify'],
      ['POST', '/tracking/demo-setup']
    ]);
    const calls = await forceShow(desk, ['tab-ranking', 'tab-activity', 'tab-analytics', 'tab-accounts']);
    const bad = calls.filter(c => RESTRICTED.some(re => re.test(c)));
    assert(bad.length === 0, `restricted requests: ${bad.join(', ')}`);
    await desk.reload({ waitUntil: 'networkidle2' });
  });

  await step('A8. Admin: releases the auto-dispatched unit and dispatches a unit of its choice; the store has it', async () => {
    await press(admin, '#refreshWorkspaceBtn');
    await openTab(admin, 'tab-ambulance');
    const auto = (await api(ctx.adminToken, `/emergencies/${ctx.refCase}`)).body.request.assigned_ambulance_id;
    const card = id => `#ambulanceFleetGrid .hospital-card[data-ambulance-id="${id}"]`;
    if (auto) {
      await waitFor(admin, s => [...document.querySelectorAll(`${s} button`)].some(b => b.textContent === 'Return to station'), card(auto));
      await admin.$$eval(`${card(auto)} button`, bs => bs.find(b => b.textContent === 'Return to station').click());
      await waitFor(admin, s => /AVAILABLE/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card(auto));
    }
    await waitFor(admin, rid => [...document.querySelectorAll('#ambulanceFleetGrid select option')].some(o => o.value === rid), ctx.refCase);
    const unit = await admin.$$eval('#ambulanceFleetGrid .hospital-card', (cards, [rid, skip]) => cards.find(c => c.dataset.ambulanceId !== skip
      && [...c.querySelectorAll('select option')].some(o => o.value === rid))?.dataset.ambulanceId, [ctx.refCase, auto]);
    assert(unit, 'no other available unit offers the case');
    await admin.select(`${card(unit)} select`, ctx.refCase);
    await admin.$eval(`${card(unit)} .btn-dispatch`, b => b.click());
    // Batch 8 (P-0.3): with simulated transport on (the default outside production) the dispatched unit's trip starts at
    // once, so the unit may already be IN_TRANSIT.
    await waitFor(admin, s => /DISPATCHED|IN.TRANSIT/i.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card(unit));
    const amb = (await api(ctx.adminToken, '/ambulances')).body.ambulances.find(a => a.ambulance_id === unit);
    assert(['DISPATCHED', 'IN_TRANSIT'].includes(amb.status) && amb.assigned_request_id === ctx.refCase, `server unit ${JSON.stringify({ s: amb.status, r: amb.assigned_request_id })}`);
  });

  // ═══════════════════════════ Fleet ═══════════════════════════
  const para = await newPage('paramedic');
  await step('P1. Fleet: navigation is exactly the Fleet set, labelled Fleet; the fleet shows only the own unit', async () => {
    await loginUI(para, PARAMEDIC);
    await expectNav(para, NAV.PARAMEDIC);
    assert(/\(Fleet\)/.test(await text(para, '#userRoleTitle')), 'role label is not Fleet');
    await openTab(para, 'tab-ambulance');
    await waitFor(para, () => document.querySelectorAll('#ambulanceFleetGrid [data-ambulance-id]').length > 0);
    const units = await para.$$eval('#ambulanceFleetGrid [data-ambulance-id]', cs => cs.map(c => c.dataset.ambulanceId));
    assert(units.length === 1 && units[0] === PARAMEDIC.ambulance_id, `fleet shows ${units.join(', ')}`);
  });

  await step('P2. Fleet: takes the own unit out of service and back; the store follows', async () => {
    const own = PARAMEDIC.ambulance_id;
    const set = await api(ctx.adminToken, `/ambulances/${own}/status`, { method: 'PATCH', body: { status: 'AVAILABLE' } });
    assert(set.status === 200, `set-up ${set.status}`);
    await press(para, '#refreshWorkspaceBtn');
    const card = `#ambulanceFleetGrid .hospital-card[data-ambulance-id="${own}"]`;
    const pressBtn = async label => {
      await waitFor(para, ([c, l]) => [...document.querySelectorAll(`${c} button`)].some(b => b.textContent === l && !b.disabled), [card, label]);
      await para.$$eval(`${card} button`, (bs, l) => bs.find(b => b.textContent === l).click(), label);
    };
    await pressBtn('Take out of service');
    await waitFor(para, s => /MAINTENANCE/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card);
    assert((await api(ctx.adminToken, '/ambulances')).body.ambulances.find(a => a.ambulance_id === own).status === 'MAINTENANCE', 'store not MAINTENANCE');
    await pressBtn('Return to service');
    await waitFor(para, s => /AVAILABLE/.test(document.querySelector(`${s} .badge-status`)?.textContent || ''), card);
    assert((await api(ctx.adminToken, '/ambulances')).body.ambulances.find(a => a.ambulance_id === own).status === 'AVAILABLE', 'store not AVAILABLE');
  });

  await step('P3. Fleet: cross-role denial (other unit, accounts, accept, audit, hospital detail, admin demo tracking) and force-shown tabs', async () => {
    const other = (await api(ctx.adminToken, '/ambulances')).body.ambulances.find(a => a.ambulance_id !== PARAMEDIC.ambulance_id).ambulance_id;
    await expectDenied(tokens.PARAMEDIC, [
      ['PATCH', `/ambulances/${other}/status`, { status: 'MAINTENANCE' }], ['GET', `/ambulances/${other}`], ['GET', '/admin/users'],
      ['POST', `/referrals/${ctx.refAcceptance}/accept`], ['GET', '/audit/verify'], ['GET', '/hospitals/H-101'], ['GET', '/analytics/history?days=28'], ['POST', '/tracking/demo-setup']
    ]);
    const calls = await forceShow(para, ['tab-acceptance', 'tab-doctors', 'tab-activity', 'tab-analytics', 'tab-accounts']);
    const bad = calls.filter(c => RESTRICTED.some(re => re.test(c)) || /\/api\/v1\/doctors/.test(c));
    assert(bad.length === 0, `restricted requests: ${bad.join(', ')}`);
  });

  // ═══════════════════════════ Roadside assist ═══════════════════════════
  const RS_NAME = `Roadside Rider ${randomBytes(2).toString('hex')}`;
  const RS_AT = { lat: 30.3139, lng: 78.0290 };
  await step('R1. Roadside: with GPS denied the Fleet user is told so, and the manual location is used', async () => {
    await para.browserContext().overridePermissions(ORIGIN, []); // no geolocation permission
    await openTab(para, 'tab-roadside');
    await press(para, '#rsGpsBtn');
    await waitOrExplain(para, () => /permission was denied/.test(document.getElementById('rsGpsStatus').textContent));
    assert(/Type the place and its latitude and longitude/.test(await text(para, '#rsGpsStatus')), 'no manual-entry guidance after the denial');
    // Validation: coordinates out of range are refused in place.
    await para.$eval('#rsLat', n => { n.value = '123'; }); await para.$eval('#rsLng', n => { n.value = '78.02'; });
    await para.$eval('#rsInjuries', n => { n.value = 'x'; });
    await press(para, '#rsAssessBtn');
    await waitFor(para, () => /Latitude must be/.test(document.getElementById('rsFormError').textContent));
  });

  await step('R2. Roadside: triage aid and live hospital ranking for the roadside location', async () => {
    await para.$eval('#rsPlace', n => { n.value = 'Connaught Place outer circle'; });
    await para.$eval('#rsLat', (n, v) => { n.value = String(v); }, RS_AT.lat);
    await para.$eval('#rsLng', (n, v) => { n.value = String(v); }, RS_AT.lng);
    await para.$eval('#rsInjuries', n => { n.value = 'Rider is unconscious after the crash'; });
    await para.$eval('#rsTags [data-symptom="arterial_bleeding"]', b => b.click());
    await para.$eval('#rsName', (n, v) => { n.value = v; }, RS_NAME);
    await para.$eval('#rsAge', n => { n.value = '34'; });
    await press(para, '#rsAssessBtn');
    await waitOrExplain(para, () => document.getElementById('rsTriage') && document.querySelectorAll('#rsHospitals .hospital-card').length > 0);
    const triage = await para.$eval('#rsTriage', n => ({ level: n.dataset.level, type: n.dataset.type, text: n.textContent }));
    assert(triage.level === '1' && triage.type === 'TRAUMA' && /Decision aid, not a diagnosis/.test(triage.text) && /Unconscious/.test(triage.text), `triage: ${JSON.stringify(triage).slice(0, 200)}`);
    const hs = (await api(ctx.adminToken, '/hospitals')).body.hospitals;
    const cards = await para.$$eval('#rsHospitals .hospital-card', cs => cs.map(c => ({ id: c.dataset.hospitalId, eligible: c.dataset.eligible === 'true', distance: c.querySelector('.rs-distance').textContent, reasons: c.querySelectorAll('.exclusion-list li').length })));
    assert(cards.length === hs.length, `${cards.length} cards for ${hs.length} hospitals`);
    for (const c of cards) {
      const h = hs.find(x => x.hospital_id === c.id);
      const want = h.location_lat === null ? 'Distance unknown' : `${haversineKm(RS_AT.lat, RS_AT.lng, Number(h.location_lat), Number(h.location_lng)).toFixed(1)} km away`;
      assert(c.distance === want, `${c.id}: distance "${c.distance}", expected "${want}"`);
      assert(c.eligible || c.reasons > 0, `${c.id} excluded without a reason`);
    }
    assert(cards[0].eligible, 'the top-ranked hospital is not suitable');
    ctx.rsHospital = cards[0].id;
  });

  await step('R2b. Roadside: no unsourced first-aid text; one "First aid steps" link opens the First Aid Guide, with Call 112', async () => {
    const shown = await para.$eval('#rsResult', n => n.textContent);
    const leaked = SYMPTOM_DATABASE.map(sym => sym.firstAid).filter(t => t && shown.includes(t.slice(0, 40)));
    assert(leaked.length === 0, `symptom_triage first-aid text shown: ${leaked.map(t => t.slice(0, 50)).join(' | ')}`);
    assert(!/First aid while help is on the way/.test(shown), 'the old first-aid panel is still rendered');
    const links = await para.$$eval('#rsGuide button, #rsGuide .rs-guide-link', bs => [...new Set(bs)].map(b => b.textContent));
    assert(JSON.stringify(links) === JSON.stringify(['First aid steps']), `guide links: ${links.join(', ')}`);
    assert(await para.$eval('#rsGuide a[href="tel:112"]', a => a.textContent === 'Call 112'), 'no Call 112 link');
    await press(para, '#rsFirstAidLink');
    await waitOrExplain(para, () => !document.getElementById('firstAidOverlay').hidden && document.querySelectorAll('#firstAidOverlayBody .fa-step').length === 4);
    await checkGuide(para, '#firstAidOverlayBody');
    await press(para, '#firstAidClose');
    await waitFor(para, () => document.getElementById('firstAidOverlay').hidden && document.activeElement?.id === 'rsFirstAidLink');
  });

  await step('R3. Roadside: pre-alert whose answer is lost, then retried, registers exactly one case, which the admin opens by ID', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED/ });
    forwarded.length = 0;
    para.__rules.push({ once: true, match: r => r.url() === `${ORIGIN}/api/v1/emergencies` && r.method() === 'POST', action: forwardThenDrop });
    await press(para, '#rsPreAlertBtn');
    await waitOrExplain(para, () => /Outcome unknown/.test(document.getElementById('rsPreAlertMessage')?.textContent || ''));
    assert(forwarded.length === 1 && forwarded[0].status === 201, `the pre-alert did not reach the server: ${forwarded.map(f => f.status)}`);
    await press(para, '#rsPreAlertBtn'); // the retry: same submission
    await waitOrExplain(para, () => document.getElementById('rsCaseStatus'));
    const msg = await text(para, '#rsPreAlertMessage');
    assert(/already registered by your earlier attempt/.test(msg), `retry message: ${msg}`);
    const mine = (await api(ctx.adminToken, '/emergencies')).body.queue.filter(q => q.patient?.full_name === RS_NAME);
    assert(mine.length === 1, `${mine.length} cases named ${RS_NAME} on the server`);
    const c = mine[0];
    assert(c.priority === 1 && c.emergency_type === 'TRAUMA' && Math.abs(Number(c.pickup_lat) - RS_AT.lat) < 1e-6 && Math.abs(Number(c.pickup_lng) - RS_AT.lng) < 1e-6,
      `case fields ${JSON.stringify({ p: c.priority, t: c.emergency_type, lat: c.pickup_lat, lng: c.pickup_lng })}`);
    ctx.rsCase = c.request_id;
    await openTab(admin, 'tab-ingestion');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, ctx.rsCase);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, r => document.getElementById('caseTrackerCaption').textContent.startsWith(r), ctx.rsCase);
  });

  await step('R4. Roadside: a referral from the roadside screen shows its countdown; the store holds it', async () => {
    const btn = `#rsHospitals .hospital-card[data-hospital-id="${ctx.rsHospital}"] .btn-rs-referral:not([disabled])`;
    await waitOrExplain(para, b => document.querySelector(b), btn);
    await press(para, btn);
    await waitOrExplain(para, () => document.getElementById('rsCaseStatus')?.dataset.state === 'pending' && /\d+s/.test(document.getElementById('rsCaseStatus').textContent));
    const d = (await api(ctx.adminToken, `/emergencies/${ctx.rsCase}`)).body;
    assert(d.acceptances.some(a => a.status === 'PENDING' && a.hospital_id === ctx.rsHospital), 'no pending referral on the server');
  });

  // ═══════════════════════════ Analytics / Monitoring (ADMIN only) ═══════════════════════════
  await step('An1. My registered patients: the admin\'s UI-registered case appears; acceptance and dispatch times match the server; another admin\'s case never does', async () => {
    // Another admin registers a case: it must never appear in this admin's list.
    const other = { username: `admin2_${randomBytes(3).toString('hex')}`, password: randomBytes(15).toString('base64url'), role: 'ADMIN' };
    const made = await api(ctx.adminToken, '/admin/users', { method: 'POST', body: other });
    assert(made.status === 201, `second admin ${made.status}`);
    const otherToken = await apiLogin(other);
    const foreign = await api(otherToken, '/emergencies', { method: 'POST', body: { patient_name: 'Other Admin Patient', age: 50, emergency_type: 'GENERAL', triage_priority: 3, pickup_lat: 30.32, pickup_lng: 78.03 } });
    assert(foreign.status === 201, `other admin's case ${foreign.status}`);
    // This admin registers a case in the UI.
    const name = `Admin Registered ${randomBytes(2).toString('hex')}`;
    await openTab(admin, 'tab-ingestion');
    await fillIntake(admin, { name, age: 63, lat: 30.3205, lng: 78.0305 });
    await admin.select('#emergencyTypeSelect', 'GENERAL');
    await press(admin, '#intakeSubmitBtn');
    await waitOrExplain(admin, () => /Registered REQ-/.test(document.getElementById('globalNotificationBanner').textContent));
    const rid = (await text(admin, '#globalNotificationBanner')).match(/REQ-[A-Za-z0-9-]+/)[0].replace(/\.$/, '');
    await openTab(admin, 'tab-analytics');
    await press(admin, '#refreshWorkspaceBtn');
    const rowSel = `#registrationsTable tr[data-request-id="${rid}"]`;
    await waitOrExplain(admin, r => document.querySelector(r), rowSel);
    assert(await admin.$eval(`${rowSel} .patient-name`, n => n.textContent) === name, 'wrong patient name in the row');
    const heads = await admin.$$eval('#registrationsTable thead th', ts => ts.map(t => t.textContent));
    assert(heads.includes('To first dispatch') && !heads.includes('To dispatch'), `dispatch column is not labelled as the first dispatch: ${heads.join(', ')}`);
    // A desk accepts and a unit is dispatched; the times appear (live or on refresh) and match the server.
    const init = await api(ctx.adminToken, '/referrals/initiate', { method: 'POST', body: { request_id: rid, hospital_id: 'H-104' } });
    assert(init.status === 201, `referral ${init.status} ${JSON.stringify(init.body)}`);
    const deskToken = await apiLogin(acct('HOSPITAL_DESK', x => x.hospital_id === 'H-104'));
    const acc = await api(deskToken, `/referrals/${init.body.acceptance_id}/accept`, { method: 'POST' });
    assert(acc.status === 200, `desk accept ${acc.status}`);
    let detail = (await api(ctx.adminToken, `/emergencies/${rid}`)).body;
    if (!detail.request.assigned_ambulance_id) {
      // Any unit will do: a free one, else one is first returned to service by the admin.
      const units = (await api(ctx.adminToken, '/ambulances')).body.ambulances;
      const unit = units.find(x => x.status === 'AVAILABLE') || units.find(x => x.status === 'MAINTENANCE') || units[0];
      if (unit.status !== 'AVAILABLE') {
        const freed = await api(ctx.adminToken, `/ambulances/${unit.ambulance_id}/status`, { method: 'PATCH', body: { status: 'AVAILABLE' } });
        assert(freed.status === 200, `freeing ${unit.ambulance_id}: ${freed.status}`);
      }
      const disp = await api(ctx.adminToken, `/ambulances/${unit.ambulance_id}/status`, { method: 'PATCH', body: { status: 'DISPATCHED', request_id: rid } });
      assert(disp.status === 200, `dispatch ${disp.status}`);
    }
    const server = async () => (await api(ctx.adminToken, '/analytics/my-registrations?days=28&limit=500')).body;
    let mine = (await server()).cases.find(c => c.request_id === rid);
    assert(mine.minutes_to_acceptance !== null && mine.minutes_to_dispatch !== null, `server milestones ${JSON.stringify(mine)}`);
    await press(admin, '#refreshWorkspaceBtn');
    await waitOrExplain(admin, ([r, a, d]) => {
      const cells = document.querySelectorAll(`${r} .cell-minutes`);
      return cells.length === 3 && cells[0].textContent === a && cells[1].textContent === d;
    }, [rowSel, fmtMinutes(mine.minutes_to_acceptance), fmtMinutes(mine.minutes_to_dispatch)]);
    assert(await admin.$eval(`${rowSel} td:nth-child(7)`, n => n.textContent) === mine.accepted_hospital_name, 'accepted hospital differs from the server');
    const listed = await admin.$$eval('#registrationsTable tbody tr[data-request-id]', rs => rs.map(r => r.dataset.requestId));
    const report = await server();
    assert(!listed.includes(foreign.body.request_id), 'another admin\'s case is listed');
    assert(JSON.stringify(listed) === JSON.stringify(report.cases.map(c => c.request_id)), `UI rows differ from the server: ${listed.length} vs ${report.cases.length}`);
    // A row opens the case in the tracker.
    await press(admin, rowSel);
    await waitOrExplain(admin, r => document.getElementById('tab-ingestion').classList.contains('active') && document.getElementById('caseTrackerCaption').textContent.startsWith(r), rid);
    // The audit chain still verifies.
    await openTab(admin, 'tab-activity');
    await press(admin, '#btnVerifyAuditChain');
    await waitFor(admin, () => document.getElementById('auditVerifyStatus'));
    assert(/Chain intact/.test(await text(admin, '#auditVerifyStatus')), 'chain not intact');
  });

  await step('An2. Analytics: every other role is refused the monitoring endpoints and has no Analytics or Audit tab', async () => {
    for (const [roleName, token] of Object.entries(tokens)) {
      await expectDenied(token, [['GET', '/analytics/my-registrations?days=28'], ['GET', '/analytics/history?days=28'], ['GET', '/analytics/forecast'], ['GET', '/analytics/audit'], ['GET', '/analytics/referrals'], ['GET', '/audit/verify'], ['GET', '/admin/patients']]);
      assert(!NAV[roleName].includes('tab-analytics') && !NAV[roleName].includes('tab-activity'), `${roleName} nav set includes monitoring`);
    }
  });

  await step('S1. Staged trauma: the admin advances an accepted trauma case to stage 2 from the tracker (OT released, ICU bed committed at stage 2); other roles get no button and a 403', async () => {
    const created = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: { patient_name: 'Staged Trauma Patient', age: 41, emergency_type: 'TRAUMA', triage_priority: 1, pickup_lat: 30.32, pickup_lng: 78.03 } });
    assert(created.status === 201 && created.body.claim?.length === 2, `staged case: ${created.status} ${JSON.stringify(created.body.claim)}`);
    const rid = created.body.request_id;
    let holder = null;
    for (const h of (await api(ctx.adminToken, '/hospitals')).body.hospitals) {
      const init = await api(ctx.adminToken, '/referrals/initiate', { method: 'POST', body: { request_id: rid, hospital_id: h.hospital_id } });
      if (init.status !== 201) continue;
      const acc = await api(ctx.adminToken, `/referrals/${init.body.acceptance_id}/accept`, { method: 'POST' });
      if (acc.status === 200) { holder = h.hospital_id; break; }
    }
    assert(holder, 'no hospital accepted the trauma case');
    const typeOf = id => ({ OT: 'OT', ICU: 'ICU_BED', VNT: 'VENTILATOR' })[String(id).split('-').pop()];
    let d = (await api(ctx.adminToken, `/emergencies/${rid}`)).body;
    assert(d.request.status === 'ALLOCATED' && (Number(d.request.current_stage) || 1) === 1, `before: ${d.request.status} stage ${d.request.current_stage}`);
    assert(d.allocations.some(a => typeOf(a.resource_id) === 'OT' && a.status === 'COMMITTED' && Number(a.stage_no) === 1), `stage-1 allocations: ${JSON.stringify(d.allocations.map(a => [a.resource_id, a.status, a.stage_no]))}`);
    // Roles the server refuses (the holding hospital's own desk may advance its case): a refusal from the server.
    await expectDenied(tokens.PARAMEDIC, [['POST', `/emergencies/${rid}/advance-stage`]]);
    const otherDeskToken = await apiLogin(acct('HOSPITAL_DESK', x => x.hospital_id !== holder));
    await expectDenied(otherDeskToken, [['POST', `/emergencies/${rid}/advance-stage`]], [403, 404]);
    // The admin advances it in the tracker.
    await openTab(admin, 'tab-ingestion');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, rid);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, () => document.getElementById('btnAdvanceStage'));
    await press(admin, '#btnAdvanceStage');
    await waitOrExplain(admin, () => document.getElementById('stagePanel')?.dataset.phase === 'confirm');
    const release = await text(admin, '#stageRelease'); const claim = await text(admin, '#stageClaim');
    assert(/Emergency OT/.test(release) && /Trauma surgeon/.test(release) && /ICU bed/.test(claim), `preview: ${release} | ${claim}`);
    admin.__api.length = 0;
    await admin.$eval('#btnConfirmAdvance', b => { b.click(); b.click(); }); // a double click sends one request
    await waitOrExplain(admin, () => document.getElementById('stagePanel')?.dataset.phase === 'done');
    const posts = admin.__api.filter(c => c === `POST /api/v1/emergencies/${rid}/advance-stage`);
    assert(posts.length === 1, `${posts.length} advance requests for one confirmation`);
    d = (await api(ctx.adminToken, `/emergencies/${rid}`)).body;
    assert(Number(d.request.current_stage) === 2, `stage after: ${d.request.current_stage}`);
    const ot = d.allocations.filter(a => typeOf(a.resource_id) === 'OT');
    const icu = d.allocations.filter(a => typeOf(a.resource_id) === 'ICU_BED');
    assert(ot.length && ot.every(a => a.status === 'RELEASED'), `OT allocations: ${JSON.stringify(ot.map(a => [a.status, a.stage_no]))}`);
    assert(icu.some(a => a.status === 'COMMITTED' && Number(a.stage_no) === 2), `ICU allocations: ${JSON.stringify(icu.map(a => [a.status, a.stage_no]))}`);
    const audit = (await api(ctx.adminToken, `/emergencies/${rid}/audit`)).body.audit_trail.find(e => e.event_type === 'STAGE_ADVANCED');
    const meta = typeof audit?.metadata === 'string' ? JSON.parse(audit.metadata) : audit?.metadata;
    const shownIds = await admin.$eval('#stageReleasedSpecialists', n => n.dataset.ids);
    assert(meta && shownIds === (meta.released_specialists || []).join(',') && shownIds.length > 0, `released specialist shown "${shownIds}", server ${JSON.stringify(meta?.released_specialists)}`);
    assert(/Released: Emergency OT/.test(await text(admin, '#stageReleased')) && /Claimed: ICU bed/.test(await text(admin, '#stageAllocated')), 'result text');
    await waitFor(admin, () => !document.getElementById('btnAdvanceStage')); // no stage 3
  });

  await step('S2. Staged trauma, answer lost: the advance POST reaches the server but its answer is dropped; the UI reads the case back (one POST), shows the server\'s stage and labels the lists as expected', async () => {
    allowedConsole.push({ step: currentStep, re: /net::ERR_FAILED/ });
    const created = await api(ctx.adminToken, '/emergencies', { method: 'POST', body: { patient_name: 'Staged Trauma Lost Answer', age: 38, emergency_type: 'TRAUMA', triage_priority: 1, pickup_lat: 30.32, pickup_lng: 78.03 } });
    assert(created.status === 201, `case ${created.status}`);
    const rid = created.body.request_id;
    let holder = null;
    for (const h of (await api(ctx.adminToken, '/hospitals')).body.hospitals) {
      const init = await api(ctx.adminToken, '/referrals/initiate', { method: 'POST', body: { request_id: rid, hospital_id: h.hospital_id } });
      if (init.status !== 201) continue;
      if ((await api(ctx.adminToken, `/referrals/${init.body.acceptance_id}/accept`, { method: 'POST' })).status === 200) { holder = h.hospital_id; break; }
    }
    assert(holder, 'no hospital accepted the trauma case');
    await openTab(admin, 'tab-ingestion');
    await admin.$eval('#openCaseId', (n, v) => { n.value = v; }, rid);
    await press(admin, '#openCaseBtn');
    await waitOrExplain(admin, r => document.getElementById('caseTrackerCaption').textContent.startsWith(r) && document.getElementById('btnAdvanceStage'), rid);
    await press(admin, '#btnAdvanceStage');
    await waitOrExplain(admin, () => document.getElementById('stagePanel')?.dataset.phase === 'confirm');
    forwarded.length = 0;
    const url = `${ORIGIN}/api/v1/emergencies/${rid}/advance-stage`;
    admin.__rules.push({ once: true, match: r => r.url() === url && r.method() === 'POST', action: forwardThenDrop });
    admin.__api.length = 0;
    await press(admin, '#btnConfirmAdvance');
    await waitOrExplain(admin, () => ['done', 'error'].includes(document.getElementById('stagePanel')?.dataset.phase));
    assert(forwarded.length === 1 && forwarded[0].status === 200, `the advance did not reach the server: ${forwarded.map(f => f.status)}`);
    const calls = [...admin.__api];
    const posts = calls.filter(c => c === `POST /api/v1/emergencies/${rid}/advance-stage`);
    const postAt = calls.indexOf(`POST /api/v1/emergencies/${rid}/advance-stage`);
    const readBack = calls.slice(postAt + 1).includes(`GET /api/v1/emergencies/${rid}`);
    assert(posts.length === 1, `${posts.length} advance POSTs (a lost answer must be read back, not retried)`);
    assert(readBack, `no read-back of the case after the lost answer: ${calls.join(', ')}`);
    const panel = await admin.$eval('#stagePanel', n => ({ phase: n.dataset.phase, stage: n.dataset.stage, recovered: n.dataset.recovered, text: n.textContent }));
    const server = (await api(ctx.adminToken, `/emergencies/${rid}`)).body;
    assert(Number(server.request.current_stage) === 2, `server stage ${server.request.current_stage}`);
    assert(panel.phase === 'done' && panel.stage === '2' && panel.recovered === 'true', `panel: ${JSON.stringify(panel).slice(0, 200)}`);
    assert(!/not advanced|Stage not advanced/i.test(panel.text), `a "not advanced" message after a committed advance: ${panel.text}`);
    assert(/Expected to release: .*Emergency OT/.test(panel.text) && /Expected to claim: .*ICU bed/.test(panel.text) && /not confirmed/.test(panel.text), `expected lists: ${panel.text}`);
    assert(!(await admin.$('#stageReleased')) && !(await admin.$('#stageAllocated')), 'predicted lists are labelled as confirmed');
  });

  await step('X1. Same tab, admin signs out and a Fleet user signs in: nothing from the admin session remains anywhere in the DOM', async () => {
    // What the admin session showed: account usernames and staff names, and patients the Fleet login may not see.
    const fleet = SECOND_FLEET; // its own address: the lockout in L2 was for the L2 page's address only
    const users = (await api(ctx.adminToken, '/admin/users?limit=200')).body.users;
    const cases = (await api(ctx.adminToken, '/emergencies')).body.queue;
    const fleetToken = await apiLogin(fleet);
    assert(fleetToken, 'the Fleet login for X1 failed');
    const visible = new Set(((await api(fleetToken, '/emergencies')).body.queue || []).map(c => c.patient?.full_name));
    const me = users.find(u => u.username === fleet.username);
    const secrets = [...new Set([
      ...users.filter(u => u.username !== fleet.username).map(u => u.username),
      ...users.filter(u => u.username !== fleet.username && u.display_name !== me?.display_name).map(u => u.display_name),
      ...cases.map(c => c.patient?.full_name).filter(n => !visible.has(n))
    ].filter(v => typeof v === 'string' && v.length >= 5))];
    // The admin has had Accounts, cases and the tracker open in this tab.
    await openTab(admin, 'tab-accounts');
    await waitOrExplain(admin, () => document.querySelectorAll('#accountsTableBody tr[data-user-id]').length > 0);
    await press(admin, '#logoutBtn');
    await waitFor(admin, () => document.body.classList.contains('signed-out'));
    await waitFor(admin, () => document.activeElement?.id === 'loginUsername');
    assert(await admin.$eval('#loginUsername', n => n.value) === '', 'the previous user\'s username is still in the sign-in form');
    await admin.type('#loginUsername', fleet.username);
    await admin.type('#loginPassword', fleet.password);
    await press(admin, '#loginSubmitBtn');
    await waitOrExplain(admin, () => !document.body.classList.contains('signed-out') && document.getElementById('connectionStatus')?.textContent === 'Live');
    await sleep(1500);
    const found = await admin.evaluate(list => {
      const dom = document.documentElement.textContent; // hidden elements included
      const values = [...document.querySelectorAll('input, textarea, select')].map(n => n.value).join('\n');
      const attrs = [...document.querySelectorAll('[title], [aria-label], [data-username]')].map(n => [n.title, n.getAttribute('aria-label'), n.dataset.username].join(' ')).join('\n');
      return list.filter(v => dom.includes(v) || values.includes(v) || attrs.includes(v));
    }, secrets);
    assert(secrets.length > 20, `too few strings to check (${secrets.length})`);
    assert(found.length === 0, `the Fleet user's page still holds the admin session's data: ${found.slice(0, 8).join(' | ')}${found.length > 8 ? ` (+${found.length - 8})` : ''}`);
  });

  // ═══════════════════════════ First aid guide ═══════════════════════════
  await step('FA1. First aid, signed out: the guide opens from the sign-in screen with no API request and no socket', async () => {
    const page = await newPage('firstaid-signedout');
    const net = [];
    page.on('request', r => { const u = r.url(); if (u.startsWith(`${ORIGIN}/api/`) || /\/socket\.io\/\?/.test(u)) net.push(`${r.method()} ${u}`); });
    page.on('websocket', () => net.push('websocket'));
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', e => net.push(`websocket ${e.url}`));
    await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await press(page, '#firstAidLink');
    await waitOrExplain(page, () => !document.getElementById('firstAidOverlay').hidden && document.querySelectorAll('#firstAidOverlayBody .fa-step').length === 4);
    await checkGuide(page, '#firstAidOverlayBody');
    await sleep(1500);
    assert(net.length === 0, `requests while signed out: ${net.join(', ')}`);
    await press(page, '#firstAidClose');
    await waitFor(page, () => document.getElementById('firstAidOverlay').hidden);
    assert(await page.evaluate(() => document.body.classList.contains('signed-out') && document.activeElement?.id === 'firstAidLink'), 'not back on the sign-in screen with focus on the link');
    assert(net.length === 0, `requests after closing: ${net.join(', ')}`);
    ctx.signedOutGuidePage = page;
  });

  await step('FA2. First aid: Admin, Hospital and Fleet each open the same guide from the First aid tab', async () => {
    const staff = await newPage('admin-firstaid');
    await loginUI(staff, ADMIN);
    for (const [label, page] of [['admin', staff], ['hospital', desk], ['fleet', para]]) {
      await openTab(page, 'tab-firstaid');
      await waitOrExplain(page, () => document.querySelectorAll('#firstAidStaff .fa-step').length === 4);
      try { await checkGuide(page, '#firstAidStaff'); } catch (err) { throw new Error(`${label}: ${err.message}`); }
    }
  });

  if (PART !== 'main') await stepMobile(deskAcct);
  await stepFinal();

}

let exitCode = 1;
try {
  await main();
  exitCode = results.every(r => r.ok) ? 0 : 1;
} catch (err) {
  console.log(`ABORT ${err.stack || err.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  if (server && server.exitCode === null) server.kill('SIGTERM');
}
console.log(`\n${results.filter(r => r.ok).length}/${results.length} steps passed.`);
process.exit(exitCode);
