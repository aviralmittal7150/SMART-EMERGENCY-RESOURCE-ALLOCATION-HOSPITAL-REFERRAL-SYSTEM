import { test, describe } from 'node:test';
import assert from 'node:assert';
import { initialHospitals, initialAmbulances, initialEmergencyQueue } from '../js/data.js';

describe('Issue #3: Command Center Dashboard & Aggregate Telemetry', () => {
  test('Correctly aggregates total network ICU beds and open ventilators', () => {
    let totalIcu = 0;
    let totalVent = 0;

    initialHospitals.forEach(h => {
      if (h.status !== 'CLOSED') {
        totalIcu += h.resources.icuBeds.available;
        totalVent += h.resources.ventilators.available;
      }
    });

    assert.strictEqual(totalIcu, 18, 'Aggregated ICU count should match sum of active facilities');
    assert.strictEqual(totalVent, 14, 'Aggregated Ventilator count should match sum of active facilities');
  });

  test('Correctly computes active ambulance standby count', () => {
    const availableAmbs = initialAmbulances.filter(a => a.status === 'AVAILABLE').length;
    assert.strictEqual(availableAmbs, 3, 'Available ambulance count should equal 3');
  });

  test('Tracks active and critical triage emergencies in the system', () => {
    const activeEmergencies = initialEmergencyQueue.filter(e => e.status !== 'COMPLETED').length;
    const criticalWaiting = initialEmergencyQueue.filter(e => e.priority === 1 && e.status === 'WAITING').length;
    
    assert.strictEqual(activeEmergencies, 3);
    assert.strictEqual(criticalWaiting, 0); // Re-verified
  });
});
