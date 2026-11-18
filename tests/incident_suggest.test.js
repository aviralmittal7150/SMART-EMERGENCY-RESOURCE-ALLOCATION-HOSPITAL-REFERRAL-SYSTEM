// Mass-casualty suggestions (js/recommend.js suggestForIncident): most urgent first, greedy on a working copy of the
// live capacity, so two patients are never suggested the same last bed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHospital, suggestForIncident } from '../js/recommend.js';

const raw = (id, icu, ot, surgeons, lat = 28.6, lng = 77.2, status = 'OPEN') => ({
  hospital_id: id, hospital_name: id, emergency_status: status, location_lat: lat, location_lng: lng,
  resources: { icubed: { total: 10, available: icu, locked: 0 }, ot: { total: 4, available: ot, locked: 0 } },
  specialists_available: { TRAUMA_SURGEON: surgeons, CARDIOLOGIST: 1 }
});
const trauma = (id, priority) => ({ request_id: id, priority, required_resource_types: ['ICU_BED', 'OT'], required_specialist: 'TRAUMA_SURGEON', pickup_lat: 28.6, pickup_lng: 77.2 });

test('normalizeHospital keeps the per-specialisation counts', () => {
  const h = normalizeHospital(raw('H-1', 2, 1, 3));
  assert.equal(h.specialistCounts.TRAUMA_SURGEON, 3);
  assert.ok(h.onDuty.has('TRAUMA_SURGEON'));
});

test('P1 first, then list order; capacity used by earlier patients is not offered again', () => {
  const hospitals = [raw('NEAR', 1, 1, 1, 28.6, 77.2), raw('FAR', 2, 2, 2, 28.7, 77.3)].map(normalizeHospital);
  const out = suggestForIncident([trauma('A', 3), trauma('B', 1), trauma('C', 3)], hospitals);
  assert.deepEqual(out.map(s => s.case.request_id), ['B', 'A', 'C']);
  assert.deepEqual(out.map(s => s.hospital?.id), ['NEAR', 'FAR', 'FAR'], 'the greedy choice follows the capacity left');
  assert.equal(out.filter(s => s.hospital?.id === 'NEAR').length, 1, 'the single bed / OT / surgeon at NEAR is suggested once only');
  assert.deepEqual(out.map(s => [s.earlierHere, s.freeBefore.ICU_BED]), [[0, 1], [0, 2], [1, 1]]);
  // The live data is not changed.
  assert.equal(hospitals[0].resources.ICU_BED.free, 1);
  assert.equal(hospitals[0].specialistCounts.TRAUMA_SURGEON, 1);
});

test('when capacity runs out the patient gets no suggestion, with the reasons', () => {
  const hospitals = [raw('ONLY', 1, 1, 2)].map(normalizeHospital);
  const out = suggestForIncident([trauma('A', 1), trauma('B', 2)], hospitals);
  assert.equal(out[0].hospital.id, 'ONLY');
  assert.equal(out[1].hospital, null);
  assert.ok(out[1].reasons.some(r => /No free ICU bed/.test(r)), out[1].reasons.join(' | '));
});

test('a consultant is not used up; an excluded hospital is skipped', () => {
  const hospitals = [raw('H-1', 5, 5, 0), raw('H-2', 5, 5, 0)].map(normalizeHospital);
  const cardiac = id => ({ request_id: id, priority: 2, required_resource_types: ['ICU_BED'], required_specialist: 'CARDIOLOGIST' });
  const out = suggestForIncident([cardiac('A'), cardiac('B'), { ...cardiac('C'), exclude: new Set(['H-1', 'H-2']) }], hospitals);
  assert.ok(out[0].hospital && out[1].hospital, 'one cardiologist can be suggested for two patients');
  assert.equal(out[2].hospital, null);
});

test('a patient needing nothing special can go anywhere open', () => {
  const hospitals = [raw('H-1', 0, 0, 0), raw('CLOSED', 5, 5, 5, 28.6, 77.2, 'CLOSED')].map(normalizeHospital);
  const out = suggestForIncident([{ request_id: 'G', priority: 4, required_resource_types: [], required_specialist: null }], hospitals);
  assert.equal(out[0].hospital.id, 'H-1');
});
