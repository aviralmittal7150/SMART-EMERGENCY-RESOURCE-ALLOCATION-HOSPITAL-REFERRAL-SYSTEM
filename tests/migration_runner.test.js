// Migration runner: file ordering, statement splitting and checksums (no database needed).
// The database behaviour (apply, re-run, failure, concurrency, start-up refusal) is tested against MySQL
// in tests/mysql_migration_runner.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMigrationFiles, splitStatements, checksumOf, MigrationError, MIGRATIONS_DIR } from '../server/db/migrate.js';

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

test('the real migration directory is valid: contiguous from 001, in order, 003 creates SchemaMigration', () => {
  const files = listMigrationFiles();
  assert.deepEqual(files.map(f => f.version), ['001_referral_lifecycle', '002_idempotency_keys', '003_schema_migration']);
  assert.match(files[2].sql, /CREATE TABLE IF NOT EXISTS SchemaMigration/);
  assert.ok(files.every(f => /^[0-9a-f]{64}$/.test(f.checksum)));
});

test('files are ordered by number regardless of directory order; non-.sql files are ignored', () => {
  const dir = tempDir({ '010_j.sql': 'SELECT 10;', 'README.md': '# not a migration' });
  for (let n = 1; n <= 9; n += 1) fs.writeFileSync(path.join(dir, `00${n}_m${n}.sql`), `SELECT ${n};`);
  try {
    assert.deepEqual(listMigrationFiles(dir).map(f => f.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { cleanup(dir); }
});

test('a duplicate number, a gap, or a badly named file is refused', () => {
  const cases = [
    [{ '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 2;' }, /share number 001/],
    [{ '001_a.sql': 'SELECT 1;', '003_c.sql': 'SELECT 3;' }, /contiguous from 001.*003_c\.sql/],
    [{ '002_b.sql': 'SELECT 2;' }, /contiguous from 001/],
    [{ '1_a.sql': 'SELECT 1;' }, /Badly named/],
    [{ '001_Bad-Name.sql': 'SELECT 1;' }, /Badly named/]
  ];
  for (const [files, expected] of cases) {
    const dir = tempDir(files);
    try {
      assert.throws(() => listMigrationFiles(dir), err => err instanceof MigrationError && expected.test(err.message));
    } finally { cleanup(dir); }
  }
});

test('the real migrations split into the expected statements (001: 5, 002: 1, 003: 1)', () => {
  const read = name => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  const s001 = splitStatements(read('001_referral_lifecycle.sql'));
  assert.equal(s001.length, 5);
  assert.ok(s001.every(s => /^ALTER TABLE /.test(s)), 'comment lines are not statements');
  assert.equal(splitStatements(read('002_idempotency_keys.sql')).length, 1);
  assert.equal(splitStatements(read('003_schema_migration.sql')).length, 1);
});

test('statement splitting respects quotes and comments', () => {
  const sql = `
    -- a comment; with a semicolon
    # another; comment
    /* block; comment */
    INSERT INTO t (a) VALUES ('x;y'), ("q;r"), ('it''s; fine');
    UPDATE \`odd;name\` SET a = 'back\\'slash;' WHERE b = 1;
    SELECT 2--1;
    SELECT 'last statement without a semicolon'`;
  assert.deepEqual(splitStatements(sql), [
    "INSERT INTO t (a) VALUES ('x;y'), (\"q;r\"), ('it''s; fine')",
    "UPDATE `odd;name` SET a = 'back\\'slash;' WHERE b = 1",
    'SELECT 2--1', // "--" without a following space is two minus signs in MySQL, not a comment
    "SELECT 'last statement without a semicolon'"
  ]);
  assert.throws(() => splitStatements("SELECT 'unterminated;"), MigrationError);
  assert.throws(() => splitStatements('SELECT 1; /* never closed'), MigrationError);
});

test('checksums are SHA-256 and ignore Windows line endings (a checkout setting must not look like an edit)', () => {
  assert.equal(checksumOf('SELECT 1;\nSELECT 2;\n'), checksumOf('SELECT 1;\r\nSELECT 2;\r\n'));
  assert.notEqual(checksumOf('SELECT 1;'), checksumOf('SELECT 2;'));
});

test('schema.sql records every migration file as BASELINE (a fresh database already contains them all)', () => {
  const schema = fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
  const insert = schema.match(/INSERT IGNORE INTO SchemaMigration \(version, status\) VALUES([\s\S]*?);/);
  assert.ok(insert, 'schema.sql must insert the baseline rows');
  const declared = [...insert[1].matchAll(/\('([^']+)', 'BASELINE'\)/g)].map(m => m[1]);
  assert.deepEqual(declared, listMigrationFiles().map(f => f.version),
    'add the new migration to schema.sql (schema change + baseline row) when you add a migration file');
});
