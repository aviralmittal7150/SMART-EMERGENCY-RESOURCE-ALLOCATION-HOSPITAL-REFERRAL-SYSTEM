// Test-only preload (see tests/memory_lock_parity.test.js): records, for every child process this process spawns,
// whether its environment carries any MYSQL_TEST_* variable, and at exit prints presence booleans only (never values).
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const KEYS = ['MYSQL_TEST_HOST', 'MYSQL_TEST_PORT', 'MYSQL_TEST_USER', 'MYSQL_TEST_PASS', 'MYSQL_TEST_DB'];
const spawned = [];
const original = childProcess.spawn;
childProcess.spawn = function spawn(command, args, options) {
  spawned.push(Object.keys(options?.env ?? process.env).some(k => k.startsWith('MYSQL_TEST_')));
  return original.call(this, command, args, options);
};
syncBuiltinESMExports(); // `import { spawn } from 'node:child_process'` now sees the wrapper

process.on('exit', () => {
  const parent = Object.fromEntries(KEYS.map(k => [k, k in process.env]));
  fs.writeSync(1, `CREDENTIAL-PROBE ${JSON.stringify({ parent, spawnedWithMysqlTest: spawned })}\n`);
});
