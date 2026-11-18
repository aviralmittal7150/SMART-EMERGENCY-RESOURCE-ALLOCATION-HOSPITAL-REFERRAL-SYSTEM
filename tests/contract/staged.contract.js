// Staged claims and the Banker's safety check (Phase 3 Step 4: Banker's option A, D2-B, D4-A, D5-A), run
// unchanged against the in-memory store (tests/contract_memory.test.js) and the MySQL store
// (tests/contract_mysql.test.js).
//
// Covers: claims recorded at intake; TRAUMA / POLYTRAUMA stage flows with stage_no and the surgeon's release;
// single-stage types unchanged; safe vs unsafe admission with no partial reservation; an admission that is safe
// only because another case will release; simultaneous staged claims and contended stage advances with retry;
// capacity exhaustion; D5 capacity edits (UNSAFE_STATE, alert, refusals, SAFE_STATE_RESTORED); a capacity edit
// racing an admission (validated under the locks); failover that escalates when no hospital is safe; expiry;
// a failure inside a stage advance (rollback + retry); the per-hospital safety report. Interleavings are forced
// with hooks and observed through events or lock probes, never sleeps. Lock order is checked after every
// scenario. All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';
import { gate } from '../helpers/gate.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-CONTRACT-EMS' };
const ADMIN = { role: 'ADMIN', id: 'U-CONTRACT-ADMIN' };
const DESK = 'U-CONTRACT-DESK-A';

async function until(condition, what, limit = 20000) {
  for (let i = 0; i < limit; i += 1) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for: ${what}`);
}

export function registerStagedContract(b) {
  const label = name => `[${b.name}] staged: ${name}`;
  const openGates = [];
  const pausedOps = [];
  const hold = () => { const g = gate(); openGates.push(g); return g; };
  const track = p => { pausedOps.push(p); return p; };

  test.beforeEach(() => b.reset());
  test.afterEach(async () => {
    openGates.splice(0).forEach(g => g.release());
    await Promise.allSettled(pausedOps.splice(0));
    b.hooks.clear();
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });

  async function newCase(type = 'TRAUMA', extras = []) {
    const req = resolveEmergencyRequirements(type, extras);
    const created = await b.store.createRequest({
      patient: { full_name: 'Fictional Staged Patient', age: 50, gender: 'UNKNOWN', emergency_type: type, triage_priority: 1, contact_phone: null },
      request: { emergency_type: type, required_resource_types: req.resourceTypes, required_specialist: req.specialist, priority: 1, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
    }, PARAMEDIC);
    return created;
  }
  const id = async (type, extras) => (await newCase(type, extras)).request_id;
  const capacity = async (hospitalId, { ICU_BED, OT, VENTILATOR }) => {
    for (const [type, c] of Object.entries({ ICU_BED, OT, VENTILATOR })) {
      if (c !== undefined) await b.setCapacity(hospitalId, type, typeof c === 'number' ? { total: c } : c);
    }
  };
  // The route passes the case's full requirement; for a case with a recorded claim the engine uses its stage.
  const lockAt = (hospitalId, requestId, type = 'TRAUMA') => b.store.acquireReferralLock(hospitalId, requestId, resolveEmergencyRequirements(type).resourceTypes);
  const admit = async (hospitalId, requestId, type) => b.store.commitReferral((await lockAt(hospitalId, requestId, type)).acceptanceId, DESK);
  const typeOf = resourceId => resourceId.split('-').slice(3).join('-');
  const allocs = async requestId => (await b.allocations(requestId)).map(a => `${typeOf(a.resource_id)}:stage${Number(a.stage_no)}:${a.status}`).sort();
  const doctorStatus = async d => (await b.doctor(d)).status;
  const events = async requestId => (await b.audit(requestId)).map(e => e.event_type);

  // ── Claims at intake ───────────────────────────────────────────────────────────────────────────
  test(label('intake records the maximum claim per stage: TRAUMA / POLYTRAUMA staged, others single-stage'), async () => {
    const claimOf = async (type, extras) => {
      const created = await newCase(type, extras);
      const stored = await b.store.getClaim(created.request_id);
      assert.deepEqual(created.claim, stored.stages, 'the intake response returns the recorded claim');
      assert.equal(stored.current_stage, 1);
      assert.equal(stored.recorded, true);
      return stored.stages;
    };
    assert.deepEqual(await claimOf('TRAUMA'), [{ stage_no: 1, resources: ['OT', 'TRAUMA_SURGEON'] }, { stage_no: 2, resources: ['ICU_BED'] }]);
    assert.deepEqual(await claimOf('POLYTRAUMA'), [{ stage_no: 1, resources: ['OT', 'TRAUMA_SURGEON'] }, { stage_no: 2, resources: ['ICU_BED', 'VENTILATOR'] }]);
    assert.deepEqual(await claimOf('TRAUMA', ['VENTILATOR']), [{ stage_no: 1, resources: ['OT', 'TRAUMA_SURGEON', 'VENTILATOR'] }, { stage_no: 2, resources: ['ICU_BED'] }],
      'operator extras join stage 1 (D2-a5)');
    assert.deepEqual(await claimOf('RESPIRATORY'), [{ stage_no: 1, resources: ['ICU_BED', 'VENTILATOR'] }]);
    assert.deepEqual(await claimOf('CARDIAC'), [{ stage_no: 1, resources: ['ICU_BED', 'VENTILATOR'] }], 'a consultant is checked, not claimed');
  });

  // ── Stage flows ────────────────────────────────────────────────────────────────────────────────
  test(label('TRAUMA: stage 1 holds OT + surgeon; advancing releases both and allocates the ICU bed (stage_no 2); completion frees it'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    const lock = await lockAt('H-A', t);
    assert.deepEqual(lock.resourceTypes, ['OT'], 'only the stage-1 resources are soft-locked');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    const accepted = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(accepted.specialist_id, 'DR-A02');
    assert.deepEqual(await allocs(t), ['OT:stage1:COMMITTED']);

    const advanced = await b.store.advanceStage(t, ADMIN);
    assert.deepEqual([advanced.previous_stage, advanced.current_stage], [1, 2]);
    assert.deepEqual([advanced.released, advanced.allocated, advanced.released_specialists], [['OT'], ['ICU_BED'], ['DR-A02']]);
    assert.equal(await b.currentStage(t), 2);
    assert.deepEqual(await allocs(t), ['ICU_BED:stage2:COMMITTED', 'OT:stage1:RELEASED']);
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 1, available: 1, locked: 0 }, 'the theatre is free for the next case');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 0, locked: 0 });
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE', 'the surgeon\'s stage is over');
    assert.ok((await events(t)).includes('STAGE_ADVANCED'));
    await assert.rejects(b.store.advanceStage(t, ADMIN), err => err.status === 409 && /no stage 3/.test(err.message));

    await b.store.transitionRequestStatus(t, 'COMPLETED', ADMIN);
    assert.deepEqual(await allocs(t), ['ICU_BED:stage2:RELEASED', 'OT:stage1:RELEASED']);
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
  });

  test(label('POLYTRAUMA: stage 2 adds the ICU bed AND the ventilator, in one step, while IN_TREATMENT'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1, VENTILATOR: 1 });
    const p = await id('POLYTRAUMA');
    await admit('H-A', p, 'POLYTRAUMA');
    await b.store.transitionRequestStatus(p, 'IN_TREATMENT', ADMIN);
    assert.equal(await doctorStatus('DR-A02'), 'IN_PROCEDURE');
    const advanced = await b.store.advanceStage(p, ADMIN);
    assert.deepEqual(advanced.allocated, ['ICU_BED', 'VENTILATOR']);
    assert.deepEqual(await allocs(p), ['ICU_BED:stage2:COMMITTED', 'OT:stage1:RELEASED', 'VENTILATOR:stage2:COMMITTED']);
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
  });

  test(label('single-stage types are unchanged: everything at admission, and there is no stage to advance to'), async () => {
    await capacity('H-A', { ICU_BED: 1, VENTILATOR: 1 });
    const r = await id('RESPIRATORY');
    await admit('H-A', r, 'RESPIRATORY');
    assert.deepEqual(await allocs(r), ['ICU_BED:stage1:COMMITTED', 'VENTILATOR:stage1:COMMITTED']);
    await assert.rejects(b.store.advanceStage(r, ADMIN), err => err.status === 409 && /no stage 2/.test(err.message));
    const waiting = await id('TRAUMA');
    await assert.rejects(b.store.advanceStage(waiting, ADMIN), err => err.status === 409 && /only an allocated case/.test(err.message));
  });

  // ── Safe and unsafe admission ──────────────────────────────────────────────────────────────────
  test(label('unsafe admission is refused with its explanation and leaves nothing behind (G9, D4-a5)'), async () => {
    // The only ICU bed is occupied by nobody's allocation (G4: permanently held), so a surgical case could
    // never get its post-op bed, although the theatre and the surgeon are free right now.
    await capacity('H-A', { ICU_BED: { total: 1, available: 0 }, OT: 1 });
    const t = await id('TRAUMA');
    let refusal;
    await assert.rejects(lockAt('H-A', t), err => { refusal = err; return err.status === 409; });
    assert.equal(refusal.code, 'UNSAFE');
    assert.equal(refusal.safety.reason, 'UNSAFE');
    assert.equal(refusal.safety.hospital_id, 'H-A');
    assert.equal(refusal.safety.blocking.type, 'ICU_BED');
    assert.match(refusal.message, /unsafe/);
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 1, available: 1, locked: 0 }, 'no theatre held');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE', 'no surgeon reserved');
    assert.deepEqual(await b.acceptances(t), []);
    assert.deepEqual(await b.allocations(t), []);
    assert.equal((await b.request(t)).status, 'WAITING');
    const audit = (await b.audit(t)).find(e => e.event_type === 'ADMISSION_REFUSED_UNSAFE');
    assert.ok(audit, 'the refusal is on the case trail');
    assert.equal(audit.metadata.safety.blocking.type, 'ICU_BED');
  });

  test(label('an admission is safe when another case will release what it needs (not only what is free now)'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1, VENTILATOR: 1 });
    const holder = await id('RESPIRATORY');
    await admit('H-A', holder, 'RESPIRATORY'); // holds the only ICU bed; single-stage, so it can always finish
    const t = await id('TRAUMA');
    await lockAt('H-A', t);
    const acquired = (await b.audit(t)).find(e => e.event_type === 'LOCK_ACQUIRED');
    assert.deepEqual(acquired.metadata.safetySequence, [holder, t], 'the trauma case finishes after the holder frees its bed');
  });

  test(label('simultaneous staged claims: both admitted safely; their stage advances contend, the loser is refused intact and succeeds on retry'), async () => {
    const extra = await b.store.addDoctor({ hospital_id: 'H-A', full_name: 'Fictional Second Surgeon', specialization: 'TRAUMA_SURGEON' }, ADMIN);
    await capacity('H-A', { ICU_BED: 1, OT: 2, VENTILATOR: 1 });
    const [p1, p2] = [await id('POLYTRAUMA'), await id('POLYTRAUMA')];
    const locks = await Promise.all([lockAt('H-A', p1, 'POLYTRAUMA'), lockAt('H-A', p2, 'POLYTRAUMA')]);
    assert.deepEqual(locks.map(l => l.specialistId).sort(), [extra.doctor_id, 'DR-A02'].sort(), 'each holds its own surgeon');
    for (const l of locks) await b.store.commitReferral(l.acceptanceId, DESK);

    const [a, c] = await Promise.allSettled([b.store.advanceStage(p1, ADMIN), b.store.advanceStage(p2, ADMIN)]);
    const outcomes = [a, c];
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1, outcomes.map(o => o.reason?.message).join('; '));
    const loserIndex = outcomes.findIndex(o => o.status === 'rejected');
    const loser = [p1, p2][loserIndex];
    const winner = [p1, p2][1 - loserIndex];
    const refusal = outcomes[loserIndex].reason;
    assert.equal(refusal.status, 409);
    assert.equal(refusal.safety.reason, 'INSUFFICIENT', 'a capacity shortfall, not an unsafe state: the winner can finish and free both units');
    assert.equal(await b.currentStage(loser), 1, 'the loser stays in stage 1 ...');
    assert.deepEqual(await allocs(loser), ['OT:stage1:COMMITTED'], '... holding exactly what it had (D2-a9)');
    assert.ok((await events(loser)).includes('STAGE_ADVANCE_REFUSED'));

    await b.store.transitionRequestStatus(winner, 'COMPLETED', ADMIN);
    const retried = await b.store.advanceStage(loser, ADMIN);
    assert.equal(retried.current_stage, 2);
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 1, available: 0, locked: 0 });
  });

  test(label('resource exhaustion: 5 simultaneous single-stage claims for 2 bed+ventilator pairs yield exactly 2, no partial holds'), async () => {
    await capacity('H-A', { ICU_BED: 2, VENTILATOR: 2 });
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await id('RESPIRATORY'));
    const results = await Promise.allSettled(ids.map(x => lockAt('H-A', x, 'RESPIRATORY')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409 && /No available/.test(r.reason.message)));
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 2 });
  });

  // ── D5: capacity edits ─────────────────────────────────────────────────────────────────────────
  test(label('D5: an edit that makes the hospital unsafe succeeds, is flagged, alerted and reported; admissions and advances stop until releases restore safety'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 2, VENTILATOR: 1 });
    const t = await id('TRAUMA');
    await admit('H-A', t);
    const edited = await b.store.updateResourceCapacity('H-A', 'ICU_BED', { total: 0, available: 0 }, ADMIN);
    assert.equal(edited.safety.safe, false, 'the edit itself is allowed (D5-a2)');
    assert.equal(await b.hospitalFlag('H-A'), 'UNSAFE');
    const flagged = (await b.hospitalAudit('H-A')).filter(e => e.event_type === 'UNSAFE_STATE');
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].metadata.explanation, /can never finish/);
    assert.ok((await b.alerts()).some(a => a.hospital_id === 'H-A' && a.alert_type === 'RESOURCE_CRITICAL' && /UNSAFE_STATE/.test(a.message)));
    const report = await b.store.getHospitalSafety('H-A');
    assert.equal(report.safe, false);
    assert.equal(report.safety_state, 'UNSAFE');
    assert.deepEqual(report.unfinished.map(u => u.id), [t]);

    // A GENERAL case claims nothing, so only the hospital's state can refuse it: D5-a3, no admissions while unsafe.
    const other = await id('GENERAL');
    await assert.rejects(lockAt('H-A', other, 'GENERAL'), err => err.status === 409 && err.safety?.reason === 'HOSPITAL_UNSAFE');
    await assert.rejects(b.store.advanceStage(t, ADMIN), err => err.status === 409 && err.safety?.reason === 'HOSPITAL_UNSAFE');

    await b.store.transitionRequestStatus(t, 'CANCELLED', ADMIN); // the release restores a safe state (D5-a4)
    assert.equal(await b.hospitalFlag('H-A'), 'SAFE');
    assert.deepEqual((await b.hospitalAudit('H-A')).map(e => e.event_type).filter(e => /STATE/.test(e)), ['UNSAFE_STATE', 'SAFE_STATE_RESTORED']);
    assert.equal((await b.store.getHospitalSafety('H-A')).safe, true);
  });

  test(label('D5 race: a capacity edit waiting behind an admission is validated against the state after it (no locked > available)'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    const held = hold();
    b.hooks.once('acquire:hospitalLocked', held.hold, ctx => ctx.requestId === t);
    const admitting = track(lockAt('H-A', t));
    await held.reached; // the admission holds H-A and has not locked the OT yet
    const editing = track(b.store.updateResourceCapacity('H-A', 'OT', { available: 0 }, ADMIN)); // valid NOW (locked 0)
    await until(async () => (await b.hospitalLockWaiters('H-A')) === 1, 'the capacity edit to wait for H-A');
    held.release();
    await admitting;
    await assert.rejects(editing, err => err.status === 400, 'validated after the admission soft-locked the theatre');
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 1, available: 1, locked: 1 });
  });

  // ── Failover, escalation, expiry ───────────────────────────────────────────────────────────────
  test(label('rejection: failover skips an unsafe hospital; with none safe the case is escalated (alert + audit, D4-a3)'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    await capacity('H-B', { ICU_BED: { total: 1, available: 0 }, OT: 1 }); // H-B could never give a post-op bed
    const t = await id('TRAUMA');
    const lock = await lockAt('H-A', t);
    const rejected = await b.store.rejectReferral(lock.acceptanceId, 'Fictional rejection', DESK);
    assert.equal(rejected.next_hospital_id, null);
    assert.equal((await b.request(t)).status, 'WAITING');
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 1, available: 1, locked: 0 });
    assert.deepEqual(await b.resource('H-B', 'OT'), { total: 1, available: 1, locked: 0 }, 'nothing left at the unsafe candidate');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
    assert.equal(await doctorStatus('DR-B01'), 'AVAILABLE');
    const trail = await b.audit(t);
    assert.ok(trail.some(e => e.event_type === 'ADMISSION_REFUSED_UNSAFE' && e.metadata.safety.hospital_id === 'H-B'));
    const escalation = trail.find(e => e.event_type === 'ADMISSION_ESCALATED');
    assert.ok(escalation, 'the case trail records the escalation');
    assert.equal(escalation.metadata.safety.hospital_id, 'H-B');
    assert.ok((await b.alerts()).some(a => a.request_id === t && a.alert_type === 'SYSTEM' && /ESCALATION/.test(a.message)));
  });

  test(label('expiry of a staged referral releases the OT and surgeon; no ICU bed was ever held'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    const lock = await lockAt('H-A', t);
    await b.forceExpire(lock.acceptanceId);
    assert.equal(await b.engine.expireLock(lock.acceptanceId), true);
    assert.deepEqual(await b.resource('H-A', 'OT'), { total: 1, available: 1, locked: 0 });
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
  });

  // ── Rollback and retry ─────────────────────────────────────────────────────────────────────────
  test(label('a failure inside a stage advance changes nothing, and the advance can be retried'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    await admit('H-A', t);
    b.hooks.once('advance:hospitalLocked', () => { throw new Error('injected failure'); });
    await assert.rejects(b.store.advanceStage(t, ADMIN), /injected failure/);
    assert.equal(await b.currentStage(t), 1);
    assert.deepEqual(await allocs(t), ['OT:stage1:COMMITTED']);
    assert.equal(await doctorStatus('DR-A02'), 'ASSIGNED');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 1, available: 1, locked: 0 });
    assert.equal((await b.store.advanceStage(t, ADMIN)).current_stage, 2);
  });

  // ── Backend equivalence ───────────────────────────────────────────────────────────────────────
  test(label('a legacy claim that does not reserve the surgeon still requires one on duty (same on both backends)'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    // A single-stage claim backfilled from holdings (migration 005, D2-a10) may lack the surgeon row.
    await b.setClaim(t, [{ stage_no: 1, resource_type: 'ICU_BED' }, { stage_no: 1, resource_type: 'OT' }]);
    await b.store.updateDoctorStatus('DR-A02', 'OFF_DUTY', ADMIN);
    await assert.rejects(lockAt('H-A', t), err => err.status === 409 && /TRAUMA_SURGEON is not available/.test(err.message));
    for (const type of ['ICU_BED', 'OT']) assert.deepEqual(await b.resource('H-A', type), { total: 1, available: 1, locked: 0 });
    await b.store.updateDoctorStatus('DR-A02', 'AVAILABLE', ADMIN);
    const lock = await lockAt('H-A', t);
    assert.deepEqual(lock.resourceTypes, ['ICU_BED', 'OT']);
    assert.equal(lock.specialistId, null, 'the claim reserves no surgeon, so none is reserved (only checked)');
    assert.equal(await doctorStatus('DR-A02'), 'AVAILABLE');
  });

  // ── The safety report ──────────────────────────────────────────────────────────────────────────
  test(label('the per-hospital safety report shows each case\'s allocation, max and remaining need'), async () => {
    await capacity('H-A', { ICU_BED: 1, OT: 1 });
    const t = await id('TRAUMA');
    await admit('H-A', t);
    const report = await b.store.getHospitalSafety('H-A');
    assert.equal(report.safe, true);
    assert.equal(report.safety_state, 'SAFE');
    assert.deepEqual(report.sequence, [t]);
    const mine = report.cases.find(c => c.request_id === t);
    assert.equal(mine.stage, 1);
    assert.equal(mine.legacy_claim, false);
    assert.deepEqual(mine.allocation, { ICU_BED: 0, OT: 1, TRAUMA_SURGEON: 1, VENTILATOR: 0 });
    assert.deepEqual(mine.need, { ICU_BED: 1, OT: 0, TRAUMA_SURGEON: 0, VENTILATOR: 0 });
    assert.equal(await b.store.getHospitalSafety('H-NOPE'), null);
  });
}
