// tests/bankers_compound.test.js
// P3-02: Multi-Resource Banker's Algorithm Compound Claims Test Suite (Issue #25)
// Tests 4-resource vector class compound claims and proactive deadlock rejection.

import test from 'node:test';
import assert from 'node:assert';
import { BankersAlgorithm } from '../js/bankers.js';

test('Issue #25 / P3-02: Multi-Resource Compound Claims Deadlock Engine', async (t) => {
  await t.test('Creates 4-resource vector class compound model correctly', () => {
    const compound = BankersAlgorithm.createCompoundModel();
    assert.strictEqual(compound.resourceNames.length, 4);
    assert.deepStrictEqual(compound.resourceNames, [
      'ICU Beds', 'Ventilators', 'Specialists', 'Operating Theatres'
    ]);
  });

  await t.test('Evaluates safe sequence across 4 compound resource dimensions', () => {
    const compound = new BankersAlgorithm(
      ['P0 (Cardiac)', 'P1 (Polytrauma)', 'P2 (Stroke)', 'P3 (Respiratory)'],
      ['ICU Beds', 'Ventilators', 'Specialists', 'Operating Theatres']
    );
    compound.available = [3, 3, 2, 2];
    compound.allocation = [
      [0, 1, 0, 0],
      [2, 0, 0, 1],
      [3, 0, 2, 0],
      [2, 1, 1, 1]
    ];
    compound.max = [
      [7, 5, 3, 2],
      [3, 2, 2, 2],
      [9, 0, 2, 1],
      [2, 2, 2, 2]
    ];

    const result = compound.evaluateSafety();
    assert.strictEqual(result.isSafe, true);
    assert.strictEqual(result.safeSequence.length, 4);
    assert.strictEqual(result.safeSequence[0], 'P1 (Polytrauma)');
  });

  await t.test('requestResources safely grants compound request if safe state is preserved', () => {
    const bankers = new BankersAlgorithm();
    // P1 requests [1, 0, 2] (ICU, Vent, Specialist)
    const res = bankers.requestResources(1, [1, 0, 2]);
    assert.strictEqual(res.granted, true);
    assert.ok(res.safeSequence.length > 0);
  });

  await t.test('requestResources proactively rejects compound request that triggers circular wait/unsafe state', () => {
    const bankers = new BankersAlgorithm();
    // P0 claims [3, 3, 2] which would exhaust available resources and trigger unsafe state
    const res = bankers.requestResources(0, [3, 3, 2]);
    assert.strictEqual(res.granted, false);
    assert.ok(res.reason.includes('UNSAFE state'));
  });

  await t.test('requestResources prevents requests exceeding Maximum Claim', () => {
    const bankers = new BankersAlgorithm();
    // P3 Max claim is [2, 2, 2], Alloc is [2, 1, 1], Need is [0, 1, 1]
    // Requesting [1, 0, 0] exceeds need!
    const res = bankers.requestResources(3, [1, 0, 0]);
    assert.strictEqual(res.granted, false);
    assert.ok(res.reason.includes('exceeded maximum claim'));
  });
});
