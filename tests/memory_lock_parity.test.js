// In-memory-only parts of the locking-parity fixes (round-1 review L2, L-T5) that the shared contract cannot express:
//  - expireLock on a PENDING record that has no live lock (MySQL has no such state: its PENDING row IS the lock),
//  - the memory store's background worker runs the stranded-case recovery, as MySQL's sweeper does,
//  - a memory-only contract run never loads the MySQL test credentials (.env.local).
// Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend } from './contract/backends.js';
import { resolveEmergencyRequirements } from '../server/services/emergencyRequirements.js';
import { db } from '../server/db/seed.js';

const b = await createMemoryBackend();
test.after(() => b.close());
test.beforeEach(() => b.reset());

async function newCase() {
  const req = resolveEmergencyRequirements('RESPIRATORY');
  const { request_id } = await b.store.createRequest({
    patient: { full_name: 'Fictional Parity Patient', age: 40, gender: 'UNKNOWN', emergency_type: 'RESPIRATORY', triage_priority: 2, contact_phone: null },
    request: { emergency_type: 'RESPIRATORY', required_resource_types: req.resourceTypes, required_specialist: req.specialist, priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
  }, { role: 'PARAMEDIC', id: 'U-TEST' });
  return request_id;
}

test('expireLock on a PENDING record without a live lock acts only after its expiry, then re-queues and audits as MySQL', async () => {
  await b.setCapacity('H-A', 'ICU_BED', { total: 1 });
  await b.setCapacity('H-A', 'VENTILATOR', { total: 1 });
  const id = await newCase();
  const lock = await b.store.acquireReferralLock('H-A', id, ['ICU_BED', 'VENTILATOR']);
  // Simulate a lost live lock (e.g. a crash): the PENDING record stays, the engine entry is gone.
  const entry = b.engine._activeLocks.get(lock.acceptanceId);
  clearInterval(entry.countdownTimer);
  b.engine._activeLocks.delete(lock.acceptanceId);

  assert.equal(await b.engine.expireLock(lock.acceptanceId), false, 'not expired yet: nothing happens');
  assert.equal((await b.acceptances(id))[0].status, 'PENDING');
  assert.equal((await b.request(id)).status, 'MATCHING');

  await b.forceExpire(lock.acceptanceId);
  assert.equal(await b.engine.expireLock(lock.acceptanceId), true);
  assert.equal((await b.acceptances(id))[0].status, 'EXPIRED');
  assert.equal((await b.request(id)).status, 'WAITING', 're-queued (no other hospital has capacity)');
  const last = (await b.audit(id)).at(-1);
  assert.deepEqual([last.event_type, last.new_state, last.metadata], ['LOCK_TTL_EXPIRED_FAILOVER', 'EXPIRED', { acceptanceId: lock.acceptanceId }]);
  assert.equal(await b.engine.expireLock(lock.acceptanceId), false, 'idempotent');
});

test('the memory store\'s background worker re-queues a stranded MATCHING case, as MySQL\'s sweeper does', async () => {
  const id = await newCase();
  await b.setRequestStatus(id, 'MATCHING');
  const called = new Promise(resolve => {
    const original = b.engine.requeueStrandedRequests.bind(b.engine);
    b.engine.requeueStrandedRequests = async () => {
      const moved = await original();
      b.engine.requeueStrandedRequests = original;
      resolve(moved);
      return moved;
    };
  });
  b.store.startBackgroundWorkers({ intervalMs: 10 });
  // The worker's timer is unref'd (it must not keep a server alive); this deadline keeps the test's event loop up.
  let deadline;
  const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('the worker never ran the recovery')), 5000); });
  try {
    assert.equal(await Promise.race([called, timedOut]), 1);
  } finally {
    clearTimeout(deadline);
    await b.store.close();
  }
  assert.equal(db.emergencyRequests.find(r => r.request_id === id).status, 'WAITING');
});

test('L-T5: a memory-only contract backend never loads the MySQL test credentials', () => {
  // A clean child process (no MYSQL_TEST_* inherited) builds the memory backend, then reports only whether any
  // MYSQL_TEST_* variable is present. Values are never printed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_')));
  const script = `
    const { createMemoryBackend } = await import('./tests/contract/backends.js');
    const backend = await createMemoryBackend();
    await backend.close();
    const keys = ['MYSQL_TEST_HOST', 'MYSQL_TEST_PORT', 'MYSQL_TEST_USER', 'MYSQL_TEST_PASS', 'MYSQL_TEST_DB'];
    console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, k in process.env]))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const presence = JSON.parse(child.stdout.trim().split('\n').at(-1));
  console.log('MYSQL_TEST_* present after a memory-only backend:', JSON.stringify(presence));
  assert.deepEqual(Object.values(presence), [false, false, false, false, false]);
});

test('L-T5: the memory API integration run loads no MySQL test credentials and passes none to its server', () => {
  // tests/api_integration.test.js (memory variant) runs once more in a clean child process, on its own port. The probe
  // preload reports whether the test process ends up with MYSQL_TEST_* (only a static import of the MySQL helper would
  // load them) and whether any server it spawns receives one. MYSQL_TEST_PROBE is a dummy, not a credential: it checks
  // that the test strips MYSQL_TEST_* from the server's environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_') && k !== 'API_TEST_BACKEND' && k !== 'NODE_TEST_CONTEXT'));
  // (NODE_TEST_CONTEXT is dropped so the child runs as a plain test process, not as a node --test worker.)
  const probe = pathToFileURL(new URL('./helpers/spawnEnvProbe.js', import.meta.url).pathname).href;
  const child = spawnSync(process.execPath, ['--import', probe, 'tests/api_integration.test.js'], {
    cwd: process.cwd(), env: { ...env, API_TEST_PORT: '4219', MYSQL_TEST_PROBE: 'dummy' }, encoding: 'utf8', timeout: 60_000
  });
  assert.equal(child.status, 0, `the memory API run itself must pass:\n${child.stdout.slice(-2000)}\n${child.stderr.slice(-2000)}`);
  const line = child.stdout.split('\n').find(l => l.startsWith('CREDENTIAL-PROBE '));
  assert.ok(line, 'the probe reported');
  const report = JSON.parse(line.slice('CREDENTIAL-PROBE '.length));
  console.log('api_integration (memory) MYSQL_TEST_* presence:', JSON.stringify(report));
  assert.deepEqual(Object.values(report.parent), [false, false, false, false, false], 'the test process never loaded .env.local');
  assert.ok(report.spawnedWithMysqlTest.length >= 1, 'the server was spawned through the probe');
  assert.ok(report.spawnedWithMysqlTest.every(present => present === false), 'no spawned server received a MYSQL_TEST_* variable');
});
