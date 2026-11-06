// Stress harness end to end on the MYSQL store (dedicated *_test database only; skipped without it,
// a failure under REQUIRE_MYSQL_TESTS=true). Same checks as tests/sim_harness_memory.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan } from '../sim/lib/plan.js';
import { createMysqlBackend } from '../sim/lib/backends.js';
import { runOnce } from '../sim/lib/runner.js';

const scenario = JSON.parse(fs.readFileSync(new URL('../sim/scenarios/smoke.json', import.meta.url), 'utf8'));
const { plan } = buildPlan(scenario);
const backend = await createMysqlBackend(scenario.fixture, { poolSize: scenario.poolSize });

if (backend.skip) {
  test.skip(`MySQL stress harness (skipped: ${backend.skip})`, () => {});
} else {
  test.after(() => backend.close());

  test('[mysql] the smoke scenario passes every safety check, with real concurrency on a connection pool', async () => {
    const r = await runOnce(scenario, plan, backend);
    assert.equal(r.passed, true, JSON.stringify({ inv: r.invariantFailures, lock: r.lockOrder.details, err: r.unexpectedErrors }));
    assert.equal(r.operations.create.ok, scenario.cases);
    assert.ok(r.casesAllocated > 0);
    assert.ok(r.lockOrder.acquisitionsChecked > 0, 'the lock-order checker observed the SQL transactions');
    assert.equal(r.finalState.unitsSoftLocked, 0);
    const info = await backend.serverInfo();
    assert.equal(info.databaseIsTest, true, 'the harness only ever runs on a *_test database');
  });

  test('[mysql] an injected capacity leak in the database is caught and fails the run', async () => {
    const r = await runOnce(scenario, plan, backend, {
      afterReset: b => b.admin.query("UPDATE MedicalResource SET available_capacity = available_capacity - 1 WHERE resource_type = 'ICU_BED' AND total_capacity > 0 LIMIT 1")
    });
    assert.equal(r.passed, false);
    assert.ok(r.invariantFailures[0].violations.some(v => v.code === 'IN_USE_MISMATCH'), JSON.stringify(r.invariantFailures[0]));
  });
}
