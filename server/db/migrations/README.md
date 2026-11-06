# Database migrations

Schema changes for the MySQL store, applied in order by the migration runner
(`server/db/migrate.js`). The application never migrates by itself: at start-up it refuses to run while
any migration is pending, failed or edited, and names the problem.

| File | Change |
|---|---|
| `001_referral_lifecycle.sql` | Ambulance assignment columns, `CANCELLED` referral status, requirement columns, audit rows outlive their case |
| `002_idempotency_keys.sql` | `IdempotencyKey` table |
| `003_schema_migration.sql` | `SchemaMigration` bookkeeping table used by the runner |

The notes inside 001 and 002 about running them by hand date from before the runner. They are kept
unchanged on purpose: an applied migration file must never be edited (the runner checks a SHA-256 of
each file it applied).

## Commands

```
npm run db:migrate                         # apply pending migrations, in order
npm run db:migrate -- --status             # show applied / pending; changes nothing
npm run db:migrate -- --dry-run            # show what would be applied; changes nothing
```

Connection settings come from `DB_*` (see `.env.example`). Run the runner only against the database you
intend to change, and take a backup first: MySQL DDL is not transactional.

## Which situation are you in?

- **New, empty database:** `npm run db:init` (optionally `npm run db:seed`). `schema.sql` already contains
  every migration and records them as `BASELINE`, so `db:migrate` then reports "up to date".
- **Database created before the runner existed** (no `SchemaMigration` table; the server refuses to start
  and asks for it): declare once what it already has, then the runner applies the rest.
  - It started cleanly before this release (001 and 002 applied): `npm run db:migrate -- --baseline 002`
  - It predates 001 entirely: `npm run db:migrate -- --baseline none`
  The runner refuses to guess, and `db:init` refuses to run over such a database (it would record
  migrations it never applied).
- **Database already managed by the runner:** `npm run db:migrate`.

## When a migration fails

The runner records each statement as it completes. On failure the migration is marked `FAILED` with the
number of statements that completed, the runner stops, and the server refuses to start. Nothing is re-run
automatically. Resolve it in one of two ways:

1. Finish the remaining statements by hand, then `npm run db:migrate -- --mark-applied <version>`.
2. Undo the completed statements (restore the previous state), fix the cause, then
   `npm run db:migrate -- --retry <version>` and run `npm run db:migrate` again; it starts from statement 1.

A migration left `RUNNING` (the process was killed) is resolved the same way.

## Adding a migration

1. Add `server/db/migrations/NNN_short_name.sql` with the next number (numbers are contiguous from 001;
   a gap, a duplicate or a lower number than an applied migration is refused).
2. Apply the same change to `server/db/schema.sql` and add `('NNN_short_name', 'BASELINE')` to its
   `INSERT IGNORE INTO SchemaMigration` list. `tests/migration_runner.test.js` fails until you do.
3. Extend `checkSchema` in `server/db/bootstrap.js` only if the code needs a specific column or table to
   start safely; pending migrations are already reported generically.
4. Prove it in `tests/mysql_migration_runner.test.js` / `tests/mysql_migration.test.js` (upgraded database
   identical to a fresh one, data kept). Never edit a migration once it has been applied anywhere.
