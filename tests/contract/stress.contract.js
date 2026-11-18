// Concurrency stress scenario (round-1 review L-T1), shared by both backends: many cases compete for scarce capacity
// through the store API the routes use (acquireReferralLock / commitReferral / rejectReferral with failover /
// transitionRequestStatus). Nothing here simulates a lock: every grant, refusal and release is the engine's own.
// Memory: tests/concurrency_stress.test.js (npm run test:concurrency). MySQL: tests/contract_mysql.test.js
// (npm run test:mysql; a MySQL-backed file must be listed there, see tests/test_scripts.test.js).
//
// Invariants checked after every phase: exactly-capacity reservations, at most one live referral per case,
// 0 <= locked <= available <= total for every resource, locked units == live locks, used units == committed
// allocations, no leaked locks at the end, a valid audit hash chain, and zero lock-order violations.
// All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-STRESS-EMS' };
const ADMIN = { role: 'ADMIN', id: 'U-STRESS-ADMIN' };
const DESK = 'U-STRESS-DESK';
const CAPACITY = { 'H-A': 4, 'H-B': 3, 'H-D': 2 }; // H-C is CLOSED in the fixture
const HOSPITALS = Object.keys(CAPACITY);
const TOTAL = Object.values(CAPACITY).reduce((a, b) => a + b, 0);
const CASES = 30;
const TYPES = ['ICU_BED', 'VENTILATOR']; // the RESPIRATORY claim
const REQ = resolveEmergencyRequirements('RESPIRATORY');

async function createCase(b, i) {
  const { request_id } = await b.store.createRequest({
    patient: { full_name: `Fictional Stress Patient ${i}`, age: 40, gender: 'UNKNOWN', emergency_type: 'RESPIRATORY', triage_priority: 2, contact_phone: null },
    request: { emergency_type: 'RESPIRATORY', required_resource_types: REQ.resourceTypes, required_specialist: REQ.specialist, priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
  }, PARAMEDIC);
  return request_id;
}

const lockAt = (b, hospitalId, requestId) => b.store.acquireReferralLock(hospitalId, requestId, TYPES);
const placeOf = resourceId => resourceId.replace(/^RES-/, '').replace(/-(ICU_BED|VENTILATOR|OT)$/, m => `/${m.slice(1)}`);

/** Every case of `ids` tries every open hospital at once (one concurrent referral per case and hospital). */
async function stampede(b, ids) {
  const results = await Promise.allSettled(ids.flatMap(id => HOSPITALS.map(h => lockAt(b, h, id))));
  for (const r of results) {
    if (r.status === 'rejected') assert.equal(r.reason.status, 409, `a refusal is a business 409, not a crash: ${r.reason.message}`);
  }
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

/** Cross-check capacity, live locks, acceptances and allocations, read straight from the backend. */
async function assertInvariants(b, ids, phase) {
  const live = (await b.engine.getActiveLocks()).filter(l => ids.includes(l.requestId));
  const perCase = new Map();
  for (const l of live) perCase.set(l.requestId, (perCase.get(l.requestId) ?? 0) + 1);
  for (const [id, n] of perCase) assert.equal(n, 1, `${phase}: ${id} holds ${n} live referrals`);

  const committed = {}; // 'hospital/type' -> committed allocations
  const statuses = new Map();
  for (const id of ids) {
    const status = (await b.request(id)).status;
    statuses.set(id, status);
    const pending = (await b.acceptances(id)).filter(a => a.status === 'PENDING');
    assert.ok(pending.length <= 1, `${phase}: ${id} has ${pending.length} PENDING acceptances`);
    assert.equal(pending.length, perCase.get(id) ?? 0, `${phase}: ${id} PENDING acceptances match its live locks`);
    if (pending.length) assert.equal(status, 'MATCHING', `${phase}: ${id} holds a referral, so it is MATCHING`);
    const mine = (await b.allocations(id)).filter(a => a.status === 'COMMITTED');
    if (status === 'ALLOCATED') {
      assert.equal(mine.length, TYPES.length, `${phase}: ${id} is ALLOCATED with one unit of each type`);
      assert.equal(new Set(mine.map(a => placeOf(a.resource_id).split('/')[0])).size, 1, `${phase}: ${id} is allocated at one hospital`);
      assert.equal(pending.length, 0, `${phase}: an ALLOCATED case holds no pending referral`);
    } else {
      assert.equal(mine.length, 0, `${phase}: ${id} is ${status} but holds committed units`);
    }
    for (const a of mine) committed[placeOf(a.resource_id)] = (committed[placeOf(a.resource_id)] ?? 0) + 1;
  }

  for (const r of await b.allResources()) {
    assert.ok(r.locked >= 0 && r.locked <= r.available && r.available <= r.total,
      `${phase}: capacity invariant broken for ${r.hospital_id}/${r.resource_type}: ${JSON.stringify(r)}`);
    if (!TYPES.includes(r.resource_type)) continue;
    assert.equal(r.locked, live.filter(l => l.hospitalId === r.hospital_id).length,
      `${phase}: ${r.hospital_id}/${r.resource_type} locked units == live locks there`);
    assert.equal(r.total - r.available, committed[`${r.hospital_id}/${r.resource_type}`] ?? 0,
      `${phase}: ${r.hospital_id}/${r.resource_type} used units == committed allocations`);
  }
  return { live, statuses };
}

export function registerStressContract(b) {
  test(`[${b.name}] ${CASES} cases stampede ${HOSPITALS.length} hospitals (${TOTAL} slots): exactly-capacity reservations; accept / reject-with-failover / retry; cancelling everything leaks nothing`, async () => {
    await b.reset();
    for (const [h, n] of Object.entries(CAPACITY)) for (const type of TYPES) await b.setCapacity(h, type, { total: n });
    const ids = [];
    for (let i = 0; i < CASES; i += 1) ids.push(await createCase(b, i));

    // Phase 1: every case refers to every hospital at once.
    const granted = await stampede(b, ids);
    assert.equal(new Set(granted.map(l => l.requestId)).size, granted.length, 'no case was granted two referrals');
    assert.equal(granted.length, TOTAL, `exactly ${TOTAL} referrals granted (one per slot), got ${granted.length}`);
    for (const h of HOSPITALS) assert.equal(granted.filter(l => l.hospitalId === h).length, CAPACITY[h], `${h} filled exactly to capacity`);
    await assertInvariants(b, ids, 'after the stampede');

    // Phase 2, all at once: accept half the grants, reject the other half (each rejection fails over), while every
    // case that got nothing tries every hospital again, competing with the failovers for the units being freed.
    const winners = new Set(granted.map(l => l.requestId));
    const settled = await Promise.allSettled([
      ...granted.map((lock, i) => (i % 2
        ? b.store.rejectReferral(lock.acceptanceId, 'Fictional stress rejection', DESK)
        : b.store.commitReferral(lock.acceptanceId, DESK))),
      stampede(b, ids.filter(id => !winners.has(id)))
    ]);
    for (const s of settled) assert.equal(s.status, 'fulfilled', s.reason?.message);
    const { live, statuses } = await assertInvariants(b, ids, 'after accept / reject / failover / retry');
    const allocated = ids.filter(id => statuses.get(id) === 'ALLOCATED').length;
    assert.equal(allocated, Math.ceil(TOTAL / 2), 'every accepted referral, and only those, allocated');
    assert.ok(allocated + live.length <= TOTAL, `never more cases holding units than slots: ${allocated} allocated + ${live.length} pending`);

    // Phase 3: cancel every case at once: every unit and every lock comes back.
    const cancels = await Promise.allSettled(ids.map(id => b.store.transitionRequestStatus(id, 'CANCELLED', ADMIN)));
    for (const s of cancels) assert.equal(s.status, 'fulfilled', s.reason?.message);
    await assertInvariants(b, ids, 'after cancelling everything');
    assert.equal((await b.engine.getActiveLocks()).length, 0, 'no leaked locks');
    for (const h of HOSPITALS) for (const type of TYPES) assert.deepEqual(await b.resource(h, type), { total: CAPACITY[h], available: CAPACITY[h], locked: 0 }, `${h}/${type}`);
    for (const amb of ['AMB-A1', 'AMB-B1']) assert.deepEqual(await b.ambulance(amb), { status: 'AVAILABLE', assigned_request_id: null });

    const chain = await b.store.verifyAuditChain();
    assert.equal(chain.valid, true, JSON.stringify(chain.first_break));
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });
}
