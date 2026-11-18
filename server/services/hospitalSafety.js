// server/services/hospitalSafety.js
// Builds one hospital's Banker's state from rows both storage engines read UNDER that hospital's lock, and
// takes the admission / stage-advance decisions with server/services/bankers.js. Pure: no I/O.
//
//   Available   free units per type (available_capacity - locked_capacity) and AVAILABLE exclusive specialists.
//               Occupancy no case owns (for example seeded in-use beds) is never released, so it is not
//               available and belongs to no case (G4).
//   Allocation  per case: soft-locked + committed units at this hospital, and its active specialist assignment.
//   Max         per case: peak requirement over its remaining stages (D2-a8). A case with no recorded claim
//               (created before claims existed, or inserted directly) is a legacy single-stage case: its
//               maximum is exactly what it holds, so it never waits for more (D2-a10).

import { evaluateSafety, requestResources, explain } from './bankers.js';
import { CLAIM_RESOURCE_TYPES, maxClaim, stageOf, vector } from './clinicalPathways.js';
import { EXCLUSIVE_SPECIALISTS } from './emergencyRequirements.js';

const TYPES = CLAIM_RESOURCE_TYPES;
const pick = (v, f) => Object.fromEntries(TYPES.map(t => [t, f(t, v[t] || 0)]));

/**
 * resources:            [{ resource_type, available_capacity, locked_capacity }]
 * specialistsAvailable: { TRAUMA_SURGEON: n }
 * cases:                [{ id, stages | null, currentStage, held: { type: n } }]
 */
export function buildHospitalState({ resources, specialistsAvailable = {}, cases }) {
  const available = vector();
  for (const r of resources) {
    if (r.resource_type in available) available[r.resource_type] = Math.max(0, Number(r.available_capacity) - Number(r.locked_capacity));
  }
  for (const s of EXCLUSIVE_SPECIALISTS) available[s] = Number(specialistsAvailable[s] || 0);
  const anomalies = [];
  const processes = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(c => {
    const allocation = vector(c.held);
    let max;
    if (!c.stages) {
      max = { ...allocation }; // legacy single-stage: holds exactly its claim
    } else {
      const peak = maxClaim(c.stages, c.currentStage);
      const over = TYPES.filter(t => allocation[t] > peak[t]);
      if (over.length) anomalies.push({ id: c.id, kind: 'HOLDS_ABOVE_CLAIM', types: over });
      max = pick(peak, (t, v) => Math.max(v, allocation[t])); // never hide what is held; reported above
    }
    return { id: c.id, max, allocation, stage: c.currentStage, legacy: !c.stages };
  });
  return { types: TYPES, available, processes, anomalies };
}

const bankerState = state => ({ types: state.types, available: state.available, processes: state.processes.map(p => ({ id: p.id, max: p.max, allocation: p.allocation })) });

/** Compact, JSON-friendly description of a decision for API responses and audit metadata. */
export function summarize(decision) {
  const out = { reason: decision.reason ?? (decision.granted ? 'SAFE' : null), explanation: decision.explanation };
  if (decision.blocking) out.blocking = decision.blocking;
  if (decision.request) out.request = Object.fromEntries(Object.entries(decision.request).filter(([, n]) => n > 0));
  if (decision.available) out.available = decision.available;
  if (decision.safety?.sequence) out.sequence = decision.safety.sequence;
  if (decision.safety?.unfinished?.length) out.unfinished = decision.safety.unfinished.map(u => ({ id: u.id, shortfall: u.shortfall }));
  return out;
}

/** Whole-hospital safety report (GET /hospitals/:id/safety and the D5 flag). */
export function evaluateHospital(state) {
  const safety = evaluateSafety(bankerState(state));
  return {
    safe: safety.safe,
    explanation: explain(safety),
    available: state.available,
    sequence: safety.sequence,
    unfinished: safety.unfinished.map(u => ({ id: u.id, need: u.need, shortfall: u.shortfall })),
    cases: state.processes.map(p => ({
      request_id: p.id, stage: p.stage, legacy_claim: p.legacy, max: p.max, allocation: p.allocation,
      need: pick(p.max, (t, v) => v - p.allocation[t])
    })),
    anomalies: state.anomalies
  };
}

/**
 * Admit case `id` (not yet in the state) at its current stage. D5-a3: an already unsafe hospital admits nobody.
 * Returns { granted, reason, blocking, explanation, request, available, safety }.
 */
export function admissionDecision(state, { id, stages, currentStage }) {
  const pre = evaluateSafety(bankerState(state));
  if (!pre.safe) {
    return { granted: false, reason: 'HOSPITAL_UNSAFE', safety: pre, available: state.available, explanation: `Refused: the hospital is already unsafe. ${explain(pre)}` };
  }
  const request = vector(stageOf(stages, currentStage)?.units);
  if (state.processes.some(p => p.id === id)) {
    // A case being admitted already holds units here: leftover rows from an earlier referral (an inconsistency).
    // Refuse explicitly instead of failing inside the algorithm, identically on both backends.
    return {
      granted: false, reason: 'ALREADY_HOLDS', request, available: state.available,
      explanation: `Refused: ${id} already holds resources at this hospital (inconsistent leftover state); release them first.`
    };
  }
  const result = requestResources(bankerState(state), id, request, { newProcess: { id, max: maxClaim(stages, currentStage) } });
  return { ...result, request, available: state.available, explanation: explain(result) };
}

/**
 * Move case `id` (already in the state) from its current stage to `toStage`: first `release` (units the new
 * stage no longer needs) goes back to Available, then the new stage's missing units are requested.
 */
export function advanceDecision(state, { id, stages, toStage, release }) {
  const pre = evaluateSafety(bankerState(state));
  if (!pre.safe) {
    return { granted: false, reason: 'HOSPITAL_UNSAFE', safety: pre, available: state.available, explanation: `Refused: the hospital is already unsafe. ${explain(pre)}` };
  }
  // A case holding nothing here (e.g. an empty stage) still advances; it simply starts from a zero allocation.
  const me = state.processes.find(p => p.id === id) ?? { id, allocation: vector(), max: vector() };
  const present = state.processes.some(p => p.id === id);
  const rel = vector(release);
  const held = pick(me.allocation, (t, v) => v - rel[t]);
  const target = vector(stageOf(stages, toStage)?.units);
  const request = pick(target, (t, v) => Math.max(0, v - held[t]));
  const peak = maxClaim(stages, toStage);
  const after = {
    types: state.types,
    available: pick(state.available, (t, v) => v + rel[t]),
    processes: [
      ...state.processes.map(p => (p.id === id
        ? { id, allocation: held, max: pick(peak, (t, v) => Math.max(v, held[t])) }
        : { id: p.id, max: p.max, allocation: p.allocation })),
      ...(present ? [] : [{ id, allocation: held, max: pick(peak, (t, v) => Math.max(v, held[t])) }])
    ]
  };
  const result = requestResources(after, id, request);
  return { ...result, request, available: after.available, explanation: explain(result) };
}
