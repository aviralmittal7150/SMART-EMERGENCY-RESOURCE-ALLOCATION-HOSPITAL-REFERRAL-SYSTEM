// server/server.js
// Express.js Backend REST API — Phase 2 Main Entry Point
// Smart Emergency Resource Allocation & Hospital Referral System

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Route Modules
import authRoutes       from './routes/auth.js';
import hospitalsRoutes  from './routes/hospitals.js';
import emergenciesRoutes from './routes/emergencies.js';
import referralsRoutes  from './routes/referrals.js';
import doctorsRoutes    from './routes/doctors.js';
import ambulancesRoutes from './routes/ambulances.js';
import auditRoutes from './routes/audit.js';
import analyticsRoutes  from './routes/analytics.js';
import adminRoutes      from './routes/admin.js';
import patientRoutes    from './routes/patient.js';
import trackingRoutes   from './routes/tracking.js';
import incidentsRoutes  from './routes/incidents.js';
import geoRoutes        from './routes/geo.js';

// Services
import { assertAuthConfig, verifyToken, resolveAccount, REVOKED_TOKEN, accountUsable } from './middleware/auth.js';
import { startSocketAccountRecheck, parseRecheckInterval, refreshSocketAccount } from './services/socketAccounts.js';
import { accountEvents } from './services/accountEvents.js';
import { parseTrustProxy } from './services/trustProxy.js';
import { parseApiRateLimit } from './services/settings.js';
import { bootstrapStore } from './db/bootstrap.js';
import { store } from './db/store.js';
import { rejectRepeatedQuery } from './services/validation.js';
import {
  socketRooms, visibleLocks, userRoom, hospitalRoom, ambulanceRoom, isStaff, COMMAND_CENTER, STAFF_ROOM, ADMIN_ROOM
} from './services/accessPolicy.js';
import { loadPatientCase, patientCaseUpdate } from './services/patientView.js';
import { parseTrackingConfig } from './services/tracking/config.js';
import { TrackingEngine } from './services/tracking/engine.js';
import { createRouter } from './services/tracking/routing.js';
import { configureTracking } from './services/tracking/index.js';
import { caseStatusEvent, CASE_STATUS_EVENT } from './services/caseEvents.js';
import { OPERATING_AREA } from './services/operatingArea.js';
import { startSimulatedTransport } from './services/tracking/autoTransport.js';

dotenv.config();

// Token settings (JWT_SECRET strength in production, JWT_EXPIRES) and TRUST_PROXY are checked before anything else
// starts (X9; round 2 item 10).
let trustProxy;
let socketRecheckMs;
let apiRateLimit;
let trackingConfig;
try {
  assertAuthConfig();
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  socketRecheckMs = parseRecheckInterval(process.env.SOCKET_RECHECK_MS);
  apiRateLimit = parseApiRateLimit(process.env.API_RATE_LIMIT);
  // Batch 7: TRACKING_TICK_MS, TRACKING_TIME_SCALE, ROUTING_URL (https only; off in production unless set), ROUTING_TIMEOUT_MS.
  trackingConfig = parseTrackingConfig(process.env);
  // Batch 8: the retired DISPATCHER / PATIENT roles may be re-enabled for tests only, never in production.
  if (process.env.NODE_ENV === 'production' && (process.env.ENABLE_RETIRED_ROLES ?? '').trim() !== '') {
    throw new Error('ENABLE_RETIRED_ROLES is a test setting and must not be set when NODE_ENV=production.');
  }
} catch (err) {
  console.error(`[STARTUP] ${err.message}`);
  process.exit(1);
}

// Choose the storage backend BEFORE anything can serve a request. In MySQL mode a connection or
// schema problem aborts startup: there is deliberately no fallback to the in-memory store.
let storage;
try {
  storage = await bootstrapStore();
} catch (err) {
  console.error(`[STARTUP] ${err.message}`);
  process.exit(1);
}
const lockingEngine = storage.store.lockingEngine;

// Batch 7: the ONE simulation engine of this process, on the configured store. Started below, stopped on shutdown.
const tracking = configureTracking(new TrackingEngine({
  store,
  router: createRouter({ url: trackingConfig.routingUrl, timeoutMs: trackingConfig.routingTimeoutMs, area: OPERATING_AREA }),
  tickMs: trackingConfig.tickMs,
  timeScale: trackingConfig.timeScale,
  area: OPERATING_AREA,
  legSeconds: trackingConfig.legSeconds
}));
console.log(`[TRACKING] Simulated trips every ${trackingConfig.tickMs} ms; routing ${trackingConfig.routingUrl
  ? `via ${trackingConfig.routingUrl} (sends trip coordinates to that service; straight lines on failure)`
  : 'OFF (straight-line routes)'}${trackingConfig.timeScale !== 1 ? `; time scale x${trackingConfig.timeScale} (demo speed-up x${trackingConfig.demoSpeedup})` : ''}${trackingConfig.legSeconds ? `; time-compressed legs of ${trackingConfig.legSeconds.min}-${trackingConfig.legSeconds.max} s (Simulated)` : ''}; operating area ${OPERATING_AREA.name}; simulated transport on accept ${trackingConfig.simulatedTransport ? 'ON' : 'OFF'}.`);

// Production (X2; round 2 item 4; Batch 6 round 2): demo accounts are refused at login, so a production server without
// one active, usable, non-demo ADMIN could not be administered (patients or desks alone cannot manage accounts).
// Refuse to start instead, and report leftover demo accounts.
if (process.env.NODE_ENV === 'production') {
  let usable;
  let demoUsers;
  try {
    usable = await store.countUsableAdmins();
    demoUsers = await store.countDemoUsers();
  } catch (err) {
    console.error(`[STARTUP] Could not check the accounts: ${err.message}`);
    process.exit(1);
  }
  if (usable === 0) {
    console.error('[STARTUP] NODE_ENV=production but this store has no active non-demo ADMIN account, so nobody could administer it (demo accounts are refused in production). ' +
      'Create one with `npm run user:create -- --role ADMIN` (MySQL store). Refusing to start.');
    process.exit(1);
  }
  if (demoUsers > 0) {
    console.warn(`[SECURITY] ${demoUsers} demo account(s) exist in this store. They are REFUSED at login because NODE_ENV=production; deactivate them.`);
  }
}

const PORT = parseInt(process.env.PORT || '4000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ──────────────────────────────────────────────────────────────────────────────
// Express App Setup
// ──────────────────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Rate limits key on the client address. Behind a reverse proxy set TRUST_PROXY (e.g. 1) so that address is the
// real client's, not the proxy's; never trust X-Forwarded-For from the open internet (X6).
app.set('trust proxy', trustProxy);

// ── Security Middleware ──
// Content-Security-Policy exactly as the frontend was verified against (e2e/SERVER_REQUIREMENTS.md §1). useDefaults is
// off so helmet adds nothing else (notably no upgrade-insecure-requests, which would break a plain-HTTP LAN demo).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── One error shape (X11): every 4xx/5xx JSON body is { success: false, error, ... } ──
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && body.success === undefined
    ? json({ success: false, ...body })
    : json(body));
  next();
});

// ── CORS ──
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', FRONTEND_URL],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['Idempotent-Replayed'],
  credentials: true
}));

// ── Body Parsing ──
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request Logging ──
app.use(morgan('dev'));

// ── Global Rate Limiting ──
app.use('/api/', rateLimit({
  windowMs: 60_000,
  limit: apiRateLimit, // API_RATE_LIMIT, default 300 per minute per client address
  message: { success: false, error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
}));

// ── API responses carry patient data: never cached; a repeated query parameter is a 400 (X7) ──
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', rejectRepeatedQuery);

// ──────────────────────────────────────────────────────────────────────────────
// REST API Routes  — /api/v1/*
// ──────────────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',        authRoutes);
app.use('/api/v1/hospitals',   hospitalsRoutes);
app.use('/api/v1/emergencies', emergenciesRoutes);
app.use('/api/v1/referrals',   referralsRoutes);
app.use('/api/v1/doctors',     doctorsRoutes);
app.use('/api/v1/ambulances',  ambulancesRoutes);
app.use('/api/v1/analytics',   analyticsRoutes);
app.use('/api/v1/audit',       auditRoutes);
app.use('/api/v1/admin',       adminRoutes);
app.use('/api/v1/patient',     patientRoutes);
app.use('/api/v1/tracking',    trackingRoutes);
app.use('/api/v1/incidents',   incidentsRoutes);
app.use('/api/v1/geo',         geoRoutes);

// ── Health Check ──
app.get('/health', async (req, res) => {
  let databaseUp = true;
  try {
    databaseUp = await store.ping();
  } catch {
    databaseUp = false;
  }
  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'OK' : 'DEGRADED',
    service: 'Smart Emergency Resource Allocation API',
    version: '2.0.0',
    storage: storage.config.mode,
    database: databaseUp ? 'up' : 'down',
    uptime_sec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ── Static Frontend Serving ──
// Only frontend assets and the documents linked from the UI are public.
// Never expose rootDir wholesale: it contains server source, tests and config.
const PUBLIC_DOCS = ['PRD.md', 'WORKFLOW.md', 'AGENTS.md'];
app.use('/css', express.static(path.join(rootDir, 'css')));
app.use('/js', express.static(path.join(rootDir, 'js')));
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(rootDir, 'index.html')));
PUBLIC_DOCS.forEach(doc => app.get(`/${doc}`, (req, res) => res.sendFile(path.join(rootDir, doc))));

// ── 404 Handler for API Routes ──
app.use('/api', (req, res) => {
  // originalUrl, not path: inside this mount `req.path` has lost its "/api" prefix.
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.originalUrl.split('?')[0]}` });
});

// ── Fallback to index.html for Frontend Single Page Navigation ──
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(rootDir, 'index.html'));
  }
  next();
});

// ── Global Error Handler ──
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  // Server faults (e.g. a failed SQL statement) are logged but never echoed to the client.
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : (err.message || 'Request failed.') });
});

// ──────────────────────────────────────────────────────────────────────────────
// P2-04: WebSocket Real-Time Signaling — Socket.io
// Broadcasts live events to hospital consoles and command center
// ──────────────────────────────────────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', FRONTEND_URL],
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// ── Socket Auth Middleware ──
// The same verification as REST (HS256 only, issuer, audience, expiry: verifyToken), and the account is loaded from
// the store: identity and scope come from the account row, not from the token's claims.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
  if (!token) {
    return next(new Error('Authentication required for operational events.'));
  }
  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    return next(new Error('Invalid or expired socket token.'));
  }
  let resolved;
  try {
    resolved = await resolveAccount(claims);
  } catch (err) {
    console.error('[WS] Could not load the account at handshake:', err.message);
    return next(new Error('Could not verify the account. Please retry.'));
  }
  if (!resolved.user) return next(new Error(resolved.reason === 'revoked' ? REVOKED_TOKEN : 'Invalid or expired socket token.'));
  socket.user = resolved.user;
  next();
});

// Live sockets re-check their account (deactivation, role / hospital / ambulance changes) every SOCKET_RECHECK_MS.
startSocketAccountRecheck(io, socketRecheckMs);
// An account changed through the admin API: re-check its live sockets now (a revoked session is cut at once).
accountEvents.on('changed', userId => {
  for (const socket of io.of('/').sockets.values()) {
    if (socket.user?.user_id === userId) refreshSocketAccount(socket);
  }
});

// Per-socket throttle for client requests (X6): at most SOCKET_EVENT_LIMIT events per SOCKET_EVENT_WINDOW_MS; the
// rest are dropped. The UI sends two requests per (re)connect.
const SOCKET_EVENT_LIMIT = Number.parseInt(process.env.SOCKET_EVENT_LIMIT || '20', 10);
const SOCKET_EVENT_WINDOW_MS = Number.parseInt(process.env.SOCKET_EVENT_WINDOW_MS || '10000', 10);
const MAX_TIMER_MS = 2_147_483_647;

/** Disconnect the socket when its token expires (a session never outlives its token). */
function disconnectAtExpiry(socket) {
  const expiresMs = socket.user.exp * 1000;
  const timer = setTimeout(() => {
    if (Date.now() >= expiresMs) {
      console.log(`[WS] Token expired; disconnecting ${socket.id}`);
      socket.disconnect(true);
    } else {
      disconnectAtExpiry(socket); // a lifetime longer than one timer period
    }
  }, Math.min(Math.max(expiresMs - Date.now(), 0), MAX_TIMER_MS));
  timer.unref?.();
  socket.data.expiryTimer = timer;
}

// ── Connection Handler ──
io.on('connection', async (socket) => {
  console.log(`[WS] Client connected: ${socket.id} (Role: ${socket.user?.role || 'GUEST'})`);
  disconnectAtExpiry(socket);

  // Rooms follow the REST scoping (server/services/accessPolicy.js): user:<id> for everyone, hospital:<id> for a
  // desk, command_center (the audit trail and every referral in the network) for admins only.
  for (const room of socketRooms(socket.user)) socket.join(room);

  socket.data.window = { start: Date.now(), count: 0 };
  socket.use((packet, next) => {
    const window = socket.data.window;
    const now = Date.now();
    if (now - window.start >= SOCKET_EVENT_WINDOW_MS) {
      window.start = now;
      window.count = 0;
    }
    window.count += 1;
    if (window.count <= SOCKET_EVENT_LIMIT) return next();
    if (window.count === SOCKET_EVENT_LIMIT + 1) console.warn(`[WS] ${socket.id} exceeded ${SOCKET_EVENT_LIMIT} events per ${SOCKET_EVENT_WINDOW_MS} ms; dropping`);
    // Not calling next() drops the event.
  });

  // Client requests latest KPIs (staff only: a patient socket gets nothing but its own case updates)
  socket.on('request:kpis', async () => {
    if (!isStaff(socket.user)) return;
    try {
      socket.emit('kpis:update', await store.getKpis());
    } catch (err) {
      console.error('[WS] Could not build KPIs:', err.message);
    }
  });

  // Client requests active locks (the same policy as GET /referrals/active: admins all, desks their own, nobody else)
  socket.on('request:active_locks', async () => {
    // socket.user is re-read on each request: the periodic re-check may have changed the role.
    if (!isStaff(socket.user)) return;
    try {
      const locks = visibleLocks(socket.user, await store.getActiveLocks());
      if (locks) socket.emit('locks:update', locks);
    } catch (err) {
      console.error('[WS] Could not list locks:', err.message);
    }
  });

  socket.on('disconnect', () => {
    clearTimeout(socket.data.expiryTimer);
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });

  // Last, so every handler above is already registered while the (async) snapshot is built.
  // Send initial state snapshot (staff only)
  if (!isStaff(socket.user)) return;
  try {
    socket.emit('system:snapshot', await store.getSnapshotCounts());
  } catch (err) {
    console.error('[WS] Could not build snapshot:', err.message);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// P2-04 + P2-08: Bridge Locking Engine Events to WebSocket Broadcasts
// Real-time: lock acquired/expired/committed/rejected -> broadcast to consoles
// ──────────────────────────────────────────────────────────────────────────────
// referral:status — the per-user outcome of a referral, to the user who initiated it (and inherited by its
// failovers), on room user:<initiated_by> (B1-R1; e2e/SERVER_REQUIREMENTS.md §3). No patient fields: the client
// fetches the case with its own token. Events for one engine event are sent in order (the failover PENDING last).
async function notifyInitiator(updates) {
  for (const update of updates) {
    try {
      const acceptance = await store.getAcceptance(update.acceptance_id);
      const initiatedBy = acceptance?.initiated_by;
      if (!initiatedBy) continue;
      // Only to a CURRENT staff account: a paramedic since turned into a PATIENT (or deactivated) gets nothing.
      const recipient = await store.getUser(initiatedBy);
      if (!accountUsable(recipient) || !isStaff(recipient)) continue;
      io.to(userRoom(initiatedBy)).emit('referral:status', {
        acceptance_id: update.acceptance_id,
        request_id: update.request_id ?? acceptance.request_id,
        hospital_id: update.hospital_id ?? acceptance.hospital_id,
        status: update.status,
        next_acceptance_id: update.next_acceptance_id ?? null,
        next_hospital_id: update.next_hospital_id ?? null,
        ambulance_id: update.ambulance_id ?? null,
        at: new Date().toISOString()
      });
    } catch (err) {
      console.error('[WS] Could not send referral:status:', err.message);
    }
  }
}

/** The ended referral's status, then the failover referral (PENDING) if the server placed one. */
function endedWithFailover({ acceptanceId, requestId, hospitalId, status, nextAcceptanceId, nextHospitalId }) {
  const updates = [{
    acceptance_id: acceptanceId, request_id: requestId, hospital_id: hospitalId, status,
    next_acceptance_id: nextAcceptanceId ?? null, next_hospital_id: nextHospitalId ?? null
  }];
  if (nextAcceptanceId) {
    updates.push({ acceptance_id: nextAcceptanceId, request_id: requestId, hospital_id: nextHospitalId ?? null, status: 'PENDING' });
  }
  return notifyInitiator(updates);
}

/** A hospital-room copy of an ended referral without its failover (another hospital's referral). */
function withoutFailover(data) {
  const { next_acceptance_id: _a, next_hospital_id: _b, nextAcceptanceId: _c, nextHospitalId: _d, ...rest } = data;
  return rest;
}

const remainingSecOf = lock => (Number.isFinite(lock.expiresAt)
  ? Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000))
  : (lock.remainingSec ?? 90));

lockingEngine.on('lock_acquired', (lockData) => {
  console.log(`[LOCK] Soft-lock ACQUIRED: ${lockData.acceptanceId} -> ${lockData.hospitalId}`);

  // Broadcast to the specific hospital's room, with the lock's real remaining time.
  const remaining = remainingSecOf(lockData);
  io.to(hospitalRoom(lockData.hospitalId)).emit('referral:incoming', {
    type: 'INCOMING_REFERRAL',
    acceptance_id: lockData.acceptanceId,
    request_id:    lockData.requestId,
    hospital_id:   lockData.hospitalId,
    remaining_sec: remaining,
    message: `Incoming emergency referral — ${remaining}-second response window.`
  });

  // Broadcast to command center
  io.to(COMMAND_CENTER).emit('lock:acquired', lockData);
  broadcastKPIs();
});

lockingEngine.on('lock_tick', (lockData) => {
  io.to(hospitalRoom(lockData.hospitalId)).emit('referral:countdown', {
    acceptance_id: lockData.acceptanceId,
    remaining_sec: lockData.remainingSec
  });
});

lockingEngine.on('allocation_committed', async (data) => {
  console.log(`[LOCK] Allocation COMMITTED: ${data.acceptanceId}`);
  io.to(hospitalRoom(data.hospitalId)).emit('referral:accepted', data);
  io.to(COMMAND_CENTER).emit('allocation:committed', data);
  broadcastKPIs();
  notifyInitiator([{
    acceptance_id: data.acceptanceId, request_id: data.requestId, hospital_id: data.hospitalId,
    status: 'ACCEPTED', ambulance_id: data.ambulance_id ?? null
  }]);
  // Batch 8 (P-0.3): the dispatched unit starts moving at once (simulated transport; off in production by default).
  if (trackingConfig.simulatedTransport && data.ambulance_id) {
    startSimulatedTransport(tracking, store, { requestId: data.requestId, ambulanceId: data.ambulance_id });
  }

  // Create and broadcast alert
  try {
    const alert = await store.createAlert({
      hospital_id: data.hospitalId,
      request_id:  data.requestId,
      alert_type:  'INCOMING_REFERRAL',
      message:     `Referral ${data.requestId} ACCEPTED — resources locked and ambulance dispatch initiated.`
    });
    io.to(hospitalRoom(data.hospitalId)).emit('alert:new', alert);
  } catch (err) {
    console.error('[ALERT] Could not record alert:', err.message);
  }
});

lockingEngine.on('lock_released', (data) => {
  console.log(`[LOCK] Lock REJECTED/RELEASED: ${data.acceptanceId}`);
  // The hospital that declined is not told where the case went next (round 2 item 9); admins and the initiator are.
  io.to(hospitalRoom(data.hospitalId)).emit('referral:rejected', withoutFailover(data));
  io.to(COMMAND_CENTER).emit('lock:released', data);
  broadcastKPIs();
  // REJECTED (with its failover, if any) or CANCELLED (the case was cancelled/completed while pending).
  endedWithFailover({
    acceptanceId: data.acceptanceId, requestId: data.requestId, hospitalId: data.hospitalId,
    status: data.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED',
    nextAcceptanceId: data.next_acceptance_id, nextHospitalId: data.next_hospital_id
  });
});

lockingEngine.on('lock_expired', (data) => {
  console.log(`[LOCK] Lock EXPIRED (90s TTL): ${data.acceptanceId} — Auto-failover triggered`);
  io.to(hospitalRoom(data.hospitalId)).emit('referral:expired', {
    ...withoutFailover(data),
    message: 'Referral response window expired (90s). Automatically rerouting to next candidate hospital.'
  });
  io.to(COMMAND_CENTER).emit('lock:expired', data);
  broadcastKPIs();
  endedWithFailover({
    acceptanceId: data.acceptanceId, requestId: data.requestId, hospitalId: data.hospitalId, status: 'EXPIRED',
    nextAcceptanceId: data.nextAcceptanceId, nextHospitalId: data.nextHospitalId
  });
});

// Audit trail events
// A case's audit entries go to the command centre (ADMIN + DISPATCHER: they read every case's trail anyway); entries
// without a case (accounts, hospital status, rosters, capacity) go to ADMIN only, like GET /analytics/audit.
store.on('audit', (entry) => {
  io.to(entry.request_id ? COMMAND_CENTER : ADMIN_ROOM).emit('audit:entry', entry);
  if (entry.request_id && PATIENT_UPDATE_EVENTS.has(entry.event_type)) schedulePatientUpdate(entry.request_id);
  if (entry.request_id) sendCaseStatus(entry);
});

// ── case:status (Batch 8): every case status change, by anyone, to the command centre, the hospital holding the case
// and the unit still serving it (server/services/caseEvents.js; rooms: accessPolicy.caseStatusRooms). Sent per case in
// the order the changes were recorded (one queue per case).
const caseStatusQueues = new Map();
function sendCaseStatus(entry) {
  const previous = caseStatusQueues.get(entry.request_id) ?? Promise.resolve();
  const next = previous.then(async () => {
    const event = await caseStatusEvent(store, entry);
    if (event) io.to(event.rooms).emit(CASE_STATUS_EVENT, event.payload);
  }).catch(err => console.error('[WS] case:status failed:', err.message));
  caseStatusQueues.set(entry.request_id, next);
  next.then(() => { if (caseStatusQueues.get(entry.request_id) === next) caseStatusQueues.delete(entry.request_id); });
}

// ── patient:case_update (Batch 6): the redacted state of a patient's own case, to that patient's accounts only ──
// Sent on status changes, referral acceptance / allocation, dispatch and completion; coalesced per case (one update for
// the several audit rows one operation writes), always built from the case's current state.
const PATIENT_UPDATE_EVENTS = new Set([
  'STATUS_CHANGED', 'ALLOCATION_COMMITTED', 'AMBULANCE_STATUS_CHANGED', 'LOCK_ACQUIRED', 'LOCK_REJECTED',
  'LOCK_TTL_EXPIRED_FAILOVER', 'LOCK_CANCELLED', 'STAGE_ADVANCED'
]);
const pendingPatientUpdates = new Map();
function schedulePatientUpdate(requestId) {
  if (pendingPatientUpdates.has(requestId)) return;
  const timer = setTimeout(() => {
    pendingPatientUpdates.delete(requestId);
    sendPatientUpdate(requestId).catch(err => console.error('[WS] patient:case_update failed:', err.message));
  }, 50);
  timer.unref?.();
  pendingPatientUpdates.set(requestId, timer);
}
async function sendPatientUpdate(requestId) {
  const request = await store.getRequest(requestId);
  if (!request?.patient_id) return;
  const accounts = await store.listPatientAccountIds(request.patient_id);
  if (!accounts.length) return;
  const view = await loadPatientCase(store, requestId, { kind: 'patient', patientId: request.patient_id }, { timeline: false });
  if (!view) return;
  const payload = patientCaseUpdate(view);
  for (const userId of accounts) io.to(userRoom(userId)).emit('patient:case_update', payload);
}

// P2-08: stale-lock cleanup. The in-memory store runs a belt-and-suspenders sweeper and announces
// what it cleaned; the MySQL store expires locks from their persisted expiry (engine 'lock_expired').
store.on('lock_cleanup', (acceptance) => {
  io.to(COMMAND_CENTER).emit('lock:expired_cleanup', acceptance);
});

// ── tracking:update (Batch 7): each persisted step or phase change of a simulated trip, one per trip per tick ──
// Staff: the command centre (ADMIN, DISPATCHER), the paramedic crewing the unit (ambulance:<id>) and the destination
// hospital's desk (hospital:<id>); one emit to the union of the rooms, so nobody gets it twice. Patients: the redacted
// patient:tracking, to the accounts of the case's patient only. Nobody else.
tracking.on('update', ({ trip, update, patient }) => {
  io.to([COMMAND_CENTER, ambulanceRoom(trip.ambulance_id), hospitalRoom(trip.hospital_id)]).emit('tracking:update', update);
  if (patient?.accountIds.length) io.to(patient.accountIds.map(userRoom)).emit('patient:tracking', patient.payload);
});
tracking.start();

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
async function broadcastKPIs() {
  if (io.engine.clientsCount === 0) return; // nobody is listening: skip the work (and the DB query)
  try {
    io.to(STAFF_ROOM).emit('kpis:update', await store.getKpis()); // aggregate counts: every staff socket, never a patient
  } catch (err) {
    console.error('[KPI] Broadcast failed:', err.message);
  }
}

// Broadcast KPIs every 10 seconds for live dashboard
setInterval(broadcastKPIs, 10_000);

// ──────────────────────────────────────────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║  Smart Emergency Resource Allocation System — Phase 2 Backend   ║
  ║  REST API:  http://localhost:${PORT}                                 ║
  ║  WebSocket: ws://localhost:${PORT}  (Socket.io)                     ║
  ║  Health:    http://localhost:${PORT}/health                          ║
  ╚══════════════════════════════════════════════════════════════════╝
  `);
});

// ── Graceful shutdown: stop accepting work, then release the database pool ──
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received; closing server and storage.`);
  const forceExit = setTimeout(() => process.exit(1), 8000);
  forceExit.unref();
  try {
    tracking.stop();
    io.close();
    await new Promise(resolve => httpServer.close(resolve));
    await storage.store.close();
    process.exit(0);
  } catch (err) {
    console.error('[SHUTDOWN] Error while closing:', err.message);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, io };
