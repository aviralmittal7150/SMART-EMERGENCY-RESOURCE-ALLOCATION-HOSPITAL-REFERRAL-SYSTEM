// sim/lib/report.js
// Builds the reproducible report: what was run (scenario + hashes + workload fingerprint), where
// (environment, backend), every run's raw measurements, and the spread across runs. No hostnames,
// usernames or credentials are recorded.

import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { spread } from './stats.js';
import { sha256 } from './plan.js';

const git = args => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

export function environment() {
  const cpus = os.cpus();
  return {
    gitCommit: git(['rev-parse', 'HEAD']),
    // Uncommitted changes to anything except generated reports (sim/reports/) make a measurement suspect.
    gitDirty: (git(['status', '--porcelain', '--', '.', ':(exclude)sim/reports']) ?? '') !== '',
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1))
  };
}

const tally = (items, key) => items.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] || 0) + 1 }), {});

export function buildReport({ scenario, scenarioFile, plan, fingerprint, serverInfo, runs, label }) {
  const opNames = [...new Set(runs.flatMap(r => Object.keys(r.operations)))].sort();
  const aggregate = {
    wallMs: spread(runs.map(r => r.wallMs)),
    throughputOpsPerSec: spread(runs.map(r => r.throughputOpsPerSec)),
    casesPlaced: spread(runs.map(r => r.casesPlaced)),
    casesAllocated: spread(runs.map(r => r.casesAllocated)),
    deadlockRetries: spread(runs.map(r => r.conflicts.deadlockRetries)),
    busyRefusals: spread(runs.map(r => r.conflicts.busyRefusals)),
    operations: Object.fromEntries(opNames.map(name => [name, {
      attempts: spread(runs.map(r => r.operations[name]?.attempts ?? 0)),
      ok: spread(runs.map(r => r.operations[name]?.ok ?? 0)),
      p50Ms: spread(runs.map(r => r.operations[name]?.latencyMs.p50 ?? null)),
      p95Ms: spread(runs.map(r => r.operations[name]?.latencyMs.p95 ?? null)),
      p99Ms: spread(runs.map(r => r.operations[name]?.latencyMs.p99 ?? null)),
      maxMs: spread(runs.map(r => r.operations[name]?.latencyMs.max ?? null))
    }]))
  };
  return {
    schema: 'eris-sim-report/1',
    generatedAt: new Date().toISOString(),
    label: label ?? null,
    scenario: {
      file: scenarioFile, name: scenario.name, version: scenario.version, seed: scenario.seed,
      cases: scenario.cases, concurrency: scenario.concurrency, sha256: sha256(scenario)
    },
    fixtureSha256: sha256(scenario.fixture),
    workload: {
      fingerprint,
      emergencyTypes: tally(plan.cases, 'emergencyType'),
      decisions: tally(plan.cases, 'decision'),
      outcomes: tally(plan.cases, 'outcome')
    },
    environment: environment(),
    backend: serverInfo,
    measurementNotes: [
      'Latency is wall-clock time per store call measured in-process with performance.now(); it includes connection-pool queueing.',
      'The lock-order checker is installed during runs (small overhead on every SQL statement / in-memory lock).',
      'The workload is identical across runs (same fingerprint); which case wins a contested unit is not, hence the spread.'
    ],
    runs,
    aggregate,
    passed: runs.every(r => r.passed)
  };
}

const fmt = s => (s.median === null ? '—' : s.min === s.max ? `${s.median}` : `${s.median} (${s.min}–${s.max})`);

export function toMarkdown(report) {
  const a = report.aggregate;
  const lines = [];
  lines.push(`# Stress harness report: ${report.scenario.name} v${report.scenario.version}${report.label ? ` (${report.label})` : ''}`);
  lines.push('');
  lines.push(`**Result: ${report.passed ? 'PASSED' : 'FAILED'}.** All runs: 0 invariant violations, 0 lock-order violations and 0 unexpected errors are required.`);
  lines.push('');
  lines.push('## What was run');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| Scenario | \`${report.scenario.file}\` (seed ${report.scenario.seed}, ${report.scenario.cases} cases, concurrency ${report.scenario.concurrency}) |`);
  lines.push(`| Scenario SHA-256 | \`${report.scenario.sha256}\` |`);
  lines.push(`| Fixture SHA-256 | \`${report.fixtureSha256}\` |`);
  lines.push(`| Workload fingerprint | \`${report.workload.fingerprint}\` |`);
  lines.push(`| Emergency types | ${Object.entries(report.workload.emergencyTypes).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  lines.push(`| Planned desk decisions | ${Object.entries(report.workload.decisions).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  lines.push(`| Planned outcomes | ${Object.entries(report.workload.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  lines.push(`| Runs | ${report.runs.length} |`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  const e = report.environment;
  const b = report.backend;
  lines.push(`- Commit \`${e.gitCommit ?? 'unknown'}\`${e.gitDirty ? ' **(working tree had uncommitted changes)**' : ''}`);
  lines.push(`- Node ${e.node}, ${e.platform} (${e.arch}), ${e.cpuCount} × ${e.cpuModel}, ${e.memoryGb} GB RAM`);
  lines.push(`- Backend: ${b.backend}${b.mysqlVersion ? `, MySQL ${b.mysqlVersion}, lower_case_table_names=${b.lowerCaseTableNames}, pool ${b.poolSize} connections, lock wait timeout ${b.sessionLockWaitTimeoutSec}s, ${b.engineIsolation}` : ''}`);
  lines.push('');
  lines.push('## Results (median, with min–max across runs)');
  lines.push('');
  lines.push(`- Wall time: ${fmt(a.wallMs)} ms · throughput: ${fmt(a.throughputOpsPerSec)} operations/s`);
  lines.push(`- Cases that obtained a referral lock: ${fmt(a.casesPlaced)} of ${report.scenario.cases} · allocated: ${fmt(a.casesAllocated)}`);
  lines.push(`- Conflicts: deadlock retries ${fmt(a.deadlockRetries)} · busy refusals ${fmt(a.busyRefusals)}`);
  lines.push('');
  lines.push('| Operation | Attempts | OK | p50 ms | p95 ms | p99 ms | max ms |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, o] of Object.entries(a.operations)) {
    lines.push(`| ${name} | ${fmt(o.attempts)} | ${fmt(o.ok)} | ${fmt(o.p50Ms)} | ${fmt(o.p95Ms)} | ${fmt(o.p99Ms)} | ${fmt(o.maxMs)} |`);
  }
  lines.push('');
  lines.push('## Refusals by reason (per run)');
  lines.push('');
  lines.push('| Run | Operation | Reasons |');
  lines.push('| ---: | :--- | :--- |');
  report.runs.forEach((r, i) => {
    for (const [name, o] of Object.entries(r.operations)) {
      const reasons = Object.entries(o.refused);
      if (reasons.length) lines.push(`| ${i + 1} | ${name} | ${reasons.map(([k, v]) => `${k} ${v}`).join(', ')} |`);
    }
  });
  lines.push('');
  lines.push('## Safety checks (per run)');
  lines.push('');
  lines.push('| Run | Invariant violations | Lock-order violations (acquisitions checked) | Unexpected errors | Final state |');
  lines.push('| ---: | ---: | ---: | ---: | :--- |');
  report.runs.forEach((r, i) => {
    const inv = r.invariantFailures.reduce((s, f) => s + f.total, 0);
    const state = Object.entries(r.finalState.requestsByStatus).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`| ${i + 1} | ${inv} | ${r.lockOrder.violations} (${r.lockOrder.acquisitionsChecked}) | ${r.unexpectedErrors.length} | ${state}; units committed ${r.finalState.unitsCommitted}, soft-locked ${r.finalState.unitsSoftLocked} |`);
  });
  lines.push('');
  lines.push('## Measurement notes');
  lines.push('');
  for (const note of report.measurementNotes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}
