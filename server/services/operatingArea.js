// server/services/operatingArea.js
// Batch 8 (P-0.1): ERIS operates in ONE city, Dehradun (Uttarakhand). The single place that defines the operating area,
// the verified locality points the demo data is built from, and the checks every route uses:
//  - a pickup, incident, ambulance position, trip start or hospital coordinate outside the area is refused (400) before
//    anything is routed or stored;
//  - a road route from the routing service is accepted only if every point stays inside the area and it is at most
//    ROUTE_DETOUR_LIMIT x the straight-line distance (otherwise the trip falls back to the labelled simulated route).
//
// LOCALITIES: locality CENTRE points (never real hospital addresses), each looked up ONCE on OpenStreetMap Nominatim
// (https://nominatim.openstreetmap.org/search?q=<place>&format=json&limit=1, descriptive User-Agent, one request per second)
// on 2026-11-15. Source: OpenStreetMap contributors, ODbL. The returned point and the OSM object are recorded below.
// "Patel Nagar" (also requested) was NOT found by Nominatim under any spelling tried ("Patel Nagar, Dehradun",
// "Patelnagar, Dehradun", "Patel Nagar, Dehradun, Uttarakhand", bounded to the area): it is therefore not used, rather
// than guessed. "ISBT, Dehradun" first matched the Rishikesh ISBT (outside the city); the Dehradun ISBT was found as
// "Inter State Bus Terminal, Dehradun".

export const LOCALITIES = Object.freeze({
  CLOCK_TOWER:        Object.freeze({ name: 'Clock Tower (Ghanta Ghar)', lat: 30.3243249, lng: 78.0418653, osm: 'way 1556686564 (man_made=tower)' }),
  RAJPUR_ROAD:        Object.freeze({ name: 'Rajpur Road',               lat: 30.3537385, lng: 78.0634548, osm: 'way 105690119 (highway=primary)' }),
  ISBT:               Object.freeze({ name: 'ISBT Dehradun',             lat: 30.2879057, lng: 77.9980333, osm: 'way 451131123 (amenity=bus_station)' }),
  PREM_NAGAR:         Object.freeze({ name: 'Premnagar',                 lat: 30.3352250, lng: 77.9640010, osm: 'node 2379693708 (place=neighbourhood)' }),
  CLEMENT_TOWN:       Object.freeze({ name: 'Clement Town',              lat: 30.2613281, lng: 78.0120117, osm: 'node 2379693648 (place=hamlet)' }),
  SAHASTRADHARA_ROAD: Object.freeze({ name: 'Sahastradhara Road',        lat: 30.3779553, lng: 78.1047242, osm: 'way 527433595 (highway=tertiary)' })
});

/** The Dehradun operating area (inclusive). Every locality above lies inside with at least ~0.045 degrees of margin. */
export const OPERATING_AREA = Object.freeze({ name: 'Dehradun, Uttarakhand', minLat: 30.20, maxLat: 30.45, minLng: 77.90, maxLng: 78.15 });

/** A road route longer than this multiple of the straight-line distance is refused (a detour, or another city). */
export const ROUTE_DETOUR_LIMIT = 3;

export function insideArea(lat, lng, area = OPERATING_AREA) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= area.minLat && lat <= area.maxLat && lng >= area.minLng && lng <= area.maxLng;
}

/**
 * May this unit be sent (auto-dispatch)? Its known position must lie in the area. A unit with no recorded position cannot
 * be judged and stays eligible (every seeded unit has one, and no API accepts a position outside the area any more).
 */
export const unitInArea = (unit, area = OPERATING_AREA) =>
  unit.current_lat == null || unit.current_lng == null || insideArea(Number(unit.current_lat), Number(unit.current_lng), area);
/** The same rule as SQL on table Ambulance (no user input: the bounds are constants). */
export const UNIT_IN_AREA_SQL = `(current_lat IS NULL OR current_lng IS NULL OR (current_lat BETWEEN ${OPERATING_AREA.minLat} AND ${OPERATING_AREA.maxLat}
  AND current_lng BETWEEN ${OPERATING_AREA.minLng} AND ${OPERATING_AREA.maxLng}))`;

export const AREA_MESSAGE = `is outside the operating area (${OPERATING_AREA.name}: latitude ${OPERATING_AREA.minLat} to ${OPERATING_AREA.maxLat}, longitude ${OPERATING_AREA.minLng} to ${OPERATING_AREA.maxLng}).`;

/**
 * The first refusal message for named points, or null. points: [[label, lat, lng], ...]; a point with a null / undefined
 * latitude AND longitude is "not given" and passes (the field's own validation decides whether it is required).
 */
export function areaProblem(points, area = OPERATING_AREA) {
  for (const [label, lat, lng] of points) {
    if ((lat === null || lat === undefined) && (lng === null || lng === undefined)) continue;
    if (lat === null || lat === undefined || lng === null || lng === undefined) return `${label} needs both latitude and longitude.`;
    if (!insideArea(Number(lat), Number(lng), area)) return `${label} ${AREA_MESSAGE}`;
  }
  return null;
}
