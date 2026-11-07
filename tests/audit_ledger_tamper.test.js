// tests/audit_ledger_tamper.test.js
// P3-04 (Issue #27): tamper detection and append-time normalization of the browser audit ledger
// (js/audit_ledger.js). Regression tests for the detection failures found on 2026-11-06:
//   R1/R2  verifyLedgerIntegrity() ignored the entries it was given, so a deleted or reordered record in any
//          supplied record set (an export) was reported valid;
//   R3     the timestamp (and audit ID) were not covered by the hash;
//   R4     sealed payloads were only shallow-frozen and hashed through lossy JSON, so an in-place NaN or
//          undefined edit went undetected;
//   R5     the "SHA256-" hash was a 64-bit non-cryptographic mix.
// Out of scope (Phase 3 Step 5): records removed from the END of the chain, and a full rewrite of a keyless
// chain. No test here claims either is detected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const MODULE = '../js/audit_ledger.js';
let instance = 0;
/** A fresh module instance: its own private ledger, seeded exactly as the app seeds it. */
const freshLedger = () => import(`${MODULE}?tamper-${++instance}`);

const SEEDED = 13;
const nodeSha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Independent re-implementation of the documented hash input (kept separate from the module on purpose).
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);
const expectedHash = e => `SHA256-${nodeSha256(canonical(['ERIS-AUDIT-SHA256-V1', e.sequenceNumber, e.auditId, e.timestamp, e.eventType, e.payload, e.previousHash])).toUpperCase()}`;

/** A mutable deep copy of the ledger, as an attacker editing an export would hold it. */
const editableCopy = L => structuredClone(L.getLedgerEntries());
const rechainFrom = (entries, index) => {               // honest re-sealing after an edit, from `index` on
  for (let i = index; i < entries.length; i++) {
    entries[i].previousHash = i === 0 ? 'GENESIS_ROOT_HASH' : entries[i - 1].integrityHash;
    entries[i].integrityHash = expectedHash(entries[i]);
  }
  return entries;
};

// ── SHA-256 itself ───────────────────────────────────────────────────────────────────────────────────

test('sha256Hex matches the FIPS 180-4 test vectors and node:crypto at every padding boundary', async () => {
  const { sha256Hex } = await freshLedger();
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  for (let n = 0; n <= 130; n++) {                     // 55/56/63/64/119/120 byte padding edges included
    const text = 'x'.repeat(n);
    assert.equal(sha256Hex(text), nodeSha256(text), `length ${n}`);
  }
  for (const text of ['é', 'चिकित्सा', '急救🚑', '\u0000', 'line\nbreak']) assert.equal(sha256Hex(text), nodeSha256(text), text);
});

// ── Valid ledgers ────────────────────────────────────────────────────────────────────────────────────

test('a freshly seeded ledger verifies, both in place and as a supplied copy, and keeps its API shape', async () => {
  const L = await freshLedger();
  assert.deepEqual(L.verifyLedgerIntegrity(), { isValid: true, verifiedEntries: SEEDED, errorIndex: null });
  assert.deepEqual(L.verifyLedgerIntegrity(L.getLedgerEntries()), { isValid: true, verifiedEntries: SEEDED, errorIndex: null });
  assert.deepEqual(L.verifyLedgerIntegrity(editableCopy(L)), { isValid: true, verifiedEntries: SEEDED, errorIndex: null });
  assert.equal(L.getLedgerStats().chainValid, true);
});

test('every sealed hash is SHA-256 over all fields, canonically encoded, and chained from the genesis value', async () => {
  const L = await freshLedger();
  L.appendAuditEntry(L.EVENT_TYPES.REFERRAL_ACCEPTED, { z: 1, a: { y: [1, 'two', null, true], b: 'ü' } });
  const entries = L.getLedgerEntries();
  assert.equal(entries[0].previousHash, 'GENESIS_ROOT_HASH');
  entries.forEach((e, i) => {
    assert.match(e.integrityHash, /^SHA256-[0-9A-F]{64}$/);
    assert.equal(e.integrityHash, expectedHash(e), `entry ${i}`);
    assert.equal(e.sequenceNumber, i + 1);
    assert.equal(e.auditId, `AUD-${String(i + 1).padStart(5, '0')}`);
    if (i > 0) assert.equal(e.previousHash, entries[i - 1].integrityHash);
  });
});

test('boundaries: an empty chain and a one-entry chain verify; key order does not change the hash', async () => {
  const L = await freshLedger();
  assert.deepEqual(L.verifyLedgerIntegrity([]), { isValid: true, verifiedEntries: 0, errorIndex: null });
  assert.deepEqual(L.verifyLedgerIntegrity(L.getLedgerEntries().slice(0, 1)), { isValid: true, verifiedEntries: 1, errorIndex: null });
  const [first] = editableCopy(L);
  const reordered = { ...first, payload: Object.fromEntries(Object.entries(first.payload).reverse()) };
  assert.equal(expectedHash(reordered), first.integrityHash);
  assert.equal(L.verifyLedgerIntegrity([reordered]).isValid, true);
});

// ── R1/R2: supplied record sets — deletion, insertion, reordering ────────────────────────────────────

test('R1: a record deleted from the middle of a supplied set is detected at the gap', async () => {
  const L = await freshLedger();
  const tampered = L.getLedgerEntries().filter((_, i) => i !== 5);
  assert.deepEqual(L.verifyLedgerIntegrity(tampered), {
    isValid: false, verifiedEntries: 5, errorIndex: 5, reason: 'Sequence break (expected #6): record deleted, inserted or reordered'
  });
  assert.equal(L.verifyLedgerIntegrity().isValid, true, 'the module\'s own ledger is untouched');
});

test('R1: deleting the first record, or re-numbering after a deletion, is detected', async () => {
  const L = await freshLedger();
  assert.equal(L.verifyLedgerIntegrity(L.getLedgerEntries().slice(1)).errorIndex, 0);
  // Re-number the survivors to hide the gap: the audit IDs, links and hashes no longer match.
  const renumbered = editableCopy(L).filter((_, i) => i !== 5);
  renumbered.forEach((e, i) => { e.sequenceNumber = i + 1; });
  const r = L.verifyLedgerIntegrity(renumbered);
  assert.equal(r.isValid, false);
  assert.equal(r.errorIndex, 5);
});

test('R2: reordered, duplicated and inserted records are detected', async () => {
  const L = await freshLedger();
  const swapped = L.getLedgerEntries(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.equal(L.verifyLedgerIntegrity(swapped).errorIndex, 3);
  const duplicated = L.getLedgerEntries(); duplicated.splice(7, 0, duplicated[6]);
  assert.equal(L.verifyLedgerIntegrity(duplicated).errorIndex, 7);
  const reversed = L.getLedgerEntries().reverse();
  assert.equal(L.verifyLedgerIntegrity(reversed).errorIndex, 0);
});

// ── R3 and field edits ──────────────────────────────────────────────────────────────────────────────

test('R3: an edited timestamp or audit ID is detected', async () => {
  const L = await freshLedger();
  const t = editableCopy(L); t[4].timestamp = '2020-01-01T00:00:00.000Z';
  assert.deepEqual(L.verifyLedgerIntegrity(t), { isValid: false, verifiedEntries: 4, errorIndex: 4, reason: 'Hash mismatch (tampering detected)' });
  const a = editableCopy(L); a[4].auditId = 'AUD-99999';
  assert.equal(L.verifyLedgerIntegrity(a).reason, 'Audit ID does not match the sequence number');
});

test('every sealed field is covered: editing any one of them in any position is detected', async () => {
  const L = await freshLedger();
  const edits = {
    eventType: e => { e.eventType = 'COMPLETED_X'; },
    payloadTop: e => { e.payload.edited = 1; },
    payloadNested: e => { e.payload.nested = { deep: [1] }; },
    previousHash: e => { e.previousHash = `SHA256-${'A'.repeat(64)}`; },
    integrityHash: e => { e.integrityHash = `SHA256-${'B'.repeat(64)}`; },
    timestamp: e => { e.timestamp = new Date(Date.parse(e.timestamp) + 1).toISOString(); },
    isSealed: e => { e.isSealed = false; }
  };
  for (const index of [0, 6, SEEDED - 1]) {                // first, middle, last
    for (const [name, edit] of Object.entries(edits)) {
      const copy = editableCopy(L);
      edit(copy[index]);
      const r = L.verifyLedgerIntegrity(copy);
      assert.equal(r.isValid, false, `${name} @${index}`);
      assert.equal(r.errorIndex, index, `${name} @${index}`);
    }
  }
});

test('an edit re-sealed only at its own entry breaks the link to the next one', async () => {
  const L = await freshLedger();
  const copy = editableCopy(L);
  copy[6].payload.requestId = 'REQ-FORGED';
  copy[6].integrityHash = expectedHash(copy[6]);
  assert.deepEqual(L.verifyLedgerIntegrity(copy), { isValid: false, verifiedEntries: 7, errorIndex: 7, reason: 'Broken chain link' });
});

// ── R4: append-time normalization ───────────────────────────────────────────────────────────────────

test('R4: payloads are normalized once, at append, with JSON semantics, and what is stored is what was hashed', async () => {
  const L = await freshLedger();
  const when = new Date('2026-11-06T10:00:00.000Z');
  const e = L.appendAuditEntry(L.EVENT_TYPES.STRESS_TEST_RUN, {
    nan: NaN, inf: Infinity, ninf: -Infinity, negZero: -0, gone: undefined, fn() {}, when,
    list: [1, undefined, NaN, () => 1], nested: { keep: 'yes', drop: undefined }
  });
  assert.deepEqual(e.payload, {
    nan: null, inf: null, ninf: null, negZero: 0, when: '2026-11-06T10:00:00.000Z',
    list: [1, null, null, null], nested: { keep: 'yes' }
  });
  assert.ok(!Object.is(e.payload.negZero, -0));
  assert.equal(e.integrityHash, expectedHash(e));
  // The CSV export shows exactly the stored payload, as before (it always went through JSON).
  assert.ok(L.exportLedgerToCsv().includes('""nan"":null'));
  assert.equal(L.verifyLedgerIntegrity().isValid, true);
});

test('R4: a sealed payload is deep-frozen and shares nothing with the caller', async () => {
  const L = await freshLedger();
  const callerBed = { id: 'ICU-1', tags: ['a'] };
  const e = L.appendAuditEntry(L.EVENT_TYPES.SOFT_LOCK_PLACED, { bed: callerBed });
  callerBed.id = 'ICU-9'; callerBed.tags.push('b');         // the caller keeps using its own object
  assert.deepEqual(e.payload.bed, { id: 'ICU-1', tags: ['a'] });
  assert.throws(() => { e.payload.bed.id = 'X'; }, TypeError);
  assert.throws(() => { e.payload.bed.tags.push('c'); }, TypeError);
  const exported = L.getLedgerEntries().at(-1);
  assert.throws(() => { exported.payload.bed.tags[0] = 'z'; }, TypeError);
  assert.equal(L.verifyLedgerIntegrity().isValid, true);
});

test('R4: payload defaults and non-object payloads keep their previous meaning', async () => {
  const L = await freshLedger();
  assert.deepEqual(L.appendAuditEntry(L.EVENT_TYPES.COMPLETED).payload, {});
  assert.deepEqual(L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, null).payload, {});
  assert.deepEqual(L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, 'ab').payload, { 0: 'a', 1: 'b' });
  assert.deepEqual(L.appendAuditEntry('CUSTOM_EVENT', { ok: true }).payload, { ok: true }, 'unknown event types are still accepted');
  assert.equal(L.verifyLedgerIntegrity().isValid, true);
});

test('a payload that cannot be stored is refused before numbering: no gap, no change to the ledger', async () => {
  const L = await freshLedger();
  const before = L.getLedgerEntries();
  const circular = { a: 1 }; circular.self = circular;
  assert.throws(() => L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, { big: 10n }), TypeError);
  assert.throws(() => L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, circular), TypeError);
  assert.throws(() => L.appendAuditEntry(undefined, {}), TypeError);
  assert.throws(() => L.appendAuditEntry('', {}), TypeError);
  assert.deepEqual(L.getLedgerEntries(), before);
  const next = L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, { ok: 1 });
  assert.equal(next.sequenceNumber, SEEDED + 1);
  assert.equal(L.verifyLedgerIntegrity().isValid, true);
});

// ── Existing entries are never rewritten, and the verifier never normalizes ──────────────────────────

test('appending never changes entries already in the ledger', async () => {
  const L = await freshLedger();
  const before = structuredClone(L.getLedgerEntries());
  for (let i = 0; i < 5; i++) L.appendAuditEntry(L.EVENT_TYPES.RESOURCE_RELEASED, { i, nan: NaN });
  assert.deepEqual(L.getLedgerEntries().slice(0, SEEDED), before);
});

test('the verifier reads supplied entries without modifying or normalizing them', async () => {
  const L = await freshLedger();
  const copy = editableCopy(L);
  const snapshot = structuredClone(copy);
  L.verifyLedgerIntegrity(copy);
  assert.deepEqual(copy, snapshot);

  const nonJson = {
    'NaN': p => { p.v = NaN; },
    '-0': p => { p.v = -0; },
    'undefined': p => { p.v = undefined; },
    'function': p => { p.v = () => 1; },
    'Date object': p => { p.v = new Date(0); },
    'array extra property': p => { p.v = Object.assign([1], { hidden: 2 }); },
    'sparse array': p => { p.v = [1, , 3]; },
    'accessor': p => { Object.defineProperty(p, 'v', { get: () => 1, enumerable: true }); },
    'symbol key': p => { p[Symbol('s')] = 1; },
    'class instance': p => { p.v = new (class Thing {})(); }
  };
  for (const [name, plant] of Object.entries(nonJson)) {
    const tampered = editableCopy(L);
    plant(tampered[2].payload);
    const before = tampered[2].payload;
    const r = L.verifyLedgerIntegrity(tampered);
    assert.deepEqual(r, { isValid: false, verifiedEntries: 2, errorIndex: 2, reason: 'Payload is not plain JSON data' }, name);
    assert.equal(tampered[2].payload, before, `${name}: not replaced`);
  }
});

test('legacy entries (sealed with the old 32-hex hash) are reported, never re-hashed or accepted', async () => {
  const L = await freshLedger();
  const legacy = editableCopy(L).map(e => ({ ...e }));
  legacy[0].integrityHash = 'SHA256-0014BECCCC49012D0009012D7994BECC';
  const snapshot = structuredClone(legacy);
  assert.deepEqual(L.verifyLedgerIntegrity(legacy), {
    isValid: false, verifiedEntries: 0, errorIndex: 0,
    reason: 'Legacy integrity hash format (sealed before SHA-256; cannot be verified)'
  });
  assert.deepEqual(legacy, snapshot);
});

// ── Invalid or incomplete ledger data ────────────────────────────────────────────────────────────────

test('non-array ledger data is refused without throwing', async () => {
  const L = await freshLedger();
  for (const bad of [undefined, null, {}, 'entries', 42, new Set()]) {
    assert.deepEqual(L.verifyLedgerIntegrity(bad),
      { isValid: false, verifiedEntries: 0, errorIndex: null, reason: 'Ledger data must be an array of entries' }, String(bad));
  }
});

test('incomplete or malformed entries are reported at their index, each with its own reason', async () => {
  const L = await freshLedger();
  const cases = {
    'null entry': [(c) => { c[3] = null; }, 'Malformed entry (not an object)'],
    'number entry': [(c) => { c[3] = 7; }, 'Malformed entry (not an object)'],
    'array entry': [(c) => { c[3] = []; }, 'Malformed entry (not an object)'],
    'missing field': [(c) => { delete c[3].timestamp; }, 'Malformed entry (missing or unexpected fields)'],
    'extra field': [(c) => { c[3].approvedBy = 'admin'; }, 'Malformed entry (missing or unexpected fields)'],
    'accessor field': [(c) => { const v = c[3].eventType; Object.defineProperty(c[3], 'eventType', { get: () => v, enumerable: true }); }, 'Malformed entry (accessor field)'],
    'string sequence': [(c) => { c[3].sequenceNumber = '4'; }, 'Sequence break (expected #4): record deleted, inserted or reordered'],
    'fractional sequence': [(c) => { c[3].sequenceNumber = 4.5; }, 'Sequence break (expected #4): record deleted, inserted or reordered'],
    'bad timestamp': [(c) => { c[3].timestamp = 'yesterday'; }, 'Invalid timestamp'],
    'non-canonical timestamp': [(c) => { c[3].timestamp = '2026-11-06T10:00:00Z'; }, 'Invalid timestamp'],
    'numeric timestamp': [(c) => { c[3].timestamp = 1793700000000; }, 'Invalid timestamp'],
    'empty event type': [(c) => { c[3].eventType = ''; }, 'Invalid event type'],
    'numeric event type': [(c) => { c[3].eventType = 5; }, 'Invalid event type'],
    'payload not an object': [(c) => { c[3].payload = 'text'; }, 'Payload is not an object'],
    'payload null': [(c) => { c[3].payload = null; }, 'Payload is not an object'],
    'payload array': [(c) => { c[3].payload = []; }, 'Payload is not an object'],
    'malformed hash': [(c) => { c[3].integrityHash = 'SHA256-XYZ'; }, 'Malformed integrity hash'],
    'lower-case hash': [(c) => { c[3].integrityHash = c[3].integrityHash.toLowerCase(); }, 'Malformed integrity hash'],
    'unprefixed hash': [(c) => { c[3].integrityHash = c[3].integrityHash.slice(7); }, 'Malformed integrity hash'],
    'wrong genesis': [(c) => { c[0].previousHash = 'SOMETHING_ELSE'; }, 'Broken chain link']
  };
  for (const [name, [damage, reason]] of Object.entries(cases)) {
    const copy = editableCopy(L);
    damage(copy);
    const index = name === 'wrong genesis' ? 0 : 3;
    assert.deepEqual(L.verifyLedgerIntegrity(copy), { isValid: false, verifiedEntries: index, errorIndex: index, reason }, name);
  }
});

test('an existing nested value edited in place is detected', async () => {
  const L = await freshLedger();
  const copy = editableCopy(L);
  assert.equal(copy[11].eventType, 'BANKERS_SAFE');
  copy[11].payload.resourceVector[0] = 9;
  assert.deepEqual(L.verifyLedgerIntegrity(copy), { isValid: false, verifiedEntries: 11, errorIndex: 11, reason: 'Hash mismatch (tampering detected)' });
});

test('a legacy-format entry in the middle of a chain is reported at its own index', async () => {
  const L = await freshLedger();
  const copy = editableCopy(L);
  copy[6].integrityHash = 'SHA256-0014BECCCC49012D0009012D7994BECC';
  assert.deepEqual(L.verifyLedgerIntegrity(copy), {
    isValid: false, verifiedEntries: 6, errorIndex: 6, reason: 'Legacy integrity hash format (sealed before SHA-256; cannot be verified)'
  });
});

// ── Review findings (2026-11-06): append must only store what verify accepts; verify never throws ───

test('a payload whose own toJSON() yields a non-object is refused before numbering', async () => {
  const L = await freshLedger();
  for (const result of [null, 'x', 5, [1], undefined]) {
    assert.throws(() => L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, { toJSON() { return result; } }), TypeError, String(result));
  }
  assert.equal(L.getLedgerEntries().length, SEEDED);
  const ok = L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, { toJSON() { return { summarised: true }; } });
  assert.deepEqual(ok.payload, { summarised: true });
  assert.equal(ok.sequenceNumber, SEEDED + 1);
  assert.equal(L.verifyLedgerIntegrity().isValid, true);
  assert.equal(L.getLedgerStats().chainValid, true);
});

const nested = depth => { let v = 1; for (let i = 0; i < depth; i++) v = { v }; return v; }; // `depth` object levels, the payload itself included

test('nesting is capped at MAX_PAYLOAD_DEPTH on append, and what append accepts always verifies', async () => {
  const L = await freshLedger();
  assert.equal(L.MAX_PAYLOAD_DEPTH, 32);
  const atLimit = L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, nested(L.MAX_PAYLOAD_DEPTH));
  assert.equal(atLimit.integrityHash, expectedHash(atLimit));
  assert.throws(() => L.appendAuditEntry(L.EVENT_TYPES.COMPLETED, nested(L.MAX_PAYLOAD_DEPTH + 1)), TypeError);
  assert.equal(L.getLedgerEntries().length, SEEDED + 1, 'refused before numbering');
  assert.deepEqual(L.verifyLedgerIntegrity(), { isValid: true, verifiedEntries: SEEDED + 1, errorIndex: null });
  assert.equal(L.getLedgerStats().chainValid, true);
});

test('hostile supplied data gets a result, never an exception, and no getter is run', async () => {
  const L = await freshLedger();
  const deep = editableCopy(L); deep[2].payload = nested(100000);
  assert.deepEqual(L.verifyLedgerIntegrity(deep), { isValid: false, verifiedEntries: 2, errorIndex: 2, reason: 'Payload is not plain JSON data' });

  let reads = 0;
  const getter = editableCopy(L);
  Object.defineProperty(getter, 4, { get() { reads++; throw new Error('boom'); }, enumerable: true });
  assert.deepEqual(L.verifyLedgerIntegrity(getter), { isValid: false, verifiedEntries: 4, errorIndex: 4, reason: 'Malformed entry (accessor)' });
  assert.equal(reads, 0);

  const holey = editableCopy(L); delete holey[4];
  Object.defineProperty(Array.prototype, 4, { value: editableCopy(L)[4], configurable: true, writable: true });
  try {
    assert.deepEqual(L.verifyLedgerIntegrity(holey), { isValid: false, verifiedEntries: 4, errorIndex: 4, reason: 'Malformed entry (missing)' });
  } finally {
    delete Array.prototype[4];
  }

  const { proxy, revoke } = Proxy.revocable(editableCopy(L), {}); revoke();
  assert.deepEqual(L.verifyLedgerIntegrity(proxy), { isValid: false, verifiedEntries: 0, errorIndex: null, reason: 'Ledger data could not be read' });
  const inner = Proxy.revocable({}, {}); inner.revoke();
  const withRevoked = editableCopy(L); withRevoked[1] = inner.proxy;
  assert.deepEqual(L.verifyLedgerIntegrity(withRevoked), { isValid: false, verifiedEntries: 1, errorIndex: 1, reason: 'Malformed entry (could not be read)' });
});

test('sha256Hex only hashes strings', async () => {
  const { sha256Hex } = await freshLedger();
  for (const bad of [undefined, null, 5, {}]) assert.throws(() => sha256Hex(bad), TypeError);
});

// ── Documented limits (Step 5), asserted so a future change cannot silently claim more ───────────────

test('known limits: tail truncation, tail extension and re-sealing from the edit onward are not detected', async () => {
  const L = await freshLedger();
  assert.equal(L.verifyLedgerIntegrity(L.getLedgerEntries().slice(0, 5)).isValid, true, 'tail truncation');
  const rewritten = editableCopy(L);
  rewritten[4].payload.requestId = 'REQ-REWRITTEN';
  assert.equal(L.verifyLedgerIntegrity(rechainFrom(rewritten, 4)).isValid, true, 'keyless chain re-sealed from the edit');
  const lastOnly = editableCopy(L);
  lastOnly[SEEDED - 1].payload.location = 'elsewhere';
  assert.equal(L.verifyLedgerIntegrity(rechainFrom(lastOnly, SEEDED - 1)).isValid, true, 'last entry re-sealed alone');
  const extended = editableCopy(L);
  extended.push({ ...structuredClone(extended[0]), sequenceNumber: SEEDED + 1, auditId: `AUD-${String(SEEDED + 1).padStart(5, '0')}` });
  assert.equal(L.verifyLedgerIntegrity(rechainFrom(extended, SEEDED)).isValid, true, 'forged entry appended at the end');
});
