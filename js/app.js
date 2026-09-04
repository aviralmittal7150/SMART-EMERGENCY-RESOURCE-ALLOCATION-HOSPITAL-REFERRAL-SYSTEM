import { initialHospitals, initialAmbulances, initialEmergencyQueue } from './data.js';
import { TRIAGE_LEVELS, EMERGENCY_PRESETS, comparePriority } from './triage.js';
import { rankHospitals, DEFAULT_WEIGHTS } from './ranking.js';
import { LockManager } from './locking.js';
import { BankersAlgorithm } from './bankers.js';

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
  activeTab: "tab-ingestion"
};

// Initialize Modules
const bankersEngine = new BankersAlgorithm();
const lockManager = new LockManager((lockState) => {
  renderHospitalAcceptanceView();
  renderKpiCards();
});

// DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
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
});

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
      <div style="font-size: 0.85rem; color: var(--text-secondary);">
        Scoring Model: <strong>Resource Fit (40%) + Acceptance (25%) + Capacity (20%) + Distance (15%)</strong>
      </div>
      <div style="font-size: 0.8rem; font-family: var(--font-mono); color: var(--status-blue);">
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
          <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">
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
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted);">
            Match breakdown: Fit ${hospital.breakdown.resourceFit}% | Cap ${hospital.breakdown.capacity}% | Dist ${hospital.breakdown.distance}%
          </div>
          <button class="btn btn-primary btn-sm btn-init-referral" data-hospital-id="${hospital.id}">
            ⚡ Place 90s Soft-Lock & Request Referral
          </button>
        </div>
      ` : `
        <div style="font-size: 0.75rem; color: var(--status-red); margin-top: 0.5rem; background: rgba(239, 68, 68, 0.1); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm);">
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

    <div class="panel" style="margin-top: 1.5rem; background: rgba(15, 23, 42, 0.9);">
      <div class="panel-header">
        <span class="panel-title">🚨 Patient Requirements & Clinical Triage</span>
        <span class="panel-badge">${request.requestId}</span>
      </div>
      
      <div class="grid-2col" style="font-size: 0.88rem; margin-bottom: 1rem;">
        <div>
          <div>👤 <strong>Patient:</strong> ${request.patientName} (Age: ${request.age})</div>
          <div>🩺 <strong>Condition:</strong> ${request.emergencyType}</div>
          <div>⚠️ <strong>Triage Severity:</strong> <span style="color: var(--status-red); font-weight: 700;">${request.priorityName}</span></div>
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
    const triageBadgeColor = TRIAGE_LEVELS[item.priority]?.color || "var(--status-blue)";

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-weight: 700; color: var(--status-blue);">${item.requestId}</td>
      <td><strong>${item.patientName}</strong> <span style="font-size: 0.75rem; color: var(--text-muted);">(${item.age}y)</span></td>
      <td>${item.emergencyType}</td>
      <td><span style="background: rgba(255,255,255,0.08); color: ${triageBadgeColor}; padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); font-size: 0.75rem; font-weight: 700;">P${item.priority}</span></td>
      <td><span class="badge-status ${item.status === 'ALLOCATED' ? 'badge-open' : item.status === 'WAITING' ? 'badge-limited' : 'badge-open'}">${item.status}</span></td>
      <td style="font-size: 0.82rem;">${item.assignedHospital}</td>
      <td style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted);">${item.requestTime}</td>
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
          <div style="font-size: 0.75rem; color: var(--text-muted);">${h.address}</div>
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
          <div style="font-size: 0.78rem; color: var(--text-muted);">${amb.type} • Stationed at ${amb.hospitalId}</div>
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
  banner.style.background = type === "urgent" ? "rgba(239, 68, 68, 0.9)" : type === "success" ? "rgba(16, 185, 129, 0.9)" : "rgba(56, 189, 248, 0.9)";

  setTimeout(() => {
    banner.style.display = "none";
  }, 6000);
}
