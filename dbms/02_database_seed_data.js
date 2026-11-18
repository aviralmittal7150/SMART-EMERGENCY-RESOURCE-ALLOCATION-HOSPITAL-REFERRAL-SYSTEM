// server/db/seed.js
// Seeds the in-memory state store from initial data (for environments without MySQL)
// This module provides an in-memory DBMS simulation with SELECT...FOR UPDATE semantics

import { EventEmitter } from 'events';
import { LOCALITIES } from '../services/operatingArea.js';
import { noteLockAcquired, noteLockReleased } from '../services/lockOrder.js';
import { singleStageClaim, claimRows } from '../services/clinicalPathways.js';
import { chainEntries, verifyLedger, normalizeAuditEntry, GENESIS_HASH } from '../services/auditChain.js';
import { demoUserRows } from './demoUsers.js';
import {
  DEMO_ACCEPTANCES, DEMO_ALLOCATIONS, DEMO_ASSIGNMENTS, DEMO_DOCTOR_STATUS, DEMO_UNIT_ASSIGNMENTS, DEMO_UNIT_BASE_STATUS, DEMO_AUDIT_EVENTS
} from './demoLifecycle.js';

// ──────────────────────────────────────────────────────────────────────────────
// In-Memory DBMS Store — mirrors the MySQL schema tables
// Used when DB_USE_MEMORY=true (default for demo/dev without MySQL setup)
// ──────────────────────────────────────────────────────────────────────────────

class InMemoryStore extends EventEmitter {
  constructor() {
    super();

    // ── Hospital Table ──
    // Batch 8 (P-0.1): Dehradun. FICTIONAL demo hospitals (no real facility or brand) placed at verified locality centre
    // points (server/services/operatingArea.js LOCALITIES, OpenStreetMap Nominatim), never at real hospital addresses.
    const at = (key, dLat = 0, dLng = 0) => ({ location_lat: Number((LOCALITIES[key].lat + dLat).toFixed(4)), location_lng: Number((LOCALITIES[key].lng + dLng).toFixed(4)) });
    this.hospitals = [
      { hospital_id: 'H-101', hospital_name: 'Clock Tower Trauma Centre (demo)',
        address: 'Clock Tower area, Dehradun (fictional demo facility)', ...at('CLOCK_TOWER'),
        contact_phone: '+91-135-000-0101', trauma_level: 'Level 1 Comprehensive Trauma Center',
        emergency_status: 'OPEN', acceptance_rate: 0.94, avg_response_sec: 32, rating: 4.8 },
      { hospital_id: 'H-102', hospital_name: 'Rajpur Road General (demo)',
        address: 'Rajpur Road, Dehradun (fictional demo facility)', ...at('RAJPUR_ROAD'),
        contact_phone: '+91-135-000-0102', trauma_level: 'Level 2 Emergency Facility',
        emergency_status: 'LIMITED', acceptance_rate: 0.78, avg_response_sec: 54, rating: 4.3 },
      { hospital_id: 'H-103', hospital_name: 'Premnagar Heart & Neuro (demo)',
        address: 'Premnagar, Dehradun (fictional demo facility)', ...at('PREM_NAGAR'),
        contact_phone: '+91-135-000-0103', trauma_level: 'Specialized Cardiac & Neuro Emergency Center',
        emergency_status: 'OPEN', acceptance_rate: 0.96, avg_response_sec: 28, rating: 4.9 },
      { hospital_id: 'H-104', hospital_name: 'Clement Town Community Clinic (demo)',
        address: 'Clement Town, Dehradun (fictional demo facility)', ...at('CLEMENT_TOWN'),
        contact_phone: '+91-135-000-0104', trauma_level: 'Level 4 Community Urgent Care Clinic',
        emergency_status: 'OPEN', acceptance_rate: 0.72, avg_response_sec: 68, rating: 3.9 },
      { hospital_id: 'H-105', hospital_name: 'Sahastradhara Emergency Centre (demo)',
        address: 'Sahastradhara Road, Dehradun (fictional demo facility)', ...at('SAHASTRADHARA_ROAD'),
        contact_phone: '+91-135-000-0105', trauma_level: 'Level 1 Multi-Disciplinary Trauma Center',
        emergency_status: 'OPEN', acceptance_rate: 0.91, avg_response_sec: 38, rating: 4.7 },
      { hospital_id: 'H-106', hospital_name: 'ISBT Care Hospital (demo)',
        address: 'ISBT area, Dehradun (fictional demo facility)', ...at('ISBT'),
        contact_phone: '+91-135-000-0106', trauma_level: 'General Hospital (CLOSED - DIVERT)',
        emergency_status: 'CLOSED', acceptance_rate: 0.50, avg_response_sec: 95, rating: 3.4 }
    ];

    // ── MedicalResource Table ──
    this.medicalResources = [
      // H-101
      { resource_id: 'RES-101-ICU', hospital_id: 'H-101', resource_type: 'ICU_BED',    total_capacity: 20, available_capacity: 4,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-101-VNT', hospital_id: 'H-101', resource_type: 'VENTILATOR', total_capacity: 15, available_capacity: 3,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-101-OT',  hospital_id: 'H-101', resource_type: 'OT',         total_capacity: 6,  available_capacity: 2,  locked_capacity: 0, version_lock: 0 },
      // H-102
      { resource_id: 'RES-102-ICU', hospital_id: 'H-102', resource_type: 'ICU_BED',    total_capacity: 12, available_capacity: 1,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-102-VNT', hospital_id: 'H-102', resource_type: 'VENTILATOR', total_capacity: 8,  available_capacity: 1,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-102-OT',  hospital_id: 'H-102', resource_type: 'OT',         total_capacity: 3,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
      // H-103
      { resource_id: 'RES-103-ICU', hospital_id: 'H-103', resource_type: 'ICU_BED',    total_capacity: 25, available_capacity: 8,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-103-VNT', hospital_id: 'H-103', resource_type: 'VENTILATOR', total_capacity: 18, available_capacity: 6,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-103-OT',  hospital_id: 'H-103', resource_type: 'OT',         total_capacity: 8,  available_capacity: 4,  locked_capacity: 0, version_lock: 0 },
      // H-104
      { resource_id: 'RES-104-ICU', hospital_id: 'H-104', resource_type: 'ICU_BED',    total_capacity: 6,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-104-VNT', hospital_id: 'H-104', resource_type: 'VENTILATOR', total_capacity: 3,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-104-OT',  hospital_id: 'H-104', resource_type: 'OT',         total_capacity: 1,  available_capacity: 1,  locked_capacity: 0, version_lock: 0 },
      // H-105
      { resource_id: 'RES-105-ICU', hospital_id: 'H-105', resource_type: 'ICU_BED',    total_capacity: 18, available_capacity: 5,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-105-VNT', hospital_id: 'H-105', resource_type: 'VENTILATOR', total_capacity: 12, available_capacity: 4,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-105-OT',  hospital_id: 'H-105', resource_type: 'OT',         total_capacity: 5,  available_capacity: 3,  locked_capacity: 0, version_lock: 0 },
      // H-106
      { resource_id: 'RES-106-ICU', hospital_id: 'H-106', resource_type: 'ICU_BED',    total_capacity: 8,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-106-VNT', hospital_id: 'H-106', resource_type: 'VENTILATOR', total_capacity: 4,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
      { resource_id: 'RES-106-OT',  hospital_id: 'H-106', resource_type: 'OT',         total_capacity: 2,  available_capacity: 0,  locked_capacity: 0, version_lock: 0 },
    ];

    // ── Doctor Table ──
    this.doctors = [
      { doctor_id: 'DR-001', hospital_id: 'H-101', full_name: 'Dr. Arjun Mehta',    specialization: 'CARDIOLOGIST',   availability_status: 'AVAILABLE',   shift_start: '08:00', shift_end: '20:00' },
      { doctor_id: 'DR-002', hospital_id: 'H-101', full_name: 'Dr. Priya Sharma',   specialization: 'NEUROLOGIST',    availability_status: 'IN_PROCEDURE', shift_start: '08:00', shift_end: '20:00' },
      { doctor_id: 'DR-003', hospital_id: 'H-101', full_name: 'Dr. Kabir Singh',    specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE',   shift_start: '20:00', shift_end: '08:00' },
      { doctor_id: 'DR-004', hospital_id: 'H-101', full_name: 'Dr. Nisha Patel',    specialization: 'PEDIATRICIAN',   availability_status: 'AVAILABLE',   shift_start: '08:00', shift_end: '20:00' },
      { doctor_id: 'DR-005', hospital_id: 'H-102', full_name: 'Dr. Rajan Verma',    specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE',   shift_start: '09:00', shift_end: '21:00' },
      { doctor_id: 'DR-006', hospital_id: 'H-103', full_name: 'Dr. Suresh Iyer',    specialization: 'CARDIOLOGIST',   availability_status: 'AVAILABLE',   shift_start: '07:00', shift_end: '19:00' },
      { doctor_id: 'DR-007', hospital_id: 'H-103', full_name: 'Dr. Anika Bose',     specialization: 'NEUROLOGIST',    availability_status: 'AVAILABLE',   shift_start: '07:00', shift_end: '19:00' },
      { doctor_id: 'DR-008', hospital_id: 'H-103', full_name: 'Dr. Yusuf Khan',     specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE',   shift_start: '07:00', shift_end: '19:00' },
      { doctor_id: 'DR-009', hospital_id: 'H-103', full_name: 'Dr. Sunita Rao',     specialization: 'PEDIATRICIAN',   availability_status: 'OFF_DUTY',    shift_start: '19:00', shift_end: '07:00' },
      { doctor_id: 'DR-010', hospital_id: 'H-104', full_name: 'Dr. Meera Krishnan', specialization: 'PEDIATRICIAN',   availability_status: 'AVAILABLE',   shift_start: '09:00', shift_end: '21:00' },
      { doctor_id: 'DR-011', hospital_id: 'H-105', full_name: 'Dr. Vikram Joshi',   specialization: 'CARDIOLOGIST',   availability_status: 'AVAILABLE',   shift_start: '08:00', shift_end: '20:00' },
      { doctor_id: 'DR-012', hospital_id: 'H-105', full_name: 'Dr. Deepa Nair',     specialization: 'NEUROLOGIST',    availability_status: 'IN_PROCEDURE', shift_start: '08:00', shift_end: '20:00' },
      { doctor_id: 'DR-013', hospital_id: 'H-105', full_name: 'Dr. Rohan Gupta',    specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE',   shift_start: '08:00', shift_end: '20:00' },
    ];

    // ── Ambulance Table ──
    this.ambulances = [
      // Units are stationed across the verified Dehradun localities (so the nearest free unit is typically 1-5 km away);
      // AMB-02 is on the road between Premnagar and the city centre, as in its demo case.
      { ambulance_id: 'AMB-01', hospital_id: 'H-101', vehicle_number: 'UK-07-EM-0001', ambulance_type: 'ALS', status: 'AVAILABLE',  current_lat: at('CLOCK_TOWER').location_lat, current_lng: at('CLOCK_TOWER').location_lng, eta_mins: 4 },
      { ambulance_id: 'AMB-02', hospital_id: 'H-103', vehicle_number: 'UK-07-EM-0002', ambulance_type: 'ALS', status: 'IN_TRANSIT', current_lat: 30.3300, current_lng: 78.0000, eta_mins: 9 },
      { ambulance_id: 'AMB-03', hospital_id: 'H-102', vehicle_number: 'UK-07-EM-0003', ambulance_type: 'BLS', status: 'AVAILABLE',  current_lat: at('RAJPUR_ROAD').location_lat, current_lng: at('RAJPUR_ROAD').location_lng, eta_mins: 3 },
      { ambulance_id: 'AMB-04', hospital_id: 'H-105', vehicle_number: 'UK-07-EM-0004', ambulance_type: 'ALS', status: 'AVAILABLE',  current_lat: at('SAHASTRADHARA_ROAD').location_lat, current_lng: at('SAHASTRADHARA_ROAD').location_lng, eta_mins: 6 },
      { ambulance_id: 'AMB-05', hospital_id: 'H-104', vehicle_number: 'UK-07-EM-0005', ambulance_type: 'BLS', status: 'MAINTENANCE', current_lat: at('CLEMENT_TOWN').location_lat, current_lng: at('CLEMENT_TOWN').location_lng, eta_mins: 0 },
      { ambulance_id: 'AMB-06', hospital_id: 'H-106', vehicle_number: 'UK-07-EM-0006', ambulance_type: 'BLS', status: 'AVAILABLE',  current_lat: at('ISBT').location_lat, current_lng: at('ISBT').location_lng, eta_mins: 5 },
      { ambulance_id: 'AMB-07', hospital_id: 'H-103', vehicle_number: 'UK-07-EM-0007', ambulance_type: 'ALS', status: 'AVAILABLE',  current_lat: at('PREM_NAGAR').location_lat, current_lng: at('PREM_NAGAR').location_lng, eta_mins: 5 },
    ];

    // ── EmergencyRequest Table ──
    // is_demo = 1: fictional demo cases, excluded from observed analytics (migration 007; docs/analytics.md).
    // With NODE_ENV=production there are no demo cases and no demo history at all (like `db:seed` on MySQL): only the
    // hospitals, resources, doctors and units. updated_at = the time of the case's last recorded event (the seed time).
    const demoCases = process.env.NODE_ENV !== 'production';
    const seededAt = new Date().toISOString();
    this.emergencyRequests = !demoCases ? [] : [
      { request_id: 'REQ-8901', is_demo: 1, patient_id: 'PAT-001', emergency_type: 'CARDIAC',     required_resource_types: ['ICU_BED', 'VENTILATOR'], required_specialist: 'CARDIOLOGIST', priority: 1, status: 'ALLOCATED',     clinical_notes: 'ST-elevation, chest pain', request_time: seededAt, updated_at: seededAt },
      { request_id: 'REQ-8902', is_demo: 1, patient_id: 'PAT-002', emergency_type: 'TRAUMA',      required_resource_types: ['ICU_BED', 'OT'], required_specialist: 'TRAUMA_SURGEON', priority: 2, status: 'IN_TREATMENT',  clinical_notes: 'Polytrauma from road accident', request_time: seededAt, updated_at: seededAt },
      { request_id: 'REQ-8903', is_demo: 1, patient_id: 'PAT-003', emergency_type: 'RESPIRATORY', required_resource_types: ['ICU_BED', 'VENTILATOR'], required_specialist: null, priority: 3, status: 'WAITING',      clinical_notes: 'SpO2 85%, severe dyspnea', request_time: seededAt, updated_at: seededAt },
    ];

    // ── Patient Table ──
    this.patients = !demoCases ? [] : [
      { patient_id: 'PAT-001', full_name: 'Robert Vance',   age: 58, gender: 'MALE',   emergency_type: 'CARDIAC',     triage_priority: 1 },
      { patient_id: 'PAT-002', full_name: 'Sarah Jenkins',  age: 34, gender: 'FEMALE', emergency_type: 'TRAUMA',      triage_priority: 2 },
      { patient_id: 'PAT-003', full_name: 'David Miller',   age: 45, gender: 'MALE',   emergency_type: 'RESPIRATORY', triage_priority: 3 },
    ];

    // ── ResourceAllocation Table ──
    // The demo cases' recorded history (server/db/demoLifecycle.js; the same as the MySQL demo seed); none in production.
    this.resourceAllocations = !demoCases ? [] : DEMO_ALLOCATIONS.map(a => ({ ...a, status: 'COMMITTED', stage_no: 1, allocated_at: seededAt }));

    // ── HospitalAcceptance Table ──
    this.hospitalAcceptances = !demoCases ? [] : DEMO_ACCEPTANCES.map(a => ({
      ...a, rejection_reason: null, lock_expires_at: seededAt, responded_at: seededAt, created_at: seededAt, initiated_by: null
    }));

    // ── EmergencyHistory (Audit Ledger) ──
    this.emergencyHistory = [];

    // ── Alerts ──
    this.alerts = [];

    // ── SystemUser Table (bcrypt hashes only; the fictional demo accounts, flagged is_demo) ──
    this.systemUsers = demoUserRows();

    // ── DoctorAssignment Table (exclusive specialist reservations, Phase 3 Step 3) ──
    this.doctorAssignments = !demoCases ? [] : DEMO_ASSIGNMENTS.map(a => ({
      ...a, stage_no: 1, status: 'COMMITTED', reserved_at: seededAt, committed_at: seededAt, released_at: null
    }));
    for (const [doctorId, status] of Object.entries(demoCases ? DEMO_DOCTOR_STATUS : {})) this.doctors.find(d => d.doctor_id === doctorId).availability_status = status;
    // Without the demo history, units start from their pre-history status (AMB-02 at its station).
    for (const [unitId, status] of Object.entries(demoCases ? {} : DEMO_UNIT_BASE_STATUS)) this.ambulances.find(a => a.ambulance_id === unitId).status = status;
    for (const u of demoCases ? DEMO_UNIT_ASSIGNMENTS : []) {
      Object.assign(this.ambulances.find(a => a.ambulance_id === u.ambulance_id),
        { status: u.status, assigned_request_id: u.request_id, destination_hospital_id: u.destination_hospital_id });
    }

    // ── RequestClaim Table (staged maximum claims, Phase 3 Step 4) ──
    // Open demo cases get the single-stage claim migration 005 gives every open case (D2-a10).
    this.requestClaims = this.emergencyRequests
      .filter(r => !['COMPLETED', 'CANCELLED'].includes(r.status))
      .flatMap(r => claimRows(singleStageClaim(r.required_resource_types || [], r.required_specialist))
        .map(row => ({ request_id: r.request_id, ...row })));

    // ── AmbulanceTrip Table (migration 010): simulated live-tracking trips; none seeded ──
    this.ambulanceTrips = [];

    // ── Incident Table (migration 011): mass-casualty incidents; EmergencyRequest.incident_id links their cases ──
    this.incidents = [];
    // ── TreatmentUpdate (migration 011): hospital progress notes; AmbulanceAssignment: one row per patient a unit carries ──
    this.treatmentUpdates = [];
    this.ambulanceAssignments = [];
    // Ambulance.capacity (migration 011): patients a unit may carry, 1 unless configured.
    for (const unit of this.ambulances) unit.capacity ??= 1;

    // ── Audit-chain write counter (AC9; in memory an append is synchronous, so there is no lock wait to time) ──
    this.auditStats = { rows: 0 };

    // ── Mutexes ('resource:<id>' / 'hospital:<id>' -> { held, waiters[] }) — OS Mutual Exclusion ──
    this._mutexes = new Map();

    // Last: the demo history goes through the normal chained audit path, so the ledger verifies from the start.
    for (const entry of demoCases ? DEMO_AUDIT_EVENTS : []) this.auditLog(entry);
  }

  // ──────────────────────────────────────────────────
  // MUTEX — Simulate SELECT ... FOR UPDATE (see docs/lock-order.md)
  // Arrival-ordered (FIFO): waiters are granted strictly in the order they asked, and a release hands
  // ownership directly to the next waiter, so a newcomer can never barge past a queued request.
  // The returned release function is idempotent: a second call can never free a lock that has
  // already been handed to someone else. A waiter that times out leaves the queue without the lock.
  // ──────────────────────────────────────────────────
  /** Row lock on one resource (lock level 4). */
  async acquireResourceLock(resourceId, timeoutMs = 5000) {
    const lockKey = this.medicalResources.find(r => r.resource_id === resourceId)?.resource_type ?? resourceId;
    return this._acquireMutex(`resource:${resourceId}`, 'MedicalResource', lockKey, resourceId, timeoutMs);
  }

  /** The per-hospital lock (lock level 2): serialises operations that change one hospital's capacity or doctors. */
  async acquireHospitalLock(hospitalId, timeoutMs = 5000) {
    return this._acquireMutex(`hospital:${hospitalId}`, 'Hospital', hospitalId, hospitalId, timeoutMs);
  }

  /** True while the hospital's mutex is held (diagnostics and tests). */
  isHospitalLockHeld(hospitalId) {
    return Boolean(this._mutexes.get(`hospital:${hospitalId}`)?.held);
  }

  async _acquireMutex(mutexKey, lockTable, lockKey, label, timeoutMs) {
    let mutex = this._mutexes.get(mutexKey);
    if (!mutex) {
      mutex = { held: false, waiters: [] };
      this._mutexes.set(mutexKey, mutex);
    }
    const resourceId = label;

    if (mutex.held) {
      // Wait for a releaser to hand the lock over (`held` stays true across the hand-over).
      await new Promise((resolve, reject) => {
        const waiter = {
          grant: () => {
            clearTimeout(waiter.timer);
            resolve();
          }
        };
        waiter.timer = setTimeout(() => {
          const index = mutex.waiters.indexOf(waiter);
          if (index >= 0) mutex.waiters.splice(index, 1);
          reject(new Error(`Lock timeout on ${resourceId}`));
        }, timeoutMs);
        mutex.waiters.push(waiter);
      });
    } else {
      mutex.held = true;
    }

    // Recorded here, in the acquirer's own async context (not the releaser's).
    noteLockAcquired(lockTable, lockKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      noteLockReleased(lockTable, lockKey);
      const next = mutex.waiters.shift();
      if (next) next.grant(); // ownership passes straight to the next waiter
      else mutex.held = false;
    };
  }

  // Append to immutable audit log
  /**
   * Append an audit record, chained (Phase 3 Step 5): the next chain_seq, the previous row's hash and a SHA-256 over
   * the canonical record (server/services/auditChain.js). Synchronous, so this is the commit point and appends are
   * totally ordered. The head is simply the last chained row, so emptying the array restarts the chain at genesis.
   */
  auditLog(entry) {
    // Non-scalar fields are refused before anything is appended (A6), with the same rules as the MySQL engine's _audit.
    const fields = normalizeAuditEntry(entry);
    const last = this.emergencyHistory.findLast(h => h.chain_seq != null);
    const head = last ? { chain_seq: last.chain_seq, hash: last.row_hash } : { chain_seq: 0, hash: GENESIS_HASH };
    const eventTimeMs = Date.now();
    // event_time is the ISO form of the hashed millisecond, so Date.parse(event_time) === event_time_ms.
    const { rows: [row] } = chainEntries(head, [{ ...fields, event_time_ms: eventTimeMs, event_time: new Date(eventTimeMs).toISOString() }]);
    const stored = { history_id: this.emergencyHistory.length + 1, ...row };
    this.emergencyHistory.push(stored);
    this.auditStats.rows += 1;
    this.emit('audit', stored);
  }

  /**
   * Full-chain verification of the in-memory ledger (AC8). Its head is the last row, so a cut tail is not detectable
   * here. Same checks as MySQL: the displayed event_time against the hashed millisecond (A2), and unchained rows
   * stored after the first chained row are a break (A3); those before it are legacy.
   */
  verifyAuditChain() {
    const firstChained = this.emergencyHistory.findIndex(h => h.chain_seq != null);
    const unchained = (h, i) => h.chain_seq == null && (firstChained < 0 || i < firstChained);
    const chained = this.emergencyHistory.filter(h => h.chain_seq != null).map(h => ({
      ...h, event_time_check_ms: h.event_time instanceof Date ? h.event_time.getTime() : Date.parse(h.event_time)
    }));
    return verifyLedger({
      chained,
      legacyUnchained: this.emergencyHistory.filter(unchained).length,
      unchainedAfterChain: firstChained < 0 ? [] : this.emergencyHistory.filter((h, i) => i > firstChained && h.chain_seq == null)
    });
  }

  getHospitalResources(hospitalId) {
    return this.medicalResources.filter(r => r.hospital_id === hospitalId);
  }

  getDoctors(hospitalId) {
    return this.doctors.filter(d => d.hospital_id === hospitalId);
  }
}

export const db = new InMemoryStore();
export default db;
