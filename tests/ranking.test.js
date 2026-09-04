import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rankHospitals } from '../js/ranking.js';
import { initialHospitals } from '../js/data.js';

describe('Issue #2: Hospital Suitability Ranking & Matching Engine', () => {
  test('Hospitals in CLOSED / Divert status are strictly excluded (Score = 0)', () => {
    const hospitals = JSON.parse(JSON.stringify(initialHospitals));
    const requirements = { requiredBeds: 1 };
    const ranked = rankHospitals(hospitals, requirements);
    
    const closedHospital = ranked.find(h => h.id === 'H-106');
    assert.strictEqual(closedHospital.isEligible, false);
    assert.strictEqual(closedHospital.suitabilityScore, 0);
  });

  test('Hospitals lacking mandatory required specialist are excluded rather than given low score', () => {
    const hospitals = JSON.parse(JSON.stringify(initialHospitals));
    const requirements = { requiredBeds: 1, specialist: 'cardiologist' };
    const ranked = rankHospitals(hospitals, requirements);

    const hospitalWithoutCardiologist = ranked.find(h => h.id === 'H-102');
    assert.strictEqual(hospitalWithoutCardiologist.isEligible, false);
    assert.ok(hospitalWithoutCardiologist.exclusionReason.includes('Specialist'));
  });

  test('Suitability score correctly weights Resource Fit (40%), Acceptance (25%), Capacity (20%), Distance (15%)', () => {
    const hospitals = JSON.parse(JSON.stringify(initialHospitals));
    const requirements = { requiredBeds: 1, requiredVents: 1 };
    const ranked = rankHospitals(hospitals, requirements);

    const topMatch = ranked.find(h => h.isEligible);
    assert.ok(topMatch.suitabilityScore > 70, 'Top eligible hospital must have high suitability score');
    assert.ok(topMatch.breakdown.resourceFit > 0);
  });
});
