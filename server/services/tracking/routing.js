// server/services/tracking/routing.js
// Road routes for the simulated trips. The server asks an OSRM-compatible routing service
//   GET ${ROUTING_URL}/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson
// with a short timeout. On ANY failure (network, timeout, HTTP error, unusable answer), or when routing is off, the leg
// is a straight line with intermediate points and the trip is labelled route_source 'simulated'.
//
// PRIVACY: a routing request sends the ambulance start, the patient pickup point and the hospital position to the
// routing provider. ROUTING_URL is therefore OFF in production unless set explicitly (see .env.example).
//
// ROUTING_URL:  unset/empty -> off (fully simulated local routing); set an explicit URL only for optional integrations
//               "off"       -> no routing service (straight lines)
//               otherwise   -> an https:// URL (http:// only for localhost / 127.0.0.1 / [::1] outside production, for
//                              a local OSRM or the test fake). Anything else stops start-up.
// ROUTING_TIMEOUT_MS: whole milliseconds, 100 to 10000 (default 4000).

import { isValidPoint, normaliseRoute, straightLine, downsample, cumulativeMeters, haversineMeters } from './geo.js';
import { insideArea, ROUTE_DETOUR_LIMIT } from '../operatingArea.js';
import { parseIntegerSetting } from '../settings.js';

export const DEFAULT_ROUTING_URL = null;
export const DEFAULT_ROUTING_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_ROUTE_POINTS = 1000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The routing base URL, or null when routing is off. Throws (start-up refusal) on an unusable value. */
export function parseRoutingUrl(raw, { production = false } = {}) {
  const value = String(raw ?? '').trim();
  if (value === '') return null;
  if (value.toLowerCase() === 'off') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ROUTING_URL must be an https:// URL or "off" (got "${value}").`);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname) && !production;
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`ROUTING_URL must use https:// (plain http:// is allowed only for localhost outside production; got "${value}").`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ROUTING_URL must not contain credentials, a query string or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export const parseRoutingTimeout = raw => parseIntegerSetting('ROUTING_TIMEOUT_MS', raw, { fallback: DEFAULT_ROUTING_TIMEOUT_MS, min: 100, max: 10_000 });

/** One leg from the OSRM service as [[lat, lng], ...] (from and to exactly at its ends). Throws on any problem. */
export async function osrmLeg(baseUrl, from, to, { timeoutMs = DEFAULT_ROUTING_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const coords = `${from[1]},${from[0]};${to[1]},${to[0]}`;
  const response = await fetchImpl(`${baseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`routing service answered HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('routing answer too large');
  const body = JSON.parse(text);
  const coordinates = body?.code === 'Ok' ? body.routes?.[0]?.geometry?.coordinates : null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error(`routing service found no route (${body?.code ?? 'no code'})`);
  const points = coordinates.map(c => (Array.isArray(c) ? [c[1], c[0]] : null)); // GeoJSON is [lng, lat]
  if (!points.every(isValidPoint)) throw new Error('routing answer has invalid coordinates');
  return normaliseRoute(downsample(points, MAX_ROUTE_POINTS - 2), from, to);
}

/**
 * Batch 8 (P-0.1) route guard: why a road route must not be used, or null. Refused when any point leaves `area` (the
 * operating area: never silently route through or to another city) or the route is longer than ROUTE_DETOUR_LIMIT x the
 * straight-line distance.
 */
export function routeProblem(points, from, to, area) {
  if (!area) return null;
  if (!points.every(([lat, lng]) => insideArea(lat, lng, area))) return 'the route leaves the operating area';
  const straight = haversineMeters(from, to);
  const length = cumulativeMeters(points).at(-1);
  if (straight > 1 && length > ROUTE_DETOUR_LIMIT * straight) return `the route is ${(length / straight).toFixed(1)}x the straight-line distance`;
  return null;
}

/**
 * Router: { url, timeoutMs, fetchImpl, log, area }. route(from, to) never throws: { points, source: 'osrm' | 'simulated' }.
 * With `area` (the server passes the operating area) a road route failing routeProblem is replaced by the simulated
 * straight line (deterministic). The log line never contains coordinates.
 */
export function createRouter({ url = null, timeoutMs = DEFAULT_ROUTING_TIMEOUT_MS, fetchImpl = fetch, log = console, area = null } = {}) {
  return {
    url,
    async route(from, to) {
      if (url) {
        try {
          const points = await osrmLeg(url, from, to, { timeoutMs, fetchImpl });
          const problem = routeProblem(points, from, to, area);
          if (!problem) return { points, source: 'osrm' };
          log.warn?.(`[TRACKING] Road route refused (${problem}); using a simulated straight-line route.`);
        } catch (err) {
          log.warn?.(`[TRACKING] Routing failed (${err.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : err.message}); using a simulated straight-line route.`);
        }
      }
      return { points: straightLine(from, to), source: 'simulated' };
    }
  };
}
