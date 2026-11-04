// Allocation contract (tests/contract/allocation.contract.js) against the MYSQL store, on the dedicated
// *_test database only (see tests/helpers/mysqlTestDb.js). Skipped without credentials, unless
// REQUIRE_MYSQL_TESTS=true, which turns a missing or unreachable test database into a failure.
// The same scenarios run in memory in tests/contract_memory.test.js.

import test from 'node:test';
import { createMysqlBackend } from './contract/backends.js';
import { registerAllocationContract } from './contract/allocation.contract.js';

const backend = await createMysqlBackend();
if (backend.skip) {
  test.skip(`MySQL allocation contract (skipped: ${backend.skip})`, () => {});
} else {
  test.after(() => backend.close());
  registerAllocationContract(backend);
}
