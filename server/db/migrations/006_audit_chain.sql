-- 006_audit_chain.sql
-- ADDITIVE (Phase 3 Step 5, approved direction AC): a tamper-evident hash chain over the audit ledger.
--  1. EmergencyHistory gains chain_seq (unique, 1, 2, 3 ... in commit order), prev_hash, row_hash (SHA-256 hex)
--     and event_time_ms (the exact millisecond the hash covers; event_time stays for display).
--  2. AuditChainHead: one row (id = 1) holding the last chain_seq and its hash. Every audit-writing transaction
--     locks it FOR UPDATE as its LAST lock, writes its rows, moves the head and commits: chain order = commit order.
--  No triggers: creating them needs SUPER while binary logging is on (refused for the application account,
--  verified 2026-11-08). Append-only is enforced by privileges instead (the application account gets no UPDATE
--  or DELETE on EmergencyHistory; see README), and any edit made anyway is detected by chain verification.
-- Rows written before this migration keep chain_seq NULL: integrity is only claimed from the first chained row on.
-- Apply with the migration runner (`npm run db:migrate`); manual rollback notes are in README.md.

ALTER TABLE EmergencyHistory
  ADD COLUMN chain_seq BIGINT UNSIGNED NULL COMMENT 'Position in the audit hash chain (NULL = written before migration 006)',
  ADD COLUMN prev_hash CHAR(64) NULL COMMENT 'row_hash of the previous chained row (64 zeros for chain_seq 1)',
  ADD COLUMN row_hash CHAR(64) NULL COMMENT 'SHA-256 of the canonical JSON of this row (see server/services/auditChain.js)',
  ADD COLUMN event_time_ms BIGINT NULL COMMENT 'Event time in epoch milliseconds, exactly as hashed',
  ADD UNIQUE KEY uq_chain_seq (chain_seq);

CREATE TABLE IF NOT EXISTS AuditChainHead (
  id                 TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  chain_seq          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  head_hash          CHAR(64) NOT NULL,
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_single_head CHECK (id = 1)
);

INSERT IGNORE INTO AuditChainHead (id, chain_seq, head_hash) VALUES (1, 0, REPEAT('0', 64));
