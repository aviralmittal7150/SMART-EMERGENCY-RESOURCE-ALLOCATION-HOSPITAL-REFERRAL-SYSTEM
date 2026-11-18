// js/tracking-map.js
// The live-tracking map: OpenStreetMap tiles (the same Leaflet setup as the regional map), CSP-safe divIcon markers
// (no external marker images), the two route polylines, and smooth movement of the ambulance marker.
//
// Movement rule: the marker only ever interpolates between CONSECUTIVE server positions (tracking:update / GET), so it
// never jumps from the start to the destination. The position currently shown is mirrored on the container as
// data-ambulance="lat,lng" (with data-pickup / data-hospital), which the end-to-end test samples.

import { el } from './dom.js';
import { DEFAULT_VIEW } from './operating-area.js';

// Deliberately no external tile layer: the demo uses a local schematic background and simulated coordinates.
export const OSM_TILES = null;
export function addOsmTiles() { /* Offline-first demo: no external map requests. */ }

const marker = (L, kind, label, glyph) => L.divIcon({
  className: `trk-marker trk-${kind}`,
  html: el('span', { class: 'trk-glyph', role: 'img', 'aria-label': label }, glyph),
  iconSize: [32, 32], iconAnchor: [16, 16]
});

/** [[lat,lng],…] from a route given as [[lat,lng]] or [{lat,lng}]; [] when absent. */
export function routePoints(route) {
  if (!Array.isArray(route)) return [];
  return route.map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.lat), Number(p?.lng)]))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}
const point = p => (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? [Number(p.lat), Number(p.lng)] : null);
const fmt = ll => `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`;

// ── Road-following: positions along a route polyline (planar metres; fine at city scale) ──
const M_PER_DEG = 111320;
const toXY = (ll, lat0) => [ll[1] * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180), ll[0] * M_PER_DEG];
/** The polyline with cumulative lengths, for project() / at(). */
export function pathOf(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const lat0 = points[0][0];
  const xy = points.map(p => toXY(p, lat0));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { points, xy, cum, lat0, length: cum.at(-1) };
}
/** Distance along the path of the point nearest to `ll`, and how far `ll` is from the path (metres). */
export function project(path, ll) {
  const [px, py] = toXY(ll, path.lat0);
  let best = { s: 0, off: Infinity };
  for (let i = 1; i < path.xy.length; i++) {
    const [ax, ay] = path.xy[i - 1]; const [bx, by] = path.xy[i];
    const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.off) best = { s: path.cum[i - 1] + t * (path.cum[i] - path.cum[i - 1]), off };
  }
  return best;
}
/** The [lat, lng] at distance `s` along the path. */
export function at(path, s) {
  const d = Math.max(0, Math.min(path.length, s));
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < d) i++;
  const seg = path.cum[i] - path.cum[i - 1];
  const t = seg ? (d - path.cum[i - 1]) / seg : 0;
  const a = path.points[i - 1]; const b = path.points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
const ON_ROUTE_M = 25; // a server position this close to the route is on it

/**
 * A local schematic tracking map in `container`, or null when Leaflet is unavailable. show(trip) draws a trip (markers and both
 * routes) and moves the ambulance; moveTo(current) animates it from the position shown now.
 */
export function createTrackingMap(container, { reducedMotion = () => false } = {}) {
  const L = typeof window !== 'undefined' ? window.L : undefined;
  if (!L || !container) return null;
  // No zoom/fade animation: the map can be re-rendered or removed at any time, and positions animate on their own.
  const map = L.map(container, { zoomControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  addOsmTiles(L, map);
  const st = { tripId: null, routesKey: null, amb: null, pickup: null, hospital: null, toPatient: null, toHospital: null, shown: null, frame: 0, lastUpdate: 0, paths: { patient: null, hospital: null } };

  function setShown(ll) {
    st.shown = ll;
    st.amb?.setLatLng(ll);
    container.dataset.ambulance = fmt(ll);
  }

  /** The leg both positions lie on, with their distances along it; null when they are not on one route (straight move). */
  function legFor(from, target, phase) {
    const order = phase === 'EN_ROUTE_TO_HOSPITAL' || phase === 'PATIENT_PICKED_UP' || phase === 'ARRIVED_AT_HOSPITAL'
      ? [st.paths.hospital, st.paths.patient] : [st.paths.patient, st.paths.hospital];
    for (const path of order) {
      if (!path) continue;
      const a = project(path, from); const b = project(path, target);
      if (a.off <= ON_ROUTE_M && b.off <= ON_ROUTE_M && b.s >= a.s) return { path, s0: a.s, s1: b.s };
    }
    return null;
  }

  /** Animate from the position shown now to `pos`, along the road when both are on the route (never a jump). */
  function moveTo(pos, phase) {
    const target = point(pos);
    if (!target) return;
    cancelAnimationFrame(st.frame);
    if (!st.shown || reducedMotion()) { setShown(target); return; }
    const from = st.shown;
    const now = performance.now();
    // Spread the move over the time between server updates (bounded), so consecutive steps join smoothly.
    const duration = Math.max(200, Math.min(st.lastUpdate ? now - st.lastUpdate : 900, 1500));
    st.lastUpdate = now;
    const leg = legFor(from, target, phase);
    const step = t => {
      const k = Math.min((t - now) / duration, 1);
      if (k >= 1) setShown(target);
      else if (leg) setShown(at(leg.path, leg.s0 + (leg.s1 - leg.s0) * k));
      else setShown([from[0] + (target[0] - from[0]) * k, from[1] + (target[1] - from[1]) * k]);
      if (k < 1) st.frame = requestAnimationFrame(step);
    };
    st.frame = requestAnimationFrame(step);
  }

  function clear() {
    cancelAnimationFrame(st.frame);
    [st.amb, st.pickup, st.hospital, st.toPatient, st.toHospital].forEach(layer => layer && map.removeLayer(layer));
    Object.assign(st, { amb: null, pickup: null, hospital: null, toPatient: null, toHospital: null, shown: null, lastUpdate: 0, paths: { patient: null, hospital: null } });
    ['ambulance', 'pickup', 'hospital'].forEach(k => delete container.dataset[k]);
  }

  function show(trip) {
    if (!trip) { clear(); st.tripId = null; return; }
    const toPatient = routePoints(trip.route_to_patient);
    const toHospital = routePoints(trip.route_to_hospital);
    const routesKey = JSON.stringify([toPatient, toHospital]);
    if (trip.trip_id !== st.tripId || routesKey !== st.routesKey) {
      clear();
      st.tripId = trip.trip_id; st.routesKey = routesKey;
      st.paths = { patient: pathOf(toPatient), hospital: pathOf(toHospital) };
      const pickup = point(trip.pickup); const hospital = point(trip.hospital);
      if (toPatient.length > 1) st.toPatient = L.polyline(toPatient, { color: '#2563eb', weight: 5, opacity: 0.85, className: 'trk-line-to-patient' }).addTo(map);
      if (toHospital.length > 1) st.toHospital = L.polyline(toHospital, { color: '#16a34a', weight: 5, opacity: 0.85, dashArray: '10 8', className: 'trk-line-to-hospital' }).addTo(map);
      if (pickup) { st.pickup = L.marker(pickup, { icon: marker(L, 'pickup', 'Patient pickup', 'P'), keyboard: false, interactive: false }).addTo(map); container.dataset.pickup = fmt(pickup); }
      if (hospital) { st.hospital = L.marker(hospital, { icon: marker(L, 'hospital', 'Destination hospital', 'H'), keyboard: false, interactive: false }).addTo(map); container.dataset.hospital = fmt(hospital); }
      const current = point(trip.current) || point(trip.start);
      if (current) {
        st.amb = L.marker(current, { icon: marker(L, 'ambulance', 'Ambulance (simulated position)', '🚑'), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
        setShown(current);
      }
      const bounds = [...toPatient, ...toHospital, pickup, hospital, current].filter(Boolean);
      if (bounds.length) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15, animate: false });
      return;
    }
    moveTo(trip.current, trip.phase);
  }

  return {
    map, show, moveTo,
    shownPosition: () => st.shown,
    invalidate: () => map.invalidateSize(),
    // Removing the map also removes every trace of the trip from its container (no position left behind).
    destroy: () => { cancelAnimationFrame(st.frame); map.remove(); ['ambulance', 'pickup', 'hospital'].forEach(k => delete container.dataset[k]); }
  };
}
