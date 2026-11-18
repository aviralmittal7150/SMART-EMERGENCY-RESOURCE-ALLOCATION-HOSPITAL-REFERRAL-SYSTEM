// server/services/dispatch.js
// Batch 8 (P-0.3): ADMIN dispatch suggestions for one case. Decision support only: the admin confirms or overrides, the
// referral then goes through the normal locking engine (which alone guarantees no overbooking), and the hospital decides.
//   ambulances  AVAILABLE units inside the operating area, nearest to the pickup point first.
//   hospitals   every hospital not CLOSED, eligible first (free capacity for each required resource, an available required
//               specialist), then by distance; each with its reasons.
// Distances are straight-line (haversine) estimates; the route itself comes from the tracking engine.

import { haversineMeters } from './tracking/geo.js';
import { insideArea } from './operatingArea.js';

const km = meters => Math.round(meters / 100) / 10;
// A rough urban speed for the ETA estimate shown next to a unit (the simulated trip computes its own ETA).
const ESTIMATE_KMH = 30;

export async function dispatchOptions(store, request) {
  const pickup = request.pickup_lat != null && request.pickup_lng != null ? [Number(request.pickup_lat), Number(request.pickup_lng)] : null;
  const distance = (lat, lng) => (pickup && lat != null && lng != null ? haversineMeters(pickup, [Number(lat), Number(lng)]) : null);

  const units = (await store.listAmbulances({ status: 'AVAILABLE' }))
    .filter(u => insideArea(Number(u.current_lat), Number(u.current_lng)))
    .map(u => {
      const meters = distance(u.current_lat, u.current_lng);
      return {
        ambulance_id: u.ambulance_id, vehicle_number: u.vehicle_number, ambulance_type: u.ambulance_type, station_hospital_id: u.hospital_id,
        capacity: Number(u.capacity ?? 1), distance_km: meters === null ? null : km(meters),
        eta_min_estimate: meters === null ? null : Math.max(1, Math.round((meters / 1000 / ESTIMATE_KMH) * 60))
      };
    })
    .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity) || a.ambulance_id.localeCompare(b.ambulance_id));

  const [hospitals, resources, doctors] = await Promise.all([store.listHospitals(), store.listResources(), store.listDoctors()]);
  const needs = request.required_resource_types ?? request.required_resources ?? [];
  const specialist = request.required_specialist ?? null;
  const options = hospitals.filter(h => h.emergency_status !== 'CLOSED').map(h => {
    const reasons = [];
    let eligible = true;
    for (const type of needs) {
      const r = resources.find(x => x.hospital_id === h.hospital_id && x.resource_type === type);
      const free = r ? r.available_capacity - r.locked_capacity : 0;
      if (free < 1) { eligible = false; reasons.push(`no free ${type}`); } else reasons.push(`${free} ${type} free`);
    }
    if (specialist) {
      const available = doctors.filter(d => d.hospital_id === h.hospital_id && d.specialization === specialist && d.availability_status === 'AVAILABLE').length;
      if (!available) { eligible = false; reasons.push(`no ${specialist} available`); } else reasons.push(`${specialist} available`);
    }
    if (h.emergency_status === 'LIMITED') reasons.push('status LIMITED');
    const meters = distance(h.location_lat, h.location_lng);
    return { hospital_id: h.hospital_id, hospital_name: h.hospital_name, emergency_status: h.emergency_status, eligible, reasons,
      distance_km: meters === null ? null : km(meters) };
  }).sort((a, b) => (b.eligible - a.eligible) || ((a.distance_km ?? Infinity) - (b.distance_km ?? Infinity)) || a.hospital_id.localeCompare(b.hospital_id));

  return {
    suggested: { ambulance_id: units[0]?.ambulance_id ?? null, hospital_id: options.find(o => o.eligible)?.hospital_id ?? null },
    ambulances: units,
    hospitals: options,
    note: 'Decision support only: the admin confirms or overrides; the receiving hospital accepts or rejects.'
  };
}
