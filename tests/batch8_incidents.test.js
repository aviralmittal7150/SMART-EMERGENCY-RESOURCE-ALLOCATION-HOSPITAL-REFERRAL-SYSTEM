// Batch 8 (P1-A/B/E): mass-casualty incidents end to end against a real `node server/server.js`:
// create / list / get (ADMIN only: desk and Fleet refused), the operating-area check, bulk victims all or nothing
// (25 and 100 victims; 101 refused; one bad row stores nothing), Idempotency-Key replay (same victims, header) and 422 for
// the key with another body, concurrent duplicates, row-level validation without persisting, anonymous MCI-NNN labels,
// NULL ages, triage -> priority mapping (RED 1, YELLOW 3, GREEN 4), the incident summary, the idempotent demo
// (12 victims: 2 RED, 4 YELLOW, 6 GREEN), the INCIDENT_CREATED / VICTIMS_REGISTERED audit rows and a valid audit chain.
// Runs on the in-memory store; tests/batch8_incidents_mysql.test.js runs the same file on the MySQL test database.
// All data is fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const BACKEND = process.env.API_TEST_BACKEND === 'mysql' ? 'mysql' : 'memory';
const PORT = BACKEND === 'mysql' ? 4287 : 4286;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'batch8-incidents-test-secret-0123456789ab';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const INSIDE = { lat: 30.3061, lng: 78.0199 }; // Dehradun
let keyNo = 0;
const newKey = () => `inc-test-${Date.now()}-${(keyNo += 1)}`;

let server = null;
let database = null;
let skipReason = null;
const T = {};

async function call(path, token, method = 'GET', body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null), replayed: response.headers.get('Idempotent-Replayed') === 'true' };
}
const skipped = t => { if (skipReason) { t.skip(skipReason); return true; } return false; };
const incidentBody = (extra = {}) => ({ title: 'Fictional bus crash', incident_type: 'bus_crash', severity: 'high', location_lat: INSIDE.lat, location_lng: INSIDE.lng, ...extra });
const victim = (i, extra = {}) => ({ injury_description: `Fictional injury ${i}`, triage_category: ['RED', 'YELLOW', 'GREEN'][i % 3], emergency_type: 'GENERAL', ...extra });
const victims = n => Array.from({ length: n }, (_, i) => victim(i));
const addVictims = (id, list, key = newKey(), token = T.admin) => call(`/api/v1/incidents/${id}/victims`, token, 'POST', { victims: list }, { 'Idempotency-Key': key });
const getIncident = id => call(`/api/v1/incidents/${id}`, T.admin);
async function newIncident(extra) {
  const r = await call('/api/v1/incidents', T.admin, 'POST', incidentBody(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.incident.incident_id;
}
const caseCount = async () => (await call('/api/v1/emergencies', T.admin)).body.count;

test.before(async () => {
  let env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MYSQL_TEST_'))),
    PORT: String(PORT), DB_USE_MEMORY: 'true', JWT_SECRET: SECRET, API_RATE_LIMIT: '100000', SIMULATED_TRANSPORT: 'off', ROUTING_URL: 'off'
  };
  delete env.JWT_EXPIRES;
  delete env.TRUST_PROXY;
  delete env.NODE_ENV;
  if (BACKEND === 'mysql') {
    const { openTestDatabase, mysqlServerEnv } = await import('./helpers/mysqlTestDb.js');
    database = await openTestDatabase();
    if (database.skip) { skipReason = database.skip; return; }
    await database.reset(true);
    env = mysqlServerEnv(PORT, { JWT_SECRET: SECRET, API_RATE_LIMIT: '100000', JWT_EXPIRES: '', TRUST_PROXY: '', ROUTING_URL: 'off' });
  }
  server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  const accounts = { admin: ['admin', 'admin123'], apex: ['apex_desk', 'hospital123'], medic: ['UNIT-402', 'paramedic123'] };
  for (const [key, [username, password]] of Object.entries(accounts)) {
    const result = await call('/api/v1/auth/login', null, 'POST', { username, password });
    assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
    T[key] = result.body.token;
  }
});

test.after(async () => {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  if (database && !database.skip) {
    try { await database.reset(true); } finally { await database.release(); }
  }
});

test(`incidents: create, list, get; ADMIN only; operating area and field validation [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  for (const token of [T.apex, T.medic]) {
    assert.equal((await call('/api/v1/incidents', token)).status, 403);
    assert.equal((await call('/api/v1/incidents', token, 'POST', incidentBody())).status, 403);
    assert.equal((await call('/api/v1/incidents/demo-setup', token, 'POST')).status, 403);
  }
  assert.equal((await call('/api/v1/incidents', null)).status, 401);
  const outside = await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ location_lat: 28.6139, location_lng: 77.2090 }));
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /operating area/);
  assert.equal((await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ title: '' }))).status, 400);
  assert.equal((await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ incident_type: 'meteor' }))).status, 400);
  assert.equal((await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ severity: 'BLACK' }))).status, 400);

  const created = await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ location_text: 'Clock Tower', estimated_victims: 30, vehicles_involved: 2,
    occurred_at: '2026-11-15T09:30:00.000Z', description: 'Fictional' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const inc = created.body.incident;
  assert.match(inc.incident_id, /^INC-\d{8}-\d{3}$/);
  assert.deepEqual([inc.title, inc.incident_type, inc.severity, inc.location_text, inc.estimated_victims, inc.vehicles_involved, inc.occurred_at, inc.is_demo, inc.victim_count],
    ['Fictional bus crash', 'bus_crash', 'high', 'Clock Tower', 30, 2, '2026-11-15T09:30:00.000Z', false, 0]);
  assert.equal(created.body.summary.total_victims, 0);

  const second = await newIncident();
  assert.notEqual(second, inc.incident_id);
  const list = await call('/api/v1/incidents', T.admin);
  assert.equal(list.status, 200);
  assert.ok(list.body.incidents.some(i => i.incident_id === inc.incident_id) && list.body.incidents.some(i => i.incident_id === second));
  const got = await getIncident(inc.incident_id);
  assert.equal(got.status, 200);
  assert.deepEqual([got.body.incident.incident_id, got.body.victims.length], [inc.incident_id, 0]);
  assert.equal((await getIncident('INC-19990101-001')).status, 404);
  assert.equal((await call(`/api/v1/incidents/${inc.incident_id}`, T.apex)).status, 403);
});

test(`incident victims: bulk all or nothing, labels, NULL age, triage mapping, summary, 25 and 100 victims [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const id = await newIncident();
  const rows = [
    victim(0, { triage_category: 'RED', emergency_type: 'TRAUMA' }),
    victim(1, { full_name: 'Asha Fictional', age: 34, gender: 'FEMALE', triage_category: 'yellow' }),
    victim(2, { triage_category: 'GREEN', transport_required: false, pickup_lat: 30.33, pickup_lng: 78.05 })
  ];
  const before = await caseCount();
  const added = await addVictims(id, rows);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.request_ids.length, 3);
  assert.equal(await caseCount(), before + 3);
  const detail = (await getIncident(id)).body;
  const [a, b, c] = detail.victims;
  assert.deepEqual(detail.victims.map(v => v.label), ['MCI-001', 'MCI-002', 'MCI-003']);
  assert.deepEqual([a.full_name, a.age, a.triage_category, a.triage_priority, a.emergency_type, a.required_specialist], ['MCI-001', null, 'RED', 1, 'TRAUMA', 'TRAUMA_SURGEON']);
  assert.deepEqual([b.full_name, b.age, b.gender, b.triage_category, b.triage_priority], ['Asha Fictional', 34, 'FEMALE', 'YELLOW', 3]);
  assert.deepEqual([c.triage_priority, c.transport_required, c.injury_description, c.pickup_lat, c.pickup_lng], [4, false, 'Fictional injury 2', 30.33, 78.05]);
  assert.deepEqual([a.pickup_lat, a.pickup_lng, a.transport_required, a.status, a.incident_id], [INSIDE.lat, INSIDE.lng, true, 'WAITING', id]);
  assert.deepEqual(detail.summary.by_triage, { RED: 1, YELLOW: 1, GREEN: 1 });
  assert.deepEqual([detail.summary.total_victims, detail.summary.awaiting_ambulance, detail.summary.in_treatment, detail.summary.completed], [3, 2, 0, 0]);
  assert.equal(detail.incident.victim_count, 3);
  // The victims are ordinary cases: in the queue with the incident link, readable with their NULL age.
  const queue = (await call('/api/v1/emergencies', T.admin)).body.queue.filter(q => q.incident_id === id);
  assert.equal(queue.length, 3);
  const caseDetail = await call(`/api/v1/emergencies/${a.request_id}`, T.admin);
  assert.equal(caseDetail.status, 200);
  assert.equal(caseDetail.body.patient.age, null);

  // One bad row: nothing is stored (400 with that row's errors).
  const bad = await addVictims(id, [victim(3), victim(4, { triage_category: 'BLACK' }), victim(5, { pickup_lat: 28.61, pickup_lng: 77.2 })]);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map(e => [e.row, e.field]), [[1, 'triage_category'], [2, 'pickup_lat']]);
  assert.equal(await caseCount(), before + 3);
  assert.equal((await getIncident(id)).body.victims.length, 3);
  // The numbering continues after the stored victims (MCI-004 ... MCI-028 for 25 more).
  const many = await addVictims(id, victims(25));
  assert.equal(many.status, 201, JSON.stringify(many.body));
  const after25 = (await getIncident(id)).body.victims;
  assert.equal(after25.length, 28);
  assert.deepEqual([after25[3].label, after25.at(-1).label], ['MCI-004', 'MCI-028']);
  assert.equal(new Set(after25.map(v => v.request_id)).size, 28);

  const big = await newIncident();
  const hundred = await addVictims(big, victims(100));
  assert.equal(hundred.status, 201, JSON.stringify(hundred.body));
  assert.equal((await getIncident(big)).body.victims.length, 100);
  const tooMany = await addVictims(big, victims(101));
  assert.equal(tooMany.status, 400);
  assert.equal((await addVictims(big, [])).status, 400);
  assert.equal((await getIncident(big)).body.victims.length, 100);
  assert.equal((await addVictims('INC-19990101-001', victims(1))).status, 404);
  assert.equal((await addVictims(big, victims(1), undefined, T.apex)).status, 403);
});

test(`incident victims: Idempotency-Key replay, 422 for another body, concurrent duplicates, key required [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const id = await newIncident();
  const key = newKey();
  const list = victims(4);
  const first = await addVictims(id, list, key);
  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);
  const again = await addVictims(id, list, key);
  assert.equal(again.status, 201);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.body.request_ids, first.body.request_ids);
  assert.deepEqual(again.body.victims.map(v => v.label), ['MCI-001', 'MCI-002', 'MCI-003', 'MCI-004']);
  const other = await addVictims(id, victims(2), key);
  assert.equal(other.status, 422);
  assert.equal((await getIncident(id)).body.victims.length, 4);
  const noKey = await call(`/api/v1/incidents/${id}/victims`, T.admin, 'POST', { victims: victims(1) });
  assert.equal(noKey.status, 400);
  assert.equal((await getIncident(id)).body.victims.length, 4);

  // The same submission sent three times at once: one set of victims. Different submissions at once: unique numbers.
  const k2 = newKey();
  const same = await Promise.all([1, 2, 3].map(() => addVictims(id, victims(3), k2)));
  assert.ok(same.every(r => r.status === 201 || r.status === 409), same.map(r => r.status).join(','));
  const ok = same.filter(r => r.status === 201);
  assert.ok(ok.every(r => JSON.stringify(r.body.request_ids) === JSON.stringify(ok[0].body.request_ids)));
  assert.equal((await getIncident(id)).body.victims.length, 7);
  const parallel = await Promise.all([1, 2, 3].map(() => addVictims(id, victims(2))));
  assert.ok(parallel.every(r => r.status === 201 || r.status === 409), parallel.map(r => r.status).join(','));
  const stored = (await getIncident(id)).body.victims;
  assert.equal(stored.length, 7 + 2 * parallel.filter(r => r.status === 201).length);
  assert.deepEqual(stored.map(v => v.incident_seq), stored.map((_, i) => i + 1), 'victim numbers are unique and gap-free');

  // POST /incidents with its victims in one request: one incident, its victims, replayed by the same key.
  const ck = newKey();
  const body = incidentBody({ title: 'Fictional crash with victims', victims: victims(5) });
  const made = await call('/api/v1/incidents', T.admin, 'POST', body, { 'Idempotency-Key': ck });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.victims.length, 5);
  const replay = await call('/api/v1/incidents', T.admin, 'POST', body, { 'Idempotency-Key': ck });
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.incident.incident_id, made.body.incident.incident_id);
  assert.equal((await call('/api/v1/incidents', T.admin)).body.incidents.filter(i => i.title === 'Fictional crash with victims').length, 1);
  assert.equal((await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ title: 'Changed' }), { 'Idempotency-Key': ck })).status, 422);
  const badInline = await call('/api/v1/incidents', T.admin, 'POST', incidentBody({ title: 'Never stored', victims: [victim(0, { emergency_type: 'NOPE' })] }));
  assert.equal(badInline.status, 400);
  assert.equal((await call('/api/v1/incidents', T.admin)).body.incidents.filter(i => i.title === 'Never stored').length, 0);
});

test(`incident victims: validate returns row errors and stores nothing [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const id = await newIncident();
  const before = await caseCount();
  const v = await call(`/api/v1/incidents/${id}/victims/validate`, T.admin, 'POST', { victims: [victim(0), { triage_category: 'BLACK' }, victim(2, { age: 200 }), 'x'] });
  assert.equal(v.status, 200);
  assert.equal(v.body.valid, false);
  const fields = v.body.errors.map(e => `${e.row}:${e.field}`);
  for (const f of ['1:injury_description', '1:triage_category', '1:emergency_type', '2:age', '3:null']) assert.ok(fields.includes(f), `${f} in ${fields}`);
  assert.ok(!fields.some(f => f.startsWith('0:')));
  const good = await call(`/api/v1/incidents/${id}/victims/validate`, T.admin, 'POST', { victims: victims(3) });
  assert.deepEqual([good.body.valid, good.body.count, good.body.errors], [true, 3, []]);
  assert.equal(await caseCount(), before);
  assert.equal((await getIncident(id)).body.victims.length, 0);
});

test(`incident demo: idempotent, 12 victims (2 RED, 4 YELLOW, 6 GREEN) in Dehradun; audit rows; chain valid [${BACKEND}]`, async t => {
  if (skipped(t)) return;
  const first = await call('/api/v1/incidents/demo-setup', T.admin, 'POST');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await call('/api/v1/incidents/demo-setup', T.admin, 'POST');
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'existing');
  assert.equal(again.body.incident.incident_id, first.body.incident.incident_id);
  const d = (await getIncident(first.body.incident.incident_id)).body;
  assert.deepEqual([d.incident.title, d.incident.is_demo, d.victims.length], ['Highway Bus Accident', true, 12]);
  assert.deepEqual(d.summary.by_triage, { RED: 2, YELLOW: 4, GREEN: 6 });
  assert.ok(d.victims.every(v => v.is_demo && v.pickup_lat >= 30.2 && v.pickup_lat <= 30.45 && v.pickup_lng >= 77.9 && v.pickup_lng <= 78.15));
  assert.equal((await call('/api/v1/incidents', T.admin)).body.incidents.filter(i => i.is_demo).length, 1);

  const audit = (await call('/api/v1/analytics/audit?limit=1000', T.admin)).body.audit_trail;
  const created = audit.filter(e => e.event_type === 'INCIDENT_CREATED');
  const registered = audit.filter(e => e.event_type === 'VICTIMS_REGISTERED');
  const meta = e => (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata);
  assert.ok(created.some(e => meta(e).incident_id === first.body.incident.incident_id));
  const demoRows = registered.filter(e => meta(e).incident_id === first.body.incident.incident_id);
  assert.equal(demoRows.length, 1);
  assert.equal(meta(demoRows[0]).count, 12);
  const verify = await call('/api/v1/audit/verify', T.admin);
  assert.equal(verify.status, 200);
  assert.equal(verify.body.verification.valid, true, JSON.stringify(verify.body));
});
