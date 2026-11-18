// server/services/bankers.js
// Multi-resource Banker's Algorithm (Dijkstra; Silberschatz §8.6) as a validated, pure function: no I/O, no
// clock, no shared state. Both storage engines gather a hospital's real state under its per-hospital lock and
// call this module to decide whether an allocation keeps the hospital SAFE (Phase 3 Step 4, Banker's option A).
//
// Vocabulary (per resource type; every unit is quantity 1, units are counted, not named):
//   available[t]      units free right now (for a bed: available_capacity - locked_capacity)
//   allocation[i][t]  units case i holds now (soft-locked or committed; a reserved surgeon counts)
//   max[i][t]         case i's maximum claim: the peak requirement over its REMAINING treatment stages
//   need[i][t]        max - allocation: what case i may still ask for before it can finish
//
// A state is SAFE if some order exists in which every case can obtain its Need from what is free plus what
// earlier cases release when they finish. A request is granted only if it is within the case's Need, within
// Available, and the state after granting it is SAFE. In a safe state the cases' remaining claims can always be
// met one after another, so none of them can end up waiting forever on each other (no hold-and-wait deadlock).
//
// What this does NOT promise: the guarantee covers only allocations the system itself makes, assuming every
// declared claim is honest and every case eventually releases. Capacity removed from outside (an equipment
// failure entered as a capacity edit) can make a hospital unsafe; that is detected and reported (decision D5-A).

export class BankersInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BankersInputError';
  }
}

const isCount = value => Number.isInteger(value) && value >= 0;

/** Validate a vector over `types`: every type present, a whole number >= 0, nothing else. Returns a frozen copy. */
export function validateVector(vector, types, label) {
  if (!vector || typeof vector !== 'object') throw new BankersInputError(`${label}: expected an object of counts`);
  const extra = Object.keys(vector).filter(key => !types.includes(key));
  if (extra.length) throw new BankersInputError(`${label}: unknown resource type(s) ${extra.join(', ')}`);
  const out = {};
  for (const type of types) {
    const value = vector[type] ?? 0;
    if (!isCount(value)) throw new BankersInputError(`${label}: ${type} must be a whole number >= 0 (got ${JSON.stringify(value)})`);
    out[type] = value;
  }
  return Object.freeze(out);
}

const le = (a, b, types) => types.every(t => a[t] <= b[t]);
const add = (a, b, types) => Object.fromEntries(types.map(t => [t, a[t] + b[t]]));
const sub = (a, b, types) => Object.fromEntries(types.map(t => [t, a[t] - b[t]]));
const zero = types => Object.fromEntries(types.map(t => [t, 0]));

/**
 * Validate and normalise a whole state. Rejects (rather than hides) an allocation above the maximum claim:
 * the earlier browser simulator clamped such a Need to 0 with Math.max, silently treating the case as finished.
 */
export function validateState({ types, available, processes }) {
  if (!Array.isArray(types) || !types.length || new Set(types).size !== types.length || types.some(t => typeof t !== 'string')) {
    throw new BankersInputError('types: expected a non-empty list of distinct resource type names');
  }
  if (!Array.isArray(processes)) throw new BankersInputError('processes: expected a list');
  const ids = new Set();
  const normalised = processes.map((p, index) => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new BankersInputError(`processes[${index}]: id must be a non-empty string`);
    if (ids.has(p.id)) throw new BankersInputError(`processes: duplicate id ${p.id}`);
    ids.add(p.id);
    const max = validateVector(p.max, types, `${p.id}.max`);
    const allocation = validateVector(p.allocation, types, `${p.id}.allocation`);
    const over = types.filter(t => allocation[t] > max[t]);
    if (over.length) throw new BankersInputError(`${p.id}: allocation exceeds its maximum claim for ${over.join(', ')}`);
    return Object.freeze({ id: p.id, max, allocation, need: Object.freeze(sub(max, allocation, types)) });
  });
  return { types: [...types], available: validateVector(available, types, 'available'), processes: normalised };
}

/**
 * The safety algorithm. Deterministic: among the cases that can finish, the earliest in input order is
 * chosen first. Returns the completion sequence when SAFE, or the cases that can never finish and by how
 * much each falls short when UNSAFE.
 */
export function evaluateSafety(state) {
  const { types, available, processes } = validateState(state);
  let work = { ...available };
  const finished = new Set();
  const sequence = [];
  const steps = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const p of processes) {
      if (finished.has(p.id) || !le(p.need, work, types)) continue;
      const before = work;
      work = add(work, p.allocation, types);
      finished.add(p.id);
      sequence.push(p.id);
      steps.push({ id: p.id, need: p.need, workBefore: before, workAfter: work });
      progressed = true;
    }
  }
  const unfinished = processes.filter(p => !finished.has(p.id)).map(p => ({
    id: p.id,
    need: p.need,
    shortfall: Object.fromEntries(types.filter(t => p.need[t] > work[t]).map(t => [t, p.need[t] - work[t]]))
  }));
  return { safe: unfinished.length === 0, sequence, steps, unfinished, finalWork: work };
}

/**
 * The resource-request algorithm. `processId` asks for `request` (a vector). A process not yet in the state
 * (a new admission) must be supplied as `newProcess` = { id, max } with zero allocation.
 * Returns { granted: true, state, safety } or { granted: false, reason, blocking, safety? } where reason is
 *   EXCEEDS_CLAIM  the request is larger than the case's remaining Need (a claim it never declared)
 *   INSUFFICIENT   not enough free units right now
 *   UNSAFE         granting it would leave no order in which every case can finish
 */
export function requestResources(state, processId, request, { newProcess = null } = {}) {
  const base = validateState(state);
  const { types } = base;
  let processes = base.processes;
  if (newProcess) {
    if (processes.some(p => p.id === newProcess.id)) throw new BankersInputError(`${newProcess.id} is already in the state`);
    processes = [...processes, ...validateState({ types, available: base.available, processes: [{ id: newProcess.id, max: newProcess.max, allocation: zero(types) }] }).processes];
  }
  const target = processes.find(p => p.id === processId);
  if (!target) throw new BankersInputError(`unknown process ${processId}`);
  const req = validateVector(request, types, 'request');

  const overNeed = types.find(t => req[t] > target.need[t]);
  if (overNeed) {
    return { granted: false, reason: 'EXCEEDS_CLAIM', blocking: { type: overNeed, requested: req[overNeed], need: target.need[overNeed] } };
  }
  const short = types.find(t => req[t] > base.available[t]);
  if (short) {
    return { granted: false, reason: 'INSUFFICIENT', blocking: { type: short, requested: req[short], available: base.available[short] } };
  }
  const next = {
    types,
    available: sub(base.available, req, types),
    processes: processes.map(p => (p.id === processId ? { id: p.id, max: p.max, allocation: add(p.allocation, req, types) } : { id: p.id, max: p.max, allocation: p.allocation }))
  };
  const safety = evaluateSafety(next);
  if (!safety.safe) {
    const first = safety.unfinished[0];
    const type = Object.keys(first.shortfall)[0];
    return {
      granted: false, reason: 'UNSAFE', safety,
      blocking: { process: first.id, type, need: first.need[type], available: safety.finalWork[type] }
    };
  }
  return { granted: true, state: next, safety };
}

/** One-line human explanation of a safety or request result (used in refusals, audit rows and /safety). */
export function explain(result) {
  if (result.granted === true) return `Safe: every case can finish in the order ${result.safety.sequence.join(' -> ') || '(no cases)'}.`;
  if (result.reason === 'EXCEEDS_CLAIM') {
    return `Refused: the request for ${result.blocking.type} (${result.blocking.requested}) exceeds the case's remaining declared need (${result.blocking.need}).`;
  }
  if (result.reason === 'INSUFFICIENT') {
    return `Refused: ${result.blocking.type} requested ${result.blocking.requested}, only ${result.blocking.available} free.`;
  }
  if (result.reason === 'UNSAFE') {
    const b = result.blocking;
    return `Refused as unsafe: after this allocation no completion order exists; ${b.process} would still need ${b.need} ${b.type} ` +
      `with only ${b.available} obtainable even after every other finishable case releases.`;
  }
  if (typeof result.safe === 'boolean') {
    if (result.safe) return `Safe: every case can finish in the order ${result.sequence.join(' -> ') || '(no cases)'}.`;
    const first = result.unfinished[0];
    const type = Object.keys(first.shortfall)[0];
    return `Unsafe: ${result.unfinished.map(u => u.id).join(', ')} can never finish; ${first.id} still needs ${first.need[type]} ${type}, ` +
      `only ${result.finalWork[type]} obtainable.`;
  }
  return 'Unknown result.';
}
