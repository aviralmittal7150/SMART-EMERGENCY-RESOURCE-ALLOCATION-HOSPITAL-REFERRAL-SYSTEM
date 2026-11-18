// server/routes/hospitals.js
// Hospital & Resource Management API

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { canManageHospital, canReadHospitalDetail, canReadHospitalPatients } from '../services/accessPolicy.js';
import { validateBody, validateQuery } from '../services/validation.js';

const router = express.Router();

const HOSPITAL_STATUSES = ['OPEN', 'LIMITED', 'CLOSED'];
const SPECIALIZATIONS = ['CARDIOLOGIST', 'NEUROLOGIST', 'TRAUMA_SURGEON', 'PEDIATRICIAN', 'GENERAL_ER'];
// MedicalResource capacities are INT columns: strict non-negative whole numbers (X7).
const CAPACITY = { type: 'integer', min: 0, max: 2_147_483_647 };

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals
// All hospitals with their current resource state. Every role gets the public summary used for recommendation
// (capacity counts and specialist availability counts); the doctor roster only for the hospitals the caller manages
// (admins: all; a desk: its own). See server/services/accessPolicy.js.
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, validateQuery({ status: { type: 'enum', values: HOSPITAL_STATUSES, upper: true } }), async (req, res) => {
  const [hospitals, resources, doctors] = await Promise.all([
    store.listHospitals({ status: req.validQuery.status }),
    store.listResources(),
    store.listDoctors()
  ]);

  const result = hospitals.map(h => {
    const hospitalDoctors = doctors.filter(d => d.hospital_id === h.hospital_id);
    const summary = {
      ...h,
      resources: buildResourceSummary(resources.filter(r => r.hospital_id === h.hospital_id)),
      specialists: buildSpecialistSummary(hospitalDoctors),
      specialists_available: buildSpecialistCounts(hospitalDoctors)
    };
    return canReadHospitalDetail(req.user, h.hospital_id) ? { ...summary, doctors: buildDoctorSummary(hospitalDoctors) } : summary;
  });

  res.json({ success: true, count: result.length, hospitals: result });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/overview   (Batch 8, ADMIN only: the read-only operational view of every hospital)
// -> { success, generated_at, hospitals: [{ hospital_id, hospital_name, emergency_status,
//      resources: { <TYPE>: { total, available, reserved, occupied } },   available = free now (not soft-locked),
//                                                                         reserved = soft-locked by pending referrals,
//                                                                         occupied = committed to accepted cases
//      doctors: { <SPECIALIZATION>: { total, available } },
//      referrals_24h: { pending, accepted, rejected, expired, cancelled }, (referrals created in the last 24 h)
//      active_cases: { allocated, arrived, in_treatment },               (allocated = not yet arrived)
//      completed_24h }] }
// ────────────────────────────────────────────────────────────
router.get('/overview', authenticate, authorize('ADMIN'), async (req, res) => {
  const [hospitals, resources, doctors, occupied, acceptances] = await Promise.all([
    store.listHospitals(), store.listResources(), store.listDoctors(), store.countCommittedAllocations(), store.listAcceptances()
  ]);
  const since = Date.now() - 24 * 3_600_000;
  const overview = [];
  for (const h of hospitals) {
    const patients = await store.listHospitalPatients(h.hospital_id);
    const resourceView = {};
    for (const r of resources.filter(x => x.hospital_id === h.hospital_id)) {
      resourceView[r.resource_type] = {
        total: r.total_capacity,
        available: Math.max(0, r.available_capacity - r.locked_capacity),
        reserved: r.locked_capacity,
        occupied: occupied.find(o => o.hospital_id === h.hospital_id && o.resource_type === r.resource_type)?.occupied ?? 0
      };
    }
    const doctorView = {};
    for (const d of doctors.filter(x => x.hospital_id === h.hospital_id)) {
      const entry = (doctorView[d.specialization] ??= { total: 0, available: 0 });
      entry.total += 1;
      if (d.availability_status === 'AVAILABLE') entry.available += 1;
    }
    const referrals = { pending: 0, accepted: 0, rejected: 0, expired: 0, cancelled: 0 };
    for (const a of acceptances) {
      const created = a.created_at instanceof Date ? a.created_at.getTime() : Date.parse(a.created_at);
      if (a.hospital_id !== h.hospital_id || !(created >= since)) continue;
      const key = String(a.status).toLowerCase();
      if (key in referrals) referrals[key] += 1;
    }
    overview.push({
      hospital_id: h.hospital_id, hospital_name: h.hospital_name, emergency_status: h.emergency_status,
      resources: resourceView, doctors: doctorView, referrals_24h: referrals,
      active_cases: {
        allocated: patients.filter(p => p.status === 'ALLOCATED' && !p.arrived_at).length,
        arrived: patients.filter(p => p.status === 'ALLOCATED' && p.arrived_at).length,
        in_treatment: patients.filter(p => p.status === 'IN_TREATMENT').length
      },
      completed_24h: patients.filter(p => p.status === 'COMPLETED').length
    });
  }
  res.json({ success: true, generated_at: new Date().toISOString(), hospitals: overview });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/:hospitalId
// Single hospital with full detail
// ────────────────────────────────────────────────────────────
router.get('/:hospitalId', authenticate, async (req, res) => {
  const hospital = await store.getHospital(req.params.hospitalId);
  if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

  // Full detail (roster, active allocations) only for a hospital the caller manages; the public summary is in GET /.
  if (!canReadHospitalDetail(req.user, hospital.hospital_id)) {
    return res.status(403).json({ error: 'Access restricted to your assigned facility.' });
  }

  const [resources, doctors, activeAllocations] = await Promise.all([
    store.listResources(hospital.hospital_id),
    store.listDoctors({ hospitalId: hospital.hospital_id }),
    store.countActiveAllocations(hospital.hospital_id)
  ]);

  res.json({
    success: true,
    hospital: {
      ...hospital,
      resources: buildResourceSummary(resources),
      doctors: buildDoctorSummary(doctors),
      specialists: buildSpecialistSummary(doctors),
      specialists_available: buildSpecialistCounts(doctors),
      activeAllocations
    }
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/:hospitalId/safety
// Banker's state of one hospital (D5-a2): available units, each case's allocation / max / need, whether a
// completion order exists (SAFE) and, if not, which cases can never finish and why. Read-only.
// ────────────────────────────────────────────────────────────
router.get('/:hospitalId/safety', authenticate, authorize('ADMIN', 'DISPATCHER', 'HOSPITAL_DESK'), async (req, res) => {
  if (!canReadHospitalDetail(req.user, req.params.hospitalId)) {
    return res.status(403).json({ error: 'Access restricted to your assigned facility.' });
  }
  const report = await store.getHospitalSafety(req.params.hospitalId);
  if (!report) return res.status(404).json({ error: 'Hospital not found.' });
  res.json({ success: true, safety: report });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/:hospitalId/patients   (Batch 8: the hospital desk's patient board)
// The cases this hospital holds (its ACCEPTED referral) that are ALLOCATED or IN_TREATMENT, or COMPLETED within the
// last 24 hours. ADMIN, or the desk of that hospital (accessPolicy.canReadHospitalPatients); anyone else 403; an unknown
// hospital 404. Order: open cases first, by triage priority, then request_id.
// -> { success, count, patients: [{ request_id, patient_name, age, gender, triage_priority, emergency_type, status,
//      incident_id, ambulance_id, trip_phase, accepted_at, updated_at }] }
// ────────────────────────────────────────────────────────────
router.get('/:hospitalId/patients', authenticate, authorize('ADMIN', 'HOSPITAL_DESK'), async (req, res) => {
  if (!canReadHospitalPatients(req.user, req.params.hospitalId)) {
    return res.status(403).json({ error: 'Access restricted to your assigned facility.' });
  }
  if (!(await store.getHospital(req.params.hospitalId))) return res.status(404).json({ error: 'Hospital not found.' });
  const patients = await store.listHospitalPatients(req.params.hospitalId);
  res.json({ success: true, count: patients.length, patients });
});

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/hospitals/:hospitalId/status
// Update hospital emergency_status (ADMIN only)
// ────────────────────────────────────────────────────────────
router.patch('/:hospitalId/status',
  authenticate,
  authorize('ADMIN'),
  validateBody({ emergency_status: { type: 'enum', required: true, values: HOSPITAL_STATUSES } }),
  async (req, res) => {
    const { emergency_status } = req.valid;

    const updated = await store.updateHospitalStatus(req.params.hospitalId, emergency_status, actorOf(req));
    if (!updated) return res.status(404).json({ error: 'Hospital not found.' });

    res.json({ success: true, hospital_id: updated.hospital_id, emergency_status: updated.emergency_status });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/hospitals/:hospitalId/resources/:resourceType
// Update resource counts (ADMIN or HOSPITAL_DESK own facility)
// ────────────────────────────────────────────────────────────
router.patch('/:hospitalId/resources/:resourceType',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  validateBody({ available_capacity: CAPACITY, total_capacity: CAPACITY }, { atLeastOne: ['available_capacity', 'total_capacity'] }),
  async (req, res) => {
    const { hospitalId, resourceType } = req.params;
    const { available_capacity, total_capacity } = req.valid;

    if (!canManageHospital(req.user, hospitalId)) {
      return res.status(403).json({ error: 'Can only update your own facility resources.' });
    }

    try {
      const resource = await store.updateResourceCapacity(
        hospitalId, resourceType, { total: total_capacity, available: available_capacity }, actorOf(req)
      );
      res.json({ success: true, resource });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  }
);

// ────────────────────────────────────────────────────────────
// Helpers (pure: they summarise rows the store already loaded)
// ────────────────────────────────────────────────────────────
function buildResourceSummary(resources) {
  const summary = {};
  resources.forEach(r => {
    const key = r.resource_type.toLowerCase().replace('_', '');
    summary[key] = {
      total:     r.total_capacity,
      available: r.available_capacity,
      locked:    r.locked_capacity,
      resource_id: r.resource_id
    };
  });
  return summary;
}

function buildDoctorSummary(doctors) {
  return doctors.map(d => ({
    doctor_id:           d.doctor_id,
    name:                d.full_name,
    specialization:      d.specialization,
    availability_status: d.availability_status,
    shift:               `${d.shift_start} - ${d.shift_end}`
  }));
}

/** Specialist availability COUNTS per specialization (part of the public summary; no names or ids). */
function buildSpecialistCounts(doctors) {
  const counts = Object.fromEntries(SPECIALIZATIONS.map(s => [s, 0]));
  doctors.forEach(d => {
    if (d.availability_status === 'AVAILABLE' && d.specialization in counts) counts[d.specialization] += 1;
  });
  return counts;
}

function buildSpecialistSummary(doctors) {
  const summary = {
    cardiologist: false,
    neurologist: false,
    traumaSurgeon: false,
    pediatrician: false
  };
  const keyBySpecialization = {
    CARDIOLOGIST: 'cardiologist',
    NEUROLOGIST: 'neurologist',
    TRAUMA_SURGEON: 'traumaSurgeon',
    PEDIATRICIAN: 'pediatrician'
  };
  doctors.forEach(doctor => {
    const key = keyBySpecialization[doctor.specialization];
    if (key && doctor.availability_status === 'AVAILABLE') summary[key] = true;
  });
  return summary;
}

export default router;
