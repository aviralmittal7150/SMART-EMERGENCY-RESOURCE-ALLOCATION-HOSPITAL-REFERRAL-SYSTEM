// js/app.js
// ERIS operations console. Every operational figure on screen comes from the ERIS server (REST + Socket.IO) for the
// signed-in user; there is no mock data and no local fallback. Server strings are rendered through dom.js (textContent),
// never innerHTML.

import {
  el, mount, byId, setText, show, fmtDateTime, fmtTime, fmtStatus, fmtNumber, downloadCsv
} from './dom.js';
import {
  ApiError, AuthAPI, HospitalsAPI, EmergenciesAPI, IncidentsAPI, ReferralsAPI, DoctorsAPI, AmbulancesAPI, AnalyticsAPI, AuditAPI, AdminAPI, TrackingAPI, GeoAPI,
  onUnauthorized, storeToken, readStoredToken, getToken, REVOKED_SESSION, isTokenExpired, tokenExpiryMs, connectSocket, disconnectSocket, socketEmit
} from './api.js';
import { normalizeHospital, rankForCase, suggestForIncident, RESOURCE_LABELS, SPECIALIST_LABELS } from './recommend.js';
import { initBankersSimulator } from './bankers-ui.js';
import { SYMPTOM_DATABASE, analyzeRoadsideSymptoms } from './symptom_triage.js';
import { renderFirstAid } from './firstaid.js';
import { STAGED_PATHWAYS, stagedClaim, stagePlanFromClaim } from './staged.js';
import { createTrackingMap, addOsmTiles } from './tracking-map.js';
import { DEFAULT_VIEW, OPERATING_AREA, operatingAreaProblem } from './operating-area.js';

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
// Mirrors server/services/emergencyRequirements.js: the server resolves the final requirements; this only drives the form.
const TYPE_REQUIREMENTS = {
  CARDIAC: { resources: ['ICU_BED', 'VENTILATOR'], specialist: 'CARDIOLOGIST', triage: 'RED' },
  TRAUMA: { resources: ['ICU_BED', 'OT'], specialist: 'TRAUMA_SURGEON', triage: 'RED' },
  POLYTRAUMA: { resources: ['ICU_BED', 'OT'], specialist: 'TRAUMA_SURGEON', triage: 'RED' },
  STROKE: { resources: ['ICU_BED'], specialist: 'NEUROLOGIST', triage: 'YELLOW' },
  RESPIRATORY: { resources: ['ICU_BED', 'VENTILATOR'], specialist: null, triage: 'YELLOW' },
  PEDIATRIC: { resources: ['ICU_BED'], specialist: 'PEDIATRICIAN', triage: 'YELLOW' },
  GENERAL: { resources: [], specialist: null, triage: 'GREEN' }
};
const TRIAGE_CATEGORY_PRIORITY = Object.freeze({ RED: 1, YELLOW: 3, GREEN: 4 });
const TRIAGE_NAMES = { RED: 'Immediate', YELLOW: 'Urgent / delayed', GREEN: 'Minor' };
const categoryForPriority = priority => Number(priority) <= 2 ? 'RED' : Number(priority) === 3 ? 'YELLOW' : 'GREEN';
const triageLabel = (category, priority) => category || categoryForPriority(priority);
const LIFECYCLE = ['NEW', 'WAITING', 'MATCHING', 'ALLOCATED', 'IN_TREATMENT', 'COMPLETED'];
// Manual transitions the server allows (server/services/lifecycle.js); MATCHING and ALLOCATED only come from referrals.
const ADMIN_TRANSITIONS = {
  NEW: ['WAITING', 'CANCELLED'], WAITING: ['CANCELLED'], MATCHING: ['WAITING', 'CANCELLED'],
  ALLOCATED: ['IN_TREATMENT', 'COMPLETED', 'CANCELLED'], IN_TREATMENT: ['COMPLETED']
};
const REFERRABLE = ['NEW', 'WAITING', 'MATCHING'];
const TERMINAL = ['COMPLETED', 'CANCELLED'];
const ON_ROAD = ['DISPATCHED', 'IN_TRANSIT'];
const STATUS_BADGE = {
  NEW: 'badge-new', WAITING: 'badge-waiting', MATCHING: 'badge-matching', ALLOCATED: 'badge-allocated',
  IN_TREATMENT: 'badge-treatment', COMPLETED: 'badge-completed', CANCELLED: 'badge-cancelled',
  OPEN: 'badge-open', LIMITED: 'badge-limited', CLOSED: 'badge-closed',
  AVAILABLE: 'badge-open', DISPATCHED: 'badge-dispatched', IN_TRANSIT: 'badge-in-transit', MAINTENANCE: 'badge-closed',
  PENDING: 'badge-waiting', ACCEPTED: 'badge-allocated', REJECTED: 'badge-closed', EXPIRED: 'badge-closed'
};
const TAB_COPY = {
  'tab-command': ['Command center', 'Live demand, capacity, referrals and dispatch readiness across the network.'],
  'tab-ingestion': ['Cases', 'Register a patient and emergency, follow the priority queue and track each case.'],
  'tab-ranking': ['Recommendation', 'Hospitals that can treat the selected case, and the referral to the one you choose.'],
  'tab-acceptance': ['Acceptance console', 'Referrals waiting for this hospital. Nothing is committed until you accept.'],
  'tab-hospitals': ['Hospital network', 'Status, free critical resources and specialists for every facility.'],
  'tab-ambulance': ['Ambulance fleet', 'Unit status, assignment and dispatch.'],
  'tab-map': ['Regional map', 'Hospital capacity, ambulance positions and active case pickups.'],
  'tab-doctors': ['Specialist roster', 'Who is on call, where, and whether they can take a case now.'],
  'tab-activity': ['Audit ledger', 'The server\'s hash-chained audit trail and its verification.'],
  'tab-analytics': ['My registered patients', 'The cases you registered, with the times to acceptance, dispatch and completion the server recorded.'],
  'tab-tracking': ['Live tracking', 'Ambulance trips on the map: a simulated demo of dispatch, pickup and arrival. Positions are simulated, not real GPS.'],
  'tab-firstaid': ['First aid', 'General first aid while help is on the way. Static guidance: nothing is sent or saved.'],
  'tab-mci': ['Mass casualty', 'Incidents with many victims: triage (decision support), ambulance seats, a suggested hospital per victim and the referrals.'],
  'tab-roadside': ['Roadside assist', 'At the roadside: locate the patient, describe the injuries, find the nearest suitable hospital and pre-alert it.'],
  'tab-bankers': ['Banker\'s simulator', 'Offline teaching model of deadlock avoidance. It never touches live data.'],
  'tab-accounts': ['Accounts', 'Who can sign in to ERIS, with which role and links. Changes apply at once.']
};
// Three account types only: Admin (ADMIN), Hospital (HOSPITAL_DESK) and Fleet (PARAMEDIC, the ambulance crew).
const DEFAULT_TAB = { ADMIN: 'tab-command', HOSPITAL_DESK: 'tab-acceptance', PARAMEDIC: 'tab-ambulance' };
const ROLE_LABEL = { ADMIN: 'Admin', HOSPITAL_DESK: 'Hospital', PARAMEDIC: 'Fleet' };
const ACCOUNT_ROLES = Object.keys(DEFAULT_TAB);
const UNSUPPORTED_ACCOUNT = 'This account type is no longer used in ERIS. Ask the administrator for an Admin, Hospital or Fleet account.';
// What each role may do (server/services/accessPolicy.js).
const CREATES_CASES = ['ADMIN'];                    // Case registration and dispatch are command-centre actions.
const NETWORK_VIEW = ['ADMIN'];                    // every case, unit, lock; command_center events
const SEES_LOCKS = ['ADMIN', 'HOSPITAL_DESK'];     // GET /referrals/active

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────
const resource = () => ({ status: 'idle', data: null, error: null, seq: 0, at: null });
const RESOURCE_NAMES = ['hospitals', 'emergencies', 'ambulances', 'doctors', 'dashboard', 'referralHistory',
  'activeLocks', 'referralStats', 'audit', 'registrations', 'accounts', 'trips', 'patients', 'overview', 'incidents', 'incident'];

const S = {
  epoch: 0,
  user: null,
  activeTab: 'tab-command',
  res: Object.fromEntries(RESOURCE_NAMES.map(n => [n, resource()])),
  selectedRequestId: null,
  caseView: { requestId: null, status: 'idle', detail: null, audit: null, error: null, seq: 0 },
  caseCache: new Map(),       // requestId -> { status, data } (acceptance console case summaries)
  lockDeadlines: new Map(),   // acceptanceId -> deadline ms (server countdown)
  expiredHandled: new Set(),
  tracked: new Map(),         // acceptanceId -> { requestId, hospitalId, status } referrals this user initiated
  decisions: [],
  liveEvents: [],
  kpiLive: null,
  draft: { reject: new Map(), eta: new Map(), dispatch: new Map(), bed: new Map(), note: new Map(), capacity: new Map(), hospitalStatus: new Map() },
  intake: { triage: 'RED', extras: new Set(), pendingKey: null, outcomeUnknown: false, submitting: false },
  inFlight: new Set(),
  timers: { expiry: null, poll: null, reload: null },
  pendingReloads: new Set(),
  socketWasDown: false,
  map: null,
  accounts: { role: '', active: '', offset: 0, limit: 25, form: null }, // form: null | { mode: 'create' } | { mode: 'edit', userId }
  roadside: freshRoadsideState(),
  stageAdvance: null, // { requestId, phase: 'confirm'|'busy'|'done'|'error'|'unknown', plan, result?, message? }
  tracking: { selectedId: null, message: null, map: null }, // live-tracking tab
  mci: null // mass casualty tab (freshMciState)
};
S.mci = freshMciState();

function freshRoadsideState() {
  return { tags: new Set(), assessment: null, pendingKey: null, outcomeUnknown: false, submitting: false, caseId: null, message: null, gpsSeq: 0 };
}


const role = () => S.user?.role || null;
const can = (...roles) => roles.includes(role());
const hospitals = () => S.res.hospitals.data || [];
const hospitalName = id => hospitals().find(h => h.id === id)?.name || id || '—';
const queue = () => S.res.emergencies.data || [];
const patientOf = item => item?.patient || {};

// ──────────────────────────────────────────────────────────────────────────────
// Notifications
// ──────────────────────────────────────────────────────────────────────────────
let toastTimer = null;
function notify(message, tone = 'normal') {
  const banner = byId('globalNotificationBanner');
  if (!banner) return;
  banner.textContent = message;
  banner.className = `toast-enter toast-${tone}`;
  banner.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { banner.hidden = true; }, tone === 'urgent' ? 9000 : 6000);
}

function clearNotification() {
  clearTimeout(toastTimer);
  toastTimer = null;
  const banner = byId('globalNotificationBanner');
  if (banner) { banner.hidden = true; banner.textContent = ''; }
}

function pushLiveEvent(text, tone = 'info') {
  S.liveEvents.unshift({ text, tone, at: Date.now() });
  S.liveEvents = S.liveEvents.slice(0, 30);
  renderLiveEvents();
}

/** "IN_TREATMENT" -> "In treatment". */
const sentenceCase = v => { const t = fmtStatus(v).toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const errorText = err => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

// ── Generic loading / empty / error blocks ──
const stateMsg = (title, text, cls = '') => el('div', { class: ['state-msg', cls] }, el('strong', {}, title), text || '');
const loadingMsg = (what = 'Loading…') => el('div', { class: 'state-msg is-loading', role: 'status' }, what);
function errorMsg(err, retry) {
  return el('div', { class: 'state-msg is-error', role: 'alert' },
    el('strong', {}, 'Could not load this data'), errorText(err),
    retry ? el('div', {}, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: retry } }, 'Retry')) : null);
}
/** Returns a node for loading/error/empty, or null when `r` has data to render. */
function resourceGate(r, { empty, retry, isEmpty = d => Array.isArray(d) && d.length === 0 } = {}) {
  if (r.status === 'idle' || (r.status === 'loading' && r.data === null)) return loadingMsg();
  if (r.status === 'error' && r.data === null) return errorMsg(r.error, retry);
  if (r.data !== null && isEmpty(r.data)) return empty || stateMsg('Nothing to show', '');
  return null;
}

// Skip re-mounting a view whose inputs did not change, so background refreshes never wipe what the user is typing.
const renderSigs = new Map();
function unchanged(id, sig) {
  if (renderSigs.get(id) === sig) return true;
  renderSigs.set(id, sig);
  return false;
}

const badge = (status, text) => el('span', { class: ['badge-status', STATUS_BADGE[status] || 'badge-new'] }, text || fmtStatus(status));
const priorityBadge = p => { const category = categoryForPriority(p); return el('span', { class: ['badge-priority', `badge-triage-${category.toLowerCase()}`] }, category); };
// The lifecycle shown to people, built from the case status and its milestones (the server's statuses are unchanged):
// accepted by a hospital → ambulance on the way (trip phase / pickup) → arrival confirmed by the hospital → treatment.
const JOURNEY = ['ACCEPTED', 'IN_TRANSIT', 'ARRIVED', 'IN_TREATMENT', 'COMPLETED'];
const JOURNEY_TEXT = { ACCEPTED: 'Accepted', IN_TRANSIT: 'In transit', ARRIVED: 'Arrived', IN_TREATMENT: 'In treatment', COMPLETED: 'Completed' };
const MOVING_PHASES = ['EN_ROUTE_TO_PATIENT', 'ARRIVED_AT_PATIENT', 'PATIENT_PICKED_UP', 'EN_ROUTE_TO_HOSPITAL', 'ARRIVED_AT_HOSPITAL'];
/** { status, arrived_at, trip_phase, picked_up, ambulance_status } -> a JOURNEY stage, or null before acceptance. */
function journeyStage({ status, arrived_at: arrived, trip_phase: phase, picked_up: pickedUp, ambulance_status: unit } = {}) {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'IN_TREATMENT') return 'IN_TREATMENT';
  if (status !== 'ALLOCATED') return null;
  if (arrived) return 'ARRIVED';
  if (MOVING_PHASES.includes(phase) || pickedUp || unit === 'IN_TRANSIT') return 'IN_TRANSIT';
  return 'ACCEPTED';
}
function journeyBar(stage) {
  if (!stage) return null;
  const at = JOURNEY.indexOf(stage);
  return el('ol', { class: 'journey', dataset: { stage }, 'aria-label': `Journey: ${JOURNEY_TEXT[stage]}` }, JOURNEY.map((k, i) =>
    el('li', { class: ['journey-step', i < at && 'is-done', i === at && 'is-current'], 'aria-current': i === at ? 'step' : null }, JOURNEY_TEXT[k])));
}

/** A case registered as one patient of a multi-patient incident (POST /incidents). */
/** The journey stage of a queue item (GET /emergencies), from its status, arrival milestone and ambulance. */
function itemJourney(item) {
  const unit = item.assigned_ambulance_id ? (S.res.ambulances.data || []).find(a => a.ambulance_id === item.assigned_ambulance_id) : null;
  const trip = trips().filter(t => t.request_id === item.request_id).at(-1);
  return journeyStage({ status: item.status, arrived_at: item.arrived_at, trip_phase: trip ? tripPhase(trip) : null, ambulance_status: unit?.status });
}
const statusCell = item => {
  const stage = itemJourney(item);
  return [badge(item.status), stage && stage !== item.status ? el('span', { class: 'cell-muted journey-text', dataset: { stage } }, ` ${JOURNEY_TEXT[stage]}`) : null];
};
const incidentBadge = id => (id ? el('span', { class: 'badge-status badge-incident', dataset: { incidentId: id } }, `Incident ${id}`) : null);
const kv = (label, value) => el('div', { class: 'kv' }, el('div', { class: 'kv-label' }, label), el('div', { class: 'kv-value' }, value ?? '—'));
const resourceTags = (types, missing = new Set()) => (types && types.length
  ? el('div', { class: 'tag-list' }, types.map(t => el('span', { class: ['tag', missing.has(t) && 'is-missing'] }, RESOURCE_LABELS[t] || t)))
  : el('span', { class: 'cell-muted' }, 'None'));

// ──────────────────────────────────────────────────────────────────────────────
// Data loading
// ──────────────────────────────────────────────────────────────────────────────
const LOADERS = {
  hospitals: async () => (await HospitalsAPI.list()).hospitals.map(normalizeHospital),
  emergencies: async () => (await EmergenciesAPI.list()).queue,
  ambulances: async () => (await AmbulancesAPI.list()).ambulances,
  doctors: async () => (await DoctorsAPI.list()).doctors,
  dashboard: async () => (await AnalyticsAPI.getDashboard()).dashboard,
  referralHistory: async () => (await ReferralsAPI.history()).history,
  activeLocks: async () => (await ReferralsAPI.active()).active_locks,
  referralStats: async () => AnalyticsAPI.getReferrals(),
  audit: async () => (await AnalyticsAPI.getAudit(300)).audit_trail,
  accounts: async () => AdminAPI.listUsers({ role: S.accounts.role || undefined, active: S.accounts.active || undefined, limit: S.accounts.limit, offset: S.accounts.offset }),
  trips: async () => (await TrackingAPI.list()).trips,
  patients: async () => (await HospitalsAPI.patients(S.user.hospital_id)).patients,
  overview: async () => new Map(((await HospitalsAPI.overview()).hospitals || []).map(h => [h.hospital_id, h])),
  incidents: async () => (await IncidentsAPI.list()).incidents,
  incident: async () => (S.mci.openId ? IncidentsAPI.detail(S.mci.openId) : { incident: null, victims: [] }),
  registrations: async () => AnalyticsAPI.myRegistrations(Number(byId('registrationsWindow')?.value) || 28, 500)
};
const ALLOWED = {
  doctors: ['ADMIN', 'HOSPITAL_DESK'], // rosters: all for the admin, own for a hospital; the fleet none
  activeLocks: SEES_LOCKS,
  accounts: ['ADMIN'],
  trips: ['ADMIN', 'PARAMEDIC', 'HOSPITAL_DESK'], // the server scopes the list (own unit, own hospital)
  referralStats: ['ADMIN'], audit: ['ADMIN'], registrations: ['ADMIN'],
  patients: ['HOSPITAL_DESK'], // the desk's own hospital (GET /hospitals/:id/patients)
  overview: ['ADMIN'], incidents: ['ADMIN'], incident: ['ADMIN']
};
const RENDERERS = {
  hospitals: () => { renderHospitals(); renderRanking(); renderRoadside(); refreshTrackingForm(); renderMapData(); renderHospitalOptions(); renderAcceptance(); },
  emergencies: () => { renderQueue(); renderCommandQueue(); renderRanking(); renderFleet(); renderMapData(); refreshTrackingForm(); },
  ambulances: () => { refreshTrackingForm(); renderFleet(); renderFleetSummary(); renderMapData(); renderCaseTracker(); renderQueue(); renderCommandQueue(); renderIncidentPage(); },
  doctors: () => renderDoctors(),
  dashboard: () => { renderKpis(); renderCapacity(); },
  referralHistory: () => { renderQueue(); renderCommandQueue(); },
  activeLocks: () => { renderAcceptance(); renderKpis(); },
  referralStats: () => { renderKpis(); renderReferralSummary(); },
  audit: () => renderAudit(),
  registrations: () => renderRegistrations(),
  trips: () => { renderTracking(); renderQueue(); renderCommandQueue(); },
  accounts: () => renderAccounts(),
  patients: () => renderHospitalPatients(),
  overview: () => renderHospitals(),
  incidents: () => renderIncidents(),
  incident: () => renderIncidents()
};

async function load(name) {
  if (!S.user) return;
  if (ALLOWED[name] && !can(...ALLOWED[name])) return;
  const r = S.res[name];
  const epoch = S.epoch;
  const seq = ++r.seq;
  r.status = 'loading';
  RENDERERS[name]?.();
  try {
    const data = await LOADERS[name]();
    if (epoch !== S.epoch || seq !== r.seq) return;
    if (data === undefined || data === null) throw new ApiError('The server response is missing expected data.', { kind: 'parse' });
    r.data = data; r.status = 'ok'; r.error = null; r.at = Date.now();
    if (name === 'activeLocks') syncLockDeadlines(data);
    if (name === 'emergencies' && S.selectedRequestId && !can(...NETWORK_VIEW) && !data.some(q => q.request_id === S.selectedRequestId)) {
      S.selectedRequestId = null;
      S.caseView = { requestId: null, status: 'idle', detail: null, audit: null, error: null, seq: S.caseView.seq + 1 };
      renderCaseTracker(); renderRanking();
    }
  } catch (err) {
    if (epoch !== S.epoch || seq !== r.seq) return;
    r.status = 'error'; r.error = err;
  }
  RENDERERS[name]?.();
  renderDataBanner();
}

function loadMany(names) { return Promise.all(names.map(load)); }

function coreResources() {
  const names = ['hospitals', 'emergencies', 'ambulances', 'doctors', 'dashboard', 'referralHistory'];
  if (can(...SEES_LOCKS)) names.push('activeLocks');
  if (can('HOSPITAL_DESK')) names.push('patients');
  if (can('ADMIN')) names.push('referralStats');
  if (can('ADMIN') && S.res.accounts.status !== 'idle') names.push('accounts');
  if (can('ADMIN') && S.res.registrations.status !== 'idle') names.push('registrations');
  names.push('trips'); // the journey stage (in transit) of every case follows its trip
  if (can('ADMIN') && S.res.audit.status !== 'idle') names.push('audit');
  if (can('ADMIN')) ['overview', 'incidents', 'incident'].forEach(n => { if (S.res[n].status !== 'idle') names.push(n); });
  return names;
}
const loadAll = () => loadMany(coreResources());

/** Coalesce bursts of socket events into one reload per resource. */
function scheduleReload(names, delay = 300) {
  names.forEach(n => S.pendingReloads.add(n));
  clearTimeout(S.timers.reload);
  S.timers.reload = setTimeout(() => {
    const list = [...S.pendingReloads];
    S.pendingReloads.clear();
    loadMany(list);
  }, delay);
}

function renderDataBanner() {
  const failed = RESOURCE_NAMES.map(n => [n, S.res[n]]).filter(([, r]) => r.status === 'error');
  const banner = byId('dataSourceBanner');
  if (!banner) return;
  if (!S.user || failed.length === 0) { banner.hidden = true; return; }
  const [, first] = failed[0];
  setText('dataBannerTitle', failed.some(([, r]) => r.data !== null) ? 'Some data may be out of date.' : 'Some data could not be loaded.');
  setText('dataBannerText', `${errorText(first.error)} (${failed.map(([n]) => n).join(', ')})`);
  banner.hidden = false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────────────────────────────────────
function showSignedOut(message = '', tone = 'info') {
  document.body.classList.add('signed-out');
  document.body.classList.remove('booting');
  const notice = byId('authNotice');
  if (notice) {
    notice.textContent = message;
    notice.hidden = !message;
    notice.classList.toggle('is-error', tone === 'error');
  }
  setText('userRoleTitle', 'Signed out');
  setConnection('off', 'Not connected');
  focusLogin();
  requestAnimationFrame(focusLogin); // in case the portal was not focusable yet; never steals focus (see focusLogin)
}

/** Put the cursor in the username field, unless the user is already in the sign-in form (typing must not jump). */
function focusLogin() {
  if (!document.body.classList.contains('signed-out')) return;
  if (byId('loginForm')?.contains(document.activeElement)) return;
  byId('loginUsername')?.focus();
}

function clearSessionState() {
  S.epoch += 1;
  S.user = null;
  RESOURCE_NAMES.forEach(n => { S.res[n] = resource(); });
  S.selectedRequestId = null;
  S.caseView = { requestId: null, status: 'idle', detail: null, audit: null, error: null, seq: 0 };
  S.caseCache.clear(); S.lockDeadlines.clear(); S.expiredHandled.clear(); S.tracked.clear();
  S.decisions = []; S.liveEvents = []; S.kpiLive = null;
  Object.values(S.draft).forEach(m => m.clear());
  S.intake.pendingKey = null; S.intake.outcomeUnknown = false; S.intake.submitting = false;
  S.inFlight.clear(); S.pendingReloads.clear();
  S.accounts = { role: '', active: '', offset: 0, limit: 25, form: null };
  S.roadside = freshRoadsideState();
  S.mci = freshMciState();
  treatNotes.clear(); progressNotes.clear();
  S.stageAdvance = null;
  S.tracking.map?.destroy();
  S.tracking = { selectedId: null, message: null, map: null };
  lastServerReconnect = 0; // a new session gets its own reconnect allowance
  Object.values(S.timers).forEach(t => { clearTimeout(t); clearInterval(t); });
  S.timers = { expiry: null, poll: null, reload: null };
  if (S.map) { S.map.remove(); S.map = null; }
}

/** Remove every rendered operational value from the DOM (nothing from the previous session may remain visible). */
function clearViews() {
  renderSigs.clear();
  ['emergencyQueueTableBody', 'caseTrackerBody', 'caseTrackerActions', 'rankingCaseSummary', 'rankingReferralStatus',
    'rankingResultsContainer', 'acceptanceConsoleContent', 'acceptanceResult', 'hospitalsManagementGrid',
    'auditVerifyResult', 'auditLedgerTableBody', 'registrationsContent', 'rsResult', 'hospitalsDirectoryGrid', 'commandPriorityQueueBody',
    'commandReferralSummary', 'commandFleetSummary', 'commandActivityFeed', 'ambulanceFleetGrid', 'doctorsTableBody',
    'newDoctorHospital', 'leafletMapContainer', 'hospitalPatientsContent', 'mciList', 'mciIncident', 'csvPreview', 'mcRows'].forEach(id => mount(byId(id)));
  show('mciAdd', false); byId('mciCreateForm')?.reset(); byId('mcError') && (byId('mcError').hidden = true);
  { const f = byId('csvFile'); if (f) f.value = ''; }
  buildVictimRows();
  setText('mciIncidentCaption', 'Open an incident from the list.');
  ['kpiActiveEmergencies', 'kpiCriticalWaiting', 'kpiIcuAvailable', 'kpiVentilatorsAvailable', 'kpiHospitalsOpen',
    'kpiAmbulancesAvail', 'kpiReferralsPending', 'kpiReferralsAccepted', 'kpiReferralsClosed'].forEach(id => setText(id, '—'));
  ['queueResultCount', 'hospitalResultsCount', 'ambulanceResultsCount', 'auditResultCount', 'kpiUpdatedAt', 'mapCaption',
    'caseTrackerCaption'].forEach(id => setText(id, ''));
  const facility = byId('doctorFacilityFilter');
  if (facility) mount(facility, el('option', { value: 'ALL' }, 'All hospitals'));
  byId('emergencyIntakeForm')?.reset();
  renderLifecycle(null);
  byId('dataSourceBanner') && (byId('dataSourceBanner').hidden = true);
  byId('addDoctorModal')?.classList.remove('is-open');
  ['accountsTableBody', 'accountFormPanel', 'trackingTripSelect', 'trackingDetails', 'trackingControls', 'trackingAdmin', 'trackingMap'].forEach(id => mount(byId(id)));
  setText('trackingRouteLabel', ''); show('trackingMessage', false);
  { const n = byId('trackingMap'); if (n) ['ambulance', 'pickup', 'hospital'].forEach(k => delete n.dataset[k]); }
  const trkAdmin = byId('trackingAdmin'); if (trkAdmin) { mount(trkAdmin); delete trkAdmin.dataset.ready; }
  setText('accountResultCount', '');
  show('accountFormPanel', false);
  closeFirstAid();
  resetRoadsideForm();
  byId('openCaseForm')?.reset();
  // A shared device: the next person must not see who signed in before them.
  ['loginUsername', 'loginPassword'].forEach(id => { const n = byId(id); if (n) n.value = ''; });
  setPasswordVisible(false);
  show('openCaseError', false);
}

// An intake whose outcome was unknown when the session ended (lost answer, or still in flight) may have registered a
// case: say so on the sign-in screen and again after the next sign-in.
const INTAKE_UNSURE_NOTE = 'An emergency registration from the previous session may already have been saved: check the queue before registering it again.';
let intakeUnsureNotice = false;

function logout(message = '', tone = 'info') {
  if (S.intake.outcomeUnknown || S.roadside.outcomeUnknown) {
    intakeUnsureNotice = true;
    message = `${message ? `${message} ` : ''}${INTAKE_UNSURE_NOTE}`;
  }
  disconnectSocket();
  storeToken(null);
  clearSessionState();
  clearViews();
  clearNotification();
  showSignedOut(message, tone);
}

onUnauthorized(message => { if (S.user || document.body.classList.contains('booting')) logout(message, 'error'); });

/** Start a signed-in session; false (and signed out) for an account type ERIS no longer has. */
function startSession(user, token) {
  if (!ACCOUNT_ROLES.includes(user?.role)) {
    disconnectSocket();
    storeToken(null);
    clearSessionState();
    clearViews();
    showSignedOut(UNSUPPORTED_ACCOUNT, 'error');
    return false;
  }
  clearSessionState();
  S.user = user;
  storeToken(token);
  document.body.classList.remove('signed-out', 'booting');
  const hospitalPart = user.hospital_id ? ` · ${user.hospital_id}` : '';
  setText('userRoleTitle', `${user.display_name || user.username} (${ROLE_LABEL[user.role] || user.role}${hospitalPart})`);
  applyRole();

  const expiry = tokenExpiryMs(token);
  if (expiry) {
    // setTimeout cannot hold more than ~24.8 days; tokens here live hours.
    S.timers.expiry = setTimeout(() => logout('Your session expired. Please sign in again.', 'error'), Math.max(0, expiry - Date.now()));
  }
  S.timers.poll = setInterval(pollTrackedReferrals, 4000);

  setConnection('connecting', 'Connecting…');
  connectSocket(token, onSocketEvent);
  switchTab(DEFAULT_TAB[user.role] || 'tab-command');
  initIntakeForm();
  loadLocalities();
  loadAll();
  if (intakeUnsureNotice) {
    intakeUnsureNotice = false;
    if (can(...CREATES_CASES)) {
      const errorEl = byId('intakeError');
      if (errorEl) { errorEl.textContent = INTAKE_UNSURE_NOTE; errorEl.hidden = false; }
    }
  }
  return true;
}

async function restoreSession() {
  const token = readStoredToken();
  if (!token) return showSignedOut();
  if (isTokenExpired(token)) {
    storeToken(null);
    return showSignedOut('Your previous session expired. Please sign in again.');
  }
  storeToken(token);
  document.body.classList.add('booting');
  show('authBootStatus', true);
  const epoch = S.epoch;
  try {
    const me = await AuthAPI.me();
    if (epoch !== S.epoch) return;
    show('authBootStatus', false);
    if (!me?.user?.role) throw new ApiError('The server did not confirm your identity.', { kind: 'parse' });
    startSession(me.user, token);
  } catch (err) {
    show('authBootStatus', false);
    if (err.status === 401) {
      storeToken(null);
      showSignedOut(REVOKED_SESSION.test(err.message) ? err.message : 'Your session is no longer valid. Please sign in again.', 'error');
      return;
    }
    // Network or server error: keep the token (it may still be valid) but show nothing until it is confirmed.
    showSignedOut(`Could not confirm your session: ${errorText(err)} Reload the page to retry, or sign in again.`, 'error');
  }
}

// Too many failed sign-ins: the server locks the username for a while (HTTP 429) and says so.
const LOGIN_LOCKED = 'Too many attempts, try again later.';
function loginErrorText(err) {
  if (err instanceof ApiError && err.status === 429) return err.message && err.message !== `Request failed (HTTP 429).` ? `${LOGIN_LOCKED} ${err.message}` : LOGIN_LOCKED;
  return errorText(err);
}

/** "Show password" on the sign-in form: switches the input type; the button says what it will do and its state. */
function setPasswordVisible(visible) {
  const input = byId('loginPassword'); const btn = byId('loginPasswordToggle');
  if (input) input.type = visible ? 'text' : 'password';
  if (btn) { btn.setAttribute('aria-pressed', String(Boolean(visible))); btn.textContent = visible ? 'Hide password' : 'Show password'; }
}

function initLoginForm() {
  byId('loginForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const errorEl = byId('authFormError');
    const submit = byId('loginSubmitBtn');
    const username = byId('loginUsername').value.trim();
    const password = byId('loginPassword').value;
    errorEl.hidden = true;
    if (!username || !password) { errorEl.textContent = 'Enter your username and password.'; errorEl.hidden = false; return; }
    setPasswordVisible(false); // every submit hides the password again, whatever the outcome
    submit.disabled = true;
    try {
      const result = await AuthAPI.login(username, password);
      byId('loginPassword').value = '';
      show('authNotice', false);
      if (startSession(result.user, result.token)) notify(`Signed in as ${result.user.display_name || result.user.username}.`, 'success');
    } catch (err) {
      errorEl.textContent = loginErrorText(err);
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  byId('loginPasswordToggle')?.addEventListener('click', () => setPasswordVisible(byId('loginPassword')?.type === 'password'));
  byId('logoutBtn')?.addEventListener('click', () => logout('You have signed out.'));
}

// ── Role-derived UI ──
function applyRole() {
  const r = role();
  document.querySelectorAll('[data-roles]').forEach(node => {
    const allowed = node.getAttribute('data-roles').split(/\s+/);
    node.hidden = !r || !allowed.includes(r);
  });
  if (r && byId(S.activeTab)?.closest('[hidden]')) switchTab(DEFAULT_TAB[r]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Socket events
// ──────────────────────────────────────────────────────────────────────────────
function setConnection(stateName, label) {
  const ind = byId('liveIndicator');
  ind?.classList.toggle('is-live', stateName === 'live');
  ind?.classList.toggle('is-down', stateName === 'down');
  setText('connectionStatus', label);
}

const idOf = p => p?.acceptanceId ?? p?.acceptance_id ?? null;
const reqOf = p => p?.requestId ?? p?.request_id ?? null;
const hospOf = p => p?.hospitalId ?? p?.hospital_id ?? null;

function onSocketEvent(name, p = {}) {
  if (!S.user) return;
  switch (name) {
    case 'socket:connected':
      setConnection('live', 'Live');
      socketEmit('request:kpis');
      if (can(...SEES_LOCKS)) socketEmit('request:active_locks');
      if (S.socketWasDown) { S.socketWasDown = false; loadAll(); }
      break;
    case 'socket:disconnected':
      S.socketWasDown = true;
      if (p.reason === 'io server disconnect') onServerDisconnect();
      else setConnection('down', 'Reconnecting…');
      break;
    case 'socket:error':
      S.socketWasDown = true;
      setConnection('down', 'Live updates offline');
      // The server refuses the socket when the token is invalid or revoked: confirm with REST (a 401 signs out).
      if (/token|auth|session|account change/i.test(p.message || '')) AuthAPI.me().catch(() => {});
      break;
    case 'socket:unavailable':
      setConnection('down', 'Live updates unavailable');
      break;
    case 'kpis:update': {
      const prev = S.kpiLive;
      S.kpiLive = p;
      renderKpis();
      if (prev && ['active_emergencies', 'active_locks', 'ambulances_available', 'icu_available', 'hospitals_open'].some(k => prev[k] !== p[k])) {
        scheduleReload(['emergencies', 'ambulances', 'hospitals', 'dashboard', 'referralHistory', ...(can(...SEES_LOCKS) ? ['activeLocks'] : [])]);
      }
      break;
    }
    case 'locks:update':
      if (Array.isArray(p) && can(...SEES_LOCKS)) {
        Object.assign(S.res.activeLocks, { data: p, status: 'ok', error: null, at: Date.now() });
        syncLockDeadlines(p);
        renderAcceptance(); renderKpis();
      }
      break;
    case 'referral:incoming':
      notify(`Incoming referral ${reqOf(p) || ''} for ${hospitalName(hospOf(p))}: respond within ${p.remaining_sec ?? 90} s.`, 'urgent');
      pushLiveEvent(`Incoming referral ${reqOf(p)} → ${hospitalName(hospOf(p))}`, 'warning');
      if (idOf(p) && Number.isFinite(Number(p.remaining_sec))) S.lockDeadlines.set(idOf(p), Date.now() + Number(p.remaining_sec) * 1000);
      scheduleReload(['activeLocks', 'emergencies', 'hospitals', 'referralHistory'], 100);
      break;
    case 'referral:countdown':
      if (idOf(p) && Number.isFinite(Number(p.remaining_sec))) {
        setLockDeadline(idOf(p), Date.now() + Number(p.remaining_sec) * 1000);
        tickCountdowns(); // paint the server's figure now, not at the next 500 ms tick
      }
      break;
    case 'lock:acquired':
      pushLiveEvent(`Referral ${reqOf(p)} sent to ${hospitalName(hospOf(p))}`, 'warning');
      scheduleReload(['activeLocks', 'emergencies', 'hospitals', 'referralHistory']);
      afterCaseEvent(reqOf(p));
      break;
    case 'referral:accepted':
    case 'allocation:committed':
      pushLiveEvent(`Referral ${reqOf(p)} accepted by ${hospitalName(hospOf(p))}${p.ambulance_id ? `; ambulance ${p.ambulance_id} dispatched` : ''}`, 'success');
      scheduleReload(['activeLocks', 'emergencies', 'hospitals', 'ambulances', 'dashboard', 'referralHistory', 'referralStats']);
      afterCaseEvent(reqOf(p));
      break;
    case 'referral:rejected':
    case 'lock:released':
      pushLiveEvent(`Referral ${reqOf(p)} rejected by ${hospitalName(hospOf(p))}${p.next_hospital_id ? `; rerouted to ${hospitalName(p.next_hospital_id)}` : ''}`, 'critical');
      scheduleReload(['activeLocks', 'emergencies', 'hospitals', 'referralHistory', 'referralStats']);
      afterCaseEvent(reqOf(p), { ended: true });
      break;
    case 'referral:expired':
    case 'lock:expired':
    case 'lock:expired_cleanup':
      if (name === 'referral:expired') notify(`Referral ${reqOf(p) || ''} expired without an answer; the server is rerouting it.`, 'urgent');
      // The server says it expired: show "Expired" (and disable its buttons) now, before the reload removes the card.
      if (idOf(p)) { setLockDeadline(idOf(p), Date.now() - 1); tickCountdowns(); }
      pushLiveEvent(`Referral ${reqOf(p)} expired at ${hospitalName(hospOf(p))}${p.nextHospitalId ? `; rerouted to ${hospitalName(p.nextHospitalId)}` : ''}`, 'critical');
      scheduleReload(['activeLocks', 'emergencies', 'hospitals', 'referralHistory', 'referralStats']);
      afterCaseEvent(reqOf(p), { ended: true });
      break;
    case 'referral:status':
      handleReferralStatus(p);
      break;
    case 'tracking:update':
      applyTrackingUpdate(p);
      break;
    case 'case:status':
      onCaseStatus(p);
      break;
    case 'alert:new':
      pushLiveEvent(p.message ? String(p.message) : 'New alert', 'warning');
      break;
    case 'audit:entry':
      onAuditEntry(p);
      break;
    default:
      break;
  }
}

// The server closes a socket when its token expires or the account is deactivated or changed (it re-checks every
// 60 s), and socket.io does not reconnect on its own after that. Ask /auth/me: a 401 signs out (onUnauthorized);
// a confirmed account reconnects once. A second server disconnect within a minute is left for Refresh.
let lastServerReconnect = 0;
async function onServerDisconnect() {
  setConnection('down', 'Live updates stopped by the server');
  const epoch = S.epoch;
  try {
    const me = await AuthAPI.me();
    if (epoch !== S.epoch || !S.user) return;
    if (me?.user?.role !== S.user.role || (me.user.hospital_id ?? null) !== (S.user.hospital_id ?? null)) {
      logout('Your account was changed. Please sign in again.', 'error');
      return;
    }
    if (Date.now() - lastServerReconnect < 60_000) { setConnection('down', 'Live updates offline: press Refresh'); return; }
    lastServerReconnect = Date.now();
    setConnection('connecting', 'Reconnecting…');
    connectSocket(getToken(), onSocketEvent);
  } catch (err) {
    if (epoch !== S.epoch) return;
    if (err.status !== 401) setConnection('down', 'Live updates offline: press Refresh');
  }
}

// When a desk's referral ends (rejected, released, expired) the case leaves that desk's scope: the server answers 404
// for it from then on. The desk keeps what it has on screen until the reload drops the card, and reads nothing more.
const leavesScope = ended => ended && can('HOSPITAL_DESK');

function afterCaseEvent(requestId, { ended = false } = {}) {
  mciReload();
  if (leavesScope(ended)) return;
  if (requestId && requestId === S.selectedRequestId) loadCase(requestId, { quiet: true });
  if (requestId && S.caseCache.has(requestId)) S.caseCache.delete(requestId);
  if (requestId) [...S.tracked.entries()].filter(([, t]) => t.requestId === requestId).forEach(() => pollTrackedReferrals());
}

function onAuditEntry(entry) {
  if (!entry || !can(...NETWORK_VIEW)) return; // the ledger itself is ADMIN-only (renderAudit)
  if (entry.request_id && (S.res.registrations.data?.cases || []).some(c => c.request_id === entry.request_id)) scheduleReload(['registrations'], 400);
  const r = S.res.audit;
  if (Array.isArray(r.data) && !r.data.some(e => e.history_id === entry.history_id)) {
    r.data = [entry, ...r.data].slice(0, 500);
    renderAudit();
  }
  if (entry.request_id && entry.request_id === S.selectedRequestId) loadCase(entry.request_id, { quiet: true });
}

// ── Referral outcome for the user who initiated it ──
// Proposed server event (e2e/SERVER_REQUIREMENTS.md): 'referral:status' { acceptance_id, request_id, hospital_id, status, at }
// to room user:<user_id>. Until it exists, pending referrals this user started are polled via GET /emergencies/:id.
function handleReferralStatus(p) {
  const acceptanceId = idOf(p);
  const requestId = reqOf(p);
  if (!acceptanceId || !requestId) return;
  const status = String(p.status || '').toUpperCase();
  if (!S.tracked.has(acceptanceId)) S.tracked.set(acceptanceId, { requestId, hospitalId: hospOf(p), status: 'PENDING' });
  if (status && status !== 'PENDING') {
    settleTracked(acceptanceId, requestId, status, {
      hospitalId: hospOf(p), ambulanceId: p.ambulance_id ?? null,
      next: p.next_acceptance_id ? { acceptance_id: p.next_acceptance_id, hospital_id: p.next_hospital_id ?? null } : null
    });
  }
  scheduleReload(['emergencies', 'ambulances', 'hospitals', 'referralHistory', 'dashboard']);
  if (requestId === S.selectedRequestId) loadCase(requestId, { quiet: true });
}

/**
 * A case changed status (case:status { request_id, status, previous_status, hospital_id, at }, sent to the admin and the
 * accepting hospital): show it at once wherever the case is on screen, then re-read from the server.
 */
function onCaseStatus(p) {
  const requestId = reqOf(p);
  const status = String(p.status || '').toUpperCase();
  if (!requestId || !status) return;
  const item = queue().find(q => q.request_id === requestId);
  if (item) item.status = status;
  trips().filter(t => t.request_id === requestId && t.case).forEach(t => { t.case.status = status; });
  const patient = (S.res.patients.data || []).find(x => x.request_id === requestId);
  if (patient) patient.status = status;
  if (p.milestone === 'TREATMENT_NOTE') progressNotes.delete(requestId);
  const reg = (S.res.registrations.data?.cases || []).find(c => c.request_id === requestId);
  if (reg) reg.status = status;
  const what = p.milestone && !['STATUS_CHANGED'].includes(p.milestone) ? fmtStatus(p.milestone) : fmtStatus(status);
  pushLiveEvent(`${requestId}: ${what.toLowerCase()}${hospOf(p) ? ` at ${hospitalName(hospOf(p))}` : ''}`, status === 'COMPLETED' ? 'success' : 'info');
  renderQueue(); renderCommandQueue(); renderTracking(); renderHospitalPatients(); renderRegistrations();
  if (requestId === S.selectedRequestId) loadCase(requestId, { quiet: true });
  const names = ['emergencies', 'hospitals', 'ambulances', 'dashboard'];
  if (can('HOSPITAL_DESK')) names.push('patients');
  if (S.res.trips.status !== 'idle') names.push('trips');
  if (reg) names.push('registrations');
  if (can('ADMIN') && S.mci.openId) names.push('incident', 'incidents');
  if (can('ADMIN') && S.res.overview.status !== 'idle') names.push('overview');
  scheduleReload(names, 200);
}

/** Tell the initiator how their referral ended (once), and follow the server's failover referral if there is one. */
function settleTracked(acceptanceId, requestId, status, { hospitalId, ambulanceId, next }) {
  const t = S.tracked.get(acceptanceId);
  if (!t || t.status !== 'PENDING') return;
  t.status = status;
  queueMicrotask(renderIncidentPage); // an incident's victims list follows each outcome
  const name = hospitalName(hospitalId || t.hospitalId);
  if (status === 'ACCEPTED') {
    notify(`${name} accepted ${requestId}.${ambulanceId ? ` Ambulance ${ambulanceId} is assigned.` : ' No ambulance was free: dispatch one from the Fleet.'}`, 'success');
    pushLiveEvent(`Your referral ${requestId} was accepted by ${name}`, 'success');
  } else {
    const verb = status === 'EXPIRED' ? 'did not answer in time' : status === 'REJECTED' ? 'rejected' : `ended (${fmtStatus(status)})`;
    notify(`${name} ${verb} for ${requestId}.${next ? ` The server rerouted it to ${hospitalName(next.hospital_id)}.` : ' No other hospital was offered: choose another.'}`, 'urgent');
    pushLiveEvent(`Your referral ${requestId}: ${name} ${verb}`, 'critical');
    if (next && !S.tracked.has(next.acceptance_id)) S.tracked.set(next.acceptance_id, { requestId, hospitalId: next.hospital_id, status: 'PENDING' });
  }
}

let polling = false;
async function pollTrackedReferrals() {
  if (polling || !S.user) return;
  const pending = [...S.tracked.entries()].filter(([, t]) => t.status === 'PENDING');
  if (!pending.length) return;
  polling = true;
  const epoch = S.epoch;
  try {
    const requestIds = [...new Set(pending.map(([, t]) => t.requestId))];
    for (const requestId of requestIds) {
      let detail;
      try { detail = await EmergenciesAPI.detail(requestId); } catch { continue; }
      if (epoch !== S.epoch) return;
      for (const [acceptanceId, t] of pending.filter(([, x]) => x.requestId === requestId)) {
        const acc = (detail.acceptances || []).find(a => a.acceptance_id === acceptanceId);
        if (!acc || acc.status === 'PENDING' || t.status !== 'PENDING') continue;
        const next = (detail.acceptances || []).filter(a => a.status === 'PENDING' && a.acceptance_id !== acceptanceId).at(-1) || null;
        settleTracked(acceptanceId, requestId, acc.status, { hospitalId: acc.hospital_id, ambulanceId: detail.request?.assigned_ambulance_id ?? null, next });
        scheduleReload(['emergencies', 'ambulances', 'hospitals', 'referralHistory', 'dashboard']);
        if (requestId === S.selectedRequestId) loadCase(requestId, { quiet: true });
      }
    }
  } finally {
    polling = false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Countdown ticker: every [data-deadline] element shows the seconds left
// ──────────────────────────────────────────────────────────────────────────────
/** Record a lock's deadline and move every countdown already on screen for it. */
function setLockDeadline(acceptanceId, deadlineMs) {
  S.lockDeadlines.set(acceptanceId, deadlineMs);
  document.querySelectorAll(`[data-countdown-for="${CSS.escape(acceptanceId)}"]`).forEach(node => { node.dataset.deadline = String(deadlineMs); });
}

function syncLockDeadlines(locks) {
  const now = Date.now();
  const ids = new Set();
  (locks || []).forEach(lock => {
    const id = idOf(lock);
    ids.add(id);
    if (Number.isFinite(Number(lock.remainingSec))) S.lockDeadlines.set(id, now + Number(lock.remainingSec) * 1000);
    else if (lock.expiresAt) S.lockDeadlines.set(id, new Date(lock.expiresAt).getTime());
  });
  [...S.lockDeadlines.keys()].forEach(id => { if (!ids.has(id)) S.lockDeadlines.delete(id); });
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll('[data-deadline]').forEach(node => {
    const deadline = Number(node.dataset.deadline);
    const left = Math.max(0, Math.ceil((deadline - now) / 1000));
    if (left > 0) {
      node.textContent = `${left}s`;
      node.classList.toggle('is-urgent', left <= 15);
      node.classList.remove('is-expired');
      return;
    }
    node.textContent = 'Expired';
    node.classList.add('is-expired');
    const card = node.closest('[data-acceptance-id]');
    const id = card?.dataset.acceptanceId;
    if (card) {
      card.classList.add('is-expired');
      card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const note = card.querySelector('.expiry-note');
      if (note) note.textContent = 'The response window has closed. The server releases the resources and offers the case to the next hospital.';
    }
    if (id && !S.expiredHandled.has(id)) {
      S.expiredHandled.add(id);
      scheduleReload(['activeLocks', 'emergencies', 'referralHistory'], 1500);
      if (S.selectedRequestId && !(leavesScope(true) && card?.dataset.requestId === S.selectedRequestId)) loadCase(S.selectedRequestId, { quiet: true });
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Navigation, theme, clock
// ──────────────────────────────────────────────────────────────────────────────
function switchTab(tabId) {
  const pane = byId(tabId);
  const nav = document.querySelector(`.nav-tab-btn[data-tab="${tabId}"]`);
  if (!pane || (nav && nav.hidden)) return;
  // A different tab opens at its top: kept from the previous tab, the scroll position put its first cards under the
  // sticky header (e.g. "Find hospitals" low on Cases opened Recommendation with the top hospital's button covered).
  if (S.activeTab !== tabId) window.scrollTo(0, 0);
  S.activeTab = tabId;
  document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === tabId));
  const [title, description] = TAB_COPY[tabId] || TAB_COPY['tab-command'];
  setText('workspaceTitle', title);
  setText('workspaceDescription', description);
  if (!S.user) return;
  if (tabId === 'tab-map') ensureMap();
  if (tabId === 'tab-activity' && S.res.audit.status === 'idle') load('audit');
  if (tabId === 'tab-analytics' && S.res.registrations.status === 'idle') load('registrations');
  if (tabId === 'tab-roadside') renderRoadside();
  if (tabId === 'tab-tracking') { load('trips'); if (can('ADMIN')) { if (S.res.emergencies.status === 'idle') load('emergencies'); } renderTracking(); setTimeout(() => S.tracking.map?.invalidate(), 60); }
  if (tabId === 'tab-firstaid' && !byId('firstAidStaff')?.childElementCount) renderFirstAid(byId('firstAidStaff'), { idPrefix: 'fa-tab' });
  if (tabId === 'tab-acceptance') load('activeLocks');
  if (tabId === 'tab-hospitals' && can('ADMIN')) load('overview');
  if (tabId === 'tab-mci') { load('incidents'); if (S.mci.openId) load('incident'); renderIncidents(); }
  if (tabId === 'tab-ranking') renderRanking();
  if (tabId === 'tab-accounts') { load('accounts'); if (S.res.emergencies.status === 'idle') load('emergencies'); }
}

function initNavigation() {
  document.querySelectorAll('.nav-tab-btn').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  document.querySelectorAll('[data-navigate]').forEach(c => c.addEventListener('click', () => switchTab(c.dataset.navigate)));

  const header = byId('siteHeader');
  const menuBtn = byId('navMenuBtn');
  const setOpen = open => {
    header?.classList.toggle('nav-open', open);
    menuBtn?.setAttribute('aria-expanded', String(open));
  };
  menuBtn?.addEventListener('click', () => setOpen(!header.classList.contains('nav-open')));
  document.querySelectorAll('.nav-tab-btn').forEach(tab => tab.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });

  byId('refreshWorkspaceBtn')?.addEventListener('click', () => {
    if (S.user && byId('connectionStatus')?.textContent === 'Live updates offline: press Refresh') {
      setConnection('connecting', 'Reconnecting…');
      connectSocket(getToken(), onSocketEvent);
    }
    loadAll();
    if (S.selectedRequestId) loadCase(S.selectedRequestId);
    if (S.activeTab === 'tab-analytics') load('registrations');
  });
  byId('dataBannerRetry')?.addEventListener('click', () => loadAll());
}

function initTheme() {
  const btn = byId('themeToggleBtn');
  const read = () => { try { return localStorage.getItem('eris_theme'); } catch { return null; } };
  const apply = theme => {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0d0c' : '#f5f1ec');
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    setText('themeToggleText', label);
    btn?.setAttribute('title', label);
    btn?.setAttribute('aria-label', label);
  };
  apply(read() || 'light');
  btn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('eris_theme', next); } catch { /* storage unavailable */ }
    apply(next);
  });
}

function initClock() {
  const update = () => setText('systemClock', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  update();
  setInterval(update, 1000);
}

// ──────────────────────────────────────────────────────────────────────────────
// Command center
// ──────────────────────────────────────────────────────────────────────────────
function renderKpis() {
  const d = S.res.dashboard.data?.kpis;
  const live = S.kpiLive;
  // The newer of the REST dashboard and the socket push wins for the fields both carry.
  const liveNewer = live && (!S.res.dashboard.at || Date.parse(live.timestamp) >= S.res.dashboard.at - 1000);
  const pick = (liveKey, restKey) => (liveNewer && live[liveKey] !== undefined ? live[liveKey] : d?.[restKey]);
  const show2 = (id, value) => setText(id, value === undefined || value === null ? '—' : String(value));
  show2('kpiActiveEmergencies', pick('active_emergencies', 'active_emergencies'));
  show2('kpiCriticalWaiting', pick(live?.critical_p1_waiting !== undefined ? 'critical_p1_waiting' : 'critical_p1', 'critical_p1_waiting'));
  show2('kpiIcuAvailable', pick('icu_available', 'icu_available'));
  show2('kpiVentilatorsAvailable', pick('ventilators_available', 'ventilators_available'));
  show2('kpiHospitalsOpen', pick('hospitals_open', 'hospitals_open'));
  show2('kpiAmbulancesAvail', pick(live?.available_ambulances !== undefined ? 'available_ambulances' : 'ambulances_available', 'available_ambulances'));
  setText('kpiIcuSub', d ? `of ${d.icu_total} total; ${d.icu_locked} soft-locked` : 'Excludes soft-locked beds');
  setText('kpiVentSub', d ? `of ${d.ventilators_total} total` : 'Excludes soft-locked units');
  setText('kpiHospitalsStatus', d ? `${d.hospitals_limited} limited · ${d.hospitals_closed} closed` : 'Network status');
  // Desks get only their own hospital's locks from the server; the socket's active_locks is network-wide.
  const ownLocks = Array.isArray(S.res.activeLocks.data) ? S.res.activeLocks.data.length : undefined;
  const locks = can('HOSPITAL_DESK') ? ownLocks : can(...NETWORK_VIEW) && ownLocks !== undefined ? ownLocks : live?.active_locks;
  show2('kpiReferralsPending', locks);
  const stats = S.res.referralStats.data?.summary;
  show2('kpiReferralsAccepted', stats?.accepted);
  show2('kpiReferralsClosed', stats ? stats.rejected + stats.expired : undefined);
  const r = S.res.dashboard;
  setText('kpiUpdatedAt', r.status === 'error' && !d ? `KPIs unavailable: ${errorText(r.error)}`
    : d ? `Updated ${fmtTime(live?.timestamp && liveNewer ? live.timestamp : S.res.dashboard.data.timestamp)}` : 'Loading KPIs…');
}

function renderCapacity() {
  const container = byId('hospitalsDirectoryGrid');
  const r = S.res.dashboard;
  const gate = resourceGate(r, { retry: () => load('dashboard'), isEmpty: d => !d.hospital_statuses?.length, empty: stateMsg('No hospitals', 'The network has no hospitals registered.') });
  if (gate) return mount(container, gate);
  mount(container, r.data.hospital_statuses.map(h => el('div', { class: 'hospital-card' },
    el('div', { class: 'hospital-header' },
      el('div', {}, el('div', { class: 'hospital-name' }, h.hospital_name), el('div', { class: 'hospital-meta' }, h.hospital_id)),
      badge(h.emergency_status)),
    el('div', { class: 'resource-capsule-grid' },
      el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, 'ICU beds free'),
        el('span', { class: ['capsule-val', h.capacity_color === 'GREEN' ? 'good' : h.capacity_color === 'YELLOW' ? 'low' : 'empty'] }, `${h.icu_available} / ${h.icu_total}`))))));
}

function renderCommandQueue() {
  const body = byId('commandPriorityQueueBody');
  const gate = resourceGate(S.res.emergencies, { retry: () => load('emergencies') });
  if (gate) return mount(body, el('tr', {}, el('td', { colspan: '5' }, gate)));
  const active = queue().filter(item => !TERMINAL.includes(item.status)).slice(0, 6);
  if (!active.length) return mount(body, el('tr', {}, el('td', { colspan: '5' }, stateMsg('Queue clear', 'No active cases are waiting for coordination.'))));
  mount(body, active.map(item => el('tr', {},
    el('td', { class: 'cell-id' }, item.request_id),
    el('td', {}, el('span', { class: 'patient-name' }, patientOf(item).full_name || '—'), el('small', {}, ` ${fmtStatus(item.emergency_type)}`),
      item.incident_id ? ' ' : null, incidentBadge(item.incident_id)),
    el('td', {}, priorityBadge(item.priority)),
    el('td', {}, statusCell(item)),
    el('td', {}, hospitalCell(item)))));
}

function renderReferralSummary() {
  const container = byId('commandReferralSummary');
  const r = S.res.referralStats;
  const gate = resourceGate(r, { retry: () => load('referralStats'), isEmpty: () => false });
  if (gate) return mount(container, gate);
  const s = r.data.summary;
  mount(container, [['Pending', s.pending, 'awaiting a hospital'], ['Accepted', s.accepted, 'destination committed'],
    ['Rejected', s.rejected, 'declined by the hospital'], ['Expired', s.expired, 'no answer within 90 s'],
    ['Cancelled', s.cancelled, 'case ended while pending']]
    .map(([label, value, caption]) => el('div', { class: 'summary-row' },
      el('div', {}, el('strong', {}, label), el('small', {}, caption)), el('span', { class: 'summary-value' }, value))));
}

function renderFleetSummary() {
  const container = byId('commandFleetSummary');
  const gate = resourceGate(S.res.ambulances, { retry: () => load('ambulances'), empty: stateMsg('No ambulances', 'No units are registered.') });
  if (gate) return mount(container, gate);
  const list = S.res.ambulances.data;
  const count = s => list.filter(a => a.status === s).length;
  mount(container, [['Available', count('AVAILABLE'), 'ready for dispatch'], ['Dispatched', count('DISPATCHED'), 'assigned, not yet moving'],
    ['In transit', count('IN_TRANSIT'), 'active transport'], ['Maintenance', count('MAINTENANCE'), 'out of service']]
    .map(([label, value, caption]) => el('div', { class: 'summary-row' },
      el('div', {}, el('strong', {}, label), el('small', {}, caption)), el('span', { class: 'summary-value' }, value))));
}

function renderLiveEvents() {
  const feed = byId('commandActivityFeed');
  if (!feed) return;
  if (!S.liveEvents.length) return mount(feed, stateMsg('No events yet', 'Referral, allocation and alert events appear here as they happen.'));
  mount(feed, S.liveEvents.slice(0, 8).map(e => el('div', { class: ['activity-item', e.tone] },
    el('span', { class: 'activity-marker' }), el('div', {}, el('strong', {}, e.text), el('small', {}, fmtTime(e.at))))));
}

// ──────────────────────────────────────────────────────────────────────────────
// Intake
// ──────────────────────────────────────────────────────────────────────────────
function initIntakeForm() {
  applyTypeRequirements(true);
}

function applyTypeRequirements(setTriage) {
  const type = byId('emergencyTypeSelect')?.value || 'GENERAL';
  const req = TYPE_REQUIREMENTS[type] || TYPE_REQUIREMENTS.GENERAL;
  S.intake.extras.forEach(t => { if (req.resources.includes(t)) S.intake.extras.delete(t); });
  document.querySelectorAll('.resource-chip').forEach(chip => {
    const t = chip.dataset.resource;
    const locked = req.resources.includes(t);
    const selected = locked || S.intake.extras.has(t);
    chip.classList.toggle('selected', selected);
    chip.classList.toggle('locked', locked);
    chip.setAttribute('aria-pressed', String(selected));
    chip.setAttribute('aria-disabled', String(locked));
    chip.title = locked ? 'Required for this emergency type' : 'Add or remove this requirement';
  });
  const spec = byId('specialistSelect');
  if (spec) {
    if (req.specialist) { spec.value = req.specialist; spec.disabled = true; } else { spec.disabled = false; if (spec.value && TYPE_REQUIREMENTS[type].specialist === null && setTriage) spec.value = ''; }
  }
  if (setTriage) setTriageLevel(req.triage);
  setText('triageRecommendationInfo', `Suggested triage: ${req.triage} — ${TRIAGE_NAMES[req.triage]}. Confirm using the patient's observed condition.`);
}

function setTriageLevel(category) {
  if (!Object.hasOwn(TRIAGE_CATEGORY_PRIORITY, category)) return;
  S.intake.triage = category;
  document.querySelectorAll('.triage-btn').forEach(b => {
    const on = b.dataset.category === category;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/**
 * What a failed POST /emergencies means for its Idempotency-Key:
 *  'reused'  422: the key already registered a case and this (edited) body was refused — the submission is settled;
 *  'refused' another 4xx (not 408/409/429): this attempt was refused — keep the key, an earlier attempt may still count;
 *  'unknown' network failure, unreadable body, 408, 409, 429, 5xx — the server may have registered it; keep the key.
 */
function createOutcome(err) {
  const status = err?.kind === 'http' ? err.status : 0;
  if (status === 422) return 'reused';
  if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) return 'refused';
  return 'unknown';
}

function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function readIntakeForm() {
  const name = byId('patientName').value.trim();
  const ageText = byId('patientAge').value.trim();
  const age = Number(ageText);
  const latText = byId('pickupLat').value.trim();
  const lngText = byId('pickupLng').value.trim();
  const errors = [];
  if (!name) errors.push('Enter the patient name (or "Unknown").');
  if (!ageText || !Number.isInteger(age) || age < 0 || age > 130) errors.push('Age must be a whole number from 0 to 130.');
  if ((latText === '') !== (lngText === '')) errors.push('Give both pickup latitude and longitude, or neither.');
  const lat = latText === '' ? null : Number(latText);
  const lng = lngText === '' ? null : Number(lngText);
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) errors.push('Pickup latitude must be between -90 and 90.');
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) errors.push('Pickup longitude must be between -180 and 180.');
  if (lat !== null && lng !== null && !errors.length) { const area = operatingAreaProblem(lat, lng, 'The pickup'); if (area) errors.push(area); }
  const type = byId('emergencyTypeSelect').value;
  const spec = byId('specialistSelect').value || null;
  const payload = {
    patient_name: name,
    age,
    gender: byId('patientGender').value,
    emergency_type: type,
    triage_priority: TRIAGE_CATEGORY_PRIORITY[S.intake.triage],
    clinical_notes: byId('emergencyNotes').value.trim(),
    required_resources: [...S.intake.extras].sort(),
    required_specialist: TYPE_REQUIREMENTS[type]?.specialist ? null : spec
  };
  const phone = byId('contactPhone').value.trim();
  if (phone) payload.contact_phone = phone;
  if (lat !== null) { payload.pickup_lat = lat; payload.pickup_lng = lng; }
  return { payload, errors };
}

function initIntakeControls() {
  byId('emergencyTypeSelect')?.addEventListener('change', () => applyTypeRequirements(true));
  document.querySelectorAll('.triage-btn').forEach(b => b.addEventListener('click', () => setTriageLevel(b.dataset.category)));
  document.querySelectorAll('.resource-chip').forEach(chip => chip.addEventListener('click', () => {
    if (chip.classList.contains('locked')) return;
    const t = chip.dataset.resource;
    if (S.intake.extras.has(t)) S.intake.extras.delete(t); else S.intake.extras.add(t);
    applyTypeRequirements(false);
  }));
  byId('btnUseGpsLocation')?.addEventListener('click', () => {
    if (!navigator.geolocation) return setText('gpsStatus', 'Location is not available in this browser.');
    setText('gpsStatus', 'Locating…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (operatingAreaProblem(pos.coords.latitude, pos.coords.longitude)) return setText('gpsStatus', OUTSIDE_AREA);
        byId('pickupLat').value = pos.coords.latitude.toFixed(6); byId('pickupLng').value = pos.coords.longitude.toFixed(6); setText('gpsStatus', `Accuracy about ${Math.round(pos.coords.accuracy)} m.`);
      },
      err => setText('gpsStatus', `Location unavailable: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 });
  });

  byId('emergencyIntakeForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!can(...CREATES_CASES) || S.intake.submitting) return;
    const errorEl = byId('intakeError');
    errorEl.hidden = true;
    const { payload, errors } = readIntakeForm();
    if (errors.length) { errorEl.textContent = errors.join(' '); errorEl.hidden = false; return; }

    // One Idempotency-Key per submission, kept until the server settles it: a 2xx (registered or replayed) or a 422
    // (the key already registered a case, and this edited body was refused). Any other answer (network failure,
    // unreadable body, 408, 409, 429, 5xx, or a 4xx such as a validation error) keeps the key, because an earlier
    // attempt with this key may already have created the case. The retry then replays it or is refused with 422.
    if (!S.intake.pendingKey) S.intake.pendingKey = newIdempotencyKey();
    const earlierUnknown = S.intake.outcomeUnknown;
    S.intake.outcomeUnknown = true; // until this attempt is answered
    const submit = byId('intakeSubmitBtn');
    S.intake.submitting = true;
    submit.disabled = true;
    submit.textContent = 'Registering…';
    const epoch = S.epoch;
    try {
      const created = await EmergenciesAPI.create(payload, S.intake.pendingKey);
      if (epoch !== S.epoch) return;
      S.intake.pendingKey = null; S.intake.outcomeUnknown = false;
      byId('emergencyIntakeForm').reset();
      S.intake.extras.clear();
      applyTypeRequirements(true);
      notify(created.replayed
        ? `${created.request_id} was already registered by your earlier attempt; no duplicate was created.`
        : `Registered ${created.request_id}. Choose a hospital in Recommendation.`, 'success');
      S.selectedRequestId = created.request_id;
      await load('emergencies');
      if (epoch !== S.epoch) return;
      loadCase(created.request_id);
      load('dashboard');
    } catch (err) {
      if (epoch !== S.epoch) return;
      const outcome = createOutcome(err);
      if (outcome === 'reused') {
        // POST /emergencies answers 422 only for a reused Idempotency-Key with a different body: the key already
        // registered a case (an earlier attempt whose answer was lost). The submission is settled.
        S.intake.pendingKey = null; S.intake.outcomeUnknown = false;
        errorEl.textContent = 'Your edits were not saved: an earlier attempt may already have registered this case. Check the queue before registering it again.';
        load('emergencies');
        notify('An earlier attempt may already have registered this case: check the queue.', 'urgent');
      } else if (outcome === 'refused') {
        S.intake.outcomeUnknown = earlierUnknown;
        errorEl.textContent = earlierUnknown
          ? `This attempt was refused: ${errorText(err)} An earlier attempt may already have registered this case: check the queue. Correct the form and press Register again; the retry cannot register it twice.`
          : `Not registered: ${errorText(err)}`;
        notify(earlierUnknown ? 'Attempt refused; an earlier one may already have registered this case.' : 'The emergency was not registered.', 'urgent');
      } else {
        S.intake.outcomeUnknown = true;
        errorEl.textContent = `Outcome unknown: the server could not confirm whether this case was registered (${errorText(err)}). Press Register again to retry; the retry reuses the same submission, so the server will not register it twice.`;
        notify('Registration outcome unknown: retry or check the queue.', 'urgent');
      }
      errorEl.hidden = false;
    } finally {
      // A submission from an earlier session must not unlock the button while this session is submitting.
      if (epoch === S.epoch || !S.intake.submitting) {
        S.intake.submitting = false;
        submit.disabled = false;
        submit.textContent = 'Register emergency';
      }
    }
  });
}

// ── Queue ──
function hospitalForCase(requestId) {
  const item = queue().find(q => q.request_id === requestId);
  if (item && ('accepted_hospital_id' in item || 'pending_hospital_id' in item)) {
    if (item.accepted_hospital_id) return { kind: 'accepted', id: item.accepted_hospital_id };
    if (item.pending_hospital_id) return { kind: 'pending', id: item.pending_hospital_id };
    return null;
  }
  const history = (S.res.referralHistory.data || []).filter(a => a.request_id === requestId);
  const accepted = history.filter(a => a.status === 'ACCEPTED').at(-1);
  if (accepted) return { kind: 'accepted', id: accepted.hospital_id };
  const pending = history.filter(a => a.status === 'PENDING').at(-1);
  if (pending) return { kind: 'pending', id: pending.hospital_id };
  return null;
}

function hospitalCell(item) {
  const h = hospitalForCase(item.request_id);
  const transport = item.transport_required ? el('span', { class: 'badge-status badge-closed' }, 'Transport required') : null;
  if (!h) return el('span', { class: 'cell-muted' }, TERMINAL.includes(item.status) ? '—' : 'Not yet referred');
  return el('span', {}, h.kind === 'pending' ? el('span', { class: 'cell-muted' }, 'Pending: ') : null, hospitalName(h.id), transport ? ' ' : null, transport);
}

function renderQueue() {
  const body = byId('emergencyQueueTableBody');
  const r = S.res.emergencies;
  const gate = resourceGate(r, { retry: () => load('emergencies'), empty: stateMsg('No cases yet', can(...CREATES_CASES) ? 'Register an emergency to start.' : 'Cases referred to your hospital appear here.') });
  if (gate) { setText('queueResultCount', ''); return mount(body, el('tr', {}, el('td', { colspan: '8' }, gate))); }
  const search = (byId('emergencySearch')?.value || '').trim().toLowerCase();
  const priority = byId('emergencyPriorityFilter')?.value || 'ALL';
  const status = byId('emergencyStatusFilter')?.value || 'ACTIVE';
  const rows = queue().filter(item => {
    const haystack = `${item.request_id} ${patientOf(item).full_name || ''} ${item.emergency_type}`.toLowerCase();
    return (!search || haystack.includes(search))
      && (priority === 'ALL' || categoryForPriority(item.priority) === priority)
      && (status === 'ALL' || (status === 'ACTIVE' ? !TERMINAL.includes(item.status) : item.status === status));
  });
  setText('queueResultCount', `${rows.length} of ${queue().length} cases`);
  if (!rows.length) return mount(body, el('tr', {}, el('td', { colspan: '8' }, stateMsg('No matching cases', 'Adjust the filters to see more cases.'))));
  mount(body, rows.map(item => {
    const p = patientOf(item);
    const select = () => selectCase(item.request_id);
    return el('tr', {
      tabindex: '0', 'aria-selected': String(item.request_id === S.selectedRequestId), dataset: { requestId: item.request_id },
      on: { click: select, keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } } }
    },
    el('td', { class: 'cell-id' }, item.request_id),
    el('td', {}, el('span', { class: 'patient-name' }, p.full_name || '—'), el('span', { class: 'cell-muted' }, p.age !== undefined && p.age !== null ? ` (${p.age}y)` : ''),
      item.incident_id ? ' ' : null, incidentBadge(item.incident_id)),
    el('td', {}, fmtStatus(item.emergency_type)),
    el('td', {}, priorityBadge(item.priority)),
    el('td', {}, statusCell(item)),
    el('td', {}, hospitalCell(item)),
    el('td', { class: 'cell-id' }, item.assigned_ambulance_id || '—'),
    el('td', { class: 'cell-time' }, fmtDateTime(item.request_time)));
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Case tracker
// ──────────────────────────────────────────────────────────────────────────────
function selectCase(requestId) {
  if (S.stageAdvance?.requestId !== requestId) S.stageAdvance = null;
  S.selectedRequestId = requestId;
  renderQueue();
  loadCase(requestId);
}

async function loadCase(requestId, { quiet = false } = {}) {
  if (!S.user || !requestId) return;
  const view = S.caseView;
  const seq = ++view.seq;
  const epoch = S.epoch;
  if (view.requestId !== requestId) Object.assign(view, { requestId, detail: null, audit: null, error: null });
  if (!quiet || !view.detail) { view.status = 'loading'; renderCaseTracker(); renderRanking(); }
  try {
    const [detail, audit] = await Promise.all([EmergenciesAPI.detail(requestId), EmergenciesAPI.audit(requestId)]);
    if (epoch !== S.epoch || seq !== view.seq) return;
    Object.assign(view, { status: 'ok', detail, audit: audit.audit_trail || [], error: null });
  } catch (err) {
    if (epoch !== S.epoch || seq !== view.seq) return;
    Object.assign(view, { status: 'error', error: err });
  }
  renderCaseTracker();
  renderRanking();
  renderRoadside();
}

function renderLifecycle(status) {
  const idx = LIFECYCLE.indexOf(status);
  document.querySelectorAll('#lifecycleTracker .state-step').forEach(step => {
    const i = LIFECYCLE.indexOf(step.dataset.state);
    step.classList.toggle('done', idx >= 0 && i < idx);
    step.classList.toggle('active', idx >= 0 && i === idx);
    step.classList.toggle('cancelled', status === 'CANCELLED');
  });
}

function renderCaseTracker() {
  const body = byId('caseTrackerBody');
  const actions = byId('caseTrackerActions');
  const view = S.caseView;
  if (!S.selectedRequestId) {
    setText('caseTrackerCaption', can('ADMIN') ? 'Open a case by its ID, or from My registered patients.' : 'Select a case in the queue.');
    renderLifecycle(null); mount(actions);
    return mount(body, stateMsg('No case selected', can('ADMIN') ? 'Open a case by its ID to see its lifecycle, referrals, transport and audit trail.' : 'Choose a case in the priority queue to see its lifecycle, referrals, transport and audit trail.'));
  }
  if (view.status === 'loading' && !view.detail) { mount(actions); return mount(body, loadingMsg('Loading case…')); }
  if (view.status === 'error' && !view.detail) {
    mount(actions);
    return mount(body, errorMsg(view.error, () => loadCase(S.selectedRequestId)));
  }
  if (!view.detail) return;
  const { request, patient = {}, acceptances = [], allocations = [] } = view.detail;
  const audit = view.audit || [];
  setText('caseTrackerCaption', `${request.request_id} · ${patient.full_name || 'Unknown patient'}${request.status === 'CANCELLED' ? ' · cancelled' : ''}`);
  renderLifecycle(request.status);

  const accepted = acceptances.filter(a => a.status === 'ACCEPTED').at(-1);
  const pending = acceptances.filter(a => a.status === 'PENDING').at(-1);
  const amb = request.assigned_ambulance_id ? (S.res.ambulances.data || []).find(a => a.ambulance_id === request.assigned_ambulance_id) : null;

  // Actions
  const buttons = [];
  if (can(...CREATES_CASES) && REFERRABLE.includes(request.status) && !pending) {
    buttons.push(el('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'btnFindHospitals', on: { click: () => switchTab('tab-ranking') } }, 'Recommend hospitals'));
  }
  if (can('ADMIN')) {
    (ADMIN_TRANSITIONS[request.status] || []).forEach(next => buttons.push(el('button', {
      type: 'button', class: next === 'CANCELLED' ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm', dataset: { transition: next },
      on: { click: () => transitionCase(request.request_id, next) }
    }, next === 'CANCELLED' ? 'Cancel case' : `Mark ${fmtStatus(next).toLowerCase()}`)));
  }
  const plan = stagePlan(view.detail);
  const stage = S.stageAdvance?.requestId === request.request_id ? S.stageAdvance : null;
  if (plan) {
    buttons.push(el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm', id: 'btnAdvanceStage',
      disabled: S.inFlight.has(`stage:${request.request_id}`) || stage?.phase === 'confirm',
      on: { click: () => { S.stageAdvance = { requestId: request.request_id, phase: 'confirm', plan }; renderCaseTracker(); } }
    }, 'Advance to next stage'));
  }
  mount(actions, buttons);

  let transportText = '—';
  if (amb) transportText = `${amb.ambulance_id} (${fmtStatus(amb.status)}${amb.eta_mins !== undefined && amb.eta_mins !== null && amb.status === 'IN_TRANSIT' ? `, ETA ${amb.eta_mins} min` : ''})`;
  else if (request.assigned_ambulance_id) transportText = request.assigned_ambulance_id;
  else if (request.transport_required) transportText = 'Required: no ambulance assigned';

  const hasPickup = request.pickup_lat !== null && request.pickup_lat !== undefined && request.pickup_lng !== null && request.pickup_lng !== undefined;
  const trip = trips().filter(t => t.request_id === request.request_id).at(-1);
  const journey = journeyStage({ status: request.status, arrived_at: request.arrived_at, trip_phase: trip ? tripPhase(trip) : null, ambulance_status: amb?.status });
  mount(body,
    stage ? stagePanel(request, stage) : null,
    journey ? el('div', { class: 'case-journey', id: 'caseJourney' }, journeyBar(journey),
      request.bed_label ? el('span', { class: 'cell-muted' }, `Bed ${request.bed_label}`) : null) : null,
    el('div', { class: 'kv-grid', id: 'caseSummary' },
      kv('Patient', `${patient.full_name || '—'}${patient.age !== undefined ? (patient.age === null ? ', age unknown' : `, ${patient.age}y`) : ''}${patient.gender ? `, ${fmtStatus(patient.gender).toLowerCase()}` : ''}`),
      kv('Emergency', fmtStatus(request.emergency_type)),
      kv('Priority', priorityBadge(request.priority)),
      kv('Status', badge(request.status)),
      request.incident_id ? kv('Incident', incidentBadge(request.incident_id)) : null,
      kv('Registered', fmtDateTime(request.request_time)),
      kv('Required resources', resourceTags(request.required_resource_types)),
      kv('Specialist', request.required_specialist ? SPECIALIST_LABELS[request.required_specialist] || request.required_specialist : 'None'),
      kv('Pickup', hasPickup ? `${fmtNumber(request.pickup_lat, 4)}, ${fmtNumber(request.pickup_lng, 4)}` : 'Not recorded'),
      kv('Hospital', accepted ? `${hospitalName(accepted.hospital_id)} (accepted)` : pending ? `${hospitalName(pending.hospital_id)} (pending)` : 'Not allocated'),
      el('div', { class: 'kv', id: 'caseAmbulance' }, el('div', { class: 'kv-label' }, 'Ambulance'), el('div', { class: 'kv-value' }, transportText))),
    request.clinical_notes ? el('div', { class: 'notes-box' }, request.clinical_notes) : null,
    pending ? el('div', { class: 'status-line is-warning' }, 'Referral pending at ', el('strong', {}, hospitalName(pending.hospital_id)), ' · ',
      countdownNode(pending.acceptance_id, pending.lock_expires_at)) : null,

    el('h3', { class: 'section-subtitle' }, 'Referrals'),
    acceptances.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table' },
      el('thead', {}, el('tr', {}, ['Referral', 'Hospital', 'Status', 'Sent', 'Answered', 'Reason'].map(h => el('th', {}, h)))),
      el('tbody', {}, acceptances.map(a => el('tr', {},
        el('td', { class: 'cell-id' }, a.acceptance_id), el('td', {}, hospitalName(a.hospital_id)), el('td', {}, badge(a.status)),
        el('td', { class: 'cell-time' }, fmtDateTime(a.created_at)), el('td', { class: 'cell-time' }, fmtDateTime(a.responded_at)),
        el('td', { class: 'cell-muted' }, a.rejection_reason || '')))))) : stateMsg('No referrals yet', 'Use Recommend hospitals to send one.'),

    el('h3', { class: 'section-subtitle' }, 'Committed allocation'),
    allocations.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table', id: 'caseAllocations' },
      el('thead', {}, el('tr', {}, ['Allocation', 'Hospital', 'Resource', 'Stage', 'Status', 'Time'].map(h => el('th', {}, h)))),
      el('tbody', {}, allocations.map(a => el('tr', {},
        el('td', { class: 'cell-id' }, a.allocation_id), el('td', {}, hospitalName(a.hospital_id)), el('td', { class: 'cell-id' }, a.resource_id),
        el('td', {}, a.stage_no ?? '—'), el('td', {}, badge(a.status === 'COMMITTED' ? 'ALLOCATED' : a.status, fmtStatus(a.status))),
        el('td', { class: 'cell-time' }, fmtDateTime(a.allocated_at))))))) : stateMsg('Nothing committed', 'Resources are committed only when a hospital accepts.'),

    el('h3', { class: 'section-subtitle' }, 'Audit trail'),
    audit.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table', id: 'caseAuditTable' },
      el('thead', {}, el('tr', {}, ['Seq', 'Time', 'Event', 'Change', 'Actor'].map(h => el('th', {}, h)))),
      el('tbody', {}, audit.map(e => el('tr', {},
        el('td', { class: 'cell-id' }, e.chain_seq ?? e.history_id ?? ''), el('td', { class: 'cell-time' }, fmtDateTime(e.event_time)),
        el('td', {}, fmtStatus(e.event_type)), el('td', { class: 'cell-muted' }, `${e.previous_state || '—'} → ${e.new_state || '—'}`),
        el('td', { class: 'cell-muted' }, [e.actor_role, e.actor_id].filter(Boolean).join(' · '))))))) : stateMsg('No audit events', 'No events are recorded for this case yet.'),
    view.status === 'error' ? errorMsg(view.error, () => loadCase(S.selectedRequestId)) : null);
}

async function transitionCase(requestId, next) {
  if (next === 'CANCELLED' && !window.confirm(`Cancel ${requestId}? This releases its resources and cannot be undone.`)) return;
  const key = `transition:${requestId}`;
  if (S.inFlight.has(key)) return;
  S.inFlight.add(key);
  const epoch = S.epoch;
  try {
    await EmergenciesAPI.updateStatus(requestId, next);
    if (epoch !== S.epoch) return;
    notify(`${requestId} is now ${fmtStatus(next).toLowerCase()}.`, 'success');
    loadCase(requestId, { quiet: true });
    scheduleReload(['emergencies', 'ambulances', 'hospitals', 'dashboard', 'activeLocks'], 50);
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`Status not changed: ${errorText(err)}`, 'urgent');
  } finally {
    if (epoch === S.epoch) S.inFlight.delete(key);
  }
}

// ── Staged treatment (POST /emergencies/:id/advance-stage) ──
// The preview uses the client copy of the server's pathways (js/staged.js); the server applies its stored claim and
// re-checks capacity and safety, and may refuse.
/** What advancing would do, or null when the user may not advance this case (role, state, or no next stage). */
function stagePlan(detail) {
  const r = detail?.request;
  const pathway = STAGED_PATHWAYS[r?.emergency_type];
  if (!pathway || !['ALLOCATED', 'IN_TREATMENT'].includes(r.status)) return null;
  const accepted = (detail.acceptances || []).filter(a => a.status === 'ACCEPTED').at(-1);
  if (!accepted || !(can('ADMIN') || (can('HOSPITAL_DESK') && accepted.hospital_id === S.user.hospital_id))) return null;
  const from = Number(r.current_stage) || 1;
  const claim = stagedClaim(r.emergency_type, TYPE_REQUIREMENTS[r.emergency_type]?.resources || [], r.required_resource_types || []);
  const plan = stagePlanFromClaim(claim, from);
  return plan ? { ...plan, hospitalId: accepted.hospital_id } : null;
}

const resourceList = types => (types.length ? types.map(t => RESOURCE_LABELS[t] || t).join(', ') : 'nothing');
const doctorLabel = id => { const d = (S.res.doctors.data || []).find(x => x.doctor_id === id); return d ? `${d.full_name} (${id})` : id; };

function stagePanel(request, stage) {
  const p = stage.plan;
  const rid = request.request_id;
  if (stage.phase === 'confirm') {
    return el('div', { class: 'status-line is-warning stage-panel', id: 'stagePanel', dataset: { phase: 'confirm' } },
      el('strong', {}, `Advance ${rid} from stage ${p.from} to stage ${p.to}?`),
      el('span', { id: 'stageRelease' }, `Releases: ${[resourceList(p.release), p.releaseSpecialist && SPECIALIST_LABELS[p.releaseSpecialist]].filter(x => x && x !== 'nothing').join(', ') || 'nothing'}.`),
      el('span', { id: 'stageClaim' }, `Claims: ${[resourceList(p.claim), p.claimSpecialist && SPECIALIST_LABELS[p.claimSpecialist]].filter(x => x && x !== 'nothing').join(', ') || 'nothing'}.`),
      el('span', { class: 'cell-muted' }, 'From the configured pathway at ', hospitalName(p.hospitalId), '. The server re-checks capacity and safety, and may refuse.'),
      el('span', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'btnConfirmAdvance', on: { click: () => advanceCaseStage(rid, p) } }, `Advance to stage ${p.to}`),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', id: 'btnCancelAdvance', on: { click: () => { S.stageAdvance = null; renderCaseTracker(); } } }, 'Cancel')));
  }
  if (stage.phase === 'busy') return el('div', { class: 'status-line stage-panel', id: 'stagePanel', dataset: { phase: 'busy' } }, `Advancing ${rid} to stage ${p.to}…`);
  if (stage.phase === 'unknown') return el('div', { class: 'status-line is-warning stage-panel', id: 'stagePanel', dataset: { phase: 'unknown' } }, el('strong', {}, 'Outcome unknown'), stage.message);
  if (stage.phase === 'error') return el('div', { class: 'status-line is-error stage-panel', id: 'stagePanel', dataset: { phase: 'error' } }, el('strong', {}, `Stage not advanced for ${rid}`), stage.message);
  const res = stage.result;
  if (res.recovered) {
    // Only the stage is confirmed (read back from the case); the lists are the preview's expectation.
    return el('div', { class: 'status-line is-success stage-panel', id: 'stagePanel', dataset: { phase: 'done', stage: String(res.current_stage), recovered: 'true' } },
      el('strong', {}, `${rid} is now at stage ${res.current_stage}`),
      el('span', { class: 'cell-muted' }, 'The server\'s answer was lost; the case read back confirms the stage only.'),
      el('span', { id: 'stageExpectedRelease' }, `Expected to release: ${[resourceList(p.release), p.releaseSpecialist && SPECIALIST_LABELS[p.releaseSpecialist]].filter(x => x && x !== 'nothing').join(', ') || 'nothing'} (not confirmed).`),
      el('span', { id: 'stageExpectedClaim' }, `Expected to claim: ${[resourceList(p.claim), p.claimSpecialist && SPECIALIST_LABELS[p.claimSpecialist]].filter(x => x && x !== 'nothing').join(', ') || 'nothing'} (not confirmed).`));
  }
  const specialists = res.released_specialists || [];
  return el('div', { class: 'status-line is-success stage-panel', id: 'stagePanel', dataset: { phase: 'done', stage: String(res.current_stage) } },
    el('strong', {}, `${rid} is now at stage ${res.current_stage}`),
    el('span', { id: 'stageReleased' }, `Released: ${resourceList(res.released || [])}.`),
    el('span', { id: 'stageAllocated' }, `Claimed: ${resourceList(res.allocated || [])}.`),
    el('span', { id: 'stageReleasedSpecialists', dataset: { ids: specialists.join(',') } },
      specialists.length ? `Released specialist: ${specialists.map(doctorLabel).join(', ')}.` : 'No specialist released.'),
    res.assigned_specialist ? el('span', {}, `Assigned specialist: ${doctorLabel(res.assigned_specialist)}.`) : null);
}

async function advanceCaseStage(requestId, plan) {
  const key = `stage:${requestId}`;
  if (S.inFlight.has(key)) return; // double-submit safe
  S.inFlight.add(key);
  const epoch = S.epoch;
  S.stageAdvance = { requestId, phase: 'busy', plan };
  renderCaseTracker();
  try {
    const result = await EmergenciesAPI.advanceStage(requestId);
    if (epoch !== S.epoch) return;
    S.stageAdvance = { requestId, phase: 'done', plan, result };
    notify(`${requestId} advanced to stage ${result.current_stage}.`, 'success');
  } catch (err) {
    if (epoch !== S.epoch) return;
    if (isDefinite(err)) {
      S.stageAdvance = { requestId, phase: 'error', plan, message: `${errorText(err)}` };
    } else {
      // The advance is not idempotent: read the case back instead of retrying.
      S.stageAdvance = { requestId, phase: 'unknown', plan, message: 'The server\'s answer was lost. Checking the case…' };
      renderCaseTracker();
      try {
        const d = await EmergenciesAPI.detail(requestId);
        if (epoch !== S.epoch) return;
        const now = Number(d.request.current_stage) || 1;
        S.stageAdvance = now > plan.from
          ? { requestId, phase: 'done', plan, result: { previous_stage: plan.from, current_stage: now, recovered: true } }
          : { requestId, phase: 'error', plan, message: `The case is still at stage ${now}: nothing was changed. You can try again.` };
      } catch (err2) {
        if (epoch !== S.epoch) return;
        S.stageAdvance = { requestId, phase: 'error', plan, message: `Outcome still unknown (${errorText(err2)}). Check the case before trying again.` };
      }
    }
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      renderCaseTracker();
      loadCase(requestId, { quiet: true });
      scheduleReload(['hospitals', 'dashboard', 'doctors'], 50);
    }
  }
}

function countdownNode(acceptanceId, fallbackExpiry) {
  const deadline = S.lockDeadlines.get(acceptanceId) ?? (fallbackExpiry ? new Date(fallbackExpiry).getTime() : null);
  if (!deadline || Number.isNaN(deadline)) return el('span', {}, 'awaiting response');
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return el('span', { class: 'countdown-inline', dataset: { deadline: String(deadline), countdownFor: acceptanceId } }, left > 0 ? `${left}s` : 'Expired');
}

// ──────────────────────────────────────────────────────────────────────────────
// Recommendation + referral initiation
// ──────────────────────────────────────────────────────────────────────────────
function renderRanking() {
  const summary = byId('rankingCaseSummary');
  const status = byId('rankingReferralStatus');
  const results = byId('rankingResultsContainer');
  if (!summary || !S.user) return;
  const view = S.caseView;
  if (!S.selectedRequestId) {
    mount(summary, stateMsg('No case selected', 'Select a case in Cases first; the recommendation uses that case\'s own requirements.'),
      el('div', { class: 'state-msg' }, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => switchTab('tab-ingestion') } }, 'Go to cases')));
    mount(status); mount(results); renderSigs.delete('ranking');
    return;
  }
  if (!view.detail || view.requestId !== S.selectedRequestId) {
    mount(summary, view.status === 'error' ? errorMsg(view.error, () => loadCase(S.selectedRequestId)) : loadingMsg('Loading case…'));
    mount(status); mount(results); renderSigs.delete('ranking');
    return;
  }
  const { request, patient = {}, acceptances = [] } = view.detail;
  mount(summary, el('div', { class: 'kv-grid', id: 'rankingCase' },
    kv('Case', `${request.request_id} · ${patient.full_name || '—'}`),
    kv('Emergency', fmtStatus(request.emergency_type)),
    kv('Priority', priorityBadge(request.priority)),
    kv('Status', badge(request.status)),
    kv('Needs', resourceTags(request.required_resource_types)),
    kv('Specialist', request.required_specialist ? SPECIALIST_LABELS[request.required_specialist] || request.required_specialist : 'None'),
    kv('Pickup', request.pickup_lat !== null && request.pickup_lat !== undefined ? `${fmtNumber(request.pickup_lat, 4)}, ${fmtNumber(request.pickup_lng, 4)}` : 'Not recorded: distance not scored')));

  const pending = acceptances.filter(a => a.status === 'PENDING').at(-1);
  const accepted = acceptances.filter(a => a.status === 'ACCEPTED').at(-1);
  const referrable = REFERRABLE.includes(request.status) && !pending;
  if (pending) {
    mount(status, el('div', { class: 'status-line is-warning', id: 'referralPendingLine' },
      el('span', {}, 'Referral ', el('strong', {}, pending.acceptance_id), ' is waiting for ', el('strong', {}, hospitalName(pending.hospital_id)), '.'),
      el('span', {}, 'Time left: ', countdownNode(pending.acceptance_id, pending.lock_expires_at)),
      el('span', { class: 'cell-muted' }, 'You will be notified when it is accepted, rejected or expires.')));
  } else if (accepted) {
    mount(status, el('div', { class: 'status-line is-success', id: 'referralAcceptedLine' },
      el('span', {}, 'Accepted by ', el('strong', {}, hospitalName(accepted.hospital_id)), ` at ${fmtTime(accepted.responded_at)}.`),
      el('span', {}, request.assigned_ambulance_id ? `Ambulance ${request.assigned_ambulance_id} assigned.` : 'No ambulance assigned yet: dispatch one from the Fleet.')));
  } else if (!REFERRABLE.includes(request.status)) {
    mount(status, el('div', { class: 'status-line' }, `This case is ${fmtStatus(request.status).toLowerCase()}; it cannot receive a referral.`));
  } else {
    mount(status);
  }

  const hr = S.res.hospitals;
  const gate = resourceGate(hr, { retry: () => load('hospitals'), empty: stateMsg('No hospitals', 'No hospitals are registered.') });
  if (gate) { renderSigs.delete('ranking'); return mount(results, gate); }
  renderRoadside();
  const sig = JSON.stringify([request, hr.data.map(h => [h.id, h.status, h.resources, h.doctors]), hr.status === 'error', referrable, S.inFlight.has(`referral:${request.request_id}`), role()]);
  if (unchanged('ranking', sig)) return;
  const ranked = rankForCase(request, hr.data);
  const eligible = ranked.filter(r => r.eligible).length;
  const canSend = can(...CREATES_CASES);
  mount(results,
    el('p', { class: 'field-caption' }, `${eligible} of ${ranked.length} hospitals can take this case now. Score: free-resource margin 40%, free ICU share 20%, distance 25% (when the pickup is known), configured acceptance prior 15%; limited intake −10.`),
    hr.status === 'error' ? errorMsg(hr.error, () => load('hospitals')) : null,
    ranked.map((row, i) => {
      const h = row.hospital;
      const missing = new Set((request.required_resource_types || []).filter(t => !h.resources[t] || h.resources[t].free < 1));
      return el('div', { class: ['hospital-card', i === 0 && row.eligible && 'top-match'], dataset: { hospitalId: h.id } },
        el('div', { class: 'hospital-header' },
          el('div', {},
            el('div', { class: 'hospital-name' }, el('span', { class: 'rank-badge' }, `#${i + 1}`), ' ', h.name, ' ', badge(h.status)),
            el('div', { class: 'hospital-meta' }, [h.address, row.distanceKm !== null ? `${row.distanceKm.toFixed(1)} km from pickup` : 'distance unknown'].filter(Boolean).join(' · '))),
          el('div', { class: 'score-badge' }, row.eligible ? [el('span', {}, String(row.score)), el('span', { class: 'score-label' }, 'Score')] : el('span', { class: 'text-danger' }, 'Not eligible'))),
        el('div', { class: 'resource-capsule-grid' },
          ['ICU_BED', 'VENTILATOR', 'OT'].map(t => {
            const res = h.resources[t];
            return el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, `${RESOURCE_LABELS[t]} free`),
              el('span', { class: ['capsule-val', !res || res.free < 1 ? 'empty' : res.free < 3 ? 'low' : 'good'] }, res ? `${res.free} / ${res.total}` : 'none'));
          }),
          el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, 'Specialist'),
            el('span', { class: ['capsule-val', request.required_specialist && !h.onDuty.has(request.required_specialist) ? 'empty' : 'good'] },
              request.required_specialist ? (h.onDuty.has(request.required_specialist) ? 'On duty' : 'Not available') : 'Not needed'))),
        row.eligible
          ? el('div', { class: 'score-factors' }, [
            row.factors.margin !== null ? `margin ${Math.round(row.factors.margin * 100)}%` : null,
            row.factors.capacity !== null ? `ICU share ${Math.round(row.factors.capacity * 100)}%` : null,
            row.factors.distance !== null ? `distance ${Math.round(row.factors.distance * 100)}%` : 'distance not scored',
            row.factors.prior !== null ? `configured acceptance prior ${Math.round(row.factors.prior * 100)}%` : null
          ].filter(Boolean).join(' · '))
          : el('ul', { class: 'exclusion-list' }, row.reasons.map(reason => el('li', {}, reason))),
        missing.size === 0 && canSend ? el('div', { class: 'hospital-card-actions' },
          el('button', {
            type: 'button', class: 'btn btn-primary btn-sm btn-init-referral', dataset: { hospitalId: h.id },
            disabled: !row.eligible || !referrable || S.inFlight.has(`referral:${request.request_id}`),
            title: !referrable ? 'This case cannot receive a new referral now.' : '',
            on: { click: () => initiateReferral(request.request_id, h.id) }
          }, 'Send referral (90 s hold)')) : null);
    }));
}

async function initiateReferral(requestId, hospitalId) {
  const key = `referral:${requestId}`;
  if (S.inFlight.has(key)) return;
  S.inFlight.add(key);
  renderRanking();
  const epoch = S.epoch; // an answer that arrives after logout belongs to the old session: drop it
  try {
    const res = await ReferralsAPI.initiate(requestId, hospitalId);
    if (epoch !== S.epoch) return;
    S.tracked.set(res.acceptance_id, { requestId, hospitalId, status: 'PENDING' });
    if (res.ttl_expires_at) S.lockDeadlines.set(res.acceptance_id, new Date(res.ttl_expires_at).getTime());
    notify(`Referral sent to ${hospitalName(hospitalId)}. Resources held for ${res.expires_in_sec || 90} s while the hospital decides.`, 'success');
    pushLiveEvent(`You referred ${requestId} to ${hospitalName(hospitalId)}`, 'warning');
    await loadCase(requestId, { quiet: true });
    if (epoch !== S.epoch) return;
    scheduleReload(['emergencies', 'hospitals', 'referralHistory', 'dashboard'], 50);
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`Referral not sent: ${errorText(err)}`, 'urgent');
    loadCase(requestId, { quiet: true });
    load('hospitals');
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      renderRanking();
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Acceptance console
// ──────────────────────────────────────────────────────────────────────────────
function ensureCaseSummary(requestId) {
  if (S.caseCache.has(requestId)) return S.caseCache.get(requestId);
  const entry = { status: 'loading', data: null, error: null };
  S.caseCache.set(requestId, entry);
  const epoch = S.epoch;
  EmergenciesAPI.detail(requestId).then(data => {
    if (epoch !== S.epoch) return;
    Object.assign(entry, { status: 'ok', data });
    renderAcceptance();
  }, err => {
    if (epoch !== S.epoch) return;
    Object.assign(entry, { status: 'error', error: err });
    renderAcceptance();
  });
  return entry;
}

function renderAcceptance() {
  const container = byId('acceptanceConsoleContent');
  if (!container || !can('ADMIN', 'HOSPITAL_DESK')) return;
  const r = S.res.activeLocks;
  const gate = resourceGate(r, {
    retry: () => load('activeLocks'),
    empty: stateMsg('No referrals waiting', role() === 'HOSPITAL_DESK'
      ? 'New referrals for your hospital appear here immediately, with a 90-second response window.'
      : 'No hospital is holding resources for a pending referral.')
  });
  if (gate) { renderSigs.delete('acceptance'); mount(container, gate); renderDecisions(); return; }
  const sig = JSON.stringify([r.data.map(l => [idOf(l), reqOf(l), hospOf(l), l.resourceTypes]),
    r.data.map(l => S.caseCache.get(reqOf(l))?.status), [...S.inFlight].filter(k => k.startsWith('decide:')), hospitals().map(h => h.name)]);
  if (unchanged('acceptance', sig)) { tickCountdowns(); renderDecisions(); return; }

  mount(container, r.data.map(lock => {
    const id = idOf(lock);
    const requestId = reqOf(lock);
    const info = ensureCaseSummary(requestId);
    const request = info.data?.request;
    const patient = info.data?.patient || {};
    const busy = S.inFlight.has(`decide:${id}`);
    const reasonInput = el('input', {
      type: 'text', class: 'form-input', maxlength: '300', placeholder: 'Reason if rejecting (e.g. no ICU bed free)',
      'aria-label': `Rejection reason for ${requestId}`, value: S.draft.reject.get(id) || '',
      on: { input: e => S.draft.reject.set(id, e.target.value) }
    });
    const mayDecide = can('ADMIN') || hospOf(lock) === S.user.hospital_id;
    return el('div', { class: 'referral-card', dataset: { acceptanceId: id, requestId } },
      el('div', { class: 'referral-card-head' },
        el('div', {},
          el('div', { class: 'hospital-name' }, `Referral for ${requestId}`),
          el('div', { class: 'hospital-meta' }, `To ${hospitalName(hospOf(lock))} · ${id}`)),
        el('div', {}, el('div', { class: 'kv-label' }, 'Time left'),
          el('div', { class: 'countdown', dataset: { deadline: String(S.lockDeadlines.get(id) ?? Date.now()), countdownFor: id } }, '…'))),
      info.status === 'loading' ? loadingMsg('Loading case…')
        : info.status === 'error' ? errorMsg(info.error)
          : el('div', { class: 'kv-grid' },
            kv('Patient', el('span', { class: 'patient-name' }, `${patient.full_name || '—'}${patient.age !== undefined ? (patient.age === null ? ', age unknown' : `, ${patient.age}y`) : ''}`)),
            kv('Emergency', fmtStatus(request?.emergency_type)),
            kv('Priority', priorityBadge(request?.priority)),
            kv('Resources held', resourceTags(lock.resourceTypes)),
            kv('Specialist', request?.required_specialist ? SPECIALIST_LABELS[request.required_specialist] || request.required_specialist : 'None'),
            kv('Notes', request?.clinical_notes || '—')),
      el('p', { class: 'field-caption expiry-note' }, ''),
      mayDecide ? el('div', { class: 'referral-actions' },
        el('button', { type: 'button', class: 'btn btn-success btn-accept', disabled: busy, on: { click: () => decide(lock, 'accept') } }, 'Accept and commit'),
        reasonInput,
        el('button', { type: 'button', class: 'btn btn-danger btn-reject', disabled: busy, on: { click: () => decide(lock, 'reject') } }, 'Reject')) : null);
  }));
  tickCountdowns();
  renderDecisions();
}

// A 4xx is the server's definite answer. A network failure, an unreadable body or a 5xx leaves the outcome unknown:
// the server may have committed the decision before its answer was lost.
const isDefinite = err => err instanceof ApiError && err.kind === 'http' && err.status >= 400 && err.status < 500;

async function decide(lock, action) {
  const id = idOf(lock);
  const key = `decide:${id}`;
  if (S.inFlight.has(key)) return;
  S.inFlight.add(key);
  renderAcceptance();
  const requestId = reqOf(lock);
  const epoch = S.epoch;
  const reason = action === 'reject' ? ((S.draft.reject.get(id) || '').trim() || 'No capacity at this time') : null;
  const send = () => (action === 'accept' ? ReferralsAPI.accept(id) : ReferralsAPI.reject(id, reason));
  let entry = null;
  try {
    let outcome;
    try {
      outcome = decisionOutcome(action, requestId, await send(), reason);
    } catch (err) {
      if (epoch !== S.epoch) return;
      if (isDefinite(err)) throw err;
      entry = { kind: 'unknown', at: Date.now(), requestId, action, message: 'The server\'s answer was lost. Checking the real outcome…' };
      S.decisions.unshift(entry);
      renderDecisions();
      notify(`${action === 'accept' ? 'Accept' : 'Reject'} of ${requestId}: outcome unknown, checking with the server…`, 'urgent');
      outcome = await resolveLostDecision(id, requestId, action, reason, send);
    }
    if (epoch !== S.epoch) return;
    if (entry) { Object.assign(entry, outcome, { at: Date.now() }); } else { S.decisions.unshift(outcome); }
    if (outcome.kind === 'accepted') {
      const res = outcome.res;
      notify(`Accepted ${requestId}. Resources committed${res.ambulance_id ? `; ambulance ${res.ambulance_id} dispatched.` : '; no ambulance was free, so transport must be dispatched.'}`, 'success');
    } else if (outcome.kind === 'rejected') {
      notify(`Rejected ${requestId}. ${outcome.res.next_hospital_id ? `The server offered it to ${hospitalName(outcome.res.next_hospital_id)}.` : 'No other hospital could be offered.'}`, 'normal');
    } else {
      notify(`${action === 'accept' ? 'Accept' : 'Reject'} of ${requestId}: ${outcome.message}`, 'urgent');
    }
    if (outcome.kind === 'accepted' || outcome.kind === 'rejected') S.draft.reject.delete(id);
    if (outcome.kind === 'accepted') S.caseCache.delete(requestId); // after a reject the case leaves a desk's scope
  } catch (err) {
    if (epoch !== S.epoch) return;
    const failed = { kind: 'failed', at: Date.now(), requestId, action, message: errorText(err) };
    if (entry) Object.assign(entry, failed); else S.decisions.unshift(failed);
    notify(`${action === 'accept' ? 'Accept' : 'Reject'} failed: ${errorText(err)}`, 'urgent');
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      scheduleReload(['activeLocks', 'emergencies', 'ambulances', 'hospitals', 'dashboard', 'referralHistory', 'referralStats'], 50);
      if (requestId === S.selectedRequestId && !(leavesScope(true) && action === 'reject')) loadCase(requestId, { quiet: true });
      renderAcceptance();
    }
  }
}

function decisionOutcome(action, requestId, res, reason) {
  return action === 'accept' ? { kind: 'accepted', requestId, res } : { kind: 'rejected', requestId, res, reason };
}

/**
 * The answer to an accept/reject was lost. Find out what the server actually did: an accept is retried (the server
 * replays a committed accept with `replayed: true`), and the case is read back when the retry is refused; a reject is
 * read back first and retried only if the referral is still pending.
 */
async function resolveLostDecision(acceptanceId, requestId, action, reason, send) {
  const readBack = async () => {
    const detail = await EmergenciesAPI.detail(requestId);
    return { detail, acc: (detail.acceptances || []).find(a => a.acceptance_id === acceptanceId) };
  };
  const fromServerState = ({ detail, acc }) => {
    if (acc?.status === 'ACCEPTED') {
      return { kind: 'accepted', requestId, res: { requestId, hospitalId: acc.hospital_id, ambulance_id: detail.request?.assigned_ambulance_id || null, specialist_id: null, replayed: true } };
    }
    if (acc?.status === 'REJECTED') {
      const next = (detail.acceptances || []).filter(a => a.status === 'PENDING' && a.acceptance_id !== acceptanceId).at(-1);
      return { kind: 'rejected', requestId, reason: acc.rejection_reason || reason, res: { next_hospital_id: next?.hospital_id || null } };
    }
    return { kind: 'failed', requestId, action, message: acc ? `not applied: the referral is now ${fmtStatus(acc.status).toLowerCase()}.` : 'not applied: the referral no longer exists on the server.' };
  };
  const unknown = err => ({ kind: 'unknown', requestId, action, message: `Outcome still unknown (${errorText(err)}). Check the case before acting again.` });
  try {
    if (action === 'accept') {
      try { return decisionOutcome(action, requestId, await send(), reason); } catch (err) { if (!isDefinite(err)) return unknown(err); }
      return fromServerState(await readBack());
    }
    const state = await readBack();
    if (state.acc?.status !== 'PENDING') return fromServerState(state);
    try { return decisionOutcome(action, requestId, await send(), reason); } catch (err) {
      if (!isDefinite(err)) return unknown(err);
      return fromServerState(await readBack());
    }
  } catch (err) {
    return unknown(err);
  }
}

function renderDecisions() {
  const container = byId('acceptanceResult');
  if (!container) return;
  if (!S.decisions.length) return mount(container, stateMsg('No decisions yet', 'The allocation the server commits is shown here after you accept.'));
  mount(container, S.decisions.slice(0, 10).map(d => {
    if (d.kind === 'accepted') {
      return el('div', { class: 'status-line is-success allocation-result', dataset: { requestId: d.requestId, hospitalId: d.res.hospitalId, ambulanceId: d.res.ambulance_id || '' } },
        el('strong', {}, `Allocation committed for ${d.res.requestId || d.requestId}`),
        el('span', {}, `Hospital: ${hospitalName(d.res.hospitalId)}`),
        el('span', {}, `Ambulance: ${d.res.ambulance_id || 'none free — dispatch required'}`),
        el('span', {}, `Specialist: ${d.res.specialist_id || '—'}`),
        el('span', { class: 'cell-muted' }, `${d.res.replayed ? 'Already accepted earlier (replayed). ' : ''}${fmtTime(d.at)}`));
    }
    if (d.kind === 'rejected') {
      return el('div', { class: 'status-line is-warning' },
        el('strong', {}, `Rejected ${d.requestId}`), el('span', {}, `Reason: ${d.reason}`),
        el('span', {}, d.res.next_hospital_id ? `Rerouted to ${hospitalName(d.res.next_hospital_id)}` : 'No further candidate'),
        el('span', { class: 'cell-muted' }, fmtTime(d.at)));
    }
    if (d.kind === 'unknown') {
      return el('div', { class: 'status-line is-warning decision-unknown', dataset: { requestId: d.requestId } },
        el('strong', {}, `${d.action === 'accept' ? 'Accept' : 'Reject'} of ${d.requestId}: outcome unknown`), el('span', {}, d.message),
        el('span', { class: 'cell-muted' }, fmtTime(d.at)));
    }
    return el('div', { class: 'status-line is-error decision-failed', dataset: { requestId: d.requestId } }, el('strong', {}, `${d.action} failed for ${d.requestId}`), el('span', {}, d.message), el('span', { class: 'cell-muted' }, fmtTime(d.at)));
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Hospital desk: Patients (GET /hospitals/:id/patients) — start treatment, mark completed
// ──────────────────────────────────────────────────────────────────────────────
// Where the patient's ambulance is, in the words a receiving hospital uses.
const ARRIVAL_TEXT = {
  DISPATCHED: 'Ambulance dispatched',
  EN_ROUTE_TO_PATIENT: 'Ambulance on the way to the patient',
  ARRIVED_AT_PATIENT: 'Ambulance with the patient',
  PATIENT_PICKED_UP: 'Patient on board',
  EN_ROUTE_TO_HOSPITAL: 'Ambulance arriving',
  ARRIVED_AT_HOSPITAL: 'Arrived',
  COMPLETED: 'Arrived'
};
const PATIENT_ORDER = { IN_TREATMENT: 0, ALLOCATED: 1, COMPLETED: 2, CANCELLED: 3 };
const treatNotes = new Map(); // requestId -> { tone, text }: the outcome of the last step on that patient
const progressNotes = new Map(); // requestId -> { status, data }: GET /emergencies/:id/notes, read once per change

function notesOf(requestId) {
  if (progressNotes.has(requestId)) return progressNotes.get(requestId).data || [];
  const entry = { status: 'loading', data: null };
  progressNotes.set(requestId, entry);
  const epoch = S.epoch;
  EmergenciesAPI.notes(requestId).then(res => {
    if (epoch !== S.epoch || progressNotes.get(requestId) !== entry) return;
    Object.assign(entry, { status: 'ok', data: res.notes || [] });
    renderHospitalPatients();
  }, () => { if (epoch === S.epoch && progressNotes.get(requestId) === entry) entry.status = 'error'; });
  return [];
}
const TRIAGE_CATEGORY = { RED: 'Red · immediate', YELLOW: 'Yellow · delayed', GREEN: 'Green · minor' };
const triageBadge = cat => (cat ? el('span', { class: ['badge-status', `badge-triage-${String(cat).toLowerCase()}`], dataset: { triage: cat } }, TRIAGE_CATEGORY[cat] || cat) : null);

/**
 * The receiving hospital's steps, in order. `next` is the one step the server will accept now (null: nothing to do).
 * Arrival of the ambulance on the map is not arrival at the hospital: the desk confirms it.
 */
function patientNextStep(c) {
  if (c.status === 'ALLOCATED' && !c.arrived_at) return 'arrive';
  if (c.status === 'ALLOCATED' && !c.bed_label) return 'allocate-bed';
  if (c.status === 'ALLOCATED') return 'start-treatment';
  if (c.status === 'IN_TREATMENT') return 'complete';
  return null;
}
const STEP_LABEL = { arrive: 'Confirm arrival', 'allocate-bed': 'Allocate bed', 'start-treatment': 'Start treatment', notes: 'Add note', complete: 'Complete treatment' };
const STEP_DONE = { arrive: 'Arrival confirmed. The ambulance seat is released.', 'allocate-bed': 'Bed allocated.', 'start-treatment': 'Treatment started.', notes: 'Note added.', complete: 'Treatment completed. The bed and equipment are released.' };

/** What the hospital has recorded so far: "Arrived 12:01 · Bed ICU-3 · Treatment from 12:05 · Completed 12:40". */
function patientMilestones(c) {
  const parts = [
    c.arrived_at ? `Arrived ${fmtTime(c.arrived_at)}` : null,
    c.bed_label ? `Bed ${c.bed_label}` : null,
    c.treatment_started_at ? `Treatment from ${fmtTime(c.treatment_started_at)}` : null,
    c.treatment_completed_at ? `Completed ${fmtTime(c.treatment_completed_at)}` : null
  ].filter(Boolean);
  return parts.length ? el('p', { class: 'pt-milestones' }, parts.join(' · ')) : null;
}

/** "AMB-01 · Ambulance arriving · ETA 0 min 40 s (simulated)" for a patient of the desk (the ETA from its live trip). */
function patientTripText(c) {
  if (!c.ambulance_id) return 'No ambulance assigned';
  if (!c.trip_phase) return `${c.ambulance_id} · no trip on the map`;
  const trip = trips().filter(t => t.request_id === c.request_id && !t.completed).at(-1);
  const eta = trip && TRACK_MOVING.includes(trip.phase) && trip.eta_seconds !== null && trip.eta_seconds !== undefined ? ` · ETA ${fmtEta(trip.eta_seconds)}` : '';
  return `${c.ambulance_id} · ${ARRIVAL_TEXT[c.trip_phase] || fmtStatus(c.trip_phase)}${eta} (simulated)`;
}

function renderHospitalPatients() {
  const box = byId('hospitalPatientsContent');
  if (!box || !can('HOSPITAL_DESK')) return;
  const r = S.res.patients;
  const gate = resourceGate(r, { retry: () => load('patients'),
    empty: stateMsg('No patients yet', 'Cases your hospital accepts appear here, with their ambulance on the way.') });
  if (gate) { renderSigs.delete('patients'); return mount(box, gate); }
  const sig = JSON.stringify([r.data, [...S.inFlight].filter(k => k.startsWith('pt:')), [...treatNotes], [...progressNotes].map(([k, v]) => [k, v.data])]);
  if (unchanged('patients', sig)) return; // keeps a bed label or note being typed
  const list = [...r.data].sort((a, b) => (PATIENT_ORDER[a.status] ?? 9) - (PATIENT_ORDER[b.status] ?? 9)
    || (Number(a.triage_priority) || 5) - (Number(b.triage_priority) || 5) || String(a.request_id).localeCompare(String(b.request_id)));
  mount(box, el('div', { class: 'patient-list', id: 'hospitalPatientsList' }, list.map(c => {
    const id = c.request_id;
    const busy = S.inFlight.has(`pt:${id}`);
    const next = patientNextStep(c);
    const note = treatNotes.get(id);
    const ambulance = patientTripText(c);
    const actions = [];
    if (next === 'allocate-bed') {
      const input = el('input', { class: 'form-input pt-bed', type: 'text', maxlength: '40', placeholder: 'Bed, e.g. ICU-3', 'aria-label': `Bed for ${id}`, value: S.draft.bed.get(id) || '',
        on: { input: e => { S.draft.bed.set(id, e.target.value); } } });
      actions.push(input, el('button', { type: 'button', class: 'btn btn-primary btn-sm pt-action', dataset: { step: 'allocate-bed' }, disabled: busy,
        on: { click: () => { const label = input.value.trim(); if (!label) { treatNotes.set(id, { tone: 'error', text: 'Type the bed label first (e.g. ICU-3).' }); return renderHospitalPatients(); } patientStep(c, 'allocate-bed', { bed_label: label }); } } }, STEP_LABEL['allocate-bed']));
    } else if (next === 'complete') {
      const input = el('input', { class: 'form-input pt-note', type: 'text', maxlength: '500', placeholder: 'Progress note', 'aria-label': `Progress note for ${id}`, value: S.draft.note.get(id) || '',
        on: { input: e => { S.draft.note.set(id, e.target.value); } } });
      actions.push(input, el('button', { type: 'button', class: 'btn btn-secondary btn-sm pt-action', dataset: { step: 'notes' }, disabled: busy,
        on: { click: () => { const text = input.value.trim(); if (!text) { treatNotes.set(id, { tone: 'error', text: 'Type the note first.' }); return renderHospitalPatients(); } patientStep(c, 'notes', { note: text }); } } }, STEP_LABEL.notes));
      actions.push(el('button', { type: 'button', class: 'btn btn-success btn-sm pt-action', dataset: { step: 'complete' }, disabled: busy, on: { click: () => patientStep(c, 'complete') } }, STEP_LABEL.complete));
    } else if (next) {
      actions.push(el('button', { type: 'button', class: 'btn btn-primary btn-sm pt-action', dataset: { step: next }, disabled: busy, on: { click: () => patientStep(c, next) } }, STEP_LABEL[next]));
    }
    const notes = ['IN_TREATMENT', 'COMPLETED'].includes(c.status) ? notesOf(id) : [];
    return el('article', { class: 'patient-card', dataset: { requestId: id, status: c.status, next: next || '', tripPhase: c.trip_phase || '' } },
      el('div', { class: 'patient-card-head' },
        el('div', {},
          el('div', { class: 'patient-name' }, c.patient_name || 'Unknown patient'),
          el('div', { class: 'hospital-meta' }, [id, `${c.age ?? 'age unknown'}${c.age !== null && c.age !== undefined ? 'y' : ''}`, c.gender ? fmtStatus(c.gender).toLowerCase() : null, fmtStatus(c.emergency_type)].filter(Boolean).join(' · '))),
        el('div', { class: 'patient-card-badges' }, triageBadge(c.triage_category), priorityBadge(c.triage_priority), badge(c.status), incidentBadge(c.incident_id))),
      journeyBar(journeyStage(c)),
      el('div', { class: 'patient-card-trip' }, el('span', { class: 'kv-label' }, 'Ambulance '), el('span', { class: 'patient-trip' }, ambulance)),
      patientMilestones(c),
      notes.length ? el('ul', { class: 'pt-notes' }, notes.slice(-3).map(n => el('li', {}, el('span', { class: 'cell-time' }, fmtTime(n.created_at)), ` ${n.note}`))) : null,
      note ? el('p', { class: ['status-line', note.tone === 'success' ? 'is-success' : note.tone === 'warning' ? 'is-warning' : 'is-error', 'treat-note'], role: 'status' }, note.text) : null,
      actions.length ? el('div', { class: 'patient-card-actions' }, actions) : null);
  })));
}

/** One step on one patient. The server decides (state, order, own hospital); its answer is shown as it is. */
async function patientStep(c, step, body) {
  const id = c.request_id;
  const key = `pt:${id}`;
  if (S.inFlight.has(key)) return; // double-submit safe
  if (step !== 'notes' && patientNextStep(c) !== step) return; // only the step the case is ready for
  if (step === 'complete' && !window.confirm(`Complete treatment for ${c.patient_name || id} (${id})? This releases the bed and equipment held for this case.`)) return;
  S.inFlight.add(key);
  treatNotes.delete(id);
  renderHospitalPatients();
  const epoch = S.epoch;
  try {
    await EmergenciesAPI.caseStep(id, step, body);
    if (epoch !== S.epoch) return;
    if (step === 'allocate-bed') S.draft.bed.delete(id);
    if (step === 'notes') { S.draft.note.delete(id); progressNotes.delete(id); }
    treatNotes.set(id, { tone: 'success', text: STEP_DONE[step] });
  } catch (err) {
    if (epoch !== S.epoch) return;
    const text = !isDefinite(err)
      ? `Outcome unknown: the server's answer was lost (${errorText(err)}). The list is re-read from the server and shows the case as it is now.`
      : err.status === 403 ? `Not allowed: ${errorText(err)}`
        : err.status === 409 ? `Not possible now: ${errorText(err)}`
          : `Not done: ${errorText(err)}`;
    treatNotes.set(id, { tone: isDefinite(err) ? 'error' : 'warning', text });
    notify(text, 'urgent');
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      renderHospitalPatients();
      load('patients'); // the server's state wins (also after a lost answer)
      scheduleReload(['emergencies', 'hospitals', 'dashboard', 'ambulances'], 50);
      if (id === S.selectedRequestId) loadCase(id, { quiet: true });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Hospitals
// ──────────────────────────────────────────────────────────────────────────────
function renderHospitals() {
  const container = byId('hospitalsManagementGrid');
  const r = S.res.hospitals;
  const gate = resourceGate(r, { retry: () => load('hospitals'), empty: stateMsg('No hospitals', 'No facilities are registered.') });
  if (gate) { setText('hospitalResultsCount', ''); return mount(container, gate); }
  const query = (byId('hospitalSearch')?.value || '').trim().toLowerCase();
  const statusFilter = byId('hospitalStatusFilter')?.value || 'ALL';
  const list = r.data.filter(h => (!query || `${h.id} ${h.name} ${h.address}`.toLowerCase().includes(query)) && (statusFilter === 'ALL' || h.status === statusFilter));
  setText('hospitalResultsCount', `${list.length} of ${r.data.length} facilities`);
  if (!list.length) return mount(container, stateMsg('No facilities found', 'Try a different name or status.'));
  mount(container, list.map(h => {
    // Keep the admin's pending choice across live re-renders (a socket refresh must not reset it before "Set status").
    const chosen = S.draft.hospitalStatus.get(h.id) || h.status;
    const statusSelect = el('select', { class: 'form-select form-select-inline', 'aria-label': `Emergency status for ${h.name}`,
      on: { change: e => S.draft.hospitalStatus.set(h.id, e.target.value) } },
      ['OPEN', 'LIMITED', 'CLOSED'].map(s => el('option', { value: s, selected: s === chosen }, fmtStatus(s))));
    return el('article', { class: 'hospital-card operations-hospital-card', dataset: { hospitalId: h.id } },
      el('div', { class: 'hospital-header' },
        el('div', {}, el('div', { class: 'hospital-name' }, el('span', { class: 'rank-badge' }, h.id), ' ', h.name),
          el('div', { class: 'hospital-meta' }, [h.address, h.phone].filter(Boolean).join(' · '))),
        badge(h.status)),
      el('div', { class: 'resource-capsule-grid' }, ['ICU_BED', 'VENTILATOR', 'OT'].map(t => {
        const res = h.resources[t];
        return el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, `${RESOURCE_LABELS[t]} free`),
          el('span', { class: ['capsule-val', !res || res.free < 1 ? 'empty' : 'good'] }, res ? `${res.free} / ${res.total}${res.locked ? ` (${res.locked} held)` : ''}` : 'none'));
      })),
      hospitalOverview(S.res.overview.data?.get?.(h.id)),
      el('div', { class: 'hospital-card-footer' },
        el('span', {}, `Specialists on duty: ${[...h.onDuty].filter(s => SPECIALIST_LABELS[s]).map(s => SPECIALIST_LABELS[s]).join(', ') || 'none'}`),
        el('span', {}, h.traumaLevel || '')),
      can('ADMIN') ? el('div', { class: 'hospital-card-actions' }, statusSelect,
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => updateHospitalStatus(h.id, statusSelect.value) } }, 'Set status')) : null);
  }));
}

/** ADMIN overview of one hospital (GET /hospitals/overview): capacity by state, doctors, referrals and cases. */
function hospitalOverview(o) {
  if (!o) return null;
  const n = v => (v === null || v === undefined ? '—' : String(v));
  const res = o.resources || {};
  const docs = o.doctors || {};
  const ref = o.referrals_24h || o.referrals || {};
  const act = o.active_cases || {};
  return el('div', { class: 'hospital-overview', dataset: { overview: o.hospital_id } },
    el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table overview-table' },
      el('thead', {}, el('tr', {}, ['Resource', 'Total', 'Available', 'Reserved', 'Occupied'].map(t => el('th', {}, t)))),
      el('tbody', {}, Object.entries(res).map(([t, r]) => el('tr', { dataset: { resource: t } },
        el('td', {}, t === 'OT' ? 'OT' : RESOURCE_LABELS[t] || fmtStatus(t)), el('td', {}, n(r.total)), el('td', {}, n(r.available)), el('td', {}, n(r.reserved)), el('td', {}, n(r.occupied))))))),
    el('div', { class: 'overview-lines' },
      el('span', {}, el('strong', {}, 'Doctors available: '), Object.entries(docs).map(([sp, d]) => `${SPECIALIST_LABELS[sp] || fmtStatus(sp)} ${n(d.available)}/${n(d.total)}`).join(' · ') || 'none'),
      el('span', {}, el('strong', {}, 'Referrals (24 h): '), `${n(ref.pending)} pending · ${n(ref.accepted)} accepted · ${n(ref.rejected)} rejected · ${n(ref.expired)} expired`),
      el('span', { class: 'overview-cases' }, el('strong', {}, 'Active cases: '), `${n(act.allocated)} allocated · ${n(act.arrived)} arrived · ${n(act.in_treatment)} in treatment · ${n(o.completed_24h)} completed (24 h)`)));
}

async function updateHospitalStatus(id, status) {
  const epoch = S.epoch;
  try {
    await HospitalsAPI.updateStatus(id, status);
    if (epoch !== S.epoch) return;
    S.draft.hospitalStatus.delete(id);
    notify(`${hospitalName(id)} is now ${fmtStatus(status).toLowerCase()}.`, 'success');
    scheduleReload(['hospitals', 'dashboard'], 50);
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`Status not changed: ${errorText(err)}`, 'urgent');
  }
}

function renderHospitalOptions() {
  const list = hospitals();
  const facility = byId('doctorFacilityFilter');
  if (facility) {
    const current = facility.value;
    mount(facility, el('option', { value: 'ALL' }, 'All hospitals'), list.map(h => el('option', { value: h.id }, `${h.name} (${h.id})`)));
    facility.value = list.some(h => h.id === current) ? current : 'ALL';
  }
  const add = byId('newDoctorHospital');
  if (add) {
    const allowed = can('ADMIN') ? list : list.filter(h => h.id === S.user?.hospital_id);
    mount(add, allowed.map(h => el('option', { value: h.id }, h.name)));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fleet — Admin manages units; Fleet crews only act on their own assigned trips.
// ──────────────────────────────────────────────────────────────────────────────
function renderFleet() {
  const container = byId('ambulanceFleetGrid');
  const r = S.res.ambulances;
  const gate = resourceGate(r, { retry: () => load('ambulances'), empty: stateMsg('No ambulances', 'No units are registered.') });
  if (gate) { renderSigs.delete('fleet'); setText('ambulanceResultsCount', ''); return mount(container, gate); }
  const query = (byId('ambulanceSearch')?.value || '').trim().toLowerCase();
  const statusFilter = byId('ambulanceStatusFilter')?.value || 'ALL';
  const list = r.data.filter(a => (!query || `${a.ambulance_id} ${a.vehicle_number} ${a.hospital_name || ''} ${a.hospital_id}`.toLowerCase().includes(query))
    && (statusFilter === 'ALL' || a.status === statusFilter));
  setText('ambulanceResultsCount', `${list.length} of ${r.data.length} units`);
  // Cases available for Admin dispatch; hospital and Fleet views are scoped by the server.
  const needTransport = queue().filter(item => item.transport_required
    && (!can('HOSPITAL_DESK') || item.accepted_hospital_id === S.user.hospital_id));
  const sig = JSON.stringify([list, needTransport.map(i => [i.request_id, i.priority, patientOf(i).full_name]), [...S.inFlight].filter(k => k.startsWith('amb:') || k.startsWith('seat:')), hospitals().map(h => h.name), [...S.draft.capacity]]);
  if (unchanged('fleet', sig)) return;
  if (!list.length) return mount(container, stateMsg('No units found', 'Adjust the filters.'));
  mount(container, list.map(a => {
    const id = a.ambulance_id;
    const onRoad = ON_ROAD.includes(a.status);
    const mayAct = can('ADMIN'); // Only Admin dispatches or changes fleet availability; Fleet uses trip actions for pickup/transport.
    const busy = S.inFlight.has(`amb:${id}`);
    const hasPos = a.current_lat !== null && a.current_lat !== undefined && a.current_lng !== null && a.current_lng !== undefined;
    const actions = [];
    if (mayAct && a.status === 'AVAILABLE') {
      const select = el('select', { class: 'form-select', 'aria-label': `Case for ${id}`, on: { change: e => S.draft.dispatch.set(id, e.target.value) } },
        el('option', { value: '' }, needTransport.length ? 'Choose a case needing transport' : 'No case needs transport'),
        needTransport.map(item => el('option', { value: item.request_id, selected: S.draft.dispatch.get(id) === item.request_id },
          `${item.request_id} · ${triageLabel(item.triage_category, item.priority)} · ${patientOf(item).full_name || ''}`)));
      actions.push(el('div', { class: 'row' }, select,
        el('button', { type: 'button', class: 'btn btn-primary btn-sm btn-dispatch', disabled: busy || !needTransport.length,
          on: { click: () => { const rid = select.value; if (!rid) return notify('Choose the case to dispatch to.', 'urgent'); updateAmbulance(id, { status: 'DISPATCHED', request_id: rid }); } } }, 'Dispatch')));
    }
    if (mayAct && a.status === 'DISPATCHED') {
      const eta = el('input', { type: 'number', class: 'form-input', min: '0', max: '600', step: '1', placeholder: 'ETA (min)', 'aria-label': `ETA in minutes for ${id}`,
        value: S.draft.eta.get(id) ?? '', on: { input: e => S.draft.eta.set(id, e.target.value) } });
      actions.push(el('div', { class: 'row' }, eta,
        el('button', { type: 'button', class: 'btn btn-primary btn-sm btn-in-transit', disabled: busy, on: { click: () => {
          const body = { status: 'IN_TRANSIT' };
          if (eta.value !== '') {
            const n = Number(eta.value);
            if (!Number.isInteger(n) || n < 0) return notify('ETA must be a whole number of minutes.', 'urgent');
            body.eta_mins = n;
          }
          updateAmbulance(id, body);
        } } }, 'Mark in transit')));
    }
    if (mayAct && onRoad) {
      actions.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: busy,
        on: { click: () => { if (window.confirm(`Return ${id} to station? It stops serving ${a.assigned_request_id || 'its case'}.`)) updateAmbulance(id, { status: 'AVAILABLE' }); } } }, 'Return to station')));
    }
    if (mayAct && a.status === 'AVAILABLE') {
      actions.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: busy, on: { click: () => updateAmbulance(id, { status: 'MAINTENANCE' }) } }, 'Take out of service')));
    }
    if (mayAct && a.status === 'MAINTENANCE') {
      actions.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: busy, on: { click: () => updateAmbulance(id, { status: 'AVAILABLE' }) } }, 'Return to service')));
    }
    return el('div', { class: 'hospital-card', dataset: { ambulanceId: id } },
      el('div', { class: 'hospital-header' },
        el('div', {}, el('div', { class: 'hospital-name' }, id),
          el('div', { class: 'hospital-meta' }, `${a.ambulance_type || ''} · ${a.vehicle_number || ''} · station ${a.hospital_name || a.hospital_id}`)),
        badge(a.status)),
      el('div', { class: 'kv-grid' },
        kv('Case', onRoad && a.assigned_request_id ? a.assigned_request_id : '—'),
        kv('Destination', a.destination_hospital_id ? hospitalName(a.destination_hospital_id) : '—'),
        kv('ETA', a.status === 'IN_TRANSIT' && a.eta_mins !== null && a.eta_mins !== undefined ? `${a.eta_mins} min` : '—'),
        kv('Position', hasPos ? `${fmtNumber(a.current_lat, 4)}, ${fmtNumber(a.current_lng, 4)}` : 'Not reported'),
        kv('Updated', a.updated_at ? fmtTime(a.updated_at) : '—')),
      fleetSeats(a),
      actions.length ? el('div', { class: 'fleet-actions' }, actions) : null);
  }));
}

/**
 * Server features the screens offer only once the API has them (Batch 8 P1-D seats and the triage update are not built
 * yet): seats = GET /ambulances reports each unit's assignments[] (with /ambulances/:id/capacity|assign|unassign|pickup);
 * triageUpdate = POST /emergencies/:id/triage. Until then those controls are not shown rather than failing with 404.
 */
const seatsApi = () => (S.res.ambulances.data || []).some(a => Array.isArray(a.assignments));
const TRIAGE_UPDATE_API = false;

/** Seats on one unit: capacity, occupied, free; its patients (each picked up by the crew, handed over at the hospital). */
function fleetSeats(a) {
  if (!Array.isArray(a.assignments)) return null;
  const id = a.ambulance_id;
  const cap = Number(a.capacity) || 1;
  const used = Number(a.occupied ?? a.assignments?.length ?? 0);
  const busy = S.inFlight.has(`seat:${id}`);
  const list = Array.isArray(a.assignments) ? a.assignments : [];
  const capSelect = can('ADMIN') ? el('select', { class: 'form-select form-select-inline fleet-capacity', 'aria-label': `Seats on ${id}`, on: { change: e => S.draft.capacity.set(id, e.target.value) } },
    [1, 2, 3, 4].map(n => el('option', { value: String(n), selected: String(n) === String(S.draft.capacity.get(id) ?? cap) }, `${n} seat${n > 1 ? 's' : ''}`))) : null;
  return el('div', { class: 'fleet-seats', dataset: { capacity: String(cap), occupied: String(used) } },
    el('div', { class: 'fleet-seats-head' }, el('strong', {}, `Seats: ${used} of ${cap} taken · ${Math.max(0, cap - used)} free`),
      capSelect ? el('span', { class: 'row' }, capSelect, el('button', { type: 'button', class: 'btn btn-secondary btn-sm fleet-capacity-save', disabled: busy,
        on: { click: () => setCapacity(id, Number(capSelect.value)) } }, 'Save seats')) : null),
    list.length ? el('ul', { class: 'fleet-patients' }, list.map(p => {
      const rid = p.request_id;
      const pick = can('PARAMEDIC') && !p.picked_up_at
        ? el('button', { type: 'button', class: 'btn btn-primary btn-sm fleet-pickup', dataset: { requestId: rid }, disabled: busy, on: { click: () => pickupPatient(id, rid) } }, 'Picked up') : null;
      return el('li', { dataset: { requestId: rid } },
        el('span', { class: 'patient-name' }, p.label || p.patient_name || p.full_name || rid), ' ', triageBadge(p.triage_category),
        el('span', { class: 'cell-muted' }, ` ${rid} · ${p.picked_up_at ? 'on board' : 'to pick up'}${p.hospital_id || p.destination_hospital_id ? ` → ${hospitalName(p.hospital_id || p.destination_hospital_id)}` : ''}`),
        pick);
    })) : el('p', { class: 'cell-muted' }, 'No patient assigned.'),
    can('PARAMEDIC') && list.length ? el('p', { class: 'field-caption' }, 'The hospital confirms the arrival; that frees the seat.') : null);
}

async function seatCall(id, call, done) {
  const key = `seat:${id}`;
  if (S.inFlight.has(key)) return;
  S.inFlight.add(key);
  renderFleet();
  const epoch = S.epoch;
  try {
    await call();
    if (epoch !== S.epoch) return;
    notify(done, 'success');
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`${id}: ${isDefinite(err) ? errorText(err) : `outcome unknown (${errorText(err)}); the fleet is re-read from the server`}`, 'urgent');
  } finally {
    if (epoch === S.epoch) { S.inFlight.delete(key); loadMany(['ambulances', 'emergencies']); mciReload(); }
  }
}
const setCapacity = (id, n) => seatCall(id, async () => { await AmbulancesAPI.setCapacity(id, n); S.draft.capacity.delete(id); }, `${id} now has ${n} seat${n > 1 ? 's' : ''}.`);
const pickupPatient = (id, rid) => seatCall(id, () => AmbulancesAPI.pickup(id, rid), `${rid} picked up.`);

async function updateAmbulance(id, body) {
  const key = `amb:${id}`;
  if (S.inFlight.has(key)) return;
  S.inFlight.add(key);
  renderFleet();
  const epoch = S.epoch;
  try {
    const res = await AmbulancesAPI.updateStatus(id, body);
    if (epoch !== S.epoch) return;
    S.draft.eta.delete(id); S.draft.dispatch.delete(id);
    notify(`${id} is now ${fmtStatus(res.ambulance?.status || body.status).toLowerCase()}${body.request_id ? ` for ${body.request_id}` : ''}.`, 'success');
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`${id} not updated: ${errorText(err)}`, 'urgent');
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      await loadMany(['ambulances', 'emergencies', 'dashboard']);
      if (epoch === S.epoch && S.selectedRequestId) loadCase(S.selectedRequestId, { quiet: true });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Map
// ──────────────────────────────────────────────────────────────────────────────
function ensureMap() {
  const container = byId('leafletMapContainer');
  if (!container || !S.user) return;
  if (typeof window.L === 'undefined') {
    setText('mapCaption', 'The map library could not be loaded, so the map is unavailable. Hospital and fleet data are still on their own tabs.');
    return;
  }
  if (!S.map) {
    const L = window.L;
    S.map = L.map(container, { zoomControl: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    addOsmTiles(L, S.map);
    S.mapLayers = { hospitals: L.layerGroup().addTo(S.map), ambulances: L.layerGroup().addTo(S.map), incidents: L.layerGroup().addTo(S.map) };
    S.mapFitted = false;
  }
  setTimeout(() => S.map?.invalidateSize(), 50);
  renderMapData();
}

function popup(...lines) {
  return el('div', { class: 'map-popup' }, lines.filter(Boolean).map((line, i) => (i === 0 ? el('strong', {}, line) : el('div', {}, line))));
}

function renderMapData() {
  if (!S.map || !S.mapLayers || typeof window.L === 'undefined') return;
  const L = window.L;
  Object.values(S.mapLayers).forEach(layer => layer.clearLayers());
  const bounds = [];
  let unplaced = 0;
  hospitals().forEach(h => {
    if (h.lat === null || h.lng === null) { unplaced += 1; return; }
    const icu = h.resources.ICU_BED;
    const share = icu && icu.total > 0 ? icu.free / icu.total : 0;
    const color = h.status === 'CLOSED' || !icu || icu.free < 1 ? '#dc2626' : share < 0.2 ? '#d97706' : '#16a34a';
    L.circleMarker([h.lat, h.lng], { radius: 10, color, fillColor: color, fillOpacity: 0.7, weight: 2 })
      .bindPopup(popup(h.name, `Status: ${fmtStatus(h.status)}`, icu ? `ICU free ${icu.free} / ${icu.total}` : 'No ICU'))
      .addTo(S.mapLayers.hospitals);
    bounds.push([h.lat, h.lng]);
  });
  let ambUnplaced = 0;
  (S.res.ambulances.data || []).forEach(a => {
    const lat = Number(a.current_lat); const lng = Number(a.current_lng);
    if (a.current_lat === null || a.current_lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) { ambUnplaced += 1; return; }
    L.circleMarker([lat, lng], { radius: 7, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.9, weight: 2 })
      .bindPopup(popup(a.ambulance_id, `Status: ${fmtStatus(a.status)}`, a.assigned_request_id && ON_ROAD.includes(a.status) ? `Case ${a.assigned_request_id}` : null))
      .addTo(S.mapLayers.ambulances);
    bounds.push([lat, lng]);
  });
  queue().filter(item => !TERMINAL.includes(item.status)).forEach(item => {
    const lat = Number(item.pickup_lat); const lng = Number(item.pickup_lng);
    if (item.pickup_lat === null || item.pickup_lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    L.circleMarker([lat, lng], { radius: 6, color: '#7c3aed', fillColor: '#7c3aed', fillOpacity: 0.8, weight: 2, className: 'map-incident' })
      .bindPopup(popup(item.request_id, patientOf(item).full_name || null, `${fmtStatus(item.emergency_type)} · ${triageLabel(item.triage_category, item.priority)}`, fmtStatus(item.status)))
      .addTo(S.mapLayers.incidents);
  });
  [['layerToggleHospitals', 'hospitals'], ['layerToggleAmbulances', 'ambulances'], ['layerToggleIncidents', 'incidents']].forEach(([id, key]) => {
    const on = byId(id)?.checked !== false;
    if (on && !S.map.hasLayer(S.mapLayers[key])) S.mapLayers[key].addTo(S.map);
    if (!on && S.map.hasLayer(S.mapLayers[key])) S.map.removeLayer(S.mapLayers[key]);
  });
  if (!S.mapFitted && bounds.length) { S.map.fitBounds(bounds, { padding: [30, 30] }); S.mapFitted = true; }
  setText('mapCaption', [unplaced ? `${unplaced} hospital(s) have no coordinates.` : '', ambUnplaced ? `${ambUnplaced} ambulance(s) have no reported position.` : ''].filter(Boolean).join(' '));
}

// ──────────────────────────────────────────────────────────────────────────────
// Specialists
// ──────────────────────────────────────────────────────────────────────────────
function renderDoctors() {
  const body = byId('doctorsTableBody');
  const r = S.res.doctors;
  const gate = resourceGate(r, { retry: () => load('doctors'), empty: stateMsg('No specialists', 'No doctors are on the roster.') });
  if (gate) return mount(body, el('tr', {}, el('td', { colspan: '6' }, gate)));
  const q = (byId('doctorSearch')?.value || '').trim().toLowerCase();
  const fac = byId('doctorFacilityFilter')?.value || 'ALL';
  const spec = byId('doctorSpecFilter')?.value || 'ALL';
  const st = byId('doctorStatusFilter')?.value || 'ALL';
  const list = r.data.filter(d => (!q || `${d.doctor_id} ${d.full_name}`.toLowerCase().includes(q))
    && (fac === 'ALL' || d.hospital_id === fac) && (spec === 'ALL' || d.specialization === spec) && (st === 'ALL' || d.availability_status === st));
  if (!list.length) return mount(body, el('tr', {}, el('td', { colspan: '6' }, stateMsg('No matching specialists', 'Adjust the filters.'))));
  mount(body, list.map(d => {
    const mayEdit = can('ADMIN') || (can('HOSPITAL_DESK') && d.hospital_id === S.user.hospital_id);
    const statusCell = mayEdit && ['AVAILABLE', 'IN_PROCEDURE', 'OFF_DUTY'].includes(d.availability_status)
      ? el('select', { class: 'form-select form-select-inline', 'aria-label': `Status of ${d.full_name}`, on: { change: e => updateDoctorStatus(d.doctor_id, e.target.value) } },
        ['AVAILABLE', 'IN_PROCEDURE', 'OFF_DUTY'].map(s => el('option', { value: s, selected: s === d.availability_status }, fmtStatus(s))))
      : badge(d.availability_status === 'AVAILABLE' ? 'OPEN' : 'LIMITED', fmtStatus(d.availability_status));
    return el('tr', {},
      el('td', { class: 'cell-id' }, d.doctor_id), el('td', {}, d.full_name), el('td', {}, hospitalName(d.hospital_id)),
      el('td', {}, SPECIALIST_LABELS[d.specialization] || fmtStatus(d.specialization)),
      el('td', { class: 'cell-time' }, `${d.shift_start || '—'}–${d.shift_end || '—'}`), el('td', {}, statusCell));
  }));
}

async function updateDoctorStatus(id, status) {
  const epoch = S.epoch;
  try {
    await DoctorsAPI.updateStatus(id, status);
    if (epoch !== S.epoch) return;
    notify(`Specialist ${id} is now ${fmtStatus(status).toLowerCase()}.`, 'success');
  } catch (err) {
    if (epoch !== S.epoch) return;
    notify(`Status not changed: ${errorText(err)}`, 'urgent');
  } finally {
    if (epoch === S.epoch) loadMany(['doctors', 'hospitals']);
  }
}

function initDoctorModal() {
  const modal = byId('addDoctorModal');
  const close = () => modal.classList.remove('is-open');
  byId('btnOpenAddDoctorModal')?.addEventListener('click', () => { renderHospitalOptions(); byId('addDoctorError').hidden = true; modal.classList.add('is-open'); });
  byId('closeDoctorModalBtn')?.addEventListener('click', close);
  modal?.addEventListener('click', e => { if (e.target === modal) close(); });
  byId('addDoctorForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = byId('addDoctorError');
    errEl.hidden = true;
    const body = {
      hospital_id: byId('newDoctorHospital').value, full_name: byId('newDoctorName').value.trim(),
      specialization: byId('newDoctorSpec').value, shift_start: byId('newDoctorShiftStart').value, shift_end: byId('newDoctorShiftEnd').value
    };
    if (!body.full_name || !body.hospital_id) { errEl.textContent = 'Name and hospital are required.'; errEl.hidden = false; return; }
    const epoch = S.epoch;
    try {
      await DoctorsAPI.create(body);
      if (epoch !== S.epoch) return;
      notify(`${body.full_name} added to ${hospitalName(body.hospital_id)}.`, 'success');
      byId('addDoctorForm').reset();
      close();
      loadMany(['doctors', 'hospitals']);
    } catch (err) {
      if (epoch !== S.epoch) return;
      errEl.textContent = errorText(err); errEl.hidden = false;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit (ADMIN)
// ──────────────────────────────────────────────────────────────────────────────
function auditRows() {
  const q = (byId('auditCaseFilter')?.value || '').trim().toLowerCase();
  return (S.res.audit.data || []).filter(e => !q || `${e.request_id || ''} ${e.event_type} ${e.hospital_id || ''}`.toLowerCase().includes(q));
}

function renderAudit() {
  const body = byId('auditLedgerTableBody');
  if (!body || !can('ADMIN')) return;
  const r = S.res.audit;
  const gate = resourceGate(r, { retry: () => load('audit'), empty: stateMsg('No audit records', 'The ledger is empty.') });
  if (gate) { setText('auditResultCount', ''); return mount(body, el('tr', {}, el('td', { colspan: '8' }, gate))); }
  const rows = auditRows();
  setText('auditResultCount', `${rows.length} of ${r.data.length} most recent records`);
  mount(body, rows.map(e => el('tr', { dataset: { requestId: e.request_id || '' } },
    el('td', { class: 'cell-id' }, e.chain_seq ?? '—'),
    el('td', { class: 'cell-time' }, fmtDateTime(e.event_time)),
    el('td', {}, fmtStatus(e.event_type)),
    el('td', { class: 'cell-id' }, e.request_id || '—'),
    el('td', { class: 'cell-muted' }, e.hospital_id || '—'),
    el('td', { class: 'cell-muted' }, `${e.previous_state || '—'} → ${e.new_state || '—'}`),
    el('td', { class: 'cell-muted' }, [e.actor_role, e.actor_id].filter(Boolean).join(' · ')),
    el('td', { class: 'hash-cell', title: e.row_hash || '' }, e.row_hash ? `${String(e.row_hash).slice(0, 16)}…` : 'unchained'))));
}

async function verifyAuditChain() {
  const container = byId('auditVerifyResult');
  const btn = byId('btnVerifyAuditChain');
  if (!S.user) return;
  btn.disabled = true;
  mount(container, loadingMsg('Verifying the whole chain on the server…'));
  const epoch = S.epoch;
  try {
    const { verification: v } = await AuditAPI.verify();
    if (epoch !== S.epoch) return;
    const brk = v.first_break;
    mount(container,
      el('div', { class: ['audit-summary-card', v.valid ? 'is-valid' : 'is-invalid'], id: 'auditVerifyStatus' },
        el('strong', {}, v.valid ? 'Chain intact' : 'Chain broken'), el('span', {}, `checked ${v.checked} records at ${fmtTime(Date.now())}`)),
      el('div', { class: 'audit-summary-card' }, el('strong', {}, v.head ? `#${v.head.chain_seq}` : '—'),
        el('span', { class: 'hash-cell' }, v.head?.hash ? `head ${String(v.head.hash).slice(0, 20)}…` : 'no head')),
      el('div', { class: 'audit-summary-card' }, el('strong', {}, String(v.legacy_unchained ?? 0)), el('span', {}, 'legacy rows before chaining')),
      brk ? el('div', { class: 'audit-summary-card is-invalid' }, el('strong', {}, fmtStatus(brk.reason)),
        el('span', {}, `first break at seq ${brk.chain_seq ?? '—'}${brk.history_id ? `, row ${brk.history_id}` : ''}`)) : null);
  } catch (err) {
    if (epoch !== S.epoch) return;
    mount(container, errorMsg(err, verifyAuditChain));
  } finally {
    btn.disabled = false; // the button itself carries no session data
  }
}

function exportAuditCsv() {
  const rows = auditRows();
  if (!rows.length) return notify('There are no audit records to export.', 'urgent');
  downloadCsv([
    ['history_id', 'chain_seq', 'event_time', 'event_type', 'request_id', 'hospital_id', 'previous_state', 'new_state', 'actor_role', 'actor_id', 'prev_hash', 'row_hash'],
    ...rows.map(e => [e.history_id, e.chain_seq, e.event_time, e.event_type, e.request_id, e.hospital_id, e.previous_state, e.new_state, e.actor_role, e.actor_id, e.prev_hash, e.row_hash])
  ], `eris-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
}

// ──────────────────────────────────────────────────────────────────────────────
// My registered patients (ADMIN): GET /analytics/my-registrations — the caller's own registered cases
// ──────────────────────────────────────────────────────────────────────────────
const TERMINAL_CASE = ['COMPLETED', 'CANCELLED'];
const fmtMinutes = v => `${fmtNumber(v, Number(v) < 10 ? 1 : 0)} min`;
/** A milestone duration: minutes, "Not yet" while the case can still reach it, "—" when it never will. Never 0 for null. */
const milestoneCell = (minutes, status) => (minutes === null || minutes === undefined
  ? el('span', { class: 'cell-muted' }, TERMINAL_CASE.includes(status) ? '—' : 'Not yet')
  : fmtMinutes(minutes));

function openCaseInTracker(requestId) {
  if (!requestId) return;
  switchTab('tab-ingestion');
  selectCase(requestId);
  byId('caseTrackerPanel')?.scrollIntoView({ block: 'start' });
}

function renderRegistrations() {
  const box = byId('registrationsContent');
  if (!box || !can('ADMIN')) return;
  const r = S.res.registrations;
  const exportBtn = byId('btnExportRegistrationsCsv');
  if (exportBtn) exportBtn.disabled = !r.data?.cases?.length;
  const gate = resourceGate(r, { retry: () => load('registrations'), isEmpty: d => !d.cases?.length,
    empty: stateMsg('No registered patients', 'You have not registered any patients in this period.') });
  if (gate) return mount(box, gate);
  const { summary: sm, cases, window: w } = r.data;
  const avg = (value, n) => (value === null || value === undefined
    ? el('span', { class: 'insufficient' }, `Insufficient data (${n} of ${sm.minimum_sample})`)
    : fmtMinutes(value));
  mount(box,
    el('p', { class: 'field-caption' }, `${fmtDateTime(w.from)} – ${fmtDateTime(w.to)}. Dispatch times are to the first unit dispatched (a later re-dispatch does not change them). Select a row to open the case in the tracker.${
      cases.length < sm.count ? ` Showing the ${cases.length} most recent of ${sm.count}; the summary covers all of them.` : ''}`),
    el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table', id: 'registrationsTable' },
      el('thead', {}, el('tr', {}, ['Patient', 'Age / sex', 'Emergency', 'Priority', 'Status', 'Registered', 'Accepted hospital', 'To acceptance', 'To first dispatch', 'To completion'].map(h => el('th', {}, h)))),
      el('tbody', {}, cases.map(c => {
        const open = () => openCaseInTracker(c.request_id);
        return el('tr', { tabindex: '0', class: 'is-clickable', dataset: { requestId: c.request_id }, 'aria-label': `Open ${c.request_id} in the case tracker`,
          on: { click: open, keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } } },
        el('td', {}, el('span', { class: 'patient-name' }, c.patient_name || '—'), el('span', { class: 'cell-muted' }, ` ${c.request_id}`),
          c.incident_id ? ' ' : null, incidentBadge(c.incident_id)),
        el('td', {}, `${c.age ?? '—'} / ${c.gender ? fmtStatus(c.gender).toLowerCase() : '—'}`),
        el('td', {}, fmtStatus(c.emergency_type)),
        el('td', {}, priorityBadge(c.triage_priority)),
        el('td', {}, badge(c.status)),
        el('td', { class: 'cell-time' }, fmtDateTime(c.registered_at)),
        el('td', {}, c.accepted_hospital_name || c.accepted_hospital_id || el('span', { class: 'cell-muted' }, TERMINAL_CASE.includes(c.status) ? '—' : 'Not yet')),
        el('td', { class: 'cell-minutes', dataset: { field: 'acceptance' } }, milestoneCell(c.minutes_to_acceptance, c.status)),
        el('td', { class: 'cell-minutes', dataset: { field: 'dispatch' } }, milestoneCell(c.minutes_to_dispatch, c.status)),
        el('td', { class: 'cell-minutes', dataset: { field: 'completion' } }, milestoneCell(c.minutes_to_completion, c.status)));
      })),
      el('tfoot', {}, el('tr', { id: 'registrationsSummary' },
        el('td', { colspan: '7' }, el('strong', {}, `${sm.count} case${sm.count === 1 ? '' : 's'}`),
          ` · ${sm.accepted_count} accepted · ${sm.completed_count} completed · ${sm.open_count} open · averages:`),
        el('td', {}, avg(sm.avg_minutes_to_acceptance, sm.sample_size.acceptance)),
        el('td', {}, avg(sm.avg_minutes_to_dispatch, sm.sample_size.dispatch)),
        el('td', {}, avg(sm.avg_minutes_to_completion, sm.sample_size.completion)))))));
}

function exportRegistrationsCsv() {
  const data = S.res.registrations.data;
  if (!data?.cases?.length) return notify('There are no registered patients to export for this period.', 'urgent');
  const sm = data.summary;
  const avg = (v, n) => (v === null || v === undefined ? `insufficient_data (${n} of ${sm.minimum_sample})` : v);
  downloadCsv([
    ['request_id', 'patient_name', 'age', 'gender', 'emergency_type', 'triage_priority', 'status', 'registered_at', 'first_referral_at',
      'accepted_at', 'accepted_hospital', 'first_dispatched_at', 'first_unit', 'completed_at', 'minutes_to_acceptance', 'minutes_to_first_dispatch', 'minutes_to_completion'],
    ...data.cases.map(c => [c.request_id, c.patient_name, c.age, c.gender, c.emergency_type, c.triage_priority, c.status, c.registered_at, c.first_referral_at,
      c.accepted_at, c.accepted_hospital_name || c.accepted_hospital_id, c.dispatched_at, c.ambulance_id, c.completed_at, c.minutes_to_acceptance, c.minutes_to_dispatch, c.minutes_to_completion]),
    ['summary', `${sm.count} cases`, '', '', '', '', `${sm.open_count} open`, '', '', `${sm.accepted_count} accepted`, '', '', '', `${sm.completed_count} completed`,
      avg(sm.avg_minutes_to_acceptance, sm.sample_size.acceptance), avg(sm.avg_minutes_to_dispatch, sm.sample_size.dispatch), avg(sm.avg_minutes_to_completion, sm.sample_size.completion)]
  ], `eris-my-registrations-${new Date().toISOString().slice(0, 10)}.csv`);
}

function initOpenCase() {
  byId('openCaseForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const id = byId('openCaseId').value.trim();
    const error = byId('openCaseError');
    if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(id)) { error.textContent = 'Enter a case ID such as REQ-1234.'; error.hidden = false; return; }
    error.hidden = true;
    openCaseInTracker(id);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Roadside assist (ADMIN, PARAMEDIC): location, injuries, triage aid, nearest suitable hospitals,
// pre-alert (POST /emergencies, Idempotency-Key, lost-answer handling as intake) and an optional referral.
// ──────────────────────────────────────────────────────────────────────────────
const SPECIALIST_FROM_TRIAGE = { traumaSurgeon: 'TRAUMA_SURGEON', neurologist: 'NEUROLOGIST', cardiologist: 'CARDIOLOGIST', pediatrician: 'PEDIATRICIAN' };
let speech = null; // the running SpeechRecognition, if any

function resetRoadsideForm() {
  byId('roadsideForm')?.reset();
  setText('rsGpsStatus', ''); show('rsFormError', false);
  document.querySelectorAll('#rsTags .rs-tag').forEach(t => { t.classList.remove('selected'); t.setAttribute('aria-pressed', 'false'); });
  try { speech?.abort(); } catch { /* not running */ }
  speech = null;
}

function readRoadsideLocation() {
  const latText = byId('rsLat').value.trim(); const lngText = byId('rsLng').value.trim();
  const place = byId('rsPlace').value.trim();
  if (latText === '' || lngText === '') return { error: 'Give the latitude and longitude (use GPS, or type them from a map app or a road sign).' };
  const lat = Number(latText); const lng = Number(lngText);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'Latitude must be a number between -90 and 90.' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'Longitude must be a number between -180 and 180.' };
  const area = operatingAreaProblem(lat, lng, 'This location');
  if (area) return { error: area };
  return { lat, lng, place };
}

/** The triage aid's result, expressed as what the server will require (server/services/emergencyRequirements.js). */
function roadsideRequirements(analysis) {
  const type = TYPE_REQUIREMENTS[analysis.emergencyType] ? analysis.emergencyType : 'GENERAL';
  const preset = TYPE_REQUIREMENTS[type];
  const rr = analysis.requiredResources || {};
  const fromTriage = [rr.requiredBeds && 'ICU_BED', rr.requiredVents && 'VENTILATOR', rr.requiredOT && 'OT'].filter(Boolean);
  const triageSpecialist = SPECIALIST_FROM_TRIAGE[rr.specialist] || null;
  return {
    type,
    resources: [...new Set([...preset.resources, ...fromTriage])],
    extras: fromTriage.filter(t => !preset.resources.includes(t)).sort(),
    specialist: preset.specialist || triageSpecialist,
    specialistSent: preset.specialist ? null : triageSpecialist, // the server refuses a different specialist for a preset type
    specialistNote: preset.specialist && triageSpecialist && triageSpecialist !== preset.specialist
      ? `The aid also suggests a ${SPECIALIST_LABELS[triageSpecialist]}; a ${fmtStatus(type).toLowerCase()} case always requires a ${SPECIALIST_LABELS[preset.specialist]}, which is what the server checks.`
      : null
  };
}

function assessRoadside() {
  const R = S.roadside;
  const errorEl = byId('rsFormError');
  errorEl.hidden = true;
  const loc = readRoadsideLocation();
  const injuries = byId('rsInjuries').value.trim();
  const problem = loc.error || (!injuries && !R.tags.size ? 'Describe the injuries or tap at least one sign you can see.' : null);
  if (problem) { errorEl.textContent = problem; errorEl.hidden = false; return; }
  const analysis = analyzeRoadsideSymptoms(injuries, [...R.tags]);
  R.assessment = { ...loc, injuries, tags: [...R.tags], analysis, req: roadsideRequirements(analysis), at: Date.now() };
  renderRoadside();
  byId('rsResult')?.scrollIntoView({ block: 'start' });
}

function roadsidePayload() {
  const A = S.roadside.assessment;
  const ageText = byId('rsAge').value.trim();
  const age = Number(ageText);
  if (!ageText || !Number.isInteger(age) || age < 0 || age > 130) return { error: 'Give an estimated age in whole years (0–130): the server requires one.' };
  const labels = A.analysis.matchedSymptoms.map(m => m.label.replace(/^[^A-Za-z]+/, '')).join('; ');
  const notes = [`Roadside pre-alert at ${A.place || 'coordinates'} (${fmtNumber(A.lat, 5)}, ${fmtNumber(A.lng, 5)}).`,
    A.injuries ? `Reported: ${A.injuries}` : null, labels ? `Signs: ${labels}.` : null,
    `Triage aid: level ${A.analysis.triageLevel} (decision aid, not a diagnosis).`].filter(Boolean).join(' ');
  return { payload: {
    patient_name: byId('rsName').value.trim() || 'Unknown',
    age,
    gender: byId('rsGender').value,
    emergency_type: A.req.type,
    triage_priority: A.analysis.triageLevel,
    clinical_notes: notes,
    required_resources: A.req.extras,
    required_specialist: A.req.specialistSent,
    pickup_lat: A.lat,
    pickup_lng: A.lng
  } };
}

async function sendRoadsidePreAlert() {
  const R = S.roadside;
  if (R.submitting || R.caseId || !R.assessment) return;
  const { payload, error } = roadsidePayload();
  if (error) { R.message = { tone: 'error', text: error }; return renderRoadside(); }
  if (!R.pendingKey) R.pendingKey = newIdempotencyKey(); // kept until the server settles this submission
  const earlierUnknown = R.outcomeUnknown;
  R.outcomeUnknown = true;
  R.submitting = true; R.message = null;
  renderRoadside();
  const epoch = S.epoch;
  try {
    const created = await EmergenciesAPI.create(payload, R.pendingKey);
    if (epoch !== S.epoch) return;
    R.pendingKey = null; R.outcomeUnknown = false; R.caseId = created.request_id;
    R.message = { tone: 'success', text: created.replayed
      ? `${created.request_id} was already registered by your earlier attempt; no duplicate was created.`
      : `Pre-alert registered as ${created.request_id}. Send a referral to the hospital you choose below.` };
    notify(R.message.text, 'success');
    S.selectedRequestId = created.request_id;
    load('emergencies'); load('dashboard');
    loadCase(created.request_id);
  } catch (err) {
    if (epoch !== S.epoch) return;
    const outcome = createOutcome(err);
    if (outcome === 'reused') {
      R.pendingKey = null; R.outcomeUnknown = false;
      R.message = { tone: 'error', text: 'Not sent again: an earlier attempt may already have registered this case. Check the cases before sending again; your changes were not saved.' };
      load('emergencies');
    } else if (outcome === 'refused') {
      R.outcomeUnknown = earlierUnknown;
      R.message = { tone: 'error', text: earlierUnknown
        ? `This attempt was refused: ${errorText(err)} An earlier attempt may already have registered this case: check the cases.`
        : `Not sent: ${errorText(err)}` };
    } else {
      R.message = { tone: 'error', text: `Outcome unknown: the server could not confirm whether the pre-alert was registered (${errorText(err)}). Press Send pre-alert again; the retry reuses the same submission, so the server will not register it twice.` };
    }
    notify(R.message.text, 'urgent');
  } finally {
    if (epoch === S.epoch) { R.submitting = false; renderRoadside(); }
  }
}

function roadsideCaseStatus() {
  const R = S.roadside;
  const view = S.caseView;
  if (!R.caseId) return null;
  const detail = view.requestId === R.caseId ? view.detail : null;
  const head = el('strong', {}, `Case ${R.caseId}`);
  if (!detail) return el('div', { class: 'status-line', id: 'rsCaseStatus' }, head, el('span', {}, 'Loading the case…'));
  const acceptances = detail.acceptances || [];
  const pending = acceptances.filter(a => a.status === 'PENDING').at(-1);
  const accepted = acceptances.filter(a => a.status === 'ACCEPTED').at(-1);
  if (pending) return el('div', { class: 'status-line is-warning', id: 'rsCaseStatus', dataset: { state: 'pending' } }, head,
    el('span', {}, 'Referral waiting for ', el('strong', {}, hospitalName(pending.hospital_id)), ' · ', countdownNode(pending.acceptance_id, pending.lock_expires_at)));
  if (accepted) return el('div', { class: 'status-line is-success', id: 'rsCaseStatus', dataset: { state: 'accepted' } }, head,
    el('span', {}, 'Accepted by ', el('strong', {}, hospitalName(accepted.hospital_id)), '.'),
    el('span', {}, detail.request.assigned_ambulance_id ? `Ambulance ${detail.request.assigned_ambulance_id} assigned.` : 'No ambulance assigned yet.'));
  const ended = acceptances.at(-1);
  return el('div', { class: 'status-line', id: 'rsCaseStatus', dataset: { state: 'open' } }, head,
    el('span', {}, ended ? `${hospitalName(ended.hospital_id)}: ${fmtStatus(ended.status).toLowerCase()}. Choose another hospital below.` : 'Choose a hospital below to send the referral.'));
}

function renderRoadside() {
  const box = byId('rsResult');
  if (!box || !S.user || !can(...CREATES_CASES)) return;
  const R = S.roadside;
  const A = R.assessment;
  if (!A) { renderSigs.delete('roadside'); return mount(box, stateMsg('No assessment yet', 'Set the location and describe the injuries, then press Assess.')); }
  const hr = S.res.hospitals;
  const view = S.caseView;
  const detail = R.caseId && view.requestId === R.caseId ? view.detail : null;
  const busy = R.caseId ? S.inFlight.has(`referral:${R.caseId}`) : false;
  const sig = JSON.stringify([A.at, R.caseId, R.submitting, R.message, busy, detail?.request?.status, (detail?.acceptances || []).map(a => [a.acceptance_id, a.status]),
    hr.status, (hr.data || []).map(h => [h.id, h.status, h.resources, [...h.onDuty]])]);
  if (unchanged('roadside', sig)) return;
  const an = A.analysis;
  const caseLike = { required_resource_types: A.req.resources, required_specialist: A.req.specialist, pickup_lat: A.lat, pickup_lng: A.lng };
  const pending = (detail?.acceptances || []).some(a => a.status === 'PENDING');
  const referrable = Boolean(R.caseId) && (!detail || REFERRABLE.includes(detail.request.status)) && !pending;
  const gate = resourceGate(hr, { retry: () => load('hospitals'), empty: stateMsg('No hospitals', 'No hospitals are registered.') });
  const ranked = gate ? [] : rankForCase(caseLike, hr.data);
  mount(box,
    el('section', { class: 'rs-triage', id: 'rsTriage', dataset: { level: an.triageLevel, type: A.req.type } },
      el('div', { class: 'rs-triage-head' }, priorityBadge(an.triageLevel), el('strong', {}, an.triageName.replace(/^Level \d+: /, `Level ${an.triageLevel}: `))),
      el('p', { class: 'field-caption' }, 'Decision aid, not a diagnosis: a clinician confirms the priority.'),
      el('p', {}, `${an.emergencyTitle} → registered as ${fmtStatus(A.req.type).toLowerCase()}.`),
      an.matchedSymptoms.length
        ? el('ul', { class: 'rs-reasons', id: 'rsReasons' }, an.matchedSymptoms.map(m => el('li', {}, el('strong', {}, m.label.replace(/^[^A-Za-z]+/, '')), ` — ${m.clinicalAlert}`)))
        : el('p', { class: 'cell-muted', id: 'rsReasons' }, 'No critical sign recognised in the description or the tags.'),
      kv('Hospital must have', resourceTags(A.req.resources)),
      kv('Specialist', A.req.specialist ? SPECIALIST_LABELS[A.req.specialist] : 'None'),
      A.req.specialistNote ? el('p', { class: 'field-caption' }, A.req.specialistNote) : null,
      roadsideGuideLink()),
    el('section', { class: 'rs-prealert' },
      roadsideCaseStatus(),
      R.message ? el('p', { class: ['form-error', R.message.tone === 'success' && 'is-success'], id: 'rsPreAlertMessage', role: 'alert' }, R.message.text) : null,
      R.caseId
        ? el('button', { type: 'button', class: 'btn btn-secondary btn-sm', id: 'rsNewCaseBtn', on: { click: () => { S.roadside = freshRoadsideState(); resetRoadsideForm(); renderRoadside(); } } }, 'Start a new roadside case')
        : el('button', { type: 'button', class: 'btn btn-emergency btn-block', id: 'rsPreAlertBtn', disabled: R.submitting, on: { click: sendRoadsidePreAlert } },
          R.submitting ? 'Sending pre-alert…' : 'Send pre-alert (registers the case)')),
    el('h3', { class: 'section-subtitle' }, 'Nearest suitable hospitals'),
    gate || el('div', { class: 'rs-hospitals', id: 'rsHospitals' }, ranked.map((row, i) => {
      const h = row.hospital;
      return el('div', { class: ['hospital-card', i === 0 && row.eligible && 'top-match'], dataset: { hospitalId: h.id, eligible: String(row.eligible) } },
        el('div', { class: 'hospital-header' },
          el('div', {}, el('div', { class: 'hospital-name' }, el('span', { class: 'rank-badge' }, `#${i + 1}`), ' ', h.name, ' ', badge(h.status)),
            el('div', { class: 'hospital-meta rs-distance' }, row.distanceKm !== null ? `${row.distanceKm.toFixed(1)} km away` : 'Distance unknown')),
          el('div', { class: 'score-badge' }, row.eligible ? [el('span', {}, String(row.score)), el('span', { class: 'score-label' }, 'Score')] : el('span', { class: 'text-danger' }, 'Not suitable'))),
        el('div', { class: 'resource-capsule-grid' },
          A.req.resources.map(t => {
            const res = h.resources[t];
            return el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, `${RESOURCE_LABELS[t]} free`),
              el('span', { class: ['capsule-val', !res || res.free < 1 ? 'empty' : 'good'] }, res ? `${res.free} / ${res.total}` : 'unknown'));
          }),
          A.req.specialist ? el('div', { class: 'resource-capsule' }, el('span', { class: 'capsule-label' }, SPECIALIST_LABELS[A.req.specialist]),
            el('span', { class: ['capsule-val', h.onDuty.has(A.req.specialist) ? 'good' : 'empty'] }, h.onDuty.has(A.req.specialist) ? 'On duty' : 'Not available')) : null),
        row.eligible ? null : el('ul', { class: 'exclusion-list' }, row.reasons.map(reason => el('li', {}, reason))),
        R.caseId ? el('div', { class: 'hospital-card-actions' }, el('button', {
          type: 'button', class: 'btn btn-primary btn-sm btn-rs-referral', dataset: { hospitalId: h.id },
          disabled: !row.eligible || !referrable || busy,
          on: { click: () => initiateReferral(R.caseId, h.id) }
        }, 'Send referral (90 s hold)')) : null);
    })));
  tickCountdowns();
}

// The roadside screen never shows the triage module's own first-aid text: it links to the single First Aid Guide.
function roadsideGuideLink() {
  return el('section', { class: 'rs-guide', id: 'rsGuide', 'aria-label': 'First aid' },
    el('p', { class: 'rs-guide-call' }, 'Emergency? ', el('a', { href: 'tel:112' }, 'Call 112'), '. While you wait: ',
      el('button', { type: 'button', class: 'link-button rs-guide-link', id: 'rsFirstAidLink', 'aria-haspopup': 'dialog',
        on: { click: e => openFirstAid(e.currentTarget) } }, 'First aid steps')));
}

function initRoadside() {
  const tags = byId('rsTags');
  if (tags) {
    mount(tags, SYMPTOM_DATABASE.map(sym => el('button', {
      type: 'button', class: 'rs-tag', 'aria-pressed': 'false', dataset: { symptom: sym.id },
      on: { click: e => {
        const on = !S.roadside.tags.has(sym.id);
        if (on) S.roadside.tags.add(sym.id); else S.roadside.tags.delete(sym.id);
        e.currentTarget.classList.toggle('selected', on);
        e.currentTarget.setAttribute('aria-pressed', String(on));
      } }
    }, sym.label.replace(/^[^A-Za-z]+/, ''))));
  }
  byId('roadsideForm')?.addEventListener('submit', e => { e.preventDefault(); assessRoadside(); });

  byId('rsGpsBtn')?.addEventListener('click', () => {
    if (!navigator.geolocation) return setText('rsGpsStatus', 'This browser cannot report a location. Type the place and its coordinates.');
    const seq = ++S.roadside.gpsSeq;
    const epoch = S.epoch;
    setText('rsGpsStatus', 'Locating… (allow location access if the browser asks)');
    navigator.geolocation.getCurrentPosition(pos => {
      if (epoch !== S.epoch || seq !== S.roadside.gpsSeq) return;
      if (operatingAreaProblem(pos.coords.latitude, pos.coords.longitude)) return setText('rsGpsStatus', OUTSIDE_AREA);
      byId('rsLat').value = pos.coords.latitude.toFixed(6);
      byId('rsLng').value = pos.coords.longitude.toFixed(6);
      if (!byId('rsPlace').value.trim()) byId('rsPlace').value = 'GPS position';
      setText('rsGpsStatus', `Location found (accuracy about ${Math.round(pos.coords.accuracy)} m).`);
    }, err => {
      if (epoch !== S.epoch || seq !== S.roadside.gpsSeq) return;
      const why = err.code === 1 ? 'Location permission was denied.'
        : err.code === 3 ? 'Finding the location took too long.' : 'The location is not available right now.';
      setText('rsGpsStatus', `${why} Type the place and its latitude and longitude instead.`);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = byId('rsMicBtn');
  if (!SR || !mic) {
    setText('rsMicStatus', 'Voice input is not available in this browser: type the description.');
  } else {
    mic.hidden = false;
    mic.addEventListener('click', () => {
      if (speech) { try { speech.stop(); } catch { /* already stopped */ } return; }
      const rec = new SR();
      rec.lang = document.documentElement.lang || navigator.language || 'en';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = e => {
        const said = [...e.results].map(r => r[0]?.transcript || '').join(' ').trim();
        if (said) { const box = byId('rsInjuries'); box.value = `${box.value.trim()} ${said}`.trim().slice(0, 2000); }
      };
      rec.onerror = e => setText('rsMicStatus', e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access was denied: type the description.' : e.error === 'no-speech' ? 'Nothing was heard. Try again or type.' : `Voice input stopped (${e.error}). Type the description.`);
      rec.onend = () => { speech = null; mic.textContent = 'Dictate'; if (/Listening/.test(byId('rsMicStatus').textContent)) setText('rsMicStatus', ''); };
      speech = rec;
      mic.textContent = 'Stop';
      setText('rsMicStatus', 'Listening… describe what you see.');
      try { rec.start(); } catch (err) { speech = null; mic.textContent = 'Dictate'; setText('rsMicStatus', `Voice input could not start (${err.message}). Type the description.`); }
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mass casualty (ADMIN): incidents, victims (bulk rows, CSV import), triage with a reason, ambulance seats,
// a suggested hospital per victim (greedy on live capacity) and one referral per victim.
// Triage categories are decision support for the responders; a clinician confirms them.
// ──────────────────────────────────────────────────────────────────────────────
const MC_INJURIES = [
  { id: 'MINOR', label: 'Minor injuries', type: 'GENERAL' },
  { id: 'FRACTURE', label: 'Fracture or bleeding', type: 'TRAUMA' },
  { id: 'HEAD', label: 'Head injury', type: 'TRAUMA' },
  { id: 'MULTIPLE', label: 'Multiple serious injuries', type: 'POLYTRAUMA' },
  { id: 'BREATHING', label: 'Breathing difficulty', type: 'RESPIRATORY' },
  { id: 'CHEST', label: 'Chest pain', type: 'CARDIAC' },
  { id: 'CHILD', label: 'Injured child', type: 'PEDIATRIC' }
];
const TRIAGE_CATEGORIES = ['RED', 'YELLOW', 'GREEN'];
const MC_MAX_ROWS = 100;
const injuryOptions = selected => MC_INJURIES.map(i => el('option', { value: i.id, selected: i.id === selected }, i.label));
const triageOptions = selected => TRIAGE_CATEGORIES.map(c => el('option', { value: c, selected: c === selected }, TRIAGE_CATEGORY[c]));

function freshMciState() {
  return {
    openId: null, triageEdit: null, triageDraft: { category: '', reason: '' }, rowNotes: new Map(), assignDraft: new Map(),
    referrals: new Map(), sending: false, creating: false, demoBusy: false,
    bulk: { pendingKey: null, outcomeUnknown: false, submitting: false },
    csv: null // { fileName, victims, errors, checking, checked, pendingKey, outcomeUnknown, submitting, message }
  };
}
const mciNote = (id, tone, text) => { S.mci.rowNotes.set(id, { tone, text }); };
const mciReload = () => { if (can('ADMIN') && S.mci.openId) scheduleReload(['incident', 'incidents'], 200); };

/** One victim from GET /incidents/:id in the form the screen and the ranking need. */
function victimOf(v, incident) {
  const type = v.emergency_type || 'GENERAL';
  return {
    id: v.request_id,
    label: v.label || v.victim_label || v.full_name || v.patient_name || v.request_id,
    age: v.age ?? null,
    gender: v.gender || null,
    triage: v.triage_category || null,
    priority: Number(v.triage_priority ?? v.priority) || 5,
    type,
    injury: v.injury_description || '',
    status: v.status,
    transport: !(v.transport_required === false || v.transport_required === 0),
    ambulanceId: v.ambulance_id || v.assignment?.ambulance_id || null,
    pickedUp: Boolean(v.picked_up_at || v.assignment?.picked_up_at),
    arrived_at: v.arrived_at || null,
    accepted: v.accepted_hospital_id || null,
    pending: v.pending_hospital_id || null,
    pendingAcceptanceId: v.pending_acceptance_id || null,
    escalated: Boolean(v.escalated || v.unallocated || v.needs_escalation),
    required_resource_types: v.required_resource_types || TYPE_REQUIREMENTS[type]?.resources || [],
    required_specialist: v.required_specialist !== undefined ? v.required_specialist : (TYPE_REQUIREMENTS[type]?.specialist ?? null),
    pickup_lat: v.pickup_lat ?? incident?.location_lat ?? null,
    pickup_lng: v.pickup_lng ?? incident?.location_lng ?? null
  };
}
const victimsOf = data => (data?.victims || data?.cases || []).map(v => victimOf(v, data?.incident));

/** Where one victim's referral stands: the server's view first, then this session's sends. */
function victimReferral(v) {
  const local = S.mci.referrals.get(v.id);
  if (local?.phase === 'sending') return { state: 'sending', sendable: false };
  if (v.accepted || ['ALLOCATED', 'IN_TREATMENT', 'COMPLETED'].includes(v.status)) return { state: 'accepted', hospitalId: v.accepted, sendable: false };
  const tracked = [...S.tracked.entries()].filter(([, t]) => t.requestId === v.id);
  const [acceptanceId, last] = tracked.at(-1) || [];
  if (v.pending || last?.status === 'PENDING') {
    return { state: 'sent', hospitalId: v.pending || last?.hospitalId, acceptanceId: last?.status === 'PENDING' ? acceptanceId : v.pendingAcceptanceId, sendable: false };
  }
  if (!REFERRABLE.includes(v.status)) return { state: 'closed', sendable: false };
  if (local?.phase === 'failed' || local?.phase === 'unknown') return { state: local.phase, message: local.message, sendable: true };
  if (last && ['REJECTED', 'EXPIRED'].includes(last.status)) return { state: last.status === 'REJECTED' ? 'rejected' : 'expired', hospitalId: last.hospitalId, sendable: true };
  return { state: 'none', sendable: true };
}

/** Victims in triage order with their referral state and, for those still to refer, the greedy suggestion. */
function mciPlan() {
  const data = S.res.incident.data;
  const victims = victimsOf(data);
  const states = new Map(victims.map(v => [v.id, victimReferral(v)]));
  const open = victims.filter(v => states.get(v.id).sendable).map(v => ({
    ...v, request_id: v.id,
    exclude: new Set([...S.tracked.values()].filter(t => t.requestId === v.id && ['REJECTED', 'EXPIRED'].includes(t.status)).map(t => t.hospitalId))
  }));
  const plan = S.res.hospitals.data ? suggestForIncident(open, S.res.hospitals.data) : [];
  const byVictim = new Map(plan.map(p => [p.case.request_id, p]));
  const order = victims.map((v, i) => [v, i]).sort((a, b) => a[0].priority - b[0].priority || a[1] - b[1]).map(([v]) => v);
  return order.map(v => ({ v, ref: states.get(v.id), suggestion: byVictim.get(v.id) || null }));
}

function suggestionReason(sg) {
  const row = sg?.row;
  if (!row) return (sg?.reasons || []).join(' '); // no eligible hospital: the victim needs escalation
  const parts = [`score ${row.score}`, row.distanceKm !== null ? `${row.distanceKm.toFixed(1)} km` : 'distance unknown'];
  const free = Object.entries(sg.freeBefore || {}).map(([t, n]) => `${RESOURCE_LABELS[t] || t} ${n} free`);
  parts.push(free.length ? free.join(', ') : 'no special equipment needed');
  if (sg.earlierHere) parts.push(`after ${sg.earlierHere} earlier victim${sg.earlierHere > 1 ? 's' : ''} suggested here`);
  if (sg.case.required_specialist) parts.push(`${SPECIALIST_LABELS[sg.case.required_specialist] || sg.case.required_specialist} on duty`);
  return parts.join(' · ');
}

const REF_TEXT = { sending: 'Sending…', sent: 'Referral sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'No answer (expired)', failed: 'Not sent', unknown: 'Outcome unknown', none: 'Not referred', closed: '—' };

// ── List and incident page ──
function renderIncidents() {
  if (!can('ADMIN')) return;
  renderIncidentList();
  renderIncidentPage();
}

function renderIncidentList() {
  const box = byId('mciList');
  if (!box) return;
  const r = S.res.incidents;
  const gate = resourceGate(r, { retry: () => load('incidents'), empty: stateMsg('No incidents', 'Create one, or load the bus crash demo.') });
  if (gate) return mount(box, gate);
  mount(box, el('ul', { class: 'mci-list', id: 'mciIncidentList' }, r.data.map(i => {
    const open = () => openIncident(i.incident_id);
    return el('li', {}, el('button', { type: 'button', class: ['mci-list-item', i.incident_id === S.mci.openId && 'is-open'], dataset: { incidentId: i.incident_id }, on: { click: open } },
      el('strong', {}, i.title || i.incident_id),
      el('span', { class: 'cell-muted' }, [i.incident_id, fmtStatus(i.incident_type || ''), i.severity ? `${fmtStatus(i.severity).toLowerCase()} severity` : null,
        `${i.victim_count ?? i.total_victims ?? 0} victim${(i.victim_count ?? i.total_victims) === 1 ? '' : 's'}`, i.occurred_at ? fmtDateTime(i.occurred_at) : null, i.is_demo ? 'demo' : null].filter(Boolean).join(' · '))));
  })));
}

function openIncident(id) {
  S.mci = { ...freshMciState(), openId: id, referrals: S.mci.referrals };
  renderSigs.delete('mciVictims');
  resetVictimForm();
  renderIncidentList();
  load('incident');
  load('ambulances');
  if (S.res.hospitals.status === 'idle') load('hospitals');
  byId('mciIncidentPanel')?.scrollIntoView({ block: 'start' });
}

const COUNTERS = [
  ['Victims', s => `${s.total_victims ?? 0}${s.estimated_victims ? ` of ~${s.estimated_victims}` : ''}`, 'total'],
  ['Red', s => s.by_triage?.RED ?? 0, 'red'], ['Yellow', s => s.by_triage?.YELLOW ?? 0, 'yellow'], ['Green', s => s.by_triage?.GREEN ?? 0, 'green'],
  ['Awaiting ambulance', s => s.awaiting_ambulance ?? 0, 'awaiting'], ['Assigned / in transit', s => s.assigned ?? s.in_transit ?? 0, 'assigned'],
  ['Arrived at hospital', s => s.arrived ?? 0, 'arrived'], ['In treatment', s => s.in_treatment ?? 0, 'treatment'], ['Completed', s => s.completed ?? 0, 'completed'],
  ['Needs escalation', s => s.unallocated ?? s.escalated ?? 0, 'escalation']
];

function renderIncidentPage() {
  const box = byId('mciIncident');
  if (!box || !can('ADMIN')) return;
  show('mciAdd', Boolean(S.mci.openId) && S.res.incident.data?.incident?.incident_id === S.mci.openId);
  if (!S.mci.openId) { setText('mciIncidentCaption', 'Open an incident from the list.'); renderSigs.delete('mciVictims'); return mount(box); }
  const r = S.res.incident;
  const data = r.data?.incident?.incident_id === S.mci.openId ? r.data : null;
  if (!data) { renderSigs.delete('mciVictims'); return mount(box, r.status === 'error' ? errorMsg(r.error, () => load('incident')) : loadingMsg('Loading the incident…')); }
  const plan = mciPlan();
  const sig = JSON.stringify([data, plan.map(p => [p.v.id, p.ref, p.suggestion?.hospital?.id, p.suggestion && suggestionReason(p.suggestion)]),
    (S.res.ambulances.data || []).map(a => [a.ambulance_id, a.status, a.capacity, a.occupied]), S.mci.triageEdit, [...S.mci.rowNotes], S.mci.sending,
    [...S.inFlight].filter(k => k.startsWith('mci')), r.status === 'error']);
  if (unchanged('mciVictims', sig)) return tickCountdowns();
  const inc = data.incident;
  const sm = data.summary || {};
  setText('mciIncidentCaption', `${inc.incident_id} · ${inc.title || ''}`);
  const sendable = plan.filter(p => p.ref.sendable && p.suggestion?.hospital);
  const units = (S.res.ambulances.data || []).filter(a => a.status !== 'MAINTENANCE');
  mount(box,
    el('div', { class: 'mci-head', id: 'mciHead', dataset: { incidentId: inc.incident_id } },
      el('div', { class: 'hospital-name' }, inc.title || inc.incident_id, inc.is_demo ? el('span', { class: 'badge-status badge-new' }, 'Demo') : null),
      el('div', { class: 'hospital-meta' }, [inc.incident_id, fmtStatus(inc.incident_type || ''), inc.severity ? `${fmtStatus(inc.severity)} severity` : null,
        inc.location_text, inc.location_lat !== null && inc.location_lat !== undefined ? `${fmtNumber(inc.location_lat, 4)}, ${fmtNumber(inc.location_lng, 4)}` : null,
        inc.occurred_at ? fmtDateTime(inc.occurred_at) : null, inc.vehicles_involved ? `${inc.vehicles_involved} vehicles` : null].filter(Boolean).join(' · ')),
      inc.description ? el('p', { class: 'field-caption' }, inc.description) : null),
    el('div', { class: 'mci-counters', id: 'mciCounters' }, COUNTERS.map(([label, fn, key]) => el('div', { class: ['mci-counter', `is-${key}`], dataset: { counter: key } },
      el('span', { class: 'mci-counter-value' }, String(fn(sm))), el('span', { class: 'mci-counter-label' }, label)))),
    el('p', { class: 'field-caption' }, 'Triage colours are decision support for the responders, not a diagnosis: a clinician confirms them. Suggestions count the beds and equipment already suggested for victims above them; the server re-checks every referral.'),
    r.status === 'error' ? errorMsg(r.error, () => load('incident')) : null,
    el('div', { class: 'mci-actions' },
      el('button', { type: 'button', class: 'btn btn-emergency', id: 'mciSendAllBtn', disabled: S.mci.sending || !sendable.length, on: { click: sendAllReferrals } },
        S.mci.sending ? 'Sending referrals…' : `Send all referrals (${sendable.length})`)),
    plan.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table mci-table', id: 'mciVictims' },
      el('thead', {}, el('tr', {}, ['Victim', 'Triage', 'Injury', 'Status', 'Ambulance', 'Hospital'].map(t => el('th', {}, t)))),
      el('tbody', {}, plan.map(p => victimRow(p, units))))) : stateMsg('No victims yet', 'Add them below, one row each, or import a CSV file.'));
  tickCountdowns();
}

function victimRow({ v, ref, suggestion }, units) {
  const note = S.mci.rowNotes.get(v.id);
  const busyAmb = S.inFlight.has(`mciamb:${v.id}`);
  const busyTriage = S.inFlight.has(`mcitriage:${v.id}`);
  // Triage cell: the badge, or the change form (category + reason).
  let triageCell;
  if (S.mci.triageEdit === v.id) {
    const d = S.mci.triageDraft;
    const select = el('select', { class: 'form-select mci-triage-select', 'aria-label': `New triage for ${v.label}`, on: { change: e => { d.category = e.target.value; } } },
      triageOptions(d.category || v.triage));
    if (!d.category) d.category = v.triage || 'GREEN';
    const reason = el('input', { class: 'form-input mci-triage-reason', type: 'text', maxlength: '300', placeholder: 'Reason (required)', value: d.reason, 'aria-label': `Reason for the triage change of ${v.label}`,
      on: { input: e => { d.reason = e.target.value; } } });
    triageCell = el('div', { class: 'mci-triage-edit' }, select, reason,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-primary btn-sm mci-triage-save', disabled: busyTriage, on: { click: () => saveTriage(v) } }, 'Save'),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => { S.mci.triageEdit = null; renderIncidentPage(); } } }, 'Cancel')));
  } else {
    triageCell = el('div', { class: 'mci-triage' }, triageBadge(v.triage) || priorityBadge(v.priority),
      TERMINAL.includes(v.status) || !TRIAGE_UPDATE_API ? null : el('button', { type: 'button', class: 'link-button mci-triage-change', on: { click: () => { S.mci.triageEdit = v.id; S.mci.triageDraft = { category: v.triage || '', reason: '' }; renderIncidentPage(); } } }, 'Change'));
  }
  // Ambulance cell: the unit, or a choice of units with their free seats.
  let ambCell;
  if (v.ambulanceId) ambCell = el('span', {}, `${v.ambulanceId}${v.pickedUp ? ' · picked up' : ' · assigned'}`);
  else if (!v.transport) ambCell = el('span', { class: 'cell-muted' }, 'Not needed');
  else if (TERMINAL.includes(v.status)) ambCell = el('span', { class: 'cell-muted' }, '—');
  else if (!seatsApi()) ambCell = el('span', { class: 'cell-muted' }, 'Dispatched when a hospital accepts');
  else {
    const select = el('select', { class: 'form-select mci-amb-select', 'aria-label': `Ambulance for ${v.label}`, on: { change: e => S.mci.assignDraft.set(v.id, e.target.value) } },
      el('option', { value: '' }, 'Choose a unit'),
      units.map(a => {
        const cap = Number(a.capacity) || 1; const used = Number(a.occupied) || 0; const free = Math.max(0, cap - used);
        return el('option', { value: a.ambulance_id, selected: S.mci.assignDraft.get(v.id) === a.ambulance_id }, `${a.ambulance_id} · ${free} of ${cap} seat${cap > 1 ? 's' : ''} free`);
      }));
    ambCell = el('div', { class: 'mci-amb' }, select, el('button', { type: 'button', class: 'btn btn-secondary btn-sm mci-assign', disabled: busyAmb, on: { click: () => assignVictim(v, select.value) } }, 'Assign'),
      v.triage === 'RED' ? el('span', { class: 'field-caption' }, 'Red rides alone.') : null);
  }
  // Hospital cell: accepted / pending, or the suggestion with its reason and Send referral; no suggestion = escalation.
  const hosp = [];
  const st = ref.state;
  if (st === 'accepted') hosp.push(el('strong', {}, hospitalName(ref.hospitalId)), el('span', { class: 'cell-muted' }, ' · accepted'));
  else if (st === 'sent') hosp.push(el('span', {}, `${REF_TEXT.sent} to `), el('strong', {}, hospitalName(ref.hospitalId)), ref.acceptanceId ? [' · ', countdownNode(ref.acceptanceId, null)] : null);
  else if (st === 'sending') hosp.push(el('span', {}, REF_TEXT.sending));
  else if (ref.sendable) {
    if (['rejected', 'expired', 'failed', 'unknown'].includes(st)) hosp.push(el('div', { class: 'mci-ref-problem' }, `${REF_TEXT[st]}${ref.hospitalId ? ` (${hospitalName(ref.hospitalId)})` : ''}${ref.message ? `: ${ref.message}` : ''}`));
    if (suggestion?.hospital) {
      hosp.push(el('div', { class: 'mci-suggestion' }, 'Suggested: ', el('strong', {}, suggestion.hospital.name), el('span', { class: 'cell-muted mci-reason' }, ` — ${suggestionReason(suggestion)}`)),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm mci-send', disabled: S.mci.sending, on: { click: () => sendReferrals([{ v, suggestion }]) } }, 'Send referral'));
    } else {
      hosp.push(el('span', { class: 'badge-status badge-escalation' }, 'Needs escalation'),
        el('span', { class: 'cell-muted' }, ` ${suggestion?.reasons?.length ? suggestion.reasons.slice(0, 2).join(' ') : 'No suitable hospital has capacity left.'}`));
    }
  } else hosp.push(el('span', { class: 'cell-muted' }, '—'));
  if (v.escalated && st !== 'accepted' && !hosp.some(n => n.classList?.contains('badge-escalation'))) hosp.push(' ', el('span', { class: 'badge-status badge-escalation' }, 'Needs escalation'));
  return [
    el('tr', { dataset: { requestId: v.id, triage: v.triage || '', status: v.status, ref: st, hospitalId: ref.hospitalId || suggestion?.hospital?.id || '', ambulanceId: v.ambulanceId || '' } },
      el('td', {}, el('span', { class: 'patient-name' }, v.label), el('div', { class: 'cell-muted' }, `${v.id} · ${v.age ?? 'age unknown'}${v.age !== null ? 'y' : ''}${v.gender ? ` · ${fmtStatus(v.gender).toLowerCase()}` : ''}`)),
      el('td', {}, triageCell),
      el('td', {}, el('div', {}, v.injury || '—'), el('div', { class: 'cell-muted' }, fmtStatus(v.type))),
      el('td', {}, (() => {
        const stage = journeyStage({ status: v.status, arrived_at: v.arrived_at, picked_up: v.pickedUp });
        return stage ? el('span', { class: ['badge-status', STATUS_BADGE[stage === 'ACCEPTED' ? 'ALLOCATED' : stage === 'ARRIVED' || stage === 'IN_TRANSIT' ? 'IN_TRANSIT' : stage] || 'badge-new'], dataset: { stage } }, JOURNEY_TEXT[stage]) : badge(v.status);
      })()),
      el('td', {}, ambCell),
      el('td', { class: 'mci-hospital' }, hosp)),
    note ? el('tr', { class: 'mci-note-row', dataset: { noteFor: v.id } }, el('td', { colspan: '6' },
      el('p', { class: ['status-line', note.tone === 'success' ? 'is-success' : note.tone === 'warning' ? 'is-warning' : 'is-error'], role: 'status' }, note.text))) : null
  ];
}

async function saveTriage(v) {
  const key = `mcitriage:${v.id}`;
  if (S.inFlight.has(key)) return;
  const d = S.mci.triageDraft;
  const category = d.category || v.triage;
  const reason = d.reason.trim();
  if (!reason) { mciNote(v.id, 'error', 'Give the reason for the change: it is recorded with it.'); return renderIncidentPage(); }
  if (category === v.triage) { mciNote(v.id, 'error', 'Choose a different category.'); return renderIncidentPage(); }
  S.inFlight.add(key);
  renderIncidentPage();
  const epoch = S.epoch;
  try {
    await EmergenciesAPI.setTriage(v.id, category, reason);
    if (epoch !== S.epoch) return;
    S.mci.triageEdit = null;
    mciNote(v.id, 'success', `Triage changed to ${TRIAGE_CATEGORY[category]}.`);
  } catch (err) {
    if (epoch !== S.epoch) return;
    mciNote(v.id, isDefinite(err) ? 'error' : 'warning', isDefinite(err) ? `Triage not changed: ${errorText(err)}` : `Outcome unknown (${errorText(err)}): the list is re-read from the server.`);
  } finally {
    if (epoch === S.epoch) { S.inFlight.delete(key); renderIncidentPage(); load('incident'); }
  }
}

async function assignVictim(v, ambulanceId) {
  const key = `mciamb:${v.id}`;
  if (S.inFlight.has(key)) return;
  if (!ambulanceId) { mciNote(v.id, 'error', 'Choose an ambulance first.'); return renderIncidentPage(); }
  S.inFlight.add(key);
  renderIncidentPage();
  const epoch = S.epoch;
  try {
    await AmbulancesAPI.assign(ambulanceId, v.id);
    if (epoch !== S.epoch) return;
    S.mci.assignDraft.delete(v.id);
    mciNote(v.id, 'success', `${v.label} assigned to ${ambulanceId}.`);
  } catch (err) {
    if (epoch !== S.epoch) return;
    mciNote(v.id, isDefinite(err) ? 'error' : 'warning', isDefinite(err) ? `Not assigned: ${errorText(err)}` : `Outcome unknown (${errorText(err)}): the list is re-read from the server.`);
  } finally {
    if (epoch === S.epoch) { S.inFlight.delete(key); renderIncidentPage(); loadMany(['incident', 'ambulances']); }
  }
}

const sendAllReferrals = () => sendReferrals(mciPlan().filter(p => p.ref.sendable && p.suggestion?.hospital));

/** Referrals one after another, most urgent first; each result is shown as it comes, failures included. */
async function sendReferrals(items) {
  const mc = S.mci;
  if (mc.sending || !items.length) return;
  mc.sending = true;
  const epoch = S.epoch;
  renderIncidentPage();
  let sent = 0;
  try {
    for (const { v, suggestion } of items) {
      if (epoch !== S.epoch) return;
      const hospitalId = suggestion.hospital.id;
      mc.referrals.set(v.id, { phase: 'sending', hospitalId });
      mc.rowNotes.delete(v.id);
      renderIncidentPage();
      try {
        const res = await ReferralsAPI.initiate(v.id, hospitalId);
        if (epoch !== S.epoch) return;
        S.tracked.set(res.acceptance_id, { requestId: v.id, hospitalId, status: 'PENDING' });
        if (res.ttl_expires_at) S.lockDeadlines.set(res.acceptance_id, new Date(res.ttl_expires_at).getTime());
        mc.referrals.set(v.id, { phase: 'sent', hospitalId, acceptanceId: res.acceptance_id });
        sent += 1;
      } catch (err) {
        if (epoch !== S.epoch) return;
        if (isDefinite(err)) {
          mc.referrals.set(v.id, { phase: 'failed', hospitalId, message: errorText(err) });
        } else {
          // The answer was lost: read the case back (the server refuses a second referral while one is pending anyway).
          try {
            const d = await EmergenciesAPI.detail(v.id);
            if (epoch !== S.epoch) return;
            const pending = (d.acceptances || []).filter(a => a.status === 'PENDING').at(-1);
            if (pending) {
              S.tracked.set(pending.acceptance_id, { requestId: v.id, hospitalId: pending.hospital_id, status: 'PENDING' });
              if (pending.lock_expires_at) S.lockDeadlines.set(pending.acceptance_id, new Date(pending.lock_expires_at).getTime());
              mc.referrals.set(v.id, { phase: 'sent', hospitalId: pending.hospital_id, acceptanceId: pending.acceptance_id });
              sent += 1;
            } else {
              mc.referrals.set(v.id, { phase: 'failed', hospitalId, message: `the server's answer was lost and no referral is pending: nothing was sent (${errorText(err)}).` });
            }
          } catch (err2) {
            if (epoch !== S.epoch) return;
            mc.referrals.set(v.id, { phase: 'unknown', hospitalId, message: `the server's answer was lost (${errorText(err2)}). Check the case before sending again.` });
          }
        }
      }
      renderIncidentPage();
    }
  } finally {
    if (epoch === S.epoch) {
      mc.sending = false;
      notify(`${sent} of ${items.length} referral${items.length > 1 ? 's' : ''} sent.${sent < items.length ? ' The list shows the ones that were not.' : ''}`, sent === items.length ? 'success' : 'urgent');
      scheduleReload(['incident', 'emergencies', 'hospitals', 'referralHistory', 'dashboard'], 50);
      renderIncidentPage();
    }
  }
}

// ── Create incident, demo ──
function readIncidentForm() {
  const v = id => byId(id).value.trim();
  const errors = [];
  const title = v('mciTitle');
  if (!title) errors.push('Give the incident a title.');
  const lat = Number(v('mciLat')); const lng = Number(v('mciLng'));
  if (v('mciLat') === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('Latitude must be between -90 and 90.');
  if (v('mciLng') === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('Longitude must be between -180 and 180.');
  if (!errors.length) { const area = operatingAreaProblem(lat, lng, 'The incident location'); if (area) errors.push(area); }
  const int = (id, label, max) => {
    if (v(id) === '') return null;
    const n = Number(v(id));
    if (!Number.isInteger(n) || n < 0 || n > max) { errors.push(`${label} must be a whole number from 0 to ${max}.`); return null; }
    return n;
  };
  const body = {
    title, incident_type: v('mciType'), severity: v('mciSeverity'), location_text: v('mciPlace') || null,
    location_lat: lat, location_lng: lng, description: v('mciDescription') || null,
    estimated_victims: int('mciEstimated', 'Estimated victims', 1000), vehicles_involved: int('mciVehicles', 'Vehicles involved', 500)
  };
  const when = v('mciOccurred');
  if (when) { const t = new Date(when); if (Number.isNaN(t.getTime())) errors.push('The time is not valid.'); else body.occurred_at = t.toISOString(); }
  Object.keys(body).forEach(k => { if (body[k] === null) delete body[k]; });
  return { body, errors };
}

async function createIncident() {
  const mc = S.mci;
  if (mc.creating) return;
  const errEl = byId('mciCreateError');
  errEl.hidden = true;
  const { body, errors } = readIncidentForm();
  if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
  mc.creating = true;
  byId('mciCreateBtn').disabled = true;
  const epoch = S.epoch;
  try {
    const res = await IncidentsAPI.create(body);
    if (epoch !== S.epoch) return;
    byId('mciCreateForm').reset();
    notify(`Incident ${res.incident.incident_id} created. Add its victims.`, 'success');
    await load('incidents');
    openIncident(res.incident.incident_id);
  } catch (err) {
    if (epoch !== S.epoch) return;
    errEl.textContent = isDefinite(err) ? `Not created: ${errorText(err)}` : `Outcome unknown (${errorText(err)}): check the incident list before creating it again.`;
    errEl.hidden = false;
    load('incidents');
  } finally {
    if (epoch === S.epoch) { S.mci.creating = false; byId('mciCreateBtn').disabled = false; }
  }
}

async function loadIncidentDemo() {
  const btn = byId('mciDemoBtn');
  if (S.mci.demoBusy) return;
  S.mci.demoBusy = true; btn.disabled = true;
  const msg = byId('mciListMessage');
  msg.hidden = true;
  const epoch = S.epoch;
  try {
    const res = await IncidentsAPI.demoSetup();
    if (epoch !== S.epoch) return;
    const id = res.incident?.incident_id;
    notify(`Bus crash demo ready: ${id}.`, 'success');
    await loadMany(['incidents', 'ambulances', 'hospitals']);
    if (id) openIncident(id);
  } catch (err) {
    if (epoch !== S.epoch) return;
    msg.textContent = `Demo not loaded: ${errorText(err)}`; msg.hidden = false;
  } finally {
    if (epoch === S.epoch) { S.mci.demoBusy = false; btn.disabled = false; }
  }
}

// ── Victims: bulk rows ──
function readVictimRows() {
  return [...document.querySelectorAll('#mcRows .mc-row')].map(row => ({
    name: row.querySelector('.mc-name').value, age: row.querySelector('.mc-age').value, gender: row.querySelector('.mc-gender').value,
    triage: row.querySelector('.mc-triage').value, injury: row.querySelector('.mc-injury').value, transport: row.querySelector('.mc-transport').checked
  }));
}

function buildVictimRows() {
  const box = byId('mcRows');
  if (!box) return;
  const countInput = byId('mcCount');
  const n = Math.min(MC_MAX_ROWS, Math.max(1, Math.trunc(Number(countInput?.value)) || 1));
  const keep = readVictimRows();
  mount(box, Array.from({ length: n }, (_, i) => {
    const v = keep[i] || { name: '', age: '', gender: 'UNKNOWN', triage: 'GREEN', injury: 'MINOR', transport: true };
    const label = `Victim ${i + 1}`;
    return el('div', { class: 'mc-row', dataset: { index: String(i) } },
      el('span', { class: 'mc-num', 'aria-hidden': 'true' }, String(i + 1)),
      el('input', { class: 'form-input mc-name', type: 'text', maxlength: '150', placeholder: 'Name (optional)', value: v.name, 'aria-label': `${label} name (optional)`, autocomplete: 'off' }),
      el('input', { class: 'form-input mc-age', type: 'number', min: '0', max: '130', step: '1', inputmode: 'numeric', placeholder: 'Age', value: v.age, 'aria-label': `${label} approximate age (optional)` }),
      el('select', { class: 'form-select mc-gender', 'aria-label': `${label} sex` },
        [['UNKNOWN', 'Sex ?'], ['FEMALE', 'Female'], ['MALE', 'Male'], ['OTHER', 'Other']].map(([val, text]) => el('option', { value: val, selected: val === v.gender }, text))),
      el('select', { class: 'form-select mc-triage', 'aria-label': `${label} triage (decision support)` }, triageOptions(v.triage)),
      el('select', { class: 'form-select mc-injury', 'aria-label': `${label} main injury` }, injuryOptions(v.injury)),
      el('label', { class: 'mc-transport-label' }, el('input', { type: 'checkbox', class: 'mc-transport', checked: v.transport }), ' Ambulance'));
  }));
  if (countInput && String(n) !== countInput.value) countInput.value = String(n);
}

function resetVictimForm() {
  S.mci.bulk = { pendingKey: null, outcomeUnknown: false, submitting: false };
  S.mci.csv = null;
  mount(byId('mcRows'));
  if (byId('mcCount')) byId('mcCount').value = '5';
  buildVictimRows();
  mcError('');
  const f = byId('csvFile'); if (f) f.value = '';
  renderCsvPreview();
  updateVictimControls();
}

function mcError(text, tone = 'error') {
  const e = byId('mcError');
  if (!e) return;
  e.textContent = text || ''; e.hidden = !text;
  e.classList.toggle('is-success', tone === 'success');
}

function updateVictimControls() {
  const b = S.mci.bulk;
  const btn = byId('mcSaveBtn');
  if (btn) { btn.disabled = b.submitting; btn.textContent = b.submitting ? 'Saving…' : 'Save victims'; }
}

function victimPayloadFromRow(r) {
  const injury = MC_INJURIES.find(x => x.id === r.injury) || MC_INJURIES[0];
  const out = { full_name: r.name.trim() || null, gender: r.gender, injury_description: injury.label, triage_category: r.triage, emergency_type: injury.type, transport_required: r.transport };
  out.age = r.age.trim() === '' ? null : Number(r.age);
  return out;
}

/**
 * POST /incidents/:id/victims with an Idempotency-Key kept until the server settles it (a 2xx, or 422 for a key
 * already used with another body). A lost answer keeps the key, so pressing again cannot add the victims twice.
 */
async function postVictims(st, victims) {
  if (!st.pendingKey) st.pendingKey = newIdempotencyKey();
  const earlierUnknown = st.outcomeUnknown;
  st.outcomeUnknown = true;
  try {
    const res = await IncidentsAPI.addVictims(S.mci.openId, victims, st.pendingKey);
    st.pendingKey = null; st.outcomeUnknown = false;
    const n = (res.victims || res.cases || []).length || victims.length;
    return { tone: 'success', text: res.replayed ? `These ${n} victims were already saved by your earlier attempt; nothing was added twice.` : `${n} victim${n > 1 ? 's' : ''} saved.`, ok: true };
  } catch (err) {
    const outcome = createOutcome(err);
    if (outcome === 'reused') {
      st.pendingKey = null; st.outcomeUnknown = false;
      return { tone: 'error', text: 'Not saved again: an earlier attempt already saved victims with this submission, and your changes were not saved. Check the victims list.' };
    }
    if (outcome === 'refused') {
      st.outcomeUnknown = earlierUnknown;
      return { tone: 'error', text: `${earlierUnknown ? 'This attempt was refused; an earlier one may already have saved the victims (check the list). ' : 'Not saved: '}${errorText(err)}` };
    }
    return { tone: 'warning', text: `Outcome unknown: the server could not confirm whether the victims were saved (${errorText(err)}). Press again to retry; the retry reuses the same submission, so nothing is added twice.` };
  }
}

async function saveVictimRows() {
  const b = S.mci.bulk;
  if (b.submitting || !S.mci.openId) return;
  const rows = readVictimRows();
  const bad = rows.map((r, i) => { const a = Number(r.age); return r.age.trim() !== '' && (!Number.isInteger(a) || a < 0 || a > 130) ? i + 1 : null; }).filter(Boolean);
  if (bad.length) return mcError(`Age must be a whole number from 0 to 130, or empty (row${bad.length > 1 ? 's' : ''} ${bad.join(', ')}).`);
  b.submitting = true; updateVictimControls(); mcError('');
  const epoch = S.epoch;
  const result = await postVictims(b, rows.map(victimPayloadFromRow));
  if (epoch !== S.epoch) return;
  b.submitting = false; updateVictimControls();
  mcError(result.text, result.tone);
  if (result.ok) { mount(byId('mcRows')); buildVictimRows(); }
  loadMany(['incident', 'incidents']);
}

// ── Victims: CSV import (parsed here, checked by the server, then committed) ──
/** RFC 4180-style parse: quoted fields, doubled quotes, CRLF. Returns rows of strings. */
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

const CSV_COLUMNS = ['full_name', 'age', 'gender', 'triage_category', 'emergency_type', 'injury_description', 'transport_required', 'pickup_lat', 'pickup_lng'];
/** CSV rows as victims, exactly as written (the server validates them); only shape conversions here. */
function csvVictims(rows) {
  const [head, ...body] = rows;
  const cols = head.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const unknown = cols.filter(c => c && !CSV_COLUMNS.includes(c));
  const victims = body.map(cells => {
    const v = {};
    cols.forEach((c, i) => {
      if (!CSV_COLUMNS.includes(c)) return;
      const raw = (cells[i] ?? '').trim();
      if (c === 'age' || c === 'pickup_lat' || c === 'pickup_lng') { if (raw !== '') v[c] = Number.isFinite(Number(raw)) ? Number(raw) : raw; }
      else if (c === 'transport_required') { if (raw !== '') v[c] = /^(y|yes|true|1)$/i.test(raw) ? true : /^(n|no|false|0)$/i.test(raw) ? false : raw; }
      else if (c === 'triage_category' || c === 'gender' || c === 'emergency_type') { if (raw !== '') v[c] = raw.toUpperCase(); }
      else if (raw !== '') v[c] = raw;
    });
    return v;
  });
  return { victims, unknown };
}

async function onCsvFile(file) {
  if (!file || !S.mci.openId) return;
  const epoch = S.epoch;
  let text;
  try { text = await file.text(); } catch (err) { S.mci.csv = { fileName: file.name, victims: [], errors: [], message: { tone: 'error', text: `The file could not be read: ${errorText(err)}` } }; return renderCsvPreview(); }
  if (epoch !== S.epoch) return;
  const rows = parseCsv(text);
  if (rows.length < 2) { S.mci.csv = { fileName: file.name, victims: [], errors: [], message: { tone: 'error', text: 'The file needs a header line and at least one victim.' } }; return renderCsvPreview(); }
  const { victims, unknown } = csvVictims(rows);
  if (victims.length > MC_MAX_ROWS) { S.mci.csv = { fileName: file.name, victims: [], errors: [], message: { tone: 'error', text: `At most ${MC_MAX_ROWS} victims per file (this one has ${victims.length}).` } }; return renderCsvPreview(); }
  S.mci.csv = { fileName: file.name, victims, errors: [], checking: true, checked: false, pendingKey: null, outcomeUnknown: false, submitting: false,
    message: unknown.length ? { tone: 'warning', text: `Ignored columns: ${unknown.join(', ')}.` } : null };
  renderCsvPreview();
  try {
    const res = await IncidentsAPI.validateVictims(S.mci.openId, victims);
    if (epoch !== S.epoch || S.mci.csv?.victims !== victims) return;
    S.mci.csv.errors = Array.isArray(res.errors) ? res.errors : [];
    S.mci.csv.checked = res.valid !== false && S.mci.csv.errors.length === 0;
  } catch (err) {
    if (epoch !== S.epoch || S.mci.csv?.victims !== victims) return;
    // A 4xx may carry the row errors too.
    const errs = err.body?.errors;
    S.mci.csv.errors = Array.isArray(errs) ? errs : [];
    S.mci.csv.message = { tone: 'error', text: Array.isArray(errs) ? 'Some rows have errors: correct the file and choose it again.' : `The rows could not be checked: ${errorText(err)}` };
  } finally {
    if (epoch === S.epoch && S.mci.csv?.victims === victims) { S.mci.csv.checking = false; renderCsvPreview(); }
  }
}

const csvRowOf = e => Number(e.row ?? e.index ?? e.line ?? -1);

function renderCsvPreview() {
  const box = byId('csvPreview');
  if (!box) return;
  const c = S.mci.csv;
  if (!c) return mount(box);
  // Server row numbers: 0-based index (row/index) of the victims list.
  const errorsFor = i => c.errors.filter(e => csvRowOf(e) === i);
  const general = c.errors.filter(e => csvRowOf(e) < 0 || csvRowOf(e) >= c.victims.length);
  mount(box,
    el('p', { class: 'field-caption' }, `${c.fileName}: ${c.victims.length} row${c.victims.length === 1 ? '' : 's'}.`),
    c.message ? el('p', { class: ['status-line', c.message.tone === 'success' ? 'is-success' : c.message.tone === 'warning' ? 'is-warning' : 'is-error'], id: 'csvMessage', role: 'status' }, c.message.text) : null,
    c.checking ? loadingMsg('Checking the rows with the server…') : null,
    general.map(e => el('p', { class: 'form-error', role: 'alert' }, e.message || e.error || JSON.stringify(e))),
    c.victims.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'matrix-table', id: 'csvTable' },
      el('thead', {}, el('tr', {}, ['#', 'Name', 'Age', 'Triage', 'Type', 'Injury', 'Check'].map(t => el('th', {}, t)))),
      el('tbody', {}, c.victims.map((v, i) => {
        const errs = errorsFor(i);
        return el('tr', { class: errs.length ? 'csv-bad' : null, dataset: { row: String(i), ok: String(!errs.length) } },
          el('td', {}, String(i + 1)), el('td', {}, v.full_name || el('span', { class: 'cell-muted' }, 'label given by the server')), el('td', {}, v.age ?? '—'),
          el('td', {}, String(v.triage_category ?? '—')), el('td', {}, String(v.emergency_type ?? '—')), el('td', {}, v.injury_description || '—'),
          el('td', { class: errs.length ? 'text-danger csv-errors' : 'cell-muted' }, errs.length ? errs.map(e => `${e.field ? `${e.field}: ` : ''}${e.message || e.error}`).join('; ') : c.checked ? 'OK' : '…'));
      })))) : null,
    c.victims.length ? el('button', { type: 'button', class: 'btn btn-primary btn-block', id: 'csvImportBtn', disabled: !c.checked || c.submitting || c.checking, on: { click: importCsv } },
      c.submitting ? 'Importing…' : `Import ${c.victims.length} victim${c.victims.length === 1 ? '' : 's'}`) : null);
}

async function importCsv() {
  const c = S.mci.csv;
  if (!c || c.submitting || !c.checked) return;
  c.submitting = true; renderCsvPreview();
  const epoch = S.epoch;
  const result = await postVictims(c, c.victims);
  if (epoch !== S.epoch || S.mci.csv !== c) return;
  c.submitting = false;
  c.message = { tone: result.tone, text: result.text };
  if (result.ok) { c.checked = false; c.victims = []; const f = byId('csvFile'); if (f) f.value = ''; }
  renderCsvPreview();
  loadMany(['incident', 'incidents']);
}

function initIncidents() {
  byId('mciCreateForm')?.addEventListener('submit', e => { e.preventDefault(); createIncident(); });
  byId('mciDemoBtn')?.addEventListener('click', loadIncidentDemo);
  mount(byId('mcFillTriage'), el('option', { value: '' }, 'Triage'), triageOptions(null));
  mount(byId('mcFillInjury'), el('option', { value: '' }, 'Main injury'), injuryOptions(null));
  byId('mcRowsBtn')?.addEventListener('click', buildVictimRows);
  byId('mcCount')?.addEventListener('change', buildVictimRows);
  byId('mcFillBtn')?.addEventListener('click', () => {
    const t = byId('mcFillTriage').value; const inj = byId('mcFillInjury').value;
    document.querySelectorAll('#mcRows .mc-row').forEach(row => {
      if (t) row.querySelector('.mc-triage').value = t;
      if (inj) row.querySelector('.mc-injury').value = inj;
    });
  });
  byId('mcSaveBtn')?.addEventListener('click', saveVictimRows);
  byId('csvFile')?.addEventListener('change', e => onCsvFile(e.target.files?.[0]));
  buildVictimRows();
}

// ──────────────────────────────────────────────────────────────────────────────
// Accounts (ADMIN): GET/POST/PATCH /admin/users, POST /admin/users/:id/reset-password
// Passwords are read from their inputs at submit time, sent, and the inputs are cleared; nothing keeps them.
// ──────────────────────────────────────────────────────────────────────────────
const PASSWORD_POLICY = 'At least 10 characters and at most 72 bytes. It is never shown again; share it with the person directly.';

function linkText(u) {
  return [u.hospital_id && hospitalName(u.hospital_id), u.ambulance_id && `Unit ${u.ambulance_id}`].filter(Boolean).join(' · ') || '—';
}

function renderAccounts() {
  const body = byId('accountsTableBody');
  if (!body || !can('ADMIN')) return;
  const r = S.res.accounts;
  const gate = resourceGate(r, { retry: () => load('accounts'), isEmpty: d => !d.users?.length, empty: stateMsg('No accounts', 'No account matches these filters.') });
  const prev = byId('accountsPrev'); const next = byId('accountsNext');
  if (gate) {
    setText('accountResultCount', '');
    if (prev) prev.disabled = S.accounts.offset === 0;
    if (next) next.disabled = true;
    return mount(body, el('tr', {}, el('td', { colspan: '7' }, gate)));
  }
  const { users, total, offset } = r.data;
  setText('accountResultCount', `${offset + 1}–${offset + users.length} of ${total} accounts`);
  if (prev) prev.disabled = offset === 0;
  if (next) next.disabled = offset + users.length >= total;
  mount(body, users.map(u => el('tr', { dataset: { userId: u.user_id, username: u.username } },
    el('td', { class: 'cell-id' }, u.username),
    el('td', {}, u.display_name || '—'),
    el('td', {}, ROLE_LABEL[u.role] || u.role),
    el('td', { class: 'cell-muted' }, linkText(u)),
    el('td', {}, badge(Number(u.is_active) ? 'OPEN' : 'CLOSED', Number(u.is_active) ? 'Active' : 'Inactive'), Number(u.is_demo) ? el('span', { class: 'cell-muted' }, ' demo') : null),
    el('td', { class: 'cell-time' }, u.last_login ? fmtDateTime(u.last_login) : 'Never'),
    el('td', {}, el('button', { type: 'button', class: 'btn btn-secondary btn-sm btn-edit-account', on: { click: () => openAccountForm({ mode: 'edit', userId: u.user_id }) } }, 'Edit')))));
  // Re-render an open edit form only when the server's row differs from what it shows (never under the admin's typing).
  if (S.accounts.form?.mode === 'edit') {
    const fresh = users.find(u => u.user_id === S.accounts.form.userId);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(S.accounts.form.user)) renderAccountForm();
  }
}

function openAccountForm(form) {
  S.accounts.form = form;
  if (S.res.hospitals.status === 'idle') load('hospitals');
  if (S.res.ambulances.status === 'idle') load('ambulances');
  if (S.res.emergencies.status === 'idle') load('emergencies');
  renderAccountForm();
  byId('accountFormPanel')?.scrollIntoView({ block: 'nearest' });
}

function accountLinkFields(roleValue, current = {}) {
  const hospitalsList = hospitals();
  const units = S.res.ambulances.data || [];
  return el('div', { class: 'account-links' },
    el('div', { class: 'form-group', hidden: roleValue !== 'HOSPITAL_DESK' },
      el('label', { class: 'form-label', for: 'accountHospital' }, 'Hospital (required for a Hospital login)'),
      el('select', { id: 'accountHospital', class: 'form-select' }, el('option', { value: '' }, 'Choose a hospital'),
        hospitalsList.map(h => el('option', { value: h.id, selected: h.id === current.hospital_id }, `${h.name} (${h.id})`)))),
    el('div', { class: 'form-group', hidden: roleValue !== 'PARAMEDIC' },
      el('label', { class: 'form-label', for: 'accountAmbulance' }, 'Ambulance crewed (optional for a Fleet login)'),
      el('select', { id: 'accountAmbulance', class: 'form-select' }, el('option', { value: '' }, 'No unit'),
        units.map(a => el('option', { value: a.ambulance_id, selected: a.ambulance_id === current.ambulance_id }, `${a.ambulance_id} · ${a.vehicle_number || ''} · ${a.hospital_name || a.hospital_id || ''}`)))));
}

/** The links the chosen role carries (others are cleared, as the server requires). */
function readAccountLinks(roleValue) {
  const v = id => byId(id)?.value || null;
  return {
    hospital_id: roleValue === 'HOSPITAL_DESK' ? v('accountHospital') : null,
    ambulance_id: roleValue === 'PARAMEDIC' ? v('accountAmbulance') : null
  };
}

function passwordInputs(prefix) {
  return [
    el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: `${prefix}Password` }, 'Password'),
      el('input', { type: 'password', id: `${prefix}Password`, class: 'form-input', autocomplete: 'new-password', maxlength: '200' })),
    el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: `${prefix}PasswordConfirm` }, 'Repeat password'),
      el('input', { type: 'password', id: `${prefix}PasswordConfirm`, class: 'form-input', autocomplete: 'new-password', maxlength: '200' })),
    el('p', { class: 'field-caption' }, PASSWORD_POLICY)
  ];
}

/** Read and clear a password pair; returns { password } or { error }. */
function takePassword(prefix) {
  const a = byId(`${prefix}Password`); const b = byId(`${prefix}PasswordConfirm`);
  const password = a?.value || ''; const again = b?.value || '';
  if (a) a.value = ''; if (b) b.value = '';
  if (password !== again) return { error: 'The two passwords differ.' };
  if (password.length < 10) return { error: 'The password must be at least 10 characters.' };
  if (new TextEncoder().encode(password).length > 72) return { error: 'The password must be at most 72 bytes.' };
  return { password };
}

/** A 400/409 from the account API, said plainly (the server's own message names the rule). */
function accountErrorText(err) {
  if (!(err instanceof ApiError)) return errorText(err);
  if (err.status === 409) return `Not changed: ${err.message}`;
  if (err.status === 400) return `Not saved: ${err.message}`;
  if (err.status === 404) return 'Not saved: this account no longer exists. The list has been refreshed.';
  return `Not saved: ${errorText(err)}`;
}

function showAccountMessage(id, text, tone) {
  const node = byId(id);
  if (!node) return;
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('is-success', tone === 'success');
}

function renderAccountForm() {
  const panel = byId('accountFormPanel');
  if (!panel) return;
  const form = S.accounts.form;
  if (!form || !can('ADMIN')) { show(panel, false); mount(panel); return; }
  show(panel, true);
  if (form.mode === 'create') {
    const roleSelect = el('select', { id: 'accountRole', class: 'form-select', on: { change: () => { form.role = roleSelect.value; renderAccountForm(); } } },
      ACCOUNT_ROLES.map(r => el('option', { value: r, selected: r === (form.role || 'HOSPITAL_DESK') }, ROLE_LABEL[r])));
    const roleValue = form.role || 'HOSPITAL_DESK';
    const keep = id => byId(id)?.value || '';
    const username = keep('accountUsername'); const displayName = keep('accountDisplayName');
    mount(panel,
      el('div', { class: 'panel-header' }, el('div', {}, el('span', { class: 'panel-title' }, 'New account'),
        el('p', { class: 'panel-caption' }, 'The fields shown depend on the role.')),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => { S.accounts.form = null; renderAccountForm(); } } }, 'Close')),
      el('form', { id: 'accountCreateForm', class: 'account-form', on: { submit: e => { e.preventDefault(); submitCreateAccount(roleValue); } } },
        el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'accountUsername' }, 'Username'),
          el('input', { type: 'text', id: 'accountUsername', class: 'form-input', maxlength: '80', autocomplete: 'off', value: username, required: true }),
          el('p', { class: 'field-caption' }, '3–80 characters: letters, digits, "_", ".", "@", "-". Case-sensitive.')),
        el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'accountDisplayName' }, 'Display name'),
          el('input', { type: 'text', id: 'accountDisplayName', class: 'form-input', maxlength: '150', value: displayName })),
        el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'accountRole' }, 'Role'), roleSelect),
        accountLinkFields(roleValue),
        passwordInputs('accountNew'),
        el('div', { id: 'accountFormError', class: 'form-error', role: 'alert', hidden: true }),
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'accountCreateSubmit' }, 'Create account')));
    return;
  }
  const user = (S.res.accounts.data?.users || []).find(u => u.user_id === form.userId) || form.user;
  if (!user) { S.accounts.form = null; show(panel, false); return; }
  form.user = user;
  const roleValue = form.role || user.role;
  const self = user.user_id === S.user.user_id;
  const roleSelect = el('select', { id: 'accountEditRole', class: 'form-select', disabled: self, on: { change: () => { form.role = roleSelect.value; renderAccountForm(); } } },
    ACCOUNT_ROLES.map(r => el('option', { value: r, selected: r === roleValue }, ROLE_LABEL[r])),
    // An account of a type ERIS no longer has keeps its role shown (and unchanged) until the admin picks another.
    ACCOUNT_ROLES.includes(roleValue) ? null : el('option', { value: roleValue, selected: true, disabled: true }, `${roleValue} (no longer used)`));
  const active = Number(user.is_active) === 1;
  mount(panel,
    el('div', { class: 'panel-header' }, el('div', {}, el('span', { class: 'panel-title' }, `Account ${user.username}`),
      el('p', { class: 'panel-caption' }, `${ROLE_LABEL[user.role] || user.role} · ${active ? 'active' : 'inactive'}${self ? ' · this is you' : ''}`)),
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => { S.accounts.form = null; renderAccountForm(); } } }, 'Close')),
    el('form', { id: 'accountEditForm', class: 'account-form', dataset: { userId: user.user_id }, on: { submit: e => { e.preventDefault(); submitEditAccount(user, roleValue); } } },
      el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'accountEditDisplayName' }, 'Display name'),
        el('input', { type: 'text', id: 'accountEditDisplayName', class: 'form-input', maxlength: '150', value: user.display_name || '' })),
      el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'accountEditRole' }, 'Role'), roleSelect,
        self ? el('p', { class: 'field-caption' }, 'You cannot change your own role.') : null),
      accountLinkFields(roleValue, roleValue === user.role ? user : {}),
      el('div', { id: 'accountEditError', class: 'form-error', role: 'alert', hidden: true }),
      el('div', { class: 'row' },
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'accountEditSubmit' }, 'Save changes'),
        el('button', { type: 'button', class: active ? 'btn btn-danger' : 'btn btn-secondary', id: active ? 'btnAccountDeactivate' : 'btnAccountReactivate',
          on: { click: () => setAccountActive(user, !active) } }, active ? 'Deactivate' : 'Reactivate'))),
    el('form', { id: 'accountResetForm', class: 'account-form', on: { submit: e => { e.preventDefault(); submitResetPassword(user); } } },
      el('h3', { class: 'section-subtitle' }, 'Reset password'),
      passwordInputs('accountReset'),
      el('div', { id: 'accountResetMessage', class: 'form-error', role: 'alert', hidden: true }),
      el('button', { type: 'submit', class: 'btn btn-secondary', id: 'accountResetSubmit' }, 'Set new password')));
}

async function accountCall(errorId, fn) {
  const epoch = S.epoch;
  try {
    const result = await fn();
    if (epoch !== S.epoch) return null;
    return result;
  } catch (err) {
    if (epoch !== S.epoch) return null;
    showAccountMessage(errorId, accountErrorText(err), 'error');
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) load('accounts');
    return null;
  }
}

async function submitCreateAccount(roleValue) {
  showAccountMessage('accountFormError', '', 'error');
  const pw = takePassword('accountNew');
  if (pw.error) return showAccountMessage('accountFormError', pw.error, 'error');
  const body = { username: byId('accountUsername').value.trim(), display_name: byId('accountDisplayName').value.trim() || null, role: roleValue, ...readAccountLinks(roleValue), password: pw.password };
  if (roleValue === 'HOSPITAL_DESK' && !body.hospital_id) return showAccountMessage('accountFormError', 'Choose the hospital this Hospital login works for.', 'error');
  const submit = byId('accountCreateSubmit'); if (submit) submit.disabled = true;
  const res = await accountCall('accountFormError', () => AdminAPI.createUser(body));
  if (submit) submit.disabled = false;
  if (!res) return;
  notify(`Account ${res.user.username} created (${ROLE_LABEL[res.user.role] || res.user.role}).`, 'success');
  S.accounts.form = null;
  renderAccountForm();
  load('accounts');
}

async function submitEditAccount(user, roleValue) {
  showAccountMessage('accountEditError', '', 'error');
  const changes = {};
  const name = byId('accountEditDisplayName').value.trim();
  if (name && name !== (user.display_name || '')) changes.display_name = name;
  if (roleValue !== user.role) changes.role = roleValue;
  const links = readAccountLinks(roleValue);
  for (const k of ['hospital_id', 'ambulance_id']) {
    // A role change sends every link (null where the new role has none); otherwise only the links that changed.
    if (changes.role || (links[k] ?? null) !== (user[k] ?? null)) changes[k] = links[k];
  }
  if (!Object.keys(changes).length) return showAccountMessage('accountEditError', 'Nothing to save: no field was changed.', 'error');
  const res = await accountCall('accountEditError', () => AdminAPI.updateUser(user.user_id, changes));
  if (!res) return;
  notify(`Account ${res.user.username} updated.${changes.role || 'hospital_id' in changes || 'ambulance_id' in changes ? ' Their open sessions were ended.' : ''}`, 'success');
  S.accounts.form = { mode: 'edit', userId: res.user.user_id, user: res.user };
  renderAccountForm();
  load('accounts');
}

async function setAccountActive(user, active) {
  showAccountMessage('accountEditError', '', 'error');
  if (!active && !window.confirm(`Deactivate ${user.username}? They are signed out at their next request.`)) return;
  const res = await accountCall('accountEditError', () => AdminAPI.updateUser(user.user_id, { is_active: active }));
  if (!res) return;
  notify(`Account ${res.user.username} ${active ? 'reactivated' : 'deactivated'}.`, 'success');
  S.accounts.form = { mode: 'edit', userId: res.user.user_id, user: res.user };
  renderAccountForm();
  load('accounts');
}

async function submitResetPassword(user) {
  showAccountMessage('accountResetMessage', '', 'error');
  const pw = takePassword('accountReset');
  if (pw.error) return showAccountMessage('accountResetMessage', pw.error, 'error');
  const res = await accountCall('accountResetMessage', () => AdminAPI.resetPassword(user.user_id, pw.password));
  if (!res) return;
  showAccountMessage('accountResetMessage', `New password set for ${user.username}. Their open sessions were ended; they sign in again with the new password.`, 'success');
}

function initAccounts() {
  byId('btnNewAccount')?.addEventListener('click', () => openAccountForm({ mode: 'create', role: 'HOSPITAL_DESK' }));
  byId('accountRoleFilter')?.addEventListener('change', e => { S.accounts.role = e.target.value; S.accounts.offset = 0; load('accounts'); });
  byId('accountActiveFilter')?.addEventListener('change', e => { S.accounts.active = e.target.value; S.accounts.offset = 0; load('accounts'); });
  byId('accountsPrev')?.addEventListener('click', () => { S.accounts.offset = Math.max(0, S.accounts.offset - S.accounts.limit); load('accounts'); });
  byId('accountsNext')?.addEventListener('click', () => { S.accounts.offset += S.accounts.limit; load('accounts'); });
}

// ──────────────────────────────────────────────────────────────────────────────
// First aid guide as a dialog (sign-in screen and roadside). Static content: no API call, no socket, no state.
// ──────────────────────────────────────────────────────────────────────────────
let firstAidOpener = null;
function openFirstAid(opener) {
  const overlay = byId('firstAidOverlay');
  if (!overlay) return;
  if (!byId('firstAidOverlayBody').childElementCount) renderFirstAid(byId('firstAidOverlayBody'), { idPrefix: 'fa-dlg' });
  firstAidOpener = opener || null;
  overlay.hidden = false;
  document.body.classList.add('firstaid-open');
  byId('firstAidClose')?.focus();
}
function closeFirstAid() {
  const overlay = byId('firstAidOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('firstaid-open');
  firstAidOpener?.focus?.();
  firstAidOpener = null;
}
function initFirstAid() {
  byId('firstAidLink')?.addEventListener('click', e => openFirstAid(e.currentTarget));
  byId('firstAidClose')?.addEventListener('click', closeFirstAid);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFirstAid(); });
}

// ──────────────────────────────────────────────────────────────────────────────
// Live tracking (simulated ambulance trips): /api/v1/tracking/*, socket tracking:update
// ──────────────────────────────────────────────────────────────────────────────
const TRACK_PHASE_TEXT = {
  DISPATCHED: 'Dispatched: waiting to start',
  EN_ROUTE_TO_PATIENT: 'On the way to the patient',
  ARRIVED_AT_PATIENT: 'Arrived at the patient',
  PATIENT_PICKED_UP: 'Patient on board',
  EN_ROUTE_TO_HOSPITAL: 'On the way to the hospital',
  ARRIVED_AT_HOSPITAL: 'Arrived at the hospital',
  COMPLETED: 'Trip completed'
};
const TRACK_MOVING = ['EN_ROUTE_TO_PATIENT', 'EN_ROUTE_TO_HOSPITAL'];
const trackPhase = phase => TRACK_PHASE_TEXT[phase] || fmtStatus(phase);
/** A trip's phase for display: the server keeps ARRIVED_AT_HOSPITAL with completed=true once the trip is completed. */
const tripPhase = trip => (trip?.completed ? 'COMPLETED' : trip?.phase);
/** Where the trip got to, for the case line: a trip closed at the hospital (the desk's handover closes it) arrived there. */
const tripReached = trip => (trip?.completed && trip.phase !== 'ARRIVED_AT_HOSPITAL' ? 'COMPLETED' : trip?.phase);
const fmtEta = sec => (sec === null || sec === undefined ? '—' : sec <= 0 ? 'now' : `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')} s`);
const routeLabel = src => (src === 'osrm' ? 'Road route (OSRM)' : 'Simulated route');
const trips = () => S.res.trips.data || [];
const selectedTrip = () => trips().find(t => t.trip_id === S.tracking.selectedId) || null;

/** The Fleet login(s) crewing the trip's ambulance (sent to the admin only), e.g. "UNIT-402". */
const crewText = trip => (Array.isArray(trip?.crew) ? trip.crew.filter(u => typeof u === 'string' && u).join(', ') : '');

/** The controls a role may use, each enabled only in the phases the server accepts it. */
function trackingControls(trip) {
  const phase = tripPhase(trip); const paused = Boolean(trip.paused);
  const all = [
    { action: 'start', label: 'Start Demo', on: phase === 'DISPATCHED' },
    { action: 'pause', label: 'Pause', on: TRACK_MOVING.includes(phase) && !paused },
    { action: 'resume', label: 'Resume', on: TRACK_MOVING.includes(phase) && paused },
    { action: 'pickup', label: 'Patient Picked Up', on: phase === 'ARRIVED_AT_PATIENT' },
    { action: 'complete', label: 'Complete Trip', on: phase === 'ARRIVED_AT_HOSPITAL' },
    { action: 'reset', label: 'Reset Demo', on: Boolean(trip.is_demo) && (phase !== 'DISPATCHED' || Boolean(trip.timestamps?.started_at)) }
  ];
  if (can('ADMIN')) return all;
  if (can('PARAMEDIC')) return all.filter(c => ['start', 'pickup', 'complete'].includes(c.action));
  return []; // a hospital watches
}

function ensureTrackingMap() {
  const box = byId('trackingMap');
  if (!box || S.tracking.map || !S.user) return S.tracking.map;
  S.tracking.map = createTrackingMap(box, { reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches });
  if (!S.tracking.map) mount(box, stateMsg('Map unavailable', 'The map library could not be loaded; the trip details are still shown.'));
  return S.tracking.map;
}

function renderTracking() {
  const select = byId('trackingTripSelect');
  if (!select || !can('ADMIN', 'PARAMEDIC', 'HOSPITAL_DESK')) return;
  const r = S.res.trips;
  const list = trips();
  if (!S.tracking.selectedId || !list.some(t => t.trip_id === S.tracking.selectedId)) S.tracking.selectedId = list[0]?.trip_id || null;
  mount(select, list.length ? list.map(t => el('option', { value: t.trip_id, selected: t.trip_id === S.tracking.selectedId },
    `${t.request_id} · ${t.ambulance?.ambulance_id || '—'} · ${trackPhase(tripPhase(t))}`)) : el('option', { value: '' }, r.status === 'loading' ? 'Loading trips…' : 'No trips'));
  select.disabled = !list.length;
  const trip = selectedTrip();
  const details = byId('trackingDetails');
  const gate = resourceGate(r, { retry: () => load('trips'), empty: stateMsg('No ambulance trips', can('ADMIN')
    ? 'Load the sample demo trip, or create one from an allocated case below.'
    : can('HOSPITAL_DESK') ? 'No ambulance is coming to your hospital right now.' : 'No trip for your ambulance yet.') });
  if (gate || !trip) {
    mount(details, gate || stateMsg('No trip selected', ''));
    mount(byId('trackingControls'));
    setText('trackingRouteLabel', '');
    ensureTrackingMap()?.show(null);
  } else {
    setText('trackingRouteLabel', `· ${routeLabel(trip.route_source)}`);
    const caseStatus = trip.case?.status || queue().find(q => q.request_id === trip.request_id)?.status || null;
    mount(details, el('p', { class: 'status-line', id: 'trackingCaseLine', dataset: { caseStatus: caseStatus || '' } },
      `Trip: ${trackPhase(tripReached(trip))} · Case: ${caseStatus ? sentenceCase(caseStatus) : '—'}${trip.hospital?.name ? ` (${trip.hospital.name})` : ''}`),
    el('div', { class: 'kv-grid', id: 'trackingTripDetails', dataset: { tripId: trip.trip_id, phase: tripPhase(trip) } },
      kv('Case', trip.request_id),
      kv('Ambulance', trip.ambulance?.ambulance_id || '—'),
      crewText(trip) ? kv('Fleet login', el('span', { id: 'trackingCrew' }, crewText(trip))) : null,
      kv('Patient', trip.patient?.full_name || '—'),
      kv('Priority', priorityBadge(trip.case?.priority)),
      kv('Phase', el('span', { id: 'trackingPhase' }, `${trackPhase(tripPhase(trip))}${trip.paused ? ' (paused)' : ''}`)),
      kv('Progress', el('span', { id: 'trackingProgress' }, `${Math.round((Number(trip.progress) || 0) * 100)}%`)),
      kv('ETA (simulated)', el('span', { id: 'trackingEta' }, fmtEta(trip.eta_seconds))),
      kv('Hospital', trip.hospital?.name || '—'),
      kv('Route', routeLabel(trip.route_source))));
    const busy = S.inFlight.has(`trk:${trip.trip_id}`);
    mount(byId('trackingControls'), trackingControls(trip).map(c => el('button', {
      type: 'button', class: ['btn', 'btn-sm', c.action === 'reset' ? 'btn-secondary' : 'btn-primary'], dataset: { action: c.action },
      disabled: !c.on || busy, on: { click: () => trackingAction(trip.trip_id, c.action) }
    }, c.label)));
    ensureTrackingMap()?.show(trip);
  }
  const msg = byId('trackingMessage');
  if (msg) { msg.textContent = S.tracking.message?.text || ''; msg.hidden = !S.tracking.message; msg.classList.toggle('is-success', S.tracking.message?.tone === 'success'); }
  if (can('ADMIN')) renderTrackingAdmin();
}

/** A server push: update the trip and move the marker from where it is shown now (never a jump). */
function applyTrackingUpdate(p) {
  if (!p?.trip_id) return;
  const patient = can('HOSPITAL_DESK') ? (S.res.patients.data || []).find(x => x.request_id === p.request_id) : null;
  if (patient) {
    const phase = p.completed ? 'COMPLETED' : p.phase ?? patient.trip_phase;
    if (phase !== patient.trip_phase) { patient.trip_phase = phase; renderHospitalPatients(); }
  }
  const list = S.res.trips.data;
  const trip = list?.find(t => t.trip_id === p.trip_id);
  if (!trip) { if (S.res.trips.status !== 'idle') scheduleReload(['trips'], 200); return; }
  const phaseChanged = (p.completed ? 'COMPLETED' : p.phase) !== tripPhase(trip);
  Object.assign(trip, { phase: p.phase ?? trip.phase, current: p.current ?? trip.current, progress: p.progress ?? trip.progress,
    eta_seconds: p.eta_seconds ?? trip.eta_seconds, paused: p.paused ?? trip.paused, route_source: p.route_source ?? trip.route_source,
    completed: p.completed ?? trip.completed });
  if (trip.trip_id === S.tracking.selectedId) renderTracking();
  if (patient) { // the desk's ETA, in place (no re-render: a bed label being typed keeps its focus)
    const node = document.querySelector(`#hospitalPatientsList .patient-card[data-request-id="${CSS.escape(patient.request_id)}"] .patient-trip`);
    if (node) node.textContent = patientTripText(patient);
  }
  if (phaseChanged) { renderQueue(); renderCommandQueue(); if (trip.request_id === S.selectedRequestId) renderCaseTracker(); }
}

async function trackingAction(tripId, action) {
  const key = `trk:${tripId}`;
  if (S.inFlight.has(key)) return; // double-submit safe
  S.inFlight.add(key);
  const epoch = S.epoch;
  S.tracking.message = null;
  renderTracking();
  try {
    const res = await TrackingAPI.action(tripId, action);
    if (epoch !== S.epoch) return;
    if (res?.trip) {
      const list = S.res.trips.data || [];
      const i = list.findIndex(t => t.trip_id === tripId);
      if (i >= 0) list[i] = res.trip;
    }
  } catch (err) {
    if (epoch !== S.epoch) return;
    S.tracking.message = { tone: 'error', text: err instanceof ApiError && err.status === 409 ? `Not allowed now: ${err.message}` : `Not done: ${errorText(err)}` };
  } finally {
    if (epoch === S.epoch) {
      S.inFlight.delete(key);
      load('trips'); // the server's state wins (also after a lost answer)
      renderTracking();
    }
  }
}

// ── Admin: sample demo trip and "Create demo trip" ──
function renderTrackingAdmin() {
  const box = byId('trackingAdmin');
  if (!box || box.dataset.ready === 'true') return refreshTrackingForm();
  box.dataset.ready = 'true';
  mount(box,
    el('h3', { class: 'section-subtitle' }, 'Demo data'),
    el('button', { type: 'button', class: 'btn btn-secondary btn-block', id: 'btnTrackingSample', on: { click: loadSampleTrip } }, 'Load sample demo trip'),
    el('form', { id: 'trackingCreateForm', class: 'account-form', novalidate: true, on: { submit: e => { e.preventDefault(); createDemoTrip(); } } },
      el('h3', { class: 'section-subtitle' }, 'Create demo trip'),
      el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'trkCase' }, 'Case (allocated, with a pickup and an accepted hospital)'),
        el('select', { id: 'trkCase', class: 'form-select', on: { change: refreshTrackingForm } })),
      el('p', { class: 'field-caption', id: 'trkHospital' }, ''),
      el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'trkAmbulance' }, 'Ambulance'),
        el('select', { id: 'trkAmbulance', class: 'form-select', on: { change: () => fillStartFromAmbulance(true) } })),
      el('div', { class: 'grid-2col' },
        el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'trkStartLat' }, 'Start latitude'),
          el('input', { id: 'trkStartLat', class: 'form-input', type: 'text', inputmode: 'decimal' })),
        el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'trkStartLng' }, 'Start longitude'),
          el('input', { id: 'trkStartLng', class: 'form-input', type: 'text', inputmode: 'decimal' }))),
      el('p', { class: 'field-caption' }, 'Defaults to the ambulance\'s current position.'),
      el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: 'trkSpeed' }, 'Speed (km/h)'),
        el('input', { id: 'trkSpeed', class: 'form-input', type: 'number', min: '10', max: '200', step: '1', value: '60' })),
      el('p', { id: 'trkFormError', class: 'form-error', role: 'alert', hidden: true }),
      el('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'btnTrackingCreate' }, 'Create demo trip')));
  if (S.res.ambulances.status === 'idle') load('ambulances');
  refreshTrackingForm();
}

/** Cases a demo trip can follow: ALLOCATED, with pickup coordinates and an accepted hospital. */
const trackableCases = () => queue().filter(c => c.status === 'ALLOCATED' && c.accepted_hospital_id
  && c.pickup_lat !== null && c.pickup_lat !== undefined && c.pickup_lng !== null && c.pickup_lng !== undefined);

function refreshTrackingForm() {
  const caseSel = byId('trkCase'); const ambSel = byId('trkAmbulance');
  if (!caseSel || !ambSel) return;
  const keepCase = caseSel.value; const keepAmb = ambSel.value;
  const cases = trackableCases();
  mount(caseSel, el('option', { value: '' }, cases.length ? 'Choose a case' : 'No allocated case with a pickup location'),
    cases.map(c => el('option', { value: c.request_id, selected: c.request_id === keepCase }, `${c.request_id} · ${triageLabel(c.triage_category, c.priority)} · ${patientOf(c).full_name || ''}`)));
  const units = S.res.ambulances.data || [];
  mount(ambSel, el('option', { value: '' }, units.length ? 'Choose an ambulance' : 'No ambulances'),
    units.map(a => el('option', { value: a.ambulance_id, selected: a.ambulance_id === keepAmb }, `${a.ambulance_id} · ${fmtStatus(a.status).toLowerCase()} · ${a.hospital_name || a.hospital_id || ''}`)));
  const chosen = cases.find(c => c.request_id === caseSel.value);
  const h = chosen ? hospitals().find(x => x.id === chosen.accepted_hospital_id) : null;
  setText('trkHospital', chosen
    ? `Destination (read-only): ${h ? `${h.name} at ${fmtNumber(h.lat, 5)}, ${fmtNumber(h.lng, 5)}` : chosen.accepted_hospital_id}. Pickup: ${fmtNumber(chosen.pickup_lat, 5)}, ${fmtNumber(chosen.pickup_lng, 5)}.`
    : 'The destination is the case\'s accepted hospital (read-only).');
  fillStartFromAmbulance(false);
}

function fillStartFromAmbulance(force) {
  const a = (S.res.ambulances.data || []).find(x => x.ambulance_id === byId('trkAmbulance')?.value);
  const lat = byId('trkStartLat'); const lng = byId('trkStartLng');
  if (!a || !lat || !lng) return;
  if (force || (!lat.value && !lng.value)) {
    lat.value = a.current_lat !== null && a.current_lat !== undefined ? String(a.current_lat) : '';
    lng.value = a.current_lng !== null && a.current_lng !== undefined ? String(a.current_lng) : '';
  }
}

async function loadSampleTrip() {
  const btn = byId('btnTrackingSample');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const epoch = S.epoch;
  try {
    const res = await TrackingAPI.demoSetup();
    if (epoch !== S.epoch) return;
    S.tracking.selectedId = res.trip?.trip_id || S.tracking.selectedId;
    S.tracking.message = { tone: 'success', text: `Sample demo trip ready: ${res.trip?.request_id || ''} with ${res.trip?.ambulance?.ambulance_id || 'its ambulance'}. Press Start Demo.${
      crewText(res.trip) ? ` The crew follows it by signing in as ${crewText(res.trip)} (Fleet).` : ''}` };
  } catch (err) {
    if (epoch !== S.epoch) return;
    S.tracking.message = { tone: 'error', text: `Sample trip not loaded: ${errorText(err)}` };
  } finally {
    if (epoch === S.epoch) { btn.disabled = false; load('trips'); load('emergencies'); load('ambulances'); renderTracking(); }
  }
}

async function createDemoTrip() {
  const err = byId('trkFormError'); const btn = byId('btnTrackingCreate');
  if (!err || !btn || btn.disabled) return;
  err.hidden = true;
  const body = {
    request_id: byId('trkCase').value, ambulance_id: byId('trkAmbulance').value,
    start_lat: Number(byId('trkStartLat').value), start_lng: Number(byId('trkStartLng').value), speed_kmh: Number(byId('trkSpeed').value)
  };
  const problem = !body.request_id ? 'Choose a case.' : !body.ambulance_id ? 'Choose an ambulance.'
    : byId('trkStartLat').value.trim() === '' || !Number.isFinite(body.start_lat) || body.start_lat < -90 || body.start_lat > 90 ? 'Start latitude must be between -90 and 90.'
      : byId('trkStartLng').value.trim() === '' || !Number.isFinite(body.start_lng) || body.start_lng < -180 || body.start_lng > 180 ? 'Start longitude must be between -180 and 180.'
        : !Number.isInteger(body.speed_kmh) || body.speed_kmh < 10 || body.speed_kmh > 200 ? 'Speed must be a whole number from 10 to 200 km/h.'
          : operatingAreaProblem(body.start_lat, body.start_lng, 'The start position');
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  btn.disabled = true;
  const epoch = S.epoch;
  try {
    const res = await TrackingAPI.create(body);
    if (epoch !== S.epoch) return;
    S.tracking.selectedId = res.trip?.trip_id || S.tracking.selectedId;
    S.tracking.message = { tone: 'success', text: `Demo trip created for ${body.request_id} with ${body.ambulance_id}. Press Start Demo.` };
  } catch (e) {
    if (epoch !== S.epoch) return;
    err.textContent = `Not created: ${errorText(e)}`; err.hidden = false;
  } finally {
    if (epoch === S.epoch) { btn.disabled = false; load('trips'); renderTracking(); }
  }
}

// ── Operating area: the locality pickers (GET /geo/operating-area) and GPS outside the area ──
const OUTSIDE_AREA = `Outside the ${OPERATING_AREA.name} operating area — choose a locality.`;
let localities = [];
async function loadLocalities() {
  const epoch = S.epoch;
  try {
    const res = await GeoAPI.operatingArea();
    if (epoch !== S.epoch) return;
    localities = (res.localities || []).filter(l => !operatingAreaProblem(Number(l.lat), Number(l.lng)));
  } catch { localities = []; }
  document.querySelectorAll('.locality-select').forEach(sel => {
    const first = sel.querySelector('option[value=""]');
    mount(sel, first, localities.map((l, i) => el('option', { value: String(i) }, l.name)));
    sel.disabled = !localities.length;
  });
}
function initLocalityPickers() {
  document.querySelectorAll('.locality-select').forEach(sel => sel.addEventListener('change', () => {
    const l = localities[Number(sel.value)];
    if (!l || sel.value === '') return;
    byId(sel.dataset.lat).value = Number(l.lat).toFixed(6);
    byId(sel.dataset.lng).value = Number(l.lng).toFixed(6);
    if (sel.dataset.place && byId(sel.dataset.place)) byId(sel.dataset.place).value = l.name;
  }));
}

function initTracking() {
  byId('trackingTripSelect')?.addEventListener('change', e => { S.tracking.selectedId = e.target.value || null; renderTracking(); });
}

// ──────────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────────
function initFilters() {
  ['emergencySearch', 'emergencyPriorityFilter', 'emergencyStatusFilter'].forEach(id => byId(id)?.addEventListener('input', renderQueue));
  ['emergencyPriorityFilter', 'emergencyStatusFilter'].forEach(id => byId(id)?.addEventListener('change', renderQueue));
  ['hospitalSearch', 'hospitalStatusFilter'].forEach(id => { byId(id)?.addEventListener('input', renderHospitals); byId(id)?.addEventListener('change', renderHospitals); });
  ['ambulanceSearch', 'ambulanceStatusFilter'].forEach(id => { byId(id)?.addEventListener('input', renderFleet); byId(id)?.addEventListener('change', renderFleet); });
  ['doctorSearch', 'doctorFacilityFilter', 'doctorSpecFilter', 'doctorStatusFilter'].forEach(id => { byId(id)?.addEventListener('input', renderDoctors); byId(id)?.addEventListener('change', renderDoctors); });
  byId('auditCaseFilter')?.addEventListener('input', renderAudit);
  ['layerToggleHospitals', 'layerToggleAmbulances', 'layerToggleIncidents'].forEach(id => byId(id)?.addEventListener('change', renderMapData));
  byId('btnRecenterMap')?.addEventListener('click', () => { if (S.map) { S.mapFitted = false; renderMapData(); } });
  byId('btnVerifyAuditChain')?.addEventListener('click', verifyAuditChain);
  byId('btnExportAuditLedgerCsv')?.addEventListener('click', exportAuditCsv);
  byId('registrationsWindow')?.addEventListener('change', () => load('registrations'));
  byId('btnExportRegistrationsCsv')?.addEventListener('click', exportRegistrationsCsv);
}

function boot() {
  initTheme();
  initClock();
  initNavigation();
  initLoginForm();
  initIntakeControls();
  initFilters();
  initDoctorModal();
  initAccounts();
  initOpenCase();
  initRoadside();
  initFirstAid();
  initTracking();
  initLocalityPickers();
  initIncidents();
  initBankersSimulator();
  renderLiveEvents();
  setInterval(tickCountdowns, 500);
  restoreSession();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
