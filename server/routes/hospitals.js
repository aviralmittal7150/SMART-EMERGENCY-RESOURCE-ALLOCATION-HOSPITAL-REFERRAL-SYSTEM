// server/routes/hospitals.js
// Hospital & Resource Management API

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';

const router = express.Router();

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals
// All hospitals with their current resource state
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const [hospitals, resources, doctors] = await Promise.all([
    store.listHospitals({ status: req.query.status }),
    store.listResources(),
    store.listDoctors()
  ]);

  const result = hospitals.map(h => {
    const hospitalDoctors = doctors.filter(d => d.hospital_id === h.hospital_id);
    return {
      ...h,
      resources: buildResourceSummary(resources.filter(r => r.hospital_id === h.hospital_id)),
      doctors: buildDoctorSummary(hospitalDoctors),
      specialists: buildSpecialistSummary(hospitalDoctors)
    };
  });

  res.json({ success: true, count: result.length, hospitals: result });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/:hospitalId
// Single hospital with full detail
// ────────────────────────────────────────────────────────────
router.get('/:hospitalId', authenticate, async (req, res) => {
  const hospital = await store.getHospital(req.params.hospitalId);
  if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

  // RBAC: Hospital Desk can only see their own facility
  if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== req.params.hospitalId) {
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
      activeAllocations
    }
  });
});

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/hospitals/:hospitalId/status
// Update hospital emergency_status (ADMIN only)
// ────────────────────────────────────────────────────────────
router.patch('/:hospitalId/status',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    const { emergency_status } = req.body;
    if (!['OPEN', 'LIMITED', 'CLOSED'].includes(emergency_status)) {
      return res.status(400).json({ error: 'Invalid status. Must be OPEN, LIMITED, or CLOSED.' });
    }

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
  async (req, res) => {
    const { hospitalId, resourceType } = req.params;
    const { available_capacity, total_capacity } = req.body;

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== hospitalId) {
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
