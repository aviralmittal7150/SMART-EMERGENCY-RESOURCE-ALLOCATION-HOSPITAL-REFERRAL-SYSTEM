# Database migrations

Schema changes for the MySQL store, applied in order by the migration runner
(`server/db/migrate.js`). The application never migrates by itself: at start-up it refuses to run while
any migration is pending, failed or edited, and names the problem.

| File | Change |
|---|---|
| `001_referral_lifecycle.sql` | Ambulance assignment columns, `CANCELLED` referral status, requirement columns, audit rows outlive their case |
| `002_idempotency_keys.sql` | `IdempotencyKey` table |
| `003_schema_migration.sql` | `SchemaMigration` bookkeeping table used by the runner |
| `004_doctor_assignment.sql` | `Doctor.availability_status` gains `RESERVED` / `ASSIGNED`; `DoctorAssignment` table (exclusive specialist reservations, Phase 3 Step 3) |
| `005_staged_claims.sql` | `RequestClaim` table (maximum claim per case and treatment stage); `EmergencyRequest.current_stage`; `ResourceAllocation.stage_no`; `Hospital.safety_state`; single-stage claims backfilled for open cases (Phase 3 Step 4) |
| `006_audit_chain.sql` | `EmergencyHistory.chain_seq` / `prev_hash` / `row_hash` / `event_time_ms`; `AuditChainHead` (the tamper-evident audit hash chain, Phase 3 Step 5) |
| `007_analytics_integrity.sql` | `EmergencyRequest.is_demo` (the three demo cases backfilled); `EmergencyRequest.request_time` becomes `TIMESTAMP(3)`; index `HospitalAcceptance.idx_created_at`; `AuditChainHead.legacy_max_history_id` / `legacy_count` recorded from the pre-chain audit rows (review round 1: S1, S3, S4, S6, A3) |
| `008_accounts_and_scoping.sql` | `SystemUser.display_name` / `ambulance_id` (FK `fk_user_ambulance`) / `is_demo`, case-sensitive `username`; `HospitalAcceptance.initiated_by`; `EmergencyRequest.created_by` (backfilled from the `REQUEST_CREATED` audit row); case-sensitive `IdempotencyKey.idem_key` (review round 1: X2, X4, X5, X11, B1-R1) |
| `009_portal_roles.sql` | `SystemUser.role` gains `DISPATCHER` and `PATIENT`; `SystemUser.patient_id` (FK `fk_user_patient`, index `idx_patient`) links a patient account to its patient (Batch 6, portals) |
| `010_ambulance_trips.sql` | `AmbulanceTrip` table: simulated ambulance trips for the live-tracking demo, at most one active trip per ambulance and per case (Batch 7) |
| `011_incidents.sql` | Batch 8: `Incident`, `TreatmentUpdate` and `AmbulanceAssignment` tables; `Patient.age` NULLable; `EmergencyRequest` incident link, triage category, hospital milestones and the unique open-bed key; `Ambulance.capacity` |

The notes inside 001 and 002 about running them by hand date from before the runner. They are kept
unchanged on purpose: an applied migration file must never be edited (the runner checks a SHA-256 of
each file it applied).

## Commands

```
npm run db:migrate                         # apply pending migrations, in order
npm run db:migrate -- --status             # show applied / pending; changes nothing
npm run db:migrate -- --dry-run            # show what would be applied; changes nothing
```

Connection settings come from `DB_*` (see `.env.example`). Run the runner only against the database you
intend to change, and take a backup first: MySQL DDL is not transactional.

## Which situation are you in?

- **New, empty database:** `npm run db:init` (optionally `npm run db:seed`). `schema.sql` already contains
  every migration and records them as `BASELINE`, so `db:migrate` then reports "up to date".
- **Database created before the runner existed** (no `SchemaMigration` table; the server refuses to start
  and asks for it): declare once what it already has, then the runner applies the rest.
  - It started cleanly before the runner existed (001 and 002 applied): `npm run db:migrate -- --baseline 002`
    (the runner then applies every later migration, 003 onwards, in order)
  - It predates 001 entirely: `npm run db:migrate -- --baseline none`
  The runner refuses to guess, and `db:init` refuses to run over such a database (it would record
  migrations it never applied).
- **Database already managed by the runner:** `npm run db:migrate`. `db:init` refuses such a database unless it
  already records every migration file (then it changes nothing): running `schema.sql` over it would record the
  missing migrations as `BASELINE` without running their `ALTER`s. The start-up check (`checkSchema`) also requires
  the columns added by 004-011 (and the 010 and 011 tables) themselves, not only their bookkeeping rows.

## When a migration fails

The runner records each statement as it completes. On failure the migration is marked `FAILED` with the
number of statements that completed, the runner stops, and the server refuses to start. Nothing is re-run
automatically. Resolve it in one of two ways:

1. Finish the remaining statements by hand, then `npm run db:migrate -- --mark-applied <version>`.
2. Undo the completed statements (restore the previous state), fix the cause, then
   `npm run db:migrate -- --retry <version>` and run `npm run db:migrate` again; it starts from statement 1.

A migration left `RUNNING` (the process was killed) is resolved the same way.

## Migration 004: compatibility and manual rollback

**Compatibility.** Code from this release refuses to start until 004 is applied (it is reported as
pending). Code from an earlier release refuses to start on a database where 004 *is* applied (the runner
reports a migration unknown to that code). So code and schema move together: upgrade = deploy, then
`npm run db:migrate`; rollback = the steps below, then deploy the earlier code.

The ENUM change only appends values, so existing `Doctor` rows are untouched. `DoctorAssignment.doctor_id`
uses `ON DELETE RESTRICT` (MySQL does not allow a cascading action on the base column of the stored
generated column `active_doctor_id`): a doctor with assignment history cannot be deleted. The API refuses
such a removal with 409 and asks for `OFF_DUTY` instead.

**Manual rollback** (there is no automatic down-migration). Stop the application first, take a backup
(at least `mysqldump <db> DoctorAssignment Doctor`), then:

```sql
-- 1. Doctors held by a referral or a case go back to AVAILABLE. Earlier code does not model these holds,
--    so a case that is ALLOCATED keeps its beds but no longer "owns" its surgeon.
UPDATE Doctor SET availability_status = 'AVAILABLE' WHERE availability_status IN ('RESERVED', 'ASSIGNED');
-- 2. Remove the table (its history is in the backup and in the EmergencyHistory audit rows).
DROP TABLE DoctorAssignment;
-- 3. Restore the previous ENUM (fails if any row still uses a removed value, which step 1 prevents).
ALTER TABLE Doctor MODIFY availability_status ENUM('AVAILABLE','IN_PROCEDURE','OFF_DUTY') NOT NULL DEFAULT 'AVAILABLE';
-- 4. Forget the migration, so the earlier code's runner finds the database as it expects.
DELETE FROM SchemaMigration WHERE version = '004_doctor_assignment';
```

If 004 failed after statement 1 (the ENUM change), only steps 1, 3 and 4 apply; or fix the cause and use
`--retry` as described above (statement 1 is safe to repeat).

## Migration 005: compatibility and manual rollback

**What it changes.** 005 creates `RequestClaim`, adds `EmergencyRequest.current_stage` (default 1),
`ResourceAllocation.stage_no` (default 1) and `Hospital.safety_state` (default `SAFE`), and backfills a
single-stage claim for every open case (D2-a10): a case holding resources or a surgeon claims exactly what
it holds; a case holding nothing claims its recorded requirement. Closed cases get no claim. A case with no
claim at all (for example one inserted by hand later) is treated as a legacy single-stage case.

**Compatibility.** As for 004: Step 4 code refuses a database without 005 (pending), and Step 3 code refuses
one with 005 applied (a migration unknown to it). Roll back 006 (if applied) before 005, and 005 before 004.

**Manual rollback of 005.** Stop the application and back up `RequestClaim` first, then:

```sql
-- Claims and stage numbers are dropped. Allocations a case holds stay valid: earlier code treats every
-- allocation as single-stage and releases it when the case completes or is cancelled.
DROP TABLE RequestClaim;
ALTER TABLE EmergencyRequest DROP COLUMN current_stage;
ALTER TABLE ResourceAllocation DROP COLUMN stage_no;
ALTER TABLE Hospital DROP COLUMN safety_state;
DELETE FROM SchemaMigration WHERE version = '005_staged_claims';
```

## Migration 006: compatibility and manual rollback

**What it changes.** 006 adds the hash-chain columns to `EmergencyHistory` (`chain_seq`, unique; `prev_hash`;
`row_hash`; `event_time_ms`) and creates `AuditChainHead`, a single row holding the last `chain_seq` and its hash.
From then on every audit row is chained as the last step of its transaction (see `server/services/auditChain.js`).
Rows written before 006 keep `chain_seq` NULL: integrity is claimed only from the first chained row on, and
`GET /api/v1/audit/verify` reports how many such rows exist (`legacy_unchained`).

**No triggers.** Making the table append-only with triggers needs the SUPER privilege while binary logging is on
(the MySQL 8+ default), which the application account must not have. Instead, give the application account no
`UPDATE` or `DELETE` on `EmergencyHistory` (Phase 3 production hardening); any edit made anyway is detected by
verification.

**Compatibility.** As for 004 and 005: Step 5 code refuses a database without 006 (pending), and earlier code
refuses one with 006 applied. Roll back 007 (if applied) before 006, and 006 before 005.

**Manual rollback of 006.** Stop the application and back up `EmergencyHistory` and `AuditChainHead` first (the
hashes are the integrity evidence), then:

```sql
-- The audit rows themselves stay; only their chain columns and the head go.
DROP TABLE AuditChainHead;
ALTER TABLE EmergencyHistory DROP INDEX uq_chain_seq;
ALTER TABLE EmergencyHistory DROP COLUMN chain_seq, DROP COLUMN prev_hash, DROP COLUMN row_hash, DROP COLUMN event_time_ms;
DELETE FROM SchemaMigration WHERE version = '006_audit_chain';
```

## Migration 007: compatibility and manual rollback

**What it changes.** 007 adds `EmergencyRequest.is_demo` (`TINYINT(1) NOT NULL DEFAULT 0`) and marks the three
demo cases of the demo seed (`REQ-8901`/`8902`/`8903`, only while owned by `PAT-001`/`002`/`003`) as demo, so observed
analytics leave them out (S1). It changes `EmergencyRequest.request_time` to `TIMESTAMP(3)` (default
`CURRENT_TIMESTAMP(3)`), so request times keep milliseconds like the in-memory store (S3) and same-second queue ties
are ordered by real arrival (S6); existing values keep their whole second. It adds the index `idx_created_at` on
`HospitalAcceptance(created_at)`, which history windows filter on (S4). Finally it adds
`AuditChainHead.legacy_max_history_id` and `legacy_count` and records, once, the legacy audit rows as they are when
it runs: rows without `chain_seq` stored before the first chained row (all unchained rows if nothing is chained yet).
Audit verification then reports any other unchained row as `UNCHAINED_ROW`, including one inserted later with an
explicit `history_id` into a gap among the legacy ids (A3). A fresh database records none (`legacy_count` 0,
`legacy_max_history_id` NULL). Five statements.

**Compatibility.** As before: this release refuses a database without 007 (pending, and `checkSchema` names
`EmergencyRequest.is_demo` and the `request_time` precision), and earlier code refuses one with 007 applied. Roll
back 007 before 006.

**Manual rollback of 007.** Stop the application and back up `EmergencyRequest` first, then:

```sql
-- Request times lose their milliseconds (rounded to the second); the demo flag goes (the demo rows themselves stay);
-- the recorded legacy mark goes (006 code derives legacy rows from the first chained row again).
ALTER TABLE AuditChainHead DROP COLUMN legacy_max_history_id, DROP COLUMN legacy_count;
ALTER TABLE HospitalAcceptance DROP INDEX idx_created_at;
ALTER TABLE EmergencyRequest DROP COLUMN is_demo, MODIFY COLUMN request_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
DELETE FROM SchemaMigration WHERE version = '007_analytics_integrity';
```

This rollback is exercised by `tests/mysql_migration_runner.test.js` (008, 007, then 006, 005 and 004, then forward again).

## Migration 008: compatibility and manual rollback

**What it changes.** 008 makes `SystemUser` hold the real login accounts (review finding X2): it adds `display_name`,
`ambulance_id` (the unit a `PARAMEDIC` account crews, X4; foreign key `fk_user_ambulance`, `ON DELETE SET NULL`) and
`is_demo` (`TINYINT(1) NOT NULL DEFAULT 0`; demo accounts are refused at login when `NODE_ENV=production`), and gives
`username` a binary collation, so usernames compare case-sensitively exactly as in the in-memory store. It adds
`HospitalAcceptance.initiated_by` (the user who sent a referral; a failover referral inherits it; it scopes
`GET /referrals/history` for paramedics and addresses the `referral:status` socket event; existing referrals keep NULL
because who sent them was never recorded) and `EmergencyRequest.created_by` (the user who registered the case; paramedics
see their own cases), backfilled from each case's first `REQUEST_CREATED` audit row (`updated_at` is not touched).
Finally `IdempotencyKey.idem_key` gets a binary collation: keys compare case-sensitively, as in memory (X11). Five
statements. Accounts are created with `npm run user:create` (bcrypt); `db:seed` adds the fictional demo accounts only
outside production.

**Compatibility.** As before: this release refuses a database without 008 (pending, and `checkSchema` names the
`SystemUser`, `HospitalAcceptance` and `EmergencyRequest` columns), and earlier code refuses one with 008 applied. Roll back
008 before 007.

**Manual rollback of 008.** Stop the application and back up `SystemUser`, `HospitalAcceptance`, `EmergencyRequest` and
`IdempotencyKey` first, then:

```sql
-- Idempotency keys only need to outlive client retries (24 h); they are dropped so that two keys differing only in
-- letter case cannot collide when the column goes back to the case-insensitive collation. The accounts stay (their
-- display names, unit bindings and demo flags go; earlier code does not read them).
DELETE FROM IdempotencyKey;
ALTER TABLE IdempotencyKey MODIFY COLUMN idem_key VARCHAR(100) NOT NULL;
ALTER TABLE EmergencyRequest DROP INDEX idx_created_by, DROP COLUMN created_by;
ALTER TABLE HospitalAcceptance DROP INDEX idx_initiated_by, DROP COLUMN initiated_by;
ALTER TABLE SystemUser DROP FOREIGN KEY fk_user_ambulance;
ALTER TABLE SystemUser DROP COLUMN ambulance_id, DROP COLUMN is_demo, DROP COLUMN display_name, MODIFY COLUMN username VARCHAR(80) NOT NULL;
DELETE FROM SchemaMigration WHERE version = '008_accounts_and_scoping';
```

The last `ALTER` fails if two accounts differ only in letter case (allowed after 008, not before): rename one first.
This rollback is exercised by `tests/mysql_migration_runner.test.js`. Roll back 009 (if applied) before 008.

## Migration 009: compatibility and manual rollback

**What it changes.** 009 (Batch 6, portals) adds two account roles to `SystemUser.role`: `DISPATCHER` (the
command-centre operator) and `PATIENT` (the read-only patient portal), and `SystemUser.patient_id`
(`VARCHAR(20) NULL`, foreign key `fk_user_patient` to `Patient` with `ON DELETE SET NULL`, index `idx_patient`), the
patient whose cases a `PATIENT` account may read. The rules between role and links (a `PATIENT` needs `patient_id`, a
`HOSPITAL_DESK` needs `hospital_id`, only a `PATIENT` carries `patient_id`) are enforced by the application
(`server/services/accounts.js`), in both stores. It adds `SystemUser.token_version` (`INT UNSIGNED NOT NULL DEFAULT 0`):
every token carries the version it was issued under, and a password reset, a deactivation or a role / link change
raises it, so all older tokens are refused on REST and sockets. It also adds `DISPATCHER` to
`EmergencyHistory.actor_role`, so a dispatcher's actions are audited under their own role (a patient never writes).
Two statements. Admins may link several PATIENT accounts to one patient record; note that every intake
(`POST /emergencies`) creates a new patient row, so a patient account sees only the cases of the record it is linked to.

**Compatibility.** As before: this release refuses a database without 009 (pending, and `checkSchema` names
`SystemUser.patient_id`), and earlier code refuses one with 009 applied. Roll back 009 before 008.

**Manual rollback of 009.** Stop the application and back up `SystemUser` first (the dispatcher and patient accounts
are deleted: earlier code cannot represent them), then:

```sql
-- Accounts with the new roles cannot exist in earlier code; they are in the backup.
DELETE FROM SystemUser WHERE role IN ('DISPATCHER', 'PATIENT');
ALTER TABLE SystemUser DROP FOREIGN KEY fk_user_patient;
ALTER TABLE SystemUser DROP INDEX idx_patient, DROP COLUMN patient_id, DROP COLUMN token_version, MODIFY COLUMN role ENUM('ADMIN','HOSPITAL_DESK','PARAMEDIC') NOT NULL;
DELETE FROM SchemaMigration WHERE version = '009_portal_roles';
```

`EmergencyHistory.actor_role` deliberately keeps `DISPATCHER`: audit rows are immutable (hash chain) and must not be
rewritten, and earlier code only reads the value. Re-applying 009 later is a no-op for that column.

This rollback is exercised by `tests/mysql_migration_runner.test.js` (009 first, then 008 down to 004, then forward again).

## Migration 010: compatibility and manual rollback

**What it changes.** 010 (Batch 7, ambulance live-tracking demo) adds one table, `AmbulanceTrip`: a simulated trip of
one ambulance from its start position to the case's pickup point (`EmergencyRequest.pickup_lat` / `pickup_lng`) and on
to the hospital that accepted the case (`Hospital.location_lat` / `location_lng`). The patient, pickup and hospital
positions are not copied into it; the routes (`route_to_patient`, `route_to_hospital`: JSON arrays of `[lat, lng]`),
`route_source` (`osrm` or `simulated`), `phase`, `progress` (0-1 within the current leg), the live position, ETA,
`paused`, `is_demo`, `created_by`, an optimistic-concurrency `version` and the phase timestamps are. The tracking engine
also writes the live position to the existing `Ambulance.current_lat` / `current_lng` / `eta_mins`. At most one active
trip (`completed_at IS NULL`) per ambulance and per case is a database guarantee: unique keys
`uq_trip_active_ambulance` / `uq_trip_active_request` on the stored generated columns `active_ambulance_id` /
`active_request_id`. Its foreign keys (`fk_trip_request`, `fk_trip_ambulance`, `fk_trip_hospital`) are `ON DELETE
RESTRICT`. One statement; no existing table changes.

**Compatibility.** This release refuses a database without 010 (pending, and `checkSchema` names the missing table
`AmbulanceTrip`); earlier code refuses one with 010 applied (unknown migration). Roll back 010 before 009.

**Manual rollback of 010.** Stop the application and back up `AmbulanceTrip` first (the trips are lost), then:

```sql
-- The trips go; their audit rows (TRIP_* events in EmergencyHistory) stay: audit rows are immutable (hash chain).
-- Ambulances keep their last position. Cases and their allocations are untouched.
DROP TABLE IF EXISTS AmbulanceTrip;
DELETE FROM SchemaMigration WHERE version = '010_ambulance_trips';
```

This rollback is exercised by `tests/mysql_migration_runner.test.js` (010 first, then 009 down to 004, then forward again).

## Migration 011: compatibility and manual rollback

**What it changes.** 011 (Batch 8: the hospital treatment workflow and mass-casualty incidents), six statements:
`Incident` (a mass-casualty incident: title, `incident_type`, location, `severity`, estimates, `is_demo`);
`Patient.age` becomes NULLable (an unidentified victim's age may be unknown); `EmergencyRequest` gains `incident_id`
(FK `fk_request_incident`, RESTRICT) and `incident_seq` (unique per incident: `uq_incident_seq`; anonymous victims are
labelled MCI-001...), `triage_category` (RED / YELLOW / GREEN), the hospital milestones `arrived_at`, `bed_label` /
`bed_hospital_id` / `bed_allocated_at`, `treatment_started_at`, `treatment_completed_at`, `dispatch_ambulance_id` (the unit the admin chose at dispatch), and the stored generated column
`active_bed_key` whose unique key `uq_active_bed` makes a bed label unique among a hospital's open cases (two desks
allocating one bed at once: exactly one wins); `TreatmentUpdate` (hospital progress notes); `Ambulance.capacity` (1-4,
default 1, check `chk_ambulance_capacity`); `AmbulanceAssignment` (one row per patient a unit carries; at most one active
assignment per case: `uq_assignment_active_request` on the generated `active_request_id`). Existing rows keep NULL / the
defaults. The in-memory store mirrors all of it.

**Compatibility.** This release refuses a database without 011 (pending, and `checkSchema` names the missing tables
`Incident`, `TreatmentUpdate`, `AmbulanceAssignment` and the new `EmergencyRequest` / `Ambulance` columns); earlier code
refuses one with 011 applied (unknown migration). Roll back 011 before 010.

**Manual rollback of 011.** Stop the application and back up `Incident`, `TreatmentUpdate`, `AmbulanceAssignment`,
`EmergencyRequest`, `Patient` and `Ambulance` first, then:

```sql
-- Notes, seat history, incidents and milestones are lost (they are in the backup); the cases themselves stay, and the
-- audit rows of every step stay: audit rows are immutable (hash chain). Earlier code cannot represent an unknown age,
-- so those patients get age 0 (restore from the backup if you roll forward again).
DROP TABLE IF EXISTS AmbulanceAssignment;
DROP TABLE IF EXISTS TreatmentUpdate;
ALTER TABLE Ambulance DROP CHECK chk_ambulance_capacity, DROP COLUMN capacity;
ALTER TABLE EmergencyRequest DROP FOREIGN KEY fk_request_incident;
ALTER TABLE EmergencyRequest DROP INDEX uq_active_bed, DROP INDEX uq_incident_seq, DROP COLUMN active_bed_key, DROP COLUMN incident_id, DROP COLUMN incident_seq, DROP COLUMN triage_category, DROP COLUMN arrived_at, DROP COLUMN bed_label, DROP COLUMN bed_hospital_id, DROP COLUMN bed_allocated_at, DROP COLUMN treatment_started_at, DROP COLUMN treatment_completed_at, DROP COLUMN dispatch_ambulance_id;
UPDATE Patient SET age = 0 WHERE age IS NULL;
ALTER TABLE Patient MODIFY COLUMN age TINYINT UNSIGNED NOT NULL;
DROP TABLE IF EXISTS Incident;
DELETE FROM SchemaMigration WHERE version = '011_incidents';
```

This rollback is exercised by `tests/mysql_migration_runner.test.js` (011 first, then 010 down to 004, then forward again).

## Adding a migration

1. Add `server/db/migrations/NNN_short_name.sql` with the next number (numbers are contiguous from 001;
   a gap, a duplicate or a lower number than an applied migration is refused).
2. Apply the same change to `server/db/schema.sql` and add `('NNN_short_name', 'BASELINE')` to its
   `INSERT IGNORE INTO SchemaMigration` list. `tests/migration_runner.test.js` fails until you do.
3. Extend `checkSchema` in `server/db/bootstrap.js` only if the code needs a specific column or table to
   start safely; pending migrations are already reported generically.
4. Prove it in `tests/mysql_migration_runner.test.js` / `tests/mysql_migration.test.js` (upgraded database
   identical to a fresh one, data kept). Never edit a migration once it has been applied anywhere.
