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
import { generateToken } from '../../server/middleware/auth.js';
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

  test(label('duplicate intake: the same Idempotency-Key registers the patient once'), async () => {
    const idempotency = { key: 'contract-key-1', endpoint: 'POST /emergencies', fingerprint: 'f'.repeat(64) };
    const first = await createCase({ idempotency });
    const second = await createCase({ idempotency });
    assert.equal(second.request_id, first.request_id);
    assert.equal(second.replayed, true);
    assert.equal(await b.countRequests(first.request_id), 1);
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
      const headers = { Authorization: `Bearer ${generateToken({ user_id: ADMIN.id, role: 'ADMIN', hospital_id: null })}` };
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

  test(label('an accept holds the case first, then a cancellation arrives: whichever wins, nothing leaks'), async () => {
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

    assert.equal(cancel.status, 'fulfilled');
    if (b.name === 'mysql') {
      // The cancellation waits for the accept's row lock, then releases what the accept committed.
      assert.equal(accept.status, 'fulfilled');
    } else {
      // Known difference: in-memory transitions write the status without taking the case lock, so the
      // accept (resuming afterwards) sees CANCELLED and refuses. Both orders are consistent.
      assert.equal(accept.status, 'rejected');
    }
    assert.equal(await statusOf(id), 'CANCELLED');
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.equal((await b.allocations(id)).filter(a => a.status === 'COMMITTED').length, 0);
    assert.equal((await b.acceptances(id)).filter(a => a.status === 'PENDING').length, 0);
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
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
