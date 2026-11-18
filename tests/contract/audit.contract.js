// Audit hash chain contract (Phase 3 Step 5, approved direction AC), run unchanged against the in-memory store
// (tests/contract_memory.test.js) and the MySQL store (tests/contract_mysql.test.js).
//
// AC1-3/AC8: a full case lifecycle yields a continuous, valid chain whose head matches the last row.
// AC7: concurrent writers keep chain_seq continuous and the chain valid.
// AC5: a failed transaction leaves no orphaned rows, no gap and an unchanged head (MySQL: after its rows and the
//      head move were already written, at tx:beforeCommit; in memory: before its commit point).
// AC6: tampering with the stored ledger (payload, prev_hash, chain_seq, deleted middle row, cut tail) is detected
//      at the exact record. Review round 1: an edited displayed event_time (A2), an unchained row written after the
//      chain began (A3), and the listAudit tie order (S2). Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmergencyRequirements } from '../../server/services/emergencyRequirements.js';
import { GENESIS_HASH } from '../../server/services/auditChain.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'U-CONTRACT-EMS' };
const ADMIN = { role: 'ADMIN', id: 'U-CONTRACT-ADMIN' };
const DESK = 'U-CONTRACT-DESK-A';

export function registerAuditContract(b) {
  const label = name => `[${b.name}] audit chain: ${name}`;
  test.beforeEach(() => b.reset());
  test.afterEach(() => {
    b.hooks.clear();
    assert.equal(b.checker.violations.length, 0, `lock-order violations:\n${b.checker.describe()}`);
  });

  async function newCase(type = 'RESPIRATORY') {
    const req = resolveEmergencyRequirements(type);
    const created = await b.store.createRequest({
      patient: { full_name: 'Fictional Audit Patient', age: 44, gender: 'UNKNOWN', emergency_type: type, triage_priority: 2, contact_phone: null },
      request: { emergency_type: type, required_resource_types: req.resourceTypes, required_specialist: req.specialist, priority: 2, pickup_lat: null, pickup_lng: null, clinical_notes: '' }
    }, PARAMEDIC);
    return created.request_id;
  }
  const capacity = async (hospitalId, n) => {
    for (const type of ['ICU_BED', 'VENTILATOR']) await b.setCapacity(hospitalId, type, { total: n });
  };
  const lockAt = (h, id) => b.store.acquireReferralLock(h, id, ['ICU_BED', 'VENTILATOR']);
  async function lifecycle() {
    await capacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    await b.store.commitReferral(lock.acceptanceId, DESK);
    await b.store.transitionRequestStatus(id, 'IN_TREATMENT', ADMIN);
    await b.store.transitionRequestStatus(id, 'COMPLETED', ADMIN);
    return id;
  }

  test(label('a full case lifecycle produces a continuous, valid chain whose head is the last row'), async () => {
    const id = await lifecycle();
    const rows = await b.chainRows();
    assert.ok(rows.length >= 5, `expected at least create, lock, accept and two transitions; got ${rows.length}`);
    assert.deepEqual(rows.map(r => Number(r.chain_seq)), rows.map((_, i) => i + 1), 'chain_seq 1..n, no gap');
    assert.equal(rows[0].prev_hash, GENESIS_HASH);
    const events = rows.filter(r => r.request_id === id).map(r => r.event_type);
    for (const e of ['REQUEST_CREATED', 'LOCK_ACQUIRED', 'ALLOCATION_COMMITTED', 'STATUS_CHANGED']) assert.ok(events.includes(e), `${e} is chained`);
    const v = await b.store.verifyAuditChain();
    assert.equal(v.valid, true, JSON.stringify(v.first_break));
    assert.equal(v.checked, rows.length);
    assert.deepEqual(v.head, { chain_seq: rows.length, hash: rows.at(-1).row_hash }, 'the head is reported for a future checkpoint (AC10)');
    assert.equal(v.legacy_unchained, 0);
  });

  test(label('concurrent writers keep the sequence continuous and the chain valid, and none of them fails (AC7)'), async () => {
    await capacity('H-A', 8);
    await capacity('H-B', 8); // enough for all 16: any failure below is a concurrency defect, not a refusal
    const ids = await Promise.all(Array.from({ length: 16 }, () => newCase()));
    const locks = await Promise.allSettled(ids.map((id, i) => lockAt(i % 2 ? 'H-A' : 'H-B', id)));
    assert.deepEqual(locks.filter(l => l.status === 'rejected').map(l => l.reason.message), [], 'every concurrent referral succeeds');
    const commits = await Promise.allSettled(locks.map(l => b.store.commitReferral(l.value.acceptanceId, DESK)));
    assert.deepEqual(commits.filter(c => c.status === 'rejected').map(c => c.reason.message), [], 'every concurrent accept succeeds');
    const rows = await b.chainRows();
    const count = type => rows.filter(r => r.event_type === type).length;
    assert.deepEqual([count('REQUEST_CREATED'), count('LOCK_ACQUIRED'), count('ALLOCATION_COMMITTED')], [16, 16, 16], 'exactly one row per operation');
    assert.deepEqual(rows.map(r => Number(r.chain_seq)), rows.map((_, i) => i + 1));
    assert.equal(new Set(rows.map(r => r.row_hash)).size, rows.length, 'every row has its own hash');
    const v = await b.store.verifyAuditChain();
    assert.equal(v.valid, true, JSON.stringify(v.first_break));
    assert.equal(v.checked, rows.length);
  });

  test(label('a failed transaction leaves no rows, no gap and an unchanged head (AC5)'), async () => {
    await capacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const before = await b.chainRows();
    // MySQL: fail AFTER the transaction wrote its audit rows and moved the head (strongest case); memory: before commit.
    const point = b.name === 'mysql' ? 'tx:beforeCommit' : 'commit:requestLocked';
    b.hooks.once(point, () => { throw new Error('injected failure'); });
    await assert.rejects(b.store.commitReferral(lock.acceptanceId, DESK), /injected failure/);
    const after = await b.chainRows();
    assert.equal(after.length, before.length, 'no orphaned audit rows');
    const v = await b.store.verifyAuditChain();
    assert.equal(v.valid, true);
    assert.equal(v.head.chain_seq, before.length, 'the head did not move');
    await b.store.commitReferral(lock.acceptanceId, DESK); // the retry chains on with no gap
    const retried = await b.chainRows();
    assert.equal(Number(retried.at(-1).chain_seq), retried.length);
    assert.equal((await b.store.verifyAuditChain()).valid, true);
  });

  test(label('a deadlock retry after the audit rows were written rebuilds them from scratch: exactly one set (AC4)'), async () => {
    if (b.name !== 'mysql') return; // the in-memory backend has no transactions to retry
    await capacity('H-A', 2);
    const id = await newCase();
    const lock = await lockAt('H-A', id);
    const retries = [];
    b.hooks.on('tx:deadlockRetry', ctx => { retries.push(ctx); });
    // The first attempt has already chained and written its rows and moved the head when this fires.
    b.hooks.once('tx:beforeCommit', () => { throw Object.assign(new Error('injected deadlock'), { errno: 1213 }); });
    const accepted = await b.store.commitReferral(lock.acceptanceId, DESK);
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(retries.length, 1, 'the transaction was retried once');
    const rows = await b.chainRows();
    assert.equal(rows.filter(r => r.event_type === 'ALLOCATION_COMMITTED').length, 1, 'the failed attempt left no row, the retry wrote one');
    assert.deepEqual(rows.map(r => Number(r.chain_seq)), rows.map((_, i) => i + 1));
    assert.equal((await b.store.verifyAuditChain()).valid, true);
  });

  test(label('tampering with the stored ledger is detected at the exact record (AC6)'), async () => {
    await lifecycle();
    const rows = await b.chainRows();
    await b.tamperAudit(2, { new_state: 'TAMPERED' });
    let v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'ROW_HASH_MISMATCH', 2]);
    await b.tamperAudit(2, { new_state: rows[1].new_state }); // restore
    assert.equal((await b.store.verifyAuditChain()).valid, true);

    await b.tamperAudit(3, { metadata: { forged: true } });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['ROW_HASH_MISMATCH', 3]);
    await b.tamperAudit(3, { metadata: rows[2].metadata });

    await b.tamperAudit(4, { prev_hash: 'f'.repeat(64) });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['PREV_HASH_MISMATCH', 4]);
    await b.tamperAudit(4, { prev_hash: rows[3].prev_hash });
    assert.equal((await b.store.verifyAuditChain()).valid, true, 'restoring the exact values makes it valid again');

    await b.deleteAudit(3);
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['SEQUENCE_GAP', 4]);
  });

  test(label('sequence edits, reordered rows and an edited row_hash are detected at the exact record (AC6)'), async () => {
    await lifecycle();
    const rows = await b.chainRows();
    assert.ok(rows.length >= 5);
    const TEMP = 999999;
    const swapSeq = async (x, y) => { // via a temporary value: chain_seq is unique on MySQL
      await b.tamperAudit(x, { chain_seq: TEMP });
      await b.tamperAudit(y, { chain_seq: x });
      await b.tamperAudit(TEMP, { chain_seq: y });
    };

    // Sequence modification: row 3 renumbered -> the chain reads 1, 2, 4 ... so it breaks where 3 is missing.
    await b.tamperAudit(3, { chain_seq: TEMP });
    let v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'SEQUENCE_GAP', 4]);
    await b.tamperAudit(TEMP, { chain_seq: 3 });
    assert.equal((await b.store.verifyAuditChain()).valid, true);

    // Reordered rows: rows 2 and 3 swap places in the sequence. The row now at position 2 links to the old row 2,
    // not to row 1, so the first break is its prev_hash.
    await swapSeq(2, 3);
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'PREV_HASH_MISMATCH', 2]);
    await swapSeq(2, 3);
    assert.equal((await b.store.verifyAuditChain()).valid, true);

    // Reordered storage: the rows keep their numbers but swap storage positions (history_id).
    const [h2, h3] = [rows[1].history_id, rows[2].history_id];
    await b.tamperAudit(2, { history_id: TEMP });
    await b.tamperAudit(3, { history_id: h2 });
    await b.tamperAudit(2, { history_id: h3 });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'ORDER_MISMATCH', 3]);
    await b.tamperAudit(2, { history_id: TEMP });
    await b.tamperAudit(3, { history_id: h3 });
    await b.tamperAudit(2, { history_id: h2 });
    assert.equal((await b.store.verifyAuditChain()).valid, true);

    // An edited stored hash: the row no longer hashes to its own row_hash.
    await b.tamperAudit(2, { row_hash: 'a'.repeat(64) });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'ROW_HASH_MISMATCH', 2]);
  });

  test(label('an edited displayed event_time is EVENT_TIME_MISMATCH at that record, even by 1 ms (A2)'), async () => {
    await lifecycle();
    const before = await b.store.verifyAuditChain();
    assert.equal(before.valid, true, 'chained rows are written with event_time equal to event_time_ms');
    await b.shiftAuditEventTime(3, 3_600_000);
    let v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.first_break.reason, v.first_break.chain_seq], [false, 'EVENT_TIME_MISMATCH', 3]);
    await b.shiftAuditEventTime(3, -3_600_000);
    assert.equal((await b.store.verifyAuditChain()).valid, true, 'restoring the time makes it valid again');
    await b.shiftAuditEventTime(2, 1);
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['EVENT_TIME_MISMATCH', 2]);
    // A broken hash at an earlier record is still reported first.
    await b.tamperAudit(1, { new_state: 'TAMPERED' });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['ROW_HASH_MISMATCH', 1]);
  });

  test(label('unchained rows: before the chain they are legacy; one stored after the first chained row is UNCHAINED_ROW (A3)'), async () => {
    await b.insertUnchainedAudit('LEGACY_EVENT_1');
    await b.insertUnchainedAudit('LEGACY_EVENT_2');
    await b.markLegacy(); // MySQL: what migration 007 records when it runs on a database with pre-chain rows
    let v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.checked, v.legacy_unchained, v.unchained_after_chain], [true, 0, 2, 0], 'no chained row yet: all legacy');
    await lifecycle();
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.legacy_unchained, v.unchained_after_chain], [true, 2, 0], 'pre-chain rows only count as legacy');
    const forged = await b.insertUnchainedAudit('FORGED_UNCHAINED');
    v = await b.store.verifyAuditChain();
    assert.equal(v.valid, false);
    assert.deepEqual(v.first_break, { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: forged });
    assert.deepEqual([v.legacy_unchained, v.unchained_after_chain], [2, 1]);
    assert.ok(v.head.chain_seq >= 5, 'the chain itself verified: its head is still reported');
    // Precedence: a break inside the chain is reported before the unchained row.
    await b.tamperAudit(2, { new_state: 'TAMPERED' });
    v = await b.store.verifyAuditChain();
    assert.deepEqual([v.first_break.reason, v.first_break.chain_seq], ['ROW_HASH_MISMATCH', 2]);
  });

  test(label('MySQL: an unchained row slipped into an id gap is UNCHAINED_ROW, not legacy (A3, recorded legacy mark)'), async () => {
    if (b.name !== 'mysql') return; // memory appends only, so its rule is array position (docs/audit-chain.md)
    const legacy = await b.insertUnchainedAudit('LEGACY_EVENT');      // history_id 1
    await b.insertUnchainedAudit('LEGACY_EVENT', 10);                  // history_id 10: ids 2-9 are a gap
    await b.markLegacy();                                              // legacy = { max 10, count 2 }
    await b.skipHistoryIds(50);                                        // chained rows start at 50: ids 11-49 are a gap
    await lifecycle();
    const rows = await b.chainRows();
    assert.equal(Number(rows[0].history_id), 50);
    let v = await b.store.verifyAuditChain();
    assert.deepEqual([v.valid, v.legacy_unchained, v.unchained_after_chain], [true, 2, 0]);

    // Above the recorded legacy ids but below the first chained row: a "below the first chained row" rule calls it legacy.
    const above = await b.insertUnchainedAudit('FORGED_IN_GAP', 20);
    v = await b.store.verifyAuditChain();
    assert.deepEqual(v.first_break, { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: above });
    await b.admin.query('DELETE FROM EmergencyHistory WHERE history_id = ?', [above]);
    assert.equal((await b.store.verifyAuditChain()).valid, true);

    // Among the legacy ids themselves (a gap between 1 and 10): only the recorded count can tell.
    await b.insertUnchainedAudit('FORGED_IN_LEGACY_GAP', 5);
    v = await b.store.verifyAuditChain();
    assert.equal(v.valid, false);
    assert.deepEqual(v.first_break, { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: null, legacy_recorded: 2, legacy_found: 3 });
    // A deleted legacy row is the same mismatch the other way round.
    await b.admin.query('DELETE FROM EmergencyHistory WHERE history_id IN (5, ?)', [legacy]);
    v = await b.store.verifyAuditChain();
    assert.deepEqual(v.first_break, { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: null, legacy_recorded: 2, legacy_found: 1 });
  });

  test(label('both audit writers refuse non-scalar fields before writing, and store numbers as the same strings (A6)'), async () => {
    for (const entry of [{ event_type: 'BAD', new_state: true }, { event_type: 'BAD', actor_id: { id: 1 } }, { event_type: 'BAD', metadata: 'text' }]) {
      await assert.rejects(b.writeAudit(entry), err => err instanceof TypeError && /Audit (field|metadata)/.test(err.message), JSON.stringify(entry));
    }
    assert.equal((await b.chainRows()).length, 0, 'nothing was written');
    await b.writeAudit({ event_type: 'NUMERIC', hospital_id: 101, previous_state: 0, metadata: { n: 1 } });
    const [row] = await b.chainRows();
    assert.deepEqual([row.hospital_id, row.previous_state, row.new_state, row.actor_role], ['101', '0', null, 'SYSTEM']);
    assert.equal((await b.store.verifyAuditChain()).valid, true);
  });

  test(label('listAudit orders newest first and breaks event-time ties by history_id, newest first, on both stores (S2)'), async () => {
    const E = Date.UTC(2026, 1, 2, 6, 0, 0, 250);
    await b.insertAnalyticsFixture({ events: [
      { request_id: null, event_type: 'TIE_A', event_ms: E },
      { request_id: null, event_type: 'TIE_B', event_ms: E },
      { request_id: null, event_type: 'LATER', event_ms: E + 1 },
      { request_id: null, event_type: 'TIE_C', event_ms: E },
      { request_id: null, event_type: 'EARLIER', event_ms: E - 1 }
    ] });
    assert.deepEqual((await b.store.listAudit({})).map(e => e.event_type), ['LATER', 'TIE_C', 'TIE_B', 'TIE_A', 'EARLIER']);
    assert.deepEqual((await b.store.listAudit({ limit: 3 })).map(e => e.event_type), ['LATER', 'TIE_C', 'TIE_B']);
  });

  test(label('a cut-off tail: detected on MySQL against the stored head; in memory the head IS the last row (documented)'), async () => {
    await lifecycle();
    const rows = await b.chainRows();
    await b.deleteAudit(rows.length);
    const v = await b.store.verifyAuditChain();
    if (b.name === 'mysql') {
      assert.deepEqual([v.valid, v.first_break.reason], [false, 'HEAD_MISMATCH']);
      assert.equal(v.stored_head.chain_seq, rows.length);
    } else {
      assert.equal(v.valid, true, 'the in-memory demo store keeps no separate head, so a cut tail is not detectable there');
    }
  });
}
