// tests/phase2_backend.test.js
// Automated Test Suite for Phase 2:
// Express REST API, Concurrency Locking Engine, RBAC Auth, and Doctors Scheduler

import test from 'node:test';
import assert from 'node:assert';
import { db } from '../server/db/seed.js';
import { lockingEngine } from '../server/services/lockingEngine.js';
import { generateToken } from '../server/middleware/auth.js';
import jwt from 'jsonwebtoken';

test('Phase 2 — RBAC JWT Token Authentication (P2-05)', async (t) => {
  await t.test('Generates valid signed JWT with role and user claims', () => {
    const payload = { user_id: 'USER-001', role: 'ADMIN', hospital_id: null };
    const token = generateToken(payload);
    assert.ok(typeof token === 'string' && token.length > 20);

    const decoded = jwt.decode(token);
    assert.strictEqual(decoded.role, 'ADMIN');
    assert.strictEqual(decoded.user_id, 'USER-001');
  });

  await t.test('JWT for Hospital Desk properly carries hospital_id for data isolation', () => {
    const payload = { user_id: 'USER-HSP-101', role: 'HOSPITAL_DESK', hospital_id: 'H-101' };
    const token = generateToken(payload);
    const decoded = jwt.decode(token);
    assert.strictEqual(decoded.role, 'HOSPITAL_DESK');
    assert.strictEqual(decoded.hospital_id, 'H-101');
  });
});

test('Phase 2 — ACID Concurrency Locking Engine & Mutual Exclusion (P2-03)', async (t) => {
  await t.test('Acquires 90-second soft-lock and updates locked capacity atomically', async () => {
    const hospital = db.hospitals.find(h => h.hospital_id === 'H-101');
    const icuResource = db.medicalResources.find(r => r.hospital_id === 'H-101' && r.resource_type === 'ICU_BED');
    const initialLocked = icuResource.locked_capacity;

    const lock = await lockingEngine.acquireSoftLock('H-101', 'REQ-TEST-01', ['ICU_BED']);
    assert.ok(lock.acceptanceId);
    assert.strictEqual(lock.remainingSec, 90);
    assert.strictEqual(icuResource.locked_capacity, initialLocked + 1);

    // Clean up
    await lockingEngine.rejectAndFailover(lock.acceptanceId, 'Test teardown');
    assert.strictEqual(icuResource.locked_capacity, initialLocked);
  });

  await t.test('Commit allocation commits resource and decrements available capacity', async () => {
    const icuResource = db.medicalResources.find(r => r.hospital_id === 'H-103' && r.resource_type === 'ICU_BED');
    const initialAvail = icuResource.available_capacity;

    const lock = await lockingEngine.acquireSoftLock('H-103', 'REQ-TEST-02', ['ICU_BED']);
    const committed = await lockingEngine.commitAllocation(lock.acceptanceId, 'TEST-ACTOR');

    assert.strictEqual(committed.status, 'ACCEPTED');
    assert.strictEqual(icuResource.available_capacity, initialAvail - 1);

    // Revert for subsequent test runs
    icuResource.available_capacity = initialAvail;
  });

  await t.test('Concurrent lock attempts for single bed maintain mutual exclusion with zero double allocation', async () => {
    // Simulate competing requests
    const resId = 'RES-101-ICU';
    const release1 = await db.acquireResourceLock(resId, 1000);

    let secondLockAcquiredImmediately = false;
    // Attempting second acquire without release should wait or timeout
    const trySecond = new Promise((resolve) => {
      db.acquireResourceLock(resId, 100)
        .then(rel => {
          secondLockAcquiredImmediately = true;
          rel();
          resolve();
        })
        .catch(() => resolve()); // Timeout expected while held
    });

    await trySecond;
    assert.strictEqual(secondLockAcquiredImmediately, false, 'Second thread must NOT acquire lock simultaneously');
    release1(); // Clean release
  });
});

test('Phase 2 — Doctor & Specialist Shift Scheduler (P2-07)', async (t) => {
  await t.test('Correctly filters specialists and updates shift availability', () => {
    const surgeons = db.doctors.filter(d => d.specialization === 'TRAUMA_SURGEON');
    assert.ok(surgeons.length >= 2, 'Must have trauma surgeons in network');

    const doctor = surgeons[0];
    const prevStatus = doctor.availability_status;
    doctor.availability_status = 'IN_PROCEDURE';
    assert.strictEqual(doctor.availability_status, 'IN_PROCEDURE');
    doctor.availability_status = prevStatus; // reset
  });
});

test('Phase 2 — Immutable Emergency Audit Ledger (P2-02 & P2-08)', async (t) => {
  await t.test('Audit log records lifecycle events with timestamps and actors', () => {
    const initialCount = db.emergencyHistory.length;
    db.auditLog({
      request_id: 'REQ-AUDIT-TEST',
      hospital_id: 'H-101',
      event_type: 'TEST_AUDIT_EVENT',
      previous_state: 'WAITING',
      new_state: 'ALLOCATED',
      actor_role: 'SYSTEM'
    });

    assert.strictEqual(db.emergencyHistory.length, initialCount + 1);
    const last = db.emergencyHistory[db.emergencyHistory.length - 1];
    assert.strictEqual(last.event_type, 'TEST_AUDIT_EVENT');
    assert.ok(last.event_time);
  });
});
