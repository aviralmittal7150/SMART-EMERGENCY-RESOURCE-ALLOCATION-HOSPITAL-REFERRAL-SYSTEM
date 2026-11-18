// Allocation, specialist and staged-claim and audit-chain contracts (tests/contract/{allocation,specialists,staged,audit,analytics}.contract.js) against the MYSQL store, on the dedicated
// *_test database only (see tests/helpers/mysqlTestDb.js). Skipped without credentials, unless
// REQUIRE_MYSQL_TESTS=true, which turns a missing or unreachable test database into a failure.
// The same scenarios run in memory in tests/contract_memory.test.js.

import test from 'node:test';
import { createMysqlBackend } from './contract/backends.js';
import { registerAllocationContract } from './contract/allocation.contract.js';
import { registerSpecialistContract } from './contract/specialists.contract.js';
import { registerStagedContract } from './contract/staged.contract.js';
import { registerAuditContract } from './contract/audit.contract.js';
import { registerAnalyticsContract } from './contract/analytics.contract.js';
import { registerStressContract } from './contract/stress.contract.js';

const backend = await createMysqlBackend();
if (backend.skip) {
  test.skip(`MySQL allocation contract (skipped: ${backend.skip})`, () => {});
} else {
  test.after(() => backend.close());
  registerAllocationContract(backend);
  registerSpecialistContract(backend);
  registerStagedContract(backend);
  registerAuditContract(backend);
  registerAnalyticsContract(backend);
  registerStressContract(backend); // L-T1; the memory run is tests/concurrency_stress.test.js
}
