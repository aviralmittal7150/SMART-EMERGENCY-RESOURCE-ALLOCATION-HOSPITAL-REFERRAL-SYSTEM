// GET /api/v1/audit/verify through HTTP (Phase 3 Step 5): ADMIN only; reports validity, the first break and the
// head for a future checkpoint. Real Express routers in-process on the in-memory store. Fictional data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { memoryTokenFor } from './helpers/testUsers.js';
import emergenciesRoutes from '../server/routes/emergencies.js';
import auditRoutes from '../server/routes/audit.js';

const app = express();
app.use(express.json());
app.use('/api/v1/emergencies', emergenciesRoutes);
app.use('/api/v1/audit', auditRoutes);
let server;
let base;
test.before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => new Promise(r => server.close(r)));

const token = (role, hospital_id = null) => memoryTokenFor(db, { user_id: `U-${role}-${hospital_id ?? 'ALL'}`, role, hospital_id });
const call = async (path, t, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('admins can verify the audit chain; desks and paramedics cannot', async () => {
  const created = await call('/api/v1/emergencies', token('PARAMEDIC'), 'POST', { patient_name: 'Fictional Audit Route', age: 30, emergency_type: 'GENERAL', triage_priority: 3 });
  assert.equal(created.status, 201);
  const ok = await call('/api/v1/audit/verify', token('ADMIN'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verification.valid, true);
  assert.ok(ok.body.verification.checked >= 1);
  assert.match(ok.body.verification.head.hash, /^[0-9a-f]{64}$/);
  assert.equal((await call('/api/v1/audit/verify', token('HOSPITAL_DESK', 'H-101'))).status, 403);
  assert.equal((await call('/api/v1/audit/verify', token('PARAMEDIC'))).status, 403);
});

test('a tampered ledger is reported through the API with the exact break', async () => {
  const chained = db.emergencyHistory.filter(h => h.chain_seq != null);
  const victim = chained[0];
  const original = victim.event_type;
  victim.event_type = 'FORGED';
  try {
    const res = await call('/api/v1/audit/verify', token('ADMIN'));
    assert.equal(res.body.verification.valid, false);
    assert.deepEqual(res.body.verification.first_break.reason, 'ROW_HASH_MISMATCH');
    assert.equal(res.body.verification.first_break.chain_seq, victim.chain_seq);
  } finally {
    victim.event_type = original;
  }
});
