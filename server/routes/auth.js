// server/routes/auth.js
// Authentication API — POST /api/v1/auth/login, GET /api/v1/auth/me
//
// Accounts live in the store (SystemUser; review finding X2): bcrypt hashes only, compared with bcrypt.compare. An
// unknown user, a wrong password, an inactive account and (when NODE_ENV=production) a demo account all get the SAME
// 401, and an unknown user still costs one bcrypt comparison, so the response does not reveal which case it was.

import express from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { authenticate, generateToken, getJwtExpires, publicUser, accountUsable } from '../middleware/auth.js';
import { store } from '../db/store.js';
import { validateBody } from '../services/validation.js';
import { dummyHash } from '../services/passwords.js';

const router = express.Router();

const INVALID = 'Invalid credentials. Please check username and password.';
const production = () => process.env.NODE_ENV === 'production';

/** The username exactly as the lookup sees it (validateBody trims strings), so padded variants share one bucket. */
export const normalizedUsername = body => (typeof body?.username === 'string' ? body.username.trim().slice(0, 80) : '');

// Brute force protection (X6, round 2 item 2): failed attempts are counted per normalised username AND client address,
// with a ceiling per client address over all usernames (behind a proxy the address comes from TRUST_PROXY, see
// server.js). Successful logins do not count.
const limiterOptions = {
  windowMs: 15 * 60_000,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
};
// Only wrong credentials (401) count toward the per-address ceiling: a 429 from the per-username limiter, a validation
// 400 or a success never does, so many users behind one NAT address are not locked out by one user's retries.
const loginIpLimiter = rateLimit({
  ...limiterOptions,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  limit: Number.parseInt(process.env.LOGIN_IP_RATE_LIMIT || '50', 10),
  keyGenerator: req => `ip|${ipKeyGenerator(req.ip ?? '')}`
});
const loginLimiter = rateLimit({
  ...limiterOptions,
  // Lockout: the 6th failed attempt for one username (from one address) within the window gets 429 (default 5).
  limit: Number.parseInt(process.env.LOGIN_RATE_LIMIT || '5', 10),
  keyGenerator: req => `${ipKeyGenerator(req.ip ?? '')}|${normalizedUsername(req.body)}`
});

/**
 * POST /api/v1/auth/login
 * Body: { username, password }
 * Returns: { success, token, user: { user_id, username, role, hospital_id, ambulance_id, display_name }, expires_in, expires_at }
 */
router.post('/login',
  loginIpLimiter,
  loginLimiter,
  validateBody({
    username: { type: 'string', required: true, maxLength: 80 },
    // bcrypt reads at most 72 bytes; anything far longer is refused before hashing work is spent on it.
    password: { type: 'string', required: true, trim: false, maxLength: 200 }
  }),
  async (req, res) => {
    const { username, password } = req.valid;
    const user = await store.findUserByUsername(username);
    // Always one bcrypt comparison, whether or not the user exists (no timing difference to probe usernames with).
    const matches = await bcrypt.compare(password, user?.password_hash || await dummyHash());
    if (!user || !matches || !accountUsable(user)) {
      if (user && matches && Number(user.is_demo) === 1 && production()) {
        console.warn(`[AUTH] Refused demo account "${user.username}": demo accounts are disabled when NODE_ENV=production.`);
      }
      return res.status(401).json({ error: INVALID });
    }

    const token = generateToken(user);
    const { exp } = jwt.decode(token);
    // last_login is bookkeeping only: it never changes token_version, and a failed write does not fail the login.
    try {
      await store.recordLogin(user.user_id);
    } catch (err) {
      console.error('[AUTH] Could not record last_login:', err.message);
    }
    return res.status(200).json({
      success: true,
      token,
      user: publicUser(user),
      expires_in: getJwtExpires(),
      expires_at: new Date(exp * 1000).toISOString()
    });
  }
);

/**
 * GET /api/v1/auth/me
 * The current account as the store has it now (a deactivated or production-refused demo account is a 401).
 */
router.get('/me', authenticate, async (req, res) => {
  // authenticate already loaded the account and refused an unusable one; this is the current identity.
  res.json({ success: true, user: publicUser(req.user) });
});

export default router;
