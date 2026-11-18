// Stress harness end to end on the IN-MEMORY store: the smoke scenario passes all safety checks, the
// workload is identical across runs, the report is complete, and an injected fault is caught.
// The same checks run against MySQL in tests/sim_harness_mysql.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan } from '../sim/lib/plan.js';
import { createMemoryBackend } from '../sim/lib/backends.js';
import { runOnce } from '../sim/lib/runner.js';
import { buildReport, toMarkdown } from '../sim/lib/report.js';

const scenario = JSON.parse(fs.readFileSync(new URL('../sim/scenarios/smoke.json', import.meta.url), 'utf8'));
const { plan, fingerprint } = buildPlan(scenario);
const backend = await createMemoryBackend(scenario.fixture);
test.after(() => backend.close());

test('[memory] the smoke scenario passes every safety check, twice, with a complete report', async () => {
  const runs = [await runOnce(scenario, plan, backend), await runOnce(scenario, plan, backend)];
  for (const r of runs) {
    assert.equal(r.passed, true, JSON.stringify({ inv: r.invariantFailures, lock: r.lockOrder.details, err: r.unexpectedErrors }));
    assert.deepEqual(r.phases.map(p => p.name), ['intake', 'referral', 'decision', 'discharge']);
    assert.equal(r.operations.create.ok, scenario.cases, 'every case registered');
    assert.ok(r.casesAllocated > 0 && r.operations.initiate.attempts >= scenario.cases);
    assert.ok(r.lockOrder.acquisitionsChecked > 0, 'the lock-order checker observed the run');
    assert.equal(r.finalState.unitsSoftLocked, 0, 'no soft-lock outlives the decision phase');
  }
  const report = buildReport({ scenario, scenarioFile: 'sim/scenarios/smoke.json', plan, fingerprint, serverInfo: await backend.serverInfo(), runs });
  assert.equal(report.passed, true);
  assert.equal(report.workload.fingerprint, fingerprint);
  assert.equal(report.aggregate.casesAllocated.median !== null, true);
  for (const field of ['gitCommit', 'node', 'platform', 'cpuCount']) assert.ok(field in report.environment);
  assert.match(toMarkdown(report), /\*\*Result: PASSED\.\*\*/);
});

test('[memory] an injected capacity leak is caught by the invariant checks and fails the run', async () => {
  const r = await runOnce(scenario, plan, backend, {
    afterReset: b => { b.db.medicalResources.find(x => x.resource_type === 'ICU_BED' && x.total_capacity > 0).available_capacity -= 1; }
  });
  assert.equal(r.passed, false);
  assert.ok(r.invariantFailures[0].violations.some(v => v.code === 'IN_USE_MISMATCH'), JSON.stringify(r.invariantFailures[0]));
  assert.equal(r.invariantFailures[0].phase, 'intake', 'caught at the first checkpoint');
});
