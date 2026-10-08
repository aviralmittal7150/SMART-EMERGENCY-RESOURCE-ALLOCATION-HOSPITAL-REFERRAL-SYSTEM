// server/routes/analytics.js
// Analytics & Reporting API — P3 preview
// /api/v1/analytics

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { db } from '../db/seed.js';

const router = express.Router();

// GET /api/v1/analytics/dashboard
// Live command center KPIs
router.get('/dashboard', authenticate, (req, res) => {
  const activeEmergencies   = db.emergencyRequests.filter(r => !['COMPLETED', 'CANCELLED'].includes(r.status)).length;
  const criticalP1           = db.emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length;
  const openHospitals        = db.hospitals.filter(h => h.emergency_status === 'OPEN').length;
  const limitedHospitals     = db.hospitals.filter(h => h.emergency_status === 'LIMITED').length;
  const closedHospitals      = db.hospitals.filter(h => h.emergency_status === 'CLOSED').length;
  const availableAmbulances  = db.ambulances.filter(a => a.status === 'AVAILABLE').length;

  const icuBeds = db.medicalResources.filter(r => r.resource_type === 'ICU_BED');
  const totalIcuAvail  = icuBeds.reduce((s, r) => s + r.available_capacity, 0);
  const totalIcuLocked = icuBeds.reduce((s, r) => s + r.locked_capacity, 0);
  const totalIcu       = icuBeds.reduce((s, r) => s + r.total_capacity, 0);

  const ventilators = db.medicalResources.filter(r => r.resource_type === 'VENTILATOR');
  const totalVentAvail = ventilators.reduce((s, r) => s + r.available_capacity, 0);
  const totalVent      = ventilators.reduce((s, r) => s + r.total_capacity, 0);

  const ots = db.medicalResources.filter(r => r.resource_type === 'OT');
  const totalOTAvail = ots.reduce((s, r) => s + r.available_capacity, 0);

  const activeDoctors = db.doctors.filter(d => d.availability_status === 'AVAILABLE').length;

  // Hospital capacity color codes (Green >= 20%, Yellow < 20%, Red = 0)
  const hospitalStatuses = db.hospitals.map(h => {
    const icu = db.medicalResources.find(r => r.hospital_id === h.hospital_id && r.resource_type === 'ICU_BED');
    const util = icu ? (icu.available_capacity / Math.max(1, icu.total_capacity)) : 0;
    let capacityColor = 'GREEN';
    if (util === 0)    capacityColor = 'RED';
    else if (util < 0.2) capacityColor = 'YELLOW';

    return {
      hospital_id:      h.hospital_id,
      hospital_name:    h.hospital_name,
      emergency_status: h.emergency_status,
      icu_available:    icu?.available_capacity || 0,
      icu_total:        icu?.total_capacity || 0,
      capacity_color:   h.emergency_status === 'CLOSED' ? 'RED' : capacityColor
    };
  });

  // Average referral response time
  const acceptedReferrals = db.hospitalAcceptances.filter(a => a.response_time_sec != null);
  const avgResponseSec = acceptedReferrals.length > 0
    ? Math.round(acceptedReferrals.reduce((s, a) => s + a.response_time_sec, 0) / acceptedReferrals.length)
    : 0;

  res.json({
    success: true,
    dashboard: {
      kpis: {
        active_emergencies:   activeEmergencies,
        critical_p1_waiting:  criticalP1,
        hospitals_open:       openHospitals,
        hospitals_limited:    limitedHospitals,
        hospitals_closed:     closedHospitals,
        available_ambulances: availableAmbulances,
        icu_available:        totalIcuAvail,
        icu_locked:           totalIcuLocked,
        icu_total:            totalIcu,
        ventilators_available: totalVentAvail,
        ventilators_total:    totalVent,
        ot_available:         totalOTAvail,
        available_doctors:    activeDoctors,
        avg_referral_response_sec: avgResponseSec
      },
      hospital_statuses: hospitalStatuses,
      timestamp: new Date().toISOString()
    }
  });
});

// GET /api/v1/analytics/referrals
// Referral acceptance/rejection breakdown
router.get('/referrals', authenticate, authorize('ADMIN'), (req, res) => {
  const total    = db.hospitalAcceptances.length;
  const accepted = db.hospitalAcceptances.filter(a => a.status === 'ACCEPTED').length;
  const rejected = db.hospitalAcceptances.filter(a => a.status === 'REJECTED').length;
  const expired  = db.hospitalAcceptances.filter(a => a.status === 'EXPIRED').length;
  const pending  = db.hospitalAcceptances.filter(a => a.status === 'PENDING').length;

  const byHospital = db.hospitals.map(h => {
    const hospitalReferrals = db.hospitalAcceptances.filter(a => a.hospital_id === h.hospital_id);
    return {
      hospital_id:   h.hospital_id,
      hospital_name: h.hospital_name,
      total:    hospitalReferrals.length,
      accepted: hospitalReferrals.filter(a => a.status === 'ACCEPTED').length,
      rejected: hospitalReferrals.filter(a => a.status === 'REJECTED').length,
      expired:  hospitalReferrals.filter(a => a.status === 'EXPIRED').length,
      acceptance_rate: hospitalReferrals.length > 0
        ? Math.round((hospitalReferrals.filter(a => a.status === 'ACCEPTED').length / hospitalReferrals.length) * 100)
        : 0
    };
  });

  res.json({
    success: true,
    summary: { total, accepted, rejected, expired, pending },
    by_hospital: byHospital
  });
});

// GET /api/v1/analytics/audit
// Full immutable audit trail (Admin only)
router.get('/audit', authenticate, authorize('ADMIN'), (req, res) => {
  const { event_type, hospital_id, limit = 100 } = req.query;
  let events = [...db.emergencyHistory];

  if (event_type)  events = events.filter(e => e.event_type === event_type);
  if (hospital_id) events = events.filter(e => e.hospital_id === hospital_id);

  events.sort((a, b) => new Date(b.event_time) - new Date(a.event_time));
  events = events.slice(0, parseInt(limit, 10));

  res.json({ success: true, count: events.length, audit_trail: events });
});

// GET /api/v1/analytics/resources
// Resource utilization breakdown per hospital
router.get('/resources', authenticate, (req, res) => {
  const utilization = db.hospitals.map(h => {
    const resources = db.medicalResources.filter(r => r.hospital_id === h.hospital_id);
    const summary = {};
    resources.forEach(r => {
      const util = r.total_capacity > 0
        ? Math.round(((r.total_capacity - r.available_capacity) / r.total_capacity) * 100)
        : 0;
      summary[r.resource_type] = {
        total: r.total_capacity,
        available: r.available_capacity,
        locked: r.locked_capacity,
        in_use: r.total_capacity - r.available_capacity - r.locked_capacity,
        utilization_pct: util
      };
    });
    return { hospital_id: h.hospital_id, hospital_name: h.hospital_name, resources: summary };
  });

  res.json({ success: true, utilization });
});

export default router;
