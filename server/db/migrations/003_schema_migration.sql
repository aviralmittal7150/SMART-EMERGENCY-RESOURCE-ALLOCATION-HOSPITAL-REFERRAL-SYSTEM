-- 003_schema_migration.sql
-- ADDITIVE: creates the SchemaMigration bookkeeping table used by the migration runner
-- (server/db/migrate.js, `npm run db:migrate`). It never alters or drops existing data, and is
-- safe to run more than once (CREATE TABLE IF NOT EXISTS).
-- Apply migrations with the runner, not by hand: see server/db/migrations/README.md.

CREATE TABLE IF NOT EXISTS SchemaMigration (
  version            VARCHAR(100)  NOT NULL PRIMARY KEY COMMENT 'Migration file name without .sql, e.g. 001_referral_lifecycle',
  status             ENUM('BASELINE','RUNNING','APPLIED','FAILED') NOT NULL COMMENT 'BASELINE = already present when the runner was adopted (not executed by it)',
  checksum           CHAR(64)      NULL COMMENT 'SHA-256 of the migration file as executed (NULL for BASELINE rows)',
  statements_applied INT           NOT NULL DEFAULT 0 COMMENT 'Statements completed so far: DDL is not transactional, so a FAILED row says exactly how far it got',
  error_message      VARCHAR(1000) NULL,
  recorded_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
