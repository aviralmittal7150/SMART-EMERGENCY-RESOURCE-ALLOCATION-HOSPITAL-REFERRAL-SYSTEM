// Specialist-reservation and per-hospital-lock contract (Phase 3 Step 3, decision D3-B), run unchanged
// against the in-memory store (tests/contract_memory.test.js) and the MySQL store (tests/contract_mysql.test.js).
//
// Covers: the exclusive trauma surgeon's lifecycle (RESERVED -> ASSIGNED -> IN_PROCEDURE -> AVAILABLE), two
// cases competing for one surgeon (concurrent and forced), every release path (reject + failover, TTL expiry,
// cancel while pending, return to queue, cancel after accept, completion), rollback when the claim fails,
// non-exclusive specialists (checked, never reserved), administrative doctor edits while reserved, accept
// replay and retry, and the per-hospital lock itself: same hospital serialised, other hospitals unaffected.
// Interleavings are forced with execution hooks and observed through explicit events or lock probes, never
// with sleeps. After every scenario the lock-order checker must report no violation. All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';
import { gate } from '../helpers/gate.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-CONTRACT-EMS' };
const ADMIN = { role: 'ADMIN', id: 'U-CONTRACT-ADMIN' };
const DESK = 'U-CONTRACT-DESK-A';
const TRAUMA_TYPES = ['ICU_BED', 'OT'];

/** Wait (event loop turns, no timers) until `condition()` holds; fail after `limit` turns. */
async function until(condition, what, limit = 20000) {
  for (let i = 0; i < limit; i += 1) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for: ${what}`);
}

export function registerSpecialistContract(b) {
  const label = name => `[${b.name}] specialists: ${name}`;

  // Every gate a test opens is released, and every operation it paused is settled, even when the test
  // fails midway: a paused MySQL transaction left open would hold its row and metadata locks and block
  // the next test's reset forever.
  const openGates = [];
  const pausedOps = [];
  const hold = () => {
    const g = gate();
    openGates.push(g);
    return g;
  };
  const track = promise => {
    pausedOps.push(promise);
    return promise;
  };

  test.beforeEach(() => b.reset());
  test.afterEach(async () => {
    openGates.splice(0).forEach(g => g.release());
    await Promise.allSettled(pausedOps.splice(0));
    b.hooks.clear();
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });

  async function newCase(type = 'TRAUMA') {
    const req = resolveEmergencyRequirements(type);
    const created = await b.store.createRequest({
      patient: { full_name: 'Fictional Specialist Patient', age: 35, gender: 'UNKNOWN', emergency_type: type, triage_priority: 1, contact_phone: null },
      request: {
        emergency_type: type, required_resource_types: req.resourceTypes, required_specialist: req.specialist,
        priority: 1, pickup_lat: null, pickup_lng: null, clinical_notes: ''
      }
    }, PARAMEDIC);
    return created.request_id;
  }
  const traumaCapacity = async (hospitalId, total) => {
    for (const type of TRAUMA_TYPES) await b.setCapacity(hospitalId, type, { total });
  };
  const lockAt = (hospitalId, requestId, types = TRAUMA_TYPES) => b.store.acquireReferralLock(hospitalId, requestId, types);
  const statusOf = async id => (await b.request(id)).status;
  const doctorStatus = async id => (await b.doctor(id)).status;
  const activeAssignments = async () => (await b.assignments()).filter(a => a.status !== 'RELEASED');
  const assertNoDoubleBooking = async () => {
    const active = await activeAssignments();
    const doctors = active.map(a => a.doctor_id);
    assert.equal(new Set(doctors).size, doctors.length, `a doctor holds two active assignments: ${JSON.stringify(active)}`);
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────────
  test(label('the trauma surgeon is RESERVED by the referral, ASSIGNED on accept, IN_PROCEDURE in treatment, AVAILABLE on completion'), async () => {
    await traumaCapacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    assert.equal(lock.specialistId, 'DR-A02');
    assert.equal(await doctorStatus('DR-A02'), 'RESERVED');
    assert.deepEqual(await b.assignments(id), [{ doctor_id: 'DR-A02', hospital_id: 'H-A', acceptance_id: lock.acceptanceId, status: 'LOCKED' }]);

    const accepted = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(accepted.specialist_id, 'DR-A02');
    assert.equal(await doctorStatus('DR-A02'), 'ASSIGNED');
    assert.equal((await b.assignments(id))[0].status, 'COMMITTED');

    await b.store.transitionRequestStatus(id, 'IN_TREATMENT', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'IN_PROCEDURE');
    assert.equal((await b.assignments(id))[0].status, 'COMMITTED', 'still assigned to this case during the procedure');

    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.equal((await b.assignments(id))[0].status, 'RELEASED');
    const completed = (await b.audit(id)).find(e => e.event_type === 'STATUS_CHANGED' && e.new_state === 'COMPLETED');
    // Staged claim (D2-B): completed in stage 1, so only the stage-1 OT was ever allocated; the ICU bed is stage 2.
    assert.deepEqual(completed.metadata, { released_allocations: 1, capped_releases: 0, released_specialists: ['DR-A02'] });
    const acquired = (await b.audit(id)).find(e => e.event_type === 'LOCK_ACQUIRED');
    assert.equal(acquired.metadata.specialistId, 'DR-A02');
    assert.ok(b.checker.acquisitions >= 3, `the lock-order checker observed ${b.checker.acquisitions} lock acquisitions`);
  });

  // ── Competition for one surgeon ──────────────────────────────────────────────────────────────
  test(label('six trauma cases racing for the one surgeon at a hospital: exactly one reservation, no double booking'), async () => {
    await traumaCapacity('H-A', 10); // capacity is plentiful: the surgeon is the only scarce thing
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await newCase());
    const results = await Promise.allSettled(ids.map(id => lockAt('H-A', id)));
    const won = results.filter(r => r.status === 'fulfilled');
    assert.equal(won.length, 1, results.map(r => r.reason?.message).join('; '));
    const lost = results.filter(r => r.status === 'rejected');
    assert.ok(lost.every(r => r.reason.status === 409 && /TRAUMA_SURGEON is not available/.test(r.reason.message)),
      lost.map(r => r.reason.message).join('; '));
    assert.equal(won[0].value.specialistId, 'DR-A02');
    assert.equal(await doctorStatus('DR-A02'), 'RESERVED');
    assert.equal((await activeAssignments()).length, 1);
    await assertNoDoubleBooking();
    // Staged claim (D2-B): admission soft-locks only the stage-1 OT; the ICU bed is claimed for stage 2, not held.
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 10, available: 10, locked: 1 }, 'losers hold no OT');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 10, available: 10, locked: 0 }, 'nobody holds an ICU bed in stage 1');
  });

  test(label('forced: a second case at the same hospital waits for the hospital lock, then finds the surgeon taken'), async () => {
    await traumaCapacity('H-A', 5);
    const first = await newCase();
    const second = await newCase();
    const held = hold();
    b.hooks.once('acquire:hospitalLocked', held.hold, ctx => ctx.requestId === first);

    const firstLock = track(lockAt('H-A', first));
    await held.reached; // the first referral holds H-A's lock and has not reserved anyone yet
    assert.equal(await b.hospitalLockHeld('H-A'), true, 'the paused referral holds the per-hospital lock');
    assert.equal(await b.hospitalLockHeld('H-B'), false, 'other hospitals are not locked');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');

    const secondArrived = hold();
    b.hooks.once('acquire:requestLocked', secondArrived.hold, ctx => ctx.requestId === second);
    const secondLock = track(lockAt('H-A', second));
    await secondArrived.reached;
    secondArrived.release(); // the second referral now goes for H-A's lock
    // Proof that the second referral is blocked by the first (not merely slower): it is queued for H-A's
    // lock (memory: the mutex queue; MySQL: its FOR UPDATE on the Hospital row is still executing).
    await until(async () => (await b.hospitalLockWaiters('H-A')) === 1, 'the second referral to wait for H-A');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE', 'nobody has reserved the surgeon while both wait');
    held.release();

    const [a, c] = await Promise.allSettled([firstLock, secondLock]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(a.value.specialistId, 'DR-A02');
    assert.equal(c.status, 'rejected');
    assert.match(c.reason.message, /TRAUMA_SURGEON is not available at H-A/);
    assert.equal(await statusOf(second), 'WAITING');
    await assertNoDoubleBooking();
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 5, available: 5, locked: 1 });
  });

  test(label('forced: while one referral holds H-A, a case at H-B is locked AND accepted (hospitals do not block each other)'), async () => {
    await traumaCapacity('H-A', 1);
    await traumaCapacity('H-B', 1);
    const atA = await newCase();
    const atB = await newCase();
    const held = hold();
    b.hooks.once('acquire:hospitalLocked', held.hold, ctx => ctx.requestId === atA);

    const lockA = track(lockAt('H-A', atA));
    await held.reached;
    assert.equal(await b.hospitalLockHeld('H-A'), true);
    // The whole H-B handshake completes while H-A stays locked (it would hang here if it needed H-A).
    assert.equal(await b.hospitalLockWaiters('H-B'), 0);
    const lockB = await lockAt('H-B', atB);
    assert.equal(lockB.specialistId, 'DR-B01');
    const acceptedB = await b.store.commitReferral(lockB.acceptanceId, DESK);
    assert.equal(acceptedB.specialist_id, 'DR-B01');
    assert.equal(await b.hospitalLockHeld('H-A'), true, 'H-A was held throughout');
    held.release();

    assert.equal((await lockA).specialistId, 'DR-A02');
    assert.equal(await doctorStatus('DR-A02'), 'RESERVED');
    assert.equal(await doctorStatus('DR-B01'), 'ASSIGNED');
    assert.equal(await b.hospitalLockHeld('H-A'), false, 'released once the referral committed');
  });

  test(label('forced: a capacity edit at a locked hospital waits for the referral holding it'), async () => {
    await traumaCapacity('H-A', 2);
    const id = await newCase();
    const held = hold();
    b.hooks.once('acquire:hospitalLocked', held.hold, ctx => ctx.requestId === id);
    const locking = track(lockAt('H-A', id));
    await held.reached;
    const editing = track(b.store.updateResourceCapacity('H-A', 'OT', { total: 3, available: 3 }, ADMIN));
    await until(async () => (await b.hospitalLockWaiters('H-A')) === 1, 'the capacity edit to wait for H-A');
    held.release();
    await locking;
    await editing;
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 3, available: 3, locked: 1 }, 'the edit kept the referral\'s soft-lock');
  });

  // ── Release paths ────────────────────────────────────────────────────────────────────────────
  test(label('rejection releases the surgeon, and failover reserves the next hospital\'s surgeon'), async () => {
    await traumaCapacity('H-A', 1);
    await traumaCapacity('H-B', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const result = await b.store.rejectReferral(lock.acceptanceId, 'Fictional rejection', DESK);
    assert.equal(result.next_hospital_id, 'H-B');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.equal(await doctorStatus('DR-B01'), 'RESERVED');
    assert.deepEqual((await b.assignments(id)).map(a => [a.doctor_id, a.status]), [['DR-A02', 'RELEASED'], ['DR-B01', 'LOCKED']]);
    await assertNoDoubleBooking();
  });

  test(label('TTL expiry releases the surgeon'), async () => {
    await traumaCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.forceExpire(lock.acceptanceId);
    assert.equal(await b.engine.expireLock(lock.acceptanceId), true);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.deepEqual((await b.assignments(id)).map(a => a.status), ['RELEASED']);
    // and the surgeon can be reserved again by another case
    const other = await newCase();
    assert.equal((await lockAt('H-A', other)).specialistId, 'DR-A02');
  });

  test(label('cancelling a pending case, or returning it to the queue, releases the surgeon'), async () => {
    await traumaCapacity('H-A', 2);
    const cancelled = await newCase();
    await lockAt('H-A', cancelled);
    await b.store.transitionRequestStatus(cancelled, 'CANCELLED', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.deepEqual((await b.assignments(cancelled)).map(a => a.status), ['RELEASED']);

    const requeued = await newCase();
    await lockAt('H-A', requeued);
    assert.equal(await doctorStatus('DR-A02'), 'RESERVED');
    await b.store.transitionRequestStatus(requeued, 'WAITING', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.deepEqual((await b.assignments(requeued)).map(a => a.status), ['RELEASED']);
  });

  test(label('cancelling an accepted case releases the assigned surgeon with its resources'), async () => {
    await traumaCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(await doctorStatus('DR-A02'), 'ASSIGNED');
    await b.store.transitionRequestStatus(id, 'CANCELLED', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.deepEqual((await b.assignments(id)).map(a => a.status), ['RELEASED']);
    for (const type of TRAUMA_TYPES) assert.deepEqual(await b.resource('H-A', type), { total: 1, available: 1, locked: 0 });
  });

  // ── Failure and rollback ─────────────────────────────────────────────────────────────────────
  test(label('a claim that fails on capacity reserves nobody; one that fails on the surgeon locks no capacity'), async () => {
    await b.setCapacity('H-A', 'ICU_BED', { total: 1 }); // no OT at H-A
    const noOt = await newCase();
    await assert.rejects(lockAt('H-A', noOt), err => err.status === 409 && /No available OT/.test(err.message));
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.deepEqual(await b.assignments(noOt), []);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });

    await b.setCapacity('H-A', 'OT', { total: 1 });
    await b.store.updateDoctorStatus('DR-A02', 'OFF_DUTY', ADMIN);
    const noSurgeon = await newCase();
    await assert.rejects(lockAt('H-A', noSurgeon), err => err.status === 409 && /TRAUMA_SURGEON is not available/.test(err.message));
    for (const type of TRAUMA_TYPES) assert.deepEqual(await b.resource('H-A', type), { total: 1, available: 1, locked: 0 });
    assert.deepEqual(await b.assignments(noSurgeon), []);
    assert.equal(await doctorStatus('DR-A02'), 'OFF_DUTY', 'an off-duty surgeon is never reserved');
  });

  test(label('a failure inside the accept leaves the surgeon RESERVED; the retried accept assigns, a replay reports the surgeon'), async () => {
    await traumaCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    b.hooks.once('commit:requestLocked', () => { throw new Error('injected failure'); });
    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), /injected failure/);
    assert.equal(await doctorStatus('DR-A02'), 'RESERVED');
    assert.deepEqual((await b.assignments(id)).map(a => a.status), ['LOCKED']);

    const accepted = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(accepted.specialist_id, 'DR-A02');
    const replay = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.deepEqual([replay.replayed, replay.specialist_id], [true, 'DR-A02']);
    assert.equal((await b.assignments(id)).length, 1, 'the replay created no second assignment');
    assert.equal(await doctorStatus('DR-A02'), 'ASSIGNED');
  });

  // ── Non-exclusive specialists ────────────────────────────────────────────────────────────────
  test(label('a cardiologist (not exclusive) is only checked: two cardiac cases share them and nobody is reserved'), async () => {
    for (const type of ['ICU_BED', 'VENTILATOR']) await b.setCapacity('H-A', type, { total: 2 });
    const first = await newCase('CARDIAC');
    const second = await newCase('CARDIAC');
    const locks = [await lockAt('H-A', first, ['ICU_BED', 'VENTILATOR']), await lockAt('H-A', second, ['ICU_BED', 'VENTILATOR'])];
    assert.deepEqual(locks.map(l => l.specialistId), [null, null]);
    assert.equal(await doctorStatus('DR-A01'), 'AVAILABLE');
    assert.deepEqual(await b.assignments(), []);
  });

  // ── Administrative doctor changes ────────────────────────────────────────────────────────────
  test(label('a reserved or assigned surgeon cannot be edited or removed; after release the status can change, removal keeps history'), async () => {
    await traumaCapacity('H-A', 1);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    // The 409 wording is identical on both stores (S7).
    await assert.rejects(b.store.updateDoctorStatus('DR-A02', 'OFF_DUTY', ADMIN),
      err => err.status === 409 && err.message === `Doctor DR-A02 cannot change status while RESERVED for case ${id}.`);
    await assert.rejects(b.store.removeDoctor('DR-A02', ADMIN),
      err => err.status === 409 && err.message === `Doctor DR-A02 cannot be removed while RESERVED for case ${id}.`);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    await assert.rejects(b.store.updateDoctorStatus('DR-A02', 'AVAILABLE', ADMIN),
      err => err.status === 409 && err.message === `Doctor DR-A02 cannot change status while ASSIGNED for case ${id}.`);
    assert.equal(await doctorStatus('DR-A02'), 'ASSIGNED', 'the refused edit changed nothing');

    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
    assert.equal((await b.store.updateDoctorStatus('DR-A02', 'OFF_DUTY', ADMIN)).new_status, 'OFF_DUTY');
    await assert.rejects(b.store.removeDoctor('DR-A02', ADMIN), err => err.status === 409 && /assignment history/.test(err.message));
    assert.ok(await b.doctor('DR-A02'), 'the doctor with history is kept');
    assert.ok(await b.store.removeDoctor('DR-B01', ADMIN), 'a doctor without history can still be removed');
    assert.equal(await b.doctor('DR-B01'), null);
  });

  test(label('addDoctor returns the same shape on both stores, including hospital_name (S5)'), async () => {
    const added = await b.store.addDoctor({ hospital_id: 'H-B', full_name: 'Fictional New Doctor', specialization: 'neurologist', shift_start: '07:00', shift_end: '19:00' }, ADMIN);
    const { created_at: createdAt, doctor_id: doctorId, ...rest } = added;
    assert.ok(createdAt, 'created_at is present');
    // The id itself is not compared: the two stores derive the next number differently from the fixture's
    // non-numeric ids (DR-A01 ...); see the batch report. Its format is the same.
    assert.match(doctorId, /^DR-\d{3}$/);
    assert.deepEqual(rest, {
      hospital_id: 'H-B', full_name: 'Fictional New Doctor', specialization: 'NEUROLOGIST',
      availability_status: 'AVAILABLE', shift_start: '07:00', shift_end: '19:00', hospital_name: 'Contract Hospital B'
    });
    assert.deepEqual(Object.keys(added).sort(), Object.keys(await b.store.getDoctor(doctorId)).sort(), 'same keys as getDoctor');
  });
}
