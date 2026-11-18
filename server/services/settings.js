// server/services/settings.js
// Start-up parsing of numeric settings: junk stops the server, as TRUST_PROXY and SOCKET_RECHECK_MS do.

/** A whole number from `min` to `max`; unset/empty = `fallback`. Throws (start-up refusal) on anything else. */
export function parseIntegerSetting(name, raw, { fallback, min = 1, max = 1_000_000 }) {
  const value = String(raw ?? '').trim();
  if (value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${value}").`);
  }
  return Number(value);
}

/** API_RATE_LIMIT: requests per minute per client address on /api (default 300). */
export const parseApiRateLimit = raw => parseIntegerSetting('API_RATE_LIMIT', raw, { fallback: 300, min: 1, max: 1_000_000 });
