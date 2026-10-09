// server/middleware/auth.js
// JWT Role-Based Authentication (RBAC) Middleware
// Roles: ADMIN | HOSPITAL_DESK | PARAMEDIC

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'emergency-system-secret-key-2026';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

/**
 * Generate a signed JWT for a verified user
 */
export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * Verify token and attach decoded user to req.user
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalid or expired. Please re-authenticate.' });
  }
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
  PARAMEDIC: [
    'CREATE_EMERGENCY_REQUEST', 'VIEW_RANKED_HOSPITALS', 'VIEW_AMBULANCES',
    'DISPATCH_AMBULANCE', 'UPDATE_AMBULANCE_STATUS'
  ]
};
