// Unit tests for the lock-order checker (server/services/lockOrder.js). Each rule is shown to ACCEPT the
// orders our code uses and to REJECT a deliberate violation, so a clean run elsewhere is meaningful.
// The checker is also run over every contract scenario (tests/contract_*.test.js) on both backends.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LockOrderChecker, classifyStatement, instrumentMysqlPool,
  installMemoryLockOrderChecker, runInLockScope, noteLockAcquired, noteLockReleased, memoryLockOrderActive
} from '../server/services/lockOrder.js';

test('ascending ranks are accepted; a lower rank after a higher one is a RANK violation', () => {
  const checker = new LockOrderChecker();
  const ok = checker.begin('ok');
  for (const table of ['EmergencyRequest', 'Hospital', 'Doctor', 'MedicalResource', 'Ambulance']) checker.acquire(ok, table);
  assert.equal(checker.violations.length, 0);

  const bad = checker.begin('bad');
  checker.acquire(bad, 'MedicalResource');
  const violation = checker.acquire(bad, 'EmergencyRequest');
  assert.equal(violation.kind, 'RANK');
  assert.equal(violation.after, 'MedicalResource');
  assert.match(checker.describe(), /locked EmergencyRequest \(rank 10\) after MedicalResource \(rank 50\)/);
});

test('re-locking a table the scope already holds is accepted (e.g. UPDATE of the locked request row)', () => {
  const checker = new LockOrderChecker();
  const scope = checker.begin();
  checker.acquire(scope, 'EmergencyRequest');
  checker.acquire(scope, 'MedicalResource');
  checker.acquire(scope, 'EmergencyRequest');
  assert.equal(checker.violations.length, 0);
});

test('case-owned rows need the case lock, and do not constrain the locks that follow', () => {
  const checker = new LockOrderChecker();
  const withCase = checker.begin('with case');
  checker.acquire(withCase, 'EmergencyRequest');
  checker.acquire(withCase, 'MedicalResource');
  checker.acquire(withCase, 'ResourceAllocation');
  checker.acquire(withCase, 'Ambulance'); // after a case-owned row: still fine
  checker.acquire(withCase, 'HospitalAcceptance');
  assert.equal(checker.violations.length, 0);

  const withoutCase = checker.begin('without case');
  const violation = checker.acquire(withoutCase, 'HospitalAcceptance');
  assert.equal(violation.kind, 'OWNED');
});

test('within one rank, known keys must ascend (MedicalResource rows by resource_type)', () => {
  const checker = new LockOrderChecker();
  const ok = checker.begin();
  checker.acquire(ok, 'MedicalResource', { key: 'ICU_BED' });
  checker.acquire(ok, 'MedicalResource', { key: 'VENTILATOR' });
  assert.equal(checker.violations.length, 0);

  const bad = checker.begin();
  checker.acquire(bad, 'MedicalResource', { key: 'VENTILATOR' });
  assert.equal(checker.acquire(bad, 'MedicalResource', { key: 'ICU_BED' }).kind, 'KEY');
});

test('locks that never wait (SKIP LOCKED / NOWAIT) are recorded but never reported', () => {
  const checker = new LockOrderChecker();
  const scope = checker.begin();
  checker.acquire(scope, 'Ambulance');
  checker.acquire(scope, 'MedicalResource', { noWait: true });
  assert.equal(checker.violations.length, 0);
});

test('released locks no longer constrain the scope', () => {
  const checker = new LockOrderChecker();
  const scope = checker.begin();
  checker.acquire(scope, 'MedicalResource', { key: 'OT' });
  checker.release(scope, 'MedicalResource', 'OT');
  checker.acquire(scope, 'EmergencyRequest');
  assert.equal(checker.violations.length, 0);
});

test('classifyStatement: locking reads, UPDATE and DELETE count; plain reads, INSERT and SET do not', () => {
  assert.deepEqual(classifyStatement('SELECT status FROM EmergencyRequest WHERE request_id = ? FOR UPDATE'), { table: 'EmergencyRequest', noWait: false });
  assert.deepEqual(classifyStatement('SELECT emergency_status FROM Hospital WHERE hospital_id = ? FOR SHARE'), { table: 'Hospital', noWait: false });
  assert.deepEqual(classifyStatement(`SELECT ambulance_id FROM Ambulance WHERE status = 'AVAILABLE'
    ORDER BY ambulance_id LIMIT 1 FOR UPDATE SKIP LOCKED`), { table: 'Ambulance', noWait: true });
  assert.deepEqual(classifyStatement('UPDATE MedicalResource SET locked_capacity = locked_capacity + 1 WHERE resource_id = ?'), { table: 'MedicalResource', noWait: false });
  assert.deepEqual(classifyStatement('DELETE FROM Doctor WHERE doctor_id = ?'), { table: 'Doctor', noWait: false });
  assert.equal(classifyStatement('SELECT * FROM Hospital WHERE hospital_id = ?'), null);
  assert.equal(classifyStatement('INSERT INTO EmergencyHistory (event_type) VALUES (?)'), null);
  assert.equal(classifyStatement('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'), null);
});

test('instrumentMysqlPool checks statements inside a transaction only, and passes everything through', async () => {
  const issued = [];
  const fakeConnection = {
    marker: 'conn',
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    async query(sql) { issued.push(sql); return [[]]; },
    release() { issued.push('release'); }
  };
  const fakePool = { async getConnection() { return fakeConnection; }, async query(sql) { issued.push(`pool:${sql}`); return [[]]; }, async end() { issued.push('end'); } };
  const checker = new LockOrderChecker();
  const pool = instrumentMysqlPool(fakePool, checker);

  const conn = await pool.getConnection();
  assert.equal(conn.marker, 'conn');
  conn.pendingAudits = []; // engines attach state to the connection: the proxy must allow it
  assert.deepEqual(conn.pendingAudits, []);
  await conn.query('UPDATE MedicalResource SET x = 1 WHERE resource_id = ?'); // autocommit: not checked
  await conn.beginTransaction();
  await conn.query('SELECT 1 FROM MedicalResource WHERE resource_id = ? FOR UPDATE');
  await conn.query('SELECT 1 FROM EmergencyRequest WHERE request_id = ? FOR UPDATE'); // violation
  await conn.commit();
  await conn.query('SELECT 1 FROM EmergencyRequest WHERE request_id = ? FOR UPDATE'); // after commit: not checked
  conn.release();
  await pool.query('SELECT 1');
  await pool.end();

  assert.equal(checker.violations.length, 1);
  assert.equal(checker.violations[0].table, 'EmergencyRequest');
  assert.match(checker.violations[0].source, /FROM EmergencyRequest/);
  assert.ok(issued.includes('release') && issued.includes('pool:SELECT 1') && issued.includes('end'));
});

test('in-memory adapter: inactive until installed; scopes follow each async operation separately', async () => {
  assert.equal(memoryLockOrderActive(), false);
  noteLockAcquired('MedicalResource', 'X'); // no checker installed: ignored

  const checker = new LockOrderChecker();
  const uninstall = installMemoryLockOrderChecker(checker);
  try {
    assert.equal(memoryLockOrderActive(), true);
    // Two concurrent, individually correct operations interleave without being confused for one another.
    const op = (label, delayFirst) => runInLockScope(label, async () => {
      noteLockAcquired('EmergencyRequest', label);
      if (delayFirst) await new Promise(resolve => setImmediate(resolve));
      noteLockAcquired('MedicalResource', 'ICU_BED');
      noteLockReleased('MedicalResource', 'ICU_BED');
      noteLockReleased('EmergencyRequest', label);
    });
    await Promise.all([op('a', true), op('b', false)]);
    assert.equal(checker.violations.length, 0, checker.describe());

    // A deliberate violation inside one scope is caught.
    await runInLockScope('bad', async () => {
      noteLockAcquired('MedicalResource', 'OT');
      noteLockAcquired('EmergencyRequest', 'REQ-X');
    });
    assert.equal(checker.violations.length, 1);
    assert.equal(checker.violations[0].scope, 'bad');
  } finally {
    uninstall();
  }
  assert.equal(memoryLockOrderActive(), false);
});
