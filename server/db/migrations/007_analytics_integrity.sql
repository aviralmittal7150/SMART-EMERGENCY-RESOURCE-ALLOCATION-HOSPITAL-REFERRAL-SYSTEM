-- 007_analytics_integrity.sql
-- ADDITIVE (review round 1, findings S1, S3, S4 and S6): integrity of the observed analytics.
--  1. EmergencyRequest.is_demo: 1 marks a fictional demo case. Observed analytics leave demo cases, their referrals
--     and their audit timings out (S1). Only the three known demo cases of the demo seed are backfilled: REQ-8901,
--     REQ-8902 and REQ-8903, and only while they still belong to the demo patients PAT-001, PAT-002 and PAT-003
--     (a real case can never have those patient ids: real patients get PAT- plus six hex digits).
--  2. EmergencyRequest.request_time becomes TIMESTAMP(3): milliseconds, like the in-memory store, so history windows
--     (S3) and same-second queue ties (S6, ORDER BY priority, request_time) agree between the two stores. Existing
--     values keep their whole second (.000).
--  3. An index on HospitalAcceptance(created_at), which the history window filters on (S4).
--  4. AuditChainHead records the legacy (pre-chain) audit rows ONCE, as they are when this runs: the highest
--     history_id among them and their count. Legacy = no chain_seq and stored before the first chained row (all
--     unchained rows if nothing is chained yet). Verification then treats any other unchained row as a break
--     (UNCHAINED_ROW), including one inserted later with an explicit history_id into a gap below the first chained
--     row, which a "below the first chained row" rule alone would accept as legacy (review finding A3).
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

ALTER TABLE EmergencyRequest
  ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = fictional demo case, excluded from observed analytics',
  MODIFY COLUMN request_time TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

UPDATE EmergencyRequest SET is_demo = 1
WHERE (request_id, patient_id) IN (('REQ-8901', 'PAT-001'), ('REQ-8902', 'PAT-002'), ('REQ-8903', 'PAT-003'));

ALTER TABLE HospitalAcceptance
  ADD INDEX idx_created_at (created_at);

ALTER TABLE AuditChainHead
  ADD COLUMN legacy_max_history_id BIGINT UNSIGNED NULL COMMENT 'Highest history_id of the pre-chain (legacy) audit rows; NULL = none',
  ADD COLUMN legacy_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of pre-chain (legacy) audit rows, recorded once by migration 007';

UPDATE AuditChainHead h
JOIN (SELECT MAX(e.history_id) AS max_id, COUNT(*) AS n
      FROM EmergencyHistory e
      WHERE e.chain_seq IS NULL
        AND e.history_id < COALESCE((SELECT MIN(c.history_id) FROM EmergencyHistory c WHERE c.chain_seq IS NOT NULL), 9223372036854775807)) legacy
SET h.legacy_max_history_id = legacy.max_id, h.legacy_count = legacy.n
WHERE h.id = 1;
