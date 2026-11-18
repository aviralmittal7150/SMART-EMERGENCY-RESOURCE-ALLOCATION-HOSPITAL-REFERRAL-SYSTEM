// sim/compare.js
// Compare two harness reports of the SAME workload (for example the Phase 3 Step 2 baseline and a later
// step). Refuses to compare reports whose workload fingerprint, scenario or fixture differ: different
// workloads are not comparable. Environment differences are listed, never hidden, so a reader can judge
// whether a difference in numbers is the code or the machine.
//
//   node sim/compare.js --baseline <report.json> --candidate <report.json> [--out <directory>]
//
// Medians across runs are compared (each report holds several runs; see their min/median/max spread).
// Reports are read-only inputs: nothing is written next to them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const median = values => {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const delta = (base, cand) => {
  if (typeof base !== 'number' || typeof cand !== 'number') return null;
  return { absolute: Number((cand - base).toFixed(2)), percent: base === 0 ? null : Number((((cand - base) / base) * 100).toFixed(1)) };
};
const sumRefusals = (runs, op) => {
  const totals = {};
  for (const run of runs) {
    for (const [reason, n] of Object.entries(run.operations?.[op]?.refused ?? {})) totals[reason] = (totals[reason] || 0) + n;
  }
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number((v / runs.length).toFixed(1))]));
};

/** Throws when the two reports do not describe the same workload. */
export function assertComparable(base, cand) {
  const problems = [];
  if (base.schema !== cand.schema) problems.push(`report schema ${base.schema} vs ${cand.schema}`);
  if (base.workload?.fingerprint !== cand.workload?.fingerprint) problems.push(`workload fingerprint ${base.workload?.fingerprint} vs ${cand.workload?.fingerprint}`);
  if (base.scenario?.sha256 !== cand.scenario?.sha256) problems.push('scenario file differs');
  if (base.fixtureSha256 !== cand.fixtureSha256) problems.push('fixture differs');
  if (base.backend?.backend !== cand.backend?.backend) problems.push(`backend ${base.backend?.backend} vs ${cand.backend?.backend}`);
  if (problems.length) throw new Error(`Reports are not comparable: ${problems.join('; ')}`);
}

export function compareReports(base, cand) {
  assertComparable(base, cand);
  const envKeys = ['node', 'platform', 'arch', 'cpuModel', 'cpuCount', 'memoryGb', 'powerSource'];
  const backendKeys = Object.keys({ ...base.backend, ...cand.backend });
  const environment = [
    ...envKeys.map(k => ({ key: k, baseline: base.environment?.[k] ?? null, candidate: cand.environment?.[k] ?? null })),
    ...backendKeys.map(k => ({ key: `backend.${k}`, baseline: base.backend?.[k] ?? null, candidate: cand.backend?.[k] ?? null }))
  ].map(row => ({ ...row, same: JSON.stringify(row.baseline) === JSON.stringify(row.candidate) }));

  const headline = {};
  for (const key of ['throughputOpsPerSec', 'wallMs', 'casesPlaced', 'casesAllocated', 'deadlockRetries', 'busyRefusals']) {
    headline[key] = { baseline: base.aggregate[key], candidate: cand.aggregate[key], medianDelta: delta(base.aggregate[key]?.median, cand.aggregate[key]?.median) };
  }
  const lockChecks = runs => median(runs.map(r => r.lockOrder?.acquisitionsChecked));
  headline.lockAcquisitionsChecked = {
    baseline: lockChecks(base.runs), candidate: lockChecks(cand.runs), medianDelta: delta(lockChecks(base.runs), lockChecks(cand.runs))
  };

  const operations = {};
  for (const op of Object.keys({ ...base.aggregate.operations, ...cand.aggregate.operations })) {
    const b = base.aggregate.operations[op] ?? {};
    const c = cand.aggregate.operations[op] ?? {};
    operations[op] = {};
    for (const metric of ['attempts', 'ok', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs']) {
      operations[op][metric] = { baseline: b[metric]?.median ?? null, candidate: c[metric]?.median ?? null, delta: delta(b[metric]?.median, c[metric]?.median) };
    }
    operations[op].refusalsPerRun = { baseline: sumRefusals(base.runs, op), candidate: sumRefusals(cand.runs, op) };
  }

  const phases = {};
  for (const name of [...new Set([...base.runs, ...cand.runs].flatMap(r => r.phases.map(p => p.name)))]) {
    const wall = runs => median(runs.map(r => r.phases.find(p => p.name === name)?.wallMs));
    phases[name] = { baseline: wall(base.runs), candidate: wall(cand.runs), delta: delta(wall(base.runs), wall(cand.runs)) };
  }

  const finalState = runs => ({
    unitsCommitted: median(runs.map(r => r.finalState.unitsCommitted)),
    unitsSoftLocked: median(runs.map(r => r.finalState.unitsSoftLocked)),
    ambulancesOnRoad: median(runs.map(r => r.finalState.ambulancesOnRoad))
  });
  const safety = runs => runs.map(r => ({
    invariantViolations: r.invariantFailures.reduce((s, f) => s + f.total, 0),
    lockOrderViolations: r.lockOrder.violations,
    unexpectedErrors: r.unexpectedErrors.length,
    passed: r.passed
  }));

  return {
    schema: 'eris-sim-comparison/1',
    workloadFingerprint: base.workload.fingerprint,
    scenario: base.scenario,
    baseline: { label: base.label, generatedAt: base.generatedAt, runs: base.runs.length, commit: base.environment.gitCommit, dirty: base.environment.gitDirty, workingTreeSha256: base.environment.gitWorkingTreeSha256 ?? null },
    candidate: { label: cand.label, generatedAt: cand.generatedAt, runs: cand.runs.length, commit: cand.environment.gitCommit, dirty: cand.environment.gitDirty, workingTreeSha256: cand.environment.gitWorkingTreeSha256 ?? null },
    environment,
    environmentIdentical: environment.every(row => row.same),
    headline,
    operations,
    phases,
    finalState: { baseline: finalState(base.runs), candidate: finalState(cand.runs) },
    safety: { baseline: safety(base.runs), candidate: safety(cand.runs) }
  };
}

const fmt = v => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const fmtDelta = d => (!d ? '—' : `${d.absolute >= 0 ? '+' : ''}${d.absolute}${d.percent === null ? '' : ` (${d.percent >= 0 ? '+' : ''}${d.percent}%)`}`);
const spreadOf = s => (s ? `${s.min} / **${s.median}** / ${s.max}` : '—');

export function comparisonMarkdown(c) {
  const lines = [];
  lines.push(`# Harness comparison: ${c.scenario.name} v${c.scenario.version} (${c.environment.find(e => e.key === 'backend.backend')?.candidate})`, '');
  lines.push(`- Workload fingerprint (identical in both): \`${c.workloadFingerprint}\``);
  lines.push(`- Baseline: ${c.baseline.label} — ${c.baseline.runs} runs, ${c.baseline.generatedAt}, commit \`${c.baseline.commit}\`${c.baseline.dirty ? ` (dirty; tree SHA-256 \`${c.baseline.workingTreeSha256}\`)` : ''}`);
  lines.push(`- Candidate: ${c.candidate.label} — ${c.candidate.runs} runs, ${c.candidate.generatedAt}, commit \`${c.candidate.commit}\`${c.candidate.dirty ? ` (dirty; tree SHA-256 \`${c.candidate.workingTreeSha256}\`)` : ''}`);
  lines.push('', '## Environment', '', c.environmentIdentical
    ? 'Identical in every recorded field.'
    : '**Not identical.** Differences are marked; weigh the numbers below accordingly.', '');
  lines.push('| Field | Baseline | Candidate | Same |', '| :--- | :--- | :--- | :---: |');
  for (const e of c.environment) lines.push(`| ${e.key} | ${fmt(e.baseline)} | ${fmt(e.candidate)} | ${e.same ? 'yes' : '**no**'} |`);
  lines.push('', '## Headline (min / **median** / max across runs; delta of medians)', '');
  lines.push('| Metric | Baseline | Candidate | Δ median |', '| :--- | :--- | :--- | :--- |');
  for (const [k, v] of Object.entries(c.headline)) {
    const isSpread = v.baseline && typeof v.baseline === 'object';
    lines.push(`| ${k} | ${isSpread ? spreadOf(v.baseline) : fmt(v.baseline)} | ${isSpread ? spreadOf(v.candidate) : fmt(v.candidate)} | ${fmtDelta(v.medianDelta)} |`);
  }
  lines.push('', '## Per operation (medians across runs)', '');
  lines.push('| Operation | Attempts b→c | OK b→c | p50 ms b→c | p95 ms b→c | p99 ms b→c | max ms b→c |', '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const [op, m] of Object.entries(c.operations)) {
    const pair = x => `${fmt(x.baseline)} → ${fmt(x.candidate)}`;
    lines.push(`| ${op} | ${pair(m.attempts)} | ${pair(m.ok)} | ${pair(m.p50Ms)} | ${pair(m.p95Ms)} | ${pair(m.p99Ms)} | ${pair(m.maxMs)} |`);
  }
  lines.push('', '## Refusals per run, by reason (mean across runs)', '');
  lines.push('| Operation | Baseline | Candidate |', '| :--- | :--- | :--- |');
  for (const [op, m] of Object.entries(c.operations)) {
    if (Object.keys(m.refusalsPerRun.baseline).length || Object.keys(m.refusalsPerRun.candidate).length) {
      lines.push(`| ${op} | ${fmt(m.refusalsPerRun.baseline)} | ${fmt(m.refusalsPerRun.candidate)} |`);
    }
  }
  lines.push('', '## Phase wall time (ms, medians)', '', '| Phase | Baseline | Candidate | Δ |', '| :--- | :--- | :--- | :--- |');
  for (const [name, p] of Object.entries(c.phases)) lines.push(`| ${name} | ${fmt(p.baseline)} | ${fmt(p.candidate)} | ${fmtDelta(p.delta)} |`);
  lines.push('', '## Final state (medians) and safety', '');
  lines.push(`- Final state: baseline ${fmt(c.finalState.baseline)}; candidate ${fmt(c.finalState.candidate)}`);
  lines.push(`- Safety per run, baseline: ${fmt(c.safety.baseline)}`);
  lines.push(`- Safety per run, candidate: ${fmt(c.safety.candidate)}`);
  lines.push('');
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    if (!opt('baseline') || !opt('candidate')) throw new Error('usage: node sim/compare.js --baseline <report.json> --candidate <report.json> [--out <dir>]');
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const comparison = compareReports(read(opt('baseline')), read(opt('candidate')));
    const md = comparisonMarkdown(comparison);
    if (opt('out')) {
      fs.mkdirSync(opt('out'), { recursive: true });
      fs.writeFileSync(path.join(opt('out'), 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
      fs.writeFileSync(path.join(opt('out'), 'comparison.md'), md);
      console.log(`[SIM] comparison written to ${opt('out')}/comparison.{json,md}`);
    } else {
      process.stdout.write(md);
    }
  } catch (err) {
    console.error(`[SIM] ${err.message}`);
    process.exit(1);
  }
}
