// Socket.IO authentication: operational events require a valid token. Spawns a disposable server on the
// in-memory store (no database needed). The test speaks the Socket.IO protocol over HTTP polling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { connectSocket } from './helpers/rawSocket.js';

const PORT = 4140;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sockets need a valid token; valid ones get the snapshot and answer requests', async t => {
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    // A 3-second token lifetime lets the test observe expiry without waiting long.
    env: { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_EXPIRES: '3s', JWT_SECRET: 'socket-test-only-secret' },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    await sleep(150);
  }

  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();

  // 1. No token at all: refused, and no guest session is created.
  const anonymous = await connectSocket(BASE, undefined);
  assert.equal(anonymous.connected, false);
  assert.match(anonymous.error, /Authentication required/);
  assert.equal(anonymous.events.length, 0);

  // 2. Garbage and forged tokens are refused.
  const garbage = await connectSocket(BASE, 'not-a-jwt');
  assert.equal(garbage.connected, false);
  assert.match(garbage.error, /Invalid or expired/);
  const forged = await connectSocket(BASE, jwt.sign({ user_id: 'X', role: 'ADMIN' }, 'some-other-secret'));
  assert.equal(forged.connected, false);
  assert.match(forged.error, /Invalid or expired/);

  // 3. A valid token connects and immediately receives the state snapshot.
  const authed = await connectSocket(BASE, token);
  assert.equal(authed.connected, true);
  assert.equal(authed.error, null);
  assert.ok(await authed.waitFor(s => s.has('system:snapshot')), 'snapshot event received');
  const snapshot = authed.event('system:snapshot');
  assert.equal(snapshot.hospitals, 6);
  assert.ok(Number.isInteger(snapshot.active_locks));

  // 4. Handlers are registered before the async snapshot is built, so requests are answered.
  await authed.emit('request:kpis');
  assert.ok(await authed.waitFor(s => s.has('kpis:update')), 'request:kpis answered');
  assert.equal(authed.event('kpis:update').hospitals_open, 4);
  await authed.emit('request:active_locks');
  assert.ok(await authed.waitFor(s => s.has('locks:update')), 'request:active_locks answered');
  assert.deepEqual(authed.event('locks:update'), []);

  // 5. An expired token is refused.
  await sleep(3500);
  const expired = await connectSocket(BASE, token);
  assert.equal(expired.connected, false);
  assert.match(expired.error, /Invalid or expired/);
});
