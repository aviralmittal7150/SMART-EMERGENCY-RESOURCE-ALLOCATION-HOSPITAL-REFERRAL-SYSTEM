// server/routes/admin.js
// Account management API — /api/v1/admin/users (Batch 6). ADMIN only.
//
//   GET    /users?role=&active=true|false&limit=1..200&offset=0..   list (never a password hash)
//   POST   /users                    create { username, display_name?, role, password, hospital_id?, ambulance_id?, patient_id? }
//   PATCH  /users/:userId            update { display_name?, role?, hospital_id?, ambulance_id?, patient_id?, is_active? }
//   POST   /users/:userId/reset-password   { password }
//   GET    /patients?q=&limit=1..200&offset=   patients to link accounts to { patient_id, full_name, age, gender } only
//
// A password reset, a deactivation and a role or link change raise the account's token_version: every existing token
// (REST and socket) is refused from then on, and the account's live sockets are disconnected at once.
// Rules: every link (hospital, ambulance, patient) must exist; the role/link shape is checked by accountShapeProblem
// (server/services/accounts.js); an admin cannot change their own role or deactivate themselves; the last active
// non-demo ADMIN cannot be demoted or deactivated (checked inside the store's write, under lock on MySQL); every change
// writes an audit row with the admin as actor and never a password. Changes apply at once: every request reloads its
// account, and live sockets are re-checked every SOCKET_RECHECK_MS.

import express from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { respondStoreError } from '../db/storeErrors.js';
import { validateBody, validateQuery, ID20 } from '../services/validation.js';
import { ROLES, ASSIGNABLE_ROLES, accountShapeProblem } from '../services/accounts.js';
import { BCRYPT_COST } from '../services/passwords.js';
import { announceAccountChange } from '../services/accountEvents.js';

const router = express.Router();
router.use(authenticate, authorize('ADMIN'));

export const MIN_PASSWORD_LENGTH = 10;
const PREFIX = { ADMIN: 'ADM', DISPATCHER: 'DSP', HOSPITAL_DESK: 'HSP', PARAMEDIC: 'EMS', PATIENT: 'PAT' };
const actorOf = req => ({ role: req.user.role, id: req.user.user_id });

const PASSWORD = { type: 'string', required: true, trim: false, maxLength: 200 };
const LINK = { ...ID20, nullable: true, emptyAs: null };
const USERNAME = { type: 'string', required: true, maxLength: 80, pattern: /^[A-Za-z0-9_.@-]{3,80}$/,
  patternMessage: 'username must be 3-80 characters: letters, digits, "_", ".", "@", "-".' };

function passwordProblem(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (Buffer.byteLength(password, 'utf8') > 72) return 'password must be at most 72 bytes (a bcrypt limit).';
  return null;
}

/** Every link the account carries must exist. Returns a message or null. */
async function linkProblem({ hospital_id: hospitalId, ambulance_id: ambulanceId, patient_id: patientId }) {
  if (hospitalId && !(await store.getHospital(hospitalId))) return `hospital_id ${hospitalId} does not exist.`;
  if (ambulanceId && !(await store.getAmbulance(ambulanceId))) return `ambulance_id ${ambulanceId} does not exist.`;
  if (patientId && !(await store.getPatient(patientId))) return `patient_id ${patientId} does not exist.`;
  return null;
}

const badRequest = (res, message) => res.status(400).json({ error: message });

// GET /api/v1/admin/users
router.get('/users',
  validateQuery({
    role: { type: 'enum', values: ROLES, upper: true },
    active: { type: 'enum', values: ['TRUE', 'FALSE'], upper: true },
    limit: { type: 'integer', min: 1, max: 200, default: 50 },
    offset: { type: 'integer', min: 0, max: 1_000_000, default: 0 }
  }),
  async (req, res) => {
    const { role, active, limit, offset } = req.validQuery;
    const result = await store.listUsers({ role, active: active === undefined ? undefined : active === 'TRUE', limit, offset });
    res.json({ success: true, total: result.total, limit, offset, users: result.users });
  });

// POST /api/v1/admin/users
router.post('/users',
  validateBody({
    username: USERNAME,
    display_name: { type: 'string', maxLength: 150, nullable: true, emptyAs: null },
    role: { type: 'enum', required: true, values: ASSIGNABLE_ROLES, upper: true },
    password: PASSWORD,
    hospital_id: LINK, ambulance_id: LINK, patient_id: LINK
  }),
  async (req, res) => {
    const v = req.valid;
    const pw = passwordProblem(v.password);
    if (pw) return badRequest(res, pw);
    const row = {
      user_id: `USER-${PREFIX[v.role]}-${randomBytes(4).toString('hex').toUpperCase()}`,
      username: v.username, display_name: v.display_name ?? v.username, role: v.role,
      hospital_id: v.hospital_id ?? null, ambulance_id: v.ambulance_id ?? null, patient_id: v.patient_id ?? null
    };
    const shape = accountShapeProblem(row);
    if (shape) return badRequest(res, shape);
    const link = await linkProblem(row);
    if (link) return badRequest(res, link);
    row.password_hash = await bcrypt.hash(v.password, BCRYPT_COST);
    try {
      const user = await store.createUser(row, actorOf(req));
      res.status(201).json({ success: true, user });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  });

/**
 * The guard evaluated by the store at write time: no self-demotion or self-deactivation, and never leave the system
 * without an active non-demo ADMIN.
 */
const accountChangeGuard = actorId => (before, after, activeRealAdmins) => {
  const removesAdmin = before.role === 'ADMIN' && Number(before.is_active) === 1 && Number(before.is_demo) !== 1
    && (after.role !== 'ADMIN' || Number(after.is_active) !== 1);
  if (before.user_id === actorId && (after.role !== before.role || Number(after.is_active) !== 1)) {
    return { status: 409, message: 'You cannot change your own role or deactivate your own account.' };
  }
  if (removesAdmin && activeRealAdmins <= 1) {
    return { status: 409, message: 'This is the last active (non-demo) ADMIN account; create another admin first.' };
  }
  return null;
};

// PATCH /api/v1/admin/users/:userId
router.patch('/users/:userId',
  validateBody({
    display_name: { type: 'string', maxLength: 150 },
    role: { type: 'enum', values: ASSIGNABLE_ROLES, upper: true }, // DISPATCHER / PATIENT: retired, 400
    hospital_id: LINK, ambulance_id: LINK, patient_id: LINK,
    is_active: { type: 'boolean' }
  }, { atLeastOne: ['display_name', 'role', 'hospital_id', 'ambulance_id', 'patient_id', 'is_active'] }),
  async (req, res) => {
    const current = await store.getAccount(req.params.userId);
    if (!current) return res.status(404).json({ error: 'User not found.' });
    const changes = {};
    for (const field of ['display_name', 'role', 'hospital_id', 'ambulance_id', 'patient_id']) {
      if (req.valid[field] !== undefined) changes[field] = req.valid[field];
    }
    if (req.valid.is_active !== undefined) changes.is_active = req.valid.is_active ? 1 : 0;
    const shape = accountShapeProblem({ ...current, ...changes });
    if (shape) return badRequest(res, shape);
    const link = await linkProblem(changes);
    if (link) return badRequest(res, link);
    // Deactivation and role / link changes end every existing session of the account (token_version). The store decides
    // that against the row it writes (locked on MySQL), not against `current` above, which may be stale by then.
    try {
      const user = await store.updateUser(current.user_id, changes, actorOf(req), accountChangeGuard(req.user.user_id));
      if (!user) return res.status(404).json({ error: 'User not found.' });
      announceAccountChange(user.user_id); // live sockets are re-checked now, not only at the next periodic check
      res.json({ success: true, user });
    } catch (err) {
      if (!respondStoreError(res, err)) throw err;
    }
  });

// GET /api/v1/admin/patients?q=&limit=1..200&offset=   (account linking: id, name, age, gender only)
router.get('/patients',
  validateQuery({
    q: { type: 'string', maxLength: 150 },
    limit: { type: 'integer', min: 1, max: 200, default: 50 },
    offset: { type: 'integer', min: 0, max: 1_000_000, default: 0 }
  }),
  async (req, res) => {
    const { q, limit, offset } = req.validQuery;
    const result = await store.listPatients({ q: q || undefined, limit, offset });
    res.json({ success: true, total: result.total, limit, offset, patients: result.patients });
  });

// POST /api/v1/admin/users/:userId/reset-password
router.post('/users/:userId/reset-password', validateBody({ password: PASSWORD }), async (req, res) => {
  const pw = passwordProblem(req.valid.password);
  if (pw) return badRequest(res, pw);
  const hash = await bcrypt.hash(req.valid.password, BCRYPT_COST);
  const user = await store.setUserPassword(req.params.userId, hash, actorOf(req)); // also ends every existing session
  if (!user) return res.status(404).json({ error: 'User not found.' });
  announceAccountChange(user.user_id);
  res.json({ success: true, user_id: user.user_id });
});

export default router;
