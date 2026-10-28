// Idempotent emergency creation (Idempotency-Key header), in-memory store. The MySQL path is covered
// in tests/mysql_routes.test.js. Real routers are mounted in-process. All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { generateToken } from '../server/middleware/auth.js';
import emergenciesRoutes from '../server/routes/emergencies.js';

const app = express();
app.use(express.json());
app.use('/api/v1/emergencies', emergenciesRoutes);

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const paramedic = generateToken({ user_id: 'U-EMS-IDEM', role: 'PARAMEDIC', hospital_id: null });
const otherParamedic = generateToken({ user_id: 'U-EMS-IDEM-2', role: 'PARAMEDIC', hospital_id: null });
const body = (name = 'Fictional Idempotent Patient') => ({ patient_name: name, age: 50, emergency_type: 'CARDIAC', triage_priority: 1 });

async function create(payload, { token = paramedic, key } = {}) {
  const response = await fetch(`${base}/api/v1/emergencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(key !== undefined ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(payload)
  });
  return { status: response.status, replayed: response.headers.get('idempotent-replayed'), body: await response.json() };
}
const casesNamed = name => db.patients.filter(p => p.full_name === name).length;

test('a retried create with the same key returns the original case instead of registering the patient twice', async () => {
  const first = await create(body('Fictional Retry'), { key: 'retry-key-1' });
  const retry = await create(body('Fictional Retry'), { key: 'retry-key-1' });

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.replayed, 'true');
  assert.equal(first.replayed, null);
  assert.deepEqual(retry.body, first.body, 'the replay is the original response');
  assert.equal(casesNamed('Fictional Retry'), 1);
  assert.equal(db.emergencyHistory.filter(h => h.request_id === first.body.request_id && h.event_type === 'REQUEST_CREATED').length, 1);
});

test('concurrent submissions with one key create exactly one case', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => create(body('Fictional Double Click'), { key: 'double-click' })));
  assert.ok(results.every(r => r.status === 201));
  assert.equal(new Set(results.map(r => r.body.request_id)).size, 1);
  assert.equal(casesNamed('Fictional Double Click'), 1);
});

test('reusing a key for a different request is refused and creates nothing', async () => {
  await create(body('Fictional Original'), { key: 'reused-key' });
  const conflicting = await create(body('Fictional Different'), { key: 'reused-key' });
  assert.equal(conflicting.status, 422);
  assert.match(conflicting.body.error, /different request/);
  assert.equal(casesNamed('Fictional Different'), 0);
});

test('keys are scoped per user, requests without a key behave as before, and malformed keys are rejected', async () => {
  const mine = await create(body('Fictional Scoped'), { key: 'shared-key' });
  const theirs = await create(body('Fictional Scoped'), { key: 'shared-key', token: otherParamedic });
  assert.notEqual(mine.body.request_id, theirs.body.request_id, "another user's key never replays my case");

  await create(body('Fictional No Key'));
  await create(body('Fictional No Key'));
  assert.equal(casesNamed('Fictional No Key'), 2, 'without a key every call is a new case');

  for (const bad of ['', 'x'.repeat(101), 'has spaces', 'semi;colon']) {
    const result = await create(body('Fictional Bad Key'), { key: bad });
    assert.equal(result.status, 400, JSON.stringify(bad));
  }
  assert.equal(casesNamed('Fictional Bad Key'), 0);
});
