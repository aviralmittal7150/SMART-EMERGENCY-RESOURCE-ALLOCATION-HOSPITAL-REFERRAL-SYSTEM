// API-level verification of the full emergency lifecycle over HTTP.
// Runs against the in-memory store by default; with API_TEST_BACKEND=mysql (see
// api_integration_mysql.test.js) the IDENTICAL scenario runs against the real MySQL test database,
// which is the parity check between the two storage backends.
// Uses fictional patient data and a disposable server process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { openTestDatabase, mysqlServerEnv } from './helpers/mysqlTestDb.js';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4117 : 4107;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForHealth(server) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return response.json();
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API server did not become healthy within 10 seconds.');
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

async function login(username, password) {
  const { response, body } = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  return body.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test(`connected API lifecycle persists read-back state and protects allocation boundaries [${BACKEND}]`, async t => {
  let env = { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true' };
  let database = null;
  if (BACKEND === 'mysql') {
    database = await openTestDatabase();
    if (database.skip) {
      t.skip(database.skip);
      return;
    }
    await database.reset(true); // fresh schema + demo data, test database only
    env = mysqlServerEnv(PORT);
  }

  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let stdout = '';
  server.stdout.on('data', chunk => { stdout += chunk.toString(); });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    await database?.release();
  });

  const health = await waitForHealth(server);
  assert.equal(health.status, 'OK');

  const paramedicToken = await login('UNIT-402', 'paramedic123');
  const hospitalToken = await login('apex_desk', 'hospital123');
  const adminToken = await login('admin', 'admin123');

  const created = await api('/api/v1/emergencies', {
    method: 'POST',
    headers: auth(paramedicToken),
    body: JSON.stringify({
      patient_name: 'Aarav Fictional',
      age: 42,
      gender: 'MALE',
      emergency_type: 'CARDIAC',
      triage_priority: 1,
      clinical_notes: 'Fictional smoke-test patient; no real clinical data.',
      pickup_lat: 28.631,
      pickup_lng: 77.219
    })
  });
  assert.equal(created.response.status, 201);
  const requestId = created.body.request_id;

  const queue = await api('/api/v1/emergencies', { headers: auth(paramedicToken) });
  const registered = queue.body.queue.find(item => item.request_id === requestId);
  assert.equal(registered.patient.full_name, 'Aarav Fictional');
  assert.deepEqual(registered.required_resource_types, ['ICU_BED', 'VENTILATOR']);
  assert.equal(registered.priority, 1);

  const hospitals = await api('/api/v1/hospitals', { headers: auth(paramedicToken) });
  const apex = hospitals.body.hospitals.find(item => item.hospital_id === 'H-101');
  assert.equal(apex.specialists.cardiologist, true);

  const initiated = await api('/api/v1/referrals/initiate', {
    method: 'POST',
    headers: auth(paramedicToken),
    body: JSON.stringify({ request_id: requestId, hospital_id: 'H-101' })
  });
  assert.equal(initiated.response.status, 201, `${JSON.stringify(initiated.body)}\n${stdout}\n${stderr}`);
  const acceptanceId = initiated.body.acceptance_id;

  const activeForHospital = await api('/api/v1/referrals/active', { headers: auth(hospitalToken) });
  assert.equal(activeForHospital.response.status, 200);
  assert.equal(activeForHospital.body.active_locks[0].requestId, requestId);

  const accepted = await api(`/api/v1/referrals/${acceptanceId}/accept`, {
    method: 'POST',
    headers: auth(hospitalToken)
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.status, 'ACCEPTED');
  assert.ok(accepted.body.ambulance_id);

  const afterAccept = await api(`/api/v1/emergencies/${requestId}`, { headers: auth(paramedicToken) });
  assert.equal(afterAccept.body.request.status, 'ALLOCATED');
  assert.equal(afterAccept.body.allocations.length, 2);
  assert.ok(afterAccept.body.allocations.every(allocation => allocation.status === 'COMMITTED'));

  const completed = await api(`/api/v1/emergencies/${requestId}/status`, {
    method: 'PATCH',
    headers: auth(adminToken),
    body: JSON.stringify({ status: 'COMPLETED' })
  });
  assert.equal(completed.response.status, 200);

  const afterCompletion = await api(`/api/v1/emergencies/${requestId}`, { headers: auth(paramedicToken) });
  assert.equal(afterCompletion.body.request.status, 'COMPLETED');
  assert.ok(afterCompletion.body.allocations.every(allocation => allocation.status === 'RELEASED'));
  const ambulances = await api('/api/v1/ambulances', { headers: auth(paramedicToken) });
  assert.ok(ambulances.body.ambulances.some(ambulance => ambulance.ambulance_id === accepted.body.ambulance_id && ambulance.status === 'AVAILABLE'));

  const invalidResourceUpdate = await api('/api/v1/hospitals/H-101/resources/ICU_BED', {
    method: 'PATCH',
    headers: auth(paramedicToken),
    body: JSON.stringify({ available_capacity: 99 })
  });
  assert.equal(invalidResourceUpdate.response.status, 403);

  const invalidTransition = await api(`/api/v1/emergencies/${requestId}/status`, {
    method: 'PATCH',
    headers: auth(adminToken),
    body: JSON.stringify({ status: 'WAITING' })
  });
  assert.equal(invalidTransition.response.status, 409);

  const respiratoryRequests = await Promise.all(Array.from({ length: 6 }, (_, index) => api('/api/v1/emergencies', {
    method: 'POST',
    headers: auth(paramedicToken),
    body: JSON.stringify({
      patient_name: `Fictional Load Patient ${index + 1}`,
      age: 30 + index,
      gender: 'UNKNOWN',
      emergency_type: 'RESPIRATORY',
      triage_priority: 2,
      clinical_notes: 'Fictional concurrency verification record.'
    })
  })));
  assert.ok(respiratoryRequests.every(result => result.response.status === 201));

  await api('/api/v1/hospitals/H-102/resources/ICU_BED', {
    method: 'PATCH',
    headers: auth(adminToken),
    body: JSON.stringify({ available_capacity: 1 })
  });
  const lockAttempts = await Promise.all(respiratoryRequests.map(result => api('/api/v1/referrals/initiate', {
    method: 'POST',
    headers: auth(paramedicToken),
    body: JSON.stringify({ request_id: result.body.request_id, hospital_id: 'H-102' })
  })));
  assert.equal(lockAttempts.filter(result => result.response.status === 201).length, 1);

  assert.equal(server.exitCode, null, stderr);
});
