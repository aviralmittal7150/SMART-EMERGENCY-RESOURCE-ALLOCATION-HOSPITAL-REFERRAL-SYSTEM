// Batch 8 (simplified product): an EXISTING account with a retired role (DISPATCHER, PATIENT), e.g. left by an earlier
// seed, can no longer be used: its sign-in gets the same generic 401 as a wrong password, an existing token gets 401 with
// the account-change message on REST, and the socket handshake is refused. Only the test-only ENABLE_RETIRED_ROLES=1
// re-enables them, and a production server refuses to start with it set.
//  - in-memory store: in process (the login and /auth/me routes, and resolveAccount, which the socket handshake uses);
//  - MySQL test database: a real `node server/server.js` with the rows inserted directly, REST and a real socket.
// All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { connectSocket } from './helpers/rawSocket.js';
import { openTestDatabase, mysqlServerEnv } from './helpers/mysqlTestDb.js';

const SECRET = 'retired-roles-test-secret-0123456789abcdef';
process.env.JWT_SECRET = SECRET;
delete process.env.ENABLE_RETIRED_ROLES;
const PASSWORD = 'Fictional-Retired-Pass-73';
const GENERIC_LOGIN = 'Invalid credentials. Please check username and password.';
const REVOKED = 'Your session was ended by an account change. Please sign in again.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { MemoryStore } = await import('../server/db/memoryStore.js');
const { configureStore } = await import('../server/db/store.js');
const { generateToken, verifyToken, resolveAccount } = await import('../server/middleware/auth.js');
const authRoutes = (await import('../server/routes/auth.js')).default;
const { accountUsable } = await import('../server/services/accounts.js');

const hash = await bcrypt.hash(PASSWORD, 4);
const retired = [
  { user_id: 'USER-RR-DSP', username: 'fictional.rr.dispatch', role: 'DISPATCHER', patient_id: null },
  { user_id: 'USER-RR-PAT', username: 'fictional.rr.patient', role: 'PATIENT', patient_id: 'PAT-001' }
].map(u => ({ ...u, password_hash: hash, hospital_id: null, ambulance_id: null, display_name: u.username, is_active: 1, is_demo: 0, token_version: 0 }));

async function post(base, path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('in-memory store: existing DISPATCHER / PATIENT rows cannot sign in, their tokens are refused (REST and the socket handshake check)', async () => {
  const store = new MemoryStore();
  configureStore(store);
  for (const row of retired) store.db.systemUsers.push({ ...row });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const row of retired) {
      const login = await post(base, '/api/v1/auth/login', { username: row.username, password: PASSWORD });
      const wrong = await post(base, '/api/v1/auth/login', { username: row.username, password: 'wrong-password' });
      assert.deepEqual([login.status, login.body], [401, wrong.body], `${row.role}: the same generic 401 as a wrong password`);
      assert.equal(login.body.error, GENERIC_LOGIN);
      const token = generateToken(row);
      const me = await post(base, '/api/v1/auth/me', undefined, token);
      assert.deepEqual([me.status, me.body.error], [401, REVOKED], `${row.role}: an existing token is refused with the account-change message`);
      assert.deepEqual(await resolveAccount(verifyToken(token)), { reason: 'revoked' }, `${row.role}: the socket handshake's check refuses it`);
    }
    // The three product roles are unaffected.
    assert.equal((await post(base, '/api/v1/auth/login', { username: 'apex_desk', password: 'hospital123' })).status, 200);
    assert.equal((await store.countUsableAdmins()), 0, 'counts are unaffected (no real admin in the demo store)');
    // TESTS ONLY: the flag re-enables them (outside production).
    process.env.ENABLE_RETIRED_ROLES = '1';
    assert.equal((await post(base, '/api/v1/auth/login', { username: 'fictional.rr.dispatch', password: PASSWORD })).status, 200);
    assert.equal(accountUsable(retired[1], { ENABLE_RETIRED_ROLES: '1', NODE_ENV: 'production' }), false, 'never in production');
  } finally {
    delete process.env.ENABLE_RETIRED_ROLES;
    server.close();
  }
});

test('a production server refuses to start with ENABLE_RETIRED_ROLES set', async () => {
  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', ENABLE_RETIRED_ROLES: '1', PORT: '4276', DB_USE_MEMORY: 'true', JWT_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', chunk => { out += chunk; });
  proc.stderr.on('data', chunk => { out += chunk; });
  const code = await Promise.race([once(proc, 'exit').then(([c]) => c), sleep(15_000).then(() => 'still running')]);
  if (code === 'still running') { proc.kill('SIGTERM'); await once(proc, 'exit'); }
  assert.equal(code, 1);
  assert.match(out, /ENABLE_RETIRED_ROLES is a test setting/);
});

// ── MySQL: a real server, rows inserted directly, REST and a real socket ─────
const database = await openTestDatabase();
if (database.skip) {
  test.skip(`MySQL: retired roles (skipped: ${database.skip})`, () => {});
} else {
  test('MySQL store: existing DISPATCHER / PATIENT rows cannot sign in; their tokens are refused on REST and at the socket handshake', async () => {
    const PORT = 4277;
    const base = `http://127.0.0.1:${PORT}`;
    let server = null;
    try {
      await database.reset(true);
      for (const row of retired) {
        await database.admin.query(`INSERT INTO SystemUser (user_id, username, password_hash, role, patient_id, display_name, is_active, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, 1, 0)`, [row.user_id, row.username, row.password_hash, row.role, row.patient_id, row.display_name]);
      }
      server = spawn(process.execPath, ['server/server.js'], {
        cwd: process.cwd(), env: mysqlServerEnv(PORT, { JWT_SECRET: SECRET, JWT_EXPIRES: '', TRUST_PROXY: '', ENABLE_RETIRED_ROLES: '' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let log = '';
      server.stdout.on('data', chunk => { log += chunk; });
      server.stderr.on('data', chunk => { log += chunk; });
      for (let i = 0; ; i += 1) {
        if (server.exitCode !== null) throw new Error(`server exited:\n${log}`);
        try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
        if (i > 150) throw new Error(`server did not start:\n${log}`);
        await sleep(100);
      }
      for (const row of retired) {
        const login = await post(base, '/api/v1/auth/login', { username: row.username, password: PASSWORD });
        const wrong = await post(base, '/api/v1/auth/login', { username: row.username, password: 'wrong-password' });
        assert.deepEqual([login.status, login.body], [401, wrong.body], `${row.role}: the same generic 401 as a wrong password`);
        const token = generateToken(row);
        const me = await post(base, '/api/v1/auth/me', undefined, token);
        assert.deepEqual([me.status, me.body.error], [401, REVOKED], `${row.role}: REST refuses the existing token`);
        const socket = await connectSocket(base, token);
        assert.deepEqual([socket.connected, socket.error], [false, REVOKED], `${row.role}: the socket handshake is refused`);
      }
      assert.equal((await post(base, '/api/v1/auth/login', { username: 'UNIT-402', password: 'paramedic123' })).status, 200, 'Fleet still signs in');
    } finally {
      if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
      try { await database.reset(true); } finally { await database.release(); }
    }
  });
}
