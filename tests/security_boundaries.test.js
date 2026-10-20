// Regression tests for public-asset exposure and per-role patient data scoping.
// Uses fictional patient data and a disposable in-memory server process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 4108;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return;
    } catch {
      // still starting
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API server did not become healthy within 10 seconds.');
}

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  return { response, body: await response.json().catch(() => null) };
}

async function login(username, password) {
  const { body } = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  return body.token;
}

test('server source is not public, frontend assets are, and desks only see their own cases', async t => {
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true' },
    stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));
  await waitForHealth();

  for (const path of ['/server/routes/auth.js', '/server/db/seed.js', '/package.json', '/tests/api_integration.test.js']) {
    const response = await fetch(`${BASE_URL}${path}`);
    assert.notEqual(response.headers.get('content-type')?.split(';')[0], 'text/javascript', path);
    assert.ok(!/admin123|"scripts"/.test(await response.text()), `${path} leaked source`);
  }
  for (const path of ['/', '/js/app.js', '/css/main.css', '/PRD.md']) {
    assert.equal((await fetch(`${BASE_URL}${path}`)).status, 200, path);
  }

  assert.equal((await api('/api/v1/emergencies')).response.status, 401);

  const paramedic = await login('UNIT-402', 'paramedic123');
  const desk101 = await login('apex_desk', 'hospital123');
  const desk102 = await login('stjude_desk', 'hospital123');

  const created = await api('/api/v1/emergencies', {
    method: 'POST',
    token: paramedic,
    body: JSON.stringify({
      patient_name: 'Fictional Scope Patient',
      age: 50,
      emergency_type: 'CARDIAC',
      triage_priority: 1
    })
  });
  assert.equal(created.response.status, 201);
  const requestId = created.body.request_id;

  // Before any referral, no desk can see the case.
  for (const token of [desk101, desk102]) {
    assert.ok(!(await api('/api/v1/emergencies', { token })).body.queue.some(r => r.request_id === requestId));
    assert.equal((await api(`/api/v1/emergencies/${requestId}`, { token })).response.status, 404);
  }

  const initiated = await api('/api/v1/referrals/initiate', {
    method: 'POST',
    token: paramedic,
    body: JSON.stringify({ request_id: requestId, hospital_id: 'H-101' })
  });
  assert.equal(initiated.response.status, 201);

  // Only the referred hospital's desk gains visibility, including the audit trail.
  assert.equal((await api(`/api/v1/emergencies/${requestId}`, { token: desk101 })).response.status, 200);
  assert.equal((await api(`/api/v1/emergencies/${requestId}/audit`, { token: desk101 })).response.status, 200);
  assert.equal((await api(`/api/v1/emergencies/${requestId}`, { token: desk102 })).response.status, 404);
  assert.equal((await api(`/api/v1/emergencies/${requestId}/audit`, { token: desk102 })).response.status, 404);
});
