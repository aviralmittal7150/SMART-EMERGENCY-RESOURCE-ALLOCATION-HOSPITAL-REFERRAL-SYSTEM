// server/services/tracking/geo.js
// Geometry for the simulated ambulance trips: haversine distances, polylines of [lat, lng] points, the point at a
// given distance along a polyline (linear interpolation between consecutive points: the unit never jumps), and the
// straight-line fallback route. Coordinates are rounded to 7 decimals, the precision of DECIMAL(10, 7), so the
// in-memory and MySQL stores hold exactly the same values.

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = deg => (deg * Math.PI) / 180;

export const round7 = value => Math.round(value * 1e7) / 1e7;
export const roundPoint = ([lat, lng]) => [round7(lat), round7(lng)];

/** A finite [lat, lng] within the valid ranges. */
export function isValidPoint(point) {
  return Array.isArray(point) && point.length === 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && point[0] >= -90 && point[0] <= 90 && point[1] >= -180 && point[1] <= 180;
}

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversineMeters([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Cumulative distance (metres) at each point of the polyline; the last entry is its length. */
export function cumulativeMeters(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  return cumulative;
}

export const polylineMeters = points => cumulativeMeters(points).at(-1);

/**
 * The point `meters` along the polyline (clamped to its ends), interpolated between the two surrounding points.
 * `cumulative` is cumulativeMeters(points), passed in so a caller moving along one route computes it once.
 */
export function pointAtMeters(points, cumulative, meters) {
  const total = cumulative.at(-1);
  if (meters <= 0 || total === 0) return roundPoint(points[0]);
  if (meters >= total) return roundPoint(points.at(-1));
  let i = 1;
  while (cumulative[i] < meters) i += 1;
  const segment = cumulative[i] - cumulative[i - 1];
  const t = segment === 0 ? 0 : (meters - cumulative[i - 1]) / segment;
  const [a, b] = [points[i - 1], points[i]];
  return roundPoint([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}

/** Straight line from `from` to `to` with intermediate points about every `stepMeters` (2 to `maxPoints` points). */
export function straightLine(from, to, { stepMeters = 100, maxPoints = 60 } = {}) {
  const distance = haversineMeters(from, to);
  const segments = Math.max(1, Math.min(maxPoints - 1, Math.ceil(distance / stepMeters)));
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    points.push(roundPoint([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]));
  }
  points[0] = roundPoint(from);
  points[points.length - 1] = roundPoint(to);
  return points;
}

/** Keep at most `max` points (always the first and the last), dropping evenly spaced ones. */
export function downsample(points, max = 1000) {
  if (points.length <= max) return points;
  const kept = [];
  for (let i = 0; i < max - 1; i += 1) kept.push(points[Math.floor((i * (points.length - 1)) / (max - 1))]);
  kept.push(points.at(-1));
  return kept;
}

/** The route as it is stored: rounded, consecutive duplicates removed, starting EXACTLY at `from`, ending EXACTLY at `to`. */
export function normaliseRoute(points, from, to) {
  const rounded = [roundPoint(from), ...points.map(roundPoint), roundPoint(to)];
  const route = [];
  for (const point of rounded) {
    const last = route.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) route.push(point);
  }
  if (route.length === 1) route.push([...route[0]]); // from === to: a zero-length leg still has two points
  return route;
}
