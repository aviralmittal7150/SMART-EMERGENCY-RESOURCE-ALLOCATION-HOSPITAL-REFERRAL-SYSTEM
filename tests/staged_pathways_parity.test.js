// tests/staged_pathways_parity.test.js
// The case tracker previews "Advance to next stage" from the client's copy of the staged pathways (js/staged.js).
// That copy must equal the server's table and claim construction, or the preview would describe a different plan
// from the one the server applies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGED_PATHWAYS as CLIENT_PATHWAYS, stagedClaim } from '../js/staged.js';
import { STAGED_PATHWAYS as SERVER_PATHWAYS, buildClaim } from '../server/services/clinicalPathways.js';
import { resolveEmergencyRequirements, VALID_RESOURCE_TYPES } from '../server/services/emergencyRequirements.js';

test('the client pathway table equals the server table', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(CLIENT_PATHWAYS)), JSON.parse(JSON.stringify(SERVER_PATHWAYS)));
});

test('for every staged type and every set of extra resources, the client claim equals buildClaim', () => {
  const subsets = VALID_RESOURCE_TYPES.reduce((all, t) => all.concat(all.map(s => [...s, t])), [[]]);
  for (const type of Object.keys(SERVER_PATHWAYS)) {
    for (const extras of subsets) {
      const requirements = resolveEmergencyRequirements(type, extras);
      assert.ok(requirements, `${type} + ${extras.join(',')}: not a valid request`);
      const preset = resolveEmergencyRequirements(type).resourceTypes;
      const client = stagedClaim(type, preset, requirements.resourceTypes);
      assert.deepStrictEqual(client, JSON.parse(JSON.stringify(buildClaim(type, requirements))), `${type} + [${extras.join(',')}]`);
    }
  }
});

test('types without a staged pathway get no client claim (the tracker offers no advance for them)', () => {
  for (const type of ['CARDIAC', 'STROKE', 'RESPIRATORY', 'PEDIATRIC', 'GENERAL']) {
    assert.equal(SERVER_PATHWAYS[type], undefined, `${type} became staged on the server: update js/staged.js`);
    assert.equal(stagedClaim(type, [], []), null);
  }
});
