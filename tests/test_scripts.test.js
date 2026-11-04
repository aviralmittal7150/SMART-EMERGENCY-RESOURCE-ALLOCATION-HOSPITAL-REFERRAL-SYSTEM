// `npm run test:mysql` must list every test file that uses the MySQL test database, explicitly.
// (`npm test` runs every tests/*.test.js anyway; this keeps the focused MySQL command honest.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const testDir = new URL('./', import.meta.url);

test('test:mysql lists every MySQL-backed test file, and only files that exist', () => {
  const listed = pkg.scripts['test:mysql'].split(/\s+/).filter(arg => arg.startsWith('tests/'));
  // A file runs against MySQL when it opens the test database itself, builds the MySQL contract backend, or
  // forces the MySQL variant of a shared scenario. A file that only *reads* API_TEST_BACKEND (memory by
  // default) is reached through its wrapper instead.
  const runsOnMysql = source => !/process\.env\.API_TEST_BACKEND ===/.test(source)
    && [/^import .*'\.\/helpers\/mysqlTestDb\.js';$/m, /= await createMysqlBackend\(\)/, /^process\.env\.API_TEST_BACKEND = 'mysql';$/m].some(re => re.test(source));
  const usesMysql = fs.readdirSync(testDir)
    .filter(name => name.endsWith('.test.js'))
    .filter(name => runsOnMysql(fs.readFileSync(new URL(name, testDir), 'utf8')))
    .map(name => `tests/${name}`)
    .sort();
  assert.deepEqual([...listed].sort(), usesMysql);
  for (const file of ['tests/contract_mysql.test.js', 'tests/mysql_deadlock_retry.test.js', 'tests/mysql_migration_runner.test.js']) {
    assert.ok(listed.includes(file), `${file} must be in test:mysql`);
  }
});

test('db:migrate runs the migration runner', () => {
  assert.equal(pkg.scripts['db:migrate'], 'node server/db/migrate.js');
});
