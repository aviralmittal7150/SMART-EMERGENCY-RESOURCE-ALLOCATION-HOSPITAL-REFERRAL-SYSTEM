// js/recommend.js
// Hospital recommendation for ONE case, computed in the browser over live GET /hospitals data.
// It uses the case's own server-resolved requirements (required_resource_types, required_specialist) and pickup
// coordinates. It is advisory: the server re-checks capacity and the specialist when the referral is initiated and
// refuses (409) anything that no longer fits. Nothing here invents data — an unknown distance is reported as unknown.

export const RESOURCE_LABELS = { ICU_BED: 'ICU bed', VENTILATOR: 'Ventilator', OT: 'Emergency OT' };
export const SPECIALIST_LABELS = {
  CARDIOLOGIST: 'Cardiologist', NEUROLOGIST: 'Neurologist', TRAUMA_SURGEON: 'Trauma surgeon',
  PEDIATRICIAN: 'Paediatrician', GENERAL_ER: 'General ER physician'
};

// Keys used by GET /hospitals `resources` (server: resource_type.toLowerCase().replace('_', '')).
const RESOURCE_KEYS = { ICU_BED: 'icubed', VENTILATOR: 'ventilator', OT: 'ot' };

const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** Normalise one GET /hospitals row. `free` = available - locked (soft-locked units are already promised). */
export function normalizeHospital(raw) {
  const resources = {};
  for (const [type, key] of Object.entries(RESOURCE_KEYS)) {
    const r = raw?.resources?.[key];
    if (!r) continue;
    const total = Number(r.total) || 0;
    const available = Number(r.available) || 0;
    const locked = Number(r.locked) || 0;
    resources[type] = { total, available, locked, free: Math.max(0, available - locked) };
  }
  // The doctor roster comes only for hospitals the caller manages (admins: all; a desk: its own). Every caller gets
  // `specialists_available`, the count of AVAILABLE doctors per specialisation, which is what availability needs.
  const doctors = Array.isArray(raw?.doctors) ? raw.doctors : [];
  const onDuty = new Set(doctors.filter(d => d.availability_status === 'AVAILABLE').map(d => d.specialization));
  const specialistCounts = {};
  doctors.filter(d => d.availability_status === 'AVAILABLE').forEach(d => { specialistCounts[d.specialization] = (specialistCounts[d.specialization] || 0) + 1; });
  if (raw?.specialists_available && typeof raw.specialists_available === 'object') {
    for (const [spec, count] of Object.entries(raw.specialists_available)) {
      if (Number(count) > 0) onDuty.add(spec);
      if (Number.isFinite(Number(count))) specialistCounts[spec] = Number(count);
    }
  }
  return {
    id: String(raw.hospital_id),
    name: String(raw.hospital_name ?? raw.hospital_id),
    address: raw.address ? String(raw.address) : '',
    phone: raw.contact_phone ? String(raw.contact_phone) : '',
    traumaLevel: raw.trauma_level ? String(raw.trauma_level) : '',
    status: String(raw.emergency_status || 'UNKNOWN'),
    lat: num(raw.location_lat),
    lng: num(raw.location_lng),
    acceptancePrior: num(raw.acceptance_rate),
    resources,
    doctors,
    onDuty,
    specialistCounts
  };
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Rank hospitals for a case. caseItem: { required_resource_types: string[], required_specialist: string|null,
 * pickup_lat, pickup_lng }. Returns [{ hospital, eligible, score, reasons[], factors{}, distanceKm }].
 */
export function rankForCase(caseItem, hospitals) {
  const types = Array.isArray(caseItem?.required_resource_types) ? caseItem.required_resource_types : [];
  const specialist = caseItem?.required_specialist || null;
  const pickupLat = num(caseItem?.pickup_lat);
  const pickupLng = num(caseItem?.pickup_lng);
  const hasPickup = pickupLat !== null && pickupLng !== null;

  const rows = hospitals.map(hospital => {
    const reasons = [];
    if (hospital.status === 'CLOSED') reasons.push('Closed to emergency intake (divert).');
    for (const type of types) {
      const r = hospital.resources[type];
      if (!r) reasons.push(`Has no ${RESOURCE_LABELS[type] || type} capacity.`);
      else if (r.free < 1) reasons.push(`No free ${RESOURCE_LABELS[type] || type} (${r.locked} soft-locked, ${r.total - r.available} in use).`);
    }
    if (specialist && !hospital.onDuty.has(specialist)) {
      reasons.push(`No ${SPECIALIST_LABELS[specialist] || specialist} on duty.`);
    }

    const distanceKm = hasPickup && hospital.lat !== null && hospital.lng !== null
      ? haversineKm(pickupLat, pickupLng, hospital.lat, hospital.lng)
      : null;

    if (reasons.length) return { hospital, eligible: false, score: null, reasons, factors: null, distanceKm };

    // Factors in 0..1. Weights are re-normalised over the factors that are actually known.
    const margin = types.length
      ? types.reduce((s, t) => s + Math.min(hospital.resources[t].free / 3, 1), 0) / types.length
      : null;
    const icu = hospital.resources.ICU_BED;
    const capacity = icu && icu.total > 0 ? icu.free / icu.total : null;
    const distance = distanceKm === null ? null : Math.max(0, 1 - distanceKm / 15);
    const prior = hospital.acceptancePrior;
    const parts = [
      ['margin', margin, 0.40],
      ['capacity', capacity, 0.20],
      ['distance', distance, 0.25],
      ['prior', prior, 0.15]
    ].filter(([, value]) => value !== null && Number.isFinite(value));
    const weight = parts.reduce((s, [, , w]) => s + w, 0);
    let score = weight > 0 ? (parts.reduce((s, [, v, w]) => s + v * w, 0) / weight) * 100 : 0;
    if (hospital.status === 'LIMITED') score -= 10;
    score = Math.max(0, Math.round(score * 10) / 10);

    return {
      hospital, eligible: true, score, reasons: [], distanceKm,
      factors: { margin, capacity, distance, prior, limited: hospital.status === 'LIMITED' }
    };
  });

  return rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible) return b.score - a.score || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    return a.hospital.id.localeCompare(b.hospital.id);
  });
}

// Specialists the server holds for one case at a time (server/services/emergencyRequirements.js EXCLUSIVE_SPECIALISTS);
// consultants are only checked for availability, so several patients may share one.
export const EXCLUSIVE_SPECIALISTS = ['TRAUMA_SURGEON'];

/**
 * Suggest a hospital for each patient of an incident, most urgent first (priority 1 before 2, then list order).
 * Greedy: each suggestion uses up, in a working copy of the live capacity, the resources (one of each required type)
 * and an exclusive specialist, so a later patient is never suggested a bed an earlier patient was given. Advisory
 * only: the server re-checks everything when each referral is sent.
 * cases: [{ request_id, priority, required_resource_types, required_specialist, pickup_lat, pickup_lng, exclude?: Set }]
 * Returns [{ case, hospital|null, row|null, earlierHere, freeBefore{type: free}, reasons[] }] in suggestion order
 * (freeBefore: what was left for this patient after the earlier suggestions).
 */
export function suggestForIncident(cases, hospitals) {
  const work = hospitals.map(h => ({
    ...h,
    resources: Object.fromEntries(Object.entries(h.resources).map(([t, r]) => [t, { ...r }])),
    onDuty: new Set(h.onDuty),
    specialistCounts: { ...(h.specialistCounts || {}) }
  }));
  const used = new Map(); // hospital id -> patients suggested there so far
  const order = cases.map((c, i) => [c, i]).sort((a, b) => (Number(a[0].priority) || 5) - (Number(b[0].priority) || 5) || a[1] - b[1]);
  return order.map(([c]) => {
    const pool = c.exclude?.size ? work.filter(h => !c.exclude.has(h.id)) : work;
    const ranked = rankForCase(c, pool);
    const best = ranked.find(r => r.eligible) || null;
    if (!best) {
      const reasons = ranked.length ? [...new Set(ranked.flatMap(r => r.reasons))] : ['No hospital to choose from.'];
      return { case: c, hospital: null, row: null, earlierHere: 0, freeBefore: {}, reasons };
    }
    const h = best.hospital;
    const earlierHere = used.get(h.id) || 0;
    const freeBefore = Object.fromEntries((c.required_resource_types || []).map(t => [t, h.resources[t]?.free ?? 0]));
    for (const t of c.required_resource_types || []) if (h.resources[t]) h.resources[t].free = Math.max(0, h.resources[t].free - 1);
    const spec = c.required_specialist;
    if (spec && EXCLUSIVE_SPECIALISTS.includes(spec) && Number.isFinite(h.specialistCounts[spec])) {
      h.specialistCounts[spec] -= 1;
      if (h.specialistCounts[spec] < 1) h.onDuty.delete(spec);
    }
    used.set(h.id, earlierHere + 1);
    return { case: c, hospital: hospitals.find(x => x.id === h.id) || h, row: best, earlierHere, freeBefore, reasons: [] };
  });
}
