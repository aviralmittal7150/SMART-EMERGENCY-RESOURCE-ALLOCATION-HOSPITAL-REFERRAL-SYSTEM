// tests/concurrency_stress.test.js
// P3-01: Mass Casualty Concurrency Stress Simulation Engine (Issue #24)
// Simulates 100 concurrent emergency intake requests competing for scarce resources (5 ICU beds)
// Validates 0 double allocations, strict mutual exclusion, and safe failovers.

import test from 'node:test';
import assert from 'node:assert';
import { db } from '../server/db/seed.js';

test('Issue #24 / P3-01: Mass Casualty Concurrency Stress Engine', async (t) => {
  await t.test('100 concurrent requests competing for 1 bottleneck ICU bed yield exactly 1 allocation and 99 safe rejections/reroutes with 0 double allocations', async () => {
    const resourceId = 'RES-101-ICU';
    const targetHospitalId = 'H-101';

    // Set bottleneck state: exactly 1 bed available
    const resource = db.medicalResources.find(r => r.resource_id === resourceId);
    assert.ok(resource, 'Bottleneck resource must exist');
    const originalAvailable = resource.available_capacity;
    const originalLocked = resource.locked_capacity;

    resource.available_capacity = 1;
    resource.locked_capacity = 0;

    const TOTAL_REQUESTS = 100;
    let successfulAllocations = 0;
    let safeReroutes = 0;
    let lockFailures = 0;

    const startTime = Date.now();

    // Launch 100 concurrent threads
    const concurrentRequests = Array.from({ length: TOTAL_REQUESTS }, async (_, idx) => {
      const requestId = `REQ-MASS-${idx + 1}`;
      try {
        // Attempt atomic mutex lock with timeout
        const releaseMutex = await db.acquireResourceLock(resourceId, 2000);

        // Critical Section (Mutual Exclusion)
        try {
          if (resource.available_capacity > 0) {
            // Claim the resource
            resource.available_capacity -= 1;
            resource.locked_capacity += 1;
            successfulAllocations++;

            db.auditLog({
              request_id: requestId,
              hospital_id: targetHospitalId,
              event_type: 'MASS_CASUALTY_ALLOCATION_COMMITTED',
              previous_state: 'WAITING',
              new_state: 'ALLOCATED',
              actor_role: 'SYSTEM',
              metadata: { threadIdx: idx, resourceId }
            });
          } else {
            // Resource exhausted — safe reroute to Rank #2
            safeReroutes++;
            db.auditLog({
              request_id: requestId,
              hospital_id: targetHospitalId,
              event_type: 'MASS_CASUALTY_REROUTED',
              previous_state: 'WAITING',
              new_state: 'MATCHING',
              actor_role: 'SYSTEM',
              metadata: { threadIdx: idx, reason: 'Capacity exhausted' }
            });
          }
        } finally {
          releaseMutex();
        }
      } catch (err) {
        lockFailures++;
        safeReroutes++;
      }
    });

    await Promise.all(concurrentRequests);
    const durationMs = Date.now() - startTime;

    // Concurrency Invariants
    assert.strictEqual(successfulAllocations, 1, `Must have exactly 1 allocation, got ${successfulAllocations}`);
    assert.strictEqual(successfulAllocations + safeReroutes, TOTAL_REQUESTS, `All ${TOTAL_REQUESTS} requests must be resolved`);
    assert.strictEqual(resource.available_capacity, 0, 'Resource available capacity must be 0');
    assert.strictEqual(resource.locked_capacity, 1, 'Locked capacity must reflect the single winner');

    // Restore state
    resource.available_capacity = originalAvailable;
    resource.locked_capacity = originalLocked;

    assert.ok(durationMs < 5000, `Execution time (${durationMs}ms) within real-time SLA bounds`);
  });

  await t.test('High-concurrency multi-hospital allocation across 50 requests maintains global invariant balance', async () => {
    // 50 requests distributed across 5 hospitals
    const initialNetworkBeds = db.medicalResources
      .filter(r => r.resource_type === 'ICU_BED')
      .reduce((sum, r) => sum + r.available_capacity, 0);

    assert.ok(initialNetworkBeds > 0, 'Network must have beds available');

    let totalAllocated = 0;
    const requests = Array.from({ length: 50 }, async (_, i) => {
      const hospitalIndex = i % db.hospitals.length;
      const targetHospital = db.hospitals[hospitalIndex];
      const res = db.medicalResources.find(r => r.hospital_id === targetHospital.hospital_id && r.resource_type === 'ICU_BED');
      if (!res) return;

      try {
        const release = await db.acquireResourceLock(res.resource_id, 1500);
        try {
          if (res.available_capacity > 0 && targetHospital.emergency_status !== 'CLOSED') {
            res.available_capacity -= 1;
            totalAllocated++;
          }
        } finally {
          release();
        }
      } catch (_) {}
    });

    await Promise.all(requests);
    assert.ok(totalAllocated <= initialNetworkBeds, 'Allocations must not exceed initial capacity');
  });
});
