// server/services/auditChain.js
// Tamper-evident audit hash chain (Phase 3 Step 5, approved direction "AC"). Pure: no I/O.
//
// Every audit row gets the next chain_seq, an explicit event time and
//   row_hash = SHA-256( canonical JSON of { chain_seq, prev_hash, event_time_ms, request_id, hospital_id,
//                                          event_type, previous_state, new_state, actor_role, actor_id, metadata } )
// where prev_hash is the previous row's row_hash (GENESIS_HASH for chain_seq 1). Canonical JSON = keys sorted
// at every level, no whitespace, undefined dropped. Both storage engines use these functions, so a chain written
// by either verifies the same way.
//
// What the chain detects: a changed field (payload, prev_hash, chain_seq), a deleted record in the middle, and
// reordered records. What it does NOT detect on its own: records cut off the END together with the head, or a full
// rewrite of the whole chain by someone with database write access. Closing that gap needs the head
// ({ chain_seq, hash }, returned by verification) kept outside the database: a future checkpoint (AC10). A hash
// chain is tamper-EVIDENT, not tamper-proof.

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);
const HASHED_FIELDS = ['request_id', 'hospital_id', 'event_type', 'previous_state', 'new_state', 'actor_role', 'actor_id', 'metadata'];

/** Deterministic JSON: object keys sorted at every level, arrays kept in order, undefined dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The exact object a row's hash covers. Metadata is normalised through JSON so a stored-and-reloaded copy matches. */
export function hashedContent(row) {
  const content = { chain_seq: Number(row.chain_seq), prev_hash: row.prev_hash, event_time_ms: Number(row.event_time_ms) };
  for (const field of HASHED_FIELDS) {
    const v = row[field];
    content[field] = v === undefined || v === null ? null
      : field === 'metadata' ? JSON.parse(typeof v === 'string' ? v : JSON.stringify(v))
        : String(v);
  }
  return content;
}

export const rowHash = row => createHash('sha256').update(canonicalJson(hashedContent(row))).digest('hex');

/** Chain `entries` (in commit order) onto `head` = { chain_seq, hash }. Returns the rows and the new head. */
export function chainEntries(head, entries) {
  let seq = Number(head.chain_seq);
  let prev = head.hash;
  const rows = entries.map(entry => {
    seq += 1;
    const row = { ...entry, chain_seq: seq, prev_hash: prev };
    row.row_hash = rowHash(row);
    prev = row.row_hash;
    return row;
  });
  return { rows, head: { chain_seq: seq, hash: prev } };
}

/**
 * Verify a whole chain. `rows` = every chained row (any order; sorted here by chain_seq), `head` = the stored head
 * (optional). Checks, in order, for every row: sequence continuity from 1, prev_hash linkage, the recomputed hash,
 * the displayed event time (when the row carries event_time_check_ms: the stored event_time in epoch ms) against the
 * hashed event_time_ms, and storage order. Reports the FIRST break precisely, and whether the stored head matches
 * the last row.
 */
export function verifyChain(rows, head = null) {
  const sorted = [...rows].sort((a, b) => Number(a.chain_seq) - Number(b.chain_seq));
  let expectedSeq = 1;
  let prev = GENESIS_HASH;
  let lastHistoryId = null;
  for (const row of sorted) {
    const seq = Number(row.chain_seq);
    const at = { chain_seq: seq, history_id: row.history_id ?? null };
    if (seq !== expectedSeq) {
      return fail(sorted, { ...at, reason: seq > expectedSeq ? 'SEQUENCE_GAP' : 'SEQUENCE_DUPLICATE', expected_seq: expectedSeq });
    }
    if (row.prev_hash !== prev) return fail(sorted, { ...at, reason: 'PREV_HASH_MISMATCH' });
    if (rowHash(row) !== row.row_hash) return fail(sorted, { ...at, reason: 'ROW_HASH_MISMATCH' });
    // The displayed and sorted event_time is not hashed; when the store supplies it (event_time_check_ms), it must
    // be the hashed millisecond, or the visible time was edited.
    if (row.event_time_check_ms !== undefined && Number(row.event_time_check_ms) !== Number(row.event_time_ms)) {
      return fail(sorted, { ...at, reason: 'EVENT_TIME_MISMATCH' });
    }
    // history_id is assigned in insertion order, so it must rise with chain_seq: otherwise rows were reordered.
    if (lastHistoryId !== null && row.history_id != null && Number(row.history_id) <= lastHistoryId) {
      return fail(sorted, { ...at, reason: 'ORDER_MISMATCH' });
    }
    if (row.history_id != null) lastHistoryId = Number(row.history_id);
    prev = row.row_hash;
    expectedSeq += 1;
  }
  const last = { chain_seq: expectedSeq - 1, hash: prev };
  if (head && (Number(head.chain_seq) !== last.chain_seq || head.hash !== last.hash)) {
    return { valid: false, checked: sorted.length, head: last, stored_head: head, first_break: { reason: 'HEAD_MISMATCH', chain_seq: last.chain_seq } };
  }
  return { valid: true, checked: sorted.length, head: last, first_break: null };
}

function fail(sorted, first_break) {
  return { valid: false, checked: sorted.length, head: null, first_break };
}

/**
 * Whole-ledger verification shared by both stores: the chain (verifyChain) plus the rows that carry no chain_seq.
 * Legacy rows predate the chain (migration 006) and are only counted (`legacy_unchained`). Any other unchained row
 * was written outside the chain, so it is a break (`UNCHAINED_ROW`, with its history_id). Where the legacy set was
 * recorded when chaining began (MySQL: AuditChainHead.legacy_count, migration 007), a different number of legacy rows
 * is a break too (`UNCHAINED_ROW` with history_id null and both counts): a row slipped into a gap among the legacy
 * ids, or a legacy row was deleted. A break inside the chain itself is reported first.
 * @param {object} p
 * @param {object[]} p.chained               rows with a chain_seq
 * @param {object|null} p.head               the stored head, if the store keeps one
 * @param {number} p.legacyUnchained         unchained rows found in the legacy range
 * @param {object[]} p.unchainedAfterChain   unchained rows outside it ({ history_id }), in storage order
 * @param {number|null} p.legacyRecorded     how many legacy rows were recorded when chaining began (null = not recorded)
 */
export function verifyLedger({ chained, head = null, legacyUnchained = 0, unchainedAfterChain = [], legacyRecorded = null }) {
  const result = { ...verifyChain(chained, head), legacy_unchained: legacyUnchained, unchained_after_chain: unchainedAfterChain.length };
  if (!result.valid) return result;
  if (unchainedAfterChain.length) {
    result.valid = false;
    result.first_break = { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: unchainedAfterChain[0].history_id ?? null };
  } else if (legacyRecorded !== null && Number(legacyRecorded) !== legacyUnchained) {
    result.valid = false;
    result.first_break = { reason: 'UNCHAINED_ROW', chain_seq: null, history_id: null, legacy_recorded: Number(legacyRecorded), legacy_found: legacyUnchained };
  }
  return result;
}

// ── Audit entry validation (both stores) ─────────────────────────────────────────────────────────────────────────
const SCALAR_FIELDS = ['request_id', 'hospital_id', 'event_type', 'previous_state', 'new_state', 'actor_role', 'actor_id'];

class AuditEntryError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'AuditEntryError';
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * Validate and normalise an audit entry before it is chained. The scalar fields are stored in VARCHAR/ENUM columns
 * and hashed as strings, so each must be a string, a finite number (stored and hashed as its String() form) or
 * null/undefined (null). Anything else (boolean, object, array, NaN ...) would hash differently from what MySQL
 * stores, so it is refused here, on both stores, before anything is written. metadata must be a plain object or
 * null/undefined. event_type is required; actor_role defaults to 'SYSTEM'.
 * @returns {object} { request_id, hospital_id, event_type, previous_state, new_state, actor_role, actor_id, metadata }
 */
export function normalizeAuditEntry(entry) {
  if (!isPlainObject(entry)) throw new AuditEntryError('Audit entry must be a plain object.');
  const out = {};
  for (const field of SCALAR_FIELDS) {
    const v = entry[field];
    if (v === undefined || v === null) out[field] = null;
    else if (typeof v === 'string') out[field] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[field] = String(v);
    else throw new AuditEntryError(`Audit field ${field} must be a string, a finite number or null (got ${Array.isArray(v) ? 'array' : typeof v}).`);
  }
  if (!out.event_type) throw new AuditEntryError('Audit field event_type is required.');
  if (!out.actor_role) out.actor_role = 'SYSTEM';
  const m = entry.metadata;
  if (m !== undefined && m !== null && !isPlainObject(m)) {
    throw new AuditEntryError(`Audit metadata must be a plain object or null (got ${Array.isArray(m) ? 'array' : typeof m}).`);
  }
  out.metadata = m === undefined || m === null ? null : JSON.parse(JSON.stringify(m));
  return out;
}
