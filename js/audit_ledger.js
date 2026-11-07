// js/audit_ledger.js
// P3-04: Medico-Legal Audit Ledger, browser copy (DBMS Append-Only Log) (Issue #27)
//
// Each entry's content (sequence number, audit ID, timestamp, event type, payload, previous hash) is
// sealed with a SHA-256 hash, and each entry carries the previous entry's hash. verifyLedgerIntegrity()
// checks the ledger held here, or any entry array handed to it (for example an export). It reports the
// first entry that is malformed, out of sequence (a record deleted from the start or middle, inserted,
// duplicated or reordered), or whose content no longer matches its hash or whose link is broken.
//
// What it does NOT guarantee (tamper-evident, not tamper-proof):
//   - The chain has no secret key. Anyone who can change entries can also recompute the hashes from the
//     changed entry to the end, and can add or remove entries at the end. Such a re-sealed chain verifies.
//     Only an edit that is NOT followed by re-sealing everything after it is detected.
//   - Entries cut off the END (or an emptied ledger) are not detected: that needs a head hash kept
//     elsewhere. Planned with the server-side audit chain (Phase 3 Step 5).
//   - It lives in browser memory only; reloading the page starts a new ledger.
//   - Data from another realm (iframe, vm) is treated as non-plain and reported (fails closed). A Proxy can
//     present different values to different readers; the verifier returns a result for one, never throws,
//     but cannot vouch for what other code reads from it.
//
// Normalization boundary: appendAuditEntry() is the only place data enters. The payload is normalized
// there, once, with JSON semantics (NaN/Infinity -> null, undefined/functions dropped, Dates -> ISO
// strings), deep-copied and deep-frozen, so the stored record is exactly what was hashed. A payload that
// does not normalize to a plain object, or nests deeper than MAX_PAYLOAD_DEPTH, is refused before the
// entry is numbered. The verifier never normalizes: supplied data that is not plain JSON is reported.

let _ledger = []; // private append-only store

/** Deepest object/array nesting a payload may have (the payload object itself is level 1). */
export const MAX_PAYLOAD_DEPTH = 32;

const GENESIS_HASH = "GENESIS_ROOT_HASH";
const HASH_SCHEME = "ERIS-AUDIT-SHA256-V1"; // domain-separates the hash input; bump if the encoding changes
const HASH_PATTERN = /^SHA256-[0-9A-F]{64}$/;
const LEGACY_HASH_PATTERN = /^SHA256-[0-9A-F]{32}$/; // the pre-SHA-256 (non-cryptographic) format
const ENTRY_FIELDS = ["sequenceNumber", "auditId", "timestamp", "eventType", "payload", "previousHash", "integrityHash", "isSealed"];

export const EVENT_TYPES = {
  REQUEST_CREATED:      "REQUEST_CREATED",
  TRIAGE_ASSIGNED:      "TRIAGE_ASSIGNED",
  MATCHING_STARTED:     "MATCHING_STARTED",
  SOFT_LOCK_PLACED:     "SOFT_LOCK_PLACED",
  SOFT_LOCK_EXPIRED:    "SOFT_LOCK_EXPIRED",
  REFERRAL_ACCEPTED:    "REFERRAL_ACCEPTED",
  REFERRAL_REJECTED:    "REFERRAL_REJECTED",
  AMBULANCE_DISPATCHED: "AMBULANCE_DISPATCHED",
  IN_TREATMENT:         "IN_TREATMENT",
  COMPLETED:            "COMPLETED",
  RESOURCE_RELEASED:    "RESOURCE_RELEASED",
  ROADSIDE_TRIAGE:      "ROADSIDE_TRIAGE",
  PRE_ALERT_SENT:       "PRE_ALERT_SENT",
  STRESS_TEST_RUN:      "STRESS_TEST_RUN",
  BANKERS_SAFE:         "BANKERS_SAFE",
  BANKERS_UNSAFE:       "BANKERS_UNSAFE"
};

// ── SHA-256 (FIPS 180-4) ─────────────────────────────────────────────────────────────────────────────
// Synchronous and dependency-free, so the same module runs in the browser and in Node and the API stays
// synchronous (js/app.js calls it synchronously). Cross-checked against node:crypto in the tests.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * SHA-256 of a string, UTF-8 encoded as TextEncoder and node:crypto do (a lone surrogate becomes U+FFFD;
 * ledger hashes are unaffected because the canonical encoding escapes lone surrogates first), as 64
 * lower-case hex characters.
 * @param {string} message
 * @returns {string}
 */
export function sha256Hex(message) {
  if (typeof message !== "string") throw new TypeError("sha256Hex: message must be a string");
  const bytes = new TextEncoder().encode(message);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H, word => word.toString(16).padStart(8, "0")).join("");
}

// ── Canonical encoding ───────────────────────────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted, no whitespace. Accepts ONLY plain JSON data (null, booleans,
 * finite numbers other than -0, strings, dense arrays, plain objects made of own enumerable data
 * properties, nested at most MAX_PAYLOAD_DEPTH levels) and throws TypeError for anything else, so two
 * different values can never encode alike. Reads property descriptors, never getters or toJSON.
 * Strings go through JSON.stringify, which escapes lone surrogates, so the UTF-8 step is lossless.
 */
function _canonicalJson(value, ancestors = []) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("not JSON data: non-finite number or -0");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`not JSON data: ${typeof value}`);
  if (ancestors.length >= MAX_PAYLOAD_DEPTH) throw new TypeError(`not JSON data: nested deeper than ${MAX_PAYLOAD_DEPTH} levels`);
  if (ancestors.includes(value)) throw new TypeError("not JSON data: circular reference");
  const proto = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) {
    throw new TypeError("not JSON data: not a plain object or array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("not JSON data: symbol key");
  const names = Object.getOwnPropertyNames(value).filter(name => !(isArray && name === "length"));
  for (const name of names) {
    const d = descriptors[name];
    if (!("value" in d) || !d.enumerable) throw new TypeError(`not JSON data: property "${name}" is an accessor or hidden`);
  }
  const path = [...ancestors, value];
  if (isArray) {
    if (names.length !== value.length || names.some((name, i) => name !== String(i))) {
      throw new TypeError("not JSON data: sparse array or array with extra properties");
    }
    return `[${names.map(name => _canonicalJson(descriptors[name].value, path)).join(",")}]`;
  }
  const keys = [...names].sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${_canonicalJson(descriptors[key].value, path)}`).join(",")}}`;
}

/**
 * The integrity hash of an entry: SHA-256 over the canonical JSON array
 *   [HASH_SCHEME, sequenceNumber, auditId, timestamp, eventType, payload, previousHash]
 * `payloadJson` is the payload's canonical encoding, computed once by the caller (append or verify), so
 * the payload is read exactly once per check.
 */
function _computeIntegrityHash(fields, payloadJson) {
  const head = [HASH_SCHEME, fields.sequenceNumber, fields.auditId, fields.timestamp, fields.eventType]
    .map(value => _canonicalJson(value));
  const content = `[${head.join(",")},${payloadJson},${_canonicalJson(fields.previousHash)}]`;
  return `SHA256-${sha256Hex(content)}`.toUpperCase();
}

const _auditIdFor = seq => `AUD-${String(seq).padStart(5, "0")}`;

function _deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(_deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * The normalization boundary: what the caller passed, reduced to plain JSON data with JSON semantics
 * (the same view the ledger exposes in its CSV export), as a fresh deep-frozen copy that shares nothing
 * with the caller. Throws TypeError, before anything is stored, for data JSON cannot represent (BigInt,
 * circular references), for a payload whose own toJSON() turns it into something other than a plain
 * object, and for nesting deeper than MAX_PAYLOAD_DEPTH. Returns the payload and its canonical encoding.
 */
function _normalizePayload(payload) {
  const text = JSON.stringify({ ...payload });
  const normalized = text === undefined ? undefined : JSON.parse(text);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("appendAuditEntry: payload must normalize to a plain object (check its toJSON)");
  }
  const payloadJson = _canonicalJson(normalized); // throws TypeError when nested too deeply
  return { payload: _deepFreeze(normalized), payloadJson };
}

/**
 * Appends a sealed audit entry. The payload is normalized here (see the header), before the entry is
 * numbered: a payload that cannot be stored throws and leaves the ledger, and its numbering, unchanged.
 * Entries already in the ledger are never modified.
 * @param {string} eventType - One of EVENT_TYPES (any non-empty string is accepted)
 * @param {Object} payload - Contextual data for this event
 * @returns {Object} The sealed (deep-frozen) audit entry
 */
export function appendAuditEntry(eventType, payload = {}) {
  if (typeof eventType !== "string" || eventType === "") {
    throw new TypeError("appendAuditEntry: eventType must be a non-empty string");
  }
  const { payload: normalizedPayload, payloadJson } = _normalizePayload(payload);

  const sequenceNumber = _ledger.length + 1;
  const prevEntry = _ledger[_ledger.length - 1];
  const fields = {
    sequenceNumber,
    auditId:      _auditIdFor(sequenceNumber),
    timestamp:    new Date().toISOString(),
    eventType,
    payload:      normalizedPayload,
    previousHash: prevEntry ? prevEntry.integrityHash : GENESIS_HASH
  };
  const entry = Object.freeze({ ...fields, integrityHash: _computeIntegrityHash(fields, payloadJson), isSealed: true });

  _ledger.push(entry);
  return entry;
}

/**
 * Checks entry `index` of `chain`. Returns { reason } when it is invalid, or { reason: null, integrityHash }.
 * Reads each value exactly once through property descriptors (no getters run); never modifies anything.
 */
function _checkEntry(chain, index, previousHash) {
  const slot = Object.getOwnPropertyDescriptor(chain, index);
  if (slot === undefined) return { reason: "Malformed entry (missing)" };
  if (!("value" in slot)) return { reason: "Malformed entry (accessor)" };
  const problem = _entryProblem(slot.value, index, previousHash);
  return typeof problem === "string" ? { reason: problem } : { reason: null, integrityHash: problem.integrityHash };
}

/** Why `entry` is invalid (a string), or { integrityHash } when it is valid. */
function _entryProblem(entry, index, previousHash) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "Malformed entry (not an object)";
  const keys = Reflect.ownKeys(entry);
  if (keys.length !== ENTRY_FIELDS.length || !ENTRY_FIELDS.every(field => keys.includes(field))) {
    return "Malformed entry (missing or unexpected fields)";
  }
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  if (ENTRY_FIELDS.some(field => !("value" in descriptors[field]))) return "Malformed entry (accessor field)";
  const e = Object.fromEntries(ENTRY_FIELDS.map(field => [field, descriptors[field].value]));

  if (typeof e.integrityHash === "string" && LEGACY_HASH_PATTERN.test(e.integrityHash)) {
    return "Legacy integrity hash format (sealed before SHA-256; cannot be verified)";
  }
  if (typeof e.integrityHash !== "string" || !HASH_PATTERN.test(e.integrityHash)) return "Malformed integrity hash";
  if (e.sequenceNumber !== index + 1) {
    return `Sequence break (expected #${index + 1}): record deleted, inserted or reordered`;
  }
  if (e.auditId !== _auditIdFor(e.sequenceNumber)) return "Audit ID does not match the sequence number";
  if (typeof e.timestamp !== "string" || Number.isNaN(Date.parse(e.timestamp)) ||
      new Date(e.timestamp).toISOString() !== e.timestamp) {
    return "Invalid timestamp";
  }
  if (typeof e.eventType !== "string" || e.eventType === "") return "Invalid event type";
  if (e.isSealed !== true) return "Entry is not sealed";
  if (e.payload === null || typeof e.payload !== "object" || Array.isArray(e.payload)) return "Payload is not an object";
  let payloadJson;
  try {
    payloadJson = _canonicalJson(e.payload);
  } catch {
    return "Payload is not plain JSON data";
  }
  if (e.previousHash !== previousHash) return "Broken chain link";
  if (e.integrityHash !== _computeIntegrityHash(e, payloadJson)) return "Hash mismatch (tampering detected)";
  return { integrityHash: e.integrityHash };
}

/**
 * Verifies the hash chain, from the first entry, and reports the first invalid entry.
 *   verifyLedgerIntegrity()         -> the ledger held by this module
 *   verifyLedgerIntegrity(entries)  -> a supplied array of entries (e.g. getLedgerEntries() or an export);
 *                                      it is read only, never modified or normalized. Passing `undefined`
 *                                      explicitly is a supplied (invalid) value, not "the module's ledger".
 * Detects malformed entries, sequence breaks (records deleted from the start or middle, inserted, duplicated
 * or reordered), content that no longer matches its hash, and broken links. Does NOT detect a chain re-sealed
 * from the edit onward, or entries removed from or added at the end (see the header). Never throws.
 * @returns {{isValid: boolean, verifiedEntries: number, errorIndex: number|null, reason?: string}}
 */
export function verifyLedgerIntegrity(entries) {
  const chain = arguments.length === 0 ? _ledger : entries;
  let length;
  try {
    if (!Array.isArray(chain)) {
      return { isValid: false, verifiedEntries: 0, errorIndex: null, reason: "Ledger data must be an array of entries" };
    }
    length = chain.length;
  } catch {
    return { isValid: false, verifiedEntries: 0, errorIndex: null, reason: "Ledger data could not be read" };
  }
  let previousHash = GENESIS_HASH;
  for (let i = 0; i < length; i++) {
    let result;
    try {
      result = _checkEntry(chain, i, previousHash);
    } catch {
      result = { reason: "Malformed entry (could not be read)" };
    }
    if (result.reason) return { isValid: false, verifiedEntries: i, errorIndex: i, reason: result.reason };
    previousHash = result.integrityHash;
  }
  return { isValid: true, verifiedEntries: length, errorIndex: null };
}

/**
 * Returns a read-only shallow copy of all ledger entries.
 */
export function getLedgerEntries() {
  return _ledger.map(e => ({ ...e }));
}

/**
 * Query ledger entries with filters
 */
export function queryLedger({ eventType, requestId, hospitalId, limit = 50 } = {}) {
  let results = _ledger;
  if (eventType)   results = results.filter(e => e.eventType === eventType);
  if (requestId)   results = results.filter(e => e.payload.requestId === requestId);
  if (hospitalId)  results = results.filter(e => e.payload.hospitalId === hospitalId);
  return results.slice(-limit).map(e => ({ ...e }));
}

/**
 * Exports the audit trail as a downloadable/parseable CSV string
 */
export function exportLedgerToCsv() {
  const headers = ["Sequence", "AuditID", "Timestamp", "EventType", "IntegrityHash", "PreviousHash", "PayloadSummary"];
  const rows = _ledger.map(e => [
    e.sequenceNumber,
    e.auditId,
    e.timestamp,
    e.eventType,
    e.integrityHash,
    e.previousHash,
    `"${JSON.stringify(e.payload).replace(/"/g, '""')}"`
  ]);
  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/**
 * Returns total count of entries and a summary of events by type.
 */
export function getLedgerStats() {
  const summary = {};
  _ledger.forEach(e => {
    summary[e.eventType] = (summary[e.eventType] || 0) + 1;
  });
  return {
    totalEntries: _ledger.length,
    byEventType: summary,
    oldestEntry: _ledger[0]?.timestamp || null,
    latestEntry: _ledger[_ledger.length - 1]?.timestamp || null,
    chainValid: verifyLedgerIntegrity().isValid
  };
}

/**
 * Seed historical audit data with cryptographic block chain
 */
export function seedHistoricalAuditData() {
  const now = Date.now();
  const seededEvents = [
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8001", emergencyType: "CARDIAC", priority: 1, hospitalId: "H-101" } },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8001", hospitalId: "H-101", resourceType: "ICU_BED" } },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8001", hospitalId: "H-101", responseTimeSec: 28 } },
    { type: EVENT_TYPES.IN_TREATMENT,      p: { requestId: "REQ-8001", hospitalId: "H-101" } },
    { type: EVENT_TYPES.COMPLETED,         p: { requestId: "REQ-8001", hospitalId: "H-101", durationMins: 180 } },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8002", emergencyType: "TRAUMA", priority: 1, hospitalId: "H-103" } },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8002", hospitalId: "H-103", responseTimeSec: 22 } },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8003", emergencyType: "STROKE", priority: 2, hospitalId: "H-101" } },
    { type: EVENT_TYPES.SOFT_LOCK_EXPIRED, p: { requestId: "REQ-8003", hospitalId: "H-101", reason: "90s timeout" } },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8003", hospitalId: "H-103", responseTimeSec: 31 } },
    { type: EVENT_TYPES.STRESS_TEST_RUN,   p: { threads: 100, resource: "ICU_BED", doubleAllocations: 0, passed: true } },
    { type: EVENT_TYPES.BANKERS_SAFE,      p: { safeSequence: ["P0","P2","P1","P3"], resourceVector: [3,3,2,2] } },
    { type: EVENT_TYPES.ROADSIDE_TRIAGE,   p: { location: "Highway 44 - Mile Marker 12", triageLevel: 1, emergencyType: "TRAUMA" } }
  ];

  seededEvents.forEach(ev => appendAuditEntry(ev.type, ev.p));
}

// Initial seed
seedHistoricalAuditData();
