// Allocation, specialist and staged-claim and audit-chain contracts (tests/contract/{allocation,specialists,staged,audit,analytics}.contract.js) against the IN-MEMORY store.
// The same scenarios run against MySQL in tests/contract_mysql.test.js.

import test from 'node:test';
import { createMemoryBackend } from './contract/backends.js';
import { registerAllocationContract } from './contract/allocation.contract.js';
import { registerSpecialistContract } from './contract/specialists.contract.js';
import { registerStagedContract } from './contract/staged.contract.js';
import { registerAuditContract } from './contract/audit.contract.js';
import { registerAnalyticsContract } from './contract/analytics.contract.js';

const backend = await createMemoryBackend();
test.after(() => backend.close());
registerAllocationContract(backend);
registerSpecialistContract(backend);
registerStagedContract(backend);
registerAuditContract(backend);
registerAnalyticsContract(backend);
