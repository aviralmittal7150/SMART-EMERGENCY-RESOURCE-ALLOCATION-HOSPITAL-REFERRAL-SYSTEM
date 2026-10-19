-- 001_referral_lifecycle.sql
-- ADDITIVE migration for databases created from an older server/db/schema.sql.
-- It only adds columns and widens an ENUM; it never drops or rewrites data.
-- Run it MANUALLY, once, and only if the app refuses to start with "Schema is out of date".
-- (A fresh database does not need it: `node server/db/init.js` creates the current schema.)
--
-- MySQL has no "ADD COLUMN IF NOT EXISTS": run only the statements the startup error lists.

-- Ambulance: record which case a unit is dispatched to (set when a referral is accepted)
ALTER TABLE Ambulance
  ADD COLUMN assigned_request_id VARCHAR(20) NULL COMMENT 'Case this unit is dispatched to (set on referral acceptance)',
  ADD COLUMN destination_hospital_id VARCHAR(20) NULL,
  ADD CONSTRAINT fk_ambulance_assigned_request FOREIGN KEY (assigned_request_id) REFERENCES EmergencyRequest(request_id) ON DELETE SET NULL,
  ADD INDEX idx_assigned_request (assigned_request_id);

-- HospitalAcceptance: a pending referral can now be CANCELLED (case cancelled/completed while pending)
ALTER TABLE HospitalAcceptance
  MODIFY status ENUM('PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING';

-- EmergencyRequest: required resources / specialist captured at intake
ALTER TABLE EmergencyRequest
  ADD COLUMN required_resources JSON NULL AFTER emergency_type,
  ADD COLUMN required_specialist VARCHAR(40) NULL AFTER required_resources;

-- EmergencyHistory: audit rows for non-case events (doctors, capacity, ...) have no request
ALTER TABLE EmergencyHistory MODIFY request_id VARCHAR(20) NULL;
