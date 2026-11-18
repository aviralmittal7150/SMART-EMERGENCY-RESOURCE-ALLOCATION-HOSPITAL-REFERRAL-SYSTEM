// Hospital Suitability Ranking Engine (Multi-Factor OS Resource Scoring)

export const DEFAULT_WEIGHTS = {
  resourceFit: 0.40,
  acceptanceRate: 0.25,
  criticalCapacity: 0.20,
  distanceProximity: 0.15
};

/**
 * Evaluates candidate hospitals against emergency requirements and computes suitability score.
 * Formula: Suitability = (wRF * RF) + (wAR * AR) + (wCC * CC) + (wDP * DP)
 */
export function rankHospitals(hospitals, requirements, weights = DEFAULT_WEIGHTS) {
  const { requiredBeds = 0, requiredVents = 0, requiredOT = 0, specialist = null } = requirements;

  return hospitals
    .map(hospital => {
      // 1. Hard Exclusion Checks
      if (hospital.status === "CLOSED") {
        return {
          ...hospital,
          suitabilityScore: 0,
          isEligible: false,
          exclusionReason: "Hospital is in DIVERT/CLOSED status."
        };
      }

      // Check required ICU beds
      if (requiredBeds > 0 && hospital.resources.icuBeds.available < requiredBeds) {
        return {
          ...hospital,
          suitabilityScore: 0,
          isEligible: false,
          exclusionReason: "Zero ICU beds available."
        };
      }

      // Check required Ventilators
      if (requiredVents > 0 && hospital.resources.ventilators.available < requiredVents) {
        return {
          ...hospital,
          suitabilityScore: 0,
          isEligible: false,
          exclusionReason: "Zero ventilators available."
        };
      }

      // Check required Emergency OT
      if (requiredOT > 0 && hospital.resources.emergencyOT.available < requiredOT) {
        return {
          ...hospital,
          suitabilityScore: 0,
          isEligible: false,
          exclusionReason: "Emergency OT fully occupied."
        };
      }

      // Check required Specialist
      if (specialist && !hospital.resources.specialists[specialist]) {
        return {
          ...hospital,
          suitabilityScore: 0,
          isEligible: false,
          exclusionReason: `Specialist (${specialist}) not available on duty.`
        };
      }

      // 2. Compute Component Sub-Scores (Normalized 0.0 to 1.0)
      
      // Resource Fit (RF): Based on availability margin
      const totalRequested = (requiredBeds + requiredVents + requiredOT) || 1;
      const totalAvailable = 
        (requiredBeds ? hospital.resources.icuBeds.available : 0) +
        (requiredVents ? hospital.resources.ventilators.available : 0) +
        (requiredOT ? hospital.resources.emergencyOT.available : 0);
      const resourceFitScore = Math.min(1.0, 0.7 + (totalAvailable / (totalRequested * 5)));

      // Acceptance & Response Rate (AR):
      const acceptanceScore = hospital.acceptanceRate;

      // Critical Capacity (CC): Proportion of critical resources free
      const icuCap = hospital.resources.icuBeds.available / (hospital.resources.icuBeds.total || 1);
      const ventCap = hospital.resources.ventilators.available / (hospital.resources.ventilators.total || 1);
      const capacityScore = (icuCap + ventCap) / 2;

      // Distance Proximity (DP): Closer is higher (10km max reference)
      const distanceScore = Math.max(0.05, 1.0 - (hospital.distanceKm / 12.0));

      // 3. Multi-Factor Weighted Sum
      const finalScore = (
        (weights.resourceFit * resourceFitScore) +
        (weights.acceptanceRate * acceptanceScore) +
        (weights.criticalCapacity * capacityScore) +
        (weights.distanceProximity * distanceScore)
      ) * 100;

      return {
        ...hospital,
        suitabilityScore: Math.round(finalScore * 10) / 10,
        isEligible: true,
        breakdown: {
          resourceFit: Math.round(resourceFitScore * 100),
          acceptance: Math.round(acceptanceScore * 100),
          capacity: Math.round(capacityScore * 100),
          distance: Math.round(distanceScore * 100)
        }
      };
    })
    .sort((a, b) => b.suitabilityScore - a.suitabilityScore);
}
