// js/bankers-ui.js
// Banker's algorithm TEACHING SIMULATOR. Offline: it only reads the numbers typed into its own inputs, never calls
// the API and never writes any operational or audit record. The live per-hospital safety state is server-side
// (GET /hospitals/:id/safety).

import { BankersAlgorithm } from './bankers.js';
import { el, mount, byId } from './dom.js';

const engine = new BankersAlgorithm();
const intOf = (id, fallback = 0) => {
  const n = parseInt(byId(id)?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function syncInputs() {
  engine.available = [0, 1, 2].map(j => intOf(`avail${j}`));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      engine.allocation[i][j] = intOf(`alloc_${i}_${j}`);
      engine.max[i][j] = intOf(`max_${i}_${j}`);
    }
  }
}

function renderSafety() {
  const result = engine.evaluateSafety();
  const need = engine.getNeedMatrix();
  mount(byId('bankersNeedTableBody'), engine.processes.map((proc, i) =>
    el('tr', {}, el('td', { class: 'font-semibold' }, proc), need[i].map(v => el('td', {}, v)))));
  mount(byId('bankersResultContainer'),
    result.isSafe
      ? el('div', { class: 'safe-seq-display' }, el('span', {}, 'Safe state. Safe sequence:'), el('span', {}, `< ${result.safeSequence.join(' → ')} >`))
      : el('div', { class: 'unsafe-seq-display' }, el('span', {}, 'Unsafe state: a deadlock cannot be ruled out.')),
    el('div', { class: 'trace-log' }, result.traceLogs.map(line => el('div', {}, line))));
}

function evaluateClaim() {
  syncInputs();
  const p = intOf('compoundProcessSelect');
  const req = [0, 1, 2].map(j => intOf(`claimReq${j}`));
  const result = engine.requestResources(p, req);
  const box = byId('compoundClaimResultBox');
  mount(box,
    el('div', { class: result.granted ? 'result-title text-success' : 'result-title text-danger' },
      result.granted ? 'Claim granted: the system stays safe' : 'Claim refused'),
    el('div', { class: 'result-body' }, result.granted
      ? `${engine.processes[p]} receives [${req.join(', ')}]. Safe sequence: < ${result.safeSequence.join(' → ')} >`
      : result.reason));
  // A granted claim changed the simulated allocation: show it in the inputs.
  if (result.granted) {
    for (let j = 0; j < 3; j++) {
      const a = byId(`alloc_${p}_${j}`); if (a) a.value = String(engine.allocation[p][j]);
      const v = byId(`avail${j}`); if (v) v.value = String(engine.available[j]);
    }
  }
  renderSafety();
}

export function initBankersSimulator() {
  byId('btnRunBankers')?.addEventListener('click', () => { syncInputs(); renderSafety(); });
  byId('btnEvaluateCompoundClaim')?.addEventListener('click', evaluateClaim);
  byId('btnPreloadUnsafeClaim')?.addEventListener('click', () => {
    const sel = byId('compoundProcessSelect'); if (sel) sel.value = '0';
    [3, 3, 2].forEach((v, j) => { const input = byId(`claimReq${j}`); if (input) input.value = String(v); });
    evaluateClaim();
  });
  syncInputs();
  renderSafety();
}
