// sim/lib/runner.js
// Executes one run of a deterministic plan (sim/lib/plan.js) against a backend (sim/lib/backends.js),
// through the same store interface the API routes use, with real concurrency (at most
// `scenario.concurrency` operations in flight).
//
// Phases (invariants are checked after each one):
//   1. intake     every case is registered (POST /emergencies equivalent)
//   2. referral   each case tries hospitals in its planned preference order until a soft-lock succeeds
//   3. decision   each hospital desk accepts / rejects / lets the 90 s lock expire, as planned; locks
//                 placed by automatic failover after a rejection or expiry are then accepted
//   4. discharge  allocated cases are completed (via IN_TREATMENT) or cancelled, as planned
//
// Every operation is timed (performance.now) and classified: ok, an expected business refusal by reason
// (no capacity, specialist unavailable, hospital closed, already locked, stale lock, conflict/busy), or an
// UNEXPECTED error. Unexpected errors, invariant violations and lock-order violations fail the run.

import { performance } from 'node:perf_hooks';
import { checkInvariants } from './invariants.js';
import { summarize } from './stats.js';

const PARAMEDIC = { role: 'PARAMEDIC', id: 'SIM-PARAMEDIC' };
const ADMIN = { role: 'ADMIN', id: 'SIM-ADMIN' };
const DESK = 'SIM-DESK';

/** Map an error to an expected refusal reason, or 'unexpected'. */
export function classifyRefusal(err) {
  const message = String(err?.message ?? err);
  if (err?.errno === 1205 || err?.errno === 1213 || /resource is busy|Lock wait timeout|Deadlock/i.test(message)) return 'conflict_busy';
  if (/No available /.test(message)) return 'no_capacity';
  if (/specialist .* is not available/i.test(message)) return 'specialist_unavailable';
  if (/is CLOSED/.test(message)) return 'hospital_closed';
  if (/already has an active referral lock/.test(message)) return 'already_locked';
  if (/No active lock|has expired|cannot be allocated|cannot receive a referral|does not hold the allocation/.test(message)) return 'stale_lock';
  if (/Invalid lifecycle transition/.test(message)) return 'invalid_transition';
  return 'unexpected';
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      task().then(resolve, reject).finally(() => { active -= 1; pump(); });
    }
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}

function createMetrics() {
  const ops = new Map();
  const unexpected = [];
  const entry = name => {
    if (!ops.has(name)) ops.set(name, { latencies: [], ok: 0, refused: {} });
    return ops.get(name);
  };
  return {
    unexpected,
    async time(name, fn) {
      const t0 = performance.now();
      try {
        const value = await fn();
        const e = entry(name);
        e.latencies.push(performance.now() - t0);
        e.ok += 1;
        return { ok: true, value };
      } catch (err) {
        const e = entry(name);
        e.latencies.push(performance.now() - t0);
        const reason = classifyRefusal(err);
        e.refused[reason] = (e.refused[reason] || 0) + 1;
        if (reason === 'unexpected' && unexpected.length < 10) unexpected.push(`${name}: ${err?.message ?? err}`);
        return { ok: false, reason, err };
      }
    },
    summary() {
      const out = {};
      for (const [name, e] of ops) out[name] = { attempts: e.latencies.length, ok: e.ok, refused: e.refused, latencyMs: summarize(e.latencies) };
      return out;
    },
    totalOps() {
      let n = 0;
      for (const e of ops.values()) n += e.latencies.length;
      return n;
    }
  };
}

function caseInput(c) {
  return {
    patient: { full_name: `Simulated patient ${c.label}`, age: 40, gender: 'UNKNOWN', emergency_type: c.emergencyType, triage_priority: c.priority, contact_phone: null },
    request: {
      emergency_type: c.emergencyType, required_resource_types: c.resourceTypes, required_specialist: c.specialist,
      priority: c.priority, pickup_lat: null, pickup_lng: null, clinical_notes: `stress harness ${c.label}`
    }
  };
}

/**
 * Run `plan` once on `backend`. Returns a per-run result object (see sim/lib/report.js).
 * `afterReset` (tests only) runs once the fixture is loaded, e.g. to inject a fault and prove that the
 * invariant checks catch it.
 */
export async function runOnce(scenario, plan, backend, { afterReset = null } = {}) {
  await backend.reset();
  if (afterReset) await afterReset(backend);
  const metrics = createMetrics();
  const limit = createLimiter(scenario.concurrency);
  let deadlockRetries = 0;
  backend.hooks.on('tx:deadlockRetry', () => { deadlockRetries += 1; });
  const phases = [];
  const invariantFailures = [];
  const requestIdOf = new Map();
  const lockOf = new Map();
  const allocated = new Set();

  const phase = async (name, work) => {
    const t0 = performance.now();
    const before = metrics.totalOps();
    await work();
    const wallMs = performance.now() - t0;
    const violations = checkInvariants(await backend.snapshot());
    if (violations.length) invariantFailures.push({ phase: name, violations: violations.slice(0, 20), total: violations.length });
    phases.push({ name, wallMs: Number(wallMs.toFixed(1)), operations: metrics.totalOps() - before, invariantViolations: violations.length });
  };
  const forEachCase = (cases, fn) => Promise.all(cases.map(c => limit(() => fn(c))));
  const runStart = performance.now();

  await phase('intake', () => forEachCase(plan.cases, async c => {
    const r = await metrics.time('create', () => backend.store.createRequest(caseInput(c), PARAMEDIC));
    if (r.ok) requestIdOf.set(c.index, r.value.request_id);
  }));

  await phase('referral', () => forEachCase(plan.cases.filter(c => requestIdOf.has(c.index)), async c => {
    for (const hospitalId of c.hospitalPreference) {
      const r = await metrics.time('initiate', () => backend.store.acquireReferralLock(hospitalId, requestIdOf.get(c.index), c.resourceTypes));
      if (r.ok) { lockOf.set(c.index, r.value.acceptanceId); return; }
    }
  }));

  await phase('decision', async () => {
    await forEachCase(plan.cases.filter(c => lockOf.has(c.index)), async c => {
      const acceptanceId = lockOf.get(c.index);
      if (c.decision === 'accept') {
        const r = await metrics.time('accept', () => backend.store.commitReferral(acceptanceId, DESK));
        if (r.ok) allocated.add(c.index);
      } else if (c.decision === 'reject') {
        await metrics.time('reject', () => backend.store.rejectReferral(acceptanceId, 'Simulated: no capacity at this time', DESK));
      } else {
        await backend.forceExpire(acceptanceId);
        await metrics.time('expire', () => backend.engine.expireLock(acceptanceId));
      }
    });
    // Locks placed by automatic failover (after a rejection or expiry) are accepted by the next hospital.
    await forEachCase(plan.cases.filter(c => lockOf.has(c.index) && c.decision !== 'accept'), async c => {
      for (const acceptanceId of await backend.pendingFor(requestIdOf.get(c.index))) {
        const r = await metrics.time('accept_failover', () => backend.store.commitReferral(acceptanceId, DESK));
        if (r.ok) allocated.add(c.index);
      }
    });
  });

  await phase('discharge', () => forEachCase(plan.cases.filter(c => requestIdOf.has(c.index)), async c => {
    const id = requestIdOf.get(c.index);
    if (c.outcome === 'complete' && allocated.has(c.index)) {
      const r = await metrics.time('treat', () => backend.store.transitionRequestStatus(id, 'IN_TREATMENT', ADMIN));
      if (r.ok) await metrics.time('complete', () => backend.store.transitionRequestStatus(id, 'COMPLETED', ADMIN));
    } else if (c.outcome === 'cancel') {
      await metrics.time('cancel', () => backend.store.transitionRequestStatus(id, 'CANCELLED', ADMIN));
    }
  }));

  const totalMs = performance.now() - runStart;
  const final = await backend.snapshot();
  const requestsByStatus = final.requests.reduce((m, q) => ({ ...m, [q.status]: (m[q.status] || 0) + 1 }), {});
  const totalOps = metrics.totalOps();
  return {
    wallMs: Number(totalMs.toFixed(1)),
    throughputOpsPerSec: Number((totalOps / (totalMs / 1000)).toFixed(1)),
    totalOperations: totalOps,
    phases,
    operations: metrics.summary(),
    casesPlaced: lockOf.size,
    casesAllocated: allocated.size,
    finalState: {
      requestsByStatus,
      unitsCommitted: final.committed.length,
      unitsSoftLocked: final.softLocks.length,
      ambulancesOnRoad: final.ambulances.filter(a => ['DISPATCHED', 'IN_TRANSIT'].includes(a.status)).length
    },
    conflicts: {
      deadlockRetries,
      busyRefusals: Object.values(metrics.summary()).reduce((s, o) => s + (o.refused.conflict_busy || 0), 0)
    },
    lockOrder: { acquisitionsChecked: backend.checker.acquisitions, violations: backend.checker.violations.length, details: backend.checker.describe() || null },
    invariantFailures,
    unexpectedErrors: metrics.unexpected,
    passed: invariantFailures.length === 0 && backend.checker.violations.length === 0 && metrics.unexpected.length === 0
  };
}
