// server/db/migrate.js
// Schema migration runner for the MySQL store.
//
//   npm run db:migrate                        apply pending migrations, in order
//   npm run db:migrate -- --status            show what is applied / pending; change nothing
//   npm run db:migrate -- --dry-run           show what WOULD be applied; change nothing
//   npm run db:migrate -- --baseline <v|none> once, on a database created before this runner existed:
//                                             declare which migrations it already has (see README)
//   npm run db:migrate -- --mark-applied <v>  after finishing a FAILED migration by hand
//   npm run db:migrate -- --retry <v>         forget a FAILED migration so it runs again from statement 1
//
// Guarantees and limits:
//  - Order: files are server/db/migrations/NNN_name.sql, applied strictly by number. Numbers must be
//    unique and contiguous from 001. A pending migration numbered BELOW one already applied is refused
//    (no out-of-order application).
//  - Re-runs: every applied migration is recorded in SchemaMigration with the SHA-256 of its file, so a
//    second run applies nothing. An applied file that has since been edited is reported and refused.
//  - Concurrency: a MySQL advisory lock (per database) lets only one runner work at a time.
//  - Failure: MySQL DDL is NOT transactional. Each statement is recorded as it completes; if one fails the
//    migration is marked FAILED with the count of statements that did complete, and the runner refuses to
//    continue until an operator resolves it (--mark-applied or --retry). Nothing is silently re-run.
//  - A database freshly created from schema.sql already contains every migration; schema.sql records them
//    as BASELINE, so the runner has nothing to do on it.
//  - The application never runs migrations itself: it refuses to start while any are pending
//    (server/db/bootstrap.js). Run this command only against the database you intend to change.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveStorageConfig } from './config.js';
import { SCHEMA_TABLES, connectForInit, listExistingTables } from './init.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATION_TABLE = 'SchemaMigration';
const BOOTSTRAP_VERSION = '003_schema_migration'; // the migration that creates SchemaMigration itself
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const LOCK_TIMEOUT_SEC = 60;

export class MigrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MigrationError';
    Object.assign(this, details);
  }
}

const normalise = sql => sql.replace(/\r\n/g, '\n');
export const checksumOf = sql => createHash('sha256').update(normalise(sql)).digest('hex');

/**
 * The migration files in `dir`, validated and sorted by number.
 * Throws MigrationError for a badly named file, a duplicate number or a gap in the numbering.
 */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql'));
  const migrations = files.map(name => {
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new MigrationError(`Badly named migration file "${name}": expected NNN_lower_snake_case.sql.`);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    return { number: Number(match[1]), version: name.slice(0, -4), file: name, path: path.join(dir, name), sql, checksum: checksumOf(sql) };
  }).sort((a, b) => a.number - b.number);
  migrations.forEach((m, index) => {
    if (index > 0 && m.number === migrations[index - 1].number) {
      throw new MigrationError(`Two migrations share number ${String(m.number).padStart(3, '0')}: ${migrations[index - 1].file} and ${m.file}.`);
    }
    if (m.number !== index + 1) {
      throw new MigrationError(`Migration numbering must be contiguous from 001; ${m.file} is out of sequence (expected ${String(index + 1).padStart(3, '0')}).`);
    }
  });
  return migrations;
}

/**
 * Split a migration file into statements: semicolons inside quotes, and comments (-- , #, /* *\/), are
 * handled, so a statement boundary is only ever a real one.
 */
export function splitStatements(sql) {
  const s = normalise(sql);
  const statements = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const next = s[i + 1];
    if (quote) {
      current += c;
      if (c === '\\' && quote !== '`') { current += next ?? ''; i += 1; continue; }
      if (c === quote) {
        if (next === quote) { current += next; i += 1; continue; } // doubled quote = literal quote
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; current += c; continue; }
    if ((c === '-' && next === '-' && /[\s]|^$/.test(s[i + 2] ?? '')) || c === '#') {
      while (i < s.length && s[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) throw new MigrationError('Unterminated /* comment */ in migration.');
      i = end + 1;
      current += ' ';
      continue;
    }
    if (c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (quote) throw new MigrationError(`Unterminated ${quote}quoted${quote} text in migration.`);
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function tableExists(conn) {
  return (await listExistingTables(conn)).includes(MIGRATION_TABLE);
}

async function recordedRows(conn) {
  const [rows] = await conn.query(`SELECT version, status, checksum, statements_applied, error_message FROM ${MIGRATION_TABLE} ORDER BY version`);
  return rows;
}

/**
 * Compare the migration files with what the database has recorded. Read-only.
 * @returns {{tableExists:boolean, files:object[], rows:object[], pending:object[], problems:string[]}}
 */
export async function migrationStatus(conn, { dir = MIGRATIONS_DIR } = {}) {
  const files = listMigrationFiles(dir);
  if (!(await tableExists(conn))) return { tableExists: false, files, rows: [], pending: files, problems: [] };
  const rows = await recordedRows(conn);
  const byVersion = new Map(files.map(f => [f.version, f]));
  const recorded = new Map(rows.map(r => [r.version, r]));
  const problems = [];
  for (const row of rows) {
    const file = byVersion.get(row.version);
    if (!file) {
      problems.push(`migration ${row.version} is recorded in the database but no such file exists (was newer code deployed here before?)`);
    } else if (row.status === 'FAILED' || row.status === 'RUNNING') {
      problems.push(`migration ${row.version} is ${row.status} after ${row.statements_applied} statement(s)${row.error_message ? `: ${row.error_message}` : ''} — resolve it with --mark-applied or --retry (see server/db/migrations/README.md)`);
    } else if (row.status === 'APPLIED' && row.checksum !== file.checksum) {
      problems.push(`migration file ${file.file} was changed after it was applied (checksum mismatch); applied migrations must never be edited`);
    }
  }
  const pending = files.filter(f => !recorded.has(f.version));
  const highestRecorded = Math.max(0, ...rows.filter(r => byVersion.has(r.version)).map(r => byVersion.get(r.version).number));
  for (const p of pending) {
    if (p.number < highestRecorded) {
      problems.push(`migration ${p.version} is not applied although a later one is: out-of-order application is refused`);
    }
  }
  return { tableExists: true, files, rows, pending, problems };
}

async function withMigrationLock(conn, work) {
  const [[{ got }]] = await conn.query(
    "SELECT GET_LOCK(CONCAT('eris_migrate:', LEFT(SHA2(DATABASE(), 256), 32)), ?) AS got", [LOCK_TIMEOUT_SEC]
  );
  if (Number(got) !== 1) throw new MigrationError(`Another migration runner holds the lock on this database (waited ${LOCK_TIMEOUT_SEC}s).`);
  try {
    return await work();
  } finally {
    await conn.query("SELECT RELEASE_LOCK(CONCAT('eris_migrate:', LEFT(SHA2(DATABASE(), 256), 32)))");
  }
}

/** Create SchemaMigration from migration 003 itself, so the table definition has a single source. */
async function createMigrationTable(conn, files) {
  const bootstrap = files.find(f => f.version === BOOTSTRAP_VERSION);
  if (!bootstrap) throw new MigrationError(`The bootstrap migration ${BOOTSTRAP_VERSION}.sql is missing.`);
  for (const statement of splitStatements(bootstrap.sql)) await conn.query(statement);
}

async function applyOne(conn, migration, log) {
  const statements = splitStatements(migration.sql);
  if (!statements.length) throw new MigrationError(`Migration ${migration.file} contains no statements.`);
  await conn.query(
    `INSERT INTO ${MIGRATION_TABLE} (version, status, checksum, statements_applied) VALUES (?, 'RUNNING', ?, 0)`,
    [migration.version, migration.checksum]
  );
  for (let i = 0; i < statements.length; i += 1) {
    try {
      await conn.query(statements[i]);
    } catch (err) {
      const message = `${err.code || 'ERROR'}: ${err.message}`.slice(0, 1000);
      await conn.query(
        `UPDATE ${MIGRATION_TABLE} SET status = 'FAILED', statements_applied = ?, error_message = ? WHERE version = ?`,
        [i, message, migration.version]
      );
      throw new MigrationError(
        `Migration ${migration.file} failed at statement ${i + 1} of ${statements.length} (${message}). ` +
        `Statements 1-${i} stayed applied (MySQL DDL is not transactional). Nothing further was run.`,
        { version: migration.version, failedStatement: i + 1, statementsApplied: i, cause: err }
      );
    }
    await conn.query(`UPDATE ${MIGRATION_TABLE} SET statements_applied = ? WHERE version = ?`, [i + 1, migration.version]);
  }
  await conn.query(`UPDATE ${MIGRATION_TABLE} SET status = 'APPLIED' WHERE version = ?`, [migration.version]);
  log(`[MIGRATE] applied ${migration.file} (${statements.length} statement${statements.length === 1 ? '' : 's'})`);
}

/**
 * Apply every pending migration in order, on ONE dedicated connection.
 * @param {object} options
 * @param {string|null} options.baseline  for a database without SchemaMigration: the last version it already
 *                                        has ('none' = none of them). Refused once SchemaMigration exists.
 * @returns {Promise<{baselined:string[], applied:string[], pending:string[]}>}
 */
export async function runMigrations(conn, { dir = MIGRATIONS_DIR, baseline = null, dryRun = false, log = () => {} } = {}) {
  return withMigrationLock(conn, async () => {
    const files = listMigrationFiles(dir);
    const baselined = [];
    if (!(await tableExists(conn))) {
      const projectTables = (await listExistingTables(conn)).filter(t => SCHEMA_TABLES.includes(t));
      if (!projectTables.length) {
        throw new MigrationError('This database is empty. Create it with `npm run db:init` (schema.sql already contains every migration).');
      }
      if (baseline === null) {
        throw new MigrationError(
          'This database was created before the migration runner existed, so it is not known which migrations it has. ' +
          'Declare it once with --baseline <version>: the last migration already applied (for example 002 if the server ' +
          'started on it before this release), or --baseline none. See server/db/migrations/README.md.'
        );
      }
      const upTo = baseline === 'none' ? 0 : files.find(f => f.version === baseline || f.file.startsWith(`${baseline}_`))?.number;
      if (upTo === undefined) throw new MigrationError(`Unknown baseline "${baseline}": use a migration number such as 002, or none.`);
      if (dryRun) {
        return { baselined: files.filter(f => f.number <= upTo).map(f => f.version), applied: [], pending: files.filter(f => f.number > upTo).map(f => f.version) };
      }
      await createMigrationTable(conn, files);
      for (const f of files.filter(f => f.number <= upTo)) {
        await conn.query(`INSERT INTO ${MIGRATION_TABLE} (version, status, checksum, statements_applied) VALUES (?, 'BASELINE', NULL, 0)`, [f.version]);
        baselined.push(f.version);
      }
      log(`[MIGRATE] baseline recorded: ${baselined.length ? baselined.join(', ') : 'none'}`);
    } else if (baseline !== null) {
      throw new MigrationError('--baseline is only for a database without a SchemaMigration table; this one already records its migrations.');
    }

    const status = await migrationStatus(conn, { dir });
    if (status.problems.length) throw new MigrationError(`Refusing to migrate:\n  - ${status.problems.join('\n  - ')}`, { problems: status.problems });
    if (dryRun) return { baselined, applied: [], pending: status.pending.map(p => p.version) };

    const applied = [];
    for (const migration of status.pending) {
      await applyOne(conn, migration, log);
      applied.push(migration.version);
    }
    if (!applied.length) log('[MIGRATE] schema is up to date; nothing to apply');
    return { baselined, applied, pending: [] };
  });
}

/** Operator finished a FAILED (or interrupted RUNNING) migration by hand: record it as applied. */
export async function markApplied(conn, version, { dir = MIGRATIONS_DIR } = {}) {
  return withMigrationLock(conn, async () => {
    const file = listMigrationFiles(dir).find(f => f.version === version);
    if (!file) throw new MigrationError(`No migration file for ${version}.`);
    const [result] = await conn.query(
      `UPDATE ${MIGRATION_TABLE} SET status = 'APPLIED', checksum = ?, error_message = NULL WHERE version = ? AND status IN ('FAILED', 'RUNNING')`,
      [file.checksum, version]
    );
    if (result.affectedRows !== 1) throw new MigrationError(`${version} is not FAILED or RUNNING; nothing to mark.`);
  });
}

/** Operator restored the pre-migration state: forget the FAILED row so the next run starts it from statement 1. */
export async function retryFailed(conn, version) {
  return withMigrationLock(conn, async () => {
    const [result] = await conn.query(`DELETE FROM ${MIGRATION_TABLE} WHERE version = ? AND status IN ('FAILED', 'RUNNING')`, [version]);
    if (result.affectedRows !== 1) throw new MigrationError(`${version} is not FAILED or RUNNING; nothing to retry.`);
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new MigrationError(`${flag} needs a value.`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ quiet: true });
  const args = process.argv.slice(2);
  let conn;
  try {
    const config = resolveStorageConfig({ ...process.env, DB_USE_MEMORY: 'false' });
    conn = await connectForInit(config.mysql);
    const target = `${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`;
    if (args.includes('--status')) {
      const status = await migrationStatus(conn);
      console.log(`Migrations on ${target}:`);
      if (!status.tableExists) console.log('  (no SchemaMigration table: created before the runner; see --baseline)');
      for (const f of status.files) {
        const row = status.rows.find(r => r.version === f.version);
        console.log(`  ${f.version.padEnd(32)} ${row ? row.status : 'PENDING'}`);
      }
      status.problems.forEach(p => console.log(`  PROBLEM: ${p}`));
    } else if (argValue(args, '--mark-applied')) {
      await markApplied(conn, argValue(args, '--mark-applied'));
      console.log(`Recorded ${argValue(args, '--mark-applied')} as APPLIED on ${target}.`);
    } else if (argValue(args, '--retry')) {
      await retryFailed(conn, argValue(args, '--retry'));
      console.log(`Cleared ${argValue(args, '--retry')}; the next run applies it from its first statement.`);
    } else {
      const dryRun = args.includes('--dry-run');
      const result = await runMigrations(conn, { baseline: argValue(args, '--baseline'), dryRun, log: console.log });
      if (dryRun) console.log(`Dry run on ${target}: would baseline [${result.baselined.join(', ')}] and apply [${result.pending.join(', ')}].`);
      else console.log(`Migrations complete on ${target}: applied [${result.applied.join(', ')}].`);
    }
  } catch (err) {
    console.error(`[MIGRATE] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn?.end();
  }
}
