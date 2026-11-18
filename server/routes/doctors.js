// server/routes/doctors.js
// Doctor & Specialist Shift Scheduler API — P2-07
// /api/v1/doctors

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { doctorFilter, canSeeDoctor, canManageHospital } from '../services/accessPolicy.js';
import { validateBody, validateQuery, ID20, SHIFT_TIME } from '../services/validation.js';

const router = express.Router();

const VALID_SPECIALIZATIONS = ['CARDIOLOGIST', 'NEUROLOGIST', 'TRAUMA_SURGEON', 'PEDIATRICIAN', 'GENERAL_ER'];
const VALID_STATUSES = ['AVAILABLE', 'IN_PROCEDURE', 'OFF_DUTY'];
// Doctor.availability_status also has RESERVED / ASSIGNED, which only the referral lifecycle sets; they can be filtered on.
const LISTED_STATUSES = [...VALID_STATUSES, 'RESERVED', 'ASSIGNED'];

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

// "H:MM" or "HH:MM[:SS]" (24-hour). Anything else would be a storage error in MySQL (TIME column). "" or null = unchanged.
const SHIFT = { type: 'string', nullable: true, maxLength: 8, pattern: SHIFT_TIME, emptyAs: null,
  patternMessage: 'shift_start and shift_end must be times like 08:00.' };

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors
// All doctors (Admin), or own hospital's doctors (Hospital Desk)
// ────────────────────────────────────────────────────────────
router.get('/',
  authenticate,
  validateQuery({
    hospital_id: ID20,
    specialization: { type: 'enum', values: VALID_SPECIALIZATIONS, upper: true },
    availability_status: { type: 'enum', values: LISTED_STATUSES, upper: true }
  }),
  async (req, res) => {
    const { hospital_id, specialization, availability_status } = req.validQuery;
    // Rosters (server/services/accessPolicy.js): admins any hospital, a desk its own; a paramedic none (they see
    // specialist availability COUNTS in GET /hospitals instead).
    const filter = doctorFilter(req.user, hospital_id);
    const doctors = filter ? await store.listDoctors({ ...filter, specialization, availabilityStatus: availability_status }) : [];
    res.json({ success: true, count: doctors.length, doctors });
  });

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors/:doctorId
// Single doctor detail
// ────────────────────────────────────────────────────────────
router.get('/:doctorId', authenticate, async (req, res) => {
  const doctor = await store.getDoctor(req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  if (!canSeeDoctor(req.user, doctor)) {
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
  validateBody({
    hospital_id: { ...ID20, required: true },
    full_name: { type: 'string', required: true, maxLength: 150 }, // Doctor.full_name VARCHAR(150)
    specialization: { type: 'enum', required: true, values: VALID_SPECIALIZATIONS, upper: true },
    shift_start: SHIFT,
    shift_end: SHIFT
  }),
  async (req, res) => {
    const { hospital_id, full_name, specialization, shift_start, shift_end } = req.valid;

    // RBAC: Hospital Desk can only add doctors to their own hospital
    if (!canManageHospital(req.user, hospital_id)) {
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
  validateBody({ availability_status: { type: 'enum', required: true, values: VALID_STATUSES } }),
  async (req, res) => {
    const { availability_status } = req.valid;

    const doctor = await store.getDoctor(req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (!canManageHospital(req.user, doctor.hospital_id)) {
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
  validateBody({ shift_start: SHIFT, shift_end: SHIFT }),
  async (req, res) => {
    const { shift_start, shift_end } = req.valid;
    if (!shift_start && !shift_end) {
      return res.status(400).json({ error: 'Provide shift_start and/or shift_end.' });
    }

    const doctor = await store.getDoctor(req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (!canManageHospital(req.user, doctor.hospital_id)) {
      return res.status(403).json({ error: 'Can only update doctors at your own facility.' });
    }

    const updated = await store.updateDoctorShift(doctor.doctor_id, { shift_start, shift_end }, actorOf(req));
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
