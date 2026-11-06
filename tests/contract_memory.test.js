// Allocation contract (tests/contract/allocation.contract.js) against the IN-MEMORY store.
// The same scenarios run against MySQL in tests/contract_mysql.test.js.

import test from 'node:test';
import { createMemoryBackend } from './contract/backends.js';
import { registerAllocationContract } from './contract/allocation.contract.js';

const backend = await createMemoryBackend();
test.after(() => backend.close());
registerAllocationContract(backend);
