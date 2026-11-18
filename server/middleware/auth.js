// server/middleware/auth.js
// JWT Role-Based Authentication (RBAC) Middleware
// Roles: ADMIN | DISPATCHER | HOSPITAL_DESK | PARAMEDIC | PATIENT (server/services/accounts.js)
//
// Tokens (review finding X9): HS256 only (the algorithm is pinned on sign AND verify, so `alg: none` or an algorithm
// confusion is refused), with an issuer and audience that are both checked, and a lifetime taken from JWT_EXPIRES
// everywhere (the login response reports the same value). REST and Socket.IO verify through verifyToken().

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { store } from '../db/store.js';
import { patientMayCall } from '../services/accessPolicy.js';

import { ROLES, accountUsable } from '../services/accounts.js';

export { ROLES, accountUsable };
export const JWT_ALGORITHM = 'HS256';
export const MIN_JWT_SECRET_LENGTH = 32;
/** The value shipped in .env.example. A server in production refuses it. */
export const JWT_SECRET_PLACEHOLDER = 'replace-with-a-long-random-string';
const DEFAULT_EXPIRES = '8h';

// No hardcoded fallback: a publicly known signing key would let anyone forge ADMIN tokens.
// Outside production an ephemeral per-process secret is used when none is set (tokens reset on restart).
let ephemeralSecret = null;

export function getJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  const production = env.NODE_ENV === 'production';
  if (secret) {
    if (production && secret === JWT_SECRET_PLACEHOLDER) {
      throw new Error('JWT_SECRET is still the .env.example placeholder. Set a long random value when NODE_ENV=production.');
    }
    if (production && secret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters when NODE_ENV=production.`);
    }
    return secret;
  }
  if (production) {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production.');
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex');
    console.warn('[AUTH] JWT_SECRET not set — using an ephemeral development secret.');
  }
  return ephemeralSecret;
}

/** JWT_EXPIRES as jsonwebtoken expects it: a bare number is SECONDS (jsonwebtoken would read "3600" as milliseconds). */
export function getJwtExpires(env = process.env) {
  const raw = String(env.JWT_EXPIRES ?? '').trim() || DEFAULT_EXPIRES;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export const jwtIssuer = (env = process.env) => (env.JWT_ISSUER || '').trim() || 'eris-api';
export const jwtAudience = (env = process.env) => (env.JWT_AUDIENCE || '').trim() || 'eris-console';

/**
 * Validate the token configuration once at start-up (the server refuses to start on an error): the secret rules
 * above, and a JWT_EXPIRES that jsonwebtoken accepts and that is a positive lifetime.
 */
export function assertAuthConfig(env = process.env) {
  const secret = getJwtSecret(env);
  const expiresIn = getJwtExpires(env);
  let probe;
  try {
    probe = jwt.decode(jwt.sign({}, secret, { algorithm: JWT_ALGORITHM, expiresIn }));
  } catch (err) {
    throw new Error(`JWT_EXPIRES is invalid (${err.message}). Use seconds (e.g. 28800) or a span such as "8h".`);
  }
  if (!(probe.exp > probe.iat)) throw new Error('JWT_EXPIRES must be a positive lifetime.');
}

/** The identity carried in a token (and returned by /auth/login and /auth/me). */
export function publicUser(user) {
  return {
    user_id: user.user_id,
    username: user.username,
    role: user.role,
    hospital_id: user.hospital_id ?? null,
    ambulance_id: user.ambulance_id ?? null,
    patient_id: user.patient_id ?? null,
    display_name: user.display_name ?? user.username
  };
}

/**
 * Generate a signed JWT for a verified user. `tv` is the account's token_version at issue time: a password reset,
 * deactivation or role / link change raises the version and every older token is refused (Batch 6 round 2).
 */
export function generateToken(user) {
  const payload = { ...publicUser(user), tv: Number(user.token_version ?? 0) };
  return jwt.sign(payload, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: getJwtExpires(),
    issuer: jwtIssuer(),
    audience: jwtAudience(),
    subject: String(payload.user_id)
  });
}

/**
 * Verify a token exactly one way for REST and sockets: HS256 only, issuer, audience and expiry checked, and the
 * claims must describe a user this server can scope (a known role, a user id, an expiry). Throws on any failure.
 */
export function verifyToken(token) {
  const claims = jwt.verify(token, getJwtSecret(), {
    algorithms: [JWT_ALGORITHM],
    issuer: jwtIssuer(),
    audience: jwtAudience()
  });
  if (typeof claims !== 'object' || claims === null || typeof claims.user_id !== 'string' || !ROLES.includes(claims.role)
    || typeof claims.exp !== 'number') {
    throw new Error('Token claims are incomplete.');
  }
  if (claims.role === 'HOSPITAL_DESK' && typeof claims.hospital_id !== 'string') throw new Error('Desk token without a hospital.');
  if (claims.role === 'PATIENT' && typeof claims.patient_id !== 'string') throw new Error('Patient token without a patient.');
  if (claims.tv !== undefined && !Number.isSafeInteger(claims.tv)) throw new Error('Token version is malformed.');
  return claims;
}

/**
 * The caller as the store has it NOW (round 2, item 5): the account is loaded by its primary key on every request and
 * socket handshake, so deactivation and role / hospital / ambulance changes apply at once instead of at token expiry.
 * Returns the verified claims with the account's current identity, or null when the account cannot be used.
 */
export async function loadAccount(claims) {
  return (await resolveAccount(claims)).user ?? null;
}

/**
 * { user } when the token's account can be used now, else { reason: 'unusable' | 'revoked' }.
 * 'unusable' = no such account (generic message: a forged or stale id learns nothing about which accounts exist).
 * 'revoked'  = a correctly signed token whose account EXISTS but was changed: deactivated or otherwise unusable, or the
 *              token was issued under an older token_version (password reset, deactivation, role or link change).
 * Only called after verifyToken, so only a token signed by this server can ever get the specific message.
 */
export async function resolveAccount(claims) {
  const user = await store.getUser(claims.user_id);
  if (!user) return { reason: 'unusable' };
  if (!accountUsable(user)) return { reason: 'revoked' };
  if (Number(claims.tv ?? 0) !== Number(user.token_version ?? 0)) return { reason: 'revoked' };
  return { user: { ...claims, ...publicUser(user) } };
}

const INVALID_TOKEN = 'Token invalid or expired. Please re-authenticate.';
export const REVOKED_TOKEN = 'Your session was ended by an account change. Please sign in again.';

/** Verify the token, load the account, and attach the current user to req.user. */
export async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
  }

  let claims;
  try {
    claims = verifyToken(authHeader.slice(7));
  } catch {
    return res.status(401).json({ error: INVALID_TOKEN });
  }
  const { user, reason } = await resolveAccount(claims); // a store failure propagates as a 500, never as a pass
  if (!user) return res.status(401).json({ error: reason === 'revoked' ? REVOKED_TOKEN : INVALID_TOKEN });
  // Batch 6: a PATIENT may use only /auth/me and the read-only /patient/* API (server/services/accessPolicy.js).
  if (user.role === 'PATIENT' && !patientMayCall(req.method, req.originalUrl)) {
    return res.status(403).json({ error: 'Access denied for a patient account.' });
  }
  req.user = user;
  next();
}

/**
 * Restrict endpoint access to specific roles
 * @param {...string} roles - Allowed roles
 */
export function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}. Your role: ${req.user.role}`
      });
    }
    next();
  };
}

/**
 * RBAC capability map — which actions each role can perform
 */
export const ROLE_CAPABILITIES = {
  ADMIN: [
    'VIEW_ALL_HOSPITALS', 'VIEW_ALL_EMERGENCIES', 'VIEW_ALL_AMBULANCES',
    'MANAGE_RESOURCES', 'VIEW_ANALYTICS', 'VIEW_AUDIT_LEDGER',
    'BANKERS_SIMULATOR', 'SWITCH_HOSPITAL_STATUS', 'MANAGE_DOCTORS'
  ],
  HOSPITAL_DESK: [
    'VIEW_ASSIGNED_HOSPITAL', 'ACCEPT_REFERRAL', 'REJECT_REFERRAL',
    'UPDATE_RESOURCE_COUNTS', 'MANAGE_DOCTORS', 'VIEW_ALERTS'
  ],
  DISPATCHER: [
    'CREATE_EMERGENCY_REQUEST', 'VIEW_ALL_EMERGENCIES', 'INITIATE_REFERRAL', 'VIEW_ALL_HOSPITALS',
    'VIEW_ALL_AMBULANCES', 'DISPATCH_ANY_AMBULANCE', 'VIEW_DASHBOARD'
  ],
  PARAMEDIC: [
    'CREATE_EMERGENCY_REQUEST', 'VIEW_RANKED_HOSPITALS', 'VIEW_OWN_AMBULANCE',
    'UPDATE_OWN_AMBULANCE_STATUS'
  ],
  PATIENT: ['VIEW_OWN_CASES']
};
