// Roadside Accident Symptom-Based Triage & Hospital Recommendation Engine
// Operational Resource Matching & ATLS (Advanced Trauma Life Support) Triage Protocols

export const SYMPTOM_DATABASE = [
  {
    id: "unconscious",
    label: "😵 Unconscious / Unresponsive",
    keywords: ["unconscious", "unresponsive", "fainted", "passed out", "coma", "not responding", "knocked out", "lost consciousness", "blacked out", "not waking up"],
    severity: 1, // P1: Resuscitation
    emergencyCategory: "TRAUMA",
    requiredResources: ["icuBeds", "ventilators"],
    suggestedSpecialist: "traumaSurgeon",
    firstAid: "Check breathing and airway immediately. If breathing, do NOT move neck/spine unless airway is compromised. Never administer water or food to an unconscious person.",
    clinicalAlert: "High risk of airway compromise or traumatic intracranial hemorrhage."
  },
  {
    id: "severe_head_injury",
    label: "🧠 Severe Head Injury / Skull Bleed",
    keywords: ["head injury", "head trauma", "bleeding from ear", "bleeding from ears", "skull fracture", "concussion", "head bleed", "unequal pupils", "seizure after crash", "cracked helmet", "hit head"],
    severity: 1,
    emergencyCategory: "TRAUMA",
    requiredResources: ["icuBeds", "ventilators", "emergencyOT"],
    suggestedSpecialist: "neurologist",
    firstAid: "Keep neck and head completely still in neutral alignment. Do not wash or probe deep scalp wounds. Watch pupil symmetry and alert paramedics immediately.",
    clinicalAlert: "Suspected acute epidural/subdural hematoma requiring immediate neurosurgical evaluation."
  },
  {
    id: "arterial_bleeding",
    label: "🩸 Heavy Arterial Bleeding / Hemorrhage",
    keywords: ["heavy bleeding", "spurting blood", "profuse bleeding", "arterial bleed", "blood gushing", "deep laceration", "bleeding heavily", "blood pooling", "wound spurting", "artery cut"],
    severity: 1,
    emergencyCategory: "TRAUMA",
    requiredResources: ["emergencyOT", "icuBeds"],
    suggestedSpecialist: "traumaSurgeon",
    firstAid: "Apply direct, firm, continuous pressure with a clean cloth or sterile pad. If limb bleeding does not stop, apply a tourniquet 2-3 inches above wound (record time applied).",
    clinicalAlert: "Impending hemorrhagic shock; urgent surgical hemostasis and blood transfusion readiness required."
  },
  {
    id: "chest_impact",
    label: "🫀 Crushed Chest / Steering Wheel Impact",
    keywords: ["chest pain", "crushed chest", "steering wheel", "ribs crushed", "chest trauma", "blunt chest", "difficulty breathing from chest", "flail chest", "hit steering wheel", "airbag deployed"],
    severity: 1,
    emergencyCategory: "CARDIAC",
    requiredResources: ["icuBeds", "ventilators"],
    suggestedSpecialist: "cardiologist",
    firstAid: "Support victim in a semi-upright seated position if conscious to ease breathing. Loosen tight collar or clothing. Do not compress injured chest wall.",
    clinicalAlert: "Risk of myocardial contusion, tension pneumothorax, or aortic deceleration injury."
  },
  {
    id: "respiratory_arrest",
    label: "🫁 Airway Compromise / Gasping for Breath",
    keywords: ["cannot breathe", "gasping", "choking", "airway blocked", "suffocating", "severe asthma", "respiratory distress", "turning blue", "cyanosis", "stridor", "wheezing heavily"],
    severity: 1,
    emergencyCategory: "RESPIRATORY",
    requiredResources: ["icuBeds", "ventilators"],
    suggestedSpecialist: null,
    firstAid: "Ensure victim airway is clear. Gently sweep mouth only if a loose foreign object is visible. If not breathing, begin chest compressions immediately at 100-120 bpm.",
    clinicalAlert: "Acute respiratory failure; mechanical ventilation and intubation required upon arrival."
  },
  {
    id: "crushed_limb_fracture",
    label: "🦴 Crushed Limb / Open Compound Fracture",
    keywords: ["broken bone", "compound fracture", "bone sticking out", "crushed leg", "crushed arm", "fractured leg", "broken pelvis", "cannot move leg", "twisted leg", "deformed limb", "femur fracture"],
    severity: 2, // P2: Emergent
    emergencyCategory: "TRAUMA",
    requiredResources: ["emergencyOT"],
    suggestedSpecialist: "traumaSurgeon",
    firstAid: "Do not attempt to push exposed bone back into wound. Cover loosely with clean/sterile cloth. Immobilize the limb in position found using a splint or rolled jackets.",
    clinicalAlert: "Open orthopedic trauma requiring emergent debridement and orthopedic stabilization."
  },
  {
    id: "spinal_injury",
    label: "⚡ Suspected Spinal / Neck Injury",
    keywords: ["spine", "back pain", "neck injury", "cannot feel legs", "paralyzed", "numbness in limbs", "whiplash", "thrown off bike", "ejected from car", "tingling in fingers", "cannot move toes"],
    severity: 1,
    emergencyCategory: "TRAUMA",
    requiredResources: ["icuBeds", "emergencyOT"],
    suggestedSpecialist: "traumaSurgeon",
    firstAid: "CRITICAL: DO NOT MOVE OR TWIST THE PATIENT. Maintain head-neck-torso in complete inline alignment. Wait for EMS spine board.",
    clinicalAlert: "Potential unstable cervical or lumbar spine injury."
  },
  {
    id: "severe_burns",
    label: "🔥 Vehicle Fire / Severe Burn Injury",
    keywords: ["burn", "vehicle fire", "explosion", "burned skin", "charred", "chemical burn", "scalding", "fuel fire", "smoke inhalation", "singed eyebrows"],
    severity: 2,
    emergencyCategory: "TRAUMA",
    requiredResources: ["icuBeds", "ventilators"],
    suggestedSpecialist: "traumaSurgeon",
    firstAid: "Extinguish flames. Cool burns with clean running water (not iced water) for 15-20 minutes. Do not peel burned clothing stuck to skin. Cover with clean dry cloth.",
    clinicalAlert: "Thermal injury with high risk of smoke inhalation and fluid loss shock."
  },
  {
    id: "pediatric_victim",
    label: "👶 Pediatric / Child Accident Victim",
    keywords: ["child", "baby", "infant", "toddler", "kid", "little boy", "little girl", "pediatric"],
    severity: 2,
    emergencyCategory: "PEDIATRIC",
    requiredResources: ["icuBeds"],
    suggestedSpecialist: "pediatrician",
    firstAid: "Keep child calm, warm, and comforted. Avoid sudden movements. Maintain gentle head support. Reassure them that help is arriving.",
    clinicalAlert: "Pediatric physiological reserve depletes rapidly; pediatric emergency response required."
  },
  {
    id: "minor_injury",
    label: "🩹 Minor Abrasions / Conscious & Stable",
    keywords: ["minor cut", "scrape", "bruise", "mild pain", "abrasion", "sprain", "conscious and talking", "walking wounded", "small scratch"],
    severity: 4, // P4: Semi-Urgent
    emergencyCategory: "GENERAL",
    requiredResources: [],
    suggestedSpecialist: null,
    firstAid: "Wash surface dirt with clean water. Apply antiseptic dressing. Move safely off the roadway onto the shoulder away from active traffic.",
    clinicalAlert: "Low acuity trauma; standard emergency ward evaluation suitable."
  }
];

// Roadway Hotspots for quick testing & simulated roadside locations
export const ROADSIDE_HOTSPOTS = [
  {
    id: "HWY_44",
    name: "Highway 44 - Mile Marker 12 (Expressway Collision Zone)",
    address: "National Expressway 44, Mile 12, Northbound",
    lat: 28.6450,
    lng: 77.2300,
    landmark: "Near Northbound Overpass Exit 8"
  },
  {
    id: "RING_ROAD",
    name: "Outer Ring Road Junction & Flyover",
    address: "Outer Ring Road, South Flyover Pillar 42",
    lat: 28.6100,
    lng: 77.2000,
    landmark: "Under South Bypass Flyover"
  },
  {
    id: "METRO_CROSSING",
    name: "MG Road Metro Crossing & Boulevard",
    address: "MG Road, Intersection 3, Central Medical District",
    lat: 28.6250,
    lng: 77.2080,
    landmark: "Outside Metro Pillar 188"
  },
  {
    id: "TECH_CORRIDOR",
    name: "West Tech Park Bypass Expressway",
    address: "Tech Corridor Outer Link Road, Sector 62",
    lat: 28.6500,
    lng: 77.1700,
    landmark: "Opposite Tech Hub Gate 2"
  },
  {
    id: "OLD_TOWN",
    name: "Old Town Market Crossway",
    address: "Crossway 3, Old Town Heritage Zone",
    lat: 28.6320,
    lng: 77.2280,
    landmark: "Near Clock Tower Junction"
  }
];

/**
 * Calculates Haversine great-circle distance between two coordinates in kilometers.
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
    return 5.0; // Sensible default fallback
  }

  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 10) / 10;
}

/**
 * Updates hospital distances based on user's current roadside GPS location
 */
export function updateHospitalDistances(hospitals, userLat, userLng) {
  return hospitals.map(h => {
    let dist = h.distanceKm;
    if (h.coordinates && userLat != null && userLng != null) {
      dist = calculateHaversineDistance(userLat, userLng, h.coordinates.lat, h.coordinates.lng);
    }
    const estDriveMins = Math.max(3, Math.round(dist * 2.2 + 2));
    return {
      ...h,
      distanceKm: dist,
      estDriveMins
    };
  });
}

/**
 * Analyzes roadside accident symptoms from natural language text and selected symptom IDs.
 * Implements ATLS and Emergency Severity Index (ESI) resource matching.
 */
export function analyzeRoadsideSymptoms(inputText = "", selectedSymptomIds = []) {
  const normalizedText = (inputText || "").toLowerCase().trim();
  const matchedSymptomsMap = new Map();

  // 1. Keyword analysis against SYMPTOM_DATABASE
  SYMPTOM_DATABASE.forEach(symptom => {
    // Check if directly selected
    if (selectedSymptomIds.includes(symptom.id)) {
      matchedSymptomsMap.set(symptom.id, symptom);
      return;
    }

    // Check keyword matches in input text
    for (const kw of symptom.keywords) {
      if (normalizedText.includes(kw)) {
        matchedSymptomsMap.set(symptom.id, symptom);
        break;
      }
    }
  });

  const matchedSymptoms = Array.from(matchedSymptomsMap.values());

  // Fallback if no symptoms matched
  if (matchedSymptoms.length === 0) {
    return {
      matchedSymptoms: [],
      triageLevel: 4,
      triageName: "Level 4: Semi-Urgent",
      triageColor: "#3b82f6",
      emergencyType: "GENERAL",
      emergencyTitle: "General Roadside Assessment",
      requiredResources: {
        requiredBeds: 0,
        requiredVents: 0,
        requiredOT: 0,
        specialist: null
      },
      firstAidSteps: [
        "Ensure personal safety before approaching the accident site.",
        "Assess if the victim is conscious and breathing normally.",
        "Call emergency services (108 / 112) or select symptoms above for accurate routing."
      ],
      triageSummary: "No critical life-threatening symptoms flagged. General emergency evaluation recommended.",
      isCritical: false
    };
  }

  // 2. Compute minimum severity (1 is highest priority!)
  let lowestSeverity = 5;
  matchedSymptoms.forEach(s => {
    if (s.severity < lowestSeverity) {
      lowestSeverity = s.severity;
    }
  });

  // 3. Determine emergency category
  // Priority order: TRAUMA > CARDIAC > RESPIRATORY > PEDIATRIC > GENERAL
  const categoryPriority = ["TRAUMA", "CARDIAC", "RESPIRATORY", "PEDIATRIC", "GENERAL"];
  let chosenCategory = "GENERAL";
  for (const cat of categoryPriority) {
    if (matchedSymptoms.some(s => s.emergencyCategory === cat)) {
      chosenCategory = cat;
      break;
    }
  }

  // 4. Resolve aggregated required resources
  const allRequired = new Set();
  matchedSymptoms.forEach(s => {
    s.requiredResources.forEach(res => allRequired.add(res));
  });

  // Specialist resolution hierarchy
  const specialistRank = ["traumaSurgeon", "neurologist", "cardiologist", "pediatrician"];
  let chosenSpecialist = null;
  for (const spec of specialistRank) {
    if (matchedSymptoms.some(s => s.suggestedSpecialist === spec)) {
      chosenSpecialist = spec;
      break;
    }
  }

  // First-aid compilation (unique)
  const firstAidSteps = matchedSymptoms.map(s => s.firstAid);

  const triageNames = {
    1: "Level 1: Resuscitation (Immediate Life Threat)",
    2: "Level 2: Emergent (Critical Danger)",
    3: "Level 3: Urgent",
    4: "Level 4: Semi-Urgent",
    5: "Level 5: Non-Urgent"
  };

  const triageColors = {
    1: "var(--status-red)",
    2: "#f97316",
    3: "#eab308",
    4: "#3b82f6",
    5: "var(--status-green)"
  };

  const emergencyTitles = {
    TRAUMA: "Severe Polytrauma / Road Accident",
    CARDIAC: "Blunt Chest / Cardiac Emergency",
    RESPIRATORY: "Severe Airway / Respiratory Obstruction",
    PEDIATRIC: "Pediatric Emergency Shock",
    GENERAL: "General Roadside Injury"
  };

  const isCritical = lowestSeverity <= 2;

  // Build summary rationale
  const symptomLabels = matchedSymptoms.map(s => s.label).join(", ");
  const triageSummary = `Accident Triage: ${symptomLabels}. Categorized as ${triageNames[lowestSeverity]}. ${
    lowestSeverity === 1
      ? "OS Scheduling Preemption: Top priority queue placement required to eliminate mortality latency."
      : "Standard high-priority resource matching applied."
  }`;

  return {
    matchedSymptoms,
    triageLevel: lowestSeverity,
    triageName: triageNames[lowestSeverity],
    triageColor: triageColors[lowestSeverity],
    emergencyType: chosenCategory,
    emergencyTitle: emergencyTitles[chosenCategory] || "Emergency",
    requiredResources: {
      requiredBeds: allRequired.has("icuBeds") ? 1 : 0,
      requiredVents: allRequired.has("ventilators") ? 1 : 0,
      requiredOT: allRequired.has("emergencyOT") ? 1 : 0,
      specialist: chosenSpecialist
    },
    firstAidSteps,
    triageSummary,
    isCritical
  };
}

/**
 * Generates an operational plain-English reason explaining why the recommended hospital
 * was selected and highlights why closer hospitals (if any) were excluded or sub-optimal.
 */
export function generateHospitalRecommendationReason(topHospital, allRanked, requirements) {
  if (!topHospital || !topHospital.isEligible) {
    return {
      headline: "No Network Hospital Currently Meets Hard Constraints",
      details: "All regional hospitals have exceeded critical capacity or lack required surgical specialists. Contact regional EMS command for secondary diversion."
    };
  }

  // Find the closest hospital that was excluded despite being nearer
  const excludedCloser = allRanked
    .filter(h => !h.isEligible && h.distanceKm < topHospital.distanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const closerExcluded = excludedCloser.length > 0 ? excludedCloser[0] : null;

  let closerAlert = "";
  if (closerExcluded) {
    closerAlert = `⚠️ Note: ${closerExcluded.name} is closer (${closerExcluded.distanceKm} km), but was EXCLUDED: ${closerExcluded.exclusionReason} Taking the victim there would cause critical transfer delays.`;
  }

  const resourceHighlights = [];
  if (requirements.requiredOT > 0 && topHospital.resources.emergencyOT.available > 0) {
    resourceHighlights.push(`${topHospital.resources.emergencyOT.available} open Emergency OT(s)`);
  }
  if (requirements.requiredBeds > 0 && topHospital.resources.icuBeds.available > 0) {
    resourceHighlights.push(`${topHospital.resources.icuBeds.available} open ICU Bed(s)`);
  }
  if (requirements.specialist && topHospital.resources.specialists[requirements.specialist]) {
    const specName = requirements.specialist === "traumaSurgeon" ? "Trauma Surgeon" : requirements.specialist === "neurologist" ? "Neurologist" : requirements.specialist === "cardiologist" ? "Cardiologist" : "Pediatrician";
    resourceHighlights.push(`${specName} actively on duty`);
  }

  const headline = `Best Fit: ${topHospital.name} (${topHospital.distanceKm} km · ~${topHospital.estDriveMins || Math.round(topHospital.distanceKm * 2.2 + 2)} mins drive)`;
  const details = `${topHospital.name} is verified ready with ${resourceHighlights.join(", ") || "full operational capacity"} and ${Math.round(topHospital.acceptanceRate * 100)}% historic acceptance rate. ${closerAlert}`;

  return {
    headline,
    details,
    closerExcluded: closerExcluded || null
  };
}
