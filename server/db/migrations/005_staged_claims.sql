-- 005_staged_claims.sql
-- ADDITIVE (Phase 3 Step 4, Banker's option A, decisions D2-B and D5-A): staged resource claims.
--  1. RequestClaim: the maximum claim each case declares at intake, per treatment stage and resource type
--     (ICU_BED, OT, VENTILATOR, and the exclusive specialist TRAUMA_SURGEON). Fixed at intake.
--  2. EmergencyRequest.current_stage: the stage the case is in (1 until an explicit stage advance).
--  3. ResourceAllocation.stage_no: the stage an allocation belongs to.
--  4. Hospital.safety_state: SAFE / UNSAFE flag kept by the Banker's check; it changes only together with an
--     UNSAFE_STATE or SAFE_STATE_RESTORED audit event (D5-A).
--  5. Backfill (D2-a10): every OPEN case gets a single-stage claim. A case that holds resources or a surgeon
--     claims exactly what it holds; a case that holds nothing claims its recorded requirement (the resources
--     and exclusive specialist the referral route would lock for it). Closed cases get no claim.
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

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

ALTER TABLE EmergencyRequest
  ADD COLUMN current_stage TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Treatment stage of the case (staged claims)';

ALTER TABLE ResourceAllocation
  ADD COLUMN stage_no TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Treatment stage this allocation belongs to';

ALTER TABLE Hospital
  ADD COLUMN safety_state ENUM('SAFE','UNSAFE') NOT NULL DEFAULT 'SAFE' COMMENT 'Banker''s safety flag (D5-A)';

INSERT IGNORE INTO RequestClaim (request_id, stage_no, resource_type, quantity)
SELECT ra.request_id, 1, mr.resource_type, COUNT(*)
FROM ResourceAllocation ra
JOIN MedicalResource mr ON mr.resource_id = ra.resource_id
JOIN EmergencyRequest r ON r.request_id = ra.request_id
WHERE ra.status IN ('LOCKED', 'COMMITTED') AND r.status NOT IN ('COMPLETED', 'CANCELLED')
GROUP BY ra.request_id, mr.resource_type;

INSERT IGNORE INTO RequestClaim (request_id, stage_no, resource_type, quantity)
SELECT da.request_id, 1, d.specialization, 1
FROM DoctorAssignment da
JOIN Doctor d ON d.doctor_id = da.doctor_id
JOIN EmergencyRequest r ON r.request_id = da.request_id
WHERE da.status IN ('LOCKED', 'COMMITTED') AND r.status NOT IN ('COMPLETED', 'CANCELLED');

INSERT IGNORE INTO RequestClaim (request_id, stage_no, resource_type, quantity)
SELECT DISTINCT r.request_id, 1, jt.resource_type, 1
FROM EmergencyRequest r,
     JSON_TABLE(COALESCE(r.required_resources, JSON_ARRAY()), '$[*]' COLUMNS (resource_type VARCHAR(30) PATH '$')) jt
WHERE r.status NOT IN ('COMPLETED', 'CANCELLED')
  AND jt.resource_type IN ('ICU_BED', 'OT', 'VENTILATOR')
  AND NOT EXISTS (SELECT 1 FROM ResourceAllocation ra WHERE ra.request_id = r.request_id AND ra.status IN ('LOCKED', 'COMMITTED'))
  AND NOT EXISTS (SELECT 1 FROM DoctorAssignment da WHERE da.request_id = r.request_id AND da.status IN ('LOCKED', 'COMMITTED'));

INSERT IGNORE INTO RequestClaim (request_id, stage_no, resource_type, quantity)
SELECT r.request_id, 1, 'TRAUMA_SURGEON', 1
FROM EmergencyRequest r
WHERE r.status NOT IN ('COMPLETED', 'CANCELLED') AND r.required_specialist = 'TRAUMA_SURGEON'
  AND NOT EXISTS (SELECT 1 FROM ResourceAllocation ra WHERE ra.request_id = r.request_id AND ra.status IN ('LOCKED', 'COMMITTED'))
  AND NOT EXISTS (SELECT 1 FROM DoctorAssignment da WHERE da.request_id = r.request_id AND da.status IN ('LOCKED', 'COMMITTED'));
