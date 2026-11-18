// e2e/batch5/prod-smoke.mjs
// Production-mode smoke test on the MySQL TEST database (name must end in _test; helper lock held throughout).
//
//   B5_PORT=4420 B5_SHOTS=<dir> node e2e/batch5/prod-smoke.mjs
//
// 1. Reset + seed the _test DB (demo accounts present, is_demo = 1).
// 2. Create a real non-demo ADMIN with `npm run user:create` (password on stdin, never echoed or printed).
// 3. Start the server with NODE_ENV=production and a strong random JWT_SECRET.
// 4. Demo logins (with their documented demo passwords, read from tests/security_units.test.js and never printed)
//    are refused; the real admin signs in through the UI and the Command Center loads.
// 5. Reset the _test DB through the helper (the account is removed) and confirm it is gone.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import puppeteer from 'puppeteer';
import { DEMO_USERS } from '../../server/db/demoUsers.js';
import { ROOT, CHROME, assert, results, issues, state, note, step, ServerHandle, openMysql, makeApi, makeBrowserKit, summary, allowedConsole } from './lib.mjs';

const PORT = Number(process.env.B5_PORT || 4420);
state.shots = process.env.B5_SHOTS || path.join(ROOT, 'e2e', 'screenshots', 'batch5-prod');
mkdirSync(state.shots, { recursive: true });

/** The documented demo passwords, as { username: password }, parsed from the unit test (values stay in memory). */
function demoPasswords() {
  const src = readFileSync(path.join(ROOT, 'tests', 'security_units.test.js'), 'utf8');
  const m = src.match(/const expected = \{([^}]*)\}/);
  assert(m, 'demo password map not found in tests/security_units.test.js');
  const out = {};
  for (const pair of m[1].matchAll(/'?([\w-]+)'?\s*:\s*'([^']*)'/g)) out[pair[1]] = pair[2];
  return out;
}

let db; let server; let browser;
const REAL = { username: `b5_real_admin_${randomBytes(3).toString('hex')}`, password: randomBytes(24).toString('base64url') };

async function userCreate() {
  const c = db.config;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DB_') && k !== 'ERIS_USER_PASSWORD')),
    NODE_ENV: 'production', DB_USE_MEMORY: 'false', DB_HOST: c.host, DB_PORT: String(c.port), DB_NAME: c.database, DB_USER: c.user, DB_PASS: c.password ?? '' };
  assert(/_test$/.test(env.DB_NAME), 'refusing: not a _test database');
  const child = spawn('npm', ['run', 'user:create', '--', '--username', REAL.username, '--role', 'ADMIN', '--display-name', 'B5 Real Admin'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.stdin.end(`${REAL.password}\n`);
  const code = await new Promise(r => child.on('exit', r));
  assert(!out.includes(REAL.password), 'user:create output contains the password');
  return { code, out: out.replace(/\s+/g, ' ').trim() };
}

async function main() {
  db = await openMysql();
  note(`MySQL test DB "${db.config.database}" (ends in _test); advisory lock held`);
  await db.reset(true);

  await step('PS1. npm run user:create makes a real non-demo ADMIN (password on stdin, not echoed)', async () => {
    const r = await userCreate();
    note(`user:create exit ${r.code}: "${r.out.slice(-220)}"`);
    assert(r.code === 0, `user:create exit ${r.code}`);
    const [row] = (await db.admin.query('SELECT role, is_demo, is_active, password_hash FROM SystemUser WHERE username = ?', [REAL.username]))[0];
    assert(row && row.role === 'ADMIN' && Number(row.is_demo) === 0 && Number(row.is_active) === 1 && /^\$2[aby]\$1[2-9]\$/.test(row.password_hash), `SELECT ${JSON.stringify({ ...row, password_hash: row?.password_hash?.slice(0, 7) })}`);
    note(`SELECT: SystemUser ${REAL.username} role=${row.role} is_demo=${row.is_demo} is_active=${row.is_active} hash cost ${row.password_hash.slice(4, 6)}`);
    const [[d]] = await db.admin.query('SELECT COUNT(*) AS n FROM SystemUser WHERE is_demo = 1');
    note(`SELECT: ${d.n} demo accounts present in the store (they must be refused)`);
  });

  server = new ServerHandle({ backend: 'mysql', port: PORT, db });
  const A = makeApi(server);
  await step('PS2. NODE_ENV=production server starts with a strong JWT_SECRET; demo logins are refused', async () => {
    await server.start({ NODE_ENV: 'production' });
    assert(/demo account\(s\) exist/.test(server.log), `no start-up demo warning in the log: ${server.log.slice(-300)}`);
    const pw = demoPasswords();
    const tried = [];
    for (const [username, password] of Object.entries(pw)) {
      const u = DEMO_USERS.find(x => x.username === username);
      assert(u && await bcrypt.compare(password, u.password_hash), `documented demo password for ${username} does not match its hash`);
      const r = await A.api(null, '/auth/login', { method: 'POST', body: { username, password }, as: `demo-${username}` });
      tried.push(`${username}:${r.status}`);
      assert(r.status === 401 || r.status === 403, `demo login ${username} -> ${r.status}`);
    }
    await new Promise(r => setTimeout(r, 300));
    const refusedLog = (server.log.match(/Refused demo account "[^"]+"/g) || []);
    assert(refusedLog.length === tried.length, `server log refusals: ${refusedLog.join(', ')}`);
    note(`server log: ${refusedLog.join('; ')}`);
    note(`production: start-up warning present; demo logins with the CORRECT documented passwords refused: ${tried.join(', ')}`);
  });

  await step('PS3. The real admin signs in through the UI and the Command Center loads', async () => {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
    const K = makeBrowserKit(browser, server);
    allowedConsole.push({ step: '*', re: /status of 401/ });
    const page = await K.newPage('prod-admin');
    // The demo admin is refused in the UI too.
    await page.goto(server.origin, { waitUntil: 'networkidle2' });
    await K.waitFor(page, () => document.body.classList.contains('signed-out') && !document.body.classList.contains('booting'));
    await page.type('#loginUsername', 'admin'); await page.type('#loginPassword', demoPasswords().admin);
    await page.click('#loginSubmitBtn');
    await K.waitOrExplain(page, () => !document.getElementById('authFormError').hidden);
    const refused = await K.text(page, '#authFormError');
    assert(await page.evaluate(() => document.body.classList.contains('signed-out')), 'demo admin got in');
    await K.loginUI(page, REAL);
    await K.waitOrExplain(page, () => document.getElementById('tab-command')?.classList.contains('active') && /\d/.test(document.getElementById('kpiActiveEmergencies')?.textContent || '')
      && document.querySelectorAll('#hospitalsDirectoryGrid [data-hospital-id], #hospitalsDirectoryGrid .hospital-card').length > 0, null, 15000);
    const kpi = await K.text(page, '#kpiActiveEmergencies');
    const api = (await A.api(await K.token(page), '/analytics/dashboard')).body;
    await page.screenshot({ path: path.join(state.shots, 'prod-command-center.png') });
    note(`UI: demo admin refused ("${refused}"); real admin signed in, Command Center active, Live, active-emergencies KPI "${kpi}" (dashboard API ${JSON.stringify(api).slice(0, 120)})`);
  });

  await step('PS4. Clean-up: _test DB reset through the helper; the real admin account is gone', async () => {
    await server.stop();
    await db.reset(true);
    const [[r]] = await db.admin.query('SELECT COUNT(*) AS n FROM SystemUser WHERE username = ?', [REAL.username]);
    assert(Number(r.n) === 0, 'account still present');
    note(`SELECT after reset: SystemUser ${REAL.username} rows = ${r.n} (clean demo seed restored)`);
  });
}

let exitCode = 1;
try { await main(); exitCode = results.every(r => r.ok) && issues.length === 0 ? 0 : 1; } catch (err) { console.log(`ABORT ${err.stack || err.message}`); } finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await server?.stop(); } catch { /* ignore */ }
  if (db) { try { await db.reset(true); } catch (err) { console.log(`reset failed: ${err.message}`); } await db.release().catch(() => {}); }
}
summary('Batch 5 production smoke [mysql _test]');
process.exit(exitCode);
