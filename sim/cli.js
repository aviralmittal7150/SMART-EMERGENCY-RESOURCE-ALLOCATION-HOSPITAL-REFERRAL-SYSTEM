#!/usr/bin/env node
// sim/cli.js — mass-casualty stress harness.
//
//   node sim/cli.js --scenario sim/scenarios/mass-casualty-v1.json [--backend mysql|memory] [--runs N]
//                   [--out <directory>] [--label <text>]
//
// MySQL runs use ONLY the dedicated *_test database from .env.local / MYSQL_TEST_* (the helper refuses any
// other database name). Exit code 1 if any run has an invariant violation, a lock-order violation or an
// unexpected error. See sim/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './lib/plan.js';
import { createMemoryBackend, createMysqlBackend } from './lib/backends.js';
import { runOnce } from './lib/runner.js';
import { buildReport, toMarkdown } from './lib/report.js';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

export async function runScenario({ scenarioFile, backendName = 'mysql', runs, label, log = () => {} }) {
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const { plan, fingerprint } = buildPlan(scenario);
  const backend = backendName === 'memory'
    ? await createMemoryBackend(scenario.fixture)
    : await createMysqlBackend(scenario.fixture, { poolSize: scenario.poolSize ?? 20 });
  if (backend.skip) throw new Error(`MySQL test database unavailable: ${backend.skip}`);
  const results = [];
  try {
    const serverInfo = await backend.serverInfo();
    const count = Number(runs ?? scenario.runs ?? 3);
    for (let i = 0; i < count; i += 1) {
      log(`[SIM] ${scenario.name} run ${i + 1}/${count} on ${backend.name} ...`);
      const result = await runOnce(scenario, plan, backend);
      log(`[SIM]   ${result.passed ? 'passed' : 'FAILED'}: ${result.totalOperations} operations in ${result.wallMs} ms, ${result.casesAllocated} allocated`);
      results.push(result);
    }
    return buildReport({ scenario, scenarioFile: path.relative(process.cwd(), scenarioFile), plan, fingerprint, serverInfo, runs: results, label });
  } finally {
    await backend.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2));
    if (!a.scenario) throw new Error('--scenario <file> is required');
    const report = await runScenario({ scenarioFile: path.resolve(a.scenario), backendName: a.backend ?? 'mysql', runs: a.runs, label: a.label, log: console.log });
    if (a.out) {
      fs.mkdirSync(a.out, { recursive: true });
      fs.writeFileSync(path.join(a.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(path.join(a.out, 'report.md'), toMarkdown(report));
      console.log(`[SIM] report written to ${a.out}/report.{json,md}`);
    }
    console.log(`[SIM] ${report.passed ? 'PASSED' : 'FAILED'}: fingerprint ${report.workload.fingerprint.slice(0, 16)}…, throughput median ${report.aggregate.throughputOpsPerSec.median} ops/s`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (err) {
    console.error(`[SIM] ${err.message}`);
    process.exitCode = 1;
  }
}
