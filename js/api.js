// js/api.js
// REST client, session storage and the single Socket.IO connection.
//
// Rules this module enforces:
//  - Same origin by default: the Express server serves this UI, so the API is `/api/v1` and the socket is the page
//    origin. An explicit override exists for development only: <meta name="eris-api-origin" content="http://host:port">.
//  - apiFetch never "succeeds quietly": a network failure, any non-2xx status and a malformed JSON body all throw
//    ApiError. There is no fallback data anywhere.
//  - A 401 on an authenticated call clears the session and notifies the app (which shows the sign-in portal).
//  - The JWT is kept in sessionStorage: it survives a reload of this tab but is not shared with other tabs and is
//    dropped when the tab closes (smaller exposure than localStorage). It is validated with /auth/me before use.

const SESSION_KEY = 'eris.session.token';
/** The server's 401 (REST and socket handshake) for a token issued before an account change. */
export const REVOKED_SESSION = /ended by an account change/i;
const LEGACY_LOCAL_KEY = 'eris.auth.session'; // older builds kept the token in localStorage; removed on load

const metaOrigin = typeof document !== 'undefined'
  ? (document.querySelector('meta[name="eris-api-origin"]')?.getAttribute('content') || '').trim().replace(/\/+$/, '')
  : '';
export const API_ORIGIN = metaOrigin; // '' = same origin
const API_BASE = `${API_ORIGIN}/api/v1`;

export class ApiError extends Error {
  /** kind: 'network' | 'http' | 'parse' */
  constructor(message, { status = 0, kind = 'http', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.body = body;
  }
}

// ── Session ──────────────────────────────────────────────────────────────────
let authToken = null;
let unauthorizedHandler = null;

function storage() {
  try { return window.sessionStorage; } catch { return null; }
}

try { window.localStorage?.removeItem(LEGACY_LOCAL_KEY); } catch { /* storage unavailable */ }

export function onUnauthorized(handler) { unauthorizedHandler = handler; }

export function getToken() { return authToken; }

export function storeToken(token) {
  authToken = token || null;
  const s = storage();
  try {
    if (token) s?.setItem(SESSION_KEY, token);
    else s?.removeItem(SESSION_KEY);
  } catch { /* in-memory only */ }
}

export function readStoredToken() {
  try { return storage()?.getItem(SESSION_KEY) || null; } catch { return null; }
}

/** Expiry (epoch ms) from the token's `exp` claim, or null. The payload is NOT trusted for identity — /auth/me is. */
export function tokenExpiryMs(token) {
  try {
    const part = String(token).split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(json).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function isTokenExpired(token, skewMs = 5000) {
  const exp = tokenExpiryMs(token);
  return exp === null || exp - skewMs <= Date.now();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
export async function apiFetch(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (auth) {
    if (!authToken) {
      unauthorizedHandler?.('Your session has ended. Please sign in again.');
      throw new ApiError('Not signed in.', { status: 401, kind: 'http' });
    }
    finalHeaders.Authorization = `Bearer ${authToken}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch {
    throw new ApiError('Cannot reach the ERIS server. Check the connection and try again.', { kind: 'network' });
  }

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch {
      throw new ApiError(`The server sent an unreadable response (HTTP ${response.status}).`, { status: response.status, kind: 'parse' });
    }
  }

  if (!response.ok) {
    const message = (data && typeof data.error === 'string' && data.error) || `Request failed (HTTP ${response.status}).`;
    if (response.status === 401 && auth) {
      storeToken(null);
      // A token refused because the account changed (password reset, deactivation, role or link change) says so.
      unauthorizedHandler?.(REVOKED_SESSION.test(message) ? message : 'Your session has expired or is no longer valid. Please sign in again.');
    }
    throw new ApiError(message, { status: response.status, kind: 'http', body: data });
  }
  if (data === null || typeof data !== 'object') {
    throw new ApiError('The server sent an empty or unexpected response.', { status: response.status, kind: 'parse' });
  }
  return { data, headers: response.headers };
}

const get = async path => (await apiFetch(path)).data;
const send = async (method, path, body, headers) => (await apiFetch(path, { method, body, headers })).data;
const enc = encodeURIComponent;

// ── Endpoints ────────────────────────────────────────────────────────────────
export const AuthAPI = {
  async login(username, password) {
    const { data } = await apiFetch('/auth/login', { method: 'POST', body: { username, password }, auth: false });
    if (typeof data.token !== 'string' || !data.user) throw new ApiError('The server did not return a session.', { kind: 'parse' });
    return data;
  },
  me: () => get('/auth/me')
};

export const HospitalsAPI = {
  list: () => get('/hospitals'),
  updateStatus: (id, status) => send('PATCH', `/hospitals/${enc(id)}/status`, { emergency_status: status }),
  /** The hospital's accepted cases (its own desk, or ADMIN). */
  patients: id => get(`/hospitals/${enc(id)}/patients`),
  /** ADMIN: capacity, doctors, referral counts and active cases per hospital. */
  overview: () => get('/hospitals/overview')
};

export const EmergenciesAPI = {
  list: () => get('/emergencies'),
  detail: id => get(`/emergencies/${enc(id)}`),
  audit: id => get(`/emergencies/${enc(id)}/audit`),
  /** The same idempotencyKey for a retry of the same submission makes the server return the original case. */
  async create(body, idempotencyKey) {
    const { data, headers } = await apiFetch('/emergencies', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } });
    return { ...data, replayed: headers.get('Idempotent-Replayed') === 'true' };
  },
  updateStatus: (id, status) => send('PATCH', `/emergencies/${enc(id)}/status`, { status }),
  /** ADMIN, or the desk of the hospital holding the case: move a staged case to its next treatment stage. */
  advanceStage: id => send('POST', `/emergencies/${enc(id)}/advance-stage`),
  /**
   * The receiving hospital's steps, in order (its own desk only; the server checks state and order):
   * arrive -> allocate-bed { bed_label } -> start-treatment -> notes { note } (while in treatment) -> complete.
   */
  caseStep: (id, step, body) => send('POST', `/emergencies/${enc(id)}/${enc(step)}`, body),
  /** ADMIN or the holding desk: the treatment progress notes. */
  notes: id => get(`/emergencies/${enc(id)}/notes`),
  /** ADMIN: change a victim's triage category with a reason (decision support; audited). */
  setTriage: (id, triageCategory, reason) => send('POST', `/emergencies/${enc(id)}/triage`, { triage_category: triageCategory, reason })
};

// Mass-casualty incidents (ADMIN).
export const IncidentsAPI = {
  list: () => get('/incidents'),
  detail: id => get(`/incidents/${enc(id)}`),
  create: body => send('POST', '/incidents', body),
  /** Victims, all or nothing. The same idempotencyKey for a retry returns the original result (Idempotent-Replayed). */
  async addVictims(id, victims, idempotencyKey) {
    const { data, headers } = await apiFetch(`/incidents/${enc(id)}/victims`, { method: 'POST', body: { victims }, headers: { 'Idempotency-Key': idempotencyKey } });
    return { ...data, replayed: headers.get('Idempotent-Replayed') === 'true' };
  },
  /** Row-level errors for the same body, nothing saved (CSV preview). */
  validateVictims: (id, victims) => send('POST', `/incidents/${enc(id)}/victims/validate`, { victims }),
  demoSetup: (reset = false) => send('POST', `/incidents/demo-setup${reset ? '?reset=1' : ''}`)
};

export const ReferralsAPI = {
  initiate: (requestId, hospitalId) => send('POST', '/referrals/initiate', { request_id: requestId, hospital_id: hospitalId }),
  accept: id => send('POST', `/referrals/${enc(id)}/accept`),
  reject: (id, reason) => send('POST', `/referrals/${enc(id)}/reject`, { rejection_reason: reason }),
  active: () => get('/referrals/active'),
  history: () => get('/referrals/history')
};

export const DoctorsAPI = {
  list: () => get('/doctors'),
  create: body => send('POST', '/doctors', body),
  updateStatus: (id, status) => send('PATCH', `/doctors/${enc(id)}/status`, { availability_status: status })
};

export const AmbulancesAPI = {
  list: () => get('/ambulances'),
  updateStatus: (id, body) => send('PATCH', `/ambulances/${enc(id)}/status`, body),
  /** ADMIN: seats 1-4. */
  setCapacity: (id, capacity) => send('PATCH', `/ambulances/${enc(id)}/capacity`, { capacity }),
  /** ADMIN: put a patient on this unit (RED alone; others within free seats). */
  assign: (id, requestId) => send('POST', `/ambulances/${enc(id)}/assign`, { request_id: requestId }),
  unassign: (id, requestId, reason) => send('POST', `/ambulances/${enc(id)}/unassign`, { request_id: requestId, reason }),
  /** Fleet, own unit: the patient is on board. */
  pickup: (id, requestId) => send('POST', `/ambulances/${enc(id)}/pickup`, { request_id: requestId })
};

export const AnalyticsAPI = {
  getDashboard: () => get('/analytics/dashboard'),
  getReferrals: () => get('/analytics/referrals'),
  getAudit: (limit = 200) => get(`/analytics/audit?limit=${enc(limit)}`),
  getResources: () => get('/analytics/resources'),
  getHistory: days => get(`/analytics/history?days=${enc(days)}`),
  /** ADMIN: the caller's own registered cases with their milestones (GET /analytics/my-registrations). */
  myRegistrations: (days, limit) => get(`/analytics/my-registrations?days=${enc(days)}&limit=${enc(limit)}`),
  getForecast: (historyDays, horizonDays) => get(`/analytics/forecast?history_days=${enc(historyDays)}&horizon_days=${enc(horizonDays)}`)
};

/** Query string from the defined values only (a repeated or empty parameter is a 400 on the server). */
const qs = params => {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); });
  const text = q.toString();
  return text ? `?${text}` : '';
};

// Account management (ADMIN only). Passwords go straight into the request body; nothing keeps them.
export const AdminAPI = {
  listUsers: ({ role, active, limit, offset } = {}) => get(`/admin/users${qs({ role, active, limit, offset })}`),
  createUser: body => send('POST', '/admin/users', body),
  updateUser: (userId, changes) => send('PATCH', `/admin/users/${enc(userId)}`, changes),
  resetPassword: (userId, password) => send('POST', `/admin/users/${enc(userId)}/reset-password`, { password })
};

// Live tracking of (simulated) ambulance trips. The server scopes the list per role and checks every transition.
export const TrackingAPI = {
  list: () => get('/tracking/trips'),
  detail: id => get(`/tracking/trips/${enc(id)}`),
  demoSetup: () => send('POST', '/tracking/demo-setup'),
  create: body => send('POST', '/tracking/demo-trips', body),
  action: (id, action) => send('POST', `/tracking/trips/${enc(id)}/${enc(action)}`)
};

/** The operating area: { name, bbox, localities: [{ name, lat, lng }] } (verified locality centre points). */
export const GeoAPI = {
  operatingArea: () => get('/geo/operating-area')
};

export const AuditAPI = {
  verify: () => get('/audit/verify')
};

// ── Socket.IO (exactly one connection) ───────────────────────────────────────
export const SOCKET_EVENTS = [
  'system:snapshot', 'kpis:update', 'locks:update',
  'lock:acquired', 'lock:released', 'lock:expired', 'lock:expired_cleanup', 'allocation:committed',
  'referral:incoming', 'referral:countdown', 'referral:accepted', 'referral:rejected', 'referral:expired',
  'referral:status', 'alert:new', 'audit:entry', 'tracking:update', 'case:status'
];

let socket = null;

/**
 * Open the live connection for `token`, replacing any previous one. `onEvent(name, payload)` receives every server
 * event plus the lifecycle pseudo-events 'socket:connected' | 'socket:disconnected' | 'socket:error' | 'socket:unavailable'.
 */
export function connectSocket(token, onEvent) {
  disconnectSocket();
  if (typeof window.io !== 'function') {
    onEvent('socket:unavailable', {});
    return null;
  }
  const s = window.io(API_ORIGIN || undefined, {
    transports: ['websocket', 'polling'],
    forceNew: true, // a new session never reuses the previous session's manager or credentials
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000
  });
  socket = s;
  s.on('connect', () => { if (socket === s) onEvent('socket:connected', {}); });
  s.on('disconnect', reason => { if (socket === s) onEvent('socket:disconnected', { reason }); });
  s.on('connect_error', err => { if (socket === s) onEvent('socket:error', { message: err?.message || 'connection error' }); });
  SOCKET_EVENTS.forEach(name => s.on(name, payload => { if (socket === s) onEvent(name, payload); }));
  return s;
}

export function socketEmit(name, payload) {
  if (socket?.connected) socket.emit(name, payload);
}

export function isSocketConnected() { return Boolean(socket?.connected); }

export function disconnectSocket() {
  if (!socket) return;
  const s = socket;
  socket = null;
  s.removeAllListeners();
  s.disconnect();
}
