// server/routes/patient.js
// Patient portal API — /api/v1/patient (Batch 6). PATIENT only, read-only, and only the patient's own data:
//   GET /me            { success, patient: { patient_id, full_name, age, gender, contact_phone } }
//   GET /cases         { success, count, cases: [case view without timeline] }
//   GET /cases/:id     { success, case: case view with timeline }      (server/services/patientView.js)
//   GET /cases/:id/tracking  { success, tracking: { phase, current: { lat, lng }, eta_seconds, route_source, simulated: true,
//                      hospital: { name, lat, lng }, pickup: { lat, lng } } }: the SIMULATED ambulance trip of the case
//                      (the active one, else the latest; server/services/tracking/view.js); { success, tracking: null } for
//                      the patient's own case without a trip. Another patient's case and a missing one: the same 404.
// A case that is not the patient's and a case that does not exist get the SAME 404, so a patient cannot learn whether
// another request id exists.

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { caseScope } from '../services/accessPolicy.js';
import { loadPatientCase } from '../services/patientView.js';
import { getTracking } from '../services/tracking/index.js';
import { isActive } from '../services/tracking/phases.js';

const router = express.Router();
router.use(authenticate, authorize('PATIENT'));

const NOT_FOUND = { error: 'Case not found.' };

router.get('/me', async (req, res) => {
  const patient = await store.getPatient(req.user.patient_id);
  if (!patient) return res.status(404).json({ error: 'Patient record not found.' });
  res.json({
    success: true,
    patient: {
      patient_id: patient.patient_id, full_name: patient.full_name, age: patient.age,
      gender: patient.gender, contact_phone: patient.contact_phone ?? null
    }
  });
});

router.get('/cases', async (req, res) => {
  const scope = caseScope(req.user);
  const own = await store.listRequests({ scope });
  const cases = [];
  for (const item of own) {
    const view = await loadPatientCase(store, item.request_id, scope, { timeline: false });
    if (view) cases.push(view);
  }
  res.json({ success: true, count: cases.length, cases });
});

router.get('/cases/:requestId', async (req, res) => {
  const view = await loadPatientCase(store, req.params.requestId, caseScope(req.user));
  if (!view) return res.status(404).json(NOT_FOUND);
  res.json({ success: true, case: view });
});

router.get('/cases/:requestId/tracking', async (req, res) => {
  const requestId = req.params.requestId;
  // ONE scoped query decides: not yours and missing cost the same and get the same answer (no timing oracle).
  if (!(await store.caseVisible(requestId, caseScope(req.user)))) return res.status(404).json(NOT_FOUND);
  const trips = await store.listTrips({ requestId });
  const trip = trips.find(isActive) ?? trips[0];
  res.json({ success: true, tracking: trip ? await getTracking().patientView(trip) : null });
});

export default router;
