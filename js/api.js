// js/api.js
// Phase 2: Backend REST API Client & WebSocket Connection Manager
// Provides a unified interface for all API calls and real-time events

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:4000/api/v1';
let _authToken = null;
let _currentUser = null;

// ──────────────────────────────────────────────────────────────────────────────
// Auth Token Management
// ──────────────────────────────────────────────────────────────────────────────
export function setAuthToken(token) {
  _authToken = token;
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      _currentUser = payload;
    } catch { _currentUser = null; }
  } else {
    _currentUser = null;
  }
}

export function getAuthToken()   { return _authToken; }
export function getCurrentUser() { return _currentUser; }

// ──────────────────────────────────────────────────────────────────────────────
// HTTP Fetch Wrapper
// ──────────────────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (err) {
    // Backend not available — return null gracefully
    console.warn(`[API] Backend unavailable: ${err.message}`);
    return null;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `API Error ${response.status}`);
  }
  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// Auth API
// ──────────────────────────────────────────────────────────────────────────────
export const AuthAPI = {
  async login(username, password) {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    if (data?.token) setAuthToken(data.token);
    return data;
  },

  async me() {
    return apiFetch('/auth/me');
  },

  logout() {
    setAuthToken(null);
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Hospitals API
// ──────────────────────────────────────────────────────────────────────────────
export const HospitalsAPI = {
  getAll(status)       { return apiFetch(`/hospitals${status ? `?status=${status}` : ''}`); },
  getById(id)          { return apiFetch(`/hospitals/${id}`); },
  updateStatus(id, s)  { return apiFetch(`/hospitals/${id}/status`, { method: 'PATCH', body: JSON.stringify({ emergency_status: s }) }); },
  updateResource(id, type, body) {
    return apiFetch(`/hospitals/${id}/resources/${type}`, { method: 'PATCH', body: JSON.stringify(body) });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Emergencies API
// ──────────────────────────────────────────────────────────────────────────────
export const EmergenciesAPI = {
  getAll(status)       { return apiFetch(`/emergencies${status ? `?status=${status}` : ''}`); },
  getById(id)          { return apiFetch(`/emergencies/${id}`); },
  create(body)         { return apiFetch('/emergencies', { method: 'POST', body: JSON.stringify(body) }); },
  updateStatus(id, s)  { return apiFetch(`/emergencies/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: s }) }); },
  getAudit(id)         { return apiFetch(`/emergencies/${id}/audit`); }
};

// ──────────────────────────────────────────────────────────────────────────────
// Referrals API
// ──────────────────────────────────────────────────────────────────────────────
export const ReferralsAPI = {
  initiate(requestId, hospitalId, resourceTypes = ['ICU_BED']) {
    return apiFetch('/referrals/initiate', {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, hospital_id: hospitalId, resource_types: resourceTypes })
    });
  },
  accept(acceptanceId) {
    return apiFetch(`/referrals/${acceptanceId}/accept`, { method: 'POST' });
  },
  reject(acceptanceId, reason) {
    return apiFetch(`/referrals/${acceptanceId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ rejection_reason: reason })
    });
  },
  getActive()   { return apiFetch('/referrals/active'); },
  getHistory()  { return apiFetch('/referrals/history'); }
};

// ──────────────────────────────────────────────────────────────────────────────
// Doctors API
// ──────────────────────────────────────────────────────────────────────────────
export const DoctorsAPI = {
  getAll(filters = {}) {
    const q = new URLSearchParams(filters).toString();
    return apiFetch(`/doctors${q ? `?${q}` : ''}`);
  },
  getById(id)            { return apiFetch(`/doctors/${id}`); },
  create(body)           { return apiFetch('/doctors', { method: 'POST', body: JSON.stringify(body) }); },
  updateStatus(id, s)    { return apiFetch(`/doctors/${id}/status`, { method: 'PATCH', body: JSON.stringify({ availability_status: s }) }); },
  updateShift(id, body)  { return apiFetch(`/doctors/${id}/shift`, { method: 'PATCH', body: JSON.stringify(body) }); },
  delete(id)             { return apiFetch(`/doctors/${id}`, { method: 'DELETE' }); }
};

// ──────────────────────────────────────────────────────────────────────────────
// Ambulances API
// ──────────────────────────────────────────────────────────────────────────────
export const AmbulancesAPI = {
  getAll(filters = {}) {
    const q = new URLSearchParams(filters).toString();
    return apiFetch(`/ambulances${q ? `?${q}` : ''}`);
  },
  updateStatus(id, body) {
    return apiFetch(`/ambulances/${id}/status`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  getSummary() { return apiFetch('/ambulances/stats/summary'); }
};

// ──────────────────────────────────────────────────────────────────────────────
// Analytics API
// ──────────────────────────────────────────────────────────────────────────────
export const AnalyticsAPI = {
  getDashboard()  { return apiFetch('/analytics/dashboard'); },
  getReferrals()  { return apiFetch('/analytics/referrals'); },
  getAudit()      { return apiFetch('/analytics/audit'); },
  getResources()  { return apiFetch('/analytics/resources'); }
};

// ──────────────────────────────────────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────────────────────────────────────
export async function checkServerHealth() {
  try {
    const res = await fetch('http://localhost:4000/health');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// P2-04: WebSocket Real-Time Client (Socket.io)
// Manages the live connection to the backend for real-time events
// ──────────────────────────────────────────────────────────────────────────────
let _socket = null;
const _socketListeners = new Map();

export function initWebSocket(token, onEvent) {
  if (_socket?.connected) return _socket;

  // Dynamically load socket.io client from CDN if not already available
  if (typeof io === 'undefined') {
    console.warn('[WS] Socket.io client not loaded. Skipping WebSocket connection.');
    return null;
  }

  _socket = io('http://localhost:4000', {
    transports: ['websocket', 'polling'],
    auth: { token: token || '' },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: 5
  });

  _socket.on('connect', () => {
    console.log('[WS] Connected to Emergency System backend');
    if (onEvent) onEvent('connected', { socket_id: _socket.id });
  });

  _socket.on('disconnect', (reason) => {
    console.warn('[WS] Disconnected:', reason);
    if (onEvent) onEvent('disconnected', { reason });
  });

  // Real-time event forwarding
  const events = [
    'system:snapshot', 'kpis:update', 'lock:acquired', 'lock:released', 'lock:expired',
    'lock:expired_cleanup', 'allocation:committed', 'referral:incoming', 'referral:countdown',
    'referral:accepted', 'referral:rejected', 'referral:expired', 'alert:new', 'audit:entry'
  ];

  events.forEach(event => {
    _socket.on(event, (data) => {
      if (onEvent) onEvent(event, data);
    });
  });

  return _socket;
}

export function getSocket()    { return _socket; }
export function disconnectWS() { if (_socket) { _socket.disconnect(); _socket = null; } }
