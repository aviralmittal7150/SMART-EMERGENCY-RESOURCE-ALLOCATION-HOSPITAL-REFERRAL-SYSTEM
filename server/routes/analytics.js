// server/routes/analytics.js
// Analytics & Reporting API — P3 preview
// /api/v1/analytics

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';

const router = express.Router();

// GET /api/v1/analytics/dashboard
// Live command center KPIs
router.get('/dashboard', authenticate, async (req, res) => {
  const { hospitals, medicalResources, doctors, ambulances, emergencyRequests, hospitalAcceptances } = await store.getAnalyticsData();
  const activeEmergencies   = emergencyRequests.filter(r => !['COMPLETED', 'CANCELLED'].includes(r.status)).length;
  const criticalP1           = emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length;
  const openHospitals        = hospitals.filter(h => h.emergency_status === 'OPEN').length;
  const limitedHospitals     = hospitals.filter(h => h.emergency_status === 'LIMITED').length;
  const closedHospitals      = hospitals.filter(h => h.emergency_status === 'CLOSED').length;
  const availableAmbulances  = ambulances.filter(a => a.status === 'AVAILABLE').length;

  const icuBeds = medicalResources.filter(r => r.resource_type === 'ICU_BED');
  const totalIcuAvail  = icuBeds.reduce((s, r) => s + r.available_capacity, 0);
  const totalIcuLocked = icuBeds.reduce((s, r) => s + r.locked_capacity, 0);
  const totalIcu       = icuBeds.reduce((s, r) => s + r.total_capacity, 0);

  const ventilators = medicalResources.filter(r => r.resource_type === 'VENTILATOR');
  const totalVentAvail = ventilators.reduce((s, r) => s + r.available_capacity, 0);
  const totalVent      = ventilators.reduce((s, r) => s + r.total_capacity, 0);

  const ots = medicalResources.filter(r => r.resource_type === 'OT');
  const totalOTAvail = ots.reduce((s, r) => s + r.available_capacity, 0);

  const activeDoctors = doctors.filter(d => d.availability_status === 'AVAILABLE').length;

  // Hospital capacity color codes (Green >= 20%, Yellow < 20%, Red = 0)
  const hospitalStatuses = hospitals.map(h => {
    const icu = medicalResources.find(r => r.hospital_id === h.hospital_id && r.resource_type === 'ICU_BED');
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
  const acceptedReferrals = hospitalAcceptances.filter(a => a.response_time_sec != null);
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

// Acceptance rate over referrals the hospital could actually decide on.
function acceptanceRate(referrals) {
  const decidable = referrals.filter(a => a.status !== 'CANCELLED');
  if (decidable.length === 0) return 0;
  return Math.round((decidable.filter(a => a.status === 'ACCEPTED').length / decidable.length) * 100);
}

// GET /api/v1/analytics/referrals
// Referral acceptance/rejection breakdown
router.get('/referrals', authenticate, authorize('ADMIN'), async (req, res) => {
  const { hospitals, hospitalAcceptances } = await store.getAnalyticsData();
  const total    = hospitalAcceptances.length;
  const accepted = hospitalAcceptances.filter(a => a.status === 'ACCEPTED').length;
  const rejected = hospitalAcceptances.filter(a => a.status === 'REJECTED').length;
  const expired  = hospitalAcceptances.filter(a => a.status === 'EXPIRED').length;
  const pending  = hospitalAcceptances.filter(a => a.status === 'PENDING').length;
  // CANCELLED means the case was cancelled/completed while the referral was pending;
  // the hospital never had a chance to decide, so it is not counted against it.
  const cancelled = hospitalAcceptances.filter(a => a.status === 'CANCELLED').length;

  const byHospital = hospitals.map(h => {
    const hospitalReferrals = hospitalAcceptances.filter(a => a.hospital_id === h.hospital_id);
    return {
      hospital_id:   h.hospital_id,
      hospital_name: h.hospital_name,
      total:    hospitalReferrals.length,
      accepted: hospitalReferrals.filter(a => a.status === 'ACCEPTED').length,
      rejected: hospitalReferrals.filter(a => a.status === 'REJECTED').length,
      expired:  hospitalReferrals.filter(a => a.status === 'EXPIRED').length,
      cancelled: hospitalReferrals.filter(a => a.status === 'CANCELLED').length,
      acceptance_rate: acceptanceRate(hospitalReferrals)
    };
  });

  res.json({
    success: true,
    summary: { total, accepted, rejected, expired, pending, cancelled },
    by_hospital: byHospital
  });
});

// GET /api/v1/analytics/audit
// Full immutable audit trail (Admin only)
router.get('/audit', authenticate, authorize('ADMIN'), async (req, res) => {
  const { event_type, hospital_id, limit = 100 } = req.query;
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);

  const events = await store.listAudit({ eventType: event_type, hospitalId: hospital_id, limit: parsedLimit });
  res.json({ success: true, count: events.length, audit_trail: events });
});

// GET /api/v1/analytics/resources
// Resource utilization breakdown per hospital
router.get('/resources', authenticate, async (req, res) => {
  const { hospitals, medicalResources } = await store.getAnalyticsData();
  const utilization = hospitals.map(h => {
    const resources = medicalResources.filter(r => r.hospital_id === h.hospital_id);
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
