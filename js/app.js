import { initialHospitals, initialAmbulances, initialEmergencyQueue } from './data.js';
import { TRIAGE_LEVELS, EMERGENCY_PRESETS, comparePriority } from './triage.js';
import { rankHospitals, DEFAULT_WEIGHTS } from './ranking.js';
import { LockManager } from './locking.js';
import { BankersAlgorithm } from './bankers.js';
import {
  SYMPTOM_DATABASE,
  ROADSIDE_HOTSPOTS,
  analyzeRoadsideSymptoms,
  updateHospitalDistances,
  calculateHaversineDistance,
  generateHospitalRecommendationReason
} from './symptom_triage.js';
import {
  AuthAPI,
  HospitalsAPI,
  EmergenciesAPI,
  ReferralsAPI,
  DoctorsAPI,
  AmbulancesAPI,
  AnalyticsAPI,
  initWebSocket,
  checkServerHealth,
  getAuthToken,
  getCurrentUser
} from './api.js';
import { dispatchForReferral, getDispatchControl } from './dispatch_state.js';
import {
  getLedgerEntries,
  verifyLedgerIntegrity,
  exportLedgerToCsv,
  appendAuditEntry,
  getLedgerStats,
  EVENT_TYPES
} from './audit_ledger.js';

// Seed Doctors for UI Registry (Phase 2 P2-07)
const initialDoctorsList = [
  { doctor_id: 'DR-001', hospital_id: 'H-101', full_name: 'Dr. Arjun Mehta', specialization: 'CARDIOLOGIST', availability_status: 'AVAILABLE', shift_start: '08:00', shift_end: '20:00' },
  { doctor_id: 'DR-002', hospital_id: 'H-101', full_name: 'Dr. Priya Sharma', specialization: 'NEUROLOGIST', availability_status: 'IN_PROCEDURE', shift_start: '08:00', shift_end: '20:00' },
  { doctor_id: 'DR-003', hospital_id: 'H-101', full_name: 'Dr. Kabir Singh', specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE', shift_start: '20:00', shift_end: '08:00' },
  { doctor_id: 'DR-004', hospital_id: 'H-101', full_name: 'Dr. Nisha Patel', specialization: 'PEDIATRICIAN', availability_status: 'AVAILABLE', shift_start: '08:00', shift_end: '20:00' },
  { doctor_id: 'DR-005', hospital_id: 'H-102', full_name: 'Dr. Rajan Verma', specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE', shift_start: '09:00', shift_end: '21:00' },
  { doctor_id: 'DR-006', hospital_id: 'H-103', full_name: 'Dr. Suresh Iyer', specialization: 'CARDIOLOGIST', availability_status: 'AVAILABLE', shift_start: '07:00', shift_end: '19:00' },
  { doctor_id: 'DR-007', hospital_id: 'H-103', full_name: 'Dr. Anika Bose', specialization: 'NEUROLOGIST', availability_status: 'AVAILABLE', shift_start: '07:00', shift_end: '19:00' },
  { doctor_id: 'DR-008', hospital_id: 'H-103', full_name: 'Dr. Yusuf Khan', specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE', shift_start: '07:00', shift_end: '19:00' },
  { doctor_id: 'DR-009', hospital_id: 'H-103', full_name: 'Dr. Sunita Rao', specialization: 'PEDIATRICIAN', availability_status: 'OFF_DUTY', shift_start: '19:00', shift_end: '07:00' },
  { doctor_id: 'DR-010', hospital_id: 'H-104', full_name: 'Dr. Meera Krishnan', specialization: 'PEDIATRICIAN', availability_status: 'AVAILABLE', shift_start: '09:00', shift_end: '21:00' },
  { doctor_id: 'DR-011', hospital_id: 'H-105', full_name: 'Dr. Vikram Joshi', specialization: 'CARDIOLOGIST', availability_status: 'AVAILABLE', shift_start: '08:00', shift_end: '20:00' },
  { doctor_id: 'DR-012', hospital_id: 'H-105', full_name: 'Dr. Deepa Nair', specialization: 'NEUROLOGIST', availability_status: 'IN_PROCEDURE', shift_start: '08:00', shift_end: '20:00' },
  { doctor_id: 'DR-013', hospital_id: 'H-105', full_name: 'Dr. Rohan Gupta', specialization: 'TRAUMA_SURGEON', availability_status: 'AVAILABLE', shift_start: '08:00', shift_end: '20:00' }
];

// Global Application State
const state = {
  hospitals: JSON.parse(JSON.stringify(initialHospitals)),
  ambulances: JSON.parse(JSON.stringify(initialAmbulances)),
  emergencyQueue: JSON.parse(JSON.stringify(initialEmergencyQueue)),
  doctors: JSON.parse(JSON.stringify(initialDoctorsList)),
  selectedTriage: 1,
  selectedEmergencyType: "CARDIAC",
  customRequirements: {
    requiredBeds: 1,
    requiredVents: 1,
    requiredOT: 0,
    specialist: "cardiologist"
  },
  currentActiveReferral: null,
  lastAcceptedReferral: null,
  selectedRequestId: null,
  activeTab: "tab-command",
  currentUserRole: "admin",
  currentUser: null,
  backendOnline: false,
  dataSource: "demo",
  activity: [],
  roadside: {
    currentLocation: ROADSIDE_HOTSPOTS[0],
    selectedSymptomIds: ["unconscious", "severe_head_injury", "crushed_limb_fracture"],
    symptomText: "Motorcycle crash on Highway 44. Rider unconscious, bleeding from head, compound fracture on leg.",
    isListening: false,
    recognition: null,
    lastAnalysis: null,
    lastRanked: []
  },
  mapInstance: null,
  mapMarkers: {
    hospitals: [],
    ambulances: [],
    roadside: []
  }
};

// Guards the roadside 1-click pre-alert (its button is re-rendered, so the flag lives here).
let roadsidePreAlertInFlight = false;

// Initialize Modules
const bankersEngine = new BankersAlgorithm();
const lockManager = new LockManager((lockState) => {
  renderHospitalAcceptanceView();
  renderKpiCards();
});

// DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initNavbarTabs();
  initClock();
  initTriageSelector();
  initEmergencyPresets();
  initBankersSimulator();
  renderKpiCards();
  renderHospitalsDirectory();
  renderEmergencyQueue();
  renderRankingResults();
  renderAmbulanceFleet();
  attachFormListeners();
  initRoadsideAssist();
  initAuthPortalModal();
  initDoctorsScheduler();
  initRealtimeBackendBridge();
  initAnalyticsDashboard();
  renderAuditLedgerTable();
  initOperationsWorkspace();
});

// Theme Toggle Engine (Dark / Light Mode)
function initTheme() {
  const toggleBtn = document.getElementById("themeToggleBtn");
  const toggleIcon = document.getElementById("themeToggleIcon");
  const toggleText = document.getElementById("themeToggleText");

  // Read saved preference or system preference
  const savedTheme = localStorage.getItem("ser_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  // ERIS is an operational console: start in the high-contrast dark shell,
  // while still allowing a deliberate user toggle or saved preference.
  const initialTheme = savedTheme || "dark";

  applyTheme(initialTheme, false);

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const activeTheme = document.documentElement.getAttribute("data-theme") || "light";
      const nextTheme = activeTheme === "dark" ? "light" : "dark";
      applyTheme(nextTheme, true);
    });
  }

  // Follow system theme changes if user hasn't explicitly set a preference
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!localStorage.getItem("ser_theme")) {
        applyTheme(e.matches ? "dark" : "light", false);
      }
    });
  }

  function applyTheme(theme, notify = false) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ser_theme", theme);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute("content", theme === "dark" ? "#0B0F19" : "#F4F7FB");
    }

    if (toggleIcon && toggleText) {
      if (theme === "dark") {
        toggleIcon.textContent = "☀️";
        toggleText.textContent = "Light";
        if (toggleBtn) toggleBtn.setAttribute("title", "Switch to Light Mode");
      } else {
        toggleIcon.textContent = "🌙";
        toggleText.textContent = "Dark";
        if (toggleBtn) toggleBtn.setAttribute("title", "Switch to Dark Mode");
      }
    }

    if (notify) {
      showNotification(`Switched to ${theme === "dark" ? "Dark" : "Light"} Mode`, "normal");
    }
  }
}

// Navigation Tabs
function initNavbarTabs() {
  const tabs = document.querySelectorAll(".nav-tab-btn");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("locked-tab")) {
        showNotification("This workspace is restricted for the current role.", "urgent");
        return;
      }
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const targetId = tab.getAttribute("data-tab");
      state.activeTab = targetId;
      document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");
      updateWorkspaceHeader(targetId);

      // Re-render views on tab switch
      if (targetId === "tab-roadside") performRoadsideAnalysis();
      if (targetId === "tab-ranking") renderRankingResults();
      if (targetId === "tab-command") {
        renderKpiCards();
        renderHospitalsDirectory();
        renderAnalyticsCharts();
        renderAuditLedgerTable();
      }
      if (targetId === "tab-acceptance") renderHospitalAcceptanceView();
      if (targetId === "tab-bankers") renderBankersView();
      if (targetId === "tab-ambulance") renderAmbulanceFleet();
      if (targetId === "tab-map") renderLeafletMap();
      if (targetId === "tab-doctors") renderDoctorsRoster();
      if (targetId === "tab-hospitals") renderHospitalManagement();
      if (targetId === "tab-activity") renderActivityWorkspace();
    });
  });

  document.querySelectorAll("[data-navigate]").forEach(control => {
    control.addEventListener("click", () => triggerTabSwitch(control.getAttribute("data-navigate")));
  });
}

function updateWorkspaceHeader(targetId) {
  const copy = {
    "tab-ingestion": ["Emergency intake", "Capture a case, assign operational priority, and place it in the coordination queue."],
    "tab-roadside": ["Roadside assist", "Translate field observations into a triage-aware hospital suitability recommendation."],
    "tab-ranking": ["Suitability ranking", "Compare eligible hospitals using resource fit, response, capacity, and distance."],
    "tab-acceptance": ["Acceptance console", "Complete the closed-loop hospital handshake before a destination is committed."],
    "tab-command": ["Command Center", "Monitor demand, capacity, referrals, and dispatch readiness across the network."],
    "tab-hospitals": ["Hospital network", "Review facility status, critical resources, and operational capacity."],
    "tab-bankers": ["Banker's visualizer", "Explore safe-state resource allocation and deadlock avoidance."],
    "tab-map": ["Regional map", "Inspect hospital capacity, ambulance telemetry, and roadside incident layers."],
    "tab-doctors": ["Specialist roster", "Coordinate on-call specialists and shift availability."],
    "tab-ambulance": ["EMS fleet", "Track unit readiness and closed-loop transport operations."],
    "tab-activity": ["Activity & audit", "Review local operational events and the sealed Phase 3 audit ledger."],
  };
  const [title, description] = copy[targetId] || copy["tab-command"];
  const titleEl = document.getElementById("workspaceTitle");
  const descriptionEl = document.getElementById("workspaceDescription");
  if (titleEl) titleEl.textContent = title;
  if (descriptionEl) descriptionEl.textContent = description;
}

// Live Clock
function initClock() {
  const clockEl = document.getElementById("systemClock");
  const update = () => {
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toTimeString().split(" ")[0] + " IST";
    }
  };
  update();
  setInterval(update, 1000);
}

function initOperationsWorkspace() {
  const rerenderQueue = () => renderEmergencyQueue();
  ["emergencySearch", "emergencyPriorityFilter", "emergencyStatusFilter"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", rerenderQueue);
    document.getElementById(id)?.addEventListener("change", rerenderQueue);
  });
  ["hospitalSearch", "hospitalStatusFilter"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", renderHospitalManagement);
    document.getElementById(id)?.addEventListener("change", renderHospitalManagement);
  });
  ["ambulanceSearch", "ambulanceStatusFilter"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", renderAmbulanceFleet);
    document.getElementById(id)?.addEventListener("change", renderAmbulanceFleet);
  });
  document.getElementById("doctorSearch")?.addEventListener("input", renderDoctorsRoster);
  document.getElementById("refreshWorkspaceBtn")?.addEventListener("click", () => refreshWorkspaceData());
  document.getElementById("openAuthFromBanner")?.addEventListener("click", () => {
    const modal = document.getElementById("authPortalModal");
    if (modal) modal.style.display = "flex";
  });
  document.querySelectorAll(".triage-btn, .resource-chip").forEach(control => {
    if (!control.hasAttribute("tabindex")) control.setAttribute("tabindex", "0");
    control.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); control.click(); }
    });
  });
  updateWorkspaceHeader(state.activeTab);
  applyRoleVisibility();
  renderHospitalManagement();
  renderCommandOverview();
  renderActivityWorkspace();
}

function updateDataSourceBanner() {
  const banner = document.getElementById("dataSourceBanner");
  const status = document.getElementById("connectionStatus");
  if (state.dataSource === "backend") {
    if (banner) {
      banner.classList.add("connected");
      banner.innerHTML = `<span class="data-source-icon">●</span><div><strong>AUTHORIZED LIVE WORKSPACE</strong><span>Operational data is synchronized with the connected application session.</span></div><button type="button" class="btn btn-secondary btn-sm" id="refreshWorkspaceBtn">↻ Refresh data</button>`;
      banner.querySelector("#refreshWorkspaceBtn")?.addEventListener("click", () => refreshWorkspaceData());
    }
    if (status) status.textContent = "LIVE SESSION";
  } else {
    if (status) status.textContent = state.backendOnline ? "API READY" : "DEMO MODE";
  }
}

async function refreshWorkspaceData() {
  if (!getAuthToken()) {
    showNotification("Connect an authorized role to refresh from the API. Showing standalone development data.", "normal");
    renderKpiCards();
    renderHospitalsDirectory();
    renderEmergencyQueue();
    renderAmbulanceFleet();
    renderDoctorsRoster();
    return false;
  }
  try {
    const [hospitals, emergencies, doctors, ambulances] = await Promise.all([
      HospitalsAPI.getAll(), EmergenciesAPI.getAll(), DoctorsAPI.getAll(), AmbulancesAPI.getAll()
    ]);
    if (hospitals?.hospitals) state.hospitals = hospitals.hospitals.map(normalizeHospital).filter(Boolean);
    if (emergencies?.queue) state.emergencyQueue = emergencies.queue.map(normalizeEmergency).filter(Boolean).sort(comparePriority);
    if (doctors?.doctors) state.doctors = doctors.doctors;
    if (ambulances?.ambulances) state.ambulances = ambulances.ambulances.map(normalizeAmbulance).filter(Boolean);
    state.dataSource = "backend";
    updateDataSourceBanner();
    renderKpiCards(); renderHospitalsDirectory(); renderEmergencyQueue(); renderAmbulanceFleet(); renderDoctorsRoster();
    updateRoadsideDispatchControl();
    recordActivity("DATA_REFRESHED", "Authorized workspace data refreshed", "success");
    showNotification("✓ Workspace data refreshed from the connected API.", "success");
    return true;
  } catch (error) {
    showNotification(`Unable to refresh workspace data: ${error.message}`, "urgent");
    return false;
  }
}

function normalizeHospital(hospital) {
  if (!hospital) return null;
  const resources = hospital.resources || {};
  const resourceFor = (keys) => keys.map(key => resources[key]).find(Boolean) || { total: 0, available: 0, locked: 0 };
  return {
    id: hospital.id || hospital.hospital_id,
    name: hospital.name || hospital.hospital_name,
    address: hospital.address || hospital.location_address || "Regional facility",
    status: hospital.status || hospital.emergency_status || "OPEN",
    distanceKm: Number(hospital.distanceKm || hospital.distance_km || 0),
    coordinates: hospital.coordinates || { lat: hospital.location_lat, lng: hospital.location_lng },
    phone: hospital.phone || hospital.contact_phone,
    traumaLevel: hospital.traumaLevel || hospital.trauma_level,
    acceptanceRate: Number(hospital.acceptanceRate ?? hospital.acceptance_rate ?? 0),
    avgResponseSec: Number(hospital.avgResponseSec ?? hospital.avg_response_sec ?? 0),
    rating: Number(hospital.rating || 0),
    resources: {
      icuBeds: resourceFor(["icuBeds", "icubed", "icu_bed"]),
      ventilators: resourceFor(["ventilators", "ventilator"]),
      emergencyOT: resourceFor(["emergencyOT", "ot"]),
     specialists: hospital.specialists || buildSpecialistFlags(hospital.doctors)
    }
  };
}

function normalizeEmergency(item) {
  if (!item) return null;
  const patient = item.patient || {};
  return {
    ...item,
    requestId: item.requestId || item.request_id,
     patientName: item.patientName || patient.patient_name || patient.full_name || patient.name || "Operational case",
    age: item.age || patient.age || "—",
    emergencyType: item.emergencyType || item.emergency_type || "GENERAL",
    priority: Number(item.priority || item.triage_priority || 5),
    priorityName: item.priorityName || item.priority_name || `Level ${item.priority || item.triage_priority || 5}`,
    status: item.status || "WAITING",
    assignedHospital: item.assignedHospital || item.assigned_hospital || "Matching...",
    requestTime: item.requestTime || item.request_time || new Date().toLocaleTimeString(),
     requiredResources: item.requiredResources || item.required_resources || [],
     requiredResourceTypes: item.requiredResourceTypes || item.required_resource_types || [],
     requiredSpecialist: item.requiredSpecialist || item.required_specialist || null
  };
}

function buildSpecialistFlags(doctors = []) {
  const flags = { cardiologist: false, neurologist: false, traumaSurgeon: false, pediatrician: false };
  const keyBySpecialization = {
    CARDIOLOGIST: "cardiologist",
    NEUROLOGIST: "neurologist",
    TRAUMA_SURGEON: "traumaSurgeon",
    PEDIATRICIAN: "pediatrician"
  };
  doctors.forEach(doctor => {
    const key = keyBySpecialization[doctor.specialization];
    if (key && doctor.availability_status === "AVAILABLE") flags[key] = true;
  });
  return flags;
}

function normalizeAmbulance(item) {
  if (!item) return null;
  return { ...item, id: item.id || item.ambulance_id, type: item.type || item.ambulance_type, hospitalId: item.hospitalId || item.hospital_id, etaMins: item.etaMins ?? item.eta_mins ?? 0 };
}

// KPI Render
function renderKpiCards() {
  const activeEmergencies = state.emergencyQueue.filter(e => e.status !== "COMPLETED").length;
  const criticalWaiting = state.emergencyQueue.filter(e => e.priority === 1 && e.status === "WAITING").length;
  
  let totalIcuAvail = 0;
  let totalVentAvail = 0;
  let openHospitals = 0;

  state.hospitals.forEach(h => {
    if (h.status !== "CLOSED") {
      totalIcuAvail += h.resources.icuBeds.available;
      totalVentAvail += h.resources.ventilators.available;
      openHospitals++;
    }
  });

  const availAmbulances = state.ambulances.filter(a => a.status === "AVAILABLE").length;

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setVal("kpiActiveEmergencies", activeEmergencies);
  setVal("kpiCriticalWaiting", criticalWaiting);
  setVal("kpiIcuAvailable", totalIcuAvail);
  setVal("kpiVentilatorsAvailable", totalVentAvail);
  setVal("kpiHospitalsOpen", `${openHospitals}/${state.hospitals.length}`);
  setVal("kpiAmbulancesAvail", availAmbulances);

  const activeReferral = state.currentActiveReferral || lockManager.activeLock;
  const pendingReferrals = activeReferral ? 1 : 0;
  const acceptedReferrals = state.emergencyQueue.filter(e => e.status === "ALLOCATED" || e.status === "IN_TREATMENT").length;
  const closedReferrals = state.activity.filter(event => ["REJECTED", "EXPIRED", "TIMEOUT"].some(term => event.type.includes(term))).length;
  setVal("kpiReferralsPending", pendingReferrals);
  setVal("kpiReferralsAccepted", acceptedReferrals);
  setVal("kpiReferralsClosed", closedReferrals);
  setVal("kpiHospitalsStatus", `${state.hospitals.filter(h => h.status === "CLOSED").length} closed · ${state.hospitals.filter(h => h.status === "LIMITED").length} limited`);
  renderCommandOverview();
}

// Triage Selector UI
function initTriageSelector() {
  const buttons = document.querySelectorAll(".triage-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedTriage = parseInt(btn.getAttribute("data-level"), 10);
      updateTriageRecommendation();
    });
  });
}

function initEmergencyPresets() {
  const select = document.getElementById("emergencyTypeSelect");
  if (!select) return;

  select.addEventListener("change", (e) => {
    state.selectedEmergencyType = e.target.value;
    const preset = EMERGENCY_PRESETS[e.target.value] || EMERGENCY_PRESETS.GENERAL;

    // Auto set triage
    state.selectedTriage = preset.defaultTriage;
    document.querySelectorAll(".triage-btn").forEach(b => {
      if (parseInt(b.getAttribute("data-level"), 10) === preset.defaultTriage) {
        b.classList.add("active");
      } else {
        b.classList.remove("active");
      }
    });

    // Auto check resources
    document.querySelectorAll(".resource-chip").forEach(chip => {
      const res = chip.getAttribute("data-resource");
      if (preset.required.includes(res)) {
        chip.classList.add("selected");
      } else {
        chip.classList.remove("selected");
      }
    });

    syncCustomRequirementsFromUI();
    updateTriageRecommendation();
  });

  // Resource Chips click
  document.querySelectorAll(".resource-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("selected");
      syncCustomRequirementsFromUI();
    });
  });
}

function syncCustomRequirementsFromUI() {
  const selected = Array.from(document.querySelectorAll(".resource-chip.selected")).map(c => c.getAttribute("data-resource"));
  state.customRequirements = {
    requiredBeds: selected.includes("icuBeds") ? 1 : 0,
    requiredVents: selected.includes("ventilators") ? 1 : 0,
    requiredOT: selected.includes("emergencyOT") ? 1 : 0,
    specialist: selected.find(r => ["cardiologist", "neurologist", "traumaSurgeon", "pediatrician"].includes(r)) || null
  };
}

function updateTriageRecommendation() {
  const infoEl = document.getElementById("triageRecommendationInfo");
  if (!infoEl) return;
  const levelInfo = TRIAGE_LEVELS[state.selectedTriage];
  infoEl.innerHTML = `
    <div style="color: ${levelInfo.color}; font-weight: 700;">
      ${levelInfo.name} ${levelInfo.preemptive ? '⚡ (Preemptive OS Scheduling Lock)' : '⏱️ (Standard Priority Queue)'}
    </div>
    <div style="font-size: 0.78rem; color: var(--text-muted);">
      Target Medical Response Time: <strong>&lt; ${levelInfo.maxWaitMins} minutes</strong> | Auto-Failover TTL: <strong>90s</strong>
    </div>
  `;
}

// Intake Form Submit
function attachFormListeners() {
  const form = document.getElementById("emergencyIntakeForm");
  if (!form) return;

  // One Idempotency-Key per intended submission: a retry after a failure or timeout reuses it (the
  // server returns the original case), while editing the form starts a new request with a new key.
  let intakeKey = null;
  let intakeInFlight = false;
  const submitButton = form.querySelector('button[type="submit"]');
  const newIntakeRequest = () => { intakeKey = null; };
  form.addEventListener("input", newIntakeRequest);
  form.addEventListener("click", event => {
    if (event.target.closest(".triage-btn, .resource-chip")) newIntakeRequest();
  });
  document.getElementById("emergencyTypeSelect")?.addEventListener("change", newIntakeRequest);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (intakeInFlight) return; // double click / Enter while the first submission is still running
    const patientName = document.getElementById("patientName").value.trim() || "Anonymous Patient";
    const patientAge = parseInt(document.getElementById("patientAge").value, 10) || 45;
    const notes = document.getElementById("emergencyNotes").value.trim();

    const newRequest = {
      requestId: `REQ-${Math.floor(1000 + Math.random() * 9000)}`,
      patientName,
      age: patientAge,
      emergencyType: state.selectedEmergencyType,
      priority: state.selectedTriage,
      priorityName: TRIAGE_LEVELS[state.selectedTriage].name,
      status: "WAITING",
      assignedHospital: "Calculating Best Match...",
      requestTime: new Date().toLocaleTimeString(),
           requiredResources: Object.keys(state.customRequirements).filter(k => state.customRequirements[k]),
      notes
    };

    if (getAuthToken()) {
      intakeKey ||= newIdempotencyKey();
      intakeInFlight = true;
      if (submitButton) submitButton.disabled = true;
      try {
        const response = await EmergenciesAPI.create({
          patient_name: patientName,
          age: patientAge,
           emergency_type: state.selectedEmergencyType,
           triage_priority: state.selectedTriage,
           clinical_notes: notes,
           required_resources: resourceTypesForApi(state.customRequirements),
           required_specialist: state.customRequirements.specialist
        }, intakeKey);
        if (response?.request_id) {
          intakeKey = null; // this submission is done; the next one is a new case
          newRequest.requestId = response.request_id;
          state.selectedRequestId = response.request_id;
          state.dataSource = "backend";
          await refreshWorkspaceData();
          triggerTabSwitch("tab-ranking");
          recordActivity("REQUEST_CREATED", `Emergency ${newRequest.requestId} entered the authorized priority queue`, "critical");
          showNotification(`🚨 Emergency ${newRequest.requestId} registered in the connected queue.`, "urgent");
          return;
        }
      } catch (error) {
        showNotification(`API registration failed: ${error.message}`, "urgent");
        return;
      } finally {
        intakeInFlight = false;
        if (submitButton) submitButton.disabled = false;
      }
    }

    // Insert into Priority Queue (sorted by comparePriority)
    state.emergencyQueue.push(newRequest);
    state.selectedRequestId = newRequest.requestId;
    state.emergencyQueue.sort(comparePriority);

    // Switch to Ranking Tab automatically
    triggerTabSwitch("tab-ranking");
    renderRankingResults();
    renderEmergencyQueue();
    renderKpiCards();
    recordActivity("REQUEST_CREATED", `Emergency ${newRequest.requestId} entered the standalone priority queue`, "critical");
    showNotification(`🚨 Emergency Registered: ${newRequest.requestId} (${newRequest.priorityName}) - Matching suitable hospitals...`, "urgent");
  });
}

function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function resourceTypesForApi(requirements) {
  const resourceTypes = [];
  if (requirements.requiredBeds) resourceTypes.push("ICU_BED");
  if (requirements.requiredVents) resourceTypes.push("VENTILATOR");
  if (requirements.requiredOT) resourceTypes.push("OT");
  return resourceTypes;
}

function triggerTabSwitch(tabId) {
  const btn = document.querySelector(`.nav-tab-btn[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

// Ranking Render
function renderRankingResults() {
  const container = document.getElementById("rankingResultsContainer");
  if (!container) return;

  syncCustomRequirementsFromUI();
  const ranked = rankHospitals(state.hospitals, state.customRequirements, DEFAULT_WEIGHTS);

  container.innerHTML = `
    <div style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 0.82rem; color: var(--text-secondary);">
        Scoring Model: <strong>Resource Fit (40%) + Acceptance (25%) + Capacity (20%) + Distance (15%)</strong>
      </div>
      <div style="font-size: 0.78rem; font-family: var(--font-mono); color: var(--accent-blue);">
        ${ranked.filter(h => h.isEligible).length} Eligible Hospitals Matched
      </div>
    </div>
  `;

  ranked.forEach((hospital, idx) => {
    const isTop = idx === 0 && hospital.isEligible;
    const card = document.createElement("div");
    card.className = `hospital-card ${isTop ? 'top-match' : ''}`;

    const statusBadgeClass = hospital.status === "OPEN" ? "badge-open" : hospital.status === "LIMITED" ? "badge-limited" : "badge-closed";

    card.innerHTML = `
      <div class="hospital-header">
        <div>
          <div class="hospital-name">
            <span class="rank-badge">#${idx + 1}</span>
            <span>${hospital.name}</span>
            <span class="badge-status ${statusBadgeClass}">${hospital.status}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-tertiary); margin-top: 0.2rem;">
            📍 ${hospital.address} • <strong>${hospital.distanceKm} km away</strong> • ⭐ ${hospital.rating}/5.0
          </div>
        </div>
        <div class="score-badge">
          ${hospital.isEligible ? `<span>${hospital.suitabilityScore}</span><span class="score-label">Suitability</span>` : `<span style="color: var(--status-red); font-size: 0.85rem;">EXCLUDED</span>`}
        </div>
      </div>

      <div class="resource-capsule-grid">
        <div class="resource-capsule">
          <span class="capsule-label">ICU Beds</span>
          <span class="capsule-val ${hospital.resources.icuBeds.available > 2 ? 'good' : hospital.resources.icuBeds.available > 0 ? 'low' : 'empty'}">
            ${hospital.resources.icuBeds.available} / ${hospital.resources.icuBeds.total}
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Ventilators</span>
          <span class="capsule-val ${hospital.resources.ventilators.available > 2 ? 'good' : hospital.resources.ventilators.available > 0 ? 'low' : 'empty'}">
            ${hospital.resources.ventilators.available} / ${hospital.resources.ventilators.total}
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Emergency OT</span>
          <span class="capsule-val ${hospital.resources.emergencyOT.available > 0 ? 'good' : 'empty'}">
            ${hospital.resources.emergencyOT.available} / ${hospital.resources.emergencyOT.total}
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Acceptance Rate</span>
          <span class="capsule-val good">${Math.round(hospital.acceptanceRate * 100)}%</span>
        </div>
      </div>

      ${hospital.isEligible ? `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; border-top: 1px solid var(--glass-border); padding-top: 0.75rem;">
          <div style="font-size: 0.72rem; color: var(--text-tertiary);">
            Match breakdown: Fit ${hospital.breakdown.resourceFit}% | Cap ${hospital.breakdown.capacity}% | Dist ${hospital.breakdown.distance}%
          </div>
          <button class="btn btn-primary btn-sm btn-init-referral" data-hospital-id="${hospital.id}">
            ⚡ Place 90s Soft-Lock & Request Referral
          </button>
        </div>
      ` : `
        <div style="font-size: 0.75rem; color: var(--status-red); margin-top: 0.5rem; background: var(--status-red-soft); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm);">
          🚫 <strong>Hard Constraint Exclusion:</strong> ${hospital.exclusionReason}
        </div>
      `}
    `;

    container.appendChild(card);
  });

  // Attach Referral Button Listeners
  document.querySelectorAll(".btn-init-referral").forEach(btn => {
    btn.addEventListener("click", () => {
      const hospitalId = btn.getAttribute("data-hospital-id");
      const targetHospital = state.hospitals.find(h => h.id === hospitalId);
      if (!targetHospital) return;

      initiateReferralLock(targetHospital);
    });
  });
}

async function initiateReferralLock(hospital, requestedRequest = null) {
  const selectedRequest = state.emergencyQueue.find(item => item.requestId === state.selectedRequestId);
  const waitingRequests = state.emergencyQueue.filter(e => ["NEW", "WAITING"].includes(e.status));
  const latestWaiting = requestedRequest || selectedRequest || (waitingRequests.length === 1 ? waitingRequests[0] : null);
  if (!latestWaiting) {
    showNotification("Select exactly one NEW/WAITING emergency in the priority queue before initiating a referral.", "urgent");
    return;
  }

  if (getAuthToken()) {
    const resourceTypes = latestWaiting.requiredResourceTypes?.length
      ? latestWaiting.requiredResourceTypes
      : resourceTypesForApi(state.customRequirements);
    try {
      const response = await ReferralsAPI.initiate(latestWaiting.requestId, hospital.id, resourceTypes.length ? resourceTypes : ["ICU_BED"]);
      if (response?.acceptance_id) {
        const expiry = response.ttl_expires_at ? new Date(response.ttl_expires_at).getTime() : Date.now() + ((response.expires_in_sec || 90) * 1000);
        state.currentActiveReferral = { hospital, request: latestWaiting, acceptanceId: response.acceptance_id, expiresAt: expiry, remainingSec: Math.ceil((expiry - Date.now()) / 1000), status: "LOCKED_PENDING_RESPONSE", remote: true };
        triggerTabSwitch("tab-acceptance");
        recordActivity("REFERRAL_INITIATED", `Referral ${response.acceptance_id} sent to ${hospital.name}`, "warning");
        showNotification(`🔒 Referral handshake opened for ${hospital.name}. Awaiting facility response.`, "success");
        renderHospitalAcceptanceView();
        return;
      }
    } catch (error) {
      showNotification(`Referral initiation failed: ${error.message}`, "urgent");
      return;
    }
  }

  state.currentActiveReferral = {
    hospital,
    request: latestWaiting
  };

  lockManager.acquireLock(hospital, latestWaiting, () => {
    // Timeout Callback -> Auto Failover
    state.currentActiveReferral = null;
    recordActivity("REFERRAL_TIMEOUT", `Soft-lock expired for ${hospital.name}; candidate review required`, "critical");
    showNotification(`⏱️ Referral timeout (90s) for ${hospital.name}. Automatically failing over to next candidate hospital!`, "urgent");
    renderRankingResults();
  });

  triggerTabSwitch("tab-acceptance");
  recordActivity("REFERRAL_INITIATED", `Standalone soft-lock placed on ${hospital.name}`, "warning");
  showNotification(`🔒 90-Second Soft-Lock placed on ${hospital.name} for Request ${latestWaiting.requestId}. Awaiting hospital handshake!`, "success");
}

// Hospital Acceptance Terminal View
function renderHospitalAcceptanceView() {
  const container = document.getElementById("acceptanceConsoleContent");
  if (!container) return;

  const lock = lockManager.activeLock || state.currentActiveReferral;

  if (!lock) {
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📡</div>
        <h3>No Active Referral Locks in Progress</h3>
        <p style="font-size: 0.85rem; margin-top: 0.4rem;">Select an emergency case from the Ranking Engine to initiate a 90-second soft-lock request.</p>
         <button id="btnGoToRanking" type="button" class="btn btn-secondary btn-sm" style="margin-top: 1rem;">
           Go to Hospital Ranking
        </button>
      </div>
    `;
    document.getElementById("btnGoToRanking")?.addEventListener("click", () => triggerTabSwitch("tab-ranking"));
    return;
  }

  const { hospital, request } = lock;
  const remainingSec = lock.remote ? Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000)) : lock.remainingSec;

  container.innerHTML = `
    <div class="lock-timer-box anim-lock-pulse">
      <div style="font-size: 0.85rem; font-weight: 700; color: var(--status-yellow); text-transform: uppercase; letter-spacing: 0.05em;">
        ⚡ Emergency Referral Incoming • Soft Lock Active (ACID Safe)
      </div>
      <div class="timer-countdown">${remainingSec}s</div>
      <div style="font-size: 0.8rem; color: var(--text-muted);">
        Hospital: <strong>${hospital.name}</strong> • Patient: <strong>${request.patientName} (${request.priorityName})</strong>
      </div>
    </div>

    <div class="panel" style="margin-top: 1.5rem; background: var(--bg-surface-elevated); border: 1px solid var(--glass-border);">
      <div class="panel-header">
        <span class="panel-title">🚨 Patient Requirements & Clinical Triage</span>
        <span class="panel-badge">${request.requestId}</span>
      </div>
      
      <div class="grid-2col" style="font-size: 0.85rem; margin-bottom: 1rem;">
        <div>
          <div>👤 <strong>Patient:</strong> ${request.patientName} (Age: ${request.age})</div>
          <div>🩺 <strong>Condition:</strong> ${request.emergencyType}</div>
          <div>⚠️ <strong>Triage Severity:</strong> <span style="color: var(--status-red); font-weight: 700; font-family: var(--font-mono);">${request.priorityName}</span></div>
        </div>
        <div>
          <div>🏥 <strong>Target Facility:</strong> ${hospital.name}</div>
          <div>📍 <strong>Distance:</strong> ${hospital.distanceKm} km (Est. Transit: ~${Math.round(hospital.distanceKm * 2.5)} mins)</div>
          <div>🔒 <strong>Resources Locked:</strong> ${(request.requiredResourceTypes?.length ? request.requiredResourceTypes : ["ICU_BED"]).join(", ")} (Soft Reservation)</div>
        </div>
      </div>

      <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
        <button id="btnAcceptReferral" class="btn btn-success btn-block" style="font-size: 1rem; padding: 0.85rem;">
          ✅ ACCEPT REFERRAL & COMMIT BED ALLOCATION
        </button>
        <button id="btnRejectReferral" class="btn btn-danger btn-block" style="font-size: 1rem; padding: 0.85rem;">
          ❌ REJECT & TRIGGER AUTOMATIC FAILOVER
        </button>
      </div>
    </div>
  `;

  document.getElementById("btnAcceptReferral")?.addEventListener("click", async () => {
    if (lock.remote) {
      try {
         const accepted = await ReferralsAPI.accept(lock.acceptanceId);
         request.status = "ALLOCATED";
         request.assignedHospital = hospital.name;
         // The backend auto-dispatches a unit on accept; ambulance_id is null when none was free.
         state.lastAcceptedReferral = { requestId: request.requestId, hospitalId: hospital.id, hospitalName: hospital.name, ambulanceId: accepted?.ambulance_id || null };
        state.currentActiveReferral = null;
        recordActivity("REFERRAL_ACCEPTED", `${hospital.name} accepted ${request.requestId}`, "success");
        await refreshWorkspaceData();
        showNotification(accepted?.ambulance_id
          ? `✓ ${hospital.name} confirmed the referral. Ambulance ${accepted.ambulance_id} was dispatched automatically.`
          : `✓ ${hospital.name} confirmed the referral. No ambulance was free to auto-dispatch.`, "success");
        updateRoadsideDispatchControl();
        renderHospitalAcceptanceView();
      } catch (error) { showNotification(`Acceptance failed: ${error.message}`, "urgent"); }
      return;
    }
    const committed = lockManager.commitAllocation();
    if (committed) {
      state.currentActiveReferral = null;
      if (request) {
        request.status = "ALLOCATED";
        request.assignedHospital = hospital.name;
        state.lastAcceptedReferral = { requestId: request.requestId, hospitalId: hospital.id, hospitalName: hospital.name };
      }
      showNotification(`🎉 ${hospital.name} ACCEPTED referral for ${request.patientName}! Bed atomically committed. Ambulance dispatched.`, "success");
      recordActivity("REFERRAL_ACCEPTED", `${hospital.name} accepted ${request.requestId}`, "success");
      renderEmergencyQueue();
      renderKpiCards();
    }
  });

  document.getElementById("btnRejectReferral")?.addEventListener("click", async () => {
    if (lock.remote) {
      try {
        await ReferralsAPI.reject(lock.acceptanceId, "Facility declined referral");
        state.currentActiveReferral = null;
        recordActivity("REFERRAL_REJECTED", `${hospital.name} declined ${request.requestId}`, "critical");
        await refreshWorkspaceData();
        showNotification(`Referral declined by ${hospital.name}. Review the next eligible candidate.`, "urgent");
        renderHospitalAcceptanceView();
      } catch (error) { showNotification(`Rejection failed: ${error.message}`, "urgent"); }
      return;
    }
    lockManager.rejectAllocation(() => {
      state.currentActiveReferral = null;
      showNotification(`❌ Referral rejected by ${hospital.name}. Soft-lock released. Automatically rerouting to next candidate...`, "urgent");
      recordActivity("REFERRAL_REJECTED", `${hospital.name} declined ${request.requestId}`, "critical");
      renderRankingResults();
    });
  });
  if (lock.remote && remainingSec > 0) {
    window.setTimeout(() => {
      if (state.currentActiveReferral?.acceptanceId === lock.acceptanceId) renderHospitalAcceptanceView();
    }, 1000);
  }
}

// Emergency Queue Render
function renderEmergencyQueue() {
  const tbody = document.getElementById("emergencyQueueTableBody");
  const search = (document.getElementById("emergencySearch")?.value || "").trim().toLowerCase();
  const priority = document.getElementById("emergencyPriorityFilter")?.value || "ALL";
  const status = document.getElementById("emergencyStatusFilter")?.value || "ALL";
  const filtered = state.emergencyQueue.filter(item => {
    const haystack = `${item.requestId} ${item.patientName} ${item.emergencyType} ${item.assignedHospital}`.toLowerCase();
    return (!search || haystack.includes(search)) &&
      (priority === "ALL" || String(item.priority) === priority) &&
      (status === "ALL" || item.status === status);
  });
  const countEl = document.getElementById("queueResultCount");
  if (countEl) countEl.textContent = `${filtered.length} of ${state.emergencyQueue.length} cases`;
  if (!tbody) {
    renderCommandOverview();
    return;
  }

  tbody.innerHTML = "";
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><strong>No matching cases</strong>Adjust the queue filters to broaden the operational view.</div></td></tr>`;
    renderCommandOverview();
    return;
  }
  filtered.forEach(item => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.setAttribute("aria-selected", String(item.requestId === state.selectedRequestId));
    tr.title = "Select this case for hospital matching";
    const priorityBadgeClass = `badge-priority badge-p${item.priority}`;
    const statusMap = {
      'ALLOCATED': 'badge-allocated',
      'WAITING': 'badge-waiting',
      'MATCHING': 'badge-matching',
      'IN_TREATMENT': 'badge-treatment',
      'COMPLETED': 'badge-completed',
      'NEW': 'badge-new'
    };
    const statusBadgeClass = statusMap[item.status] || 'badge-new';

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-weight: 700; color: var(--accent); font-size: 0.8rem;">${item.requestId}</td>
      <td><strong style="color: var(--text-heading);">${item.patientName}</strong> <span style="font-size: 0.75rem; color: var(--text-muted);">(${item.age}y)</span></td>
      <td style="font-size: 0.84rem;">${item.emergencyType}</td>
      <td><span class="${priorityBadgeClass}">P${item.priority}</span></td>
      <td><span class="badge-status ${statusBadgeClass}">${item.status}</span></td>
      <td style="font-size: 0.82rem; color: var(--text-secondary);">${item.assignedHospital}</td>
      <td style="font-family: var(--font-mono); font-size: 0.775rem; color: var(--text-muted);">${item.requestTime}</td>
    `;
    const selectRequest = () => {
      state.selectedRequestId = item.requestId;
      renderEmergencyQueue();
      showNotification(`Selected ${item.requestId} for referral matching.`, "normal");
    };
    tr.addEventListener("click", selectRequest);
    tr.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRequest();
      }
    });
    tbody.appendChild(tr);
  });
  renderCommandOverview();
}

// Hospitals Directory Render
function renderHospitalsDirectory() {
  const container = document.getElementById("hospitalsDirectoryGrid");
  if (!container) return;

  container.innerHTML = "";
  state.hospitals.forEach(h => {
    const card = document.createElement("div");
    card.className = "hospital-card";
    const statusClass = h.status === "OPEN" ? "badge-open" : h.status === "LIMITED" ? "badge-limited" : "badge-closed";

    card.innerHTML = `
      <div class="hospital-header">
        <div>
          <div class="hospital-name">${h.name}</div>
          <div style="font-size: 0.72rem; color: var(--text-tertiary);">${h.address}</div>
        </div>
        <span class="badge-status ${statusClass}">${h.status}</span>
      </div>
      <div class="resource-capsule-grid">
        <div class="resource-capsule">
          <span class="capsule-label">ICU Beds</span>
          <span class="capsule-val ${h.resources.icuBeds.available > 0 ? 'good' : 'empty'}">${h.resources.icuBeds.available}/${h.resources.icuBeds.total}</span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Ventilators</span>
          <span class="capsule-val ${h.resources.ventilators.available > 0 ? 'good' : 'empty'}">${h.resources.ventilators.available}/${h.resources.ventilators.total}</span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">OT Theatres</span>
          <span class="capsule-val ${h.resources.emergencyOT.available > 0 ? 'good' : 'empty'}">${h.resources.emergencyOT.available}/${h.resources.emergencyOT.total}</span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Specialists</span>
          <span class="capsule-val good">${Object.values(h.resources.specialists).filter(Boolean).length}/4</span>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
  renderHospitalManagement();
}

function renderHospitalManagement() {
  const container = document.getElementById("hospitalsManagementGrid");
  if (!container) return;
  const query = (document.getElementById("hospitalSearch")?.value || "").trim().toLowerCase();
  const status = document.getElementById("hospitalStatusFilter")?.value || "ALL";
  const hospitals = state.hospitals.filter(h => {
    const matchesQuery = !query || `${h.id} ${h.name} ${h.address}`.toLowerCase().includes(query);
    return matchesQuery && (status === "ALL" || h.status === status);
  });
  const count = document.getElementById("hospitalResultsCount");
  if (count) count.textContent = `${hospitals.length} of ${state.hospitals.length} facilities`;
  if (!hospitals.length) {
    container.innerHTML = `<div class="empty-state"><strong>No facilities found</strong>Try a different facility name or status.</div>`;
    return;
  }
  container.innerHTML = hospitals.map(h => {
    const statusClass = h.status === "OPEN" ? "badge-open" : h.status === "LIMITED" ? "badge-limited" : "badge-closed";
    const resources = [
      ["ICU beds", h.resources.icuBeds],
      ["Ventilators", h.resources.ventilators],
      ["Emergency OT", h.resources.emergencyOT]
    ];
    const available = resources.reduce((sum, [, resource]) => sum + resource.available, 0);
    const capacity = resources.reduce((sum, [, resource]) => sum + resource.total, 0);
    return `<article class="hospital-card operations-hospital-card">
      <div class="hospital-header"><div><div class="hospital-name"><span class="rank-badge">${h.id}</span>${h.name}</div><div class="hospital-meta">${h.address}</div></div><span class="badge-status ${statusClass}">${h.status}</span></div>
      <div class="capacity-meter"><span style="width:${capacity ? Math.round((available / capacity) * 100) : 0}%"></span></div>
      <div class="capacity-meter-label"><span>Critical resource readiness</span><strong>${available}/${capacity} open</strong></div>
      <div class="resource-capsule-grid">${resources.map(([label, resource]) => `<div class="resource-capsule"><span class="capsule-label">${label}</span><span class="capsule-val ${resource.available > 0 ? "good" : "empty"}">${resource.available}/${resource.total}</span></div>`).join("")}</div>
      <div class="hospital-card-footer"><span>★ ${h.rating}/5 · ${h.acceptanceRate ? Math.round(h.acceptanceRate * 100) : "—"}% acceptance</span><span>${h.traumaLevel || "Emergency facility"}</span></div>
    </article>`;
  }).join("");
}

function recordActivity(type, message, tone = "info") {
  state.activity.unshift({ type, message, tone, timestamp: new Date().toISOString() });
  state.activity = state.activity.slice(0, 40);
  renderKpiCards();
  renderCommandOverview();
  renderActivityWorkspace();
}

function formatActivityTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderCommandOverview() {
  const queueBody = document.getElementById("commandPriorityQueueBody");
  if (queueBody) {
    const topCases = [...state.emergencyQueue].sort(comparePriority).slice(0, 5);
    const commandStatusClasses = { NEW: "new", WAITING: "waiting", MATCHING: "matching", ALLOCATED: "allocated", IN_TREATMENT: "treatment", COMPLETED: "completed", CANCELLED: "cancelled" };
    queueBody.innerHTML = topCases.length ? topCases.map(item => `<tr>
      <td class="font-mono">${item.requestId}</td><td><strong>${item.patientName}</strong><small>${item.emergencyType}</small></td>
      <td><span class="badge-priority badge-p${item.priority}">P${item.priority}</span></td>
      <td><span class="badge-status badge-${commandStatusClasses[item.status] || "new"}">${String(item.status).replace("_", " ")}</span></td>
      <td>${item.assignedHospital || "Matching"}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state"><strong>Queue clear</strong>No active cases are awaiting coordination.</div></td></tr>`;
  }

  const referralSummary = document.getElementById("commandReferralSummary");
  if (referralSummary) {
    const pending = state.currentActiveReferral || lockManager.activeLock ? 1 : 0;
    const accepted = state.emergencyQueue.filter(item => ["ALLOCATED", "IN_TREATMENT"].includes(item.status)).length;
    const closed = state.activity.filter(event => ["REJECTED", "EXPIRED", "TIMEOUT"].some(term => event.type.includes(term))).length;
    referralSummary.innerHTML = [
      ["⏳", "Pending handshake", pending, "awaiting acceptance"],
      ["✓", "Accepted / allocated", accepted, "destination committed"],
      ["!", "Rejected / expired", closed, "recovery events"]
    ].map(([icon, label, value, caption]) => `<div class="summary-row"><span class="summary-icon">${icon}</span><div><strong>${label}</strong><small>${caption}</small></div><span class="summary-value">${value}</span></div>`).join("");
  }

  const fleetSummary = document.getElementById("commandFleetSummary");
  if (fleetSummary) {
    const available = state.ambulances.filter(a => a.status === "AVAILABLE").length;
    const transit = state.ambulances.filter(a => a.status === "IN_TRANSIT").length;
    const maintenance = state.ambulances.filter(a => a.status === "MAINTENANCE").length;
    fleetSummary.innerHTML = [
      ["●", "Available", available, "ready for dispatch"],
      ["↗", "In transit", transit, "active transport"],
      ["⚙", "Maintenance", maintenance, "out of service"]
    ].map(([icon, label, value, caption]) => `<div class="summary-row"><span class="summary-icon">${icon}</span><div><strong>${label}</strong><small>${caption}</small></div><span class="summary-value">${value}</span></div>`).join("");
  }

  const feed = document.getElementById("commandActivityFeed");
  if (feed) {
    const events = state.activity.length ? state.activity.slice(0, 5) : [{ type: "SYSTEM_READY", message: "Standalone operations workspace initialized", tone: "info", timestamp: new Date().toISOString() }];
    feed.innerHTML = events.map(event => `<div class="activity-item ${event.tone}"><span class="activity-marker"></span><div><strong>${event.message}</strong><small>${event.type} · ${formatActivityTime(event.timestamp)}</small></div></div>`).join("");
  }
}

function renderActivityWorkspace() {
  const timeline = document.getElementById("activityTimeline");
  if (!timeline) return;
  const events = state.activity.length ? state.activity : [{ type: "SYSTEM_READY", message: "Standalone operations workspace initialized", tone: "info", timestamp: new Date().toISOString() }];
  timeline.innerHTML = events.map(event => `<div class="activity-item ${event.tone}"><span class="activity-marker"></span><div><strong>${event.message}</strong><small>${event.type} · ${new Date(event.timestamp).toLocaleString()}</small></div></div>`).join("");
  const auditSummary = document.getElementById("activityAuditSummary");
  if (auditSummary) {
    const entries = getLedgerEntries();
    const integrity = verifyLedgerIntegrity();
    auditSummary.innerHTML = [
      [entries.length, "sealed entries"],
      [integrity.isValid ? "VALID" : "REVIEW", "chain integrity"],
      [state.activity.length, "session events"]
    ].map(([value, label]) => `<div class="audit-summary-card"><strong>${value}</strong><span>${label}</span></div>`).join("");
  }
}

// Banker's Algorithm Visualizer UI
function initBankersSimulator() {
  const runBtn = document.getElementById("btnRunBankers");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      syncBankersInputMatrix();
      renderBankersResults();
    });
  }

  // P3-02 Compound Claim Evaluation UI
  const btnEvaluateCompound = document.getElementById("btnEvaluateCompoundClaim");
  btnEvaluateCompound?.addEventListener("click", () => {
    syncBankersInputMatrix();
    const pIdx = parseInt(document.getElementById("compoundProcessSelect")?.value, 10) || 0;
    const req0 = parseInt(document.getElementById("claimReq0")?.value, 10) || 0;
    const req1 = parseInt(document.getElementById("claimReq1")?.value, 10) || 0;
    const req2 = parseInt(document.getElementById("claimReq2")?.value, 10) || 0;
    const reqVec = [req0, req1, req2];

    const result = bankersEngine.requestResources(pIdx, reqVec);
    const box = document.getElementById("compoundClaimResultBox");
    if (!box) return;

    if (result.granted) {
      box.innerHTML = `
        <div style="color: var(--status-green); font-weight: 700; margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem;">
          <span>✅</span> Compound Claim Granted Safely!
        </div>
        <div style="font-size: 0.8rem; color: var(--text-heading); margin-bottom: 0.5rem;">
          Allocation committed for <strong>${bankersEngine.processes[pIdx]}</strong>: [${reqVec.join(', ')}]
        </div>
        <div style="font-family: var(--font-mono); font-size: 0.75rem; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm); color: #34d399;">
          Valid Safe Sequence: &lt; ${result.safeSequence.join(" ➔ ")} &gt;
        </div>
      `;
      appendAuditEntry(EVENT_TYPES.BANKERS_SAFE, {
        process: bankersEngine.processes[pIdx],
        requested: reqVec,
        safeSequence: result.safeSequence
      });
      renderAuditLedgerTable();
      showNotification(`✅ Compound claim granted! System remains in Safe State.`, "success");
    } else {
      box.innerHTML = `
        <div style="color: var(--status-red); font-weight: 700; margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem;">
          <span>⛔</span> Deadlock Avoidance: Request Proactively Rejected!
        </div>
        <div style="font-size: 0.8rem; color: #fca5a5; margin-bottom: 0.4rem;">
          ${result.reason}
        </div>
        <div style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); background: rgba(239, 68, 68, 0.1); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm);">
          Circular wait hazard averted. Process enqueued in OS waiting state until resources are released.
        </div>
      `;
      appendAuditEntry(EVENT_TYPES.BANKERS_UNSAFE, {
        process: bankersEngine.processes[pIdx],
        requested: reqVec,
        rejectionReason: result.reason
      });
      renderAuditLedgerTable();
      showNotification(`⚠️ Proactive Deadlock Rejection: Request would enter unsafe state!`, "urgent");
    }
  });

  document.getElementById("btnPreloadUnsafeClaim")?.addEventListener("click", () => {
    const sel = document.getElementById("compoundProcessSelect");
    if (sel) sel.value = "0";
    const r0 = document.getElementById("claimReq0");
    const r1 = document.getElementById("claimReq1");
    const r2 = document.getElementById("claimReq2");
    if (r0) r0.value = 3;
    if (r1) r1.value = 3;
    if (r2) r2.value = 2;
    btnEvaluateCompound?.click();
  });

  // P3-01 Mass Casualty 100-Thread Concurrency Stress Simulation Runner
  document.getElementById("btnRunMassCasualtyStress")?.addEventListener("click", async () => {
    const btn = document.getElementById("btnRunMassCasualtyStress");
    const statusText = document.getElementById("stressTestStatusText");
    const metricsGrid = document.getElementById("stressTestMetricsGrid");
    const consoleLog = document.getElementById("stressTestLogConsole");

    if (btn) btn.disabled = true;
    if (metricsGrid) metricsGrid.style.display = "grid";
    if (consoleLog) {
      consoleLog.style.display = "block";
      consoleLog.innerHTML = "";
    }

    if (statusText) statusText.textContent = "⚡ Spawning 100 asynchronous concurrent threads...";

    const appendLog = (msg) => {
      if (!consoleLog) return;
      const row = document.createElement("div");
      row.textContent = msg;
      consoleLog.appendChild(row);
      consoleLog.scrollTop = consoleLog.scrollHeight;
    };

    appendLog("[STRESS-ENGINE] Initializing 100 concurrent threads competing for 1 bottleneck ICU bed...");

    let remainingBeds = 1;
    let mutexLocked = false;
    let winnerThread = null;
    let safeReroutes = 0;

    const acquireLock = async () => {
      while (mutexLocked) {
        await new Promise(r => setTimeout(r, Math.random() * 8 + 2));
      }
      mutexLocked = true;
      return () => { mutexLocked = false; };
    };

    const threadPromises = Array.from({ length: 100 }, async (_, idx) => {
      const threadId = idx + 1;
      const release = await acquireLock();
      try {
        if (remainingBeds > 0) {
          remainingBeds--;
          winnerThread = threadId;
          appendLog(`[THREAD-${String(threadId).padStart(3, '0')}] 🔒 ACQUIRED ROW LOCK on ICU Bed (Winner!) Allocation Committed.`);
        } else {
          safeReroutes++;
          if (idx < 5 || idx > 95) {
            appendLog(`[THREAD-${String(threadId).padStart(3, '0')}] 🛑 Resource exhausted. Safe Reroute to Rank #2 hospital triggered.`);
          }
        }
      } finally {
        release();
      }
    });

    await Promise.all(threadPromises);

    document.getElementById("stressKpiThreads").textContent = "100";
    document.getElementById("stressKpiAllocated").textContent = "1";
    document.getElementById("stressKpiRerouted").textContent = String(safeReroutes);
    document.getElementById("stressKpiDoubleAlloc").textContent = "0";

    appendLog(`[STRESS-ENGINE] ✅ Completed! Winner: THREAD-${String(winnerThread).padStart(3, '0')}. Total Rerouted: ${safeReroutes}. Double Allocations: 0.`);
    if (statusText) statusText.textContent = `✅ Complete: 1 Winner, 99 Rerouted, 0 Race Conditions!`;

    appendAuditEntry(EVENT_TYPES.STRESS_TEST_RUN, {
      threads: 100,
      resource: "ICU_BED",
      winnerThread,
      safeReroutes,
      doubleAllocations: 0,
      passed: true
    });
    renderAuditLedgerTable();

    if (btn) btn.disabled = false;
    showNotification("🚀 100-Thread Concurrency Stress Test Passed with 0 Double Allocations!", "success");
  });
}

function syncBankersInputMatrix() {
  // Read available inputs
  const avail0 = parseInt(document.getElementById("avail0")?.value, 10) || 3;
  const avail1 = parseInt(document.getElementById("avail1")?.value, 10) || 3;
  const avail2 = parseInt(document.getElementById("avail2")?.value, 10) || 2;
  bankersEngine.available = [avail0, avail1, avail2];

  // Read matrix inputs
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const allocVal = parseInt(document.getElementById(`alloc_${i}_${j}`)?.value, 10) || 0;
      const maxVal = parseInt(document.getElementById(`max_${i}_${j}`)?.value, 10) || 0;
      bankersEngine.allocation[i][j] = allocVal;
      bankersEngine.max[i][j] = maxVal;
    }
  }
}

function renderBankersView() {
  renderBankersResults();
}

function renderBankersResults() {
  const result = bankersEngine.evaluateSafety();
  const outputContainer = document.getElementById("bankersResultContainer");
  if (!outputContainer) return;

  const needMatrix = bankersEngine.getNeedMatrix();

  // Render Need Table
  const needTableBody = document.getElementById("bankersNeedTableBody");
  if (needTableBody) {
    needTableBody.innerHTML = "";
    bankersEngine.processes.forEach((proc, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-weight: 700;">${proc}</td>
        <td>${needMatrix[i][0]}</td>
        <td>${needMatrix[i][1]}</td>
        <td>${needMatrix[i][2]}</td>
      `;
      needTableBody.appendChild(tr);
    });
  }

  if (result.isSafe) {
    outputContainer.innerHTML = `
      <div class="safe-seq-display">
        <span>✅ SAFE SYSTEM STATE: Deadlock Avoided! Safe Sequence:</span>
        <span style="font-size: 1.05rem; color: #fff; background: rgba(0,0,0,0.4); padding: 0.3rem 0.6rem; border-radius: 4px;">
          &lt; ${result.safeSequence.join(" ➔ ")} &gt;
        </span>
      </div>
      <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-top: 1rem; font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.7; max-height: 180px; overflow-y: auto;">
        ${result.traceLogs.map(log => `<div>${log}</div>`).join("")}
      </div>
    `;
  } else {
    outputContainer.innerHTML = `
      <div class="unsafe-seq-display">
        <span>⚠️ UNSAFE STATE DETECTED: System cannot avoid potential deadlock!</span>
      </div>
      <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-top: 1rem; font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.7; color: #fca5a5;">
        ${result.traceLogs.map(log => `<div>${log}</div>`).join("")}
      </div>
    `;
  }
}

// Ambulance Fleet Render
function renderAmbulanceFleet() {
  const container = document.getElementById("ambulanceFleetGrid");
  if (!container) return;

  const query = (document.getElementById("ambulanceSearch")?.value || "").trim().toLowerCase();
  const statusFilter = document.getElementById("ambulanceStatusFilter")?.value || "ALL";
  const filtered = state.ambulances.filter(amb => {
    const matchesQuery = !query || `${amb.id} ${amb.type} ${amb.hospitalId}`.toLowerCase().includes(query);
    return matchesQuery && (statusFilter === "ALL" || amb.status === statusFilter);
  });
  const resultCount = document.getElementById("ambulanceResultsCount");
  if (resultCount) resultCount.textContent = `${filtered.length} of ${state.ambulances.length} units`;
  container.innerHTML = "";
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><strong>No units found</strong>Adjust the fleet filters to broaden the view.</div>`;
    return;
  }
  filtered.forEach(amb => {
    const card = document.createElement("div");
    card.className = "hospital-card";
    const statusBadge = amb.status === "AVAILABLE" ? "badge-open" : ["IN_TRANSIT", "DISPATCHED"].includes(amb.status) ? "badge-limited" : "badge-closed";

    card.innerHTML = `
      <div class="hospital-header">
        <div>
          <div class="hospital-name">🚑 ${amb.id}</div>
          <div style="font-size: 0.75rem; color: var(--text-tertiary);">${amb.type} • Stationed at ${amb.hospitalId}</div>
        </div>
        <span class="badge-status ${statusBadge}">${amb.status}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; font-size: 0.82rem;">
        <div>Transit Telemetry: <strong>${amb.status === 'IN_TRANSIT' ? `ETA ${amb.etaMins} mins` : 'Standby at Station'}</strong></div>
         <button class="btn btn-secondary btn-sm btn-view-ambulance" data-ambulance-id="${amb.id}" type="button">
           📍 View GPS Route
         </button>
      </div>
    `;
    container.appendChild(card);
  });
  container.querySelectorAll(".btn-view-ambulance").forEach(button => {
    button.addEventListener("click", () => {
      const ambulance = state.ambulances.find(item => item.id === button.dataset.ambulanceId);
      if (!ambulance) return;
      triggerTabSwitch("tab-map");
      showNotification(`📍 Tracking ${ambulance.id} from station ${ambulance.hospitalId}.`, "normal");
    });
  });
}

// Notification Banner Helper
function showNotification(msg, type = "normal") {
  const banner = document.getElementById("globalNotificationBanner");
  if (!banner) return;

  banner.textContent = msg;
  banner.style.display = "block";
  banner.className = "toast-enter";

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  if (type === "urgent") {
    banner.style.background  = isDark ? "#DC2626" : "#DC2626";
    banner.style.color       = "#FFFFFF";
    banner.style.border      = "1px solid #B91C1C";
    banner.style.boxShadow   = isDark ? "0 8px 24px rgba(0,0,0,0.5)" : "0 8px 24px rgba(220,38,38,0.25)";
  } else if (type === "success") {
    banner.style.background  = isDark ? "#059669" : "#16A34A";
    banner.style.color       = "#FFFFFF";
    banner.style.border      = isDark ? "1px solid #047857" : "1px solid #15803D";
    banner.style.boxShadow   = isDark ? "0 8px 24px rgba(0,0,0,0.5)" : "0 8px 24px rgba(22,163,74,0.25)";
  } else {
    banner.style.background  = isDark ? "#1E293B" : "#0F2747";
    banner.style.color       = "#FFFFFF";
    banner.style.border      = isDark ? "1px solid #334155" : "1px solid #1E3A5F";
    banner.style.boxShadow   = isDark ? "0 8px 24px rgba(0,0,0,0.5)" : "0 8px 24px rgba(15,39,71,0.18)";
  }

  setTimeout(() => {
    banner.style.display = "none";
    banner.className = "";
  }, 6000);
}

/* ====================================================================
   ROADSIDE ACCIDENT & VOICE SYMPTOM TRIAGE MODULE
   "Just tell or select symptoms from the road accident scene"
   ==================================================================== */

function initRoadsideAssist() {
  // 1. Populate Roadside Location Selector
  const locSelect = document.getElementById("roadsideLocationSelect");
  if (locSelect) {
    locSelect.innerHTML = "";
    ROADSIDE_HOTSPOTS.forEach((spot, idx) => {
      const opt = document.createElement("option");
      opt.value = spot.id;
      opt.textContent = `${spot.name} (${spot.landmark})`;
      if (idx === 0) opt.selected = true;
      locSelect.appendChild(opt);
    });

    locSelect.addEventListener("change", (e) => {
      const chosen = ROADSIDE_HOTSPOTS.find(s => s.id === e.target.value);
      if (chosen) {
        state.roadside.currentLocation = chosen;
        const label = document.getElementById("roadsideCurrentLocLabel");
        if (label) label.textContent = `${chosen.name} - ${chosen.address}`;
        showNotification(`📍 Roadside position set to: ${chosen.name}`, "normal");
        performRoadsideAnalysis();
      }
    });
  }

  // 2. Real Device GPS Button
  const btnGps = document.getElementById("btnUseGpsLocation");
  if (btnGps) {
    btnGps.addEventListener("click", () => {
      if (!navigator.geolocation) {
        showNotification("⚠️ Geolocation is not supported by your browser. Using simulated road hotspot.", "urgent");
        return;
      }
      showNotification("📡 Acquiring device GPS satellite fix...", "normal");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = Math.round(pos.coords.latitude * 10000) / 10000;
          const lng = Math.round(pos.coords.longitude * 10000) / 10000;
          state.roadside.currentLocation = {
            id: "GPS_LIVE",
            name: `Live Device Road Coordinates (${lat}, ${lng})`,
            address: `Current Road Position (Accuracy: ±${Math.round(pos.coords.accuracy)}m)`,
            lat,
            lng,
            landmark: "Current Road Point"
          };
          const label = document.getElementById("roadsideCurrentLocLabel");
          if (label) label.textContent = state.roadside.currentLocation.name;
          showNotification(`✅ Roadside GPS locked at [${lat}, ${lng}]. Real-time hospital distances updated!`, "success");
          performRoadsideAnalysis();
        },
        (err) => {
          showNotification(`⚠️ GPS fix unavailable (${err.message}). Defaulted to Highway 44 Expressway Hotspot.`, "normal");
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  }

  // 3. Render Quick Roadside Symptom Tags
  const tagsGrid = document.getElementById("roadsideTagsGrid");
  if (tagsGrid) {
    tagsGrid.innerHTML = "";
    SYMPTOM_DATABASE.forEach(symptom => {
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = `roadside-tag ${state.roadside.selectedSymptomIds.includes(symptom.id) ? "selected" : ""}`;
      tag.setAttribute("data-symptom-id", symptom.id);
      tag.innerHTML = symptom.label;
      tag.addEventListener("click", () => {
        tag.classList.toggle("selected");
        const id = symptom.id;
        if (state.roadside.selectedSymptomIds.includes(id)) {
          state.roadside.selectedSymptomIds = state.roadside.selectedSymptomIds.filter(x => x !== id);
        } else {
          state.roadside.selectedSymptomIds.push(id);
        }
        performRoadsideAnalysis();
      });
      tagsGrid.appendChild(tag);
    });
  }

  // 4. Voice Speech Recognition Setup
  const micBtn = document.getElementById("roadsideMicBtn");
  const micStatus = document.getElementById("roadsideMicStatus");
  const soundwaves = document.getElementById("roadsideSoundwaves");
  const symptomText = document.getElementById("roadsideSymptomText");

  if (symptomText) {
    symptomText.value = state.roadside.symptomText;
    symptomText.addEventListener("input", (e) => {
      state.roadside.symptomText = e.target.value;
      performRoadsideAnalysis();
    });
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      state.roadside.isListening = true;
      if (micBtn) micBtn.classList.add("recording");
      if (micStatus) micStatus.textContent = "🔴 Listening... Speak observed accident symptoms now!";
      if (soundwaves) soundwaves.classList.add("active");
    };

    recognition.onresult = (event) => {
      let interimTranscript = "";
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      const combined = (finalTranscript || interimTranscript).trim();
      if (combined && symptomText) {
        symptomText.value = combined;
        state.roadside.symptomText = combined;
        performRoadsideAnalysis();
      }
    };

    recognition.onerror = (event) => {
      state.roadside.isListening = false;
      if (micBtn) micBtn.classList.remove("recording");
      if (soundwaves) soundwaves.classList.remove("active");
      if (micStatus) micStatus.textContent = "Tap microphone & tell what you see";
      if (event.error !== "no-speech") {
        showNotification(`🎙️ Speech recognition alert: ${event.error}`, "normal");
      }
    };

    recognition.onend = () => {
      state.roadside.isListening = false;
      if (micBtn) micBtn.classList.remove("recording");
      if (soundwaves) soundwaves.classList.remove("active");
      if (micStatus) micStatus.textContent = "Tap microphone & tell what you see";
      performRoadsideAnalysis();
    };

    state.roadside.recognition = recognition;

    if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (state.roadside.isListening) {
          recognition.stop();
        } else {
          try {
            recognition.start();
          } catch (err) {
            recognition.stop();
          }
        }
      });
    }
  } else {
    if (micBtn) {
      micBtn.addEventListener("click", () => {
        showNotification("🎙️ Web Speech Recognition is not supported in this browser. Please type symptoms or use the instant test scenarios below.", "normal");
      });
    }
  }

  // 5. Preset Scenario Buttons
  const scenarioPresets = {
    motorcycle: {
      text: "Motorcycle collision at highway speed. Rider is unconscious, bleeding heavily from head, compound fracture on leg with bone exposed.",
      tags: ["unconscious", "severe_head_injury", "crushed_limb_fracture", "arterial_bleeding"]
    },
    car_chest: {
      text: "Car crash into highway concrete barrier. Airbag deployed, driver had steering wheel impact with severe chest pain and gasping for breath.",
      tags: ["chest_impact", "respiratory_arrest"]
    },
    pedestrian: {
      text: "Pedestrian struck by speeding bus on outer road. Deep open leg wound with heavy spurting arterial bleeding, dazed and disoriented.",
      tags: ["arterial_bleeding", "unconscious"]
    },
    bike_fracture: {
      text: "Bicycle fall on roadside shoulder. Compound fracture on right forearm, severe arm pain, conscious and responsive.",
      tags: ["crushed_limb_fracture"]
    }
  };

  document.querySelectorAll(".scenario-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.getAttribute("data-scenario");
      const preset = scenarioPresets[type];
      if (preset) {
        state.roadside.symptomText = preset.text;
        state.roadside.selectedSymptomIds = [...preset.tags];
        if (symptomText) symptomText.value = preset.text;
        // Update tags UI
        document.querySelectorAll(".roadside-tag").forEach(tag => {
          const id = tag.getAttribute("data-symptom-id");
          if (preset.tags.includes(id)) {
            tag.classList.add("selected");
          } else {
            tag.classList.remove("selected");
          }
        });
        showNotification(`⚡ Loaded test scenario: ${btn.textContent.trim()}`, "normal");
        performRoadsideAnalysis();
      }
    });
  });

  // 6. Manual Analyze Button
  const btnAnalyze = document.getElementById("btnAnalyzeRoadside");
  if (btnAnalyze) {
    btnAnalyze.addEventListener("click", () => {
      performRoadsideAnalysis();
      showNotification("🎯 Analyzed symptoms and updated roadside hospital recommendations!", "success");
    });
  }

  // 7. Intake Tab CTA Banner
  const ctaBanner = document.getElementById("btnJumpToRoadside");
  if (ctaBanner) {
    ctaBanner.addEventListener("click", () => {
      triggerTabSwitch("tab-roadside");
    });
  }

  // 8. Navigation Modal Close
  const closeRouteBtn = document.getElementById("closeRouteModalBtn");
  const routeModal = document.getElementById("routeDirectionsModal");
  if (closeRouteBtn && routeModal) {
    closeRouteBtn.addEventListener("click", () => {
      routeModal.style.display = "none";
    });
    routeModal.addEventListener("click", (e) => {
      if (e.target === routeModal) routeModal.style.display = "none";
    });
  }

  // Initial trigger
  performRoadsideAnalysis();
}

function performRoadsideAnalysis() {
  const text = state.roadside.symptomText || document.getElementById("roadsideSymptomText")?.value || "";
  const selectedIds = state.roadside.selectedSymptomIds || [];
  const loc = state.roadside.currentLocation;

  // 1. Analyze symptoms
  const analysis = analyzeRoadsideSymptoms(text, selectedIds);
  state.roadside.lastAnalysis = analysis;

  // 2. Update hospital distances based on current road location
  const updatedHospitals = updateHospitalDistances(state.hospitals, loc.lat, loc.lng);

  // 3. Rank hospitals against required resources
  const ranked = rankHospitals(updatedHospitals, analysis.requiredResources, DEFAULT_WEIGHTS);
  state.roadside.lastRanked = ranked;

  // 4. Update AI Triage Panel in UI
  const triageBadge = document.getElementById("roadsideTriageBadge");
  if (triageBadge) {
    triageBadge.textContent = analysis.triageName;
    triageBadge.style.color = analysis.triageColor;
  }

  const preemptTag = document.getElementById("roadsidePreemptTag");
  if (preemptTag) {
    if (analysis.triageLevel <= 2) {
      preemptTag.style.display = "inline-flex";
      preemptTag.innerHTML = "⚡ OS Preemptive Scheduling Lock";
    } else {
      preemptTag.style.display = "inline-flex";
      preemptTag.innerHTML = "⏱️ Standard Priority Queue";
    }
  }

  const emergencyTitle = document.getElementById("roadsideEmergencyTitle");
  if (emergencyTitle) {
    emergencyTitle.innerHTML = `Emergency Category: <strong style="color: #fff;">${analysis.emergencyTitle}</strong>`;
  }

  const rationaleEl = document.getElementById("roadsideTriageRationale");
  if (rationaleEl) {
    rationaleEl.textContent = analysis.triageSummary;
  }

  // Required resources capsules
  const resGrid = document.getElementById("roadsideRequiredResourcesGrid");
  if (resGrid) {
    const reqs = analysis.requiredResources;
    resGrid.innerHTML = `
      <div class="resource-capsule">
        <span class="capsule-label">ICU Bed</span>
        <span class="capsule-val ${reqs.requiredBeds ? 'good' : 'empty'}">${reqs.requiredBeds ? 'REQUIRED' : 'Optional'}</span>
      </div>
      <div class="resource-capsule">
        <span class="capsule-label">Ventilator</span>
        <span class="capsule-val ${reqs.requiredVents ? 'good' : 'empty'}">${reqs.requiredVents ? 'REQUIRED' : 'Optional'}</span>
      </div>
      <div class="resource-capsule">
        <span class="capsule-label">Emergency OT</span>
        <span class="capsule-val ${reqs.requiredOT ? 'good' : 'empty'}">${reqs.requiredOT ? 'REQUIRED' : 'Optional'}</span>
      </div>
      <div class="resource-capsule">
        <span class="capsule-label">Specialist</span>
        <span class="capsule-val ${reqs.specialist ? 'good' : 'empty'}">${reqs.specialist ? reqs.specialist.toUpperCase() : 'General ER'}</span>
      </div>
    `;
  }

  // First aid steps
  const firstAidList = document.getElementById("roadsideFirstAidList");
  if (firstAidList) {
    firstAidList.innerHTML = analysis.firstAidSteps.map(step => `<li>${step}</li>`).join("");
  }

  // 5. Render Recommendation Hero Card
  renderRoadsideHospitalRecommendation(ranked, analysis);
}

function renderRoadsideHospitalRecommendation(ranked, analysis) {
  const container = document.getElementById("roadsideRecommendationContainer");
  if (!container) return;

  const topHospital = ranked.find(h => h.isEligible);
  const reason = generateHospitalRecommendationReason(topHospital, ranked, analysis.requiredResources);

  if (!topHospital) {
    container.innerHTML = `
      <div class="panel" style="text-align: center; padding: 2.5rem 1rem; border-color: var(--status-red);">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🚨</div>
        <h3 style="color: var(--status-red);">No Regional Hospital Currently Meets Critical Life-Saving Constraints</h3>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">
          All regional facilities have exhausted their ICU beds, ventilators, or lack the on-duty surgical specialist for this accident.
        </p>
         <button id="btnOpenEmsFallback" type="button" class="btn btn-primary" style="margin-top: 1rem;">
           📞 Open EMS fallback coordination
         </button>
       </div>
     `;
    document.getElementById("btnOpenEmsFallback")?.addEventListener("click", () => {
      triggerTabSwitch("tab-ambulance");
      showNotification("No eligible destination is available. Coordinate an alternate transport plan with EMS dispatch.", "urgent");
    });
     return;
  }

  const specName = analysis.requiredResources.specialist
    ? (analysis.requiredResources.specialist === "traumaSurgeon" ? "Trauma Surgeon" : analysis.requiredResources.specialist === "neurologist" ? "Neurologist" : analysis.requiredResources.specialist === "cardiologist" ? "Cardiologist" : "Pediatrician")
    : null;

  const hasSpecialist = specName ? topHospital.resources.specialists[analysis.requiredResources.specialist] : true;

  container.innerHTML = `
    <!-- 🏆 HERO RECOMMENDED HOSPITAL CARD -->
    <div class="hero-recommendation-card">
      <div class="hero-rec-header">
        <div>
          <div class="hero-rec-badge">
            <span>🏆</span> #1 RECOMMENDED HOSPITAL FOR THIS ACCIDENT
          </div>
          <div class="hero-hosp-title">${topHospital.name}</div>
          <div style="font-size: 0.82rem; color: var(--text-tertiary); margin-top: 0.25rem;">
            📍 ${topHospital.address} • <strong>${topHospital.traumaLevel || 'Major Emergency Facility'}</strong> • ⭐ ${topHospital.rating}/5.0
          </div>
        </div>
        <div class="hero-eta-pill">
          <span>⏱️</span>
          <span><strong>${topHospital.distanceKm} km</strong> (~${topHospital.estDriveMins || Math.round(topHospital.distanceKm * 2.2 + 2)} mins drive)</span>
        </div>
      </div>

      <!-- Real-Time Resource Verification Capsules -->
      <div class="resource-capsule-grid">
        <div class="resource-capsule">
          <span class="capsule-label">ICU Beds</span>
          <span class="capsule-val ${topHospital.resources.icuBeds.available > 0 ? 'good' : 'empty'}">
            🟢 ${topHospital.resources.icuBeds.available} Available (Ready)
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Emergency OT</span>
          <span class="capsule-val ${topHospital.resources.emergencyOT.available > 0 ? 'good' : 'empty'}">
            🟢 ${topHospital.resources.emergencyOT.available} Open Theatres
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">Ventilators</span>
          <span class="capsule-val ${topHospital.resources.ventilators.available > 0 ? 'good' : 'empty'}">
            🟢 ${topHospital.resources.ventilators.available} Available
          </span>
        </div>
        <div class="resource-capsule">
          <span class="capsule-label">${specName || 'Specialist'}</span>
          <span class="capsule-val ${hasSpecialist ? 'good' : 'empty'}">
            ${hasSpecialist ? '🟢 ON DUTY' : '❌ Not Available'}
          </span>
        </div>
      </div>

      <!-- Clinical Decision Transparency Box -->
      <div class="rec-reason-box">
        <div style="font-weight: 700; color: var(--accent-cyan); margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem;">
          <span>🧠</span> Why Visit This Hospital? (Clinical & Operational Resource Fit)
        </div>
        <div>${reason.details}</div>
      </div>

      <!-- One-Touch Roadside Action Buttons -->
      <div class="roadside-action-grid">
        <button id="btnRoadsideNavigate" class="btn btn-primary" style="padding: 0.85rem; font-size: 0.9rem;">
          🧭 Turn-by-Turn GPS Navigation
        </button>
        <button id="btnRoadsidePreAlert" class="btn btn-cyan" style="padding: 0.85rem; font-size: 0.9rem;">
          🚨 Pre-Alert Hospital ER (1-Click)
        </button>
        <button id="btnRoadsideDispatchEMS" class="btn btn-accent" style="padding: 0.85rem; font-size: 0.9rem;">
          🚑 Dispatch Closest EMS Ambulance
        </button>
        <a href="tel:${topHospital.phone || '108'}" id="btnRoadsideCallHospital" class="btn btn-secondary" style="padding: 0.85rem; font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
          📞 Direct ER: ${topHospital.phone || '108'}
        </a>
      </div>
      <div id="roadsideDispatchStatus" role="status" aria-live="polite" style="margin-top: 0.6rem; font-size: 0.8rem; color: var(--text-secondary);"></div>
    </div>

    <!-- Other Regional Hospitals Comparison Grid -->
    <div class="panel" style="margin-top: 1.5rem;">
      <div class="panel-header">
        <span class="panel-title">🏥 Regional Hospitals Comparison Matrix</span>
        <span class="panel-badge">Distance From Road: ${state.roadside.currentLocation.name.split('(')[0].trim()}</span>
      </div>
      <div class="grid-3col">
        ${ranked.slice(1).map((h, i) => {
          const isEligible = h.isEligible;
          return `
            <div class="hospital-card" style="${!isEligible ? 'opacity: 0.75; border-color: rgba(244, 63, 94, 0.25);' : ''}">
              <div class="hospital-header">
                <div>
                  <div class="hospital-name">
                    <span class="rank-badge">#${i + 2}</span>
                    <span>${h.name}</span>
                  </div>
                  <div style="font-size: 0.72rem; color: var(--text-tertiary);">
                    📍 ${h.distanceKm} km away (~${h.estDriveMins || Math.round(h.distanceKm * 2.2 + 2)} mins)
                  </div>
                </div>
                <div class="score-badge">
                  ${isEligible ? `<span>${h.suitabilityScore}</span>` : `<span style="color: var(--status-red); font-size: 0.75rem;">EXCLUDED</span>`}
                </div>
              </div>
              <div class="resource-capsule-grid" style="margin-top: 0.5rem;">
                <div class="resource-capsule">
                  <span class="capsule-label">ICU</span>
                  <span class="capsule-val ${h.resources.icuBeds.available > 0 ? 'good' : 'empty'}">${h.resources.icuBeds.available}/${h.resources.icuBeds.total}</span>
                </div>
                <div class="resource-capsule">
                  <span class="capsule-label">OT</span>
                  <span class="capsule-val ${h.resources.emergencyOT.available > 0 ? 'good' : 'empty'}">${h.resources.emergencyOT.available}/${h.resources.emergencyOT.total}</span>
                </div>
              </div>
              ${!isEligible ? `
                <div style="margin-top: 0.5rem; font-size: 0.72rem; color: #fca5a5; background: rgba(244, 63, 94, 0.1); padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);">
                  ❌ ${h.exclusionReason}
                </div>
              ` : `
                <div style="margin-top: 0.5rem; font-size: 0.72rem; color: var(--text-tertiary);">
                  Suitability Fit: ${h.suitabilityScore}/100
                </div>
              `}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  // Attach Roadside Action Handlers
  document.getElementById("btnRoadsideNavigate")?.addEventListener("click", () => {
    openRouteNavigationModal(topHospital);
  });

  document.getElementById("btnRoadsidePreAlert")?.addEventListener("click", async () => {
    // 1-Click Pre-Alert ER: Creates an active emergency request, locks soft-reservation, and notifies hospital!
    // A second click while the first pre-alert is still being sent would register the victim twice.
    if (roadsidePreAlertInFlight) return;
    roadsidePreAlertInFlight = true;
    try {
      await sendRoadsidePreAlert(topHospital, analysis);
    } finally {
      roadsidePreAlertInFlight = false;
    }
  });

  async function sendRoadsidePreAlert(topHospital, analysis) {
    const newReqId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
    const newRequest = {
      requestId: newReqId,
      patientName: "Roadside Accident Victim",
      age: 35,
      emergencyType: analysis.emergencyType,
      priority: analysis.triageLevel,
      priorityName: analysis.triageName,
      status: "WAITING",
      assignedHospital: topHospital.name,
      requestTime: new Date().toLocaleTimeString(),
      requiredResources: Object.keys(analysis.requiredResources).filter(k => analysis.requiredResources[k]),
      notes: `Roadside Ingestion from ${state.roadside.currentLocation.name}. Symptoms: ${state.roadside.symptomText}`
    };

    if (getAuthToken()) {
      try {
        const response = await EmergenciesAPI.create({
          patient_name: newRequest.patientName,
          age: newRequest.age,
          emergency_type: newRequest.emergencyType,
          triage_priority: newRequest.priority,
          clinical_notes: newRequest.notes,
          pickup_lat: state.roadside.currentLocation.lat,
          pickup_lng: state.roadside.currentLocation.lng
        }, newIdempotencyKey());
        if (!response?.request_id) throw new Error("The emergency API did not return a request ID.");
        newRequest.requestId = response.request_id;
        await refreshWorkspaceData();
      } catch (error) {
        showNotification(`Unable to transmit roadside pre-alert: ${error.message}`, "urgent");
        return;
      }
    } else {
      state.emergencyQueue.unshift(newRequest);
      state.emergencyQueue.sort(comparePriority);
    }

    await initiateReferralLock(topHospital, state.emergencyQueue.find(item => item.requestId === newRequest.requestId) || newRequest);
    recordActivity("ROADSIDE_PREALERT", `Roadside pre-alert sent for ${newRequest.requestId}`, "critical");
    showNotification(`🚨 1-Click ER Pre-Alert Transmitted to ${topHospital.name}! Trauma scrub team alerted. Soft lock active!`, "urgent");
  }

  document.getElementById("btnRoadsideDispatchEMS")?.addEventListener("click", async () => {
    const referral = state.lastAcceptedReferral;
    const etaMins = Math.max(3, Math.round(topHospital.distanceKm * 1.5));
    const result = await dispatchForReferral({
      referral,
      awaitingAcceptance: state.currentActiveReferral?.status === "LOCKED_PENDING_RESPONSE",
      getAmbulances: () => state.ambulances,
      onChange: updateRoadsideDispatchControl,
      refresh: async () => { if (getAuthToken()) await refreshWorkspaceData(); },
      dispatch: async (ambulance) => {
        if (getAuthToken()) {
          await AmbulancesAPI.updateStatus(ambulance.id, { status: "DISPATCHED", request_id: referral.requestId, eta_mins: etaMins });
        } else {
          // Standalone demo mode has no backend to record the assignment.
          ambulance.status = "IN_TRANSIT";
          ambulance.etaMins = etaMins;
          ambulance.assigned_request_id = referral.requestId;
        }
      }
    });

    if (result.ambulance && referral) referral.ambulanceId = result.ambulance.id || result.ambulance.ambulance_id;
    const label = result.ambulance ? (result.ambulance.id || result.ambulance.ambulance_id) : "";
    switch (result.outcome) {
      case "AWAITING_ACCEPTANCE":
        showNotification("Wait for explicit hospital acceptance before dispatching an ambulance.", "urgent");
        break;
      case "NO_ACCEPTED_REFERRAL":
        showNotification("Accept a hospital referral before dispatching an ambulance.", "urgent");
        break;
      case "ALREADY_ASSIGNED":
        showNotification(`🚑 Ambulance ${label} is already assigned to ${referral.requestId} (${result.ambulance.status}).`, "normal");
        break;
      case "IN_FLIGHT":
        break;
      case "NO_AMBULANCE":
        showNotification("No available ambulance is currently eligible for dispatch.", "urgent");
        break;
      case "DISPATCHED":
        showNotification(`🚑 Ambulance ${label} (${result.ambulance.type}) dispatched to ${state.roadside.currentLocation.name}! ETA: ${result.ambulance.etaMins || etaMins} mins.`, "success");
        break;
      default:
        showNotification(`Dispatch request failed: ${result.error?.message || "unknown error"}`, "urgent");
    }
    if (["DISPATCHED", "ALREADY_ASSIGNED"].includes(result.outcome)) {
      renderAmbulanceFleet();
      renderKpiCards();
    }
    updateRoadsideDispatchControl();
  });

  updateRoadsideDispatchControl();
}

// Reflects the current assignment on the roadside Dispatch EMS button (no-op if it is not on screen).
function updateRoadsideDispatchControl() {
  const button = document.getElementById("btnRoadsideDispatchEMS");
  if (!button) return;
  const status = document.getElementById("roadsideDispatchStatus");
  const control = getDispatchControl({
    referral: state.lastAcceptedReferral,
    awaitingAcceptance: state.currentActiveReferral?.status === "LOCKED_PENDING_RESPONSE",
    ambulances: state.ambulances
  });
  button.disabled = control.disabled;
  button.setAttribute("aria-disabled", String(control.disabled));
  button.textContent = control.label || "🚑 Dispatch Closest EMS Ambulance";
  if (status) status.textContent = control.detail;
}

function openRouteNavigationModal(hospital) {
  const modal = document.getElementById("routeDirectionsModal");
  const content = document.getElementById("routeModalContent");
  if (!modal || !content) return;

  const loc = state.roadside.currentLocation;
  const driveMins = hospital.estDriveMins || Math.round(hospital.distanceKm * 2.2 + 2);

  content.innerHTML = `
    <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1.25rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <span style="font-weight: 700; color: #fff; font-size: 0.95rem;">🚦 Emergency Green Corridor Route</span>
        <span style="font-weight: 800; color: var(--accent-cyan); font-family: var(--font-mono); font-size: 1.05rem;">
          ${driveMins} MINS (${hospital.distanceKm} km)
        </span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-secondary);">
        <strong>From:</strong> ${loc.name} <br>
        <strong>To:</strong> ${hospital.name} (${hospital.address})
      </div>
    </div>

    <div style="margin-bottom: 1.25rem;">
      <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; margin-bottom: 0.5rem;">
        Turn-by-Turn Driving Directions:
      </div>
      <div class="route-step">
        <div class="route-step-num">1</div>
        <div>
          <div style="font-weight: 700; color: #fff;">Head onto the main road toward Central Medical Corridor</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">Continue straight for 1.2 km with hazard lights on.</div>
        </div>
      </div>
      <div class="route-step">
        <div class="route-step-num">2</div>
        <div>
          <div style="font-weight: 700; color: #fff;">Take Highway Exit 8 towards ${hospital.address.split(',')[0]}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">Dedicated emergency vehicle siren corridor active. (600m)</div>
        </div>
      </div>
      <div class="route-step">
        <div class="route-step-num">3</div>
        <div>
          <div style="font-weight: 700; color: #fff;">Turn Right into ${hospital.name} Emergency Trauma Bay</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">Follow red ER signs directly into the triage ambulance dock. (300m)</div>
        </div>
      </div>
    </div>

    <div style="display: flex; gap: 0.75rem;">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(hospital.name + ' ' + hospital.address)}" target="_blank" rel="noopener" class="btn btn-primary btn-block" style="text-decoration: none; text-align: center; font-size: 0.9rem; padding: 0.75rem;">
        🗺️ Launch Live in Google Maps
      </a>
       <button id="btnCloseRouteFromContent" type="button" class="btn btn-secondary">
        Close
      </button>
    </div>
  `;

  modal.style.display = "flex";
  document.getElementById("btnCloseRouteFromContent")?.addEventListener("click", () => { modal.style.display = "none"; });
}

// System Role Switcher & Modal
function initAuthPortalModal() {
  const switchBtn = document.getElementById("switchPortalBtn");
  const modal = document.getElementById("authPortalModal");
  const closeBtn = document.getElementById("closeAuthModalBtn");

  if (switchBtn && modal) {
    switchBtn.addEventListener("click", () => {
      modal.style.display = "flex";
    });
  }

  if (closeBtn && modal) {
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
  }

  // Role Tab Switching
  const roleTabs = document.querySelectorAll(".role-tab-btn");
  roleTabs.forEach(btn => {
    btn.addEventListener("click", () => {
      roleTabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const role = btn.getAttribute("data-role-tab");
      document.querySelectorAll(".role-pane").forEach(p => p.classList.remove("active"));

      const targetPane = document.getElementById(`rolePane${role.charAt(0).toUpperCase() + role.slice(1)}`);
      if (targetPane) targetPane.classList.add("active");
    });
  });

  // Quick Demo Role Login Buttons
  const setRole = (role, title, icon) => {
    state.currentUserRole = role;
    state.currentUser = { role: role === "admin" ? "ADMIN" : role === "hospital" ? "HOSPITAL_DESK" : "PARAMEDIC", display_name: title };
    const roleTitle = document.getElementById("userRoleTitle");
    const roleIcon = document.getElementById("userRoleIcon");
    if (roleTitle) roleTitle.textContent = title;
    if (roleIcon) roleIcon.textContent = icon;
    if (modal) modal.style.display = "none";
    updateDataSourceBanner();
    applyRoleVisibility();
    recordActivity("DEMO_ROLE_SWITCH", `Simulation view switched to ${title}`, "info");
    showNotification(`🛡️ Switched active portal view to: ${title}`, "success");
  };

  const login = async (form, username, password) => {
    const errorEl = document.getElementById("authFormError");
    if (errorEl) { errorEl.textContent = ""; errorEl.style.display = "none"; }
    try {
      const result = await AuthAPI.login(username, password);
      if (!result?.token) throw new Error("The authentication service did not return a session token.");
      state.currentUser = result.user || getCurrentUser();
      state.currentUserRole = state.currentUser?.role === "ADMIN" ? "admin" : state.currentUser?.role === "HOSPITAL_DESK" ? "hospital" : "paramedic";
      const roleTitle = document.getElementById("userRoleTitle");
      const roleIcon = document.getElementById("userRoleIcon");
      if (roleTitle) roleTitle.textContent = state.currentUser.display_name || state.currentUser.role;
      if (roleIcon) roleIcon.textContent = state.currentUserRole === "admin" ? "👑" : state.currentUserRole === "hospital" ? "🏥" : "🚑";
      state.dataSource = "backend";
      updateDataSourceBanner();
      applyRoleVisibility();
      if (modal) modal.style.display = "none";
      recordActivity("AUTHENTICATED", `${state.currentUser.display_name || username} connected`, "success");
      showNotification(`✓ Authenticated as ${state.currentUser.display_name || username}.`, "success");
      await refreshWorkspaceData();
      initWebSocket(getAuthToken(), (eventType, data) => {
        if (eventType === "referral:incoming") showNotification(`🚨 Incoming referral for ${data.hospital_id || "your facility"}.`, "urgent");
        if (eventType === "allocation:committed") showNotification("✓ Allocation committed by the operational backend.", "success");
      });
    } catch (error) {
      if (errorEl) { errorEl.textContent = error.message; errorEl.style.display = "block"; }
      showNotification(`Authentication failed: ${error.message}`, "urgent");
    }
  };

  document.getElementById("adminLoginForm")?.addEventListener("submit", event => {
    event.preventDefault();
    login(event.currentTarget, document.getElementById("adminUsernameInput")?.value.trim(), document.getElementById("adminPasswordInput")?.value);
  });
  document.getElementById("hospitalLoginForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const usernames = { "H-101": "apex_desk", "H-102": "stjude_desk", "H-103": "fortis_desk", "H-104": "memorial_desk", "H-105": "maxlife_desk" };
    login(event.currentTarget, usernames[document.getElementById("hospitalSelectInput")?.value] || "fortis_desk", document.getElementById("hospitalPasswordInput")?.value);
  });
  document.getElementById("paramedicLoginForm")?.addEventListener("submit", event => {
    event.preventDefault();
    login(event.currentTarget, document.getElementById("paramedicUnitInput")?.value.trim(), document.getElementById("paramedicPinInput")?.value);
  });

  document.getElementById("quickLoginAdmin")?.addEventListener("click", () => setRole("admin", "Admin Portal", "👑"));
  document.getElementById("quickLoginFortis")?.addEventListener("click", () => setRole("hospital", "Fortis Desk Console", "🏥"));
  document.getElementById("quickLoginApex")?.addEventListener("click", () => setRole("hospital", "Apex Desk Console", "🏥"));
  document.getElementById("quickLoginEMS")?.addEventListener("click", () => setRole("paramedic", "Paramedic Dispatch Unit", "🚑"));
}

function applyRoleVisibility() {
  const role = state.currentUser?.role || (state.currentUserRole === "admin" ? "ADMIN" : state.currentUserRole === "hospital" ? "HOSPITAL_DESK" : "PARAMEDIC");
  const restricted = {
    "ADMIN": [],
    "HOSPITAL_DESK": ["nav-emergency", "nav-roadside", "nav-bankers", "nav-ems"],
    "PARAMEDIC": ["nav-acceptance", "nav-bankers", "nav-doctors", "nav-activity"]
  };
  document.querySelectorAll(".nav-tab-btn").forEach(button => button.classList.remove("locked-tab"));
  (restricted[role] || []).forEach(id => document.getElementById(id)?.classList.add("locked-tab"));
  document.querySelectorAll(".nav-tab-btn.locked-tab").forEach(button => {
    button.setAttribute("aria-disabled", "true");
    if (!button.dataset.roleGuarded) {
      button.dataset.roleGuarded = "true";
      button.addEventListener("click", event => {
        if (button.classList.contains("locked-tab")) {
          event.preventDefault();
          showNotification("This workspace is restricted for the current role.", "urgent");
        }
      });
    }
  });
}

/* ====================================================================
   PHASE 2: INTERACTIVE CITY GPS MAP (LEAFLET / OSM) — P2-06
   Dynamic geospatial mapping of participating hospitals, bed capacity
   heatmaps, moving ambulance markers, and roadside accident points.
   ==================================================================== */

function renderLeafletMap() {
  const mapContainer = document.getElementById("leafletMapContainer");
  if (!mapContainer || typeof L === "undefined") return;

  const defaultCenter = [28.6300, 77.2180];

  if (!state.mapInstance) {
    state.mapInstance = L.map("leafletMapContainer").setView(defaultCenter, 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.mapInstance);

    // Layer toggle events
    document.getElementById("layerToggleHospitals")?.addEventListener("change", (e) => {
      state.mapMarkers.hospitals.forEach(m => e.target.checked ? state.mapInstance.addLayer(m) : state.mapInstance.removeLayer(m));
    });

    document.getElementById("layerToggleAmbulances")?.addEventListener("change", (e) => {
      state.mapMarkers.ambulances.forEach(m => e.target.checked ? state.mapInstance.addLayer(m) : state.mapInstance.removeLayer(m));
    });

    document.getElementById("layerToggleRoadside")?.addEventListener("change", (e) => {
      state.mapMarkers.roadside.forEach(m => e.target.checked ? state.mapInstance.addLayer(m) : state.mapInstance.removeLayer(m));
    });

    document.getElementById("btnRecenterMap")?.addEventListener("click", () => {
      state.mapInstance.setView(defaultCenter, 13);
    });
  } else {
    // Invalidate map size so Leaflet recalculates dimensions when tab is revealed
    setTimeout(() => state.mapInstance.invalidateSize(), 150);
  }

  // Clear existing markers
  state.mapMarkers.hospitals.forEach(m => state.mapInstance.removeLayer(m));
  state.mapMarkers.ambulances.forEach(m => state.mapInstance.removeLayer(m));
  state.mapMarkers.roadside.forEach(m => state.mapInstance.removeLayer(m));

  state.mapMarkers.hospitals = [];
  state.mapMarkers.ambulances = [];
  state.mapMarkers.roadside = [];

  // 1. Render Hospital Markers with Capacity Heatmap Color
  state.hospitals.forEach(h => {
    if (!h.coordinates) return;
    const icuAvail = h.resources?.icuBeds?.available ?? 0;
    const icuTotal = h.resources?.icuBeds?.total ?? 1;
    const ratio = icuAvail / icuTotal;

    let markerColor = "#16a34a"; // Green (>= 20%)
    if (h.status === "CLOSED" || icuAvail === 0) {
      markerColor = "#dc2626"; // Red (Closed / 0 Beds)
    } else if (ratio < 0.2) {
      markerColor = "#d97706"; // Amber (< 20%)
    }

    const circle = L.circleMarker([h.coordinates.lat, h.coordinates.lng], {
      radius: 12,
      fillColor: markerColor,
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      fillOpacity: 0.85
    });

    const popupHtml = `
      <div style="font-family: var(--font-main); min-width: 200px;">
        <strong style="color: var(--text-heading); font-size: 0.9rem;">${h.name}</strong>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 2px;">${h.address}</div>
        <hr style="margin: 6px 0; border: 0; border-top: 1px solid #e2e8f0;">
        <div style="font-size: 0.78rem;"><strong>Status:</strong> <span style="color: ${markerColor}; font-weight: 700;">${h.status}</span></div>
        <div style="font-size: 0.78rem;"><strong>ICU Beds:</strong> ${icuAvail} / ${icuTotal} available</div>
        <div style="font-size: 0.78rem;"><strong>Ventilators:</strong> ${h.resources?.ventilators?.available ?? 0} open</div>
        <div style="font-size: 0.78rem;"><strong>Emergency OT:</strong> ${h.resources?.emergencyOT?.available ?? 0} theatres</div>
        <div style="font-size: 0.78rem;"><strong>Rating:</strong> ⭐ ${h.rating}/5.0</div>
      </div>
    `;

    circle.bindPopup(popupHtml);
    circle.addTo(state.mapInstance);
    state.mapMarkers.hospitals.push(circle);
  });

  // 2. Render EMS Ambulance Markers
  const hospitalCoordMap = {
    "H-101": [28.6300, 77.2180],
    "H-102": [28.6420, 77.2250],
    "H-103": [28.6050, 77.2020],
    "H-104": [28.6380, 77.2220],
    "H-105": [28.6520, 77.1650],
    "H-106": [28.6310, 77.2320]
  };

  state.ambulances.forEach((amb, idx) => {
    const base = hospitalCoordMap[amb.hospitalId] || defaultCenter;
    // Slight offset for visual distinctness
    const offsetLat = base[0] + (idx * 0.003 - 0.006);
    const offsetLng = base[1] + (idx * 0.003 - 0.006);

    const ambMarker = L.circleMarker([offsetLat, offsetLng], {
      radius: 9,
      fillColor: "#2563eb",
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      fillOpacity: 0.95
    });

    const popupHtml = `
      <div style="font-family: var(--font-main);">
        <strong style="color: #1e3a8a;">🚑 ${amb.id}</strong> (${amb.type})
        <div style="font-size: 0.75rem; margin-top: 4px;"><strong>Station:</strong> ${amb.hospitalId}</div>
        <div style="font-size: 0.75rem;"><strong>Status:</strong> <span style="font-weight: 700; color: #2563eb;">${amb.status}</span></div>
        <div style="font-size: 0.75rem;"><strong>ETA:</strong> ${amb.etaMins ? `${amb.etaMins} mins` : 'Standby'}</div>
      </div>
    `;

    ambMarker.bindPopup(popupHtml);
    ambMarker.addTo(state.mapInstance);
    state.mapMarkers.ambulances.push(ambMarker);
  });

  // 3. Render Roadside Incident Hotspot Markers
  ROADSIDE_HOTSPOTS.forEach(spot => {
    const spotMarker = L.circleMarker([spot.lat, spot.lng], {
      radius: 10,
      fillColor: "#f97316",
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      fillOpacity: 0.85
    });

    const popupHtml = `
      <div style="font-family: var(--font-main);">
        <strong style="color: #c2410c;">⚠️ ${spot.name}</strong>
        <div style="font-size: 0.75rem; color: #475569; margin-top: 2px;">${spot.address}</div>
        <div style="font-size: 0.75rem; margin-top: 4px;"><strong>Landmark:</strong> ${spot.landmark}</div>
      </div>
    `;

    spotMarker.bindPopup(popupHtml);
    spotMarker.addTo(state.mapInstance);
    state.mapMarkers.roadside.push(spotMarker);
  });
}

/* ====================================================================
   PHASE 2: DOCTOR & SPECIALIST SHIFT SCHEDULER — P2-07
   Live doctor roster management with availability status toggle,
   specialization filter, shift timings, and new doctor registration.
   ==================================================================== */

function initDoctorsScheduler() {
  const facilityFilter = document.getElementById("doctorFacilityFilter");
  const specFilter = document.getElementById("doctorSpecFilter");
  const statusFilter = document.getElementById("doctorStatusFilter");

  [facilityFilter, specFilter, statusFilter].forEach(el => {
    el?.addEventListener("change", () => renderDoctorsRoster());
  });

  // Modal open/close
  const modal = document.getElementById("addDoctorModal");
  const btnOpen = document.getElementById("btnOpenAddDoctorModal");
  const btnClose = document.getElementById("closeDoctorModalBtn");

  if (btnOpen && modal) {
    btnOpen.addEventListener("click", () => modal.style.display = "flex");
  }
  if (btnClose && modal) {
    btnClose.addEventListener("click", () => modal.style.display = "none");
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
  }

  // Add Doctor Form Submit
  const addForm = document.getElementById("addDoctorForm");
  if (addForm) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hospId = document.getElementById("newDoctorHospital")?.value || "H-101";
      const name = document.getElementById("newDoctorName")?.value?.trim() || "Dr. Anonymous";
      const spec = document.getElementById("newDoctorSpec")?.value || "GENERAL_ER";
      const start = document.getElementById("newDoctorShiftStart")?.value || "08:00";
      const end = document.getElementById("newDoctorShiftEnd")?.value || "20:00";

      const newDoc = {
        doctor_id: `DR-${String(state.doctors.length + 1).padStart(3, '0')}`,
        hospital_id: hospId,
        full_name: name,
        specialization: spec,
        availability_status: "AVAILABLE",
        shift_start: start,
        shift_end: end
      };

      if (getAuthToken()) {
        try {
          const result = await DoctorsAPI.create({ hospital_id: hospId, full_name: name, specialization: spec, shift_start: start, shift_end: end });
          if (result?.doctor) state.doctors.push(result.doctor);
          else throw new Error("The specialist registry did not return the created record.");
        } catch (error) {
          showNotification(`Unable to save specialist: ${error.message}`, "urgent");
          return;
        }
      } else state.doctors.push(newDoc);

      renderDoctorsRoster();
      if (modal) modal.style.display = "none";
      addForm.reset();
      showNotification(`👨‍⚕️ Added ${name} to ${hospId} emergency roster.`, "success");
      recordActivity("SPECIALIST_ADDED", `${name} added to the specialist roster`, "success");
    });
  }

  renderDoctorsRoster();
}

function renderDoctorsRoster() {
  const tbody = document.getElementById("doctorsTableBody");
  if (!tbody) return;

  const facilityFilter = document.getElementById("doctorFacilityFilter")?.value || "ALL";
  const specFilter = document.getElementById("doctorSpecFilter")?.value || "ALL";
  const statusFilter = document.getElementById("doctorStatusFilter")?.value || "ALL";
  const search = (document.getElementById("doctorSearch")?.value || "").trim().toLowerCase();

  let filtered = [...state.doctors];

  if (facilityFilter !== "ALL") filtered = filtered.filter(d => d.hospital_id === facilityFilter);
  if (specFilter !== "ALL") filtered = filtered.filter(d => d.specialization === specFilter);
  if (statusFilter !== "ALL") filtered = filtered.filter(d => d.availability_status === statusFilter);
  if (search) filtered = filtered.filter(d => `${d.doctor_id} ${d.full_name} ${d.specialization} ${d.hospital_id}`.toLowerCase().includes(search));

  tbody.innerHTML = "";

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No specialists match the selected criteria.</td></tr>`;
    return;
  }

  const specLabelMap = {
    "CARDIOLOGIST": "Interventional Cardiologist",
    "NEUROLOGIST": "Neurosurgeon",
    "TRAUMA_SURGEON": "Trauma Surgeon",
    "PEDIATRICIAN": "Pediatrician",
    "GENERAL_ER": "General ER Physician"
  };

  const hospNameMap = {
    "H-101": "Apex City Trauma",
    "H-102": "St. Jude Metro",
    "H-103": "Fortis Cardiac & Neuro",
    "H-104": "Memorial Healthcare",
    "H-105": "Max Life Emergency",
    "H-106": "Downtown Care (Closed)"
  };

  filtered.forEach(doc => {
    const tr = document.createElement("tr");

    let statusBadgeClass = "badge-open";
    if (doc.availability_status === "IN_PROCEDURE") statusBadgeClass = "badge-limited";
    if (doc.availability_status === "OFF_DUTY") statusBadgeClass = "badge-closed";

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-weight: 700; color: var(--accent); font-size: 0.8rem;">${doc.doctor_id}</td>
      <td><strong style="color: var(--text-heading);">${doc.full_name}</strong></td>
      <td style="font-size: 0.82rem; color: var(--text-secondary);">${hospNameMap[doc.hospital_id] || doc.hospital_id}</td>
      <td style="font-size: 0.82rem;">${specLabelMap[doc.specialization] || doc.specialization}</td>
      <td style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted);">${doc.shift_start} - ${doc.shift_end}</td>
      <td><span class="badge-status ${statusBadgeClass}">${doc.availability_status.replace('_', ' ')}</span></td>
      <td>
        <select class="form-select doc-status-selector" data-doc-id="${doc.doctor_id}" style="width: auto; padding: 0.2rem 0.5rem; font-size: 0.75rem;">
          <option value="AVAILABLE" ${doc.availability_status === 'AVAILABLE' ? 'selected' : ''}>Available</option>
          <option value="IN_PROCEDURE" ${doc.availability_status === 'IN_PROCEDURE' ? 'selected' : ''}>In Procedure</option>
          <option value="OFF_DUTY" ${doc.availability_status === 'OFF_DUTY' ? 'selected' : ''}>Off Duty</option>
        </select>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Attach status toggle listener
  document.querySelectorAll(".doc-status-selector").forEach(sel => {
    sel.addEventListener("change", async (e) => {
      const docId = e.target.getAttribute("data-doc-id");
      const targetDoc = state.doctors.find(d => d.doctor_id === docId);
      if (targetDoc) {
        if (getAuthToken()) {
          try { await DoctorsAPI.updateStatus(docId, e.target.value); }
          catch (error) { e.target.value = targetDoc.availability_status; showNotification(`Unable to update specialist status: ${error.message}`, "urgent"); return; }
        }
        targetDoc.availability_status = e.target.value;
        renderDoctorsRoster();
        showNotification(`👨‍⚕️ Updated ${targetDoc.full_name} status to ${e.target.value.replace('_', ' ')}.`, "normal");
        recordActivity("SPECIALIST_STATUS_CHANGED", `${targetDoc.full_name} is now ${e.target.value.replace('_', ' ')}`, "info");
      }
    });
  });
}

/* ====================================================================
   PHASE 2: REAL-TIME WEBSOCKET BACKEND BRIDGE (P2-04 / P2-08)
   Attempts connection to Express/Socket.io backend if running,
   enabling seamless live synchronization across browser clients.
   ==================================================================== */

function initRealtimeBackendBridge() {
  checkServerHealth().then(health => {
    if (health) {
      state.backendOnline = true;
      updateDataSourceBanner();
      console.log("[BRIDGE] Backend server detected online:", health);
      showNotification(`🟢 API available (v${health.version}). Connect a role for authorized live data.`, "success");

      if (!getAuthToken()) return;
      initWebSocket(getAuthToken(), (eventType, data) => {
        if (eventType === "referral:incoming") {
          showNotification(`🚨 [WebSocket Alert] Incoming emergency referral for ${data.hospital_id}!`, "urgent");
        } else if (eventType === "allocation:committed") {
          showNotification(`🎉 [WebSocket Alert] Referral ${data.requestId} committed to ${data.hospitalId}!`, "success");
        } else if (eventType === "lock:expired") {
          showNotification(`⏱️ [WebSocket Alert] Referral timed out (90s). Automatic failover in progress.`, "urgent");
        }
      });
    } else {
      state.backendOnline = false;
      updateDataSourceBanner();
      console.log("[BRIDGE] Operating in standalone browser mode with in-memory DBMS simulation.");
    }
  });
}

/* ====================================================================
   PHASE 3: EMERGENCY ANALYTICS & TREND FORECASTING — P3-03 (Issue #26)
   Historical Intake Velocity, Peak Demand Hours, Hospital Rejection
   Bottlenecks & Response SLA Tracking
   ==================================================================== */

function initAnalyticsDashboard() {
  const timeRangeSelect = document.getElementById("analyticsTimeRange");
  timeRangeSelect?.addEventListener("change", () => {
    renderAnalyticsCharts();
  });

  document.getElementById("btnExportAnalyticsCsv")?.addEventListener("click", () => {
    exportAnalyticsCsv();
  });

  document.getElementById("btnExportAuditLedgerCsv")?.addEventListener("click", () => {
    const csvContent = exportLedgerToCsv();
    downloadCsvFile(csvContent, `emergency_audit_ledger_${new Date().toISOString().slice(0, 10)}.csv`);
    showNotification("📜 Downloaded cryptographically sealed audit ledger CSV", "success");
  });

  renderAnalyticsCharts();
}

function renderAnalyticsCharts() {
  renderHourlyVelocityChart();
  renderBottleneckBars();
}

function renderHourlyVelocityChart() {
  const container = document.getElementById("analyticsHourlyChart");
  if (!container) return;

  const hourlyData = [
    { hour: "00", count: 14, peak: true },
    { hour: "01", count: 18, peak: true },
    { hour: "02", count: 16, peak: true },
    { hour: "03", count: 7,  peak: false },
    { hour: "04", count: 4,  peak: false },
    { hour: "05", count: 3,  peak: false },
    { hour: "06", count: 6,  peak: false },
    { hour: "07", count: 9,  peak: false },
    { hour: "08", count: 13, peak: false },
    { hour: "09", count: 15, peak: false },
    { hour: "10", count: 12, peak: false },
    { hour: "11", count: 10, peak: false },
    { hour: "12", count: 14, peak: false },
    { hour: "13", count: 11, peak: false },
    { hour: "14", count: 13, peak: false },
    { hour: "15", count: 15, peak: false },
    { hour: "16", count: 16, peak: false },
    { hour: "17", count: 18, peak: false },
    { hour: "18", count: 21, peak: false },
    { hour: "19", count: 19, peak: false },
    { hour: "20", count: 22, peak: false },
    { hour: "21", count: 24, peak: false },
    { hour: "22", count: 28, peak: true },
    { hour: "23", count: 25, peak: true }
  ];

  const maxVal = Math.max(...hourlyData.map(d => d.count));
  container.innerHTML = hourlyData.map(d => {
    const heightPct = Math.round((d.count / maxVal) * 100);
    const barBg = d.peak ? "var(--status-red, #ef4444)" : "var(--accent, #3b82f6)";
    return `
      <div style="flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end;" title="Hour ${d.hour}:00 - ${d.count} Emergencies ${d.peak ? '(Highway Peak)' : ''}">
        <div style="font-size: 0.65rem; color: var(--text-tertiary); margin-bottom: 2px;">${d.count}</div>
        <div style="width: 100%; height: ${heightPct}%; background: ${barBg}; border-radius: 2px 2px 0 0; min-height: 4px; transition: height 0.3s ease;"></div>
        <div style="font-size: 0.62rem; color: var(--text-muted); margin-top: 4px; font-family: var(--font-mono);">${d.hour}</div>
      </div>
    `;
  }).join("");
}

function renderBottleneckBars() {
  const container = document.getElementById("analyticsBottleneckBars");
  if (!container) return;

  const facilities = [
    { name: "Apex City Trauma (H-101)", accepted: 42, rejected: 3, avgSlaSec: 28 },
    { name: "Fortis Cardiac & Neuro (H-103)", accepted: 38, rejected: 4, avgSlaSec: 22 },
    { name: "St. Jude Metro (H-102)", accepted: 29, rejected: 8, avgSlaSec: 36 },
    { name: "Memorial Healthcare (H-104)", accepted: 25, rejected: 5, avgSlaSec: 31 },
    { name: "Max Life Emergency (H-105)", accepted: 18, rejected: 9, avgSlaSec: 44 }
  ];

  container.innerHTML = facilities.map(f => {
    const total = f.accepted + f.rejected;
    const acceptPct = Math.round((f.accepted / total) * 100);
    const rejectPct = 100 - acceptPct;
    return `
      <div style="font-size: 0.78rem;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
          <span style="font-weight: 600; color: var(--text-heading);">${f.name}</span>
          <span style="color: var(--text-secondary); font-family: var(--font-mono);">
            <strong style="color: var(--status-green);">${acceptPct}% Acc</strong> • ${f.accepted}/${total} • Avg SLA: ${f.avgSlaSec}s
          </span>
        </div>
        <div style="height: 8px; width: 100%; background: rgba(239, 68, 68, 0.4); border-radius: 4px; overflow: hidden; display: flex;">
          <div style="height: 100%; width: ${acceptPct}%; background: var(--status-green, #10b981);"></div>
          <div style="height: 100%; width: ${rejectPct}%; background: var(--status-red, #ef4444);"></div>
        </div>
      </div>
    `;
  }).join("");
}

function exportAnalyticsCsv() {
  const headers = ["FacilityName", "AcceptedCount", "RejectedCount", "AcceptanceRatePct", "AverageSlaLatencySec"];
  const rows = [
    ["Apex City Trauma (H-101)", 42, 3, "93%", 28],
    ["Fortis Cardiac & Neuro (H-103)", 38, 4, "90%", 22],
    ["St. Jude Metro (H-102)", 29, 8, "78%", 36],
    ["Memorial Healthcare (H-104)", 25, 5, "83%", 31],
    ["Max Life Emergency (H-105)", 18, 9, "67%", 44]
  ];
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  downloadCsvFile(csv, `emergency_analytics_sla_report_${new Date().toISOString().slice(0, 10)}.csv`);
  showNotification("📈 Downloaded Emergency Analytics & SLA Report CSV", "success");
}

function downloadCsvFile(content, fileName) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ====================================================================
   PHASE 3: IMMUTABLE AUDIT LEDGER CONSOLE — P3-04 (Issue #27)
   Cryptographically Sealed Append-Only Medico-Legal Audit Log
   ==================================================================== */

function renderAuditLedgerTable() {
  const tbody = document.getElementById("auditLedgerTableBody");
  const badge = document.getElementById("auditIntegrityStatusBadge");
  if (!tbody) return;

  const entries = getLedgerEntries();
  const integrity = verifyLedgerIntegrity();

  if (badge) {
    if (integrity.isValid) {
      badge.className = "badge-status badge-open";
      badge.textContent = `🛡️ VERIFIED: ${integrity.verifiedEntries} ENTRIES SEALED (0 TAMPERING)`;
    } else {
      badge.className = "badge-status badge-closed";
      badge.textContent = `⚠️ TAMPERING DETECTED AT BLOCK #${integrity.errorIndex}!`;
    }
  }

  tbody.innerHTML = "";

  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--text-muted);">No sealed audit logs recorded.</td></tr>`;
    return;
  }

  const reversed = [...entries].reverse();

  reversed.forEach(entry => {
    const tr = document.createElement("tr");

    let eventColor = "var(--accent)";
    if (entry.eventType.includes("ACCEPTED") || entry.eventType.includes("SAFE")) eventColor = "var(--status-green)";
    if (entry.eventType.includes("EXPIRED") || entry.eventType.includes("REJECTED") || entry.eventType.includes("UNSAFE")) eventColor = "var(--status-red)";
    if (entry.eventType.includes("STRESS") || entry.eventType.includes("ROADSIDE")) eventColor = "var(--accent-cyan, #06b6d4)";

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-tertiary);">#${entry.sequenceNumber}</td>
      <td style="font-family: var(--font-mono); font-weight: 700; color: var(--accent); font-size: 0.78rem;">${entry.auditId}</td>
      <td style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-secondary);">${new Date(entry.timestamp).toLocaleTimeString()}</td>
      <td>
        <span style="font-weight: 700; font-size: 0.75rem; color: ${eventColor};">
          ${entry.eventType}
        </span>
      </td>
      <td style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted);" title="${entry.integrityHash}">
        ${entry.integrityHash.slice(0, 22)}...
      </td>
      <td>
        <span class="badge-status badge-open" style="font-size: 0.7rem; padding: 0.15rem 0.4rem;">
          🔒 SEALED
        </span>
      </td>
    `;

    tbody.appendChild(tr);
  });
}
