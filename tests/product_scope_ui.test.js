import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const emergencyRoute = await readFile(new URL('../server/routes/emergencies.js', import.meta.url), 'utf8');
const referralRoute = await readFile(new URL('../server/routes/referrals.js', import.meta.url), 'utf8');
const ambulanceRoute = await readFile(new URL('../server/routes/ambulances.js', import.meta.url), 'utf8');

test('intake exposes only RED, YELLOW and GREEN triage choices', () => {
  const triage = html.match(/<div class="triage-selector"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(triage, /data-category="RED"/);
  assert.match(triage, /data-category="YELLOW"/);
  assert.match(triage, /data-category="GREEN"/);
  assert.doesNotMatch(triage, /data-level=|>P[1-5]</);
  assert.match(app, /RED: 1, YELLOW: 3, GREEN: 4/);
});

test('Fleet lands on its own fleet workspace and cannot see the incident intake workspace', () => {
  assert.match(app, /PARAMEDIC: 'tab-ambulance'/);
  assert.match(html, /id="tab-ingestion" class="tab-pane" data-roles="ADMIN HOSPITAL_DESK"/);
  assert.match(html, /id="intakePanel" data-roles="ADMIN"/);
  assert.match(html, /id="nav-emergency" type="button" data-roles="ADMIN HOSPITAL_DESK"/);
});

test('server write routes reserve case creation, referrals and fleet administration for Admin', () => {
  assert.match(emergencyRoute, /router\.post\([\s\S]*?authorize\('ADMIN'\),[\s\S]*?validateBody\(CREATE_SCHEMA\)/);
  assert.match(referralRoute, /router\.post\('\/initiate',[\s\S]*?authorize\('ADMIN'\)/);
  assert.match(ambulanceRoute, /router\.patch\('\/:ambulanceId\/status',[\s\S]*?authorize\('ADMIN'\)/);
});
