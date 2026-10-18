// server/routes/hospitals.js
// Hospital & Resource Management API

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals
// All hospitals with their current resource state
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { status } = req.query;
  let hospitals = db.hospitals;
  if (status) hospitals = hospitals.filter(h => h.emergency_status === status.toUpperCase());

  const result = hospitals.map(h => ({
    ...h,
    resources: buildResourceSummary(h.hospital_id),
      doctors:   buildDoctorSummary(h.hospital_id),
      specialists: buildSpecialistSummary(h.hospital_id)
  }));

  res.json({ success: true, count: result.length, hospitals: result });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/hospitals/:hospitalId
// Single hospital with full detail
// ────────────────────────────────────────────────────────────
router.get('/:hospitalId', authenticate, (req, res) => {
  const hospital = db.hospitals.find(h => h.hospital_id === req.params.hospitalId);
  if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

  // RBAC: Hospital Desk can only see their own facility
  if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== req.params.hospitalId) {
    return res.status(403).json({ error: 'Access restricted to your assigned facility.' });
  }

  res.json({
    success: true,
    hospital: {
      ...hospital,
      resources: buildResourceSummary(hospital.hospital_id),
       doctors:   buildDoctorSummary(hospital.hospital_id),
       specialists: buildSpecialistSummary(hospital.hospital_id),
      activeAllocations: db.resourceAllocations.filter(
        a => a.hospital_id === hospital.hospital_id && a.status !== 'RELEASED'
      ).length
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
  (req, res) => {
    const { emergency_status } = req.body;
    if (!['OPEN', 'LIMITED', 'CLOSED'].includes(emergency_status)) {
      return res.status(400).json({ error: 'Invalid status. Must be OPEN, LIMITED, or CLOSED.' });
    }

    const hospital = db.hospitals.find(h => h.hospital_id === req.params.hospitalId);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

    const previous = hospital.emergency_status;
    hospital.emergency_status = emergency_status;

    db.auditLog({
      request_id: null,
      hospital_id: hospital.hospital_id,
      event_type: 'HOSPITAL_STATUS_CHANGED',
      previous_state: previous,
      new_state: emergency_status,
      actor_role: 'ADMIN',
      actor_id: req.user.user_id
    });

    res.json({ success: true, hospital_id: hospital.hospital_id, emergency_status });
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

    const resource = db.medicalResources.find(
      r => r.hospital_id === hospitalId && r.resource_type === resourceType.toUpperCase()
    );
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });

    const nextTotal = total_capacity === undefined ? resource.total_capacity : Number(total_capacity);
    const nextAvailable = available_capacity === undefined ? resource.available_capacity : Number(available_capacity);
    if (!Number.isInteger(nextTotal) || !Number.isInteger(nextAvailable)
      || nextTotal < 0 || nextAvailable < 0
      || nextAvailable > nextTotal
      || nextAvailable < resource.locked_capacity) {
      return res.status(400).json({
        error: 'Capacity must be whole numbers with 0 <= locked <= available <= total.'
      });
    }

    let release;
    const previousCapacity = `${resource.total_capacity}:${resource.available_capacity}`;
    try {
      release = await db.acquireResourceLock(resource.resource_id, 3000);
      resource.total_capacity = nextTotal;
      resource.available_capacity = nextAvailable;
      resource.version_lock += 1;
    } catch (error) {
      return res.status(409).json({ error: error.message });
    } finally {
      release?.();
    }

    db.auditLog({
      request_id: null,
      hospital_id: hospitalId,
      event_type: 'RESOURCE_CAPACITY_UPDATED',
      previous_state: previousCapacity,
      new_state: `${nextTotal}:${nextAvailable}`,
      actor_role: req.user.role,
      actor_id: req.user.user_id,
      metadata: { resource_type: resource.resource_type }
    });

    res.json({ success: true, resource });
  }
);

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function buildResourceSummary(hospitalId) {
  const resources = db.getHospitalResources(hospitalId);
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

function buildDoctorSummary(hospitalId) {
  const docs = db.getDoctors(hospitalId);
  return docs.map(d => ({
    doctor_id:           d.doctor_id,
    name:                d.full_name,
    specialization:      d.specialization,
    availability_status: d.availability_status,
    shift:               `${d.shift_start} - ${d.shift_end}`
  }));
}

function buildSpecialistSummary(hospitalId) {
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
  db.getDoctors(hospitalId).forEach(doctor => {
    const key = keyBySpecialization[doctor.specialization];
    if (key && doctor.availability_status === 'AVAILABLE') summary[key] = true;
  });
  return summary;
}

export default router;
