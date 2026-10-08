// server/db/seed.js
// Seeds the in-memory state store from initial data (for environments without MySQL)
// This module provides an in-memory DBMS simulation with SELECT...FOR UPDATE semantics

import { EventEmitter } from 'events';

// ──────────────────────────────────────────────────────────────────────────────
// In-Memory DBMS Store — mirrors the MySQL schema tables
// Used when DB_USE_MEMORY=true (default for demo/dev without MySQL setup)
// ──────────────────────────────────────────────────────────────────────────────

class InMemoryStore extends EventEmitter {
  constructor() {
    super();

    // ── Hospital Table ──
    this.hospitals = [
      { hospital_id: 'H-101', hospital_name: 'Apex City Trauma & Super Specialty Center',
        address: 'Central Medical District, Ave 4', location_lat: 28.6300, location_lng: 77.2180,
        contact_phone: '+91-11-2345-0101', trauma_level: 'Level 1 Comprehensive Trauma Center',
        emergency_status: 'OPEN', acceptance_rate: 0.94, avg_response_sec: 32, rating: 4.8 },
      { hospital_id: 'H-102', hospital_name: 'St. Jude Metro General Hospital',
        address: 'North Sector 12, Parkway', location_lat: 28.6420, location_lng: 77.2250,
        contact_phone: '+91-11-2345-0102', trauma_level: 'Level 2 Emergency Facility',
        emergency_status: 'LIMITED', acceptance_rate: 0.78, avg_response_sec: 54, rating: 4.3 },
      { hospital_id: 'H-103', hospital_name: 'Fortis Cardiac & Neuro Institute',
        address: 'South Expressway, Sector 8', location_lat: 28.6050, location_lng: 77.2020,
        contact_phone: '+91-11-2345-0103', trauma_level: 'Specialized Cardiac & Neuro Emergency Center',
        emergency_status: 'OPEN', acceptance_rate: 0.96, avg_response_sec: 28, rating: 4.9 },
      { hospital_id: 'H-104', hospital_name: 'Memorial Community Healthcare Center',
        address: 'East Ring Road, Block C', location_lat: 28.6380, location_lng: 77.2220,
        contact_phone: '+91-11-2345-0104', trauma_level: 'Level 4 Community Urgent Care Clinic',
        emergency_status: 'OPEN', acceptance_rate: 0.72, avg_response_sec: 68, rating: 3.9 },
      { hospital_id: 'H-105', hospital_name: 'Max Life Emergency & Research Center',
        address: 'West Hub, Technology Corridor', location_lat: 28.6520, location_lng: 77.1650,
        contact_phone: '+91-11-2345-0105', trauma_level: 'Level 1 Multi-Disciplinary Trauma Center',
        emergency_status: 'OPEN', acceptance_rate: 0.91, avg_response_sec: 38, rating: 4.7 },
      { hospital_id: 'H-106', hospital_name: 'Downtown Care Hospital',
        address: 'Old Town, Crossway 3', location_lat: 28.6310, location_lng: 77.2320,
        contact_phone: '+91-11-2345-0106', trauma_level: 'General Hospital (CLOSED - DIVERT)',
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
      { ambulance_id: 'AMB-01', hospital_id: 'H-101', vehicle_number: 'DL-01-EM-0001', ambulance_type: 'ALS', status: 'AVAILABLE',  current_lat: 28.6300, current_lng: 77.2180, eta_mins: 4 },
      { ambulance_id: 'AMB-02', hospital_id: 'H-103', vehicle_number: 'DL-01-EM-0002', ambulance_type: 'ALS', status: 'IN_TRANSIT', current_lat: 28.6180, current_lng: 77.2100, eta_mins: 9 },
      { ambulance_id: 'AMB-03', hospital_id: 'H-102', vehicle_number: 'DL-01-EM-0003', ambulance_type: 'BLS', status: 'AVAILABLE',  current_lat: 28.6420, current_lng: 77.2250, eta_mins: 3 },
      { ambulance_id: 'AMB-04', hospital_id: 'H-105', vehicle_number: 'DL-01-EM-0004', ambulance_type: 'ALS', status: 'AVAILABLE',  current_lat: 28.6520, current_lng: 77.1650, eta_mins: 6 },
      { ambulance_id: 'AMB-05', hospital_id: 'H-104', vehicle_number: 'DL-01-EM-0005', ambulance_type: 'BLS', status: 'MAINTENANCE', current_lat: 28.6380, current_lng: 77.2220, eta_mins: 0 },
    ];

    // ── EmergencyRequest Table ──
    this.emergencyRequests = [
      { request_id: 'REQ-8901', patient_id: 'PAT-001', emergency_type: 'CARDIAC',     priority: 1, status: 'ALLOCATED',     clinical_notes: 'ST-elevation, chest pain', request_time: new Date().toISOString() },
      { request_id: 'REQ-8902', patient_id: 'PAT-002', emergency_type: 'TRAUMA',      priority: 2, status: 'IN_TREATMENT',  clinical_notes: 'Polytrauma from road accident', request_time: new Date().toISOString() },
      { request_id: 'REQ-8903', patient_id: 'PAT-003', emergency_type: 'RESPIRATORY', priority: 3, status: 'WAITING',      clinical_notes: 'SpO2 85%, severe dyspnea', request_time: new Date().toISOString() },
    ];

    // ── Patient Table ──
    this.patients = [
      { patient_id: 'PAT-001', full_name: 'Robert Vance',   age: 58, gender: 'MALE',   emergency_type: 'CARDIAC',     triage_priority: 1 },
      { patient_id: 'PAT-002', full_name: 'Sarah Jenkins',  age: 34, gender: 'FEMALE', emergency_type: 'TRAUMA',      triage_priority: 2 },
      { patient_id: 'PAT-003', full_name: 'David Miller',   age: 45, gender: 'MALE',   emergency_type: 'RESPIRATORY', triage_priority: 3 },
    ];

    // ── ResourceAllocation Table ──
    this.resourceAllocations = [];

    // ── HospitalAcceptance Table ──
    this.hospitalAcceptances = [];

    // ── EmergencyHistory (Audit Ledger) ──
    this.emergencyHistory = [];

    // ── Alerts ──
    this.alerts = [];

    // ── Mutex Lock Map (resource_id -> locked boolean) — OS Mutual Exclusion ──
    this._locks = new Map();
    this._lockQueue = new Map();
  }

  // ──────────────────────────────────────────────────
  // MUTEX — Simulate SELECT ... FOR UPDATE
  // ──────────────────────────────────────────────────
  async acquireResourceLock(resourceId, timeoutMs = 5000) {
    if (!this._locks.has(resourceId)) {
      this._locks.set(resourceId, false);
    }

    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (!this._locks.get(resourceId)) {
          this._locks.set(resourceId, true);
          resolve(() => this._locks.set(resourceId, false));
        } else {
          // Queue for retry
          const timer = setTimeout(() => reject(new Error(`Lock timeout on ${resourceId}`)), timeoutMs);
          const interval = setInterval(() => {
            if (!this._locks.get(resourceId)) {
              clearInterval(interval);
              clearTimeout(timer);
              this._locks.set(resourceId, true);
              resolve(() => this._locks.set(resourceId, false));
            }
          }, 10);
        }
      };
      tryAcquire();
    });
  }

  // Append to immutable audit log
  auditLog(entry) {
    this.emergencyHistory.push({
      history_id: this.emergencyHistory.length + 1,
      event_time: new Date().toISOString(),
      ...entry
    });
    this.emit('audit', entry);
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
