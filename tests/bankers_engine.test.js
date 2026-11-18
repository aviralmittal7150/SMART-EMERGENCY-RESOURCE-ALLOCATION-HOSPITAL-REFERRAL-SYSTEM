// Server-side Banker's Algorithm (server/services/bankers.js), clinical pathways (clinicalPathways.js) and the
// per-hospital state builder (hospitalSafety.js). Pure functions: no database, no clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSafety, requestResources, explain, validateState, BankersInputError
} from '../server/services/bankers.js';
import {
  validatePathways, PathwayConfigError, buildClaim, singleStageClaim, claimFromRows, claimRows,
  maxClaim, physicalTypes, exclusiveSpecialistOf, stageOf, CLAIM_RESOURCE_TYPES
} from '../server/services/clinicalPathways.js';
import { buildHospitalState, admissionDecision, advanceDecision, evaluateHospital } from '../server/services/hospitalSafety.js';
import { resolveEmergencyRequirements } from '../server/services/emergencyRequirements.js';

// ── The textbook instance (Silberschatz, Operating System Concepts, §8.6.3) ─────────────────────
const T = ['A', 'B', 'C'];
const v = (a, b, c) => ({ A: a, B: b, C: c });
const textbook = () => ({
  types: T,
  available: v(3, 3, 2),
  processes: [
    { id: 'P0', allocation: v(0, 1, 0), max: v(7, 5, 3) },
    { id: 'P1', allocation: v(2, 0, 0), max: v(3, 2, 2) },
    { id: 'P2', allocation: v(3, 0, 2), max: v(9, 0, 2) },
    { id: 'P3', allocation: v(2, 1, 1), max: v(2, 2, 2) },
    { id: 'P4', allocation: v(0, 0, 2), max: v(4, 3, 3) }
  ]
});

test('textbook state is safe, with a deterministic completion order and a work trace', () => {
  const r = evaluateSafety(textbook());
  assert.equal(r.safe, true);
  assert.deepEqual(r.sequence, ['P1', 'P3', 'P4', 'P0', 'P2']);
  assert.deepEqual(r.steps[0], { id: 'P1', need: v(1, 2, 2), workBefore: v(3, 3, 2), workAfter: v(5, 3, 2) });
  assert.deepEqual(r.finalWork, v(10, 5, 7), 'everything is returned once all finish');
  assert.match(explain(r), /^Safe: every case can finish in the order P1 -> P3/);
});

test('textbook requests: P1 (1,0,2) is granted; then P4 (3,3,0) is refused as insufficient and P0 (0,2,0) as unsafe', () => {
  const p1 = requestResources(textbook(), 'P1', v(1, 0, 2));
  assert.equal(p1.granted, true);
  assert.deepEqual(p1.state.available, v(2, 3, 0));
  const p4 = requestResources(p1.state, 'P4', v(3, 3, 0));
  assert.deepEqual([p4.granted, p4.reason, p4.blocking], [false, 'INSUFFICIENT', { type: 'A', requested: 3, available: 2 }]);
  const p0 = requestResources(p1.state, 'P0', v(0, 2, 0));
  assert.deepEqual([p0.granted, p0.reason], [false, 'UNSAFE']);
  assert.ok(p0.safety.unfinished.length > 0);
  assert.match(explain(p0), /unsafe/);
});

test('a request beyond the remaining declared need is refused (EXCEEDS_CLAIM), never silently clamped', () => {
  const r = requestResources(textbook(), 'P3', v(1, 0, 0)); // P3 need is (0,1,1)
  assert.deepEqual([r.granted, r.reason, r.blocking], [false, 'EXCEEDS_CLAIM', { type: 'A', requested: 1, need: 0 }]);
});

test('input validation rejects malformed states instead of hiding them', () => {
  const cases = [
    [s => { s.processes[0].allocation.A = 8; }, /exceeds its maximum claim for A/], // the old simulator clamped this
    [s => { s.available.A = -1; }, /A must be a whole number/],
    [s => { s.available.A = 1.5; }, /A must be a whole number/],
    [s => { s.available.Z = 1; }, /unknown resource type/],
    [s => { s.processes[1].id = 'P0'; }, /duplicate id P0/],
    [s => { s.types = []; }, /types/]
  ];
  for (const [corrupt, expected] of cases) {
    const s = textbook();
    corrupt(s);
    assert.throws(() => evaluateSafety(s), err => err instanceof BankersInputError && expected.test(err.message), String(expected));
  }
  assert.throws(() => requestResources(textbook(), 'P9', v(0, 0, 0)), /unknown process P9/);
  assert.throws(() => requestResources(textbook(), 'P0', v(0, 0, 0), { newProcess: { id: 'P0', max: v(1, 1, 1) } }), /already in the state/);
});

test('an empty hospital is safe, and the input objects are not mutated', () => {
  assert.equal(evaluateSafety({ types: T, available: v(0, 0, 0), processes: [] }).safe, true);
  const s = textbook();
  const before = JSON.stringify(s);
  requestResources(s, 'P1', v(1, 0, 2));
  evaluateSafety(s);
  assert.equal(JSON.stringify(s), before);
  assert.ok(Object.isFrozen(validateState(s).available));
});

// ── Clinical pathways (D2-B) ───────────────────────────────────────────────────────────────────
test('the shipped pathways are valid; broken configurations are refused at start-up with every problem named', () => {
  assert.equal(validatePathways(), true);
  const bad = {
    TRAUMA: [{ resources: ['OT'] }, { resources: ['ICU_BED'], specialist: 'TRAUMA_SURGEON' }], // surgeon not in stage 1
    POLYTRAUMA: [{ resources: ['OT', 'OT'] }, { resources: ['MRI'] }],                          // duplicate, unknown, ICU missing
    CARDIAC: [{ resources: ['ICU_BED', 'VENTILATOR'] }],                                        // only one stage
    SPACE: [{ resources: [] }, { resources: [] }]
  };
  assert.throws(() => validatePathways(bad), err => {
    assert.ok(err instanceof PathwayConfigError);
    for (const expected of [/TRAUMA stage 2: an exclusive specialist must be claimed in stage 1/, /TRAUMA: the preset's TRAUMA_SURGEON must be claimed in stage 1/,
      /POLYTRAUMA stage 1: duplicate resource/, /unknown resource MRI/, /POLYTRAUMA: preset resource ICU_BED is in no stage/,
      /CARDIAC: a staged pathway needs at least 2 stages/, /SPACE: unknown emergency type/]) {
      assert.ok(err.problems.some(p => expected.test(p)), `missing problem ${expected}: ${err.problems.join(' | ')}`);
    }
    return true;
  });
});

test('claims at intake: TRAUMA and POLYTRAUMA are staged, extras join stage 1, other types are single-stage', () => {
  const trauma = buildClaim('TRAUMA', resolveEmergencyRequirements('TRAUMA'));
  assert.deepEqual(trauma, [{ stage_no: 1, units: { OT: 1, TRAUMA_SURGEON: 1 } }, { stage_no: 2, units: { ICU_BED: 1 } }]);
  const poly = buildClaim('POLYTRAUMA', resolveEmergencyRequirements('POLYTRAUMA', ['VENTILATOR']));
  assert.deepEqual(poly, [{ stage_no: 1, units: { OT: 1, VENTILATOR: 1, TRAUMA_SURGEON: 1 } }, { stage_no: 2, units: { ICU_BED: 1, VENTILATOR: 1 } }]);
  assert.deepEqual(buildClaim('CARDIAC', resolveEmergencyRequirements('CARDIAC')), [{ stage_no: 1, units: { ICU_BED: 1, VENTILATOR: 1 } }],
    'a consultant (cardiologist) is checked, not claimed');
  assert.deepEqual(buildClaim('GENERAL', resolveEmergencyRequirements('GENERAL')), [{ stage_no: 1, units: {} }]);
  assert.deepEqual(singleStageClaim(['ICU_BED', 'OT'], 'TRAUMA_SURGEON'), [{ stage_no: 1, units: { ICU_BED: 1, OT: 1, TRAUMA_SURGEON: 1 } }]);
});

test('claim helpers: rows round-trip, Need is the peak over remaining stages, stage accessors', () => {
  const poly = buildClaim('POLYTRAUMA', resolveEmergencyRequirements('POLYTRAUMA'));
  assert.deepEqual(claimFromRows(claimRows(poly)), poly);
  assert.equal(claimFromRows([]), null);
  assert.deepEqual(maxClaim(poly, 1), { ICU_BED: 1, OT: 1, TRAUMA_SURGEON: 1, VENTILATOR: 1 });
  assert.deepEqual(maxClaim(poly, 2), { ICU_BED: 1, OT: 0, TRAUMA_SURGEON: 0, VENTILATOR: 1 });
  assert.deepEqual(physicalTypes(stageOf(poly, 1)), ['OT']);
  assert.equal(exclusiveSpecialistOf(stageOf(poly, 1)), 'TRAUMA_SURGEON');
  assert.equal(exclusiveSpecialistOf(stageOf(poly, 2)), null);
  assert.deepEqual(CLAIM_RESOURCE_TYPES, ['ICU_BED', 'OT', 'TRAUMA_SURGEON', 'VENTILATOR']);
});

// ── Hospital decisions with real claims ─────────────────────────────────────────────────────────
const res = (icu, ot, vent) => [
  { resource_type: 'ICU_BED', available_capacity: icu, locked_capacity: 0 },
  { resource_type: 'OT', available_capacity: ot, locked_capacity: 0 },
  { resource_type: 'VENTILATOR', available_capacity: vent, locked_capacity: 0 }
];
const TRAUMA = buildClaim('TRAUMA', resolveEmergencyRequirements('TRAUMA'));
const POLY = buildClaim('POLYTRAUMA', resolveEmergencyRequirements('POLYTRAUMA'));

test('admission: surgery is refused when its post-op ICU bed can never be guaranteed (free OT and surgeon notwithstanding)', () => {
  const state = buildHospitalState({ resources: res(0, 2, 0), specialistsAvailable: { TRAUMA_SURGEON: 1 }, cases: [] });
  const d = admissionDecision(state, { id: 'REQ-T', stages: TRAUMA, currentStage: 1 });
  assert.deepEqual([d.granted, d.reason, d.blocking.type], [false, 'UNSAFE', 'ICU_BED']);
  assert.deepEqual(d.request, { ICU_BED: 0, OT: 1, TRAUMA_SURGEON: 1, VENTILATOR: 0 }, 'stage 1 asks only for the OT and the surgeon');
  const ok = admissionDecision(buildHospitalState({ resources: res(1, 2, 0), specialistsAvailable: { TRAUMA_SURGEON: 1 }, cases: [] }), { id: 'REQ-T', stages: TRAUMA, currentStage: 1 });
  assert.equal(ok.granted, true);
});

test('admission depends on what other cases will release, not only on what is free now', () => {
  // No ICU bed is free, but REQ-L (single-stage, needs nothing more) will release one when it finishes.
  const withHolder = buildHospitalState({
    resources: res(0, 1, 0), specialistsAvailable: { TRAUMA_SURGEON: 1 },
    cases: [{ id: 'REQ-L', stages: singleStageClaim(['ICU_BED'], null), currentStage: 1, held: { ICU_BED: 1 } }]
  });
  const ok = admissionDecision(withHolder, { id: 'REQ-T', stages: TRAUMA, currentStage: 1 });
  assert.equal(ok.granted, true);
  assert.deepEqual(ok.safety.sequence, ['REQ-L', 'REQ-T'], 'REQ-T can finish only after REQ-L frees its bed');
  const noHolder = buildHospitalState({ resources: res(0, 1, 0), specialistsAvailable: { TRAUMA_SURGEON: 1 }, cases: [] });
  assert.equal(admissionDecision(noHolder, { id: 'REQ-T', stages: TRAUMA, currentStage: 1 }).reason, 'UNSAFE');
});

test('multi-case dependency: B can finish only with the ventilator A releases; losing the ICU bed strands both', () => {
  // A: TRAUMA with an extra ventilator holds OT + VENTILATOR + surgeon and still needs an ICU bed.
  const A = buildClaim('TRAUMA', resolveEmergencyRequirements('TRAUMA', ['VENTILATOR']));
  // B: POLYTRAUMA holds its OT and still needs an ICU bed and a ventilator (none free: A holds it).
  const cases = [
    { id: 'REQ-A', stages: A, currentStage: 1, held: { OT: 1, VENTILATOR: 1, TRAUMA_SURGEON: 1 } },
    { id: 'REQ-B', stages: POLY, currentStage: 1, held: { OT: 1 } }
  ];
  const safe = evaluateHospital(buildHospitalState({ resources: res(1, 0, 0), cases }));
  assert.equal(safe.safe, true);
  assert.deepEqual(safe.sequence, ['REQ-A', 'REQ-B']);
  const stranded = evaluateHospital(buildHospitalState({ resources: res(0, 0, 0), cases }));
  assert.equal(stranded.safe, false);
  assert.deepEqual(stranded.unfinished.map(u => u.id), ['REQ-A', 'REQ-B'], 'B waits on A\'s ventilator, A on an ICU bed nobody will free');
  assert.match(stranded.explanation, /can never finish/);
});

test('legacy cases (no recorded claim) are treated as holding exactly their claim: they never wait', () => {
  const state = buildHospitalState({
    resources: res(0, 0, 0), cases: [{ id: 'REQ-OLD', stages: null, currentStage: 1, held: { ICU_BED: 1, OT: 1 } }]
  });
  const report = evaluateHospital(state);
  assert.equal(report.safe, true);
  assert.deepEqual(report.cases[0].need, { ICU_BED: 0, OT: 0, TRAUMA_SURGEON: 0, VENTILATOR: 0 });
  assert.equal(report.cases[0].legacy_claim, true);
});

test('an already unsafe hospital admits nobody, even a case that needs nothing beyond what is free (D5-a3)', () => {
  const unsafe = buildHospitalState({
    resources: res(0, 1, 0), cases: [{ id: 'REQ-T', stages: TRAUMA, currentStage: 1, held: { OT: 1, TRAUMA_SURGEON: 1 } }]
  });
  assert.equal(evaluateHospital(unsafe).safe, false, 'the ICU bed REQ-T needs after surgery is gone (e.g. a capacity edit)');
  const d = admissionDecision(unsafe, { id: 'REQ-G', stages: [{ stage_no: 1, units: {} }], currentStage: 1 });
  assert.deepEqual([d.granted, d.reason], [false, 'HOSPITAL_UNSAFE']);
});

test('stage advance: stage 1 resources are released while stage 2 is requested; refused when unsafe or short', () => {
  const state = buildHospitalState({
    resources: res(1, 0, 1), specialistsAvailable: { TRAUMA_SURGEON: 0 },
    cases: [{ id: 'REQ-P', stages: POLY, currentStage: 1, held: { OT: 1, TRAUMA_SURGEON: 1 } }]
  });
  const d = advanceDecision(state, { id: 'REQ-P', stages: POLY, toStage: 2, release: { OT: 1, TRAUMA_SURGEON: 1 } });
  assert.equal(d.granted, true);
  assert.deepEqual(d.request, { ICU_BED: 1, OT: 0, TRAUMA_SURGEON: 0, VENTILATOR: 1 });
  assert.deepEqual(d.available, { ICU_BED: 1, OT: 1, TRAUMA_SURGEON: 1, VENTILATOR: 1 }, 'released units count as free for the check');

  const noVent = buildHospitalState({
    resources: res(1, 0, 0), cases: [{ id: 'REQ-P', stages: POLY, currentStage: 1, held: { OT: 1, TRAUMA_SURGEON: 1 } }]
  });
  const refused = advanceDecision(noVent, { id: 'REQ-P', stages: POLY, toStage: 2, release: { OT: 1, TRAUMA_SURGEON: 1 } });
  assert.equal(refused.granted, false);
  assert.equal(refused.reason, 'HOSPITAL_UNSAFE', 'with no ventilator obtainable the hospital is already unsafe');
});

test('holdings above the recorded claim are reported as an anomaly, never hidden', () => {
  const state = buildHospitalState({
    resources: res(5, 5, 5), cases: [{ id: 'REQ-X', stages: TRAUMA, currentStage: 2, held: { ICU_BED: 1, OT: 1 } }]
  });
  assert.deepEqual(state.anomalies, [{ id: 'REQ-X', kind: 'HOLDS_ABOVE_CLAIM', types: ['OT'] }]);
  assert.equal(evaluateHospital(state).safe, true);
});

test('anomalies are explicit decisions, never crashes: a case already holding units is refused; a case holding nothing can advance', () => {
  const holding = buildHospitalState({
    resources: res(1, 1, 0), cases: [{ id: 'REQ-T', stages: TRAUMA, currentStage: 1, held: { OT: 1, TRAUMA_SURGEON: 1 } }]
  });
  assert.equal(evaluateHospital(holding).safe, true, 'precondition: the hospital itself is safe');
  const again = admissionDecision(holding, { id: 'REQ-T', stages: TRAUMA, currentStage: 1 });
  assert.deepEqual([again.granted, again.reason], [false, 'ALREADY_HOLDS']);
  assert.match(again.explanation, /already holds resources/);

  const empty = buildHospitalState({ resources: res(1, 0, 1), cases: [] });
  const advanced = advanceDecision(empty, { id: 'REQ-P', stages: POLY, toStage: 2, release: {} });
  assert.equal(advanced.granted, true);
  assert.deepEqual(advanced.request, { ICU_BED: 1, OT: 0, TRAUMA_SURGEON: 0, VENTILATOR: 1 });
});
