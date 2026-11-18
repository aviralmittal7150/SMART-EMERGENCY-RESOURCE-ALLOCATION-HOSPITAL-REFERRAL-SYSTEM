// server/services/incidents.js
// Batch 8 (P1-A/B/E): mass-casualty incidents. The ONE rule set shared by the routes (server/routes/incidents.js) and
// both stores (createIncident / addIncidentVictims):
//  - incident fields (migration 011 Incident columns) and victim rows, validated row by row (row-level errors for the
//    CSV preview, POST /incidents/:id/victims/validate);
//  - triage_category -> triage_priority for the existing engines (RED 1, YELLOW 3, GREEN 4; there is no BLACK);
//  - anonymous victims are named MCI-001, MCI-002 ... from their number within the incident (incident_seq);
//  - the victim view and the incident summary (counts by triage category and by stage) built from the cases.
// A victim IS an ordinary case (EmergencyRequest + Patient) linked by incident_id: referral, dispatch, tracking and the
// hospital steps all work on it unchanged. Triage is decision support only.

import { validateFields, ValidationError } from './validation.js';
import { CASE_FIELDS, buildCaseInput } from './caseIntake.js';
import { areaProblem, LOCALITIES } from './operatingArea.js';

export const INCIDENT_TYPES = Object.freeze(['bus_crash', 'train_accident', 'building_collapse', 'fire', 'industrial_accident', 'road_accident', 'other']);
export const SEVERITIES = Object.freeze(['low', 'moderate', 'high', 'critical']);
export const TRIAGE_CATEGORIES = Object.freeze(['RED', 'YELLOW', 'GREEN']);
export const TRIAGE_PRIORITY = Object.freeze({ RED: 1, YELLOW: 3, GREEN: 4 });
export const MAX_VICTIMS_PER_REQUEST = 100;

/** The anonymous label of the n-th victim of an incident (stable: incident_seq never changes). */
export const victimLabel = seq => `MCI-${String(seq).padStart(3, '0')}`;
/** Today's incident id prefix (UTC), e.g. INC-20261115-. */
export const incidentIdPrefix = (date = new Date()) => `INC-${date.toISOString().slice(0, 10).replaceAll('-', '')}-`;
export const incidentId = (prefix, n) => `${prefix}${String(n).padStart(3, '0')}`;

// Lengths match the Incident columns.
export const INCIDENT_FIELDS = Object.freeze({
  title: { type: 'string', required: true, maxLength: 150 },
  incident_type: { type: 'enum', required: true, values: INCIDENT_TYPES },
  severity: { type: 'enum', required: true, values: SEVERITIES },
  location_text: { type: 'string', nullable: true, maxLength: 255, emptyAs: null },
  location_lat: { type: 'number', required: true, min: -90, max: 90 },
  location_lng: { type: 'number', required: true, min: -180, max: 180 },
  description: { type: 'string', nullable: true, maxLength: 2000, emptyAs: null },
  estimated_victims: { type: 'integer', nullable: true, min: 0, max: 1000 },
  vehicles_involved: { type: 'integer', nullable: true, min: 0, max: 500 },
  occurred_at: { type: 'string', nullable: true, maxLength: 40, emptyAs: null }
});

// One victim row. Name and age are optional (an unidentified victim); injury and triage are required.
const VICTIM_FIELDS = Object.freeze({
  full_name: { type: 'string', nullable: true, maxLength: 150, emptyAs: null },
  age: { ...CASE_FIELDS.age, required: false, nullable: true },
  gender: CASE_FIELDS.gender,
  injury_description: { type: 'string', required: true, maxLength: 500 },
  triage_category: { type: 'enum', required: true, values: TRIAGE_CATEGORIES, upper: true },
  emergency_type: CASE_FIELDS.emergency_type,
  transport_required: { type: 'boolean', default: true },
  pickup_lat: { type: 'number', nullable: true, min: -90, max: 90 },
  pickup_lng: { type: 'number', nullable: true, min: -180, max: 180 }
});
const SPECIAL_FIELDS = Object.freeze({
  required_resource_types: CASE_FIELDS.required_resources,
  required_specialist: CASE_FIELDS.required_specialist
});

// No ambulance needed (walking wounded): recorded with the injury in the case's clinical notes (no extra column).
const NO_TRANSPORT_MARK = '\n[No ambulance needed]';

/** Validated incident fields (throws ValidationError), with the operating-area check. */
export function validateIncident(body) {
  const valid = validateFields(body, INCIDENT_FIELDS);
  const outside = areaProblem([['The incident location', valid.location_lat, valid.location_lng]]);
  if (outside) throw new ValidationError(outside);
  if (valid.occurred_at != null) {
    const t = Date.parse(valid.occurred_at);
    if (!Number.isFinite(t)) throw new ValidationError('occurred_at must be an ISO date-time.');
    valid.occurred_at = new Date(t).toISOString();
  }
  return valid;
}

/**
 * Validate victim rows against an incident. Returns { inputs, errors }: inputs are the store inputs
 * ({ patient, request, triage_category }) when there are no errors; errors are [{ row (0-based), field, message }].
 */
export function validateVictims(victims, incident) {
  const errors = [];
  if (!Array.isArray(victims) || victims.length === 0) {
    return { inputs: [], errors: [{ row: -1, field: 'victims', message: 'victims must be a non-empty list.' }] };
  }
  if (victims.length > MAX_VICTIMS_PER_REQUEST) {
    return { inputs: [], errors: [{ row: -1, field: 'victims', message: `At most ${MAX_VICTIMS_PER_REQUEST} victims per request (got ${victims.length}).` }] };
  }
  const inputs = victims.map((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ row: i, field: null, message: 'Each victim must be an object.' });
      return null;
    }
    // Every field is checked on its own, so a row reports all its problems at once.
    const valid = {};
    let ok = true;
    for (const [name, rule] of Object.entries(VICTIM_FIELDS)) {
      try {
        Object.assign(valid, validateFields(Object.prototype.hasOwnProperty.call(row, name) ? { [name]: row[name] } : {}, { [name]: rule }));
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push({ row: i, field: name, message: err.message });
        ok = false;
      }
    }
    let special = { required_resource_types: [], required_specialist: null };
    if (row.special_requirements !== undefined && row.special_requirements !== null) {
      try { special = { ...special, ...validateFields(row.special_requirements, SPECIAL_FIELDS) }; } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push({ row: i, field: 'special_requirements', message: err.message });
        ok = false;
      }
    }
    if (!ok) return null;
    const lat = valid.pickup_lat ?? (valid.pickup_lng == null ? Number(incident.location_lat) : null);
    const lng = valid.pickup_lng ?? (valid.pickup_lat == null ? Number(incident.location_lng) : null);
    const outside = areaProblem([['The pickup point', lat, lng]]);
    if (outside || lat == null || lng == null) {
      errors.push({ row: i, field: 'pickup_lat', message: outside || 'The pickup point needs both latitude and longitude.' });
      return null;
    }
    const input = buildCaseInput({
      ...valid, age: valid.age ?? null, triage_priority: TRIAGE_PRIORITY[valid.triage_category],
      required_resources: special.required_resource_types, required_specialist: special.required_specialist,
      pickup_lat: lat, pickup_lng: lng,
      clinical_notes: `${valid.injury_description}${valid.transport_required === false ? NO_TRANSPORT_MARK : ''}`
    });
    if (!input) {
      errors.push({ row: i, field: 'special_requirements', message: 'Invalid required_resource_types or required_specialist.' });
      return null;
    }
    return { ...input, triage_category: valid.triage_category };
  });
  return errors.length ? { inputs: [], errors } : { inputs, errors };
}

/** Plain incident row for the API. */
export function incidentView(row, victimCount = null) {
  if (!row) return null;
  const iso = t => (t == null ? null : new Date(t).toISOString());
  return {
    incident_id: row.incident_id, title: row.title, incident_type: row.incident_type, severity: row.severity,
    location_text: row.location_text ?? null, location_lat: Number(row.location_lat), location_lng: Number(row.location_lng),
    description: row.description ?? null,
    estimated_victims: row.estimated_victims == null ? null : Number(row.estimated_victims),
    vehicles_involved: row.vehicles_involved == null ? null : Number(row.vehicles_involved),
    occurred_at: iso(row.occurred_at), created_by: row.created_by ?? null, created_at: iso(row.created_at),
    is_demo: Number(row.is_demo) === 1,
    ...(victimCount === null ? {} : { victim_count: Number(victimCount) })
  };
}

const OPEN = ['NEW', 'WAITING', 'MATCHING', 'ALLOCATED', 'IN_TREATMENT'];

/** One victim (a case from store.listRequests, plus its referrals) for GET /incidents/:id. */
export function victimView(r, acceptances = []) {
  const p = r.patient ?? {};
  const notes = String(r.clinical_notes ?? '');
  const transport = !notes.endsWith(NO_TRANSPORT_MARK);
  const pending = acceptances.filter(a => a.status === 'PENDING').at(-1) ?? null;
  const accepted = r.accepted_hospital_id ?? null;
  // Escalation: a referral was refused or expired and nobody holds or is considering the case now (P1-C).
  const escalated = ['NEW', 'WAITING'].includes(r.status) && !accepted && !pending
    && acceptances.some(a => ['REJECTED', 'EXPIRED'].includes(a.status));
  const iso = t => (t == null ? null : new Date(t).toISOString());
  return {
    request_id: r.request_id, incident_id: r.incident_id, incident_seq: r.incident_seq == null ? null : Number(r.incident_seq),
    label: r.incident_seq == null ? (p.full_name ?? r.request_id) : victimLabel(Number(r.incident_seq)),
    full_name: p.full_name ?? null, age: p.age == null ? null : Number(p.age), gender: p.gender ?? null,
    triage_category: r.triage_category ?? null, triage_priority: Number(r.priority), emergency_type: r.emergency_type,
    injury_description: transport ? notes : notes.slice(0, -NO_TRANSPORT_MARK.length), transport_required: transport,
    required_resource_types: r.required_resource_types ?? [], required_specialist: r.required_specialist ?? null,
    status: r.status, ambulance_id: r.assigned_ambulance_id ?? null,
    accepted_hospital_id: accepted, pending_hospital_id: pending?.hospital_id ?? r.pending_hospital_id ?? null,
    pending_acceptance_id: pending?.acceptance_id ?? null, escalated,
    pickup_lat: r.pickup_lat == null ? null : Number(r.pickup_lat), pickup_lng: r.pickup_lng == null ? null : Number(r.pickup_lng),
    arrived_at: iso(r.arrived_at), bed_label: r.bed_label ?? null, treatment_started_at: iso(r.treatment_started_at),
    treatment_completed_at: iso(r.treatment_completed_at), is_demo: Number(r.is_demo) === 1
  };
}

/** Counts by triage category and by stage (each victim in exactly one stage). */
export function incidentSummary(incident, victims) {
  const s = {
    total_victims: victims.length, estimated_victims: incident.estimated_victims ?? null,
    by_triage: { RED: 0, YELLOW: 0, GREEN: 0 },
    awaiting_ambulance: 0, assigned: 0, arrived: 0, in_treatment: 0, completed: 0, cancelled: 0, unallocated: 0,
    referral_pending: 0, accepted: 0
  };
  for (const v of victims) {
    if (v.triage_category in s.by_triage) s.by_triage[v.triage_category] += 1;
    if (v.status === 'COMPLETED') { s.completed += 1; continue; }
    if (v.status === 'CANCELLED') { s.cancelled += 1; continue; }
    if (v.status === 'IN_TREATMENT') { s.in_treatment += 1; continue; }
    if (v.arrived_at) { s.arrived += 1; continue; }
    if (v.ambulance_id) { s.assigned += 1; continue; }
    if (v.escalated) s.unallocated += 1;
    if (v.pending_hospital_id) s.referral_pending += 1;
    if (v.accepted_hospital_id) s.accepted += 1;
    if (v.transport_required && OPEN.includes(v.status)) s.awaiting_ambulance += 1;
  }
  return s;
}

/** GET /incidents/:id: { incident, summary, victims } (victims also as `cases`), built from the store. */
export async function incidentDetail(store, incidentRow) {
  const [requests, acceptances] = await Promise.all([store.listRequests(), store.listAcceptances()]);
  const mine = requests.filter(r => r.incident_id === incidentRow.incident_id)
    .sort((a, b) => Number(a.incident_seq) - Number(b.incident_seq));
  const ids = new Set(mine.map(r => r.request_id));
  const byRequest = new Map();
  for (const a of acceptances) if (ids.has(a.request_id)) (byRequest.get(a.request_id) ?? byRequest.set(a.request_id, []).get(a.request_id)).push(a);
  const victims = mine.map(r => victimView(r, byRequest.get(r.request_id) ?? []));
  const incident = incidentView(incidentRow, victims.length);
  return { incident, summary: incidentSummary(incident, victims), victims, cases: victims };
}

// ── P1-E demo: "Highway Bus Accident" (fictional), 12 victims: 2 RED, 4 YELLOW, 6 GREEN ──
export const DEMO_INCIDENT = Object.freeze({
  title: 'Highway Bus Accident',
  incident_type: 'bus_crash',
  severity: 'high',
  location_text: 'Haridwar Road near ISBT Dehradun (fictional demo)',
  location_lat: LOCALITIES.ISBT.lat,
  location_lng: LOCALITIES.ISBT.lng,
  description: 'Fictional demo: an inter-city bus overturned on the highway near ISBT. All victims are fictional.',
  estimated_victims: 12,
  vehicles_involved: 1
});
const demoRow = (triage, type, injury, age, gender) => ({ triage_category: triage, emergency_type: type, injury_description: injury, age, gender, transport_required: true });
export const DEMO_VICTIMS = Object.freeze([
  demoRow('RED', 'TRAUMA', 'Head injury, unconscious', 38, 'MALE'),
  demoRow('RED', 'RESPIRATORY', 'Chest trauma, breathing difficulty', 55, 'FEMALE'),
  demoRow('YELLOW', 'TRAUMA', 'Open leg fracture', 29, 'MALE'),
  demoRow('YELLOW', 'TRAUMA', 'Arm fracture with bleeding', 44, 'FEMALE'),
  demoRow('YELLOW', 'GENERAL', 'Abdominal pain after impact', null, 'UNKNOWN'),
  demoRow('YELLOW', 'GENERAL', 'Deep cut on the forehead', 61, 'MALE'),
  demoRow('GREEN', 'GENERAL', 'Minor cuts and bruises', 23, 'FEMALE'),
  demoRow('GREEN', 'GENERAL', 'Sprained ankle', 34, 'MALE'),
  demoRow('GREEN', 'GENERAL', 'Minor cuts and bruises', 12, 'FEMALE'),
  demoRow('GREEN', 'GENERAL', 'Shoulder bruise', 47, 'MALE'),
  demoRow('GREEN', 'GENERAL', 'Shock, no visible injury', null, 'UNKNOWN'),
  { ...demoRow('GREEN', 'GENERAL', 'Grazed hands', 30, 'MALE'), transport_required: false }
]);
