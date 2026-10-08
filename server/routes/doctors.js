// server/routes/doctors.js
// Doctor & Specialist Shift Scheduler API — P2-07
// /api/v1/doctors

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';

const router = express.Router();

const VALID_SPECIALIZATIONS = ['CARDIOLOGIST', 'NEUROLOGIST', 'TRAUMA_SURGEON', 'PEDIATRICIAN', 'GENERAL_ER'];
const VALID_STATUSES = ['AVAILABLE', 'IN_PROCEDURE', 'OFF_DUTY'];

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors
// All doctors (Admin), or own hospital's doctors (Hospital Desk)
// ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { hospital_id, specialization, availability_status } = req.query;
  let doctors = [...db.doctors];

  // RBAC: Hospital Desk only sees their own facility's doctors
  if (req.user.role === 'HOSPITAL_DESK') {
    doctors = doctors.filter(d => d.hospital_id === req.user.hospital_id);
  } else if (hospital_id) {
    doctors = doctors.filter(d => d.hospital_id === hospital_id);
  }

  if (specialization) doctors = doctors.filter(d => d.specialization === specialization.toUpperCase());
  if (availability_status) doctors = doctors.filter(d => d.availability_status === availability_status.toUpperCase());

  // Enrich with hospital name
  const enriched = doctors.map(d => ({
    ...d,
    hospital_name: db.hospitals.find(h => h.hospital_id === d.hospital_id)?.hospital_name || 'Unknown'
  }));

  res.json({ success: true, count: enriched.length, doctors: enriched });
});

// ────────────────────────────────────────────────────────────
// GET /api/v1/doctors/:doctorId
// Single doctor detail
// ────────────────────────────────────────────────────────────
router.get('/:doctorId', authenticate, (req, res) => {
  const doctor = db.doctors.find(d => d.doctor_id === req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
    return res.status(403).json({ error: 'Access restricted to your facility.' });
  }

  res.json({
    success: true,
    doctor: {
      ...doctor,
      hospital_name: db.hospitals.find(h => h.hospital_id === doctor.hospital_id)?.hospital_name
    }
  });
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/doctors
// Add a new doctor to a hospital
// ────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  (req, res) => {
    const { hospital_id, full_name, specialization, shift_start, shift_end } = req.body;

    if (!full_name || !specialization || !hospital_id) {
      return res.status(400).json({ error: 'full_name, specialization, hospital_id are required.' });
    }

    if (!VALID_SPECIALIZATIONS.includes(specialization.toUpperCase())) {
      return res.status(400).json({ error: `Invalid specialization. Must be: ${VALID_SPECIALIZATIONS.join(', ')}` });
    }

    // RBAC: Hospital Desk can only add doctors to their own hospital
    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== hospital_id) {
      return res.status(403).json({ error: 'Can only add doctors to your own facility.' });
    }

    const hospital = db.hospitals.find(h => h.hospital_id === hospital_id);
    if (!hospital) return res.status(404).json({ error: 'Hospital not found.' });

    const doctorId = `DR-${String(db.doctors.length + 1).padStart(3, '0')}`;
    const newDoctor = {
      doctor_id:           doctorId,
      hospital_id,
      full_name,
      specialization:      specialization.toUpperCase(),
      availability_status: 'AVAILABLE',
      shift_start:         shift_start || '08:00',
      shift_end:           shift_end   || '20:00',
      created_at:          new Date().toISOString()
    };

    db.doctors.push(newDoctor);

    db.auditLog({
      request_id: 'N/A',
      hospital_id,
      event_type: 'DOCTOR_ADDED',
      previous_state: null,
      new_state: 'AVAILABLE',
      actor_role: req.user.role,
      actor_id: req.user.user_id,
      metadata: { doctorId, full_name, specialization }
    });

    res.status(201).json({ success: true, doctor: newDoctor });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/doctors/:doctorId/status
// Update doctor availability status
// ────────────────────────────────────────────────────────────
router.patch('/:doctorId/status',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  (req, res) => {
    const { availability_status } = req.body;

    if (!VALID_STATUSES.includes(availability_status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const doctor = db.doctors.find(d => d.doctor_id === req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
      return res.status(403).json({ error: 'Can only update doctors at your own facility.' });
    }

    const previous = doctor.availability_status;
    doctor.availability_status = availability_status;

    db.auditLog({
      request_id: 'N/A',
      hospital_id: doctor.hospital_id,
      event_type: 'DOCTOR_STATUS_CHANGED',
      previous_state: previous,
      new_state: availability_status,
      actor_role: req.user.role,
      actor_id: req.user.user_id,
      metadata: { doctorId: doctor.doctor_id, full_name: doctor.full_name }
    });

    res.json({ success: true, doctor_id: doctor.doctor_id, previous_status: previous, new_status: availability_status });
  }
);

// ────────────────────────────────────────────────────────────
// PATCH /api/v1/doctors/:doctorId/shift
// Update doctor shift schedule
// ────────────────────────────────────────────────────────────
router.patch('/:doctorId/shift',
  authenticate,
  authorize('ADMIN', 'HOSPITAL_DESK'),
  (req, res) => {
    const { shift_start, shift_end } = req.body;

    const doctor = db.doctors.find(d => d.doctor_id === req.params.doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

    if (req.user.role === 'HOSPITAL_DESK' && req.user.hospital_id !== doctor.hospital_id) {
      return res.status(403).json({ error: 'Can only update doctors at your own facility.' });
    }

    if (shift_start) doctor.shift_start = shift_start;
    if (shift_end)   doctor.shift_end   = shift_end;

    res.json({ success: true, doctor_id: doctor.doctor_id, shift_start: doctor.shift_start, shift_end: doctor.shift_end });
  }
);

// ────────────────────────────────────────────────────────────
// DELETE /api/v1/doctors/:doctorId
// Remove a doctor from the system (Admin only)
// ────────────────────────────────────────────────────────────
router.delete('/:doctorId',
  authenticate,
  authorize('ADMIN'),
  (req, res) => {
    const idx = db.doctors.findIndex(d => d.doctor_id === req.params.doctorId);
    if (idx === -1) return res.status(404).json({ error: 'Doctor not found.' });

    const [removed] = db.doctors.splice(idx, 1);

    db.auditLog({
      request_id: 'N/A',
      hospital_id: removed.hospital_id,
      event_type: 'DOCTOR_REMOVED',
      previous_state: removed.availability_status,
      new_state: null,
      actor_role: 'ADMIN',
      actor_id: req.user.user_id,
      metadata: { doctorId: removed.doctor_id, full_name: removed.full_name }
    });

    res.json({ success: true, message: `Doctor ${removed.full_name} removed from system.` });
  }
);

export default router;
