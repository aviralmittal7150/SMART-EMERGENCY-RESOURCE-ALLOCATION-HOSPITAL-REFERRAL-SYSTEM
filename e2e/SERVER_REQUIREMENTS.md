# Server requirements from the frontend (Batch 3 input)

These are server changes the reworked UI (index.html, js/, css/) needs or benefits from. None were made in the
frontend work; the UI already works against the current server, except where marked **REQUIRED**.

## 1. Content-Security-Policy — REQUIRED for Batch 3 (enable in helmet)

The page now runs with no inline scripts, no inline event handlers, no `style=` attributes and no HTML injection of
server data. `e2e/frontend-smoke.mjs` serves it with exactly this header and fails on any violation; it passed with
zero violations (Chrome, 2026-11-11):

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js; style-src 'self' https://fonts.googleapis.com https://unpkg.com/leaflet@1.9.4/dist/leaflet.css; font-src https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Helmet configuration that produces it (`server/server.js`, replacing `contentSecurityPolicy: false`):

```js
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
```

Why each source is there:

| Directive | Source | Used by |
|---|---|---|
| script-src | `'self'` | `/js/*.js` (ES modules) and `/socket.io/socket.io.min.js` |
| script-src | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` | map; loaded with Subresource Integrity `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=` |
| style-src | `'self'` | `/css/*.css` |
| style-src | `https://fonts.googleapis.com` | `@import` of the Geist fonts in `css/main.css` |
| style-src | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` | map; SRI `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=` |
| font-src | `https://fonts.gstatic.com` | Geist font files |
| img-src | `data:` | favicon and two small SVGs in CSS |
| img-src | `https://tile.openstreetmap.org` | map tiles (`https://tile.openstreetmap.org/...` (tiles are requested with the page origin as Referer, as OSM requires)) |
| connect-src | `'self'` | REST `/api/v1/*` and the Socket.IO WebSocket on the same origin |

Notes:
- `useDefaults: false` keeps helmet from adding `upgrade-insecure-requests`, which would break a plain-HTTP deployment
  (for example a LAN demo). Add it only when the site is served over HTTPS.
- `connect-src 'self'` matching the same-origin `ws://` WebSocket was verified in Chrome only. If an older Safari must be
  supported and the socket is refused there, add the explicit `ws://<host>:<port>` / `wss://<host>` origin.
- JavaScript still sets a few CSS properties through the CSSOM (`element.style.x = …`: chart bar heights, the nav
  indicator, Leaflet's own positioning). CSP does not restrict CSSOM writes, so no `'unsafe-inline'` is needed.
- Leaflet stays on the CDN pinned by SRI because no local copy exists in `node_modules` and no new npm dependency was
  allowed. If the deployment must not reach the CDN, vendor `leaflet@1.9.4` (js + css) under `/js/vendor/` and replace
  the two unpkg sources with `'self'`. Without Leaflet the UI still works; the Map tab says the map is unavailable.

## 2. Socket.IO client must stay served by the server — REQUIRED (no change today)

The page loads `<script src="/socket.io/socket.io.min.js">` (same origin; the CDN copy is gone). Keep Socket.IO's
default `serveClient: true`. If it is disabled, the UI keeps working but shows "Live updates unavailable".

## 3. Per-user referral outcome event `referral:status` — REQUIRED for paramedic notifications

Problem: after the scoping fix, accept / reject / expiry events reach only the hospital room and `command_center`.
The paramedic who sent a referral hears nothing. The UI currently falls back to polling `GET /emergencies/:id` every
4 s for referrals initiated **in the current tab session**; a referral sent before a page reload is not followed.

Requested:

1. On socket connection, also join a per-user room:
   `socket.join(\`user:${socket.user.user_id}\`)` (every role).
2. Record who initiated each referral: store `initiated_by = req.user.user_id` on the HospitalAcceptance created by
   `POST /referrals/initiate` (MySQL: new nullable column via a migration; memory store: same field). An acceptance
   created by automatic failover (after reject or expiry) inherits `initiated_by` from the one it replaces.
3. Emit to `user:<initiated_by>` whenever such a referral changes state:

```
event:   referral:status
payload: {
  acceptance_id: string,            // the referral that changed
  request_id:    string,
  hospital_id:   string,
  status:        'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'PENDING',
  next_acceptance_id: string|null,  // failover referral created by the server, if any
  next_hospital_id:   string|null,
  ambulance_id:  string|null,       // on ACCEPTED: the auto-dispatched unit, if any
  at:            ISO-8601 string
}
```

   Emit points: `allocation_committed` (ACCEPTED), `lock_released` (REJECTED), `lock_expired` (EXPIRED), a case
   cancellation that cancels a pending referral (CANCELLED), and the failover lock itself (PENDING, with the new
   `acceptance_id`). No patient fields in the payload: the client fetches the case with its own token.

Client side (already implemented in `js/app.js`, `handleReferralStatus`): it starts following the acceptance,
re-reads the case and the queue, shows a toast and a live-event entry, and follows a failover referral. Once the event
exists, the 4 s poll becomes a fallback only.

## 4. Recommended (not blocking)

- **Assigned hospital in the case list.** `GET /emergencies` has `assigned_ambulance_id` but no hospital. The UI derives
  "Hospital" from `GET /referrals/history`. Adding `accepted_hospital_id` and `pending_hospital_id` to each list item
  would remove that call.
- **Scope `GET /referrals/history` for PARAMEDIC.** It returns every acceptance in the network to any authenticated
  user. With `initiated_by` (section 3) it could return only a paramedic's own referrals.
- **`Cache-Control: no-store` on `/api/*` responses** (patient data). The client already requests with
  `cache: 'no-store'`.
- **KPI field names.** `kpis:update` uses `critical_p1` and `ambulances_available`; `/analytics/dashboard` uses
  `critical_p1_waiting` and `available_ambulances`. The client maps both; aligning them would avoid the mapping.
- **`referral:incoming.remaining_sec`** is always 90. Sending the real remaining seconds (from the lock) would make a
  late-joining desk's first countdown exact; the client corrects itself on the next `referral:countdown` tick anyway.

## 5. What the UI calls (so backend changes keep these shapes)

| Call | Roles that use it in the UI |
|---|---|
| `POST /auth/login`, `GET /auth/me` (session restore) | all |
| `GET /hospitals`, `GET /emergencies`, `GET /emergencies/:id`, `GET /emergencies/:id/audit` | all (desk scoped by server) |
| `GET /ambulances`, `GET /doctors`, `GET /analytics/dashboard`, `GET /referrals/history` | all |
| `POST /emergencies` with `Idempotency-Key` (reads `Idempotent-Replayed`) | ADMIN, PARAMEDIC |
| `POST /referrals/initiate` | ADMIN, PARAMEDIC |
| `GET /referrals/active`, `POST /referrals/:id/accept`, `POST /referrals/:id/reject` | ADMIN, HOSPITAL_DESK |
| `PATCH /ambulances/:id/status` (DISPATCHED + request_id, IN_TRANSIT + eta_mins, AVAILABLE, MAINTENANCE) | ADMIN, PARAMEDIC, HOSPITAL_DESK (own station) |
| `PATCH /emergencies/:id/status` | ADMIN |
| `PATCH /hospitals/:id/status` | ADMIN |
| `POST /doctors`, `PATCH /doctors/:id/status` | ADMIN, HOSPITAL_DESK (own hospital) |
| `GET /analytics/referrals`, `GET /analytics/audit?limit=300`, `GET /analytics/history?days=`, `GET /analytics/forecast?history_days=28&horizon_days=7`, `GET /audit/verify` | ADMIN |

Socket events consumed: `kpis:update`, `locks:update` (after emitting `request:active_locks`), `referral:incoming`,
`referral:countdown`, `referral:accepted`, `referral:rejected`, `referral:expired`, `lock:acquired`, `lock:released`,
`lock:expired`, `lock:expired_cleanup`, `allocation:committed`, `alert:new`, `audit:entry`, and the proposed
`referral:status`. The client emits `request:kpis` and `request:active_locks` on every (re)connect and reloads its data
after a reconnect.
