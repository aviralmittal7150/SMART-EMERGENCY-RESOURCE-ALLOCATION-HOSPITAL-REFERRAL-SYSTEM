// Shared helper for tests that need the dedicated MySQL test database.
//
// Credentials come from .env.local (git-ignored): MYSQL_TEST_HOST / _PORT / _USER / _PASS / _DB.
// Guards:
//  - the database name MUST end in "_test" (these tests drop and recreate its tables)
//  - a MySQL advisory lock serialises every test FILE that uses the database, because `node --test`
//    runs files in parallel processes and they would otherwise reset each other's data
// If credentials are missing or MySQL is unreachable the caller gets { skip } and should skip, not fail.

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { resetTestDatabase } from '../../server/db/init.js';

dotenv.config({ path: '.env.local', quiet: true });

export const testConfig = {
  host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER,
  password: process.env.MYSQL_TEST_PASS,
  database: process.env.MYSQL_TEST_DB
};

const LOCK_NAME = 'eris_test_database';

/**
 * @returns {Promise<{skip:string}|{admin:any, config:object, reset:Function, release:Function}>}
 */
export async function openTestDatabase() {
  if (!testConfig.user || !testConfig.database) return { skip: 'MYSQL_TEST_* not set in .env.local' };
  if (!/_test$/.test(testConfig.database)) {
    throw new Error(`Refusing to run: MYSQL_TEST_DB must end in "_test" (got "${testConfig.database}").`);
  }
  let admin;
  try {
    admin = await mysql.createConnection({ ...testConfig, multipleStatements: true, connectTimeout: 3000 });
  } catch (err) {
    return { skip: `MySQL unreachable (${err.code || err.message})` };
  }
  const [[{ got }]] = await admin.query('SELECT GET_LOCK(?, 600) AS got', [LOCK_NAME]);
  if (Number(got) !== 1) {
    await admin.end();
    throw new Error('Timed out waiting for the MySQL test-database lock held by another test file.');
  }
  return {
    admin,
    config: testConfig,
    /** Drop + recreate the project tables, optionally re-seeding the demo data. */
    reset: (seed = true) => resetTestDatabase(admin, testConfig.database, { seed }),
    async release() {
      try { await admin.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } finally { await admin.end(); }
    }
  };
}

/** Environment for a child `node server/server.js` that must use the MySQL test database. */
export function mysqlServerEnv(port, extra = {}) {
  return {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    DB_USE_MEMORY: 'false',
    DB_HOST: testConfig.host,
    DB_PORT: String(testConfig.port),
    DB_NAME: testConfig.database,
    DB_USER: testConfig.user,
    DB_PASS: testConfig.password,
    ...extra
  };
}
