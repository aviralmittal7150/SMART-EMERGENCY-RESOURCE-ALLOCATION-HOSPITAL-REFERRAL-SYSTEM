// js/staged.js
// The client's copy of the server's staged treatment pathways (server/services/clinicalPathways.js: STAGED_PATHWAYS
// and buildClaim; engineering assumptions D2-a1), used only to PREVIEW what "Advance to next stage" will release and
// claim. The server applies its own stored claim and re-checks capacity and safety. tests/staged_pathways_parity.test.js
// fails if this copy drifts from the server's.

export const STAGED_PATHWAYS = {
  TRAUMA: [{ resources: ['OT'], specialist: 'TRAUMA_SURGEON' }, { resources: ['ICU_BED'] }],
  POLYTRAUMA: [{ resources: ['OT'], specialist: 'TRAUMA_SURGEON' }, { resources: ['ICU_BED', 'VENTILATOR'] }]
};
const RESOURCE_TYPES = ['ICU_BED', 'VENTILATOR', 'OT'];
const EXCLUSIVE_SPECIALISTS = ['TRAUMA_SURGEON'];

/**
 * The claim the server records at intake for a staged emergency type, as [{ stage_no, units }] (buildClaim): stage 1
 * holds its resources plus any extras beyond the type's preset, and its exclusive specialist. Null for other types.
 */
export function stagedClaim(emergencyType, presetResources, requiredResources = []) {
  const staged = STAGED_PATHWAYS[emergencyType];
  if (!staged) return null;
  const extras = requiredResources.filter(r => !presetResources.includes(r));
  return staged.map((stage, index) => {
    const units = {};
    for (const t of index === 0 ? [...new Set([...stage.resources, ...extras])] : stage.resources) units[t] = (units[t] || 0) + 1;
    if (stage.specialist && EXCLUSIVE_SPECIALISTS.includes(stage.specialist)) units[stage.specialist] = 1;
    return { stage_no: index + 1, units };
  });
}

/** What moving from stage `from` to the next releases and claims under `claim`; null when there is no next stage. */
export function stagePlanFromClaim(claim, from) {
  const cur = claim?.find(s => s.stage_no === from);
  const next = claim?.find(s => s.stage_no === from + 1);
  if (!cur || !next) return null;
  const types = units => Object.keys(units).filter(t => RESOURCE_TYPES.includes(t));
  const specialist = units => Object.keys(units).find(t => EXCLUSIVE_SPECIALISTS.includes(t)) || null;
  const held = types(cur.units); const wanted = types(next.units);
  const heldSpec = specialist(cur.units); const nextSpec = specialist(next.units);
  return {
    from, to: from + 1,
    release: held.filter(t => !wanted.includes(t)),
    claim: wanted.filter(t => !held.includes(t)),
    releaseSpecialist: heldSpec && heldSpec !== nextSpec ? heldSpec : null,
    claimSpecialist: nextSpec && nextSpec !== heldSpec ? nextSpec : null
  };
}
