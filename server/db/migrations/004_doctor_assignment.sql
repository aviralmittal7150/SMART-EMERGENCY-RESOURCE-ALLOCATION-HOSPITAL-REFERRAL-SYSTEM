-- 004_doctor_assignment.sql
-- ADDITIVE (Phase 3 Step 3, decision D3-B): exclusive reservation of procedure-bound specialists.
--  1. Doctor.availability_status gains RESERVED (held by a pending referral) and ASSIGNED (held by an
--     accepted case). The new values are appended to the ENUM, so existing rows are unchanged
--     (an in-place metadata change in MySQL 8).
--  2. DoctorAssignment records every reservation / assignment and its release. The stored generated
--     column `active_doctor_id` is the doctor while the assignment is active (LOCKED or COMMITTED) and NULL
--     otherwise; its UNIQUE key makes "one active assignment per doctor" a database guarantee, in addition
--     to the per-hospital lock that serialises reservations. A doctor with assignment history cannot be
--     deleted (ON DELETE RESTRICT); set them OFF_DUTY instead.
-- Apply with the migration runner (`npm run db:migrate`); see server/db/migrations/README.md, including
-- the manual rollback notes for this migration.

ALTER TABLE Doctor
  MODIFY availability_status ENUM('AVAILABLE','IN_PROCEDURE','OFF_DUTY','RESERVED','ASSIGNED') NOT NULL DEFAULT 'AVAILABLE';

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
