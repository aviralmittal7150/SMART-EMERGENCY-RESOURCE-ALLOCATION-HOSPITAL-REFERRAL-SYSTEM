import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  analyzeRoadsideSymptoms,
  calculateHaversineDistance,
  updateHospitalDistances,
  generateHospitalRecommendationReason,
  SYMPTOM_DATABASE,
  ROADSIDE_HOTSPOTS
} from '../js/symptom_triage.js';
import { initialHospitals } from '../js/data.js';
import { rankHospitals } from '../js/ranking.js';

describe('Feature: Roadside Accident & Symptom-Based Hospital Finder', () => {
  test('Correctly extracts symptoms and triage severity from natural language accident description', () => {
    const speechInput = "A motorcyclist crashed at high speed on the highway, he is unconscious and bleeding heavily from his head!";
    const analysis = analyzeRoadsideSymptoms(speechInput, []);

    assert.strictEqual(analysis.triageLevel, 1, 'Severe head trauma with unconsciousness must triage to Level 1 Resuscitation');
    assert.strictEqual(analysis.emergencyType, 'TRAUMA');
    assert.ok(analysis.isCritical, 'Accident must be marked critical');
    assert.strictEqual(analysis.requiredResources.requiredBeds, 1, 'Must require ICU Bed');
    assert.strictEqual(analysis.requiredResources.requiredOT, 1, 'Must require Emergency OT');
    assert.ok(['traumaSurgeon', 'neurologist'].includes(analysis.requiredResources.specialist), 'Must assign Trauma or Neuro Specialist');
  });

  test('Extracts blunt chest impact and assigns cardiac emergency category with cardiologist requirement', () => {
    const speechInput = "Car struck a divider, driver hit steering wheel hard, has severe crushing chest pain and difficulty breathing";
    const analysis = analyzeRoadsideSymptoms(speechInput, []);

    assert.strictEqual(analysis.triageLevel, 1);
    assert.strictEqual(analysis.emergencyType, 'CARDIAC');
    assert.strictEqual(analysis.requiredResources.specialist, 'cardiologist');
    assert.strictEqual(analysis.requiredResources.requiredVents, 1);
  });

  test('Correctly combines selected symptom chips with voice text', () => {
    const analysis = analyzeRoadsideSymptoms("Patient fell down on the road", ["crushed_limb_fracture"]);

    assert.ok(analysis.matchedSymptoms.some(s => s.id === "crushed_limb_fracture"));
    assert.strictEqual(analysis.triageLevel, 2, 'Compound fracture must triage to Level 2 Emergent');
    assert.strictEqual(analysis.requiredResources.requiredOT, 1, 'Open fracture requires Emergency OT');
  });

  test('Accurately computes Haversine GPS distances between coordinates', () => {
    // Delhi Connaught Place to India Gate ~ 2.1 km
    const dist = calculateHaversineDistance(28.6315, 77.2167, 28.6129, 77.2295);
    assert.ok(dist >= 1.8 && dist <= 2.6, `Calculated distance should be approximately 2.1 km (got ${dist})`);
  });

  test('Dynamically updates hospital distances based on user roadside location', () => {
    const hotspot = ROADSIDE_HOTSPOTS[0]; // Highway 44
    const updated = updateHospitalDistances(initialHospitals, hotspot.lat, hotspot.lng);

    assert.strictEqual(updated.length, initialHospitals.length);
    assert.ok(typeof updated[0].distanceKm === 'number');
    assert.ok(updated[0].estDriveMins > 0);
  });

  test('Selects nearest SUITABLE hospital over closer unequipped hospital for critical polytrauma', () => {
    // Road accident with head bleed + compound fracture needing Emergency OT, ICU bed, and trauma surgeon
    const analysis = analyzeRoadsideSymptoms("Motorcycle crash, bone sticking out, head bleed, heavy arterial bleeding", []);
    const reqs = analysis.requiredResources;

    // Rank hospitals
    const ranked = rankHospitals(initialHospitals, reqs);
    const topEligible = ranked.find(h => h.isEligible);

    assert.ok(topEligible, 'A suitable hospital must be found');
    assert.ok(
      topEligible.resources.emergencyOT.available >= reqs.requiredOT,
      'Top hospital must have open emergency OT'
    );
    assert.ok(
      topEligible.resources.icuBeds.available >= reqs.requiredBeds,
      'Top hospital must have open ICU bed'
    );
    assert.ok(
      topEligible.resources.specialists[reqs.specialist] === true,
      'Top hospital must have required specialist on duty'
    );

    // Verify reason generation flags unequipped closer hospital
    const reason = generateHospitalRecommendationReason(topEligible, ranked, reqs);
    assert.ok(reason.headline.includes(topEligible.name));
    assert.ok(reason.details.length > 20);
    // Memorial Community (H-104) is 1.8km away but has NO ICU beds / trauma surgeon
    if (reason.closerExcluded) {
      assert.strictEqual(reason.closerExcluded.id, 'H-104');
    }
  });

  test('Provides tailored first-aid instructions for roadside bystanders', () => {
    const analysis = analyzeRoadsideSymptoms("Deep cut with spurting arterial blood and cannot feel legs or back pain", []);
    assert.ok(analysis.firstAidSteps.length >= 1);
    const combinedFirstAid = analysis.firstAidSteps.join(" ");
    assert.ok(
      combinedFirstAid.includes("pressure") || combinedFirstAid.includes("tourniquet") || combinedFirstAid.includes("DO NOT MOVE"),
      'First aid must include bleed pressure or spinal stabilization'
    );
  });
});
