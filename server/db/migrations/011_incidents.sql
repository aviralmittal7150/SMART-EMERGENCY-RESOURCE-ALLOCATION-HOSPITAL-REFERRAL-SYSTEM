-- 011_incidents.sql
-- ADDITIVE (Batch 8): the hospital treatment workflow and mass-casualty incidents. Six statements.
--  1. Incident: a mass-casualty incident (e.g. a bus crash) under which many victims are registered at once.
--  2. Patient.age becomes NULLable: a victim's age may be unknown (the API shows "Unknown").
--  3. EmergencyRequest gains
--     * incident_id (FK fk_request_incident, RESTRICT) and incident_seq (the victim's number within its incident, unique
--       per incident: anonymous victims are labelled MCI-001, MCI-002 ... from it), triage_category RED / YELLOW / GREEN
--       (decision support, mapped onto the existing priority);
--     * dispatch_ambulance_id, the unit the admin chose when dispatching (preferred by the accept's auto-dispatch);
--     * the hospital milestones arrived_at, bed_label + bed_hospital_id + bed_allocated_at, treatment_started_at,
--       treatment_completed_at (the existing statuses are unchanged);
--     * active_bed_key, a stored generated column: "<hospital>|<BED LABEL>" while the case is open and has a bed, NULL
--       otherwise. Its unique key uq_active_bed makes a bed label unique among a hospital's open cases in the database
--       itself (two desks allocating the same bed at once: exactly one wins), as AmbulanceTrip's active_* keys do.
--  4. TreatmentUpdate: progress notes written by the receiving hospital while a case is in treatment.
--  5. Ambulance.capacity (1-4, default 1): how many patients a unit may carry.
--  6. AmbulanceAssignment: one row per patient carried by a unit (assigned, picked up, handed over, released); at most
--     one ACTIVE (not released) assignment per case, enforced by the unique key on the generated active_request_id.
-- Foreign keys are RESTRICT (MySQL forbids a cascading action on the base column of a stored generated column).
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

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

ALTER TABLE Patient
  MODIFY COLUMN age TINYINT UNSIGNED NULL COMMENT 'NULL = unknown (e.g. an unidentified incident victim)';

ALTER TABLE EmergencyRequest
  ADD COLUMN incident_id VARCHAR(30) NULL COMMENT 'The mass-casualty incident of the case (NULL: a single case)',
  ADD COLUMN incident_seq SMALLINT UNSIGNED NULL COMMENT 'Victim number within the incident (anonymous label MCI-NNN)',
  ADD COLUMN triage_category ENUM('RED','YELLOW','GREEN') NULL COMMENT 'Incident triage (decision support)',
  ADD COLUMN arrived_at TIMESTAMP(3) NULL COMMENT 'The receiving hospital confirmed arrival (ambulance handover)',
  ADD COLUMN bed_label VARCHAR(30) NULL,
  ADD COLUMN bed_hospital_id VARCHAR(20) NULL,
  ADD COLUMN bed_allocated_at TIMESTAMP(3) NULL,
  ADD COLUMN treatment_started_at TIMESTAMP(3) NULL,
  ADD COLUMN treatment_completed_at TIMESTAMP(3) NULL,
  ADD COLUMN dispatch_ambulance_id VARCHAR(20) NULL COMMENT 'The unit the admin chose at dispatch (preferred when the hospital accepts)',
  ADD COLUMN active_bed_key VARCHAR(60) GENERATED ALWAYS AS (
    IF(bed_label IS NULL OR status IN ('COMPLETED', 'CANCELLED'), NULL, CONCAT(bed_hospital_id, '|', UPPER(bed_label)))) STORED,
  ADD UNIQUE KEY uq_incident_seq (incident_id, incident_seq),
  ADD UNIQUE KEY uq_active_bed (active_bed_key),
  ADD CONSTRAINT fk_request_incident FOREIGN KEY (incident_id) REFERENCES Incident(incident_id) ON DELETE RESTRICT;

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

ALTER TABLE Ambulance
  ADD COLUMN capacity TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Patients the unit may carry (1-4)',
  ADD CONSTRAINT chk_ambulance_capacity CHECK (capacity BETWEEN 1 AND 4);

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
