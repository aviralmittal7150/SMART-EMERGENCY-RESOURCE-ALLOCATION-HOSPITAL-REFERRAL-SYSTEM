import { test, describe } from 'node:test';
import assert from 'node:assert';
import { initialAmbulances, initialEmergencyQueue } from '../js/data.js';

describe('Issue #6: Ambulance Fleet Dispatch & Process Lifecycle Tracker', () => {
  test('Ambulances maintain distinct status states (AVAILABLE, IN_TRANSIT, MAINTENANCE)', () => {
    const statuses = initialAmbulances.map(a => a.status);
    assert.ok(statuses.includes('AVAILABLE'));
    assert.ok(statuses.includes('IN_TRANSIT'));
    assert.ok(statuses.includes('MAINTENANCE'));
  });

  test('Emergency requests map to valid OS process states', () => {
    const validStates = ['NEW', 'WAITING', 'ALLOCATED', 'IN_TREATMENT', 'COMPLETED'];
    initialEmergencyQueue.forEach(item => {
      assert.ok(validStates.includes(item.status), `State ${item.status} must be valid OS process state`);
    });
  });
});
