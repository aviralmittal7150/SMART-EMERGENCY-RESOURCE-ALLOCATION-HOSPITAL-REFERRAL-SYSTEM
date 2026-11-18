-- 009_portal_roles.sql
-- ADDITIVE (Batch 6, portals): two more account roles and the patient link.
--  1. SystemUser.role gains DISPATCHER (the command-centre operator) and PATIENT (read-only patient portal).
--  2. SystemUser.patient_id: the patient a PATIENT account belongs to (it sees only that patient's cases). Foreign key
--     fk_user_patient to Patient, ON DELETE SET NULL (an account whose patient is gone can no longer sign in: a PATIENT
--     without patient_id is refused), and index idx_patient.
--  3. SystemUser.token_version: every token carries the version it was issued under; a password reset, a deactivation or
--     a role / link change raises it, so every older token (REST and socket) is refused (Batch 6 round 2).
--  4. EmergencyHistory.actor_role gains DISPATCHER, so a dispatcher's actions are audited under their own role. (A patient
--     never writes: the patient portal is read-only.)
-- The role/link rules (PATIENT needs patient_id, HOSPITAL_DESK needs hospital_id, only PATIENT carries patient_id) are
-- enforced by the application (server/services/accounts.js), as the earlier role rules are.
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

ALTER TABLE SystemUser
  MODIFY COLUMN role ENUM('ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER','PATIENT') NOT NULL,
  ADD COLUMN patient_id VARCHAR(20) NULL COMMENT 'PATIENT only: the patient whose cases this account may read',
  ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Raised on a password reset, deactivation or role/link change: older tokens are refused',
  ADD INDEX idx_patient (patient_id),
  ADD CONSTRAINT fk_user_patient FOREIGN KEY (patient_id) REFERENCES Patient(patient_id) ON DELETE SET NULL;

ALTER TABLE EmergencyHistory
  MODIFY COLUMN actor_role ENUM('SYSTEM','ADMIN','HOSPITAL_DESK','PARAMEDIC','DISPATCHER') NOT NULL DEFAULT 'SYSTEM';
