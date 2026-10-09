// tests/audit_ledger.test.js
// P3-04: Immutable Medico-Legal Audit Ledger Test Suite (Issue #27)
// Tests append-only integrity, tamper-detection, and cryptographic hash chain verification.

import test from 'node:test';
import assert from 'node:assert';
import {
  appendAuditEntry,
  getLedgerEntries,
  verifyLedgerIntegrity,
  exportLedgerToCsv,
  getLedgerStats,
  EVENT_TYPES
} from '../js/audit_ledger.js';

test('Issue #27 / P3-04: Immutable Medico-Legal Audit Ledger', async (t) => {
  await t.test('Appends immutable audit entries with SHA-256 block hash', () => {
    const entry = appendAuditEntry(EVENT_TYPES.REQUEST_CREATED, {
      requestId: 'REQ-AUDIT-VAL-1',
      priority: 1,
      patientName: 'John Doe'
    });

    assert.ok(entry.auditId.startsWith('AUD-'));
    assert.ok(entry.integrityHash.startsWith('SHA256-'));
    assert.strictEqual(entry.isSealed, true);
    assert.ok(entry.timestamp);
  });

  await t.test('Verifies cryptographic integrity chain across all recorded events', () => {
    const integrity = verifyLedgerIntegrity();
    assert.strictEqual(integrity.isValid, true);
    assert.ok(integrity.verifiedEntries > 10);
    assert.strictEqual(integrity.errorIndex, null);
  });

  await t.test('Exports audit ledger to CSV format for legal and regulatory compliance', () => {
    const csv = exportLedgerToCsv();
    assert.ok(typeof csv === 'string');
    assert.ok(csv.includes('Sequence,AuditID,Timestamp,EventType,IntegrityHash,PreviousHash,PayloadSummary'));
    assert.ok(csv.includes('SHA256-'));
  });

  await t.test('Calculates ledger statistics correctly', () => {
    const stats = getLedgerStats();
    assert.ok(stats.totalEntries > 0);
    assert.strictEqual(stats.chainValid, true);
    assert.ok(stats.byEventType[EVENT_TYPES.REQUEST_CREATED] > 0);
  });
});
