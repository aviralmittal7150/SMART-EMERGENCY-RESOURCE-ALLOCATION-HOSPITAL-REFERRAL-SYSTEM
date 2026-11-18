// server/services/clinicalPathways.js
// Treatment stages per emergency type: the maximum claim a case declares at intake (Phase 3 decision D2-B).
//
// ENGINEERING ASSUMPTIONS, NOT CLINICAL FACTS (D2-a1): TRAUMA = stage 1 operating theatre + trauma surgeon,
// stage 2 ICU bed; POLYTRAUMA = the same with a ventilator added to stage 2. Every other type keeps today's
// preset as one stage (D2-a2). Stage contents are policy-level upper bounds per type, not predictions for a
// patient (D2-a3). Claims are fixed at intake (D2-a4). Operator-selected extra resources join stage 1 (D2-a5).
// This module is the only place pathways are defined; validatePathways() runs at server start-up (D2-a11), so
// a team-supplied table (option C) can replace STAGED_PATHWAYS without code changes.
//
// A claim is a list of stages: [{ stage_no, units: { <type>: count } }]. Types are physical resources
// (ICU_BED, OT, VENTILATOR) and exclusive specialists (TRAUMA_SURGEON, D3-B); consultants are only checked
// for availability and are not part of a claim. Every unit has quantity 1 (G5).

import {
  VALID_RESOURCE_TYPES, EXCLUSIVE_SPECIALISTS, VALID_EMERGENCY_TYPES, resolveEmergencyRequirements
} from './emergencyRequirements.js';

/** Every type a claim (and the Banker's state) can contain, in a fixed order. */
export const CLAIM_RESOURCE_TYPES = Object.freeze([...VALID_RESOURCE_TYPES, ...EXCLUSIVE_SPECIALISTS].sort());

const deepFreeze = value => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

export const STAGED_PATHWAYS = deepFreeze({
  TRAUMA: [
    { resources: ['OT'], specialist: 'TRAUMA_SURGEON' },
    { resources: ['ICU_BED'] }
  ],
  POLYTRAUMA: [
    { resources: ['OT'], specialist: 'TRAUMA_SURGEON' },
    { resources: ['ICU_BED', 'VENTILATOR'] }
  ]
});

export class PathwayConfigError extends Error {
  constructor(problems) {
    super(`Invalid clinical pathway configuration: ${problems.join('; ')}`);
    this.name = 'PathwayConfigError';
    this.problems = problems;
  }
}

/**
 * Refuse a configuration that could make a claim weaker than today's single-stage requirement, reserve an
 * exclusive specialist anywhere but stage 1 (it is reserved with the referral), or name unknown types.
 */
export function validatePathways(pathways = STAGED_PATHWAYS) {
  const problems = [];
  for (const [type, stages] of Object.entries(pathways)) {
    if (!VALID_EMERGENCY_TYPES.includes(type)) { problems.push(`${type}: unknown emergency type`); continue; }
    if (!Array.isArray(stages) || stages.length < 2) { problems.push(`${type}: a staged pathway needs at least 2 stages`); continue; }
    const preset = resolveEmergencyRequirements(type);
    const covered = new Set();
    stages.forEach((stage, index) => {
      const where = `${type} stage ${index + 1}`;
      const resources = stage?.resources;
      if (!Array.isArray(resources)) { problems.push(`${where}: resources must be a list`); return; }
      if (new Set(resources).size !== resources.length) problems.push(`${where}: duplicate resource`);
      for (const r of resources) {
        if (!VALID_RESOURCE_TYPES.includes(r)) problems.push(`${where}: unknown resource ${r}`);
        covered.add(r);
      }
      if (stage.specialist) {
        if (!EXCLUSIVE_SPECIALISTS.includes(stage.specialist)) problems.push(`${where}: ${stage.specialist} is not an exclusive specialist`);
        else if (index !== 0) problems.push(`${where}: an exclusive specialist must be claimed in stage 1`);
      }
    });
    for (const r of preset.resourceTypes) if (!covered.has(r)) problems.push(`${type}: preset resource ${r} is in no stage`);
    if (EXCLUSIVE_SPECIALISTS.includes(preset.specialist) && stages[0]?.specialist !== preset.specialist) {
      problems.push(`${type}: the preset's ${preset.specialist} must be claimed in stage 1`);
    }
  }
  if (problems.length) throw new PathwayConfigError(problems);
  return true;
}

const unitsOf = (types, specialist) => {
  const units = {};
  for (const t of types) units[t] = (units[t] || 0) + 1;
  if (specialist && EXCLUSIVE_SPECIALISTS.includes(specialist)) units[specialist] = 1;
  return units;
};

/** One stage holding `resourceTypes` (+ the exclusive specialist, if any): the single-stage / legacy claim. */
export function singleStageClaim(resourceTypes, specialist) {
  return [{ stage_no: 1, units: unitsOf([...new Set(resourceTypes)], specialist) }];
}

/** The claim recorded at intake for a case whose requirements were resolved by resolveEmergencyRequirements. */
export function buildClaim(emergencyType, requirements, pathways = STAGED_PATHWAYS) {
  const type = String(emergencyType || '').toUpperCase();
  const staged = pathways[type];
  if (!staged) return singleStageClaim(requirements.resourceTypes, requirements.specialist);
  const preset = resolveEmergencyRequirements(type);
  const extras = requirements.resourceTypes.filter(r => !preset.resourceTypes.includes(r));
  return staged.map((stage, index) => ({
    stage_no: index + 1,
    units: unitsOf(index === 0 ? [...new Set([...stage.resources, ...extras])] : stage.resources, stage.specialist)
  }));
}

/** Rebuild a claim from stored rows [{ stage_no, resource_type, quantity }]; null when there are none. */
export function claimFromRows(rows) {
  if (!rows?.length) return null;
  const byStage = new Map();
  for (const row of rows) {
    const stage = Number(row.stage_no);
    if (!byStage.has(stage)) byStage.set(stage, {});
    byStage.get(stage)[row.resource_type] = (byStage.get(stage)[row.resource_type] || 0) + Number(row.quantity ?? 1);
  }
  const maxStage = Math.max(...byStage.keys());
  return Array.from({ length: maxStage }, (_, i) => ({ stage_no: i + 1, units: byStage.get(i + 1) || {} }));
}

/** Rows to store for a claim (one per stage and type; an empty stage stores nothing). */
export function claimRows(stages) {
  return stages.flatMap(s => Object.entries(s.units).map(([resource_type, quantity]) => ({ stage_no: s.stage_no, resource_type, quantity })));
}

export const stageOf = (stages, stageNo) => stages.find(s => s.stage_no === stageNo) || null;

/** Physical resource types of a stage, sorted (the rows a soft-lock or allocation touches). */
export const physicalTypes = stage => Object.keys(stage?.units || {}).filter(t => VALID_RESOURCE_TYPES.includes(t)).sort();

/** The exclusive specialist a stage reserves, or null. */
export const exclusiveSpecialistOf = stage => Object.keys(stage?.units || {}).find(t => EXCLUSIVE_SPECIALISTS.includes(t)) || null;

/** Maximum claim from `fromStage` on: per type, the peak over the remaining stages (D2-a8). */
export function maxClaim(stages, fromStage) {
  const max = Object.fromEntries(CLAIM_RESOURCE_TYPES.map(t => [t, 0]));
  for (const s of stages) {
    if (s.stage_no < fromStage) continue;
    for (const [t, n] of Object.entries(s.units)) if (t in max) max[t] = Math.max(max[t], n);
  }
  return max;
}

/** A vector over CLAIM_RESOURCE_TYPES from a units map. */
export const vector = (units = {}) => Object.fromEntries(CLAIM_RESOURCE_TYPES.map(t => [t, units[t] || 0]));

/** The claim in a compact, response-friendly form: [{ stage_no, resources: [...] }]. */
export const describeClaim = stages => stages.map(s => ({
  stage_no: s.stage_no,
  resources: Object.entries(s.units).flatMap(([t, n]) => Array(n).fill(t)).sort()
}));
