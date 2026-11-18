// server/services/registrationReport.js
// GET /api/v1/analytics/my-registrations (Batch 6, round 4): the caller's own registered cases and their lifecycle
// milestones, read from the recorded lifecycle and audit data only. Pure: both stores hand it the same raw rows, so
// both give identical results. Nothing is estimated: a milestone that has not happened is null, and so are its minutes.
//
// Milestones (first occurrence in the audit trail, ordered by event time then history_id):
//   first_referral_at  LOCK_ACQUIRED (a referral placed, by anyone, including failovers)
//   accepted_at        ALLOCATION_COMMITTED (the referral acceptance commit); its hospital_id is the accepting hospital
//   dispatched_at      the earliest of: an ALLOCATION_COMMITTED that auto-dispatched a unit (metadata.ambulance_id), or an
//                      AMBULANCE_STATUS_CHANGED to DISPATCHED for the case (manual dispatch); ambulance_id from that row
//   completed_at       STATUS_CHANGED to COMPLETED
// Means follow decision S6-2 (D8-a2): reported only with at least THRESHOLDS.minObservations observations, else null
// with the sample size still reported. Per-case minutes are facts and are always returned.

import { THRESHOLDS, DAY_MS } from './analyticsEngine.js';

export const REGISTRATION_EVENT_TYPES = Object.freeze(['LOCK_ACQUIRED', 'ALLOCATION_COMMITTED', 'AMBULANCE_STATUS_CHANGED', 'STATUS_CHANGED']);
export const REGISTRATION_LIMITS = Object.freeze({ defaultDays: 30, maxDays: 366, defaultLimit: 200, maxLimit: 500 });

const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const minutes = (from, to) => (from === null || to === null ? null : Math.round(((to - from) / 60_000) * 100) / 100);
const meta = m => {
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return {}; } }
  return m;
};

/** The window [from, to) in epoch ms for `days` days ending now. */
export function registrationWindow(days, nowMs) {
  return { fromMs: nowMs - days * DAY_MS, toMs: nowMs };
}

function caseView(r, events, hospitalNames) {
  const ordered = events.sort((a, b) => (a.ms - b.ms) || (Number(a.history_id) - Number(b.history_id)));
  const first = pred => ordered.find(pred) ?? null;
  const referral = first(e => e.event_type === 'LOCK_ACQUIRED');
  const accepted = first(e => e.event_type === 'ALLOCATION_COMMITTED');
  const dispatch = first(e => (e.event_type === 'ALLOCATION_COMMITTED' && meta(e.metadata).ambulance_id)
    || (e.event_type === 'AMBULANCE_STATUS_CHANGED' && e.new_state === 'DISPATCHED'));
  const completed = first(e => e.event_type === 'STATUS_CHANGED' && e.new_state === 'COMPLETED');
  const at = e => (e ? e.ms : null);
  return {
    request_id: r.request_id,
    patient_id: r.patient_id,
    patient_name: r.full_name ?? null,
    age: r.age === null || r.age === undefined ? null : Number(r.age),
    gender: r.gender ?? null,
    emergency_type: r.emergency_type,
    triage_priority: Number(r.priority),
    status: r.status,
    registered_at: iso(r.registered_ms),
    first_referral_at: iso(at(referral)),
    accepted_at: iso(at(accepted)),
    accepted_hospital_id: accepted?.hospital_id ?? null,
    accepted_hospital_name: accepted?.hospital_id ? (hospitalNames.get(accepted.hospital_id) ?? null) : null,
    dispatched_at: iso(at(dispatch)),
    ambulance_id: dispatch ? (meta(dispatch.metadata).ambulance_id ?? null) : null,
    completed_at: iso(at(completed)),
    minutes_to_acceptance: minutes(r.registered_ms, at(accepted)),
    minutes_to_dispatch: minutes(r.registered_ms, at(dispatch)),
    minutes_to_completion: minutes(r.registered_ms, at(completed)),
    _registered_ms: r.registered_ms
  };
}

function gatedMean(values, minN) {
  if (values.length < minN || values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/**
 * raw: { requests:[{request_id, patient_id, full_name, age, gender, emergency_type, priority, status, registered_ms}],
 *        events:[{request_id, event_type, new_state, hospital_id, metadata, ms, history_id}], hospitals:[{hospital_id, hospital_name}] }
 * Requests are already the caller's, non-demo, inside the window. Returns the response body minus `success`.
 */
export function registrationReport(raw, window, limit, { minN = THRESHOLDS.minObservations } = {}) {
  const names = new Map(raw.hospitals.map(h => [h.hospital_id, h.hospital_name]));
  const byCase = new Map(raw.requests.map(r => [r.request_id, []]));
  for (const e of raw.events) byCase.get(e.request_id)?.push(e);
  const all = raw.requests.map(r => caseView(r, byCase.get(r.request_id), names))
    .sort((a, b) => (b._registered_ms - a._registered_ms) || (a.request_id < b.request_id ? 1 : a.request_id > b.request_id ? -1 : 0));
  const sample = key => all.map(c => c[key]).filter(v => v !== null);
  const acceptance = sample('minutes_to_acceptance');
  const dispatch = sample('minutes_to_dispatch');
  const completion = sample('minutes_to_completion');
  return {
    window: { from: iso(window.fromMs), to: iso(window.toMs) },
    summary: {
      count: all.length,
      accepted_count: all.filter(c => c.accepted_at !== null).length,
      completed_count: all.filter(c => c.completed_at !== null).length,
      open_count: all.filter(c => !['COMPLETED', 'CANCELLED'].includes(c.status)).length,
      avg_minutes_to_acceptance: gatedMean(acceptance, minN),
      avg_minutes_to_dispatch: gatedMean(dispatch, minN),
      avg_minutes_to_completion: gatedMean(completion, minN),
      sample_size: { acceptance: acceptance.length, dispatch: dispatch.length, completion: completion.length },
      minimum_sample: minN
    },
    cases: all.slice(0, limit).map(({ _registered_ms: _drop, ...c }) => c)
  };
}
