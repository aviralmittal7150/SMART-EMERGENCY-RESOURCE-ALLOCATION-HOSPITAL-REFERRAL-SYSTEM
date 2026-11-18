// server/services/caseIntake.js
// The ONE per-case intake rule set, shared by POST /emergencies (one case) and POST /incidents (Batch 8: a
// mass-casualty incident registering 2-50 cases at once): field validation matching the columns, the resolved
// requirements, and the { patient, request } input both stores' createRequest / createIncident take.

import { VALID_EMERGENCY_TYPES, resolveEmergencyRequirements } from './emergencyRequirements.js';

// Lengths match the columns: Patient.full_name VARCHAR(150), contact_phone VARCHAR(30), clinical_notes TEXT (65,535
// bytes), required_specialist VARCHAR(40); Patient.age is required, 0-130; triage 1-5.
export const CASE_FIELDS = Object.freeze({
  age: { type: 'integer', required: true, min: 0, max: 130 },
  gender: { type: 'enum', values: ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'], upper: true, default: 'UNKNOWN' },
  emergency_type: { type: 'enum', required: true, values: VALID_EMERGENCY_TYPES, upper: true },
  triage_priority: { type: 'integer', min: 1, max: 5, default: 3 },
  clinical_notes: { type: 'string', nullable: true, maxLength: 20000, maxBytes: 65535 },
  required_resources: { type: 'strings', maxItems: 10, maxLength: 20, default: [] },
  required_specialist: { type: 'string', nullable: true, maxLength: 40, emptyAs: null }
});

/**
 * The store input for one validated case, or null when the requirements are invalid. `valid` holds the CASE_FIELDS
 * values plus full_name (may be null for an incident patient, named by the store), pickup and contact.
 */
export function buildCaseInput(valid) {
  const requirements = resolveEmergencyRequirements(valid.emergency_type, valid.required_resources ?? [], valid.required_specialist ?? null);
  if (!requirements) return null;
  return {
    patient: {
      full_name:       valid.full_name ?? null,
      age:             valid.age,
      gender:          valid.gender,
      emergency_type:  valid.emergency_type,
      triage_priority: valid.triage_priority,
      contact_phone:   valid.contact_phone || null
    },
    request: {
      emergency_type:          valid.emergency_type,
      required_resource_types: requirements.resourceTypes,
      required_specialist:     requirements.specialist,
      priority:                valid.triage_priority,
      pickup_lat:              valid.pickup_lat ?? null,
      pickup_lng:              valid.pickup_lng ?? null,
      clinical_notes:          valid.clinical_notes || ''
    }
  };
}
