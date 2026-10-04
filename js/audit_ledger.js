// ============================================================
// P3-04: Immutable Medical Audit Ledger (DBMS Append-Only Log)
// Every state transition is timestamped and sealed — no edits, no deletes.
// Models the ACID "durability" guarantee for medico-legal traceability.
// ============================================================

let _ledger = []; // private append-only store
let _sequenceCounter = 1;

const EVENT_TYPES = {
  REQUEST_CREATED:   "REQUEST_CREATED",
  TRIAGE_ASSIGNED:   "TRIAGE_ASSIGNED",
  MATCHING_STARTED:  "MATCHING_STARTED",
  SOFT_LOCK_PLACED:  "SOFT_LOCK_PLACED",
  SOFT_LOCK_EXPIRED: "SOFT_LOCK_EXPIRED",
  REFERRAL_ACCEPTED: "REFERRAL_ACCEPTED",
  REFERRAL_REJECTED: "REFERRAL_REJECTED",
  AMBULANCE_DISPATCHED: "AMBULANCE_DISPATCHED",
  IN_TREATMENT:      "IN_TREATMENT",
  COMPLETED:         "COMPLETED",
  RESOURCE_RELEASED: "RESOURCE_RELEASED",
  ROADSIDE_TRIAGE:   "ROADSIDE_TRIAGE",
  PRE_ALERT_SENT:    "PRE_ALERT_SENT",
  STRESS_TEST_RUN:   "STRESS_TEST_RUN",
  BANKERS_SAFE:      "BANKERS_SAFE",
  BANKERS_UNSAFE:    "BANKERS_UNSAFE"
};

/**
 * Appends an immutable audit entry. Once written, entries cannot be modified or deleted.
 * @param {string} eventType - One of EVENT_TYPES
 * @param {Object} payload - Contextual data for this event
 * @returns {Object} The sealed audit entry
 */
function appendAuditEntry(eventType, payload = {}) {
  const entry = Object.freeze({
    auditId:   `AUD-${String(_sequenceCounter++).padStart(5, "0")}`,
    timestamp: new Date().toISOString(),
    eventType,
    payload:   Object.freeze({ ...payload }),
    checksum:  _computeChecksum(eventType, payload)
  });

  _ledger.push(entry);
  return entry;
}

/**
 * Simple deterministic checksum for tamper detection (not cryptographic — academic demo).
 */
function _computeChecksum(eventType, payload) {
  const raw = eventType + JSON.stringify(payload) + _sequenceCounter;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `CRC-${Math.abs(hash).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Returns a read-only shallow copy of all ledger entries (no mutation possible).
 */
function getLedgerEntries() {
  return _ledger.map(e => ({ ...e }));
}

/**
 * Returns entries filtered by eventType, requestId, or hospitalId.
 */
function queryLedger({ eventType, requestId, hospitalId, limit = 50 } = {}) {
  let results = _ledger;
  if (eventType)   results = results.filter(e => e.eventType === eventType);
  if (requestId)   results = results.filter(e => e.payload.requestId === requestId);
  if (hospitalId)  results = results.filter(e => e.payload.hospitalId === hospitalId);
  return results.slice(-limit).map(e => ({ ...e }));
}

/**
 * Returns total count of entries and a summary of events by type.
 */
function getLedgerStats() {
  const summary = {};
  _ledger.forEach(e => {
    summary[e.eventType] = (summary[e.eventType] || 0) + 1;
  });
  return {
    totalEntries: _ledger.length,
    byEventType: summary,
    oldestEntry: _ledger[0]?.timestamp || null,
    latestEntry: _ledger[_ledger.length - 1]?.timestamp || null
  };
}

/**
 * Seed the ledger with realistic historical entries for demo (P3-03 analytics support)
 */
function seedHistoricalAuditData() {
  const now = Date.now();
  const seededEvents = [
    // Last 24 hours of activity
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8001", emergencyType: "CARDIAC",     priority: 1, hospitalId: "H-101" }, offsetMins: 1440 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8001", hospitalId: "H-101", resourceType: "ICU_BED" }, offsetMins: 1438 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8001", hospitalId: "H-101", responseTimeSec: 28 }, offsetMins: 1437 },
    { type: EVENT_TYPES.IN_TREATMENT,      p: { requestId: "REQ-8001", hospitalId: "H-101" }, offsetMins: 1415 },
    { type: EVENT_TYPES.COMPLETED,         p: { requestId: "REQ-8001", hospitalId: "H-101", durationMins: 180 }, offsetMins: 1200 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8002", emergencyType: "TRAUMA",      priority: 1, hospitalId: "H-103" }, offsetMins: 1380 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8002", hospitalId: "H-103", resourceType: "EMERGENCY_OT" }, offsetMins: 1378 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8002", hospitalId: "H-103", responseTimeSec: 22 }, offsetMins: 1377 },
    { type: EVENT_TYPES.IN_TREATMENT,      p: { requestId: "REQ-8002", hospitalId: "H-103" }, offsetMins: 1360 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8003", emergencyType: "STROKE",      priority: 2, hospitalId: "H-101" }, offsetMins: 1300 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8003", hospitalId: "H-101" }, offsetMins: 1298 },
    { type: EVENT_TYPES.SOFT_LOCK_EXPIRED, p: { requestId: "REQ-8003", hospitalId: "H-101", reason: "90s timeout" }, offsetMins: 1296 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8003", hospitalId: "H-103", resourceType: "ICU_BED" }, offsetMins: 1295 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8003", hospitalId: "H-103", responseTimeSec: 31 }, offsetMins: 1294 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8004", emergencyType: "RESPIRATORY",  priority: 2, hospitalId: "H-105" }, offsetMins: 1200 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8004", hospitalId: "H-105", responseTimeSec: 44 }, offsetMins: 1198 },
    { type: EVENT_TYPES.IN_TREATMENT,      p: { requestId: "REQ-8004", hospitalId: "H-105" }, offsetMins: 1180 },
    { type: EVENT_TYPES.COMPLETED,         p: { requestId: "REQ-8004", hospitalId: "H-105", durationMins: 120 }, offsetMins: 1060 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8005", emergencyType: "TRAUMA",      priority: 1, hospitalId: "H-103" }, offsetMins: 1100 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8005", hospitalId: "H-103", responseTimeSec: 18 }, offsetMins: 1098 },
    { type: EVENT_TYPES.REFERRAL_REJECTED, p: { requestId: "REQ-8006", hospitalId: "H-104", reason: "No ICU beds" }, offsetMins: 980 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8006", emergencyType: "PEDIATRIC",   priority: 2, hospitalId: "H-104" }, offsetMins: 980 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8006", hospitalId: "H-101" }, offsetMins: 978 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8006", hospitalId: "H-101", responseTimeSec: 52 }, offsetMins: 977 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8007", emergencyType: "CARDIAC",     priority: 1, hospitalId: "H-101" }, offsetMins: 840 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8007", hospitalId: "H-101", responseTimeSec: 26 }, offsetMins: 838 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8008", emergencyType: "TRAUMA",      priority: 1, hospitalId: "H-103" }, offsetMins: 720 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8008", hospitalId: "H-103", responseTimeSec: 19 }, offsetMins: 718 },
    { type: EVENT_TYPES.IN_TREATMENT,      p: { requestId: "REQ-8008", hospitalId: "H-103" }, offsetMins: 700 },
    { type: EVENT_TYPES.COMPLETED,         p: { requestId: "REQ-8008", hospitalId: "H-103", durationMins: 90 }, offsetMins: 610 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8009", emergencyType: "RESPIRATORY",  priority: 2, hospitalId: "H-105" }, offsetMins: 600 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8009", hospitalId: "H-105", responseTimeSec: 38 }, offsetMins: 598 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8010", emergencyType: "CARDIAC",     priority: 1, hospitalId: "H-103" }, offsetMins: 480 },
    { type: EVENT_TYPES.REFERRAL_REJECTED, p: { requestId: "REQ-8010", hospitalId: "H-106", reason: "Hospital CLOSED" }, offsetMins: 479 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8010", hospitalId: "H-103", responseTimeSec: 30 }, offsetMins: 478 },
    { type: EVENT_TYPES.STRESS_TEST_RUN,   p: { threads: 50, resource: "ICU_BED", doubleAllocations: 0, passed: true }, offsetMins: 360 },
    { type: EVENT_TYPES.BANKERS_SAFE,      p: { safeSequence: ["P0","P2","P1","P3"], resourceVector: [3,3,2] }, offsetMins: 300 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8011", emergencyType: "TRAUMA",      priority: 1, hospitalId: "H-101" }, offsetMins: 240 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8011", hospitalId: "H-101", responseTimeSec: 33 }, offsetMins: 238 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8012", emergencyType: "STROKE",      priority: 2, hospitalId: "H-103" }, offsetMins: 120 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8012", hospitalId: "H-103", responseTimeSec: 25 }, offsetMins: 118 },
    { type: EVENT_TYPES.REQUEST_CREATED,   p: { requestId: "REQ-8013", emergencyType: "CARDIAC",     priority: 1, hospitalId: "H-101" }, offsetMins: 60 },
    { type: EVENT_TYPES.SOFT_LOCK_PLACED,  p: { requestId: "REQ-8013", hospitalId: "H-101" }, offsetMins: 58 },
    { type: EVENT_TYPES.REFERRAL_ACCEPTED, p: { requestId: "REQ-8013", hospitalId: "H-101", responseTimeSec: 21 }, offsetMins: 57 },
    { type: EVENT_TYPES.ROADSIDE_TRIAGE,   p: { location: "Highway 44 - Mile Marker 12", triageLevel: 1, emergencyType: "TRAUMA" }, offsetMins: 30 }
  ];

  seededEvents.forEach(ev => {
    const fakeTime = new Date(now - ev.offsetMins * 60 * 1000).toISOString();
    const entry = Object.freeze({
      auditId:   `AUD-${String(_sequenceCounter++).padStart(5, "0")}`,
      timestamp: fakeTime,
      eventType: ev.type,
      payload:   Object.freeze(ev.p),
      checksum:  _computeChecksum(ev.type, ev.p)
    });
    _ledger.push(entry);
  });
}

// Auto-seed on module load
seedHistoricalAuditData();

export {
  EVENT_TYPES,
  appendAuditEntry,
  getLedgerEntries,
  queryLedger,
  getLedgerStats
};
