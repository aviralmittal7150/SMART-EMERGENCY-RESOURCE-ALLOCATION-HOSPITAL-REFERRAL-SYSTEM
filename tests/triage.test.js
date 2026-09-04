import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TRIAGE_LEVELS, EMERGENCY_PRESETS, comparePriority } from '../js/triage.js';

describe('Issue #1: Emergency Ingestion & Priority Triage Engine', () => {
  test('Triage 1 (Resuscitation) has higher scheduling priority than Triage 3 (Urgent)', () => {
    const p1Case = { priority: 1, requestTime: '22:10:00' };
    const p3Case = { priority: 3, requestTime: '22:05:00' };
    const queue = [p3Case, p1Case];
    queue.sort(comparePriority);

    assert.strictEqual(queue[0].priority, 1, 'P1 case must be at the head of the Priority Queue');
  });

  test('FIFO tie-breaking is enforced for emergencies with identical triage priority', () => {
    const earlierCase = { priority: 2, requestTime: '2026-09-04T22:00:00Z' };
    const laterCase = { priority: 2, requestTime: '2026-09-04T22:05:00Z' };
    const queue = [laterCase, earlierCase];
    queue.sort(comparePriority);

    assert.strictEqual(queue[0].requestTime, earlierCase.requestTime, 'Earlier arrival time should be prioritized on tie');
  });

  test('Emergency presets correctly resolve required life-saving resources', () => {
    const cardiacPreset = EMERGENCY_PRESETS.CARDIAC;
    assert.strictEqual(cardiacPreset.defaultTriage, 1);
    assert.ok(cardiacPreset.required.includes('icuBeds'), 'Cardiac emergency must require ICU Bed');
    assert.ok(cardiacPreset.required.includes('cardiologist'), 'Cardiac emergency must require Cardiologist');
  });
});
