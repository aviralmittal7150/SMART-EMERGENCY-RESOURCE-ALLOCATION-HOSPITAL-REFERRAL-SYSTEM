// Shared emergency requirement resolution for API validation and referral safety.

export const VALID_RESOURCE_TYPES = ['ICU_BED', 'VENTILATOR', 'OT'];

const EMERGENCY_REQUIREMENTS = {
  CARDIAC: { resources: ['ICU_BED', 'VENTILATOR'], specialist: 'CARDIOLOGIST' },
  TRAUMA: { resources: ['ICU_BED', 'OT'], specialist: 'TRAUMA_SURGEON' },
  POLYTRAUMA: { resources: ['ICU_BED', 'OT'], specialist: 'TRAUMA_SURGEON' },
  STROKE: { resources: ['ICU_BED'], specialist: 'NEUROLOGIST' },
  RESPIRATORY: { resources: ['ICU_BED', 'VENTILATOR'], specialist: null },
  PEDIATRIC: { resources: ['ICU_BED'], specialist: 'PEDIATRICIAN' },
  GENERAL: { resources: [], specialist: null }
};

export const VALID_EMERGENCY_TYPES = Object.keys(EMERGENCY_REQUIREMENTS);

/**
 * Resolve requirements from the operational emergency category and optional
 * operator-selected extras. Preset requirements cannot be removed by a client.
 */
export function resolveEmergencyRequirements(emergencyType, requestedResources = [], requestedSpecialist = null) {
  const type = String(emergencyType || '').trim().toUpperCase();
  const preset = EMERGENCY_REQUIREMENTS[type];
  if (!preset) return null;

  const extras = Array.isArray(requestedResources)
    ? requestedResources.map(value => String(value).trim().toUpperCase())
    : [];
  if (extras.some(value => !VALID_RESOURCE_TYPES.includes(value))) return null;

  const requestedSpecialistValue = requestedSpecialist
    ? String(requestedSpecialist).trim().toUpperCase()
    : null;

  // A client may add an operational specialist requirement when the preset has
  // none, but it must not replace the specialist that makes the emergency
  // category safe to route (for example, a CARDIAC case cannot be changed to
  // NEUROLOGIST by the intake client).
  if (preset.specialist && requestedSpecialistValue && requestedSpecialistValue !== preset.specialist) {
    return null;
  }

  const specialist = requestedSpecialistValue || preset.specialist;

  const validSpecialists = ['CARDIOLOGIST', 'NEUROLOGIST', 'TRAUMA_SURGEON', 'PEDIATRICIAN'];
  if (specialist && !validSpecialists.includes(specialist)) return null;

  return {
    resourceTypes: [...new Set([...preset.resources, ...extras])],
    specialist: specialist || null
  };
}
