// tests/concurrency_stress.test.js
// Concurrency stress against the REAL in-memory engine (round-1 review L-T1): the shared scenario in
// tests/contract/stress.contract.js (30 cases stampeding 3 hospitals with 9 slots, then accept / reject-with-failover
// / retry, then cancel-all) through the store API. The same scenario runs on MySQL in tests/contract_mysql.test.js.

import test from 'node:test';
import { createMemoryBackend } from './contract/backends.js';
import { registerStressContract } from './contract/stress.contract.js';

const backend = await createMemoryBackend();
test.after(() => backend.close());
registerStressContract(backend);
