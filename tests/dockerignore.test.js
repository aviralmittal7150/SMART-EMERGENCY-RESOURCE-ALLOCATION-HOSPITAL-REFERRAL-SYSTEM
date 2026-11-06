// The Docker build context must never include local secret files (COPY . . copies everything else).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const patterns = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8')
  .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

test('.dockerignore excludes .env and .env.local (local MySQL test credentials)', () => {
  for (const secret of ['.env', '.env.local']) {
    assert.ok(patterns.includes(secret), `${secret} must be listed in .dockerignore`);
  }
  assert.ok(patterns.includes('.env.*.local'), 'per-environment local env files must be excluded too');
});

test('.dockerignore does not re-include an env file with a negation rule', () => {
  assert.equal(patterns.filter(p => p.startsWith('!') && p.includes('.env')).length, 0);
});
