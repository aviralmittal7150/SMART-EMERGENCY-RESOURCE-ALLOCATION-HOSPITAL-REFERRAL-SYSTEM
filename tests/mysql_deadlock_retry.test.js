// MySQL-ONLY (InnoDB deadlock detection has no in-memory counterpart): a REAL deadlock is forced inside
// an engine transaction, and the engine's retry path (mysqlLockingEngine._tx, errno 1213) is shown to
// re-run the whole transaction from scratch and apply its effects exactly once.
//
// How the deadlock is forced, deterministically (pause points, no sleeps):
//   1. The engine completes a case: it locks the EmergencyRequest row and is paused there.
//   2. A rival connection (outside the engine, deliberately breaking our lock order) locks the case's
//      ICU MedicalResource row, then asks for the EmergencyRequest row: it now waits for the engine.
//   3. The engine resumes and asks for the MedicalResource row: it now waits for the rival -> cycle.
//      InnoDB detects it and rolls back the transaction that changed FEWER rows; the rival first
//      inserts ballast rows so the engine is that victim (documented InnoDB behaviour).
//   4. The rival is granted the request row, then rolls back; the engine's retry completes.
// Runs only against the dedicated *_test database. All data is fictional.
//
// InnoDB DEPENDENCIES (this is a regression test of the retry path, not a portable engine test):
//  - innodb_deadlock_detect must be ON (the MySQL default). The test asserts it first and fails with a
//    clear message otherwise; with detection off, a cycle would only end by innodb_lock_wait_timeout
//    (errno 1205), which the engine deliberately does NOT retry.
//  - Victim choice: InnoDB rolls back the "smaller" transaction (fewer rows inserted/updated/deleted). The
//    300 ballast rows make the rival far larger than the engine's one-row change. If a future MySQL release
//    changed this rule and chose the rival instead, the test would FAIL (no retry observed, assertion
//    `retries.length === 1`), never pass silently.
//  - Verified on MySQL 9.6 (macOS, local) and MySQL 8.4 (Linux, as in CI).

import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createMysqlBackend } from './contract/backends.js';
import { resolveEmergencyRequirements } from '../server/services/emergencyRequirements.js';
import { gate } from './helpers/gate.js';

const ADMIN = { role: 'ADMIN', id: 'U-DEADLOCK-ADMIN' };
const backend = await createMysqlBackend();

if (backend.skip) {
  test.skip(`MySQL deadlock retry (skipped: ${backend.skip})`, () => {});
} else {
  const b = backend;
  test.after(() => b.close());

  test('a real InnoDB deadlock is retried from scratch and the completion is applied exactly once', async () => {
    await b.reset();
    const [[{ detect }]] = await b.admin.query('SELECT @@innodb_deadlock_detect AS detect');
    assert.equal(Number(detect), 1, 'this test needs innodb_deadlock_detect=ON on the test server');

    await b.setCapacity('H-A', 'ICU_BED', { total: 2 });
    await b.setCapacity('H-A', 'VENTILATOR', { total: 2 });
    const req = resolveEmergencyRequirements('RESPIRATORY');
    const { request_id: id } = await b.store.createRequest({
      patient: { full_name: 'Fictional Deadlock Patient', age: 50, gender: 'UNKNOWN', emergency_type: 'RESPIRATORY', triage_priority: 2, contact_phone: null },
      request: { emergency_type: 'RESPIRATORY', required_resource_types: req.resourceTypes, required_specialist: null, priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
    }, ADMIN);
    const lock = await b.store.acquireReferralLock('H-A', id, req.resourceTypes);
    await b.store.commitReferral(lock.acceptanceId, 'U-DEADLOCK-DESK');
    assert.deepEqual(await b.resource('H-A', 'ICU_BED'), { total: 2, available: 1, locked: 0 });

    const retries = [];
    b.hooks.on('tx:deadlockRetry', ctx => { retries.push(ctx); });
    const held = gate();
    b.hooks.once('transition:statusRecorded', held.hold, ctx => ctx.requestId === id && ctx.attempt === 0);

    const rival = await mysql.createConnection({ ...b.config });
    try {
      const completing = b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
      await held.reached; // attempt 0 holds the EmergencyRequest row and has written COMPLETED

      await rival.query('SET SESSION innodb_lock_wait_timeout = 30');
      await rival.beginTransaction();
      const ballast = Array.from({ length: 300 }, (_, i) => `('H-A', 'SYSTEM', 'deadlock test ballast ${i}')`).join(', ');
      await rival.query(`INSERT INTO Alert (hospital_id, alert_type, message) VALUES ${ballast}`);
      await rival.query("SELECT resource_id FROM MedicalResource WHERE resource_id = 'RES-H-A-ICU_BED' FOR UPDATE");
      const rivalGetsRequestRow = rival.query('SELECT request_id FROM EmergencyRequest WHERE request_id = ? FOR UPDATE', [id]);

      held.release(); // attempt 0 now asks for the ICU row the rival holds: a lock cycle
      await rivalGetsRequestRow; // granted only because InnoDB rolled attempt 0 back
      await rival.rollback(); // the rival gives everything up; attempt 1 can proceed

      const result = await completing;
      assert.equal(result.status, 'COMPLETED');
    } finally {
      await rival.end();
    }

    assert.equal(retries.length, 1, 'exactly one deadlock retry');
    assert.equal(retries[0].errno, 1213);
    assert.equal(retries[0].attempt, 0);
    // Applied exactly once: capacity returned once, one audit row, nothing from the rolled-back attempt.
    for (const type of ['ICU_BED', 'VENTILATOR']) assert.deepEqual(await b.resource('H-A', type), { total: 2, available: 2, locked: 0 });
    assert.deepEqual((await b.allocations(id)).map(a => a.status), ['RELEASED', 'RELEASED']);
    const completions = (await b.audit(id)).filter(e => e.event_type === 'STATUS_CHANGED' && e.new_state === 'COMPLETED');
    assert.equal(completions.length, 1);
    assert.deepEqual(completions[0].metadata, { released_allocations: 2, capped_releases: 0 });
    assert.equal((await b.request(id)).status, 'COMPLETED');
    assert.deepEqual(await b.ambulance('AMB-A1'), { status: 'AVAILABLE', assigned_request_id: null });
    const [[{ n }]] = await b.admin.query("SELECT COUNT(*) AS n FROM Alert WHERE message LIKE 'deadlock test ballast%'");
    assert.equal(Number(n), 0, "the rival's rolled-back rows are gone");
    // The engine's own transactions still followed the lock order (only the rival broke it).
    assert.equal(b.checker.violations.length, 0, b.checker.describe());
  });
}
