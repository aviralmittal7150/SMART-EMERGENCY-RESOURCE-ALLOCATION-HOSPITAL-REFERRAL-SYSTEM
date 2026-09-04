import { test, describe } from 'node:test';
import assert from 'node:assert';
import { BankersAlgorithm } from '../js/bankers.js';

describe('Issue #5: OS Deadlock & Banker\'s Algorithm Simulator', () => {
  test('Correctly computes Need matrix (Need = Max - Allocation)', () => {
    const bankers = new BankersAlgorithm();
    const need = bankers.getNeedMatrix();

    // P0 Max: [7, 5, 3], Alloc: [0, 1, 0] => Need: [7, 4, 3]
    assert.deepStrictEqual(need[0], [7, 4, 3]);
    // P1 Max: [3, 2, 2], Alloc: [2, 0, 0] => Need: [1, 2, 2]
    assert.deepStrictEqual(need[1], [1, 2, 2]);
  });

  test('Identifies safe state and generates valid execution sequence for initial vector', () => {
    const bankers = new BankersAlgorithm();
    const result = bankers.evaluateSafety();

    assert.strictEqual(result.isSafe, true, 'Initial state must be evaluated as safe');
    assert.strictEqual(result.safeSequence.length, 4, 'All 4 processes should be part of safe sequence');
    assert.ok(result.safeSequence.includes('P1 (Polytrauma)'));
  });

  test('Detects unsafe deadlock hazard when resources are exhausted', () => {
    const bankers = new BankersAlgorithm();
    bankers.available = [0, 0, 0]; // Zero available resources
    const result = bankers.evaluateSafety();

    assert.strictEqual(result.isSafe, false, 'Should flag unsafe state when cannot fulfill any process need');
    assert.strictEqual(result.safeSequence.length, 0);
  });
});
