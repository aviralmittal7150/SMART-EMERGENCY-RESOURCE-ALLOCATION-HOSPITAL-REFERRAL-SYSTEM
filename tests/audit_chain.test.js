// Audit hash chain (server/services/auditChain.js): canonical serialisation, SHA-256 row hashes, chaining and
// full-chain verification, including every tamper case of acceptance criterion AC6. Pure: no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, rowHash, chainEntries, verifyChain, verifyLedger, normalizeAuditEntry, GENESIS_HASH } from '../server/services/auditChain.js';

const entry = (i, extra = {}) => ({
  history_id: i, event_time_ms: 1762560000000 + i, request_id: `REQ-${i}`, hospital_id: i % 2 ? 'H-A' : null,
  event_type: 'STATUS_CHANGED', previous_state: 'WAITING', new_state: 'MATCHING', actor_role: 'ADMIN', actor_id: 'U-1',
  metadata: { step: i, nested: { z: 1, a: [i, null] } }, ...extra
});
const chain = n => chainEntries({ chain_seq: 0, hash: GENESIS_HASH }, Array.from({ length: n }, (_, i) => entry(i + 1)));

test('canonical JSON sorts keys at every level, keeps array order, drops undefined, rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, null] } }), '{"a":{"d":2,"e":[3,null]},"b":1}');
  assert.equal(canonicalJson({ y: [2, 1], x: 'é' }), canonicalJson({ x: 'é', y: [2, 1] }));
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
});

test('the row hash is the SHA-256 of the documented canonical form (value pinned, cross-checked with Python hashlib)', () => {
  const row = {
    chain_seq: 1, prev_hash: GENESIS_HASH, event_time_ms: 1762560000000, request_id: 'REQ-1', hospital_id: null,
    event_type: 'REQUEST_CREATED', previous_state: null, new_state: 'WAITING', actor_role: 'PARAMEDIC', actor_id: 'U-1',
    metadata: { b: 2, a: [1, { d: 4, c: 3 }] }
  };
  assert.equal(rowHash(row), 'c857e2ede63c43fcd5f5953de310c062a01a7df085a3a5301435055295d9e6e3');
  // A stored-and-reloaded copy (metadata as a JSON string, keys reordered, numbers as strings) hashes the same.
  assert.equal(rowHash({ ...row, chain_seq: '1', event_time_ms: '1762560000000', metadata: '{"a":[1,{"c":3,"d":4}],"b":2}' }), rowHash(row));
});

test('chaining: continuous sequence from the head, each prev_hash is the previous row_hash, head moves to the last row', () => {
  const { rows, head } = chain(4);
  assert.deepEqual(rows.map(r => r.chain_seq), [1, 2, 3, 4]);
  assert.equal(rows[0].prev_hash, GENESIS_HASH);
  for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].prev_hash, rows[i - 1].row_hash);
  assert.deepEqual(head, { chain_seq: 4, hash: rows[3].row_hash });
  const more = chainEntries(head, [entry(5)]);
  assert.equal(more.rows[0].chain_seq, 5);
  assert.equal(more.rows[0].prev_hash, rows[3].row_hash);
});

test('an intact chain verifies (any row order in the input), and the result reports the head for a future checkpoint', () => {
  const { rows, head } = chain(6);
  const result = verifyChain([...rows].reverse(), head);
  assert.deepEqual(result, { valid: true, checked: 6, head, first_break: null });
  assert.deepEqual(verifyChain([], { chain_seq: 0, hash: GENESIS_HASH }), { valid: true, checked: 0, head: { chain_seq: 0, hash: GENESIS_HASH }, first_break: null });
});

test('AC6 tamper cases are detected, each at the exact record, with its own reason', () => {
  const cases = [
    ['modified payload', rows => { rows[2].new_state = 'COMPLETED'; }, { reason: 'ROW_HASH_MISMATCH', chain_seq: 3 }],
    ['modified metadata', rows => { rows[2].metadata = { ...rows[2].metadata, step: 99 }; }, { reason: 'ROW_HASH_MISMATCH', chain_seq: 3 }],
    ['modified prev_hash', rows => { rows[3].prev_hash = 'f'.repeat(64); }, { reason: 'PREV_HASH_MISMATCH', chain_seq: 4 }],
    // Row 4 renumbered to 9: the sequence reads 1,2,3,5,6,9, so the first break is the gap where 4 should be.
    ['modified chain_seq', rows => { rows[3].chain_seq = 9; }, { reason: 'SEQUENCE_GAP', chain_seq: 5 }],
    ['deleted middle record', rows => { rows.splice(2, 1); }, { reason: 'SEQUENCE_GAP', chain_seq: 4 }],
    ['reordered records (sequence numbers swapped)', rows => { [rows[1].chain_seq, rows[2].chain_seq] = [rows[2].chain_seq, rows[1].chain_seq]; }, { reason: 'PREV_HASH_MISMATCH', chain_seq: 2 }],
    ['reordered records (storage order swapped)', rows => { [rows[1].history_id, rows[2].history_id] = [rows[2].history_id, rows[1].history_id]; }, { reason: 'ORDER_MISMATCH', chain_seq: 3 }],
    ['duplicated record', rows => { rows.splice(3, 0, { ...rows[2] }); }, { reason: 'SEQUENCE_DUPLICATE', chain_seq: 3 }]
  ];
  for (const [name, tamper, expected] of cases) {
    const { rows } = chain(6);
    tamper(rows);
    const result = verifyChain(rows);
    assert.equal(result.valid, false, name);
    assert.equal(result.first_break.reason, expected.reason, name);
    assert.equal(result.first_break.chain_seq, expected.chain_seq, name);
  }
});

test('a cut-off tail is detected only against a head kept elsewhere (documented limit)', () => {
  const { rows, head } = chain(5);
  const cut = rows.slice(0, 3);
  assert.equal(verifyChain(cut).valid, true, 'without a reference head, a shorter but intact chain looks valid');
  const result = verifyChain(cut, head);
  assert.equal(result.valid, false);
  assert.equal(result.first_break.reason, 'HEAD_MISMATCH');
});

test('EVENT_TIME_MISMATCH: a row whose stored event time (event_time_check_ms) differs from the hashed event_time_ms (A2)', () => {
  const { rows, head } = chain(5);
  const withCheck = rows.map(r => ({ ...r, event_time_check_ms: r.event_time_ms }));
  assert.equal(verifyChain(withCheck, head).valid, true, 'equal times verify');
  assert.equal(verifyChain(withCheck.map(r => ({ ...r, event_time_check_ms: String(r.event_time_ms) })), head).valid, true,
    'a numeric string from the database compares by value');
  withCheck[3].event_time_check_ms += 1; // row 4 shown 1 ms later than hashed
  assert.deepEqual(verifyChain(withCheck, head).first_break, { chain_seq: 4, history_id: 4, reason: 'EVENT_TIME_MISMATCH' });
  withCheck[3].event_time_check_ms = NaN; // an unparseable stored time
  assert.equal(verifyChain(withCheck, head).first_break.reason, 'EVENT_TIME_MISMATCH');
  // Checked after the row hash: an earlier hash break wins, and a payload edit on the same row is a hash break.
  withCheck[1].new_state = 'EDITED';
  assert.deepEqual([verifyChain(withCheck, head).first_break.reason, verifyChain(withCheck, head).first_break.chain_seq], ['ROW_HASH_MISMATCH', 2]);
  // Without event_time_check_ms (callers that do not supply it) nothing is compared.
  assert.equal(verifyChain(rows, head).valid, true);
});

test('verifyLedger: legacy rows are counted, an unchained row after the chain is UNCHAINED_ROW, chain breaks come first (A3)', () => {
  const { rows, head } = chain(4);
  assert.deepEqual(verifyLedger({ chained: rows, head, legacyUnchained: 3 }),
    { valid: true, checked: 4, head, first_break: null, legacy_unchained: 3, unchained_after_chain: 0 });
  const after = verifyLedger({ chained: rows, head, legacyUnchained: 3, unchainedAfterChain: [{ history_id: 9 }, { history_id: 12 }] });
  assert.deepEqual(after, {
    valid: false, checked: 4, head, legacy_unchained: 3, unchained_after_chain: 2,
    first_break: { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: 9 }
  });
  const broken = rows.map(r => ({ ...r }));
  broken[2].prev_hash = 'f'.repeat(64);
  const both = verifyLedger({ chained: broken, head, unchainedAfterChain: [{ history_id: 9 }] });
  assert.deepEqual([both.valid, both.first_break.reason, both.first_break.chain_seq], [false, 'PREV_HASH_MISMATCH', 3]);
  assert.equal(both.unchained_after_chain, 1, 'still counted');
  const headBreak = verifyLedger({ chained: rows.slice(0, 3), head, unchainedAfterChain: [{ history_id: 9 }] });
  assert.equal(headBreak.first_break.reason, 'HEAD_MISMATCH');
});

test('normalizeAuditEntry: scalar fields are strings, finite numbers (as strings) or null; metadata a plain object or null (A6)', () => {
  assert.deepEqual(normalizeAuditEntry({ event_type: 'X', request_id: 'REQ-1', hospital_id: 7, actor_id: 0, metadata: { a: [1, undefined], b: undefined } }), {
    request_id: 'REQ-1', hospital_id: '7', event_type: 'X', previous_state: null, new_state: null, actor_role: 'SYSTEM', actor_id: '0',
    metadata: { a: [1, null] }
  });
  assert.equal(normalizeAuditEntry({ event_type: 'X', actor_role: '' }).actor_role, 'SYSTEM');
  assert.equal(normalizeAuditEntry({ event_type: 'X', metadata: Object.assign(Object.create(null), { k: 1 }) }).metadata.k, 1);
  const refused = [
    [{ event_type: 'X', new_state: true }, /new_state must be a string, a finite number or null \(got boolean\)/],
    [{ event_type: 'X', hospital_id: { id: 'H' } }, /hospital_id .*\(got object\)/],
    [{ event_type: 'X', actor_id: ['U'] }, /actor_id .*\(got array\)/],
    [{ event_type: 'X', previous_state: NaN }, /previous_state .*\(got number\)/],
    [{ event_type: 'X', request_id: 1n }, /request_id .*\(got bigint\)/],
    [{ event_type: 42.5, metadata: 'text' }, /metadata must be a plain object or null \(got string\)/],
    [{ event_type: 'X', metadata: [1] }, /metadata .*\(got array\)/],
    [{ event_type: 'X', metadata: new Date(0) }, /metadata .*\(got object\)/],
    [{ event_type: 'X', metadata: false }, /metadata .*\(got boolean\)/],
    [{ new_state: 'Y' }, /event_type is required/],
    [null, /plain object/]
  ];
  for (const [entry, message] of refused) assert.throws(() => normalizeAuditEntry(entry), err => err instanceof TypeError && message.test(err.message), String(message));
  // A number is hashed exactly as the string the database stores, so it verifies after a reload.
  const { rows } = chainEntries({ chain_seq: 0, hash: GENESIS_HASH }, [{ ...normalizeAuditEntry({ event_type: 'X', hospital_id: 101 }), event_time_ms: 1 }]);
  assert.equal(verifyChain([{ ...rows[0], hospital_id: '101' }]).valid, true);
});
