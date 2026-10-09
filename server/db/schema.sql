-- ============================================================
-- SMART EMERGENCY RESOURCE ALLOCATION & HOSPITAL REFERRAL SYSTEM
-- MySQL Schema — Phase 2 DBMS Layer
-- 10 Normalized Tables with Foreign Keys, Indexes & ACID Support
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
  availability_status ENUM('AVAILABLE','IN_PROCEDURE','OFF_DUTY') NOT NULL DEFAULT 'AVAILABLE',
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
  age                TINYINT UNSIGNED NOT NULL,
  gender             ENUM('MALE','FEMALE','OTHER','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  emergency_type     VARCHAR(50)  NOT NULL,
  triage_priority    TINYINT      NOT NULL DEFAULT 3 COMMENT '1=Resuscitation, 2=Emergent, 3=Urgent, 4=Semi-Urgent, 5=Non-Urgent',
  contact_phone      VARCHAR(30),
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_triage (triage_priority),
  CONSTRAINT chk_triage CHECK (triage_priority BETWEEN 1 AND 5)
);

-- ─────────────────────────────────────────────────────────────
-- Table 5: EmergencyRequest
-- OS Process Lifecycle: NEW -> WAITING -> ALLOCATED -> IN_TREATMENT -> COMPLETED | CANCELLED
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS EmergencyRequest (
  request_id         VARCHAR(20)  PRIMARY KEY,
  patient_id         VARCHAR(20)  NOT NULL,
  emergency_type     VARCHAR(50)  NOT NULL,
  priority           TINYINT      NOT NULL DEFAULT 3,
  pickup_lat         DECIMAL(10, 7),
  pickup_lng         DECIMAL(10, 7),
  clinical_notes     TEXT,
  status             ENUM('NEW','WAITING','MATCHING','ALLOCATED','IN_TREATMENT','COMPLETED','CANCELLED') NOT NULL DEFAULT 'NEW',
  request_time       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES Patient(patient_id) ON DELETE RESTRICT,
  INDEX idx_status_priority (status, priority),
  INDEX idx_request_time (request_time)
);

-- ─────────────────────────────────────────────────────────────
-- Table 6: HospitalAcceptance
-- 90-second TTL soft-lock handshake record
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS HospitalAcceptance (
  acceptance_id      VARCHAR(30)  PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20)  NOT NULL,
  status             ENUM('PENDING','ACCEPTED','REJECTED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  response_time_sec  INT,
  rejection_reason   VARCHAR(300),
  lock_expires_at    TIMESTAMP    NOT NULL,
  responded_at       TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  INDEX idx_request (request_id),
  INDEX idx_status (status),
  INDEX idx_expires (lock_expires_at)
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
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE CASCADE,
  INDEX idx_status (status),
  INDEX idx_hospital (hospital_id)
);

-- ─────────────────────────────────────────────────────────────
-- Table 9: EmergencyHistory (Immutable Audit Ledger)
-- Append-only: no UPDATE or DELETE permitted (enforced via app logic)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS EmergencyHistory (
  history_id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
  request_id         VARCHAR(20)  NOT NULL,
  hospital_id        VARCHAR(20),
  event_type         VARCHAR(80)  NOT NULL COMMENT 'e.g. STATUS_CHANGE, LOCK_ACQUIRED, ALLOCATION_COMMITTED, RESOURCE_RELEASED',
  previous_state     VARCHAR(50),
  new_state          VARCHAR(50),
  actor_role         ENUM('SYSTEM','ADMIN','HOSPITAL_DESK','PARAMEDIC') NOT NULL DEFAULT 'SYSTEM',
  actor_id           VARCHAR(80),
  metadata           JSON,
  event_time         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (request_id) REFERENCES EmergencyRequest(request_id) ON DELETE CASCADE,
  INDEX idx_request (request_id),
  INDEX idx_event_time (event_time),
  INDEX idx_event_type (event_type)
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
-- Table 11: SystemUser (RBAC — JWT Auth)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS SystemUser (
  user_id            VARCHAR(30)  PRIMARY KEY,
  username           VARCHAR(80)  NOT NULL UNIQUE,
  password_hash      VARCHAR(200) NOT NULL,
  role               ENUM('ADMIN','HOSPITAL_DESK','PARAMEDIC') NOT NULL,
  hospital_id        VARCHAR(20)  COMMENT 'Only for HOSPITAL_DESK role',
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login         TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES Hospital(hospital_id) ON DELETE SET NULL,
  INDEX idx_role (role)
);

SET FOREIGN_KEY_CHECKS = 1;
