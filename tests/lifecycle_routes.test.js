// Deterministic route-level lifecycle tests. The real Express routers are mounted
// in-process so the test shares the db / lockingEngine singletons and can hold a
// row mutex to force an exact interleaving instead of relying on timing.
// All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { lockingEngine } from '../server/services/lockingEngine.js';
import { generateToken } from '../server/middleware/auth.js';
import { getStore } from '../server/db/store.js';
import emergenciesRoutes from '../server/routes/emergencies.js';
import referralsRoutes from '../server/routes/referrals.js';
import analyticsRoutes from '../server/routes/analytics.js';
import ambulancesRoutes from '../server/routes/ambulances.js';

const app = express();
app.use(express.json());
app.use('/api/v1/emergencies', emergenciesRoutes);
app.use('/api/v1/referrals', referralsRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/ambulances', ambulancesRoutes);

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const tokens = {
  admin: generateToken({ user_id: 'U-ADM', role: 'ADMIN', hospital_id: null }),
  paramedic: generateToken({ user_id: 'U-EMS', role: 'PARAMEDIC', hospital_id: null }),
  desk101: generateToken({ user_id: 'U-H101', role: 'HOSPITAL_DESK', hospital_id: 'H-101' }),
  desk102: generateToken({ user_id: 'U-H102', role: 'HOSPITAL_DESK', hospital_id: 'H-102' })
};

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body && JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function createCase(emergencyType = 'CARDIAC') {
  const created = await call('/api/v1/emergencies', tokens.paramedic, 'POST', {
    patient_name: 'Fictional Lifecycle Patient', age: 47, emergency_type: emergencyType, triage_priority: 1
  });
  assert.equal(created.status, 201);
  return created.body.request_id;
}

const resourceRow = (hospitalId, type) => db.medicalResources.find(r => r.hospital_id === hospitalId && r.resource_type === type);
const snapshot = hospitalId => ['ICU_BED', 'VENTILATOR'].map(type => {
  const r = resourceRow(hospitalId, type);
  return [type, r.locked_capacity, r.available_capacity];
});
const requestOf = id => db.emergencyRequests.find(r => r.request_id === id);
const locksFor = id => lockingEngine.getActiveLocks().filter(l => l.requestId === id);
const auditTypes = id => db.emergencyHistory.filter(h => h.request_id === id).map(h => h.event_type);

test('POST /referrals/initiate racing a cancellation: initiate is refused and the case stays CANCELLED', async () => {
  const requestId = await createCase();
  const before = snapshot('H-101');

  // Another request holds the ICU row, so the initiate waits inside the engine.
  const releaseRow = await db.acquireResourceLock(resourceRow('H-101', 'ICU_BED').resource_id);
  const initiating = call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(locksFor(requestId).length, 0, 'initiate must still be waiting');

  // Admin cancels while the initiate is blocked, then the row is freed.
  const cancelling = call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseRow();

  const [initiated, cancelled] = await Promise.all([initiating, cancelling]);
  assert.equal(initiated.status, 409);
  assert.match(initiated.body.error, /CANCELLED/);
  assert.equal(cancelled.status, 200);
  assert.equal(requestOf(requestId).status, 'CANCELLED', 'the case must not be revived to MATCHING');
  assert.equal(locksFor(requestId).length, 0);
  assert.ok(!db.hospitalAcceptances.some(a => a.request_id === requestId), 'no referral record for a cancelled case');
  assert.deepEqual(snapshot('H-101'), before);
});

test('lock cleanup failure on cancel is reported, and the leftover lock can never allocate', async () => {
  const requestId = await createCase();
  const before = snapshot('H-101');
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  const acceptanceId = initiated.body.acceptance_id;

  const original = lockingEngine.cancelPendingForRequest;
  lockingEngine.cancelPendingForRequest = async () => { throw new Error('simulated cleanup failure'); };
  let cancelled;
  try {
    cancelled = await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
  } finally {
    lockingEngine.cancelPendingForRequest = original;
  }

  assert.equal(cancelled.status, 500);
  assert.equal(cancelled.body.lock_cleanup, 'FAILED');
  assert.equal(requestOf(requestId).status, 'CANCELLED');
  assert.ok(auditTypes(requestId).includes('LOCK_CLEANUP_FAILED'));
  assert.equal(locksFor(requestId).length, 1, 'the simulated failure leaves the lock behind');

  // The leftover lock is refused at commit time and freed by the guard...
  const accepted = await call(`/api/v1/referrals/${acceptanceId}/accept`, tokens.desk101, 'POST');
  assert.equal(accepted.status, 409);
  assert.equal(requestOf(requestId).status, 'CANCELLED');
  assert.ok(!db.resourceAllocations.some(a => a.request_id === requestId));
  assert.equal(locksFor(requestId).length, 0);
  assert.deepEqual(snapshot('H-101'), before);
});

test('a leftover lock after a cleanup failure is released by its TTL without reviving the case', async () => {
  const requestId = await createCase();
  const before = snapshot('H-101');
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  const entry = { ...lockingEngine._activeLocks.get(initiated.body.acceptance_id) };

  const original = lockingEngine.cancelPendingForRequest;
  lockingEngine.cancelPendingForRequest = async () => { throw new Error('simulated cleanup failure'); };
  try {
    await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
  } finally {
    lockingEngine.cancelPendingForRequest = original;
  }
  assert.equal(locksFor(requestId).length, 1);

  await lockingEngine._handleTimeout(entry); // what the 90s timer / background worker does

  assert.equal(requestOf(requestId).status, 'CANCELLED', 'TTL failover must not revive a cancelled case');
  assert.equal(locksFor(requestId).length, 0);
  assert.ok(!db.hospitalAcceptances.some(a => a.request_id === requestId && a.status === 'PENDING'));
  assert.deepEqual(snapshot('H-101'), before);
});

test('committed resources are still released when pending-lock cleanup fails', async () => {
  const requestId = await createCase();
  const before = snapshot('H-101');
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal((await call(`/api/v1/referrals/${initiated.body.acceptance_id}/accept`, tokens.desk101, 'POST')).status, 200);
  assert.equal(requestOf(requestId).status, 'ALLOCATED');

  const original = lockingEngine.cancelPendingForRequest;
  lockingEngine.cancelPendingForRequest = async () => { throw new Error('simulated cleanup failure'); };
  let cancelled;
  try {
    cancelled = await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
  } finally {
    lockingEngine.cancelPendingForRequest = original;
  }

  assert.equal(cancelled.status, 500);
  const allocations = db.resourceAllocations.filter(a => a.request_id === requestId);
  assert.ok(allocations.length > 0 && allocations.every(a => a.status === 'RELEASED'));
  assert.deepEqual(snapshot('H-101'), before);
});

test('analytics: cancelled referrals are reported separately and do not lower acceptance rates', async () => {
  const hospitalId = 'H-106';
  assert.equal(db.hospitalAcceptances.filter(a => a.hospital_id === hospitalId).length, 0, 'test needs a clean hospital');
  ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CANCELLED'].forEach((status, index) => db.hospitalAcceptances.push({
    acceptance_id: `ACC-ANALYTICS-${index}`, request_id: `REQ-ANALYTICS-${index}`, hospital_id: hospitalId, status,
    created_at: new Date().toISOString()
  }));

  const { status, body } = await call('/api/v1/analytics/referrals', tokens.admin);
  assert.equal(status, 200);
  const row = body.by_hospital.find(h => h.hospital_id === hospitalId);
  assert.equal(row.total, 4);
  assert.equal(row.cancelled, 2);
  assert.equal(row.acceptance_rate, 50, '1 accepted of 2 decidable referrals; not 25%');
  assert.ok(body.summary.cancelled >= 2);

  db.hospitalAcceptances = db.hospitalAcceptances.filter(a => !a.acceptance_id.startsWith('ACC-ANALYTICS-'));
});

// ── Dispatch, ownership and lifecycle-edge regressions ───────────────────────
// The seeded fleet is tiny and shared, so every test restores it afterwards.
async function withFleetRestored(fn) {
  const saved = db.ambulances.map(a => ({ ...a }));
  try {
    await fn();
  } finally {
    saved.forEach(original => {
      const live = db.ambulances.find(a => a.ambulance_id === original.ambulance_id);
      Object.keys(live).forEach(key => delete live[key]);
      Object.assign(live, original);
    });
  }
}

async function acceptedCase() {
  const requestId = await createCase();
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  const accepted = await call(`/api/v1/referrals/${initiated.body.acceptance_id}/accept`, tokens.desk101, 'POST');
  assert.equal(accepted.status, 200);
  return { requestId, autoAmbulance: accepted.body.ambulance_id };
}

const freeAmbulance = () => db.ambulances.find(a => a.status === 'AVAILABLE' && !a.assigned_request_id);

test('ambulance update with invalid input is rejected without mutating the unit', () => withFleetRestored(async () => {
  const { requestId } = await acceptedCase();
  const unit = freeAmbulance();
  const before = { ...unit };

  for (const bad of [{ current_lat: 'abc' }, { current_lng: 999 }, { eta_mins: -5 }]) {
    const result = await call(`/api/v1/ambulances/${unit.ambulance_id}/status`, tokens.paramedic, 'PATCH',
      { status: 'DISPATCHED', request_id: requestId, ...bad });
    assert.equal(result.status, 400);
    assert.deepEqual({ ...unit }, before, `no partial update for ${JSON.stringify(bad)}`);
  }
}));

test('a case gets exactly one ambulance: accept auto-dispatches, a second dispatch is refused', () => withFleetRestored(async () => {
  const { requestId, autoAmbulance } = await acceptedCase();
  assert.ok(autoAmbulance, 'accept should dispatch a unit');
  const second = freeAmbulance();

  const result = await call(`/api/v1/ambulances/${second.ambulance_id}/status`, tokens.paramedic, 'PATCH',
    { status: 'DISPATCHED', request_id: requestId });
  assert.equal(result.status, 409);
  assert.match(result.body.error, new RegExp(autoAmbulance));
  assert.deepEqual(db.ambulances.filter(a => a.assigned_request_id === requestId).map(a => a.ambulance_id), [autoAmbulance]);
  assert.equal(second.status, 'AVAILABLE');
}));

test('dispatch requires an accepted referral and an admin cannot force MATCHING -> ALLOCATED', () => withFleetRestored(async () => {
  const requestId = await createCase();
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);

  const forced = await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'ALLOCATED' });
  assert.equal(forced.status, 409);
  assert.equal(requestOf(requestId).status, 'MATCHING');
  assert.equal(locksFor(requestId).length, 1, 'the pending handshake is untouched');
  assert.ok(!db.resourceAllocations.some(a => a.request_id === requestId));

  const unit = freeAmbulance();
  const dispatch = await call(`/api/v1/ambulances/${unit.ambulance_id}/status`, tokens.paramedic, 'PATCH',
    { status: 'DISPATCHED', request_id: requestId });
  assert.equal(dispatch.status, 409);
  assert.equal(unit.status, 'AVAILABLE');

  await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
}));

test('a hospital desk can only update ambulances stationed at its own facility', () => withFleetRestored(async () => {
  const home = db.ambulances.find(a => a.hospital_id === 'H-101');
  const denied = await call(`/api/v1/ambulances/${home.ambulance_id}/status`, tokens.desk102, 'PATCH', { status: 'MAINTENANCE' });
  assert.equal(denied.status, 403);
  assert.notEqual(home.status, 'MAINTENANCE');

  const allowed = await call(`/api/v1/ambulances/${home.ambulance_id}/status`, tokens.desk101, 'PATCH', { status: 'MAINTENANCE' });
  assert.equal(allowed.status, 200);
  assert.equal(home.status, 'MAINTENANCE');
}));

test('returning a matching case to the queue releases its pending lock and TTL cannot flip it back', async () => {
  const requestId = await createCase();
  const before = snapshot('H-101');
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  assert.equal(requestOf(requestId).status, 'MATCHING');
  assert.equal(locksFor(requestId).length, 1, 'precondition: a pending lock exists');
  const entry = { ...lockingEngine._activeLocks.get(initiated.body.acceptance_id) };

  const requeued = await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'WAITING' });
  assert.equal(requeued.status, 200);
  assert.equal(locksFor(requestId).length, 0);
  assert.deepEqual(snapshot('H-101'), before);

  await lockingEngine._handleTimeout(entry); // stale TTL callback
  assert.equal(requestOf(requestId).status, 'WAITING');

  await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
});

test('an admin cannot move a case to MATCHING by hand: only placing a referral does that', async () => {
  const requestId = await createCase();
  const forced = await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'MATCHING' });
  assert.equal(forced.status, 409);
  assert.equal(requestOf(requestId).status, 'WAITING', 'a MATCHING case without a pending referral would be stranded');
  await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
});

test('a failing alert write after a committed accept does not report the accept as failed', () => withFleetRestored(async () => {
  const requestId = await createCase();
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);

  const store = getStore();
  const original = store.createAlert;
  store.createAlert = async () => { throw new Error('alert table unavailable'); };
  let accepted;
  try {
    accepted = await call(`/api/v1/referrals/${initiated.body.acceptance_id}/accept`, tokens.desk101, 'POST');
  } finally {
    store.createAlert = original;
  }

  assert.equal(requestOf(requestId).status, 'ALLOCATED', 'precondition: the allocation committed');
  assert.equal(accepted.status, 200, 'a committed allocation must be reported as accepted, or the desk retries / gives up');
  assert.equal(accepted.body.status, 'ACCEPTED');
  await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
}));

test('failover refuses a request that has already moved past matching', async () => {
  const requestId = await createCase();
  requestOf(requestId).status = 'ALLOCATED';
  const revived = await lockingEngine._tryFailover({ requestId, hospitalId: 'H-101', resourceTypes: ['ICU_BED'] });
  assert.equal(revived, null);
  assert.equal(requestOf(requestId).status, 'ALLOCATED');
  assert.equal(locksFor(requestId).length, 0);
});

test('active-lock countdown and recorded response time follow real elapsed time', async () => {
  const requestId = await createCase();
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-103' });
  assert.equal(initiated.status, 201);
  await new Promise(resolve => setTimeout(resolve, 1200));

  const active = lockingEngine.getActiveLocks().find(l => l.acceptanceId === initiated.body.acceptance_id);
  assert.ok(active.remainingSec <= 89, `remainingSec should have counted down, got ${active.remainingSec}`);

  await withFleetRestored(async () => {
    const accepted = await call(`/api/v1/referrals/${initiated.body.acceptance_id}/accept`, tokens.admin, 'POST');
    assert.equal(accepted.status, 200);
  });
  const acceptance = db.hospitalAcceptances.find(a => a.acceptance_id === initiated.body.acceptance_id);
  assert.ok(acceptance.response_time_sec >= 1 && acceptance.response_time_sec <= 5, `got ${acceptance.response_time_sec}`);
  await call(`/api/v1/emergencies/${requestId}/status`, tokens.admin, 'PATCH', { status: 'CANCELLED' });
});
