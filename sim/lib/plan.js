// sim/lib/plan.js
// Turns a scenario (JSON) into a fully deterministic workload plan. Everything random is decided here,
// from the scenario seed, BEFORE anything runs: which emergency types arrive, their priorities, the order in
// which each case tries hospitals, what each hospital desk decides, and how each case ends. The plan's
// SHA-256 fingerprint is recorded in every report: identical fingerprints mean identical workloads.
//
// What is NOT deterministic (and is measured instead): the interleaving of concurrent operations, hence
// which case wins a contested bed, latencies and conflict counts. Reports therefore repeat runs and show
// the spread.

import { createHash } from 'node:crypto';
import { createRng } from './prng.js';
import { resolveEmergencyRequirements, VALID_EMERGENCY_TYPES } from '../../server/services/emergencyRequirements.js';

const DECISIONS = ['accept', 'reject', 'expire'];
const OUTCOMES = ['complete', 'cancel', 'keep'];

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** Validate a scenario and return a list of problems (empty = valid). */
export function validateScenario(s) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(typeof s?.name === 'string' && s.name, 'name is required');
  need(Number.isInteger(s?.version), 'version must be an integer');
  need(Number.isInteger(s?.seed), 'seed must be an integer');
  need(Number.isInteger(s?.cases) && s.cases > 0, 'cases must be a positive integer');
  need(Number.isInteger(s?.concurrency) && s.concurrency > 0, 'concurrency must be a positive integer');
  need(Array.isArray(s?.fixture?.hospitals) && s.fixture.hospitals.length > 0, 'fixture.hospitals is required');
  for (const type of Object.keys(s?.caseMix ?? {})) need(VALID_EMERGENCY_TYPES.includes(type), `caseMix: unknown emergency type ${type}`);
  for (const d of Object.keys(s?.decisions ?? {})) need(DECISIONS.includes(d), `decisions: unknown decision ${d}`);
  for (const o of Object.keys(s?.outcomes ?? {})) need(OUTCOMES.includes(o), `outcomes: unknown outcome ${o}`);
  for (const p of Object.keys(s?.priorities ?? {})) need(['1', '2', '3', '4', '5'].includes(p), `priorities: unknown priority ${p}`);
  return problems;
}

/** Build the deterministic plan for `scenario`. */
export function buildPlan(scenario) {
  const problems = validateScenario(scenario);
  if (problems.length) throw new Error(`Invalid scenario: ${problems.join('; ')}`);
  const rng = createRng(scenario.seed);
  const hospitalIds = scenario.fixture.hospitals.map(h => h.hospital_id);
  const cases = [];
  for (let i = 0; i < scenario.cases; i += 1) {
    const type = rng.weighted(scenario.caseMix);
    const requirements = resolveEmergencyRequirements(type);
    cases.push({
      index: i,
      label: `SIM-CASE-${String(i + 1).padStart(4, '0')}`,
      emergencyType: type,
      priority: Number(rng.weighted(scenario.priorities)),
      resourceTypes: requirements.resourceTypes,
      specialist: requirements.specialist,
      hospitalPreference: rng.shuffle(hospitalIds).slice(0, scenario.maxHospitalsTried ?? hospitalIds.length),
      decision: rng.weighted(scenario.decisions),
      outcome: rng.weighted(scenario.outcomes)
    });
  }
  const plan = { scenario: scenario.name, version: scenario.version, seed: scenario.seed, cases };
  return { plan, fingerprint: sha256(plan) };
}
