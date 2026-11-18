// In-memory engine: every release path re-evaluates the hospital's safety only AFTER the released lock has left
// the engine's state. The hospital's Banker's state is built from the live locks, so evaluating earlier counts the
// released units twice (still held by the lock AND already back in Available). Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from './contract/backends.js';
import { resolveEmergencyRequirements } from '../server/services/emergencyRequirements.js';
import { db } from '../server/db/seed.js';

const b = await createMemoryBackend();
test.after(() => b.close());
test.beforeEach(() => b.reset());

async function pendingTraumaLock() {
  await b.setCapacity('H-A', 'ICU_BED', { total: 1 });
  await b.setCapacity('H-A', 'OT', { total: 1 });
  const req = resolveEmergencyRequirements('TRAUMA');
  const { request_id } = await b.store.createRequest({
    patient: { full_name: 'Fictional Release-Order Patient', age: 40, gender: 'UNKNOWN', emergency_type: 'TRAUMA', triage_priority: 1, contact_phone: null },
    request: { emergency_type: 'TRAUMA', required_resource_types: req.resourceTypes, required_specialist: req.specialist, priority: 1, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
  }, { role: 'PARAMEDIC', id: 'U-TEST' });
  const lock = await b.store.acquireReferralLock('H-A', request_id, req.resourceTypes);
  // Flag the hospital UNSAFE so release paths actually re-evaluate it (they skip hospitals flagged SAFE).
  db.hospitals.find(h => h.hospital_id === 'H-A').safety_state = 'UNSAFE';
  return { requestId: request_id, acceptanceId: lock.acceptanceId };
}

function spyOnRefresh(acceptanceId, requestId) {
  const seen = [];
  const original = b.engine.refreshSafety.bind(b.engine);
  b.engine.refreshSafety = (hospitalId, options) => {
    seen.push({
      lockStillLive: b.engine._activeLocks.has(acceptanceId),
      caseInState: b.engine._hospitalState(hospitalId).processes.some(p => p.id === requestId)
    });
    return original(hospitalId, options);
  };
  return { seen, restore: () => { b.engine.refreshSafety = original; } };
}

const paths = {
  reject: ({ acceptanceId }) => b.store.rejectReferral(acceptanceId, 'Fictional rejection', 'U-DESK'),
  expiry: ({ acceptanceId }) => b.engine.expireLock(acceptanceId),
  cancel: ({ requestId }) => b.store.transitionRequestStatus(requestId, 'CANCELLED', { role: 'ADMIN', id: 'U-ADMIN' })
};

for (const [name, release] of Object.entries(paths)) {
  test(`${name}: the hospital is re-evaluated only after the released lock left the state`, async () => {
    const ctx = await pendingTraumaLock();
    const spy = spyOnRefresh(ctx.acceptanceId, ctx.requestId);
    try {
      await release(ctx);
    } finally {
      spy.restore();
    }
    assert.ok(spy.seen.length >= 1, 'the release re-evaluated the UNSAFE-flagged hospital');
    assert.deepEqual(spy.seen[0], { lockStillLive: false, caseInState: false },
      'the released case must not still count as holding the units it just gave back');
  });
}
