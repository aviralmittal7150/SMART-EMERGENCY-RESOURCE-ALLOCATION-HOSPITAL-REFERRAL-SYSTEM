import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LockManager } from '../js/locking.js';
import { initialHospitals } from '../js/data.js';

describe('Issue #4: Concurrency, 90s Soft-Locking, & Referral Handshake', () => {
  test('Acquiring soft-lock increments locked_capacity and holds lock with 90s TTL', () => {
    const hospital = JSON.parse(JSON.stringify(initialHospitals[0]));
    const request = { requestId: 'REQ-999', requiredResources: ['icuBeds'] };
    
    let lockUpdateCalled = false;
    const lockManager = new LockManager(() => { lockUpdateCalled = true; });

    const lock = lockManager.acquireLock(hospital, request, () => {});
    
    assert.strictEqual(hospital.resources.icuBeds.locked, 1, 'Locked capacity must increment by 1');
    assert.strictEqual(lock.remainingSec, 90, 'Initial lock duration must be 90 seconds');
    assert.ok(lockUpdateCalled, 'Lock update callback should fire');

    lockManager.releaseLock();
  });

  test('Accepting referral atomically commits allocation and decrements available capacity', () => {
    const hospital = JSON.parse(JSON.stringify(initialHospitals[0]));
    const request = { requestId: 'REQ-999', requiredResources: ['icuBeds'] };
    const initialAvail = hospital.resources.icuBeds.available;

    const lockManager = new LockManager(() => {});
    lockManager.acquireLock(hospital, request, () => {});
    
    const committed = lockManager.commitAllocation();
    assert.strictEqual(committed.status, 'COMMITTED_ACCEPTED');
    assert.strictEqual(hospital.resources.icuBeds.locked, 0, 'Locked capacity should reset to 0');
    assert.strictEqual(hospital.resources.icuBeds.available, initialAvail - 1, 'Available capacity should decrement by 1');
  });

  test('Rejecting referral releases soft lock and triggers failover callback', () => {
    const hospital = JSON.parse(JSON.stringify(initialHospitals[0]));
    const request = { requestId: 'REQ-999', requiredResources: ['icuBeds'] };

    const lockManager = new LockManager(() => {});
    lockManager.acquireLock(hospital, request, () => {});

    let failoverTriggered = false;
    lockManager.rejectAllocation(() => { failoverTriggered = true; });

    assert.strictEqual(hospital.resources.icuBeds.locked, 0, 'Soft lock must be released on rejection');
    assert.strictEqual(lockManager.activeLock, null);
    assert.strictEqual(failoverTriggered, true, 'Failover callback must execute on rejection');
  });
});
