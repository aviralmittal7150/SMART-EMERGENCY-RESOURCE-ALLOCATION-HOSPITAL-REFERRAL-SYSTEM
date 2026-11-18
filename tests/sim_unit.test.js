// Stress harness building blocks (no database): seeded randomness, deterministic plans (pinned workload
// fingerprints), statistics, refusal classification and the invariant checker (shown to catch each
// corruption it is meant to catch).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRng } from '../sim/lib/prng.js';
import { buildPlan, validateScenario } from '../sim/lib/plan.js';
import { percentile, summarize, spread } from '../sim/lib/stats.js';
import { checkInvariants } from '../sim/lib/invariants.js';
import { classifyRefusal } from '../sim/lib/runner.js';

const scenario = name => JSON.parse(fs.readFileSync(new URL(`../sim/scenarios/${name}.json`, import.meta.url), 'utf8'));

test('the seeded generator is deterministic, in range, and seed-sensitive', () => {
  const a = createRng(7);
  const b = createRng(7);
  const xs = Array.from({ length: 1000 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b.next()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 10), Array.from({ length: 10 }, createRng(8).next));
  const r = createRng(1);
  for (let i = 0; i < 200; i += 1) { const n = r.int(3, 5); assert.ok(n >= 3 && n <= 5 && Number.isInteger(n)); }
  assert.deepEqual([...createRng(3).shuffle([1, 2, 3, 4, 5])].sort(), [1, 2, 3, 4, 5]);
});

test('weighted choice follows the weights (10,000 draws within 2 percentage points)', () => {
  const rng = createRng(99);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 10000; i += 1) counts[rng.weighted({ a: 70, b: 20, c: 10 })] += 1;
  assert.ok(Math.abs(counts.a / 10000 - 0.7) < 0.02 && Math.abs(counts.b / 10000 - 0.2) < 0.02 && Math.abs(counts.c / 10000 - 0.1) < 0.02, JSON.stringify(counts));
  assert.throws(() => rng.weighted({ a: 0 }), /no positive weights/);
});

test('scenario workloads are pinned: changing plan generation must bump the scenario version', () => {
  // Baselines are only comparable if the workload is identical. These fingerprints are recorded in the
  // committed reports; if this test fails, create a new scenario version instead of editing this one.
  assert.equal(buildPlan(scenario('mass-casualty-v1')).fingerprint, '1d2074a8e526aa0d3e56666b59e91e8d47b008d4b3c2977fd8f6a8bc9fe22ce1');
  assert.equal(buildPlan(scenario('smoke')).fingerprint, '1764e56f5f131acc0468a05c407d432e14afd2eda98d4d16729013c8c13d91d4');
  const changed = { ...scenario('smoke'), seed: 1 };
  assert.notEqual(buildPlan(changed).fingerprint, buildPlan(scenario('smoke')).fingerprint);
});

test('plans carry the real emergency requirements and respect maxHospitalsTried', () => {
  const { plan } = buildPlan(scenario('mass-casualty-v1'));
  assert.equal(plan.cases.length, 120);
  const trauma = plan.cases.find(c => c.emergencyType === 'TRAUMA');
  assert.deepEqual([trauma.resourceTypes, trauma.specialist], [['ICU_BED', 'OT'], 'TRAUMA_SURGEON']);
  assert.ok(plan.cases.every(c => c.hospitalPreference.length === 4 && new Set(c.hospitalPreference).size === 4));
});

test('invalid scenarios are rejected with every problem named', () => {
  const problems = validateScenario({ name: '', version: 1.5, seed: 'x', cases: 0, concurrency: 0, fixture: { hospitals: [] }, caseMix: { ALIEN: 1 }, decisions: { maybe: 1 } });
  for (const expected of ['name', 'version', 'seed', 'cases', 'concurrency', 'fixture.hospitals', 'ALIEN', 'maybe']) {
    assert.ok(problems.some(p => p.includes(expected)), `expected a problem about ${expected}: ${problems.join('; ')}`);
  }
  assert.throws(() => buildPlan({}), /Invalid scenario/);
});

test('percentiles use the nearest-rank method; summaries and spreads handle empty input', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual([percentile(xs, 50), percentile(xs, 95), percentile(xs, 99), percentile(xs, 100)], [5, 10, 10, 10]);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(summarize([2, 4]), { count: 2, mean: 3, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.deepEqual(summarize([]).count, 0);
  assert.deepEqual(spread([3, 1, 2]), { min: 1, median: 2, max: 3 });
  assert.deepEqual(spread([null]), { min: null, median: null, max: null });
});

test('refusals are classified by reason; anything unrecognised is "unexpected"', () => {
  const cases = [
    [{ message: 'No available ICU_BED at H-1' }, 'no_capacity'],
    [{ message: 'Required specialist CARDIOLOGIST is not available at H-1.' }, 'specialist_unavailable'],
    [{ message: 'H-1: Refused as unsafe: after this allocation no completion order exists; REQ-1 would still need 1 ICU_BED' }, 'unsafe_state'],
    [{ message: 'H-1: Refused: the hospital is already unsafe. Unsafe: REQ-1 can never finish' }, 'unsafe_state'],
    [{ message: 'Hospital H-6 is CLOSED and cannot receive a referral.' }, 'hospital_closed'],
    [{ message: 'Request REQ-1 already has an active referral lock.' }, 'already_locked'],
    [{ message: 'The resource is busy. Please retry.' }, 'conflict_busy'],
    [{ errno: 1213, message: 'x' }, 'conflict_busy'],
    [{ message: 'No active lock found for acceptance ACC-1' }, 'stale_lock'],
    [{ message: 'Invalid lifecycle transition: WAITING -> COMPLETED.' }, 'invalid_transition'],
    [{ message: 'ER_PARSE_ERROR: You have an error in your SQL syntax' }, 'unexpected']
  ];
  for (const [err, reason] of cases) assert.equal(classifyRefusal(err), reason, err.message);
});

// ── invariant checker ────────────────────────────────────────────────────────────────────────────
function cleanSnapshot() {
  return {
    resources: [
      { resource_id: 'R-ICU', hospital_id: 'H1', resource_type: 'ICU_BED', total: 3, available: 2, locked: 1 },
      { resource_id: 'R-VNT', hospital_id: 'H1', resource_type: 'VENTILATOR', total: 2, available: 1, locked: 1 }
    ],
    softLocks: [{ resource_id: 'R-ICU', request_id: 'Q2' }, { resource_id: 'R-VNT', request_id: 'Q2' }],
    committed: [{ resource_id: 'R-ICU', request_id: 'Q1', hospital_id: 'H1' }, { resource_id: 'R-VNT', request_id: 'Q1', hospital_id: 'H1' }],
    pending: [{ acceptance_id: 'A2', request_id: 'Q2', hospital_id: 'H1' }],
    requests: [
      { request_id: 'Q1', status: 'ALLOCATED', resource_types: ['ICU_BED', 'VENTILATOR'] },
      { request_id: 'Q2', status: 'MATCHING', resource_types: ['ICU_BED', 'VENTILATOR'] },
      { request_id: 'Q3', status: 'COMPLETED', resource_types: ['ICU_BED'] },
      { request_id: 'Q4', status: 'ALLOCATED', resource_types: [] }
    ],
    ambulances: [{ ambulance_id: 'AMB-1', status: 'DISPATCHED', assigned_request_id: 'Q1' }, { ambulance_id: 'AMB-2', status: 'AVAILABLE', assigned_request_id: null }]
  };
}

// Adds exclusive-specialist state: Q1 (allocated) has its surgeon assigned, Q2 (pending) has one reserved.
function specialistSnapshot() {
  const s = cleanSnapshot();
  s.requests[0].specialist = 'TRAUMA_SURGEON';
  s.requests[1].specialist = 'TRAUMA_SURGEON';
  s.requests[2].specialist = 'CARDIOLOGIST';
  s.doctors = [{ doctor_id: 'D1', status: 'IN_PROCEDURE' }, { doctor_id: 'D2', status: 'RESERVED' }, { doctor_id: 'D3', status: 'AVAILABLE' }];
  s.assignments = [
    { doctor_id: 'D1', request_id: 'Q1', hospital_id: 'H1', acceptance_id: 'A1', status: 'COMMITTED' },
    { doctor_id: 'D2', request_id: 'Q2', hospital_id: 'H1', acceptance_id: 'A2', status: 'LOCKED' },
    { doctor_id: 'D3', request_id: 'Q3', hospital_id: 'H1', acceptance_id: 'A0', status: 'RELEASED' }
  ];
  return s;
}

test('a consistent snapshot has no violations', () => {
  assert.deepEqual(checkInvariants(cleanSnapshot()), []);
});

test('a consistent snapshot with specialist reservations and assignments has no violations', () => {
  assert.deepEqual(checkInvariants(specialistSnapshot()), []);
});

test('staged cases and Banker\'s safety: current-stage counts, an unsafe hospital and an over-claim are detected', () => {
  const s = cleanSnapshot();
  s.requests[0].stage_types = ['ICU_BED', 'VENTILATOR'];
  s.hospitalSafety = [{ hospital_id: 'H1', safe: true, explanation: 'Safe', anomalies: [] }];
  assert.deepEqual(checkInvariants(s), []);
  const stage1 = cleanSnapshot();
  stage1.requests[0].stage_types = ['OT']; // a staged case in stage 1 must hold exactly its OT, not ICU + ventilator
  assert.ok(checkInvariants(stage1).some(v => v.code === 'ALLOCATION_COUNT'));
  const unsafe = cleanSnapshot();
  unsafe.hospitalSafety = [{ hospital_id: 'H1', safe: false, explanation: 'Unsafe: REQ-X can never finish', anomalies: [] }];
  assert.ok(checkInvariants(unsafe).some(v => v.code === 'BANKER_UNSAFE'));
  const over = cleanSnapshot();
  over.hospitalSafety = [{ hospital_id: 'H1', safe: true, explanation: 'Safe', anomalies: [{ id: 'Q1', kind: 'HOLDS_ABOVE_CLAIM', types: ['OT'] }] }];
  assert.ok(checkInvariants(over).some(v => v.code === 'CLAIM_EXCEEDED'));
});

test('a staged case past its surgical stage holds no surgeon, and that is not a violation (but keeping one is)', () => {
  const s = specialistSnapshot();
  // Q1 is in stage 2 (ICU + ventilator): its surgeon was released when the stage advanced.
  s.requests[0].stage_types = ['ICU_BED', 'VENTILATOR'];
  s.requests[0].stage_specialist = null;
  s.assignments[0].status = 'RELEASED';
  s.doctors[0].status = 'AVAILABLE';
  assert.deepEqual(checkInvariants(s), []);
  const kept = specialistSnapshot();
  kept.requests[0].stage_types = ['ICU_BED', 'VENTILATOR'];
  kept.requests[0].stage_specialist = null; // stage 2 claims no surgeon, but the COMMITTED assignment remains
  assert.ok(checkInvariants(kept).some(v => v.code === 'SPECIALIST_ASSIGNMENT' && /does not claim/.test(v.message)));
});

test('each specialist corruption is detected', () => {
  const cases = [
    ['DOUBLE_BOOKED_SPECIALIST', s => { s.assignments[1].doctor_id = 'D1'; }],
    ['SPECIALIST_STATUS', s => { s.doctors[1].status = 'AVAILABLE'; }],
    ['SPECIALIST_STATUS', s => { s.doctors[2].status = 'ASSIGNED'; }],
    ['SPECIALIST_ASSIGNMENT', s => { s.assignments.splice(1, 1); s.doctors[1].status = 'AVAILABLE'; }], // pending, no reservation
    ['SPECIALIST_ASSIGNMENT', s => { s.assignments[0].status = 'RELEASED'; s.doctors[0].status = 'AVAILABLE'; }], // allocated, none
    ['SPECIALIST_ASSIGNMENT', s => { s.assignments[1].acceptance_id = 'A-OLD'; }], // reservation of a stale referral
    ['SPECIALIST_ASSIGNMENT', s => { s.assignments[0].hospital_id = 'H2'; }], // assigned at another hospital
    ['SPECIALIST_ASSIGNMENT', s => { s.assignments[2].status = 'COMMITTED'; s.doctors[2].status = 'ASSIGNED'; }] // closed case keeps one
  ];
  for (const [code, corrupt] of cases) {
    const s = specialistSnapshot();
    corrupt(s);
    const codes = checkInvariants(s).map(v => v.code);
    assert.ok(codes.includes(code), `${code} not detected; got ${JSON.stringify(codes)}`);
  }
});

test('each corruption is detected with its own code', () => {
  const cases = [
    ['CAPACITY_BOUNDS', s => { s.resources[0].available = 4; }],
    ['LOCKED_MISMATCH', s => { s.resources[0].locked = 2; s.resources[0].available = 2; }],
    ['DOUBLE_ALLOCATION', s => { s.committed.push(...Array.from({ length: 3 }, () => ({ resource_id: 'R-ICU', request_id: 'Q9', hospital_id: 'H1' }))); }],
    ['IN_USE_MISMATCH', s => { s.resources[0].available = 3; }],
    ['MULTIPLE_PENDING', s => { s.pending.push({ acceptance_id: 'A3', request_id: 'Q2', hospital_id: 'H2' }); }],
    ['MATCHING_STATE', s => { s.requests[1].status = 'WAITING'; }],
    ['ORPHAN_SOFT_LOCK', s => { s.pending = []; s.requests[1].status = 'WAITING'; }],
    ['ALLOCATION_HOSPITALS', s => { s.committed[1].hospital_id = 'H2'; }],
    ['ALLOCATION_COUNT', s => { s.requests[0].resource_types = ['ICU_BED']; }],
    ['UNEXPECTED_ALLOCATION', s => { s.requests[0].status = 'WAITING'; s.ambulances[0].assigned_request_id = null; }],
    ['TERMINAL_HOLDS', s => { s.requests[1].status = 'CANCELLED'; }],
    ['MULTIPLE_AMBULANCES', s => { s.ambulances[1] = { ambulance_id: 'AMB-2', status: 'IN_TRANSIT', assigned_request_id: 'Q1' }; }],
    ['AMBULANCE_STATE', s => { s.ambulances[0].assigned_request_id = 'Q2'; }],
    ['AMBULANCE_STALE_ASSIGNMENT', s => { s.ambulances[1].assigned_request_id = 'Q3'; }],
    ['UNKNOWN_STATUS', s => { s.requests[2].status = 'LOST'; }]
  ];
  for (const [code, corrupt] of cases) {
    const s = cleanSnapshot();
    corrupt(s);
    const codes = checkInvariants(s).map(v => v.code);
    assert.ok(codes.includes(code), `${code} not detected; got ${JSON.stringify(codes)}`);
  }
});

// ── report comparison ────────────────────────────────────────────────────────────────────────────
test('the comparison refuses different workloads, and reports a report against itself as zero change', async () => {
  const { compareReports, comparisonMarkdown } = await import('../sim/compare.js');
  const fsMod = await import('node:fs');
  const baseline = JSON.parse(fsMod.readFileSync(new URL('../sim/reports/step2-baseline-mysql/report.json', import.meta.url), 'utf8'));
  const same = compareReports(baseline, baseline);
  assert.equal(same.environmentIdentical, true);
  assert.deepEqual(same.headline.throughputOpsPerSec.medianDelta, { absolute: 0, percent: 0 });
  assert.equal(same.workloadFingerprint, '1d2074a8e526aa0d3e56666b59e91e8d47b008d4b3c2977fd8f6a8bc9fe22ce1');
  assert.match(comparisonMarkdown(same), /Identical in every recorded field/);

  const other = structuredClone(baseline);
  other.workload.fingerprint = 'f'.repeat(64);
  assert.throws(() => compareReports(baseline, other), /not comparable: workload fingerprint/);
  const memory = structuredClone(baseline);
  memory.backend.backend = 'memory';
  assert.throws(() => compareReports(baseline, memory), /not comparable: backend mysql vs memory/);

  const moved = structuredClone(baseline);
  moved.environment.powerSource = 'Battery Power';
  const diff = compareReports(baseline, moved);
  assert.equal(diff.environmentIdentical, false);
  assert.deepEqual(diff.environment.find(e => e.key === 'powerSource'), { key: 'powerSource', baseline: null, candidate: 'Battery Power', same: false });
});

test('a broken audit chain in a snapshot is an invariant violation (Step 5)', () => {
  const s = cleanSnapshot();
  s.auditChain = { valid: true, checked: 3, head: { chain_seq: 3, hash: 'x' }, first_break: null };
  assert.deepEqual(checkInvariants(s), []);
  s.auditChain = { valid: false, checked: 3, head: null, first_break: { reason: 'ROW_HASH_MISMATCH', chain_seq: 2 } };
  assert.ok(checkInvariants(s).some(v => v.code === 'AUDIT_CHAIN' && /ROW_HASH_MISMATCH/.test(v.message)));
});
