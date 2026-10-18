// Regression tests: cancelling or completing a request must clean up its pending
// referral lock, and a cancelled/completed request can never be allocated or revived.
// Engine-level tests use the in-memory store; the HTTP test spawns a disposable server.
// All patient data is fictional.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { db } from '../server/db/seed.js';
import { lockingEngine } from '../server/services/lockingEngine.js';

let seq = 0;
function addRequest(status = 'MATCHING') {
  const request = {
    request_id: `REQ-STALE-${++seq}`,
    patient_id: 'PAT-STALE',
    emergency_type: 'CARDIAC',
    required_resource_types: ['ICU_BED'],
    required_specialist: null,
    priority: 1,
    status,
    request_time: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.emergencyRequests.push(request);
  return request;
}

const icu = hospitalId => db.medicalResources.find(r => r.hospital_id === hospitalId && r.resource_type === 'ICU_BED');
const acceptanceOf = id => db.hospitalAcceptances.find(a => a.acceptance_id === id);
const locksFor = requestId => lockingEngine.getActiveLocks().filter(l => l.requestId === requestId);

test('cancelling a pending referral releases the lock and restores capacity', async () => {
  const resource = icu('H-101');
  const before = { locked: resource.locked_capacity, available: resource.available_capacity };
  const request = addRequest();
  const lock = await lockingEngine.acquireSoftLock('H-101', request.request_id, ['ICU_BED']);
  assert.equal(resource.locked_capacity, before.locked + 1);

  request.status = 'CANCELLED';
  const cancelled = await lockingEngine.cancelPendingForRequest(request.request_id, 'Request CANCELLED');

  assert.deepEqual(cancelled, [lock.acceptanceId]);
  assert.equal(resource.locked_capacity, before.locked);
  assert.equal(resource.available_capacity, before.available);
  assert.equal(locksFor(request.request_id).length, 0);
  assert.equal(acceptanceOf(lock.acceptanceId).status, 'CANCELLED');
  assert.ok(db.emergencyHistory.some(h => h.request_id === request.request_id && h.event_type === 'LOCK_CANCELLED'));

  // Idempotent: a second cancel must not release capacity again.
  assert.deepEqual(await lockingEngine.cancelPendingForRequest(request.request_id), []);
  assert.equal(resource.locked_capacity, before.locked);
});

test('a TTL timeout after cancellation cannot revive the request or double-release', async t => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());

  const resource = icu('H-102');
  const lockedBefore = resource.locked_capacity;
  const request = addRequest();
  const lock = await lockingEngine.acquireSoftLock('H-102', request.request_id, ['ICU_BED']);
  const staleEntry = { ...lockingEngine._activeLocks.get(lock.acceptanceId) };

  request.status = 'CANCELLED';
  await lockingEngine.cancelPendingForRequest(request.request_id);

  // The cleared interval must never fire, even after the full TTL elapses.
  mock.timers.tick(120_000);
  await new Promise(resolve => setImmediate(resolve));
  // A stale callback / the background worker may still call in: it must be a no-op.
  await lockingEngine._handleTimeout(staleEntry);
  assert.equal(await lockingEngine.expireLock(lock.acceptanceId), false);

  assert.equal(request.status, 'CANCELLED');
  assert.equal(acceptanceOf(lock.acceptanceId).status, 'CANCELLED');
  assert.equal(locksFor(request.request_id).length, 0);
  assert.ok(!db.hospitalAcceptances.some(a => a.request_id === request.request_id && a.status === 'PENDING'));
  assert.equal(resource.locked_capacity, lockedBefore);
});

test('a request cancelled while waiting for the row mutex is never granted a lock', async () => {
  const resource = icu('H-101');
  const before = { locked: resource.locked_capacity, available: resource.available_capacity };
  const request = addRequest('WAITING');
  const events = [];
  const onAcquired = lock => events.push(lock.requestId);
  lockingEngine.on('lock_acquired', onAcquired);

  // Another request holds the ICU row, so this acquire must wait (real time).
  const releaseRow = await db.acquireResourceLock(resource.resource_id);
  const pending = lockingEngine.acquireSoftLock('H-101', request.request_id, ['ICU_BED']);
  const outcome = pending.then(lock => ({ lock }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 50));

  request.status = 'CANCELLED';
  const cancelling = lockingEngine.cancelPendingForRequest(request.request_id, 'Request CANCELLED');
  releaseRow();

  const result = await outcome;
  await cancelling;
  lockingEngine.off('lock_acquired', onAcquired);

  assert.match(result.error?.message ?? '', /CANCELLED/, 'acquire must be refused, not granted');
  assert.ok(!events.includes(request.request_id), 'no incoming-referral event for a cancelled request');
  assert.equal(request.status, 'CANCELLED');
  assert.equal(locksFor(request.request_id).length, 0);
  assert.ok(!db.hospitalAcceptances.some(a => a.request_id === request.request_id));
  assert.equal(resource.locked_capacity, before.locked);
  assert.equal(resource.available_capacity, before.available);
});

test('a failing audit write or listener does not strand capacity during cancellation', async () => {
  const resource = icu('H-103');
  const before = { locked: resource.locked_capacity, available: resource.available_capacity };
  const request = addRequest();
  const lock = await lockingEngine.acquireSoftLock('H-103', request.request_id, ['ICU_BED']);

  const originalAudit = db.auditLog;
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  db.auditLog = () => { throw new Error('simulated audit failure'); };
  try {
    request.status = 'CANCELLED';
    const cancelled = await lockingEngine.cancelPendingForRequest(request.request_id, 'Request CANCELLED');
    assert.deepEqual(cancelled, [lock.acceptanceId]);
  } finally {
    db.auditLog = originalAudit;
    console.error = originalError;
  }

  assert.equal(resource.locked_capacity, before.locked);
  assert.equal(resource.available_capacity, before.available);
  assert.equal(locksFor(request.request_id).length, 0);
  assert.equal(acceptanceOf(lock.acceptanceId).status, 'CANCELLED');
  assert.ok(logged.some(line => /audit\/notification failed/.test(line)), 'the failure must be logged, not hidden');
});

test('failover never revives a cancelled request', async () => {
  const request = addRequest('CANCELLED');
  const revived = await lockingEngine._tryFailover({
    requestId: request.request_id,
    hospitalId: 'H-101',
    resourceTypes: ['ICU_BED']
  });
  assert.equal(revived, null);
  assert.equal(request.status, 'CANCELLED');
  assert.equal(locksFor(request.request_id).length, 0);
});

test('concurrent cancellation and acceptance never leave the request ALLOCATED', async () => {
  const resource = icu('H-103');
  const before = { locked: resource.locked_capacity, available: resource.available_capacity };

  for (const order of ['accept-first', 'cancel-first']) {
    const request = addRequest();
    const lock = await lockingEngine.acquireSoftLock('H-103', request.request_id, ['ICU_BED']);
    const accept = () => lockingEngine.commitAllocation(lock.acceptanceId, 'TEST-DESK');
    const cancel = async () => {
      request.status = 'CANCELLED'; // the route records the status synchronously first
      return lockingEngine.cancelPendingForRequest(request.request_id);
    };

    const results = await Promise.allSettled(order === 'accept-first' ? [accept(), cancel()] : [cancel(), accept()]);

    assert.equal(request.status, 'CANCELLED', order);
    assert.ok(!db.resourceAllocations.some(a => a.request_id === request.request_id), `${order}: no allocation`);
    assert.equal(locksFor(request.request_id).length, 0, order);
    assert.equal(resource.locked_capacity, before.locked, order);
    assert.equal(resource.available_capacity, before.available, order);
    assert.ok(results.some(r => r.status === 'rejected'), `${order}: acceptance must be refused`);
  }
});

test('completing a request cleans up its pending locks', async () => {
  const resource = icu('H-105');
  const lockedBefore = resource.locked_capacity;
  const request = addRequest();
  const lock = await lockingEngine.acquireSoftLock('H-105', request.request_id, ['ICU_BED']);

  request.status = 'COMPLETED';
  await lockingEngine.cancelPendingForRequest(request.request_id, 'Request COMPLETED');

  assert.equal(locksFor(request.request_id).length, 0);
  assert.equal(resource.locked_capacity, lockedBefore);
  assert.equal(acceptanceOf(lock.acceptanceId).status, 'CANCELLED');
  await assert.rejects(lockingEngine.acquireSoftLock('H-105',request.request_id, ['ICU_BED']), /COMPLETED/);
});

test('rejecting a real referral fails over instead of deadlocking on the request lock', async () => {
  const request = addRequest();
  const lock = await lockingEngine.acquireSoftLock('H-101', request.request_id, ['ICU_BED']);
  const outcome = await Promise.race([
    lockingEngine.rejectAndFailover(lock.acceptanceId, 'No capacity', 'TEST-DESK'),
    new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 3000))
  ]);
  assert.notEqual(outcome, 'TIMEOUT');
  assert.equal(outcome.status, 'REJECTED');
  assert.ok(outcome.next_acceptance_id, 'a different hospital should receive the referral');
  assert.notEqual(outcome.next_hospital_id, 'H-101');

  request.status = 'CANCELLED';
  await lockingEngine.cancelPendingForRequest(request.request_id);
  assert.equal(locksFor(request.request_id).length, 0);
});

// ── HTTP-level ───────────────────────────────────────────────────────────────
const PORT = 4109;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('API: accepting a cancelled request returns 409; completing leaves no pending locks', async t => {
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DB_USE_MEMORY: 'true' },
    stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const login = async (username, password) => (await call('/api/v1/auth/login', null, 'POST', { username, password })).body.token;
  const paramedic = await login('UNIT-402', 'paramedic123');
  const admin = await login('admin', 'admin123');
  const desk = await login('apex_desk', 'hospital123');

  const create = async () => (await call('/api/v1/emergencies', paramedic, 'POST', {
    patient_name: 'Fictional Cancel Patient', age: 41, emergency_type: 'CARDIAC', triage_priority: 1
  })).body.request_id;

  // Cancel while pending.
  const cancelledId = await create();
  const initiated = await call('/api/v1/referrals/initiate', paramedic, 'POST', { request_id: cancelledId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  const acceptanceId = initiated.body.acceptance_id;

  assert.equal((await call(`/api/v1/emergencies/${cancelledId}/status`, admin, 'PATCH', { status: 'CANCELLED' })).status, 200);
  assert.equal((await call('/api/v1/referrals/active', admin)).body.active_locks.length, 0);

  const accept = await call(`/api/v1/referrals/${acceptanceId}/accept`, desk, 'POST');
  assert.equal(accept.status, 409);
  const detail = (await call(`/api/v1/emergencies/${cancelledId}`, admin)).body;
  assert.equal(detail.request.status, 'CANCELLED');
  assert.equal(detail.allocations.length, 0);
  assert.equal(detail.acceptances[0].status, 'CANCELLED');

  // Complete after allocation: nothing pending afterwards.
  const completedId = await create();
  const second = await call('/api/v1/referrals/initiate', paramedic, 'POST', { request_id: completedId, hospital_id: 'H-101' });
  assert.equal((await call(`/api/v1/referrals/${second.body.acceptance_id}/accept`, desk, 'POST')).status, 200);
  assert.equal((await call(`/api/v1/emergencies/${completedId}/status`, admin, 'PATCH', { status: 'COMPLETED' })).status, 200);
  assert.equal((await call('/api/v1/referrals/active', admin)).body.active_locks.length, 0);
});
