// Integration tests for the MySQL locking engine, run against a REAL MySQL server.
//
// Setup: put dedicated test credentials in .env.local (git-ignored):
//   MYSQL_TEST_HOST / MYSQL_TEST_PORT / MYSQL_TEST_USER / MYSQL_TEST_PASS / MYSQL_TEST_DB
// The database name MUST end in "_test": the test drops and recreates the tables in it.
// Without credentials (or if the server is unreachable) the whole file is skipped, not failed.
// All patient data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { MySqlLockingEngine, LockError } from '../server/services/mysqlLockingEngine.js';
import { openTestDatabase } from './helpers/mysqlTestDb.js';

const TABLES = ['Alert', 'Ambulance', 'Doctor', 'EmergencyHistory', 'EmergencyRequest', 'Hospital',
  'HospitalAcceptance', 'MedicalResource', 'Patient', 'ResourceAllocation', 'SystemUser'];

// Holds the cross-file advisory lock for the whole file, then releases it in test.after below.
const handle = await openTestDatabase();
const { admin, skip, config } = handle;

if (skip) {
  test.skip(`MySQL locking engine (skipped: ${skip})`, () => {});
} else {
  const pool = mysql.createPool({ ...config, connectionLimit: 30 });
  const engine = new MySqlLockingEngine({ pool });

  // Fresh schema from the real schema.sql, so these tests also prove the schema loads and fits the engine.
  await admin.query(`SET FOREIGN_KEY_CHECKS = 0; ${TABLES.map(t => `DROP TABLE IF EXISTS \`${t}\``).join('; ')}; SET FOREIGN_KEY_CHECKS = 1`);
  await admin.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));

  test.after(async () => {
    await pool.end();
    await handle.release();
  });

  let seq = 0;

  async function reset() {
    await admin.query(`SET FOREIGN_KEY_CHECKS = 0; ${TABLES.map(t => `TRUNCATE TABLE \`${t}\``).join('; ')}; SET FOREIGN_KEY_CHECKS = 1`);
    const hospitals = [
      ['H-A', 'OPEN', 0.95, 30], ['H-B', 'OPEN', 0.85, 40], ['H-C', 'CLOSED', 0.70, 50], ['H-D', 'OPEN', 0.60, 60]
    ];
    for (const [id, status, rate, avg] of hospitals) {
      await admin.query(
        `INSERT INTO Hospital (hospital_id, hospital_name, address, location_lat, location_lng, contact_phone, emergency_status, acceptance_rate, avg_response_sec)
         VALUES (?, ?, 'Fictional Ave', 28.6, 77.2, '000', ?, ?, ?)`,
        [id, `Hospital ${id}`, status, rate, avg]
      );
    }
    const capacities = {
      'H-A': { ICU_BED: 1, VENTILATOR: 2, OT: 1 }, 'H-B': { ICU_BED: 2, VENTILATOR: 2, OT: 1 },
      'H-C': { ICU_BED: 5, VENTILATOR: 5, OT: 1 }, 'H-D': { ICU_BED: 3, VENTILATOR: 3, OT: 1 }
    };
    for (const [hospital, types] of Object.entries(capacities)) {
      for (const [type, total] of Object.entries(types)) {
        await admin.query(
          'INSERT INTO MedicalResource (resource_id, hospital_id, resource_type, total_capacity, available_capacity) VALUES (?, ?, ?, ?, ?)',
          [`RES-${hospital}-${type}`, hospital, type, total, total]
        );
      }
    }
    for (const [id, hospital, spec, availability] of [
      ['DOC-A', 'H-A', 'CARDIOLOGIST', 'AVAILABLE'], ['DOC-B', 'H-B', 'CARDIOLOGIST', 'OFF_DUTY'], ['DOC-D', 'H-D', 'CARDIOLOGIST', 'AVAILABLE']
    ]) {
      await admin.query('INSERT INTO Doctor (doctor_id, hospital_id, full_name, specialization, availability_status) VALUES (?, ?, ?, ?, ?)',
        [id, hospital, `Dr ${id}`, spec, availability]);
    }
    for (const [id, hospital] of [['AMB-A', 'H-A'], ['AMB-B', 'H-B']]) {
      await admin.query("INSERT INTO Ambulance (ambulance_id, hospital_id, vehicle_number, ambulance_type, status) VALUES (?, ?, ?, 'ALS', 'AVAILABLE')",
        [id, hospital, `VEH-${id}`]);
    }
    await admin.query("INSERT INTO Patient (patient_id, full_name, age, emergency_type) VALUES ('PAT-T', 'Fictional Patient', 40, 'CARDIAC')");
  }

  async function makeRequest({ status = 'WAITING', specialist = null, types = ['ICU_BED'] } = {}) {
    const id = `REQ-T-${++seq}`;
    await admin.query(
      "INSERT INTO EmergencyRequest (request_id, patient_id, emergency_type, required_resources, required_specialist, priority, status) VALUES (?, 'PAT-T', 'CARDIAC', ?, ?, 1, ?)",
      [id, JSON.stringify(types), specialist, status]
    );
    return id;
  }

  const one = async (sql, params = []) => (await admin.query(sql, params))[0][0];
  const resource = (hospital, type) => one('SELECT available_capacity AS available, locked_capacity AS locked FROM MedicalResource WHERE hospital_id = ? AND resource_type = ?', [hospital, type]);
  const requestStatus = async id => (await one('SELECT status FROM EmergencyRequest WHERE request_id = ?', [id])).status;
  const count = async (sql, params) => Number((await one(sql, params)).n);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  test.beforeEach(reset);

  // ── Mutual exclusion under real parallel connections ─────────────────────
  test('50 parallel requests competing for 1 ICU bed: exactly one lock, no deadlock, no leaked capacity', async () => {
    const ids = [];
    for (let i = 0; i < 50; i += 1) ids.push(await makeRequest());

    const results = await Promise.allSettled(ids.map(id => engine.acquireSoftLock('H-A', id, ['ICU_BED'])));

    const granted = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected');
    assert.equal(granted.length, 1);
    assert.equal(refused.length, 49);
    assert.ok(refused.every(r => r.reason instanceof LockError), `unexpected non-business errors: ${refused.filter(r => !(r.reason instanceof LockError)).map(r => r.reason.message)}`);
    assert.match(refused[0].reason.message, /No available ICU_BED/);

    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 1 });
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE status = 'PENDING'"), 1);
    assert.equal(await count("SELECT COUNT(*) n FROM ResourceAllocation WHERE status = 'LOCKED'"), 1);
    assert.equal(await count("SELECT COUNT(*) n FROM EmergencyRequest WHERE status = 'MATCHING'"), 1);
  });

  test('compound claims (ICU + ventilator) race without deadlock and never leave a half-held claim', async () => {
    await admin.query("UPDATE MedicalResource SET total_capacity = 3, available_capacity = 3 WHERE hospital_id = 'H-B' AND resource_type = 'ICU_BED'");
    await admin.query("UPDATE MedicalResource SET total_capacity = 2, available_capacity = 2 WHERE hospital_id = 'H-B' AND resource_type = 'VENTILATOR'");
    const ids = [];
    for (let i = 0; i < 24; i += 1) ids.push(await makeRequest({ types: ['ICU_BED', 'VENTILATOR'] }));

    // Half the callers list the types in the opposite order: the engine's sorted lock order must absorb that.
    const results = await Promise.allSettled(ids.map((id, i) =>
      engine.acquireSoftLock('H-B', id, i % 2 ? ['VENTILATOR', 'ICU_BED'] : ['ICU_BED', 'VENTILATOR'])));

    const refused = results.filter(r => r.status === 'rejected');
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2, 'limited by the scarcer resource (2 ventilators)');
    assert.ok(refused.every(r => r.reason instanceof LockError));
    assert.deepEqual(await resource('H-B', 'VENTILATOR'), { available: 2, locked: 2 });
    assert.deepEqual(await resource('H-B', 'ICU_BED'), { available: 3, locked: 2 }, 'losers must not hold an ICU bed');
  });

  test('one request cannot hold two locks even when raced from many connections', async () => {
    const id = await makeRequest();
    const hospitals = ['H-A', 'H-B', 'H-D', 'H-A', 'H-B', 'H-D', 'H-A', 'H-B'];
    const results = await Promise.allSettled(hospitals.map(h => engine.acquireSoftLock(h, id, ['ICU_BED'])));

    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => /already has an active referral lock/.test(r.reason.message)));
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 1);
    const [a, b, d] = await Promise.all(['H-A', 'H-B', 'H-D'].map(h => resource(h, 'ICU_BED')));
    assert.equal(a.locked + b.locked + d.locked, 1);
  });

  test('a row lock held by another session really blocks acquisition until it is released (FOR UPDATE)', async () => {
    const id = await makeRequest();
    const holder = await pool.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query("SELECT resource_id FROM MedicalResource WHERE hospital_id = 'H-A' AND resource_type = 'ICU_BED' FOR UPDATE");

      let settled = false;
      const pending = engine.acquireSoftLock('H-A', id, ['ICU_BED']).finally(() => { settled = true; });
      await sleep(400);
      assert.equal(settled, false, 'acquire must wait for the row lock, not read around it');

      await holder.commit();
      const lock = await pending;
      assert.equal(lock.status, 'PENDING');
    } finally {
      holder.release();
    }
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 1 });
  });

  // ── Commit ────────────────────────────────────────────────────────────────
  test('accept commits atomically: capacity, allocations, request status, ambulance, audit', async () => {
    const id = await makeRequest({ types: ['ICU_BED', 'VENTILATOR'] });
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED', 'VENTILATOR']);
    const result = await engine.commitAllocation(lock.acceptanceId, 'DESK-A');

    assert.equal(result.status, 'ACCEPTED');
    assert.equal(result.ambulance_id, 'AMB-A', 'the unit stationed at the accepting hospital is preferred');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 0, locked: 0 });
    assert.deepEqual(await resource('H-A', 'VENTILATOR'), { available: 1, locked: 0 });
    assert.equal(await requestStatus(id), 'ALLOCATED');
    assert.equal(await count("SELECT COUNT(*) n FROM ResourceAllocation WHERE request_id = ? AND status = 'COMMITTED'", [id]), 2);
    const unit = await one("SELECT status, assigned_request_id, destination_hospital_id FROM Ambulance WHERE ambulance_id = 'AMB-A'");
    assert.deepEqual({ ...unit }, { status: 'DISPATCHED', assigned_request_id: id, destination_hospital_id: 'H-A' });
    const acceptance = await one('SELECT status, response_time_sec FROM HospitalAcceptance WHERE acceptance_id = ?', [lock.acceptanceId]);
    assert.equal(acceptance.status, 'ACCEPTED');
    assert.ok(acceptance.response_time_sec >= 0 && acceptance.response_time_sec <= 5);
    const events = (await admin.query('SELECT event_type FROM EmergencyHistory WHERE request_id = ? ORDER BY history_id', [id]))[0].map(r => r.event_type);
    assert.deepEqual(events, ['LOCK_ACQUIRED', 'ALLOCATION_COMMITTED']);
  });

  test('two concurrent accepts of the same lock: one wins, capacity and ambulance are consumed once', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => engine.commitAllocation(lock.acceptanceId)));

    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason instanceof LockError));
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 0, locked: 0 });
    assert.equal(await count("SELECT COUNT(*) n FROM Ambulance WHERE assigned_request_id = ?", [id]), 1);
    assert.equal(await count("SELECT COUNT(*) n FROM ResourceAllocation WHERE request_id = ? AND status = 'COMMITTED'", [id]), 1);
  });

  test('simultaneous accepts for different requests never hand out the same ambulance', async () => {
    await admin.query("UPDATE MedicalResource SET total_capacity = 6, available_capacity = 6 WHERE hospital_id = 'H-B' AND resource_type = 'ICU_BED'");
    const locks = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await makeRequest();
      locks.push(await engine.acquireSoftLock('H-B', id, ['ICU_BED']));
    }
    const results = await Promise.all(locks.map(l => engine.commitAllocation(l.acceptanceId)));

    const assigned = results.map(r => r.ambulance_id).filter(Boolean);
    assert.equal(new Set(assigned).size, assigned.length, 'no ambulance assigned twice');
    assert.equal(assigned.length, 2, 'only two units exist; the rest of the cases get none');
    assert.equal(await count("SELECT COUNT(*) n FROM Ambulance WHERE assigned_request_id IS NOT NULL"), 2);
  });

  // ── Cancel / complete ─────────────────────────────────────────────────────
  test('cancelling a pending referral releases the lock atomically; accepting afterwards is refused', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);

    const closed = await engine.closeRequest(id, 'CANCELLED');

    assert.deepEqual(closed.cancelledLocks, [lock.acceptanceId]);
    assert.equal(await requestStatus(id), 'CANCELLED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.equal((await one('SELECT status FROM HospitalAcceptance WHERE acceptance_id = ?', [lock.acceptanceId])).status, 'CANCELLED');
    await assert.rejects(engine.commitAllocation(lock.acceptanceId), LockError);
    assert.equal(await requestStatus(id), 'CANCELLED');
  });

  test('concurrent cancel and accept never leave the request ALLOCATED or capacity leaked (30 interleavings)', async () => {
    for (let round = 0; round < 30; round += 1) {
      const id = await makeRequest();
      const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
      const accept = async () => { await sleep(Math.random() * 4); return engine.commitAllocation(lock.acceptanceId); };
      const cancel = async () => { await sleep(Math.random() * 4); return engine.closeRequest(id, 'CANCELLED'); };

      // Start both at once, alternating which one is issued first; track each outcome by name.
      const jobs = { accept, cancel };
      const outcomes = {};
      await Promise.all((round % 2 ? ['accept', 'cancel'] : ['cancel', 'accept']).map(async name => {
        [outcomes[name]] = await Promise.allSettled([jobs[name]()]);
      }));
      assert.equal(outcomes.cancel.status, 'fulfilled', `round ${round}: cancelling must always succeed`);
      assert.ok(outcomes.accept.status === 'fulfilled' || outcomes.accept.reason instanceof LockError, `round ${round}`);

      assert.equal(await requestStatus(id), 'CANCELLED', `round ${round}`);
      assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 }, `round ${round}: capacity restored`);
      assert.equal(await count("SELECT COUNT(*) n FROM ResourceAllocation WHERE request_id = ? AND status IN ('LOCKED','COMMITTED')", [id]), 0, `round ${round}`);
      assert.equal(await count('SELECT COUNT(*) n FROM Ambulance WHERE assigned_request_id = ?', [id]), 0, `round ${round}: ambulance freed`);
      assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 0, `round ${round}`);
    }
  });

  test('a cancelled request cannot acquire a new lock, and a missing request is refused', async () => {
    const cancelled = await makeRequest({ status: 'CANCELLED' });
    await assert.rejects(engine.acquireSoftLock('H-A', cancelled, ['ICU_BED']), /CANCELLED/);
    await assert.rejects(engine.acquireSoftLock('H-A', 'REQ-DOES-NOT-EXIST', ['ICU_BED']), /not found/);
    await assert.rejects(engine.acquireSoftLock('H-A', cancelled, ['TELEPORTER']), /Unsupported resource/);
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
  });

  test('completing an allocated request returns resources and frees the ambulance in one step', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    await engine.commitAllocation(lock.acceptanceId);
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 0, locked: 0 });

    await engine.closeRequest(id, 'COMPLETED');

    assert.equal(await requestStatus(id), 'COMPLETED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.equal(await count("SELECT COUNT(*) n FROM ResourceAllocation WHERE request_id = ? AND status = 'RELEASED'", [id]), 1);
    assert.equal((await one("SELECT status FROM Ambulance WHERE ambulance_id = 'AMB-A'")).status, 'AVAILABLE');
    // Closing twice is an idempotent no-op: it must not release capacity a second time.
    const again = await engine.closeRequest(id, 'COMPLETED');
    assert.equal(again.unchanged, true);
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    // ...and a different terminal move from a finished request is a lifecycle violation.
    await assert.rejects(engine.closeRequest(id, 'CANCELLED'), /Invalid lifecycle transition/);
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
  });

  test('invalid close transitions are refused and change nothing', async () => {
    const id = await makeRequest({ status: 'WAITING' });
    await assert.rejects(engine.closeRequest(id, 'COMPLETED'), /Invalid lifecycle transition/);
    await assert.rejects(engine.closeRequest(id, 'ALLOCATED'), /only handles/);
    assert.equal(await requestStatus(id), 'WAITING');
  });

  // ── Reject + failover ─────────────────────────────────────────────────────
  test('rejection fails over to the next suitable hospital (closed hospitals are skipped)', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);

    const result = await engine.rejectAndFailover(lock.acceptanceId, 'No capacity');

    assert.equal(result.status, 'REJECTED');
    assert.equal(result.next_hospital_id, 'H-B', 'H-C is CLOSED, H-B has the better rate than H-D');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.deepEqual(await resource('H-B', 'ICU_BED'), { available: 2, locked: 1 });
    assert.equal(await requestStatus(id), 'MATCHING');
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 1);
  });

  test('failover respects the required specialist and never retries a hospital that already declined', async () => {
    const id = await makeRequest({ specialist: 'CARDIOLOGIST' });
    const first = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);

    const second = await engine.rejectAndFailover(first.acceptanceId, 'No capacity');
    assert.equal(second.next_hospital_id, 'H-D', 'H-B has its cardiologist off duty, H-C is closed');

    const third = await engine.rejectAndFailover(second.next_acceptance_id, 'No capacity');
    assert.equal(third.next_acceptance_id, null, 'nobody suitable is left (H-A already declined)');
    assert.equal(await requestStatus(id), 'WAITING');
    assert.equal(await count("SELECT COUNT(*) n FROM MedicalResource WHERE locked_capacity <> 0"), 0);
  });

  // ── TTL expiry ────────────────────────────────────────────────────────────
  test('an expired lock cannot be accepted; the sweeper releases it and fails over', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    assert.equal(await engine.expireStaleLocks(), 0, 'a fresh lock is not touched');

    await admin.query("UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 5 SECOND WHERE acceptance_id = ?", [lock.acceptanceId]);
    await assert.rejects(engine.commitAllocation(lock.acceptanceId), /expired/);

    assert.equal(await engine.expireStaleLocks(), 1);
    assert.equal((await one('SELECT status FROM HospitalAcceptance WHERE acceptance_id = ?', [lock.acceptanceId])).status, 'EXPIRED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.equal(await requestStatus(id), 'MATCHING');
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND hospital_id = 'H-B' AND status = 'PENDING'", [id]), 1);
    assert.equal(await engine.expireStaleLocks(), 0, 'sweeping again is a no-op (no double release)');
  });

  test('expiry after the case was cancelled releases capacity but cannot revive the case', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    // Simulate a cancellation whose lock cleanup never ran: only the status changed.
    await admin.query("UPDATE EmergencyRequest SET status = 'CANCELLED' WHERE request_id = ?", [id]);
    await admin.query("UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 5 SECOND WHERE acceptance_id = ?", [lock.acceptanceId]);

    assert.equal(await engine.expireStaleLocks(), 1);

    assert.equal(await requestStatus(id), 'CANCELLED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 0);
  });

  test('accepting a request whose status was set to CANCELLED outside the engine is refused and frees the lock', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    await admin.query("UPDATE EmergencyRequest SET status = 'CANCELLED' WHERE request_id = ?", [id]);

    await assert.rejects(engine.commitAllocation(lock.acceptanceId), /CANCELLED/);

    assert.equal(await requestStatus(id), 'CANCELLED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
    assert.equal((await one('SELECT status FROM HospitalAcceptance WHERE acceptance_id = ?', [lock.acceptanceId])).status, 'CANCELLED');
    assert.equal(await count('SELECT COUNT(*) n FROM ResourceAllocation WHERE request_id = ? AND status = ?', [id, 'COMMITTED']), 0);
  });

  test('active locks report a countdown from the database clock', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const active = await engine.getActiveLocks();
    assert.equal(active.length, 1);
    assert.equal(active[0].acceptanceId, lock.acceptanceId);
    assert.ok(active[0].remainingSec >= 88 && active[0].remainingSec <= 90, `got ${active[0].remainingSec}`);
  });

  // ── Failover after a committed rejection / expiry ─────────────────────────
  // The rejection commits first and failover runs afterwards, in its own transactions. Whatever happens
  // in between (a crash, a lost connection, a competing referral) must leave a valid, recoverable state.
  test('a failover that dies after the rejection committed leaves the case re-queued, not stuck in MATCHING', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const original = engine._failover;
    engine._failover = async () => { throw new Error('connection lost'); };
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await engine.rejectAndFailover(lock.acceptanceId, 'No capacity');
    } finally {
      engine._failover = original;
      console.error = originalError;
    }

    assert.equal(result.status, 'REJECTED', 'the rejection is committed, so it must be reported as such');
    assert.equal(result.next_acceptance_id, null);
    assert.equal(await requestStatus(id), 'WAITING', 'no pending referral, so the case is back in the queue');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 0 });
  });

  test('a referral placed while failover is running is not overwritten back to WAITING', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const original = engine._failover;
    // A paramedic re-initiates at H-B in the window between the rejection commit and the failover.
    engine._failover = async (...args) => {
      await engine.acquireSoftLock('H-B', id, ['ICU_BED']);
      return original.apply(engine, args);
    };
    try {
      await engine.rejectAndFailover(lock.acceptanceId, 'No capacity');
    } finally {
      engine._failover = original;
    }

    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 1);
    assert.equal(await requestStatus(id), 'MATCHING', 'a case with a pending referral must be MATCHING');
  });

  test('an expiry whose failover dies leaves the case re-queued, and the sweeper still counts it', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    await admin.query('UPDATE HospitalAcceptance SET lock_expires_at = NOW() - INTERVAL 5 SECOND WHERE acceptance_id = ?', [lock.acceptanceId]);
    const original = engine._failover;
    engine._failover = async () => { throw new Error('connection lost'); };
    const originalError = console.error;
    console.error = () => {};
    let expired;
    try {
      expired = await engine.expireStaleLocks();
    } finally {
      engine._failover = original;
      console.error = originalError;
    }
    assert.equal(expired, 1);
    assert.equal(await requestStatus(id), 'WAITING');
    assert.equal((await one('SELECT status FROM HospitalAcceptance WHERE acceptance_id = ?', [lock.acceptanceId])).status, 'EXPIRED');
  });

  // ── Listener failures after commit ────────────────────────────────────────
  // Events fire only once the transaction is durable, so a throwing listener must not
  // turn a committed operation into a reported failure (the caller would retry or give up).
  async function withThrowingListener(event, fn, filter = () => true) {
    const boom = payload => { if (filter(payload)) throw new Error(`${event} listener failed`); };
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    engine.on(event, boom);
    try {
      return { result: await fn(), logged };
    } finally {
      engine.off(event, boom);
      console.error = originalError;
    }
  }

  test('a throwing listener after a committed accept still reports the allocation', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const { result, logged } = await withThrowingListener('allocation_committed', () => engine.commitAllocation(lock.acceptanceId));

    assert.equal(result.status, 'ACCEPTED');
    assert.equal(await requestStatus(id), 'ALLOCATED');
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 0, locked: 0 });
    assert.ok(logged.some(line => /listener failed after commit/.test(line)), 'the failure must be logged, not hidden');
  });

  test('a throwing audit listener does not fail an acquisition that committed', async () => {
    const id = await makeRequest();
    const { result } = await withThrowingListener('audit', () => engine.acquireSoftLock('H-A', id, ['ICU_BED']));

    assert.ok(result.acceptanceId);
    assert.deepEqual(await resource('H-A', 'ICU_BED'), { available: 1, locked: 1 });
    assert.equal(await count("SELECT COUNT(*) n FROM HospitalAcceptance WHERE request_id = ? AND status = 'PENDING'", [id]), 1);
  });

  test('a throwing lock_acquired listener during failover still reports the rejection and next hospital', async () => {
    const id = await makeRequest();
    const lock = await engine.acquireSoftLock('H-A', id, ['ICU_BED']);
    const { result } = await withThrowingListener('lock_acquired', () => engine.rejectAndFailover(lock.acceptanceId, 'No capacity'));

    assert.equal(result.status, 'REJECTED');
    assert.equal(result.next_hospital_id, 'H-B');
    assert.deepEqual(await resource('H-B', 'ICU_BED'), { available: 2, locked: 1 });
    assert.equal(await requestStatus(id), 'MATCHING');
  });
}
