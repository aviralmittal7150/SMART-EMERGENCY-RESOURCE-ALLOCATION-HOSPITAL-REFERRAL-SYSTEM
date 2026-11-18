// server/services/caseEvents.js
// Batch 8: the `case:status` socket event. Every case status change is recorded on the audit chain (STATUS_CHANGED from
// the one status-change path, by any actor; ALLOCATION_COMMITTED when a hospital accepts), so the event is derived from
// those audit rows: nothing can change a case's status without it. server.js sends it to caseStatusRooms
// (accessPolicy.js): the command centre, the hospital holding the case, the unit still serving it. Nobody else.
//
// Payload: { request_id, status, previous_status, milestone, hospital_id, incident_id, at }
//   status / previous_status  the case status after / before (equal for a milestone that does not change it)
//   milestone     ACCEPTED | ARRIVED | BED_ALLOCATED | TREATMENT_STARTED | TREATMENT_NOTE | COMPLETED | CANCELLED |
//                 TRIAGE_UPDATED | STATUS_CHANGED (any other status move)
//   hospital_id   the hospital of the case's latest ACCEPTED referral, or null (then only the command centre gets it)
//   incident_id   the case's mass-casualty incident, or null
//   at            the audit row's time (ISO 8601)

import { acceptedHospitalId } from './patientView.js';
import { caseStatusRooms } from './accessPolicy.js';

export const CASE_STATUS_EVENT = 'case:status';

const STATUS_MILESTONES = { ALLOCATED: 'ACCEPTED', IN_TREATMENT: 'TREATMENT_STARTED', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };
// Audit rows that record a milestone without a status change (the status is read from the case).
const MILESTONE_EVENTS = { PATIENT_ARRIVED: 'ARRIVED', BED_ALLOCATED: 'BED_ALLOCATED', TREATMENT_NOTE: 'TREATMENT_NOTE', TRIAGE_UPDATED: 'TRIAGE_UPDATED' };

/**
 * What an audit row changes ({ previous_status, status, milestone }; status null = read the current one), or null.
 * TREATMENT_STARTED / TREATMENT_COMPLETED / RESOURCE_RELEASED rows are written in the same transaction as their
 * STATUS_CHANGED row, which already announces the change, so they send nothing (no duplicate event).
 */
export function caseStatusChange(entry) {
  if (!entry?.request_id) return null;
  if (entry.event_type === 'STATUS_CHANGED' && entry.new_state) {
    return { previous_status: entry.previous_state ?? null, status: entry.new_state, milestone: STATUS_MILESTONES[entry.new_state] ?? 'STATUS_CHANGED' };
  }
  // The acceptance handshake: the case was MATCHING while the referral was pending.
  if (entry.event_type === 'ALLOCATION_COMMITTED') return { previous_status: 'MATCHING', status: 'ALLOCATED', milestone: 'ACCEPTED' };
  if (MILESTONE_EVENTS[entry.event_type]) return { previous_status: null, status: null, milestone: MILESTONE_EVENTS[entry.event_type] };
  return null;
}

const iso = value => {
  const ms = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
};

const metadataOf = entry => {
  if (!entry.metadata) return {};
  if (typeof entry.metadata === 'string') { try { return JSON.parse(entry.metadata); } catch { return {}; } }
  return entry.metadata;
};

/** { rooms, payload } for an audit row that changes a case's status or milestone, read from the case now; else null. */
export async function caseStatusEvent(store, entry) {
  const change = caseStatusChange(entry);
  if (!change) return null;
  const detail = await store.getRequestDetail(entry.request_id);
  const hospitalId = detail ? acceptedHospitalId(detail.acceptances ?? []) : null;
  // The unit on the road for the case, and the units whose seat this very change released (handover at arrival).
  const meta = metadataOf(entry);
  const units = new Set([detail?.request?.assigned_ambulance_id, meta.ambulance_id, ...(meta.released_seats ?? [])].filter(Boolean));
  const current = detail?.request?.status ?? null;
  return {
    rooms: caseStatusRooms({ hospitalId, ambulanceIds: [...units] }),
    payload: {
      request_id: entry.request_id,
      status: change.status ?? current,
      previous_status: change.status ? change.previous_status : current,
      milestone: change.milestone,
      hospital_id: hospitalId,
      incident_id: detail?.request?.incident_id ?? null,
      at: iso(entry.event_time_ms ?? entry.event_time)
    }
  };
}
