// server/routes/geo.js
// Batch 8 (P-0, Addendum 2): the operating area for the clients' locality picker and map view — /api/v1/geo.
//   GET /operating-area   any signed-in staff role
//   -> { success, name, bbox: { min_lat, max_lat, min_lng, max_lng }, localities: [{ key, name, lat, lng }], source, unverified }
// The localities are the Nominatim-verified centre points of server/services/operatingArea.js; the server refuses (400)
// any pickup or position outside the bbox whatever a client sends.

import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { LOCALITIES, OPERATING_AREA } from '../services/operatingArea.js';

const router = express.Router();

router.get('/operating-area', authenticate, (req, res) => {
  res.json({
    success: true,
    name: OPERATING_AREA.name,
    bbox: { min_lat: OPERATING_AREA.minLat, max_lat: OPERATING_AREA.maxLat, min_lng: OPERATING_AREA.minLng, max_lng: OPERATING_AREA.maxLng },
    localities: Object.entries(LOCALITIES).map(([key, l]) => ({ key, name: l.name, lat: l.lat, lng: l.lng })),
    source: 'OpenStreetMap Nominatim (verified 2026-11-15), © OpenStreetMap contributors, ODbL',
    unverified: ['Patel Nagar (not found by Nominatim; not offered)']
  });
});

export default router;
