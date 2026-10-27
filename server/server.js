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
import jwt from 'jsonwebtoken';
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
import analyticsRoutes  from './routes/analytics.js';

// Services
import { authenticate, getJwtSecret } from './middleware/auth.js';
import { bootstrapStore } from './db/bootstrap.js';
import { store } from './db/store.js';

dotenv.config();

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

const PORT = parseInt(process.env.PORT || '4000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ──────────────────────────────────────────────────────────────────────────────
// Express App Setup
// ──────────────────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// ── Security Middleware ──
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for development ease
  crossOriginEmbedderPolicy: false
}));

// ── CORS ──
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', FRONTEND_URL],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
}));

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
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
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
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
  if (!token) {
    return next(new Error('Authentication required for operational events.'));
  }
  try {
    socket.user = jwt.verify(token, getJwtSecret());
    next();
  } catch {
    next(new Error('Invalid or expired socket token.'));
  }
});

// ── Connection Handler ──
io.on('connection', async (socket) => {
  console.log(`[WS] Client connected: ${socket.id} (Role: ${socket.user?.role || 'GUEST'})`);

  // Join hospital-specific room (for targeted alerts)
  const hospitalId = socket.user?.hospital_id;
  if (hospitalId) {
    socket.join(`hospital:${hospitalId}`);
    console.log(`[WS] ${socket.id} joined room hospital:${hospitalId}`);
  }
  // The command-center stream carries the audit trail (patient details) and every referral in the
  // network, so it follows the same scoping as the REST API: admins only. Desks get their own
  // hospital room above; everyone authenticated gets the aggregate KPIs.
  const role = socket.user?.role;
  if (role === 'ADMIN') socket.join('command_center');

  // Client requests latest KPIs
  socket.on('request:kpis', async () => {
    try {
      socket.emit('kpis:update', await store.getKpis());
    } catch (err) {
      console.error('[WS] Could not build KPIs:', err.message);
    }
  });

  // Client requests active locks (scoped like GET /referrals/active: admins all, desks their own, nobody else)
  socket.on('request:active_locks', async () => {
    if (role !== 'ADMIN' && role !== 'HOSPITAL_DESK') return;
    try {
      const locks = await store.getActiveLocks();
      socket.emit('locks:update', role === 'ADMIN' ? locks : locks.filter(lock => lock.hospitalId === hospitalId));
    } catch (err) {
      console.error('[WS] Could not list locks:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });

  // Last, so every handler above is already registered while the (async) snapshot is built.
  // Send initial state snapshot
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
lockingEngine.on('lock_acquired', (lockData) => {
  console.log(`[LOCK] Soft-lock ACQUIRED: ${lockData.acceptanceId} -> ${lockData.hospitalId}`);

  // Broadcast to the specific hospital's room
  io.to(`hospital:${lockData.hospitalId}`).emit('referral:incoming', {
    type: 'INCOMING_REFERRAL',
    acceptance_id: lockData.acceptanceId,
    request_id:    lockData.requestId,
    hospital_id:   lockData.hospitalId,
    remaining_sec: 90,
    message: `Incoming emergency referral — 90-second response window starting now!`
  });

  // Broadcast to command center
  io.to('command_center').emit('lock:acquired', lockData);
  broadcastKPIs();
});

lockingEngine.on('lock_tick', (lockData) => {
  io.to(`hospital:${lockData.hospitalId}`).emit('referral:countdown', {
    acceptance_id: lockData.acceptanceId,
    remaining_sec: lockData.remainingSec
  });
});

lockingEngine.on('allocation_committed', async (data) => {
  console.log(`[LOCK] Allocation COMMITTED: ${data.acceptanceId}`);
  io.to(`hospital:${data.hospitalId}`).emit('referral:accepted', data);
  io.to('command_center').emit('allocation:committed', data);
  broadcastKPIs();

  // Create and broadcast alert
  try {
    const alert = await store.createAlert({
      hospital_id: data.hospitalId,
      request_id:  data.requestId,
      alert_type:  'INCOMING_REFERRAL',
      message:     `Referral ${data.requestId} ACCEPTED — resources locked and ambulance dispatch initiated.`
    });
    io.to(`hospital:${data.hospitalId}`).emit('alert:new', alert);
  } catch (err) {
    console.error('[ALERT] Could not record alert:', err.message);
  }
});

lockingEngine.on('lock_released', (data) => {
  console.log(`[LOCK] Lock REJECTED/RELEASED: ${data.acceptanceId}`);
  io.to(`hospital:${data.hospitalId}`).emit('referral:rejected', data);
  io.to('command_center').emit('lock:released', data);
  broadcastKPIs();
});

lockingEngine.on('lock_expired', (data) => {
  console.log(`[LOCK] Lock EXPIRED (90s TTL): ${data.acceptanceId} — Auto-failover triggered`);
  io.to(`hospital:${data.hospitalId}`).emit('referral:expired', {
    ...data,
    message: 'Referral response window expired (90s). Automatically rerouting to next candidate hospital.'
  });
  io.to('command_center').emit('lock:expired', data);
  broadcastKPIs();
});

// Audit trail events
store.on('audit', (entry) => {
  io.to('command_center').emit('audit:entry', entry);
});

// P2-08: stale-lock cleanup. The in-memory store runs a belt-and-suspenders sweeper and announces
// what it cleaned; the MySQL store expires locks from their persisted expiry (engine 'lock_expired').
store.on('lock_cleanup', (acceptance) => {
  io.to('command_center').emit('lock:expired_cleanup', acceptance);
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
async function broadcastKPIs() {
  if (io.engine.clientsCount === 0) return; // nobody is listening: skip the work (and the DB query)
  try {
    io.emit('kpis:update', await store.getKpis()); // aggregate counts only: every authenticated client
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
