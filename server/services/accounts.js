// server/services/accounts.js
// Which accounts may be used, in one dependency-free place: the login, every request (server/middleware/auth.js), the
// production start-up check (the stores' countUsableAdmins) and every account write (the stores' createUser /
// updateUser, the admin API, scripts/user-create.js) apply exactly the same rules.
//
// Roles (migration 009 adds DISPATCHER and PATIENT). Shape rules:
//   HOSPITAL_DESK  must have hospital_id
//   PATIENT        must have patient_id (the patient whose cases the account may read), and no hospital_id / ambulance_id
//   PARAMEDIC      may have ambulance_id (the unit they crew)
//   any role other than PATIENT must not carry patient_id

export const ROLES = Object.freeze(['ADMIN', 'DISPATCHER', 'HOSPITAL_DESK', 'PARAMEDIC', 'PATIENT']);
export const STAFF_ROLES = Object.freeze(['ADMIN', 'DISPATCHER', 'HOSPITAL_DESK', 'PARAMEDIC']);
// The roles an account may be GIVEN (admin API, user:create): Admin, Hospital desk and Fleet (paramedic crew) only. The
// DISPATCHER (Operator) and PATIENT portals were retired for the product; their policy code stays, dormant: no account
// can be created with, or changed to, those roles.
export const ASSIGNABLE_ROLES = Object.freeze(['ADMIN', 'HOSPITAL_DESK', 'PARAMEDIC']);

/** Why an account row has an invalid shape for its role, or null when it is valid. */
export function accountShapeProblem(user) {
  if (!user || !ROLES.includes(user.role)) return `role must be one of ${ROLES.join(', ')}.`;
  if (user.role === 'HOSPITAL_DESK' && !user.hospital_id) return 'A HOSPITAL_DESK account needs a hospital_id.';
  if (user.role === 'PATIENT' && !user.patient_id) return 'A PATIENT account needs a patient_id.';
  if (user.role === 'PATIENT' && (user.hospital_id || user.ambulance_id)) return 'A PATIENT account cannot be linked to a hospital_id or ambulance_id.';
  if (user.role !== 'PATIENT' && user.patient_id) return 'Only a PATIENT account may be linked to a patient_id.';
  return null;
}

/**
 * TESTS ONLY: ENABLE_RETIRED_ROLES=1 lets existing DISPATCHER / PATIENT accounts sign in, so the dormant policy can still
 * be exercised. Never in production (the server refuses to start with it set there).
 */
export const retiredRolesEnabled = (env = process.env) => env.ENABLE_RETIRED_ROLES === '1' && env.NODE_ENV !== 'production';

/**
 * Whether an account may be used now: it exists, is active, has a valid shape, holds one of the product's roles (an
 * existing DISPATCHER / PATIENT row is refused: sign-in, every request and the socket handshake), and is not a demo
 * account in production.
 */
export function accountUsable(user, env = process.env) {
  if (!user || !Number(user.is_active)) return false;
  if (!ASSIGNABLE_ROLES.includes(user.role) && !retiredRolesEnabled(env)) return false;
  if (Number(user.is_demo) === 1 && env.NODE_ENV === 'production') return false;
  return accountShapeProblem(user) === null;
}

/**
 * An account a production server can be administered with: a usable, non-demo ADMIN. A production server refuses to
 * start without one (patients or desks alone would leave nobody able to manage accounts).
 */
export const realAdminUsable = user => Boolean(user) && user.role === 'ADMIN' && Number(user.is_demo) !== 1
  && accountUsable(user, { NODE_ENV: 'production' });

/** The same rule in SQL (on SystemUser), for MySqlStore.countUsableAdmins. */
export const REAL_ADMIN_SQL = `is_demo = 0 AND is_active = 1 AND role = 'ADMIN' AND patient_id IS NULL`;

/**
 * Whether applying `changes` to the STORED account `current` must end its sessions (raise token_version): a change of
 * role or of a hospital / ambulance / patient link, or a deactivation. Decided by the store against the row it is about
 * to write (locked on MySQL), never against an earlier read, so concurrent edits cannot skip the bump.
 */
export function changeEndsSessions(current, changes) {
  if (changes.is_active !== undefined && !Number(changes.is_active) && Number(current.is_active)) return true;
  return ['role', 'hospital_id', 'ambulance_id', 'patient_id']
    .some(f => changes[f] !== undefined && (changes[f] ?? null) !== (current[f] ?? null));
}
