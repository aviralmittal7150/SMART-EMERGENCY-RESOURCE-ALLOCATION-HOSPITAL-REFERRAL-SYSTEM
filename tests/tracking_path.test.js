// The live-tracking marker follows the road between two server positions (js/tracking-map.js pathOf/project/at).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathOf, project, at } from '../js/tracking-map.js';
import { inOperatingArea, operatingAreaProblem, DEFAULT_VIEW } from '../js/operating-area.js';

// An L-shaped road: east 1 km, then north 1 km (Dehradun).
const A = [30.3165, 78.0322];
const B = [30.3165, 78.0322 + 1000 / (111320 * Math.cos((30.3165 * Math.PI) / 180))];
const C = [30.3165 + 1000 / 111320, B[1]];

test('distances along a polyline and the point at a distance', () => {
  const path = pathOf([A, B, C]);
  assert.ok(Math.abs(path.length - 2000) < 1, `length ${path.length}`);
  const corner = at(path, 1000);
  assert.ok(Math.abs(corner[0] - B[0]) < 1e-9 && Math.abs(corner[1] - B[1]) < 1e-9);
  assert.deepEqual(at(path, -5), A);
  assert.deepEqual(at(path, 99999), C);
});

test('a position on the road projects onto it; one off the road is far from it', () => {
  const path = pathOf([A, B, C]);
  const mid = at(path, 1500);
  const p = project(path, mid);
  assert.ok(Math.abs(p.s - 1500) < 0.5 && p.off < 0.5);
  // The straight line between a point before and after the corner cuts the corner: its midpoint is ~250 m off the road.
  const before = at(path, 500); const after = at(path, 1500);
  const chordMid = [(before[0] + after[0]) / 2, (before[1] + after[1]) / 2];
  assert.ok(project(path, chordMid).off > 200, 'the chord does not leave the road (test shape wrong)');
  // Moving along the path instead keeps every intermediate point on the road.
  for (let k = 0; k <= 10; k++) assert.ok(project(path, at(path, 500 + 100 * k)).off < 0.5);
});

test('the operating area is Dehradun', () => {
  assert.ok(inOperatingArea(...DEFAULT_VIEW.center));
  assert.equal(operatingAreaProblem(30.3165, 78.0322), null);
  assert.match(operatingAreaProblem(28.6139, 77.2090, 'The pickup'), /The pickup is outside the Dehradun operating area/);
  assert.ok(!inOperatingArea(Number.NaN, 78));
});

test('the browser copy of the operating area equals the server\'s', async () => {
  const { OPERATING_AREA: server } = await import('../server/services/operatingArea.js');
  const { OPERATING_AREA: client } = await import('../js/operating-area.js');
  for (const k of ['minLat', 'maxLat', 'minLng', 'maxLng']) assert.equal(client[k], server[k], k);
});
