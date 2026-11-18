// server/routes/analytics.js
// Analytics & Reporting API — P3 preview
// /api/v1/analytics

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import {
  AnalyticsInputError, resolveHistoryWindow, resolveForecastWindow, historyReport, forecastReport
} from '../services/analyticsEngine.js';
import { validateQuery, ID20 } from '../services/validation.js';
import {
  registrationReport, registrationWindow, REGISTRATION_EVENT_TYPES, REGISTRATION_LIMITS
} from '../services/registrationReport.js';

const router = express.Router();

// Capacity model (both stores): `available_capacity` counts every unit not committed to a case, and
// INCLUDES the units soft-locked by pending 90-second referrals (`locked_capacity`). So:
//   free   = available_capacity - locked_capacity   (can be offered to a new referral)
//   locked = locked_capacity                        (reserved by a pending referral)
//   in_use = total_capacity - available_capacity    (committed to accepted cases)
// and free + locked + in_use = total_capacity.
const freeUnits = r => r.available_capacity - r.locked_capacity;
const sum = (rows, pick) => rows.reduce((s, r) => s + pick(r), 0);

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

  // "available" figures are FREE units: soft-locked units are already promised to a pending referral.
  const icuBeds = medicalResources.filter(r => r.resource_type === 'ICU_BED');
  const totalIcuAvail  = sum(icuBeds, freeUnits);
  const totalIcuLocked = sum(icuBeds, r => r.locked_capacity);
  const totalIcu       = sum(icuBeds, r => r.total_capacity);

  const ventilators = medicalResources.filter(r => r.resource_type === 'VENTILATOR');
  const totalVentAvail = sum(ventilators, freeUnits);
  const totalVent      = sum(ventilators, r => r.total_capacity);

  const ots = medicalResources.filter(r => r.resource_type === 'OT');
  const totalOTAvail = sum(ots, freeUnits);

  const activeDoctors = doctors.filter(d => d.availability_status === 'AVAILABLE').length;

  // Hospital capacity color codes by free ICU share (Green >= 20%, Yellow < 20%, Red = 0)
  const hospitalStatuses = hospitals.map(h => {
    const icu = medicalResources.find(r => r.hospital_id === h.hospital_id && r.resource_type === 'ICU_BED');
    const icuFree = icu ? freeUnits(icu) : 0;
    const util = icu ? (icuFree / Math.max(1, icu.total_capacity)) : 0;
    let capacityColor = 'GREEN';
    if (util === 0)    capacityColor = 'RED';
    else if (util < 0.2) capacityColor = 'YELLOW';

    return {
      hospital_id:      h.hospital_id,
      hospital_name:    h.hospital_name,
      emergency_status: h.emergency_status,
      icu_available:    icuFree,
      icu_total:        icu?.total_capacity || 0,
      capacity_color:   h.emergency_status === 'CLOSED' ? 'RED' : capacityColor
    };
  });

  // Average referral response time
  // Observed referrals only: demo-flagged cases are excluded, as in the historical analytics (S1).
  const acceptedReferrals = hospitalAcceptances.filter(a => a.response_time_sec != null && Number(a.is_demo ?? 0) !== 1);
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
router.get('/audit',
  authenticate,
  authorize('ADMIN'),
  validateQuery({
    event_type: { type: 'string', maxLength: 80 }, // EmergencyHistory.event_type VARCHAR(80)
    hospital_id: ID20,
    limit: { type: 'integer', min: 1, max: 1000, default: 100 }
  }),
  async (req, res) => {
    const { event_type, hospital_id, limit } = req.validQuery;
    const events = await store.listAudit({ eventType: event_type || undefined, hospitalId: hospital_id || undefined, limit });
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
      const inUse = r.total_capacity - r.available_capacity; // committed to accepted cases
      const util = r.total_capacity > 0 ? Math.round((inUse / r.total_capacity) * 100) : 0;
      summary[r.resource_type] = {
        total: r.total_capacity,
        available: freeUnits(r),       // free = not committed and not soft-locked
        locked: r.locked_capacity,
        in_use: inUse,                 // available + locked + in_use = total
        utilization_pct: util
      };
    });
    return { hospital_id: h.hospital_id, hospital_name: h.hospital_name, resources: summary };
  });

  res.json({ success: true, utilization });
});

// ── Historical analytics and forecasting (Phase 3 Step 6, D8-A / D8b-A; docs/analytics.md) ─────────────────────
// Both are new, ADMIN-only endpoints; the four endpoints above keep their response shapes (D8-a8). Windows are
// resolved here, on the server, in epoch milliseconds; the client may pass epoch-ms bounds but never a time zone.
const badRequest = (res, err) => res.status(400).json({ success: false, error: err.message });

// GET /api/v1/analytics/history?from_ms=&to_ms=  |  ?days=28[&to_ms=]
// OBSERVED metrics only: demand trends, response times, per-hospital performance and the all-hospital total.
router.get('/history', authenticate, authorize('ADMIN'), async (req, res) => {
  const nowMs = Date.now();
  let window;
  try {
    window = resolveHistoryWindow(req.query, nowMs);
  } catch (err) {
    if (err instanceof AnalyticsInputError) return badRequest(res, err);
    throw err;
  }
  const data = await store.getAnalyticsHistory(window);
  res.json({ success: true, history: historyReport(data, window, nowMs) });
});

// GET /api/v1/analytics/forecast?as_of_ms=&history_days=28&horizon_days=7
// FORECASTS only (cases per day and resource units requested per day), each with method and back-test error, or
// insufficient_data with the actual sample when history is below the configured minimum.
router.get('/forecast', authenticate, authorize('ADMIN'), async (req, res) => {
  let fw;
  try {
    fw = resolveForecastWindow(req.query, Date.now());
  } catch (err) {
    if (err instanceof AnalyticsInputError) return badRequest(res, err);
    throw err;
  }
  const data = await store.getAnalyticsHistory(fw);
  const resourceTypes = [...new Set(data.resources.map(r => r.resource_type))];
  res.json({ success: true, forecast: forecastReport(data.requests, fw, resourceTypes) });
});

// GET /api/v1/analytics/my-registrations?days=1..366 (30)&limit=1..500 (200)   — ADMIN only (Batch 6, round 4)
// The CALLER's own registered cases (created_by = their user_id) in the window, newest first, with lifecycle milestones
// from the recorded audit data and S6-2-gated means (server/services/registrationReport.js). Demo-flagged cases are
// excluded, as in every observed analytic (S1). Not sent over sockets.
router.get('/my-registrations',
  authenticate,
  authorize('ADMIN'),
  validateQuery({
    days: { type: 'integer', min: 1, max: REGISTRATION_LIMITS.maxDays, default: REGISTRATION_LIMITS.defaultDays },
    limit: { type: 'integer', min: 1, max: REGISTRATION_LIMITS.maxLimit, default: REGISTRATION_LIMITS.defaultLimit }
  }),
  async (req, res) => {
    const { days, limit } = req.validQuery;
    const window = registrationWindow(days, Date.now());
    const raw = await store.getRegistrations({ createdBy: req.user.user_id, ...window, eventTypes: REGISTRATION_EVENT_TYPES });
    res.json({ success: true, ...registrationReport(raw, window, limit) });
  });

export default router;
