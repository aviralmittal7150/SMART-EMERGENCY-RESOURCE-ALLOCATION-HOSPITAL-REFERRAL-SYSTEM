// server/routes/incidents.js
// Mass-casualty incidents — /api/v1/incidents (Batch 8 P1-A/B/E). ADMIN only (accessPolicy.canSeeIncident); a desk sees
// an incident's victims only as its own patients (GET /hospitals/:id/patients), Fleet only the cases its unit serves.
//
//   POST /                      { title, incident_type, severity, location_lat, location_lng, location_text?, description?,
//                               estimated_victims?, vehicles_involved?, occurred_at?, victims?: [victim] } + optional
//                               Idempotency-Key -> 201 { success, incident, summary, victims, cases, request_ids }
//                               (a replay of the same key: the original, header Idempotent-Replayed: true; another body 422).
//                               With victims, the incident and all of them are created in ONE transaction.
//   GET  /                      { success, count, incidents: [incident + victim_count] } newest first
//   GET  /:id                   { success, incident, summary, victims, cases }   (404 when missing)
//   POST /:id/victims           { victims: [victim] } (1-100) + REQUIRED Idempotency-Key -> 201 { success, incident_id,
//                               request_ids, victims (the new ones), summary }; all or nothing; replay as above;
//                               row errors -> 400 { success: false, error, errors: [{ row, field, message }] }
//   POST /:id/victims/validate  same body -> 200 { success, valid, count, errors } (nothing is stored)
//   POST /demo-setup            not in production; idempotent -> { success, outcome: 'created' | 'existing', incident, summary,
//                               victims } (201 when created). "Highway Bus Accident" near ISBT Dehradun, 12 fictional victims
//                               (2 RED, 4 YELLOW, 6 GREEN). ?reset=1 is not implemented (501).
// victim: { full_name?, age?, gender?, injury_description, triage_category RED|YELLOW|GREEN, emergency_type,
//           transport_required? (default true), special_requirements?: { required_resource_types?, required_specialist? },
//           pickup_lat?, pickup_lng? (default: the incident location; must be inside the operating area) }
// Audit: INCIDENT_CREATED, VICTIMS_REGISTERED, plus REQUEST_CREATED per victim (all in the chained ledger).

import express from 'express';
import { createHash } from 'node:crypto';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { canSeeIncident } from '../services/accessPolicy.js';
import { ValidationError } from '../services/validation.js';
import { validateIncident, validateVictims, incidentDetail, incidentView, DEMO_INCIDENT, DEMO_VICTIMS } from '../services/incidents.js';

const router = express.Router();
router.use(authenticate, authorize('ADMIN'));

const actorOf = req => ({ role: req.user.role, id: req.user.user_id });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function respond(res, work) {
  return work().catch(err => {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, error: err.message });
    if (!respondStoreError(res, err)) throw err;
    return undefined;
  });
}

/** The Idempotency-Key header: undefined (none), the key, or false after a 400 was sent. */
function idempotencyKeyOf(req, res, { required = false } = {}) {
  const key = req.get('Idempotency-Key');
  if (key === undefined && !required) return undefined;
  if (key === undefined || !IDEMPOTENCY_KEY.test(key)) {
    res.status(400).json({ success: false, error: 'Idempotency-Key must be 1-100 characters: letters, digits, "_", "-", ".", ":".' });
    return false;
  }
  return key;
}

const rowErrors = (res, errors) => res.status(400).json({
  success: false, error: `${errors.length} problem${errors.length === 1 ? '' : 's'} in the victims list; nothing was saved.`, errors
});

async function visibleIncident(req, res) {
  const incident = await store.getIncident(req.params.incidentId);
  if (!canSeeIncident(req.user, incident)) { res.status(404).json({ success: false, error: 'Incident not found.' }); return null; }
  return incident;
}

// ── Demo (P1-E): serialised in this process; the store's demo flag makes it idempotent ──
let demoQueue = Promise.resolve();
router.post('/demo-setup', (req, res) => respond(res, async () => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ success: false, error: 'The incident demo is not available in production.' });
  if (req.query.reset !== undefined) return res.status(501).json({ success: false, error: 'Resetting the demo incident is not implemented yet.' });
  const run = demoQueue.then(async () => {
    const existing = await store.findDemoIncident();
    if (existing) return { outcome: 'existing', row: existing };
    const { inputs, errors } = validateVictims(DEMO_VICTIMS.map(v => ({ ...v })), DEMO_INCIDENT);
    if (errors.length) throw new Error(`The demo victims are invalid: ${JSON.stringify(errors)}`);
    const created = await store.createIncident({ ...DEMO_INCIDENT, occurred_at: new Date().toISOString() }, inputs, actorOf(req), { isDemo: true });
    return { outcome: 'created', row: await store.getIncident(created.incident_id) };
  });
  demoQueue = run.catch(() => {});
  const { outcome, row } = await run;
  res.status(outcome === 'created' ? 201 : 200).json({ success: true, outcome, ...(await incidentDetail(store, row)) });
}));

router.get('/', (req, res) => respond(res, async () => {
  const incidents = (await store.listIncidents()).filter(i => canSeeIncident(req.user, i)).map(i => incidentView(i, i.victim_count));
  res.json({ success: true, count: incidents.length, incidents });
}));

router.post('/', (req, res) => respond(res, async () => {
  const key = idempotencyKeyOf(req, res);
  if (key === false) return;
  const fields = validateIncident(req.body);
  const rows = req.body.victims;
  let inputs = [];
  if (rows !== undefined && rows !== null && !(Array.isArray(rows) && rows.length === 0)) {
    const checked = validateVictims(rows, fields);
    if (checked.errors.length) return rowErrors(res, checked.errors);
    inputs = checked.inputs;
  }
  const idempotency = key === undefined ? null : { key, endpoint: 'POST /incidents', fingerprint: fingerprint({ fields, inputs }) };
  const created = await store.createIncident(fields, inputs, actorOf(req), { idempotency });
  if (created.replayed) res.set('Idempotent-Replayed', 'true');
  const detail = await incidentDetail(store, await store.getIncident(created.incident_id));
  res.status(201).json({ success: true, ...detail, request_ids: created.request_ids });
}));

router.get('/:incidentId', (req, res) => respond(res, async () => {
  const incident = await visibleIncident(req, res);
  if (!incident) return;
  res.json({ success: true, ...(await incidentDetail(store, incident)) });
}));

router.post('/:incidentId/victims/validate', (req, res) => respond(res, async () => {
  const incident = await visibleIncident(req, res);
  if (!incident) return;
  const { errors } = validateVictims(req.body?.victims, incident);
  res.json({ success: true, valid: errors.length === 0, count: Array.isArray(req.body?.victims) ? req.body.victims.length : 0, errors });
}));

router.post('/:incidentId/victims', (req, res) => respond(res, async () => {
  const key = idempotencyKeyOf(req, res, { required: true });
  if (key === false) return;
  const incident = await visibleIncident(req, res);
  if (!incident) return;
  const { inputs, errors } = validateVictims(req.body?.victims, incident);
  if (errors.length) return rowErrors(res, errors);
  const idempotency = { key, endpoint: `POST /incidents/${incident.incident_id}/victims`, fingerprint: fingerprint(inputs) };
  const added = await store.addIncidentVictims(incident.incident_id, inputs, actorOf(req), { idempotency });
  if (added.replayed) res.set('Idempotent-Replayed', 'true');
  const detail = await incidentDetail(store, await store.getIncident(incident.incident_id));
  const mine = new Set(added.request_ids);
  res.status(201).json({ success: true, incident_id: incident.incident_id, request_ids: added.request_ids,
    victims: detail.victims.filter(v => mine.has(v.request_id)), summary: detail.summary });
}));

export default router;
