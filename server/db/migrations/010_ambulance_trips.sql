-- 010_ambulance_trips.sql
-- ADDITIVE (Batch 7, ambulance live tracking demo): one new table, AmbulanceTrip, holding a SIMULATED ambulance trip
-- (station -> patient pickup -> accepted hospital) that the server's tracking engine moves along a route.
--  * The patient, the pickup point (EmergencyRequest.pickup_lat/lng) and the hospital position (Hospital.location_*) are
--    NOT copied: they are read from their own tables. The unit's live position is also written to Ambulance.current_*.
--  * route_to_patient / route_to_hospital: JSON arrays of [lat, lng] points; route_source says whether they came from
--    the routing service ('osrm') or are a straight-line fallback ('simulated').
--  * progress: 0-1 within the current leg; version: optimistic-concurrency counter (every write checks and raises it).
--  * At most one ACTIVE trip (completed_at IS NULL) per ambulance and per case: enforced by the unique keys on the
--    stored generated columns active_ambulance_id / active_request_id (NULL once the trip is completed; NULLs never
--    collide), as DoctorAssignment does for doctors. The foreign keys are RESTRICT: MySQL forbids a cascading action on
--    the base column of a stored generated column.
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

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
