// js/operating-area.js
// The area ERIS operates in (Dehradun, Uttarakhand). The SERVER enforces it (400 for any pickup, incident, ambulance or
// trip coordinate outside it); this copy only lets a form say so before sending. Keep it equal to the server's
// operating-area config.

export const OPERATING_AREA = Object.freeze({
  name: 'Dehradun',
  minLat: 30.20, maxLat: 30.45,
  minLng: 77.90, maxLng: 78.15
});

/** The map's default view when there is nothing to fit: central Dehradun (Clock Tower). */
export const DEFAULT_VIEW = Object.freeze({ center: [30.3243, 78.0419], zoom: 12 });

export const inOperatingArea = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= OPERATING_AREA.minLat && lat <= OPERATING_AREA.maxLat && lng >= OPERATING_AREA.minLng && lng <= OPERATING_AREA.maxLng;

/** null when the point is inside the operating area, else the message to show. */
export function operatingAreaProblem(lat, lng, what = 'This location') {
  if (inOperatingArea(lat, lng)) return null;
  const a = OPERATING_AREA;
  return `${what} is outside the ${a.name} operating area (latitude ${a.minLat.toFixed(2)}–${a.maxLat.toFixed(2)}, longitude ${a.minLng.toFixed(2)}–${a.maxLng.toFixed(2)}).`;
}
