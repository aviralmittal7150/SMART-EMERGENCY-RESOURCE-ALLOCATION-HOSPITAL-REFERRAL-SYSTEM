# ERIS Completion & Verification Status

Review date: 2026-11-16

## What was verified from this archive

- The ZIP extracts successfully.
- All 169 JavaScript source files pass `node --check` on Node.js 22.16.0.
- `index.html` parses successfully; 272 IDs were found and there are no duplicate IDs.
- 77 dependency-independent automated tests pass across triage, hospital ranking, Banker's Algorithm, compound claims, staged pathways, audit ledger, analytics engine, simulation utilities, Dehradun tracking geometry, and first-aid content.
- The Dehradun browser/server operating-area definitions match according to the pure tracking-path tests.

## What is not verified

- Full `npm test`: not passed. The archive's `node_modules` directory was incomplete in the review environment. The test run reported 127 passed and 106 failed; most blocked test files could not import missing packages such as `express`, `dotenv`, `cors`, and `bcryptjs`.
- A clean `npm ci` could not complete because this environment could not resolve `registry.npmjs.org` (DNS/network unavailable). This is an environment limitation, not evidence that the dependency declarations are wrong.
- The Express server could not start because `express` was unavailable. Consequently, live API, browser, Socket.IO, and Admin/Fleet/Hospital end-to-end flows have not been independently verified from this archive.
- MySQL integration tests and production deployment are not verified. They require a reachable MySQL instance and credentials/configuration.

## Local startup (demo mode)

Run from the project root on a machine with Node.js 20+ and working npm registry access:

```bash
npm ci
DB_USE_MEMORY=true NODE_ENV=development PORT=5050 FRONTEND_URL=http://localhost:5050 npm start
```

Open `http://localhost:5050`. Demo mode is in-memory and data is lost when the server restarts.

Demo accounts (fictional):

| Portal | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Hospital | `apex_desk` | `hospital123` |
| Fleet | `UNIT-402` | `paramedic123` |

## Required final acceptance checks on a network-enabled runtime

1. `npm ci` completes without errors.
2. `npm test` passes; investigate any genuine test failures separately from environment setup failures.
3. Start the server in demo mode and confirm `GET /health` returns HTTP 200.
4. Verify Admin login, incident creation, victim triage, referral, and ambulance assignment.
5. Verify Fleet login, assigned patient visibility, pickup, and simulated Dehradun route progression.
6. Verify Hospital login, referral acceptance, bed allocation, arrival/handover, treatment start, notes, completion, and resource release.
7. Verify role scoping: Admin sees network operations, Hospital sees only its own cases, Fleet sees only its assigned work.
8. Verify the UI map remains usable when external routing/tiles are unavailable and clearly labels simulated movement.
9. Run the MySQL suite against a disposable test database before claiming persistent-storage readiness.

## Important distinction

A successful syntax check or unit test does not establish that the complete application works end to end. This report deliberately separates verified source-level checks from live runtime checks that could not be run in the review environment.


## Additional implementation changes (2026-11-16)

This pass corrected product-scope mismatches found in the actual UI and API source:

- Emergency intake now presents only RED / YELLOW / GREEN. The existing internal numeric scheduling field is retained for stored-record compatibility: RED=1, YELLOW=3, GREEN=4.
- Fleet now opens on its Fleet workspace. Fleet users no longer see the incident registration workspace; the intake panel and case-registration navigation are Admin-only. Hospital users retain their own case/acceptance workspace.
- Admin-only server write permissions now protect emergency creation, referral initiation, and ambulance fleet-status administration. Hospital-specific treatment actions are Hospital-desk-only. Fleet transport/pickup remains on the tracking trip actions.
- Added `npm run verify:source`, a dependency-free source preflight that checks JavaScript syntax, duplicate HTML IDs, local script/style references, and the product-scope contract tests.
- Corrected the README's authoritative product-scope summary for the three roles, three triage colours, Dehradun simulated tracking, and offline Banker's teaching simulator.

Verification after these edits:

- `npm run verify:source`: PASS (3 product-scope contract tests; 170 JavaScript files syntax-checked; 272 HTML IDs checked; zero duplicates).
- Full `npm test`: still blocked by the incomplete `node_modules` tree. The latest run had 130 passing and 106 failures/blocked tests (236 total), predominantly import failures for missing Express, dotenv, UUID, JWT and bcrypt packages; API startup-dependent tests consequently cannot reach `/health`.
- `npm ci` cannot complete in this execution environment because DNS resolution for `registry.npmjs.org` fails.

The archive is not labelled end-to-end complete: live server startup, browser journeys, and MySQL integration remain unverified until dependencies are installed in a network-enabled environment.


## Offline simulated-data configuration (2026-11-16)

- ERIS demo operations use fictional patients, incidents, hospitals, doctors, ambulance units, beds, and treatment records within the Dehradun operating area. Dehradun locality coordinates are used only as a geographic frame; no live GPS or live facility feeds are used.
- External OSRM routing is now disabled by default in both development and production. The existing local deterministic straight-line route simulator is used instead. An external routing URL is opt-in only.
- OpenStreetMap raster tiles are no longer requested. Both map panels use a local schematic grid with the project's simulated markers and route overlays.
- Updated the map accessible label and caption to state that locations and movement are simulated.
- `npm run verify:source` passes: 3/3 product-scope tests, 184 JavaScript files syntax-checked, 272 HTML IDs checked, no duplicate IDs, all local script/style references resolved.
- Full backend integration remains unverified in this environment because required npm dependencies (including Express) are not installed and the npm registry cannot be reached here. The Leaflet library itself is still loaded from its pinned CDN, so a completely disconnected browser will need that library vendored locally for the map UI; the underlying simulated data and routing do not require external services.
