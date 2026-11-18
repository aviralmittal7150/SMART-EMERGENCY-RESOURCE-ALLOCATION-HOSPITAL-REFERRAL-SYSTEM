// scripts/seed-demo-users.js
// `npm run db:seed-demo-users`: add ONLY the fictional demo accounts (bcrypt hashes, is_demo = 1) to an existing MySQL
// database, for example one upgraded with migration 008 that already holds hospitals and cases (round 2, item 8).
// Missing accounts are inserted; an existing user id or username is left untouched, so re-running changes nothing.
//
// Safety, as the other database tools: refused when NODE_ENV=production, and refused (unless --force) when the
// database already has active non-demo accounts (demo accounts are never created there and are
// refused at login anyway); the target comes only from the DB_* settings (no defaults); the database password is never
// printed; and the database must be at the current schema (checkSchema), so nothing is written into a half-migrated one.

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveStorageConfig } from '../server/db/config.js';
import { connectForInit, insertDemoUsers } from '../server/db/init.js';
import { checkSchema } from '../server/db/bootstrap.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ quiet: true });
  let conn;
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Refusing: demo accounts are never created when NODE_ENV=production. Use `npm run user:create`.');
    }
    const config = resolveStorageConfig({ ...process.env, DB_USE_MEMORY: 'false' });
    const target = `${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`;
    conn = await connectForInit(config.mysql);
    const problems = await checkSchema(conn);
    if (problems.length) throw new Error(`The database ${target} is not at the current schema (${problems.join('; ')}). Run \`npm run db:migrate\` first.`);
    // A database that already has real accounts is probably not a throwaway one: adding known demo logins needs --force.
    const [[real]] = await conn.query('SELECT COUNT(*) AS n FROM SystemUser WHERE is_demo = 0 AND is_active = 1');
    if (Number(real.n) > 0 && !process.argv.includes('--force')) {
      throw new Error(`Refusing: ${target} already has ${real.n} active non-demo account(s). Demo logins with published passwords do not belong there; pass --force only if this database is a disposable one.`);
    }
    const { inserted, skipped } = await insertDemoUsers(conn);
    console.log(`Demo accounts on ${target}: inserted [${inserted.join(', ')}]; left as they were or not applicable [${skipped.join(', ')}].`);
  } catch (err) {
    console.error(`[SEED-DEMO-USERS] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn?.end();
  }
}
