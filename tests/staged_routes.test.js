// Staged claims and the Banker's check through the HTTP API (Phase 3 Step 4): the intake response carries the
// claim; an unsafe referral is refused with its explanation in the response body (D4-a5); stage advance and the
// per-hospital safety report enforce their roles. The real Express routers run in-process on the in-memory
// store. All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { memoryTokenFor } from './helpers/testUsers.js';
import emergenciesRoutes from '../server/routes/emergencies.js';
import referralsRoutes from '../server/routes/referrals.js';
import hospitalsRoutes from '../server/routes/hospitals.js';

const app = express();
app.use(express.json());
app.use('/api/v1/emergencies', emergenciesRoutes);
app.use('/api/v1/referrals', referralsRoutes);
app.use('/api/v1/hospitals', hospitalsRoutes);

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const tokens = {
  admin: memoryTokenFor(db, { user_id: 'U-ADM', role: 'ADMIN', hospital_id: null }),
  paramedic: memoryTokenFor(db, { user_id: 'U-EMS', role: 'PARAMEDIC', hospital_id: null }),
  desk101: memoryTokenFor(db, { user_id: 'U-H101', role: 'HOSPITAL_DESK', hospital_id: 'H-101' }),
  desk103: memoryTokenFor(db, { user_id: 'U-H103', role: 'HOSPITAL_DESK', hospital_id: 'H-103' })
};

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
// H-101: no case of the demo seed holds anything there (the seeded REQ-8901 holds an ICU bed at H-103, which it will
// release when it finishes, so a fully occupied H-103 would still be SAFE; see server/db/demoLifecycle.js).
const icu101 = () => db.medicalResources.find(r => r.resource_id === 'RES-101-ICU');

test('intake returns the staged claim; an unsafe referral is refused with its explanation; the safe one is admitted and advanced', async () => {
  const created = await call('/api/v1/emergencies', tokens.paramedic, 'POST', {
    patient_name: 'Fictional Route Trauma', age: 33, emergency_type: 'TRAUMA', triage_priority: 1
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.current_stage, 1);
  assert.deepEqual(created.body.claim, [{ stage_no: 1, resources: ['OT', 'TRAUMA_SURGEON'] }, { stage_no: 2, resources: ['ICU_BED'] }]);
  const id = created.body.request_id;

  // Every free ICU bed at H-101 taken by occupancy no case owns: surgery there could never get its post-op bed.
  const freeIcu = icu101().available_capacity;
  icu101().available_capacity = 0;
  const refused = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-101' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /unsafe/);
  assert.equal(refused.body.safety.reason, 'UNSAFE');
  assert.equal(refused.body.safety.hospital_id, 'H-101');
  assert.equal(refused.body.safety.blocking.type, 'ICU_BED');
  assert.deepEqual(refused.body.safety.request, { OT: 1, TRAUMA_SURGEON: 1 });
  const trail = await call(`/api/v1/emergencies/${id}/audit`, tokens.admin);
  assert.ok(trail.body.audit_trail.some(e => e.event_type === 'ADMISSION_REFUSED_UNSAFE'));

  icu101().available_capacity = freeIcu;
  const lock = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: id, hospital_id: 'H-103' });
  assert.equal(lock.status, 201, JSON.stringify(lock.body));
  // The response reports what was actually soft-locked (stage 1: the theatre) and the reserved surgeon,
  // separately from the case's full requirement across all stages.
  assert.deepEqual(lock.body.resource_types, ['OT']);
  assert.equal(lock.body.stage, 1);
  assert.equal(lock.body.reserved_specialist, 'DR-008');
  assert.deepEqual(lock.body.required_resource_types, ['ICU_BED', 'OT']);
  assert.equal((await call(`/api/v1/referrals/${lock.body.acceptance_id}/accept`, tokens.desk103, 'POST')).status, 200);

  const foreign = await call(`/api/v1/emergencies/${id}/advance-stage`, tokens.desk101, 'POST');
  assert.equal(foreign.status, 404, 'another hospital\'s desk cannot advance: it cannot even see the case');
  assert.equal((await call(`/api/v1/emergencies/${id}/advance-stage`, tokens.paramedic, 'POST')).status, 403);
  const advanced = await call(`/api/v1/emergencies/${id}/advance-stage`, tokens.desk103, 'POST');
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
  assert.deepEqual([advanced.body.previous_stage, advanced.body.current_stage, advanced.body.allocated], [1, 2, ['ICU_BED']]);
  const again = await call(`/api/v1/emergencies/${id}/advance-stage`, tokens.admin, 'POST');
  assert.equal(again.status, 409);
  assert.match(again.body.error, /no stage 3/);
});

test('the safety report is restricted to admins and the hospital\'s own desk', async () => {
  assert.equal((await call('/api/v1/hospitals/H-103/safety', tokens.desk101)).status, 403);
  assert.equal((await call('/api/v1/hospitals/H-103/safety', tokens.paramedic)).status, 403);
  const own = await call('/api/v1/hospitals/H-103/safety', tokens.desk103);
  assert.equal(own.status, 200);
  assert.equal(typeof own.body.safety.safe, 'boolean');
  assert.ok(Array.isArray(own.body.safety.cases));
  assert.equal((await call('/api/v1/hospitals/H-103/safety', tokens.admin)).status, 200);
  assert.equal((await call('/api/v1/hospitals/H-NOPE/safety', tokens.admin)).status, 404);
});

test('a capacity edit reports the hospital\'s safety in its response (D5-A)', async () => {
  const edited = await call('/api/v1/hospitals/H-101/resources/OT', tokens.desk101, 'PATCH', { total_capacity: 6, available_capacity: 2 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.resource.safety.safe, true);
  assert.equal(edited.body.resource.safety.safety_state, 'SAFE');
});
