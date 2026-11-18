// Allocation contract: scenarios every storage backend must satisfy, run unchanged against the in-memory
// store (tests/contract_memory.test.js) and the MySQL store (tests/contract_mysql.test.js).
//
// Covers: normal allocation, insufficient resources (no partial reservation), duplicate requests,
// concurrent allocation, every release path (reject, TTL expiry, cancel, return to queue, completion),
// release bounded by total capacity, the analytics capacity figures, forced interleavings (no sleeps),
// and failure recovery. After EVERY scenario the lock-order checker must report no violation.
// All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import analyticsRoutes from '../../server/routes/analytics.js';
import { configureStore } from '../../server/db/store.js';
import { tokenFor } from '../helpers/testUsers.js';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';
import { gate } from '../helpers/gate.js';
import { RESOURCE_TYPES } from './fixture.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-CONTRACT-EMS' };
const ADMIN = { role: 'ADMIN', id: 'U-CONTRACT-ADMIN' };
const DESK = 'U-CONTRACT-DESK-A';

export function registerAllocationContract(b) {
  const label = name => `[${b.name}] ${name}`;

  test.beforeEach(() => b.reset());
  test.afterEach(() => {
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });

  async function createCase({ type = 'RESPIRATORY', idempotency = null } = {}) {
    const req = resolveEmergencyRequirements(type);
    const created = await b.store.createRequest({
      patient: { full_name: 'Fictional Contract Patient', age: 40, gender: 'UNKNOWN', emergency_type: type, triage_priority: 2, contact_phone: null },
      request: {
        emergency_type: type, required_resource_types: req.resourceTypes, required_specialist: req.specialist,
        priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: ''
      }
    }, PARAMEDIC, { idempotency });
    return created;
  }
  const newCase = async options => (await createCase(options)).request_id;
  const respiratoryCapacity = async (hospitalId, total) => {
    await b.setCapacity(hospitalId, 'ICU_BED', { total });
    await b.setCapacity(hospitalId, 'VENTILATOR', { total });
  };
  const lockAt = (hospitalId, requestId) => b.store.acquireReferralLock(hospitalId, requestId, ['ICU_BED', 'VENTILATOR']);
  const statusOf = async id => (await b.request(id)).status;
  const assertNoInvariantBreak = async () => {
    for (const r of await b.allResources()) {
      assert.ok(r.locked >= 0 && r.locked <= r.available && r.available <= r.total,
        `capacity invariant 0 <= locked <= available <= total broken for ${r.hospital_id}/${r.resource_type}: ${JSON.stringify(r)}`);
    }
  };

  // ── Normal allocation ────────────────────────────────────────────────────────────────────────
  test(label('normal allocation: soft-lock reserves, accept commits capacity, allocation rows and the ambulance'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    assert.equal(await statusOf(id), 'MATCHING');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 2, locked: 1 });

    const accepted = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(accepted.ambulance_id, 'AMB-A1', 'the unit stationed at the accepting hospital is dispatched');
    assert.equal(await statusOf(id), 'ALLOCATED');
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 1, locked: 0 });
    assert.deepEqual((await b.allocations(id)).map(a => a.status), ['COMMITTED', 'COMMITTED']);
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'DISPATCHED', assigned_request_id: id });
    const events = (await b.audit(id)).map(e => e.event_type);
    assert.ok(events.includes('LOCK_ACQUIRED') && events.includes('ALLOCATION_COMMITTED'), events.join(','));
    await assertNoInvariantBreak();
    // The lock-order check below (afterEach) is only meaningful if the checker actually saw the locks.
    assert.ok(b.checker.acquisitions >= 3, `the lock-order checker observed ${b.checker.acquisitions} lock acquisitions`);
  });

  // ── Insufficient resources ───────────────────────────────────────────────────────────────────
  test(label('insufficient resources: a compound claim missing one type is refused and leaves no partial reservation'), async () => {
    await b.setCapacity('H-A', 'ICU_BED', { total: 1 });
    await b.setCapacity('H-A', 'VENTILATOR', { total: 1, available: 0 }); // checked after ICU_BED (sorted order)
    const id = await newCase();
    await assert.rejects(lockAt('H-A', id), err => err.status === 409 && /No available VENTILATOR/.test(err.message));
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 }, 'the ICU bed taken first was given back');
    assert.deepEqual(await b.acceptances(id), []);
    assert.equal(await statusOf(id), 'WAITING');
    await assertNoInvariantBreak();
  });

  // ── Duplicate requests ───────────────────────────────────────────────────────────────────────
  test(label('duplicate referral: one case cannot hold two soft-locks'), async () => {
    await respiratoryCapacity('H-A', 1);
    await respiratoryCapacity('H-B', 1);
    const id = await newCase();
    await lockAt('H-A', id);
    await assert.rejects(lockAt('H-B', id), err => err.status === 409 && /already has an active referral lock/.test(err.message));
    assert.deepEqual(await b.resource('H-B', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    assert.equal((await b.acceptances(id)).length, 1);
  });

  test(label('duplicate accept: repeated and concurrent accepts commit once and replay the same outcome'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const results = await Promise.all(Array.from({ length: 5 }, () => b.store.commitReferral(lock.acceptanceId, DESK)));
    assert.equal(results.filter(r => !r.replayed).length, 1, 'exactly one accept applies the allocation');
    assert.ok(results.every(r => r.status === 'ACCEPTED' && r.ambulance_id === 'AMB-A1'));
    const again = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(again.replayed, true);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 1, locked: 0 }, 'capacity consumed once');
    assert.equal((await b.audit(id)).filter(e => e.event_type === 'ALLOCATION_COMMITTED').length, 1);
  });

  test(label('duplicate accept of a case whose stage holds no resources (GENERAL): the retry replays instead of a 409'), async () => {
    const id = await newCase({ type: 'GENERAL' });
    const lock = await b.store.acquireReferralLock('H-A', id, []);
    const first = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(first.status, 'ACCEPTED');
    assert.deepEqual(await b.allocations(id), [], 'nothing is allocated for a GENERAL case');
    const retry = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.deepEqual([retry.status, retry.replayed, retry.acceptanceId, retry.hospitalId], ['ACCEPTED', true, lock.acceptanceId, 'H-A']);
    assert.equal((await b.audit(id)).filter(e => e.event_type === 'ALLOCATION_COMMITTED').length, 1, 'applied once');
    // Still refused once the case is no longer active.
    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), err => err.status === 409);
  });

  test(label('duplicate intake: the same Idempotency-Key registers the patient once'), async () => {
    const idempotency = { key: 'contract-key-1', endpoint: 'POST /emergencies', fingerprint: 'f'.repeat(64) };
    const first = await createCase({ idempotency });
    const second = await createCase({ idempotency });
    assert.equal(second.request_id, first.request_id);
    assert.equal(second.replayed, true);
    assert.equal(await b.countRequests(first.request_id), 1);
  });

  test(label('an Idempotency-Key expires after 24 h on both stores: then it is absent and the request creates a new case (S7)'), async () => {
    const idempotency = { key: 'contract-key-ttl', endpoint: 'POST /emergencies', fingerprint: 'e'.repeat(64) };
    const first = await createCase({ idempotency });
    await b.ageIdempotencyKeys(23);
    const within = await createCase({ idempotency });
    assert.deepEqual([within.request_id, within.replayed], [first.request_id, true], 'a 23 h old key still replays');
    await b.ageIdempotencyKeys(2); // 25 h old now
    const after = await createCase({ idempotency });
    assert.equal(after.replayed, false, 'an expired key is treated as absent');
    assert.notEqual(after.request_id, first.request_id);
    assert.deepEqual([await b.countRequests(first.request_id), await b.countRequests(after.request_id)], [1, 1]);
    const again = await createCase({ idempotency });
    assert.deepEqual([again.request_id, again.replayed], [after.request_id, true], 'the fresh key replays the new case');
  });

  test(label('the queue breaks a same-millisecond tie by request_id, like MySQL ORDER BY priority, request_time, request_id'), async () => {
    const t = Date.UTC(2026, 1, 2, 6, 0, 0, 123);
    const row = (request_id, priority, request_ms) => ({ request_id, request_ms, emergency_type: 'GENERAL', priority, required_resource_types: ['ICU_BED'] });
    // Stored in the opposite order, so storage order cannot produce the expected result by accident.
    await b.insertAnalyticsFixture({ requests: [row('REQ-T3', 2, t + 1), row('REQ-T2', 2, t), row('REQ-T1', 2, t), row('REQ-T0', 1, t + 5)] });
    assert.deepEqual((await b.store.listRequests({})).map(r => r.request_id), ['REQ-T0', 'REQ-T1', 'REQ-T2', 'REQ-T3']);
  });

  test(label('a case created through the store is not demo (is_demo = 0) on both stores (S1)'), async () => {
    const id = await newCase();
    assert.equal((await b.store.getRequest(id)).is_demo, 0);
  });

  test(label('alert messages are truncated to 500 characters on both stores (S7)'), async () => {
    const long = 'x'.repeat(520);
    const alert = await b.store.createAlert({ hospital_id: 'H-A', request_id: null, alert_type: 'SYSTEM', message: long });
    assert.equal(alert.message, 'x'.repeat(500));
    assert.deepEqual((await b.alerts()).map(a => a.message.length), [500], 'stored truncated');
  });

  // ── Concurrent allocation ────────────────────────────────────────────────────────────────────
  test(label('concurrent allocation: 12 cases racing for 1 ICU bed yield exactly one reservation'), async () => {
    await b.setCapacity('H-A', 'ICU_BED', { total: 1 });
    await b.setCapacity('H-A', 'VENTILATOR', { total: 5 });
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(await newCase());
    const results = await Promise.allSettled(ids.map(id => lockAt('H-A', id)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const refused = results.filter(r => r.status === 'rejected');
    assert.equal(refused.length, 11);
    assert.ok(refused.every(r => r.reason.status === 409), refused.map(r => r.reason.message).join('; '));
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 1 });
    assert.deepEqual(await b.resource('H-A', 'VENTILATOR'), { total: 5, available: 5, locked: 1 }, 'losers hold no ventilator');
    await assertNoInvariantBreak();
  });

  // ── Release paths ────────────────────────────────────────────────────────────────────────────
  test(label('release on rejection: soft-locked capacity returns and the case is queued again'), async () => {
    await respiratoryCapacity('H-A', 1); // no other hospital has capacity, so there is no failover target
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const result = await b.store.rejectReferral(lock.acceptanceId, 'Fictional rejection', DESK);
    assert.equal(result.next_acceptance_id, null);
    assert.equal((await b.acceptances(id))[0].status, 'REJECTED');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    assert.equal(await statusOf(id), 'WAITING');
  });

  test(label('release on TTL expiry: capacity returns and the case is queued again'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.forceExpire(lock.acceptanceId);
    assert.equal(await b.engine.expireLock(lock.acceptanceId), true);
    assert.equal((await b.acceptances(id))[0].status, 'EXPIRED');
    assert.deepEqual(await b.resource('H-A', 'VENTILATOR'), { total: 1, available: 1, locked: 0 });
    assert.equal(await statusOf(id), 'WAITING');
  });

  test(label('release on cancellation while pending: the lock is cancelled and cannot be accepted afterwards'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.store.transitionRequestStatus(id, 'CANCELLED', ADMIN);
    assert.equal(await statusOf(id), 'CANCELLED');
    assert.equal((await b.acceptances(id))[0].status, 'CANCELLED');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), err => err.status === 409);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
  });

  test(label('release on return to queue (MATCHING -> WAITING): the pending lock is dropped'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    await lockAt('H-A', id);
    await b.store.transitionRequestStatus(id, 'WAITING', ADMIN);
    assert.equal(await statusOf(id), 'WAITING');
    assert.equal((await b.acceptances(id))[0].status, 'CANCELLED');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    // Same audit row on both backends: the referral's own state change, not the case's new status.
    const cancelledRows = (await b.audit(id)).filter(e => e.event_type === 'LOCK_CANCELLED').map(e => [e.previous_state, e.new_state]);
    assert.deepEqual(cancelledRows, [['PENDING_ACCEPTANCE', 'CANCELLED']]);
  });

  test(label('release on completion: committed capacity and the ambulance return'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    await b.store.transitionRequestStatus(id, 'IN_TREATMENT', ADMIN);
    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
    assert.deepEqual((await b.allocations(id)).map(a => a.status), ['RELEASED', 'RELEASED']);
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
    const completed = (await b.audit(id)).filter(e => e.event_type === 'STATUS_CHANGED' && e.new_state === 'COMPLETED');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].metadata, { released_allocations: 2, capped_releases: 0 });
  });

  // ── Release bounded by total capacity ────────────────────────────────────────────────────────
  test(label('a release never raises available above total after the hospital reduced its capacity'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 1, locked: 0 });

    // One ICU bed is taken out of service while the patient still occupies the other.
    await b.store.updateResourceCapacity('H-A', 'ICU_BED', { total: 1, available: 1 }, ADMIN);
    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);

    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 }, 'capped at total, not 2');
    assert.deepEqual(await b.resource('H-A', 'VENTILATOR'), { total: 2, available: 2, locked: 0 }, 'an unaffected type returns normally');
    const completed = (await b.audit(id)).find(e => e.event_type === 'STATUS_CHANGED' && e.new_state === 'COMPLETED');
    assert.deepEqual(completed.metadata, { released_allocations: 2, capped_releases: 1 }, 'the capped return is recorded');
    await assertNoInvariantBreak();
  });

  // ── Analytics capacity figures ───────────────────────────────────────────────────────────────
  test(label('analytics: "available" means free (soft-locked units excluded); free + locked + in_use = total'), async () => {
    await respiratoryCapacity('H-A', 3);
    const committed = await newCase();
    await b.store.commitReferral((await lockAt('H-A', committed)).acceptanceId, DESK);
    await lockAt('H-A', await newCase()); // one more bed and ventilator soft-locked, pending

    configureStore(b.store);
    const app = express();
    app.use('/api/v1/analytics', analyticsRoutes);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/v1/analytics`;
      const headers = { Authorization: `Bearer ${await tokenFor(b.store, { user_id: ADMIN.id, role: 'ADMIN', hospital_id: null })}` };
      const dashboard = (await (await fetch(`${base}/dashboard`, { headers })).json()).dashboard;
      assert.equal(dashboard.kpis.icu_available, 1, 'free ICU beds across the network: 3 total - 1 committed - 1 soft-locked');
      assert.equal(dashboard.kpis.icu_locked, 1);
      assert.equal(dashboard.kpis.icu_total, 3);
      assert.equal(dashboard.kpis.ventilators_available, 1);
      const hospitalA = dashboard.hospital_statuses.find(h => h.hospital_id === 'H-A');
      assert.deepEqual([hospitalA.icu_available, hospitalA.icu_total], [1, 3]);

      const utilization = (await (await fetch(`${base}/resources`, { headers })).json()).utilization;
      assert.deepEqual(utilization.find(h => h.hospital_id === 'H-A').resources.ICU_BED,
        { total: 3, available: 1, locked: 1, in_use: 1, utilization_pct: 33 });
      for (const hospital of utilization) {
        for (const [type, r] of Object.entries(hospital.resources)) {
          assert.equal(r.available + r.locked + r.in_use, r.total, `${hospital.hospital_id}/${type}`);
        }
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    const kpis = await b.store.getKpis();
    assert.deepEqual([kpis.icu_available, kpis.ventilators_available], [1, 1], 'live socket KPIs use the same definition');
  });

  // ── Forced interleavings (deterministic: hooks, no sleeps) ───────────────────────────────────
  test(label('cancellation recorded first, then an accept arrives: the accept is refused, nothing is allocated'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const held = gate();
    b.hooks.once('transition:statusRecorded', held.hold, ctx => ctx.requestId === id);

    const cancelling = b.store.transitionRequestStatus(id, 'CANCELLED', ADMIN);
    await held.reached; // the new status is written; MySQL also still holds the request row
    const accepting = b.store.commitReferral(lock.acceptanceId, DESK);
    held.release();

    await assert.rejects(accepting, err => err.status === 409);
    await cancelling;
    assert.equal(await statusOf(id), 'CANCELLED');
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
  });

  test(label('an accept holds the case first, then a cancellation arrives: the accept wins on both backends, then the cancellation releases it'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const held = gate();
    b.hooks.once('commit:requestLocked', held.hold, ctx => ctx.acceptanceId === lock.acceptanceId);

    const accepting = b.store.commitReferral(lock.acceptanceId, DESK);
    await held.reached; // the accept owns the case's lock
    const cancelling = b.store.transitionRequestStatus(id, 'CANCELLED', ADMIN);
    held.release();
    const [accept, cancel] = await Promise.allSettled([accepting, cancelling]);

    // L-T3: the SAME winner on both backends. The cancellation waits for the case lock the accept holds (the MySQL
    // row lock / the in-memory request lock), then releases what the accept committed.
    assert.equal(cancel.status, 'fulfilled', cancel.reason?.message);
    assert.equal(accept.status, 'fulfilled', accept.reason?.message);
    assert.equal(accept.value.status, 'ACCEPTED');
    assert.equal(cancel.value.previous, 'ALLOCATED');
    assert.deepEqual((await b.allocations(id)).map(a => a.status), ['RELEASED', 'RELEASED']);
    assert.equal(await statusOf(id), 'CANCELLED');
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    assert.equal((await b.acceptances(id)).filter(a => a.status === 'PENDING').length, 0);
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
  });

  // ── Locking parity (round-1 review L1-L4, L-T3) ─────────────────────────────────────────────
  for (const target of ['ALLOCATED', 'IN_TREATMENT']) {
    test(label(`L1: a store-level referral for an ${target} case is refused by the engine; capacity, allocations and ambulances are unchanged`), async () => {
      await respiratoryCapacity('H-A', 2);
      await respiratoryCapacity('H-B', 2);
      const id = await newCase();
      await b.store.commitReferral((await lockAt('H-A', id)).acceptanceId, DESK);
      if (target === 'IN_TREATMENT') await b.store.transitionRequestStatus(id, 'IN_TREATMENT', ADMIN);
      const snapshot = async () => ({
        resources: await b.allResources(), allocations: await b.allocations(id), acceptances: await b.acceptances(id),
        ambulances: [await b.ambulance('AMB-A1'), await b.ambulance('AMB-B1')]
      });
      const before = await snapshot();

      await assert.rejects(lockAt('H-B', id), err => err.status === 409 && err.message.includes(`is ${target} and cannot receive a referral`));
      assert.equal(await statusOf(id), target);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await b.engine.getActiveLocks()).length, 0);
    });
  }

  test(label('L1: the case is already MATCHING when the lock is announced (status written with the lock, not after it)'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    const seen = [];
    const listener = lock => { if (lock.requestId === id) seen.push(b.request(lock.requestId)); };
    b.engine.on('lock_acquired', listener);
    try {
      await lockAt('H-A', id);
    } finally {
      b.engine.off('lock_acquired', listener);
    }
    assert.deepEqual((await Promise.all(seen)).map(r => r.status), ['MATCHING']);
  });

  test(label('L2: MATCHING -> WAITING racing a rejection\'s failover ends WAITING with no pending referral and nothing held'), async () => {
    await respiratoryCapacity('H-A', 1);
    await respiratoryCapacity('H-B', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const held = gate();
    b.hooks.once('acquire:hospitalLocked', held.hold, ctx => ctx.requestId === id && ctx.hospitalId === 'H-B');

    const rejecting = b.store.rejectReferral(lock.acceptanceId, 'Fictional rejection', DESK);
    await held.reached; // the failover's acquire holds the case (and H-B)
    const requeueing = b.store.transitionRequestStatus(id, 'WAITING', ADMIN);
    held.release();
    const [rejected, requeued] = await Promise.allSettled([rejecting, requeueing]);

    assert.equal(rejected.status, 'fulfilled', rejected.reason?.message);
    assert.equal(rejected.value.next_hospital_id, 'H-B', 'the failover placed the referral first');
    assert.equal(requeued.status, 'fulfilled', requeued.reason?.message);
    assert.deepEqual([requeued.value.previous, requeued.value.unchanged], ['MATCHING', false], 'the transition ran after the failover, under the case lock');
    assert.equal(await statusOf(id), 'WAITING');
    assert.deepEqual((await b.acceptances(id)).map(a => [a.hospital_id, a.status]).sort(), [['H-A', 'REJECTED'], ['H-B', 'CANCELLED']]);
    assert.equal((await b.engine.getActiveLocks()).filter(l => l.requestId === id).length, 0);
    for (const h of ['H-A', 'H-B']) assert.deepEqual(await b.resource(h, 'ICU_BED'), { total: 1, available: 1, locked: 0 }, h);
    await assertNoInvariantBreak();
  });

  test(label('L3: MATCHING -> WAITING recorded first, then an accept arrives: the accept is refused and nothing is allocated'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const held = gate();
    b.hooks.once('transition:statusRecorded', held.hold, ctx => ctx.requestId === id);

    const requeueing = b.store.transitionRequestStatus(id, 'WAITING', ADMIN);
    await held.reached; // WAITING is written and the case lock is held
    const accepting = b.store.commitReferral(lock.acceptanceId, DESK);
    held.release();

    await assert.rejects(accepting, err => err.status === 409);
    await requeueing;
    assert.equal(await statusOf(id), 'WAITING');
    assert.equal((await b.acceptances(id))[0].status, 'CANCELLED');
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
    assert.deepEqual((await b.audit(id)).filter(e => e.event_type === 'STATUS_CHANGED').map(e => e.new_state), ['WAITING']);
  });

  test(label('L3: an accept holds the case first, then MATCHING -> WAITING arrives: the accept wins, the transition is refused, the audit agrees'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const held = gate();
    b.hooks.once('commit:requestLocked', held.hold, ctx => ctx.acceptanceId === lock.acceptanceId);

    const accepting = b.store.commitReferral(lock.acceptanceId, DESK);
    await held.reached; // the accept owns the case's lock
    const requeueing = b.store.transitionRequestStatus(id, 'WAITING', ADMIN);
    held.release();
    const [accept, requeue] = await Promise.allSettled([accepting, requeueing]);

    assert.equal(accept.status, 'fulfilled', accept.reason?.message);
    assert.equal(requeue.status, 'rejected');
    assert.ok(requeue.reason.status === 409 && /ALLOCATED -> WAITING/.test(requeue.reason.message), requeue.reason.message);
    assert.equal(await statusOf(id), 'ALLOCATED');
    assert.deepEqual((await b.allocations(id)).map(a => a.status), ['COMMITTED', 'COMMITTED']);
    const events = (await b.audit(id)).map(e => `${e.event_type}:${e.new_state}`);
    assert.ok(!events.some(e => e.startsWith('STATUS_CHANGED')), `no status change was recorded: ${events.join(',')}`);
    assert.equal(events.at(-1), 'ALLOCATION_COMMITTED:ALLOCATED');
  });

  test(label('L3: a pending referral of a case that is no longer MATCHING cannot be accepted (an unlocked status write)'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.setRequestStatus(id, 'WAITING'); // as an unlocked writer or a manual edit would leave it

    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK),
      err => err.status === 409 && /only a case in MATCHING can be allocated/.test(err.message));
    assert.equal(await statusOf(id), 'WAITING');
    assert.equal((await b.acceptances(id))[0].status, 'PENDING', 'nothing changed: the lock is left for its expiry/cancel path');
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 2, locked: 1 });
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
  });

  test(label('L4(a): an accept after the lock\'s expiry is refused even before the expiry has been processed'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.forceExpire(lock.acceptanceId);

    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), err => err.status === 409 && /has expired/.test(err.message));
    assert.equal(await statusOf(id), 'MATCHING');
    assert.equal((await b.acceptances(id))[0].status, 'PENDING');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 1 });
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    // The expiry path then releases it as usual.
    assert.equal(await b.engine.expireLock(lock.acceptanceId), true);
    assert.equal(await statusOf(id), 'WAITING');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
  });

  test(label('L4(b): an infrastructure failure during failover stops it; the rejection still succeeds and the case stays queued'), async () => {
    await respiratoryCapacity('H-A', 1);
    await respiratoryCapacity('H-B', 1);
    await respiratoryCapacity('H-D', 1); // a further candidate the failover must NOT try after the failure
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    b.hooks.once('acquire:hospitalLocked', () => { throw new Error('injected infrastructure failure'); }, ctx => ctx.requestId === id && ctx.hospitalId === 'H-B');

    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let result;
    try {
      result = await b.store.rejectReferral(lock.acceptanceId, 'Fictional rejection', DESK);
    } finally {
      console.error = originalError;
    }
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.next_acceptance_id, null);
    assert.ok(logged.some(line => /injected infrastructure failure/.test(line)), 'the failure is logged');
    assert.equal(await statusOf(id), 'WAITING');
    assert.deepEqual((await b.acceptances(id)).map(a => [a.hospital_id, a.status]), [['H-A', 'REJECTED']]);
    for (const h of ['H-A', 'H-B', 'H-D']) assert.deepEqual(await b.resource(h, 'ICU_BED'), { total: 1, available: 1, locked: 0 }, h);
  });

  test(label('L4(c): an accept whose soft-locked unit is gone (corrupt counters) is refused and changes nothing'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.setCapacity('H-A', 'VENTILATOR', { total: 2, available: 2, locked: 0 }); // the lock's ventilator unit vanished

    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK),
      err => err.status === 409 && /Capacity of VENTILATOR at H-A is inconsistent/.test(err.message));
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 2, locked: 1 }, 'the ICU bed (sorted first) was not committed');
    assert.deepEqual(await b.resource('H-A', 'VENTILATOR'), { total: 2, available: 2, locked: 0 });
    assert.equal(await statusOf(id), 'MATCHING');
    assert.equal((await b.acceptances(id))[0].status, 'PENDING');
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
  });

  test(label('L4(d): rejection and expiry write the same audit trail (names, states, metadata, order) on both backends'), async () => {
    await respiratoryCapacity('H-A', 1);
    await respiratoryCapacity('H-B', 1);
    await respiratoryCapacity('H-D', 1);
    const id = await newCase();
    const first = await lockAt('H-A', id);
    const rejected = await b.store.rejectReferral(first.acceptanceId, 'Fictional rejection', DESK);
    assert.equal(rejected.next_hospital_id, 'H-B');
    await b.forceExpire(rejected.next_acceptance_id);
    assert.equal(await b.engine.expireLock(rejected.next_acceptance_id), true);

    // previous_state included: a failover's LOCK_ACQUIRED starts from WAITING because the release re-queued the case first.
    const trail = (await b.audit(id)).map(e => [e.event_type, e.previous_state, e.new_state]);
    assert.deepEqual(trail, [
      ['REQUEST_CREATED', null, 'WAITING'],
      ['LOCK_ACQUIRED', 'WAITING', 'PENDING_ACCEPTANCE'],
      ['LOCK_REJECTED', 'PENDING_ACCEPTANCE', 'REJECTED'],
      ['LOCK_ACQUIRED', 'WAITING', 'PENDING_ACCEPTANCE'],
      ['LOCK_TTL_EXPIRED_FAILOVER', 'PENDING_ACCEPTANCE', 'EXPIRED'],
      ['LOCK_ACQUIRED', 'WAITING', 'PENDING_ACCEPTANCE']
    ]);
    const events = await b.audit(id);
    assert.deepEqual(events[2].metadata, { acceptanceId: first.acceptanceId, rejectionReason: 'Fictional rejection' });
    assert.deepEqual(events[4].metadata, { acceptanceId: rejected.next_acceptance_id });
    assert.equal(await statusOf(id), 'MATCHING');
    assert.deepEqual((await b.acceptances(id)).map(a => [a.hospital_id, a.status]).sort(), [['H-A', 'REJECTED'], ['H-B', 'EXPIRED'], ['H-D', 'PENDING']]);
  });

  test(label('L2: stranded-case recovery re-queues a MATCHING case without a pending referral, and only such a case'), async () => {
    await respiratoryCapacity('H-A', 1);
    const stranded = await newCase();
    await b.setRequestStatus(stranded, 'MATCHING'); // MATCHING, but no referral holds it
    const live = await newCase();
    await lockAt('H-A', live);

    assert.equal(await b.engine.requeueStrandedRequests(), 1);
    assert.equal(await statusOf(stranded), 'WAITING');
    assert.equal(await statusOf(live), 'MATCHING', 'a case with a pending referral is left alone');
    const last = (await b.audit(stranded)).at(-1);
    assert.deepEqual([last.event_type, last.new_state], ['STRANDED_MATCHING_REQUEUED', 'WAITING']);
    assert.equal(await b.engine.requeueStrandedRequests(), 0, 'idempotent');
  });

  test(label('L2: a stranded sweep racing an acquire of the same case leaves it MATCHING with its live referral, which can be accepted'), async () => {
    await respiratoryCapacity('H-A', 1);
    const id = await newCase();
    await b.setRequestStatus(id, 'MATCHING'); // stranded: MATCHING with no referral
    const acquiring = gate();
    b.hooks.once('acquire:hospitalLocked', acquiring.hold, ctx => ctx.requestId === id);
    const locking = lockAt('H-A', id);
    await acquiring.reached; // the acquire holds the case, no referral recorded yet

    const scanned = gate();
    b.hooks.once('stranded:scanned', scanned.hold);
    const sweeping = b.engine.requeueStrandedRequests();
    const scan = await scanned.reached;
    assert.ok(scan.requestIds.includes(id), 'the unlocked scan saw the case as stranded');
    acquiring.release();
    const lock = await locking; // the referral is placed (and committed) before the sweep re-checks
    scanned.release();

    assert.equal(await sweeping, 0, 'the re-check under the case lock sees the pending referral');
    assert.equal(await statusOf(id), 'MATCHING');
    assert.deepEqual((await b.acceptances(id)).map(a => a.status), ['PENDING']);
    assert.equal((await b.engine.getActiveLocks()).filter(l => l.requestId === id).length, 1);
    assert.ok(!(await b.audit(id)).some(e => e.event_type === 'STRANDED_MATCHING_REQUEUED'));
    assert.equal((await b.store.commitReferral(lock.acceptanceId, DESK)).status, 'ACCEPTED');
    assert.equal(await statusOf(id), 'ALLOCATED');
  });

  // ── Failure recovery ─────────────────────────────────────────────────────────────────────────
  test(label('a failure inside an accept leaves no partial state, and the accept can be retried'), async () => {
    await respiratoryCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    b.hooks.once('commit:requestLocked', () => { throw new Error('injected failure'); });

    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), /injected failure/);
    assert.equal(await statusOf(id), 'MATCHING');
    assert.equal((await b.acceptances(id))[0].status, 'PENDING');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 2, locked: 1 });
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0, 'nothing was committed');
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });

    const retried = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(retried.status, 'ACCEPTED');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 1, locked: 0 });
  });

  test(label('every resource type exists in the fixture for every hospital (fixture sanity)'), async () => {
    const rows = await b.allResources();
    for (const type of RESOURCE_TYPES) assert.equal(rows.filter(r => r.resource_type === type).length, 4);
  });
}
