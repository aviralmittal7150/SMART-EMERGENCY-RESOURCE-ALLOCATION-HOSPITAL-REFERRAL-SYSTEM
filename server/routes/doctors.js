// server/routes/doctors.js
// Doctor & Specialist Shift Scheduler API — P2-07
// /api/v1/doctors

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';

const router = express.Router();

const VALID_SPECIALIZATIONS = ['CARDIOLOGIST', 'NEUROLOGIST', 'TRAUMA_SURGEON', 'PEDIATRICIAN', 'GENERAL_ER'];
const VALID_STATUSES = ['AVAILABLE', 'IN_PROCEDURE', 'OFF_DUTY'];

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// "H:MM" or "HH:MM[:SS]" (24-hour). Anything else would be a storage error in MySQL (TIME column).
const SHIFT_TIME = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const invalidShift = (...values) => values.some(v => v !== undefined && v !== null && v !== '' && !SHIFT_TIME.test(String(v)));

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors
// All doctors (Admin), or own hospital's doctors (Hospital Desk)
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const { hospital_id, specialization, availability_status } = req.query;

  // RBAC: Hospital Desk only sees their own facility's doctors
  const hospitalId = req.user.role === 'HOSPITAL_DESK' ? req.user.hospital_id : hospital_id;

  const doctors = await store.listDoctors({ hospitalId, specialization, availabilityStatus: availability_status });
  res.json({ success: true, count: doctors.length, doctors });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors/:doctorId
// Single doctor detail
// ────────────────────────────────────────────────────────────
router.get('/:doctorId', authenticate, async (req, res) => {
  const doctor = await store.getDoctor(req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
    return res.status(403).json({ error: 'Access restricted to your facility.' });
  }

  res.json({ success: true, doctor });
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/doctors
// Add a new doctor to a hospital
// ────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  async (req, res) => {
    const { hospital_id, full_name, specialization, shift_start, shift_end } = req.body;

    if (!full_name || !specialization || !hospital_id) {
      return res.status(400).json({ error: 'full_name, specialization, hospital_id are required.' });
    }

    if (String(full_name).length > 150) {
      return res.status(400).json({ error: 'full_name must be at most 150 characters.' });
    }
    if (invalidShift(shift_start, shift_end)) {
      return res.status(400).json({ error: 'shift_start and shift_end must be times like 08:00.' });
    }

    if (!VALID_SPECIALIZATIONS.includes(specialization.toUpperCase())) {
      return res.status(400).json({ error: `Invalid specialization. Must be: ${VALID_SPECIALIZATIONS.join(', ')}` });
    }

    // RBAC: Hospital Desk can only add doctors to their own hospital
    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== hospital_id) {
      return res.status(403).json({ error: 'Can only add doctors to your own facility.' });
    }

    const hospital = await store.getHospital(hospital_id);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

    const doctor = await store.addDoctor({ hospital_id, full_name, specialization, shift_start, shift_end }, actorOf(req));
    res.status(201).json({ success: true, doctor });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/doctors/:doctorId/status
// Update doctor availability status
// ────────────────────────────────────────────────────────────
router.patch('/:doctorId/status',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  async (req, res) => {
    const { availability_status } = req.body;

    if (!VALID_STATUSES.includes(availability_status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const doctor = await store.getDoctor(req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
      return res.status(403).json({ error: 'Can only update doctors at your own facility.' });
    }

    const updated = await store.updateDoctorStatus(doctor.doctor_id, availability_status, actorOf(req));
    if (!updated) return res.status(404).json({ error: 'Doctor not found.' });
    res.json({ success: true, ...updated });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/doctors/:doctorId/shift
// Update doctor shift schedule
// ────────────────────────────────────────────────────────────
router.patch('/:doctorId/shift',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  async (req, res) => {
    const { shift_start, shift_end } = req.body;

    if (invalidShift(shift_start, shift_end)) {
      return res.status(400).json({ error: 'shift_start and shift_end must be times like 08:00.' });
    }

    const doctor = await store.getDoctor(req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
      return res.status(403).json({ error: 'Can only update doctors at your own facility.' });
    }

    const updated = await store.updateDoctorShift(doctor.doctor_id, { shift_start, shift_end });
    if (!updated) return res.status(404).json({ error: 'Doctor not found.' });
    res.json({ success: true, ...updated });
  }
);

// ────────────────────────────────────────────────────────────
// DELETE /api/v1/doctors/:doctorId
// Remove a doctor from the system (Admin only)
// ────────────────────────────────────────────────────────────
router.delete('/:doctorId',
  authenticate,
  authorize('ADMIN'),
  async (req, res) => {
    const removed = await store.removeDoctor(req.params.doctorId, actorOf(req));
    if (!removed) return res.status(404).json({ error: 'Doctor not found.' });

    res.json({ success: true, message: `Doctor ${removed.full_name} removed from system.` });
  }
);

export default router;
