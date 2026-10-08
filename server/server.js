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

// Route Modules
import authRoutes       from './routes/auth.js';
import hospitalsRoutes  from './routes/hospitals.js';
import emergenciesRoutes from './routes/emergencies.js';
import referralsRoutes  from './routes/referrals.js';
import doctorsRoutes    from './routes/doctors.js';
import ambulancesRoutes from './routes/ambulances.js';
import analyticsRoutes  from './routes/analytics.js';

// Services
import { lockingEngine } from './services/lockingEngine.js';
import { authenticate }  from './middleware/auth.js';
import { db }            from './db/seed.js';

dotenv.config();

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
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Smart Emergency Resource Allocation API',
    version: '2.0.0',
    uptime_sec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ── 404 Handler ──
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.path}` });
});

// ── Global Error Handler ──
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
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
    // Allow unauthenticated connections for frontend demo (read-only events)
    socket.user = { role: 'GUEST', user_id: `GUEST-${socket.id.slice(0, 6)}` };
    return next();
  }
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET || 'emergency-system-secret-key-2026');
    next();
  } catch {
    socket.user = { role: 'GUEST', user_id: `GUEST-${socket.id.slice(0, 6)}` };
    next();
  }
});

// ── Connection Handler ──
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id} (Role: ${socket.user?.role || 'GUEST'})`);

  // Join hospital-specific room (for targeted alerts)
  const hospitalId = socket.user?.hospital_id;
  if (hospitalId) {
    socket.join(`hospital:${hospitalId}`);
    console.log(`[WS] ${socket.id} joined room hospital:${hospitalId}`);
  }
  socket.join('command_center'); // All connections get command center updates

  // Send initial state snapshot
  socket.emit('system:snapshot', {
    hospitals:  db.hospitals.length,
    ambulances: db.ambulances.filter(a => a.status === 'AVAILABLE').length,
    emergencies: db.emergencyRequests.filter(r => !['COMPLETED','CANCELLED'].includes(r.status)).length,
    active_locks: lockingEngine.getActiveLocks().length,
    server_time: new Date().toISOString()
  });

  // Client requests latest KPIs
  socket.on('request:kpis', () => {
    const kpis = buildKPIs();
    socket.emit('kpis:update', kpis);
  });

  // Client requests active locks
  socket.on('request:active_locks', () => {
    socket.emit('locks:update', lockingEngine.getActiveLocks());
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
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

lockingEngine.on('allocation_committed', (data) => {
  console.log(`[LOCK] Allocation COMMITTED: ${data.acceptanceId}`);
  io.to(`hospital:${data.hospitalId}`).emit('referral:accepted', data);
  io.to('command_center').emit('allocation:committed', data);
  broadcastKPIs();

  // Create and broadcast alert
  const alert = {
    alert_id:   db.alerts.length + 1,
    hospital_id: data.hospitalId,
    request_id:  data.requestId,
    alert_type:  'INCOMING_REFERRAL',
    message:     `Referral ${data.requestId} ACCEPTED — resources locked and ambulance dispatch initiated.`,
    status:      'UNREAD',
    created_at:  new Date().toISOString()
  };
  db.alerts.push(alert);
  io.to(`hospital:${data.hospitalId}`).emit('alert:new', alert);
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
db.on('audit', (entry) => {
  io.to('command_center').emit('audit:entry', entry);
});

// ──────────────────────────────────────────────────────────────────────────────
// P2-08: TTL Expiry Background Worker — polls every 30s for zombie locks
// (Belt-and-suspenders: locking engine handles TTL internally,
//  this worker catches any edge-case stragglers)
// ──────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  const staleAcceptances = db.hospitalAcceptances.filter(a => {
    if (a.status !== 'PENDING') return false;
    const expiresAt = new Date(a.lock_expires_at).getTime();
    return Date.now() > expiresAt + 5000; // 5s grace period
  });

  staleAcceptances.forEach(acc => {
    console.log(`[WORKER] Cleaning up stale soft-lock: ${acc.acceptance_id}`);
    acc.status = 'EXPIRED';
    db.auditLog({
      request_id: acc.request_id,
      hospital_id: acc.hospital_id,
      event_type: 'LOCK_EXPIRED_WORKER_CLEANUP',
      previous_state: 'PENDING',
      new_state: 'EXPIRED',
      actor_role: 'SYSTEM',
      metadata: { acceptance_id: acc.acceptance_id }
    });
    io.to('command_center').emit('lock:expired_cleanup', acc);
  });
}, 30_000);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function buildKPIs() {
  const icuBeds = db.medicalResources.filter(r => r.resource_type === 'ICU_BED');
  const vents   = db.medicalResources.filter(r => r.resource_type === 'VENTILATOR');

  return {
    active_emergencies:    db.emergencyRequests.filter(r => !['COMPLETED','CANCELLED'].includes(r.status)).length,
    critical_p1:           db.emergencyRequests.filter(r => r.priority === 1 && r.status === 'WAITING').length,
    icu_available:         icuBeds.reduce((s, r) => s + r.available_capacity, 0),
    ventilators_available: vents.reduce((s, r) => s + r.available_capacity, 0),
    hospitals_open:        db.hospitals.filter(h => h.emergency_status === 'OPEN').length,
    ambulances_available:  db.ambulances.filter(a => a.status === 'AVAILABLE').length,
    active_locks:          lockingEngine.getActiveLocks().length,
    timestamp:             new Date().toISOString()
  };
}

function broadcastKPIs() {
  io.to('command_center').emit('kpis:update', buildKPIs());
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

export { app, io };
