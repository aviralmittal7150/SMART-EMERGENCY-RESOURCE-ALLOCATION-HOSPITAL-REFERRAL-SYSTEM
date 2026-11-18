-- ============================================================
-- SMART EMERGENCY RESOURCE ALLOCATION & HOSPITAL REFERRAL SYSTEM
-- MySQL Schema — Phase 2 DBMS Layer
-- 10 Normalized Tables with Foreign Keys, Indexes & ACID Support
-- Used by the application in MySQL mode (DB_USE_MEMORY=false) via `node server/db/init.js`,
-- and loaded against a real MySQL server by the tests/mysql_*.test.js suites and CI.
-- Existing databases are upgraded with the migration runner (`npm run db:migrate`, server/db/migrate.js),
-- which applies the additive scripts in server/db/migrations/ in order.
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ─────────────────────────────────────────────────────────────
-- Table 1: Hospital
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Hospital (
  hospital_id        VARCHAR(20)  PRIMARY KEY,
  hospital_name      VARCHAR(200) NOT NULL,
  address            VARCHAR(300) NOT NULL,
  location_lat       DECIMAL(10, 7) NOT NULL,
  location_lng       DECIMAL(10, 7) NOT NULL,
  contact_phone      VARCHAR(30)  NOT NULL,
  trauma_level       VARCHAR(150),
  emergency_status   ENUM('OPEN', 'LIMITED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
  acceptance_rate    DECIMAL(5, 4) NOT NULL DEFAULT 0.80,
  avg_response_sec   INT          NOT NULL DEFAULT 60,
  rating             DECIMAL(3, 1) NOT NULL DEFAULT 4.0,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  safety_state       ENUM('SAFE','UNSAFE') NOT NULL DEFAULT 'SAFE' COMMENT 'Banker''s safety flag (D5-A)',
  INDEX idx_emergency_status (emergency_status),
  INDEX idx_rating (rating)
);

-- ─────────────────────────────────────────────────────────────
-- Table 2: Doctor
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Doctor (
  doctor_id          VARCHAR(20)  PRIMARY KEY,
  hospital_id        VARCHAR(20)  NOT NULL,
  full_name          VARCHAR(150) NOT NULL,
  specialization     ENUM('CARDIOLOGIST','NEUROLOGIST','TRAUMA_SURGEON','PEDIATRICIAN','GENERAL_ER') NOT NULL,
  availability_status ENUM('AVAILABLE','IN_PROCEDURE','OFF_DUTY','RESERVED','ASSIGNED') NOT NULL DEFAULT 'AVAILABLE',
  shift_start        TIME,
  shift_end          TIME,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  INDEX idx_hospital_spec (hospital_id, specialization),
  INDEX idx_availability (availability_status)
);

-- ─────────────────────────────────────────────────────────────
-- Table 3: MedicalResource
-- Row-level locking anchor: SELECT ... FOR UPDATE on this table
-- version_lock implements optimistic concurrency control
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS MedicalResource (
  resource_id        VARCHAR(30)  PRIMARY KEY,
  hospital_id        VARCHAR(20)  NOT NULL,
  resource_type      ENUM('ICU_BED','VENTILATOR','OT','AMBULANCE') NOT NULL,
  total_capacity     INT          NOT NULL DEFAULT 0,
  available_capacity INT          NOT NULL DEFAULT 0,
  locked_capacity    INT          NOT NULL DEFAULT 0,
  version_lock       BIGINT       NOT NULL DEFAULT 0,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  INDEX idx_hospital_type (hospital_id, resource_type),
  INDEX idx_available (available_capacity),
  CONSTRAINT chk_capacity CHECK (available_capacity >= 0 AND locked_capacity >= 0 AND total_capacity >= 0)
);

-- ─────────────────────────────────────────────────────────────
-- Table 4: Patient
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Patient (
  patient_id         VARCHAR(20)  PRIMARY KEY,
  full_name          VARCHAR(150) NOT NULL,
  age                TINYINT UNSIGNED NULL COMMENT 'NULL = unknown (e.g. an unidentified incident victim)',
  gender             ENUM('MALE','FEMALE','OTHER','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  emergency_type     VARCHAR(50)  NOT NULL,
  triage_priority    TINYINT      NOT NULL DEFAULT 3 COMMENT '1=Resuscitation, 2=Emergent, 3=Urgent, 4=Semi-Urgent, 5=Non-Urgent',
  contact_phone      VARCHAR(30),
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_triage (triage_priority),
  CONSTRAINT chk_triage CHECK (triage_priority BETWEEN 1 AND 5)
);

-- ─────────────────────────────────────────────────────────────
-- Table 18: Incident (migration 011)
-- A mass-casualty incident (e.g. a bus crash) with many victims; EmergencyRequest.incident_id links its cases
-- (fk_request_incident). Identical to migrations/011; defined before EmergencyRequest, which references it.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Incident (
  incident_id        VARCHAR(30)  NOT NULL PRIMARY KEY COMMENT 'INC-YYYYMMDD-NNN',
  title              VARCHAR(150) NOT NULL,
  incident_type      ENUM('bus_crash','train_accident','building_collapse','fire','industrial_accident','road_accident','other') NOT NULL,
  location_text      VARCHAR(255) NULL,
  location_lat       DECIMAL(10, 7) NOT NULL,
  location_lng       DECIMAL(10, 7) NOT NULL,
  description        VARCHAR(2000) NULL,
  estimated_victims  SMALLINT UNSIGNED NULL,
  vehicles_involved  SMALLINT UNSIGNED NULL,
  severity           ENUM('low','moderate','high','critical') NOT NULL,
  occurred_at        TIMESTAMP(3) NULL,
  created_by         VARCHAR(30)  NULL COMMENT 'user_id that registered the incident',
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_demo            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = the demo incident (POST /incidents/demo-setup)',
  INDEX idx_incident_created_at (created_at)
);

-- ─────────────────────────────────────────────────────────────
-- Table 5: EmergencyRequest
-- OS Process Lifecycle: NEW -> WAITING -> ALLOCATED -> IN_TREATMENT -> COMPLETED | CANCELLED
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS EmergencyRequest (
  request_id         VARCHAR(20)  PRIMARY KEY,
  patient_id         VARCHAR(20)  NOT NULL,
  emergency_type     VARCHAR(50)  NOT NULL,
  required_resources JSON,
  required_specialist VARCHAR(40),
  priority           TINYINT      NOT NULL DEFAULT 3,
  pickup_lat         DECIMAL(10, 7),
  pickup_lng         DECIMAL(10, 7),
  clinical_notes     TEXT,
  status             ENUM('NEW','WAITING','MATCHING','ALLOCATED','IN_TREATMENT','COMPLETED','CANCELLED') NOT NULL DEFAULT 'NEW',
  request_time       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  current_stage      TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Treatment stage of the case (staged claims)',
  is_demo            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = fictional demo case, excluded from observed analytics',
  created_by         VARCHAR(30)  NULL COMMENT 'user_id that registered the case',
  incident_id        VARCHAR(30)  NULL COMMENT 'The mass-casualty incident of the case (NULL: a single case)',
  incident_seq       SMALLINT UNSIGNED NULL COMMENT 'Victim number within the incident (anonymous label MCI-NNN)',
  triage_category    ENUM('RED','YELLOW','GREEN') NULL COMMENT 'Incident triage (decision support)',
  arrived_at         TIMESTAMP(3) NULL COMMENT 'The receiving hospital confirmed arrival (ambulance handover)',
  bed_label          VARCHAR(30)  NULL,
  bed_hospital_id    VARCHAR(20)  NULL,
  bed_allocated_at   TIMESTAMP(3) NULL,
  treatment_started_at TIMESTAMP(3) NULL,
  treatment_completed_at TIMESTAMP(3) NULL,
  dispatch_ambulance_id VARCHAR(20) NULL COMMENT 'The unit the admin chose at dispatch (preferred when the hospital accepts)',
  active_bed_key     VARCHAR(60) GENERATED ALWAYS AS (
    IF(bed_label IS NULL OR status IN ('COMPLETED', 'CANCELLED'), NULL, CONCAT(bed_hospital_id, '|', UPPER(bed_label)))) STORED,
  FOREIGN KEY (patient_id) REFERENCES Patient(patient_id) ON DELETE RESTRICT,
  INDEX idx_status_priority (status, priority),
  INDEX idx_request_time (request_time),
  INDEX idx_created_by (created_by),
  UNIQUE KEY uq_incident_seq (incident_id, incident_seq),
  UNIQUE KEY uq_active_bed (active_bed_key),
  CONSTRAINT fk_request_incident FOREIGN KEY (incident_id) REFERENCES Incident(incident_id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────
-- Table 6: HospitalAcceptance
-- 90-second TTL soft-lock handshake record
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS HospitalAcceptance (
  acceptance_id      VARCHAR(30)  PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL,
  status             ENUM('PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  response_time_sec  INT,
  rejection_reason   VARCHAR(300),
  lock_expires_at    TIMESTAMP    NOT NULL,
  responded_at       TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  initiated_by       VARCHAR(30)  NULL COMMENT 'user_id that sent the referral; a failover referral inherits it',
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  INDEX idx_request (request_id),
  INDEX idx_status (status),
  INDEX idx_expires (lock_expires_at),
  INDEX idx_created_at (created_at),
  INDEX idx_initiated_by (initiated_by)
);

-- ─────────────────────────────────────────────────────────────
-- Table 7: ResourceAllocation
-- Committed allocation record after acceptance
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ResourceAllocation (
  allocation_id      VARCHAR(30)  PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL,
  resource_id        VARCHAR(30)  NOT NULL,
  status             ENUM('LOCKED','COMMITTED','RELEASED') NOT NULL DEFAULT 'LOCKED',
  allocated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at        TIMESTAMP,
  stage_no           TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Treatment stage this allocation belongs to',
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES MedicalResource(resource_id) ON DELETE CASCADE,
  INDEX idx_request_status (request_id, status),
  INDEX idx_resource (resource_id)
);

-- ─────────────────────────────────────────────────────────────
-- Table 8: Ambulance
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Ambulance (
  ambulance_id       VARCHAR(20)  PRIMARY KEY,
  hospital_id        VARCHAR(20)  NOT NULL,
  vehicle_number     VARCHAR(30)  NOT NULL,
  ambulance_type     ENUM('ALS','BLS') NOT NULL DEFAULT 'BLS',
  status             ENUM('AVAILABLE','DISPATCHED','IN_TRANSIT','MAINTENANCE') NOT NULL DEFAULT 'AVAILABLE',
  current_lat        DECIMAL(10, 7),
  current_lng        DECIMAL(10, 7),
  eta_mins           SMALLINT,
  assigned_request_id     VARCHAR(20) NULL COMMENT 'Case this unit is dispatched to (set on referral acceptance)',
  destination_hospital_id VARCHAR(20) NULL,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  capacity           TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Patients the unit may carry (1-4)',
  CONSTRAINT chk_ambulance_capacity CHECK (capacity BETWEEN 1 AND 4),
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  -- Named as migration 001 names it, so a fresh database and an upgraded one have the same constraint.
  CONSTRAINT fk_ambulance_assigned_request FOREIGN KEY (assigned_request_id) REFERENCES EmergencyRequest(request_id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_hospital (hospital_id),
  INDEX idx_assigned_request (assigned_request_id)
);

-- ─────────────────────────────────────────────────────────────
-- Table 9: EmergencyHistory (Immutable Audit Ledger)
-- Append-only: no UPDATE or DELETE permitted (enforced via app logic)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS EmergencyHistory (
  history_id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
  request_id         VARCHAR(20)  NULL,
  hospital_id        VARCHAR(20),
  event_type         VARCHAR(80)  NOT NULL COMMENT 'e.g. STATUS_CHANGE, LOCK_ACQUIRED, ALLOCATION_COMMITTED, RESOURCE_RELEASED',
  previous_state     VARCHAR(50),
  new_state          VARCHAR(50),
  actor_role         ENUM('SYSTEM','ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER') NOT NULL DEFAULT 'SYSTEM',
  actor_id           VARCHAR(80),
  metadata           JSON,
  event_time         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  chain_seq          BIGINT UNSIGNED NULL COMMENT 'Position in the audit hash chain (NULL = written before migration 006)',
  prev_hash          CHAR(64) NULL COMMENT 'row_hash of the previous chained row (64 zeros for chain_seq 1)',
  row_hash           CHAR(64) NULL COMMENT 'SHA-256 of the canonical JSON of this row (see server/services/auditChain.js)',
  event_time_ms      BIGINT NULL COMMENT 'Event time in epoch milliseconds, exactly as hashed',
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE SET NULL,
  INDEX idx_request (request_id),
  INDEX idx_event_time (event_time),
  INDEX idx_event_type (event_type),
  UNIQUE KEY uq_chain_seq (chain_seq)
) COMMENT='Immutable audit ledger — no UPDATE or DELETE';

-- ─────────────────────────────────────────────────────────────
-- Table 10: Alert
-- Real-time WebSocket notification record
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Alert (
  alert_id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
  hospital_id        VARCHAR(20),
  request_id         VARCHAR(20),
  alert_type         ENUM('INCOMING_REFERRAL','RESOURCE_CRITICAL','ACCEPTANCE_TIMEOUT','AMBULANCE_UPDATE','SYSTEM') NOT NULL,
  message            VARCHAR(500) NOT NULL,
  status             ENUM('UNREAD','ACKNOWLEDGED') NOT NULL DEFAULT 'UNREAD',
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE SET NULL,
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE SET NULL,
  INDEX idx_hospital_status (hospital_id, status),
  INDEX idx_created (created_at)
);

-- ─────────────────────────────────────────────────────────────
-- Table 11: SystemUser (RBAC — JWT Auth; login accounts with bcrypt hashes, migration 008 columns at the end)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS SystemUser (
  user_id            VARCHAR(30)  PRIMARY KEY,
  username           VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
  password_hash      VARCHAR(200) NOT NULL,
  role               ENUM('ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER','PATIENT') NOT NULL,
  hospital_id        VARCHAR(20)  COMMENT 'Only for HOSPITAL_DESK role',
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login         TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  display_name       VARCHAR(150) NULL COMMENT 'Name shown in the UI',
  ambulance_id       VARCHAR(20)  NULL COMMENT 'PARAMEDIC only: the unit this account crews (X4)',
  is_demo            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = fictional demo account, refused at login when NODE_ENV=production',
  patient_id         VARCHAR(20)  NULL COMMENT 'PATIENT only: the patient whose cases this account may read',
  token_version      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Raised on a password reset, deactivation or role/link change: older tokens are refused',
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE SET NULL,
  CONSTRAINT fk_user_ambulance FOREIGN KEY (ambulance_id) REFERENCES Ambulance(ambulance_id) ON DELETE SET NULL,
  CONSTRAINT fk_user_patient FOREIGN KEY (patient_id) REFERENCES Patient(patient_id) ON DELETE SET NULL,
  INDEX idx_role (role),
  INDEX idx_patient (patient_id)
);

-- ─────────────────────────────────────────────────────────────
-- Table 12: IdempotencyKey
-- One row per (user, endpoint, Idempotency-Key), written in the same transaction as the
-- operation it guards, so a retried request replays the original result instead of repeating it.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS IdempotencyKey (
  actor_id           VARCHAR(80)  NOT NULL,
  endpoint           VARCHAR(60)  NOT NULL,
  idem_key           VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  request_hash       CHAR(64)     NOT NULL COMMENT 'SHA-256 of the validated request, to detect a key reused for a different request',
  resource_id        VARCHAR(30)  NOT NULL COMMENT 'What the original request created (e.g. the request_id)',
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id, endpoint, idem_key),
  INDEX idx_created (created_at)
);

-- ─────────────────────────────────────────────────────────────
-- Table 13: SchemaMigration
-- Bookkeeping for the migration runner (server/db/migrate.js). Identical to migrations/003.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS SchemaMigration (
  version            VARCHAR(100)  NOT NULL PRIMARY KEY COMMENT 'Migration file name without .sql, e.g. 001_referral_lifecycle',
  status             ENUM('BASELINE','RUNNING','APPLIED','FAILED') NOT NULL COMMENT 'BASELINE = already present when the runner was adopted (not executed by it)',
  checksum           CHAR(64)      NULL COMMENT 'SHA-256 of the migration file as executed (NULL for BASELINE rows)',
  statements_applied INT           NOT NULL DEFAULT 0 COMMENT 'Statements completed so far: DDL is not transactional, so a FAILED row says exactly how far it got',
  error_message      VARCHAR(1000) NULL,
  recorded_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

-- ─────────────────────────────────────────────────────────────
-- Table 14: DoctorAssignment
-- Exclusive reservation of procedure-bound specialists (Phase 3 Step 3, D3-B). Identical to migrations/004.
-- `active_doctor_id` is the doctor while the assignment is active, NULL otherwise; its UNIQUE key makes
-- "one active assignment per doctor" a database guarantee.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS DoctorAssignment (
  assignment_id      VARCHAR(30)  NOT NULL PRIMARY KEY,
  doctor_id          VARCHAR(20)  NOT NULL,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL,
  acceptance_id      VARCHAR(30)  NULL COMMENT 'Referral that reserved the doctor',
  stage_no           TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Treatment stage (staged claims, Phase 3 Step 4); 1 until then',
  status             ENUM('LOCKED','COMMITTED','RELEASED') NOT NULL DEFAULT 'LOCKED' COMMENT 'LOCKED = reserved by a pending referral; COMMITTED = assigned to an accepted case',
  active_doctor_id   VARCHAR(20)  GENERATED ALWAYS AS (IF(status IN ('LOCKED','COMMITTED'), doctor_id, NULL)) STORED,
  reserved_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at       TIMESTAMP(3) NULL,
  released_at        TIMESTAMP(3) NULL,
  UNIQUE KEY uq_active_doctor (active_doctor_id),
  INDEX idx_request_status (request_id, status),
  INDEX idx_doctor_status (doctor_id, status),
  -- RESTRICT, not CASCADE: MySQL forbids a cascading action on the base column of a stored generated
  -- column (active_doctor_id), and a doctor's assignment history must outlive casual deletion anyway.
  CONSTRAINT fk_assignment_doctor FOREIGN KEY (doctor_id) REFERENCES Doctor(doctor_id) ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_request FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_hospital FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────
-- Table 15: RequestClaim (migration 005)
-- Maximum claim per case, treatment stage and resource type, fixed at intake (Banker's option A, D2-B)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS RequestClaim (
  request_id         VARCHAR(20)  NOT NULL,
  stage_no           TINYINT UNSIGNED NOT NULL,
  resource_type      VARCHAR(30)  NOT NULL COMMENT 'ICU_BED | OT | VENTILATOR | TRAUMA_SURGEON',
  quantity           TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (request_id, stage_no, resource_type),
  CONSTRAINT chk_claim_stage CHECK (stage_no >= 1),
  CONSTRAINT chk_claim_quantity CHECK (quantity >= 1),
  CONSTRAINT fk_claim_request FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────
-- Table 16: AuditChainHead (migration 006; legacy_* columns migration 007)
-- The head of the audit hash chain: locked FOR UPDATE as the LAST lock of every audit-writing transaction
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AuditChainHead (
  id                 TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  chain_seq          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  head_hash          CHAR(64) NOT NULL,
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  legacy_max_history_id BIGINT UNSIGNED NULL COMMENT 'Highest history_id of the pre-chain (legacy) audit rows; NULL = none',
  legacy_count       BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of pre-chain (legacy) audit rows, recorded once by migration 007',
  CONSTRAINT chk_single_head CHECK (id = 1)
);
-- A fresh database has no legacy (pre-chain) audit rows: legacy_count 0, legacy_max_history_id NULL (migration 007).
INSERT IGNORE INTO AuditChainHead (id, chain_seq, head_hash) VALUES (1, 0, REPEAT('0', 64));

-- ─────────────────────────────────────────────────────────────
-- Table 17: AmbulanceTrip (migration 010)
-- A simulated ambulance trip (station -> pickup -> accepted hospital) moved by the server's tracking engine.
-- Identical to migrations/010; at most one active trip per ambulance and per case (unique generated columns).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AmbulanceTrip (
  trip_id            VARCHAR(30)  NOT NULL PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  ambulance_id       VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL COMMENT 'Destination: the hospital that accepted the case',
  start_lat          DECIMAL(10, 7) NOT NULL,
  start_lng          DECIMAL(10, 7) NOT NULL,
  speed_kmh          SMALLINT UNSIGNED NOT NULL,
  route_to_patient   JSON         NOT NULL COMMENT '[[lat, lng], ...] from the start to the pickup point',
  route_to_hospital  JSON         NOT NULL COMMENT '[[lat, lng], ...] from the pickup point to the hospital',
  route_source       ENUM('osrm','simulated') NOT NULL,
  phase              ENUM('DISPATCHED','EN_ROUTE_TO_PATIENT','ARRIVED_AT_PATIENT','PATIENT_PICKED_UP','EN_ROUTE_TO_HOSPITAL','ARRIVED_AT_HOSPITAL') NOT NULL DEFAULT 'DISPATCHED',
  progress           DECIMAL(7, 6) NOT NULL DEFAULT 0 COMMENT '0-1 within the current leg',
  current_lat        DECIMAL(10, 7) NOT NULL,
  current_lng        DECIMAL(10, 7) NOT NULL,
  eta_seconds        INT UNSIGNED NULL COMMENT 'Seconds to the end of the current leg (pickup, then the hospital)',
  paused             TINYINT(1)   NOT NULL DEFAULT 0,
  is_demo            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = demo trip: may be reset',
  created_by         VARCHAR(30)  NULL COMMENT 'user_id that created the trip',
  version            INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Optimistic-concurrency counter',
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at         TIMESTAMP(3) NULL,
  arrived_patient_at TIMESTAMP(3) NULL,
  picked_up_at       TIMESTAMP(3) NULL,
  arrived_hospital_at TIMESTAMP(3) NULL,
  completed_at       TIMESTAMP(3) NULL,
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  active_ambulance_id VARCHAR(20) GENERATED ALWAYS AS (IF(completed_at IS NULL, ambulance_id, NULL)) STORED,
  active_request_id  VARCHAR(20)  GENERATED ALWAYS AS (IF(completed_at IS NULL, request_id, NULL)) STORED,
  UNIQUE KEY uq_trip_active_ambulance (active_ambulance_id),
  UNIQUE KEY uq_trip_active_request (active_request_id),
  INDEX idx_trip_request (request_id),
  INDEX idx_trip_hospital (hospital_id),
  INDEX idx_trip_phase (phase),
  CONSTRAINT chk_trip_progress CHECK (progress >= 0 AND progress <= 1),
  CONSTRAINT chk_trip_speed CHECK (speed_kmh BETWEEN 10 AND 200),
  CONSTRAINT fk_trip_request FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_trip_ambulance FOREIGN KEY (ambulance_id) REFERENCES Ambulance(ambulance_id) ON DELETE RESTRICT,
  CONSTRAINT fk_trip_hospital FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────
-- Table 19: TreatmentUpdate (migration 011)
-- Progress notes written by the receiving hospital while a case is in treatment. Identical to migrations/011.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS TreatmentUpdate (
  update_id          VARCHAR(30)  NOT NULL PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL,
  author_id          VARCHAR(30)  NULL COMMENT 'user_id of the hospital desk that wrote the note',
  note               VARCHAR(500) NOT NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_update_request (request_id, created_at),
  CONSTRAINT fk_update_request FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_update_hospital FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────
-- Table 20: AmbulanceAssignment (migration 011)
-- One row per patient a unit carries (configurable Ambulance.capacity; a RED patient rides alone); at most one active
-- assignment per case (unique generated active_request_id). Identical to migrations/011.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AmbulanceAssignment (
  assignment_id      VARCHAR(30)  NOT NULL PRIMARY KEY,
  ambulance_id       VARCHAR(20)  NOT NULL,
  request_id         VARCHAR(20)  NOT NULL,
  triage_category    ENUM('RED','YELLOW','GREEN') NULL COMMENT 'At assignment (a RED patient rides alone)',
  assigned_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  picked_up_at       TIMESTAMP(3) NULL,
  handed_over_at     TIMESTAMP(3) NULL COMMENT 'The receiving hospital confirmed arrival',
  released_at        TIMESTAMP(3) NULL COMMENT 'The seat is free again (handover, unassignment or case closed)',
  release_reason     VARCHAR(200) NULL,
  assigned_by        VARCHAR(30)  NULL,
  active_request_id  VARCHAR(20)  GENERATED ALWAYS AS (IF(released_at IS NULL, request_id, NULL)) STORED,
  UNIQUE KEY uq_assignment_active_request (active_request_id),
  INDEX idx_assignment_ambulance (ambulance_id, released_at),
  INDEX idx_assignment_request (request_id),
  CONSTRAINT fk_assignment_ambulance FOREIGN KEY (ambulance_id) REFERENCES Ambulance(ambulance_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ambassign_request FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE RESTRICT
);

-- This file already contains the effect of every migration below, so a database created from it records
-- them as BASELINE (the runner then has nothing to apply). EVERY new migration file must be added here
-- together with its schema change; tests/mysql_migration_runner.test.js fails if one is missing.
INSERT IGNORE INTO SchemaMigration (version, status) VALUES
  ('001_referral_lifecycle', 'BASELINE'),
  ('002_idempotency_keys', 'BASELINE'),
  ('003_schema_migration', 'BASELINE'),
  ('004_doctor_assignment', 'BASELINE'),
  ('005_staged_claims', 'BASELINE'),
  ('006_audit_chain', 'BASELINE'),
  ('007_analytics_integrity', 'BASELINE'),
  ('008_accounts_and_scoping', 'BASELINE'),
  ('009_portal_roles', 'BASELINE'),
  ('010_ambulance_trips', 'BASELINE'),
  ('011_incidents', 'BASELINE');

SET FOREIGN_KEY_CHECKS = 1;
