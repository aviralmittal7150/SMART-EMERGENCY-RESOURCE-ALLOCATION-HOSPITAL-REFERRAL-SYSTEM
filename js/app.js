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

// Global Application State
const state = {
  hospitals: JSON.parse(JSON.stringify(initialHospitals)),
  ambulances: JSON.parse(JSON.stringify(initialAmbulances)),
  emergencyQueue: JSON.parse(JSON.stringify(initialEmergencyQueue)),
  selectedTriage: 1,
  selectedEmergencyType: "CARDIAC",
  customRequirements: {
    requiredBeds: 1,
    requiredVents: 1,
    requiredOT: 0,
    specialist: "cardiologist"
  },
  currentActiveReferral: null,
  activeTab: "tab-ingestion",
  currentUserRole: "admin",
  roadside: {
    currentLocation: ROADSIDE_HOTSPOTS[0],
    selectedSymptomIds: ["unconscious", "severe_head_injury", "crushed_limb_fracture"],
    symptomText: "Motorcycle crash on Highway 44. Rider unconscious, bleeding from head, compound fracture on leg.",
    isListening: false,
    recognition: null,
    lastAnalysis: null,
    lastRanked: []
  }
};

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
});

// Theme Toggle Engine (Dark / Light Mode)
function initTheme() {
  const toggleBtn = document.getElementById("themeToggleBtn");
  const toggleIcon = document.getElementById("themeToggleIcon");
  const toggleText = document.getElementById("themeToggleText");

  // Read saved preference or system preference
  const savedTheme = localStorage.getItem("ser_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialTheme = savedTheme || (prefersDark ? "dark" : "light");

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
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const targetId = tab.getAttribute("data-tab");
      state.activeTab = targetId;
      document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");

      // Re-render views on tab switch
      if (targetId === "tab-roadside") performRoadsideAnalysis();
      if (targetId === "tab-ranking") renderRankingResults();
      if (targetId === "tab-command") {
        renderKpiCards();
        renderHospitalsDirectory();
      }
      if (targetId === "tab-acceptance") renderHospitalAcceptanceView();
      if (targetId === "tab-bankers") renderBankersView();
      if (targetId === "tab-ambulance") renderAmbulanceFleet();
    });
  });
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

  form.addEventListener("submit", (e) => {
    e.preventDefault();
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

    // Insert into Priority Queue (sorted by comparePriority)
    state.emergencyQueue.push(newRequest);
    state.emergencyQueue.sort(comparePriority);

    // Switch to Ranking Tab automatically
    triggerTabSwitch("tab-ranking");
    renderRankingResults();
    renderEmergencyQueue();
    renderKpiCards();
    showNotification(`🚨 Emergency Registered: ${newRequest.requestId} (${newRequest.priorityName}) - Matching suitable hospitals...`, "urgent");
  });
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

function initiateReferralLock(hospital) {
  const latestWaiting = state.emergencyQueue.find(e => e.status === "WAITING") || state.emergencyQueue[0];
  
  state.currentActiveReferral = {
    hospital,
    request: latestWaiting
  };

  lockManager.acquireLock(hospital, latestWaiting, () => {
    // Timeout Callback -> Auto Failover
    showNotification(`⏱️ Referral timeout (90s) for ${hospital.name}. Automatically failing over to next candidate hospital!`, "urgent");
    renderRankingResults();
  });

  triggerTabSwitch("tab-acceptance");
  showNotification(`🔒 90-Second Soft-Lock placed on ${hospital.name} for Request ${latestWaiting.requestId}. Awaiting hospital handshake!`, "success");
}

// Hospital Acceptance Terminal View
function renderHospitalAcceptanceView() {
  const container = document.getElementById("acceptanceConsoleContent");
  if (!container) return;

  const lock = lockManager.activeLock;

  if (!lock) {
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📡</div>
        <h3>No Active Referral Locks in Progress</h3>
        <p style="font-size: 0.85rem; margin-top: 0.4rem;">Select an emergency case from the Ranking Engine to initiate a 90-second soft-lock request.</p>
        <button class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="document.querySelector('[data-tab=tab-ranking]').click()">
          Go to Hospital Ranking
        </button>
      </div>
    `;
    return;
  }

  const { hospital, request, remainingSec } = lock;

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
          <div>🔒 <strong>Resources Locked:</strong> 1 ICU Bed (Soft Reservation)</div>
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

  document.getElementById("btnAcceptReferral")?.addEventListener("click", () => {
    const committed = lockManager.commitAllocation();
    if (committed) {
      if (request) {
        request.status = "ALLOCATED";
        request.assignedHospital = hospital.name;
      }
      showNotification(`🎉 ${hospital.name} ACCEPTED referral for ${request.patientName}! Bed atomically committed. Ambulance dispatched.`, "success");
      renderEmergencyQueue();
      renderKpiCards();
    }
  });

  document.getElementById("btnRejectReferral")?.addEventListener("click", () => {
    lockManager.rejectAllocation(() => {
      showNotification(`❌ Referral rejected by ${hospital.name}. Soft-lock released. Automatically rerouting to next candidate...`, "urgent");
      renderRankingResults();
    });
  });
}

// Emergency Queue Render
function renderEmergencyQueue() {
  const tbody = document.getElementById("emergencyQueueTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";
  state.emergencyQueue.forEach(item => {
    const tr = document.createElement("tr");
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
    tbody.appendChild(tr);
  });
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

  container.innerHTML = "";
  state.ambulances.forEach(amb => {
    const card = document.createElement("div");
    card.className = "hospital-card";
    const statusBadge = amb.status === "AVAILABLE" ? "badge-open" : amb.status === "IN_TRANSIT" ? "badge-limited" : "badge-closed";

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
        <button class="btn btn-secondary btn-sm" onclick="alert('Dispatch route telemetry updated for ${amb.id}')">
          📍 View GPS Route
        </button>
      </div>
    `;
    container.appendChild(card);
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
        <button class="btn btn-primary" style="margin-top: 1rem;" onclick="alert('Contacting Central EMS Disaster Command for inter-region airlift...')">
          📞 Request Central Air-Ambulance Evacuation
        </button>
      </div>
    `;
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

  document.getElementById("btnRoadsidePreAlert")?.addEventListener("click", () => {
    // 1-Click Pre-Alert ER: Creates an active emergency request, locks soft-reservation, and notifies hospital!
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

    state.emergencyQueue.unshift(newRequest);
    state.emergencyQueue.sort(comparePriority);

    initiateReferralLock(topHospital);
    showNotification(`🚨 1-Click ER Pre-Alert Transmitted to ${topHospital.name}! Trauma scrub team alerted. Soft lock active!`, "urgent");
  });

  document.getElementById("btnRoadsideDispatchEMS")?.addEventListener("click", () => {
    const availableAmb = state.ambulances.find(a => a.status === "AVAILABLE") || state.ambulances[0];
    if (availableAmb) {
      availableAmb.status = "IN_TRANSIT";
      availableAmb.etaMins = Math.max(3, Math.round(topHospital.distanceKm * 1.5));
      renderAmbulanceFleet();
      renderKpiCards();
      showNotification(`🚑 Ambulance ${availableAmb.id} (${availableAmb.type}) dispatched to ${state.roadside.currentLocation.name}! ETA: ${availableAmb.etaMins} mins.`, "success");
    }
  });
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
      <button class="btn btn-secondary" onclick="document.getElementById('routeDirectionsModal').style.display='none'">
        Close
      </button>
    </div>
  `;

  modal.style.display = "flex";
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
    const roleTitle = document.getElementById("userRoleTitle");
    const roleIcon = document.getElementById("userRoleIcon");
    if (roleTitle) roleTitle.textContent = title;
    if (roleIcon) roleIcon.textContent = icon;
    if (modal) modal.style.display = "none";
    showNotification(`🛡️ Switched active portal view to: ${title}`, "success");
  };

  document.getElementById("quickLoginAdmin")?.addEventListener("click", () => setRole("admin", "Admin Portal", "👑"));
  document.getElementById("quickLoginFortis")?.addEventListener("click", () => setRole("hospital", "Fortis Desk Console", "🏥"));
  document.getElementById("quickLoginApex")?.addEventListener("click", () => setRole("hospital", "Apex Desk Console", "🏥"));
  document.getElementById("quickLoginEMS")?.addEventListener("click", () => setRole("paramedic", "Paramedic Dispatch Unit", "🚑"));
}

