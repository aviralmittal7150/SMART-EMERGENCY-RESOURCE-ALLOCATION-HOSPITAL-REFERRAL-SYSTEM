// Triage Priority Queue & Resource Determination Engine (OS Priority Queue Logic)

export const TRIAGE_LEVELS = {
  1: { name: "Level 1: Resuscitation", color: "var(--status-red)", maxWaitMins: 0, preemptive: true },
  2: { name: "Level 2: Emergent", color: "#f97316", maxWaitMins: 10, preemptive: true },
  3: { name: "Level 3: Urgent", color: "#eab308", maxWaitMins: 30, preemptive: false },
  4: { name: "Level 4: Semi-Urgent", color: "#3b82f6", maxWaitMins: 60, preemptive: false },
  5: { name: "Level 5: Non-Urgent", color: "var(--status-green)", maxWaitMins: 120, preemptive: false }
};

export const EMERGENCY_PRESETS = {
  CARDIAC: {
    title: "Acute Coronary / Cardiac Arrest",
    defaultTriage: 1,
    required: ["icuBeds", "ventilators", "cardiologist"]
  },
  TRAUMA: {
    title: "Polytrauma / Road Accident",
    defaultTriage: 1,
    required: ["icuBeds", "emergencyOT", "traumaSurgeon"]
  },
  STROKE: {
    title: "Acute Ischemic / Hemorrhagic Stroke",
    defaultTriage: 2,
    required: ["icuBeds", "neurologist"]
  },
  RESPIRATORY: {
    title: "Severe Respiratory Distress / ARDS",
    defaultTriage: 2,
    required: ["icuBeds", "ventilators"]
  },
  PEDIATRIC: {
    title: "Pediatric Emergency Shock",
    defaultTriage: 2,
    required: ["icuBeds", "pediatrician"]
  },
  GENERAL: {
    title: "General Emergency",
    defaultTriage: 4,
    required: []
  }
};

/**
 * Priority Queue comparator for OS Scheduling
 * Returns negative if item A has higher priority (lower priority number, earlier timestamp)
 */
export function comparePriority(a, b) {
  if (a.priority !== b.priority) {
    return a.priority - b.priority; // Level 1 is highest priority
  }
  return new Date(a.requestTime) - new Date(b.requestTime); // FIFO tie-breaker
}
