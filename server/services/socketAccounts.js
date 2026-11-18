// server/services/socketAccounts.js
// Live sockets follow the account as the store has it now (round 2, item 5). The handshake loads the account (as REST
// does on every request); afterwards every live socket is re-checked periodically: an account that was deactivated
// (or is a demo account on a production server) is disconnected, and a changed role / hospital / ambulance moves the
// socket to the rooms the new identity is entitled to.

import { loadAccount } from '../middleware/auth.js';
import { socketRooms } from './accessPolicy.js';

export const DEFAULT_RECHECK_MS = 60_000;

// setInterval's largest delay; Node turns anything above it into a 1 ms timer (TimeoutOverflowWarning).
export const MAX_RECHECK_MS = 2_147_483_647;

/** SOCKET_RECHECK_MS: unset = 60 s; otherwise whole milliseconds from 1000 to 2147483647. Anything else stops start-up. */
export function parseRecheckInterval(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return DEFAULT_RECHECK_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > MAX_RECHECK_MS) {
    throw new Error(`SOCKET_RECHECK_MS must be a whole number of milliseconds, at least 1000 and at most ${MAX_RECHECK_MS} (got "${value}").`);
  }
  return Number(value);
}

const SCOPE_FIELDS = ['role', 'hospital_id', 'ambulance_id'];

/** Re-load one socket's account. Returns 'disconnected' | 'rescoped' | 'unchanged' (or 'error' if the store failed). */
export async function refreshSocketAccount(socket, { load = loadAccount, log = console } = {}) {
  let fresh;
  try {
    fresh = await load(socket.user);
  } catch (err) {
    log.error?.(`[WS] Could not re-check the account of ${socket.id}:`, err.message);
    return 'error'; // a store outage does not cut every console off; the next check retries
  }
  if (!fresh) {
    log.log?.(`[WS] Account ${socket.user?.user_id} is no longer usable; disconnecting ${socket.id}`);
    socket.disconnect(true);
    return 'disconnected';
  }
  const changed = SCOPE_FIELDS.some(field => (socket.user?.[field] ?? null) !== (fresh[field] ?? null));
  if (changed) {
    const before = socketRooms(socket.user);
    const after = socketRooms(fresh);
    for (const room of before) if (!after.includes(room)) socket.leave(room);
    for (const room of after) if (!before.includes(room)) socket.join(room);
  }
  socket.user = fresh;
  return changed ? 'rescoped' : 'unchanged';
}

/** Re-check every live socket every `intervalMs`. Returns a stop function. */
export function startSocketAccountRecheck(io, intervalMs, options = {}) {
  const timer = setInterval(() => {
    for (const socket of io.of('/').sockets.values()) refreshSocketAccount(socket, options);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
