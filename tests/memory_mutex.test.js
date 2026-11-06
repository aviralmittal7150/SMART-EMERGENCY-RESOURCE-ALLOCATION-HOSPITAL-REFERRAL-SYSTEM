// The in-memory row mutex (server/db/seed.js acquireResourceLock): arrival-ordered (FIFO), hands
// ownership straight to the next waiter, idempotent release, and timeouts that leave the queue intact.
// Deterministic: ordering is observed through promise resolution, never through sleeps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db/seed.js';

let n = 0;
const fresh = () => `TEST-MUTEX-${++n}`; // ids unknown to the resource table, so each test has its own mutex

test('an uncontended lock is granted immediately and can be re-acquired after release', async () => {
  const id = fresh();
  const release = await db.acquireResourceLock(id, 1000);
  release();
  const again = await db.acquireResourceLock(id, 1000);
  again();
});

test('waiters are granted strictly in arrival order', async () => {
  const id = fresh();
  const first = await db.acquireResourceLock(id, 1000);
  const order = [];
  const waiters = ['A', 'B', 'C', 'D'].map(name => db.acquireResourceLock(id, 1000).then(release => {
    order.push(name);
    release();
  }));
  first();
  await Promise.all(waiters);
  assert.deepEqual(order, ['A', 'B', 'C', 'D']);
});

test('a release hands the lock to the queued waiter: a newcomer cannot barge in ahead of it', async () => {
  const id = fresh();
  const first = await db.acquireResourceLock(id, 1000);
  const order = [];
  const queued = db.acquireResourceLock(id, 1000).then(release => { order.push('queued'); return release; });
  first(); // ownership passes to `queued` now, before the newcomer below even asks
  const newcomer = db.acquireResourceLock(id, 1000).then(release => { order.push('newcomer'); release(); });
  (await queued)();
  await newcomer;
  assert.deepEqual(order, ['queued', 'newcomer']);
});

test('release is idempotent: a second call never frees a lock that now belongs to someone else', async () => {
  const id = fresh();
  const first = await db.acquireResourceLock(id, 1000);
  const second = db.acquireResourceLock(id, 1000);
  first();
  const releaseSecond = await second; // the second holder owns the lock now
  first(); // stale, repeated release by the previous holder
  let thirdGranted = false;
  const third = db.acquireResourceLock(id, 1000).then(release => { thirdGranted = true; return release; });
  await new Promise(resolve => setImmediate(resolve)); // every pending microtask has run by now
  assert.equal(thirdGranted, false, 'the stale release must not have unlocked the mutex');
  releaseSecond();
  (await third)();
  assert.equal(thirdGranted, true);
});

test('a waiter that times out leaves the queue without the lock, and later waiters keep their order', async () => {
  const id = fresh();
  const holder = await db.acquireResourceLock(id, 1000);
  const timedOut = db.acquireResourceLock(id, 20);
  const later = db.acquireResourceLock(id, 5000);
  await assert.rejects(timedOut, new RegExp(`Lock timeout on ${id}`));
  holder();
  const releaseLater = await later; // granted next; the timed-out waiter was skipped
  releaseLater();
  const after = await db.acquireResourceLock(id, 1000); // and the mutex is free again afterwards
  after();
});

test('mutual exclusion under 50 concurrent increments of shared state', async () => {
  const id = fresh();
  let inside = 0;
  let maxInside = 0;
  let counter = 0;
  await Promise.all(Array.from({ length: 50 }, async () => {
    const release = await db.acquireResourceLock(id, 5000);
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    const read = counter;
    await Promise.resolve(); // yield inside the critical section
    counter = read + 1;
    inside -= 1;
    release();
  }));
  assert.equal(counter, 50);
  assert.equal(maxInside, 1);
});
