-- 002_idempotency_keys.sql
-- ADDITIVE migration: creates the IdempotencyKey table used by POST /emergencies (Idempotency-Key header).
-- Safe to run more than once (CREATE TABLE IF NOT EXISTS); it never alters or drops existing data.
-- Run it after 001 if the app refuses to start with "missing table IdempotencyKey".
-- (A fresh database does not need it: `node server/db/init.js` creates the current schema.)

CREATE TABLE IF NOT EXISTS IdempotencyKey (
  actor_id           VARCHAR(80)  NOT NULL,
  endpoint           VARCHAR(60)  NOT NULL,
  idem_key           VARCHAR(100) NOT NULL,
  request_hash       CHAR(64)     NOT NULL COMMENT 'SHA-256 of the validated request, to detect a key reused for a different request',
  resource_id        VARCHAR(30)  NOT NULL COMMENT 'What the original request created (e.g. the request_id)',
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id, endpoint, idem_key),
  INDEX idx_created (created_at)
);
