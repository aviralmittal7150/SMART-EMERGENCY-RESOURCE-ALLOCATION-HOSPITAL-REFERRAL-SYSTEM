-- 008_accounts_and_scoping.sql
-- ADDITIVE (review round 1, findings X2, X4, X5, X11 and B1-R1): real accounts, per-role scoping, per-user referral
-- notifications and case-sensitive idempotency keys.
--  1. SystemUser holds the real login accounts (bcrypt hashes): display_name; ambulance_id (a PARAMEDIC account crews one
--     unit and may change the status of that unit only, X4); is_demo (1 = fictional demo account, refused at login
--     when NODE_ENV=production, X2). Usernames compare case-sensitively (binary collation), exactly as the in-memory store.
--  2. HospitalAcceptance.initiated_by: the user who sent the referral (POST /referrals/initiate); a failover referral
--     inherits it. It scopes GET /referrals/history for paramedics and addresses the per-user `referral:status` event.
--     Existing referrals keep NULL (who initiated them was never recorded).
--  3. EmergencyRequest.created_by: the user who registered the case (paramedics see their own cases, X5), backfilled
--     from each case's REQUEST_CREATED audit row (its actor_id); updated_at is left unchanged by the backfill.
--  4. IdempotencyKey.idem_key compares case-sensitively (binary collation), as the in-memory store does (X11).
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

ALTER TABLE SystemUser
  MODIFY COLUMN username VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD COLUMN display_name VARCHAR(150) NULL COMMENT 'Name shown in the UI',
  ADD COLUMN ambulance_id VARCHAR(20) NULL COMMENT 'PARAMEDIC only: the unit this account crews (X4)',
  ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = fictional demo account, refused at login when NODE_ENV=production',
  ADD CONSTRAINT fk_user_ambulance FOREIGN KEY (ambulance_id) REFERENCES Ambulance(ambulance_id) ON DELETE SET NULL;

ALTER TABLE HospitalAcceptance
  ADD COLUMN initiated_by VARCHAR(30) NULL COMMENT 'user_id that sent the referral; a failover referral inherits it',
  ADD INDEX idx_initiated_by (initiated_by);

ALTER TABLE EmergencyRequest
  ADD COLUMN created_by VARCHAR(30) NULL COMMENT 'user_id that registered the case',
  ADD INDEX idx_created_by (created_by);

UPDATE EmergencyRequest r
JOIN (SELECT h.request_id, h.actor_id
      FROM EmergencyHistory h
      JOIN (SELECT request_id, MIN(history_id) AS first_id FROM EmergencyHistory
            WHERE event_type = 'REQUEST_CREATED' AND request_id IS NOT NULL GROUP BY request_id) f ON f.first_id = h.history_id
      WHERE h.actor_id IS NOT NULL AND CHAR_LENGTH(h.actor_id) <= 30) c ON c.request_id = r.request_id
SET r.created_by = c.actor_id, r.updated_at = r.updated_at
WHERE r.created_by IS NULL;

ALTER TABLE IdempotencyKey
  MODIFY COLUMN idem_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
