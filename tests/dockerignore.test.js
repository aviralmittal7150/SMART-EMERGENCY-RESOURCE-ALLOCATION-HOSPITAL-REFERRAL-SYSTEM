// The Docker build context must never include local secret files (COPY . . copies everything else), and the image
// runs as an unprivileged user on a current Node LTS (review finding X10).

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

test('.dockerignore excludes every .env* file; the only re-included one is the placeholder template .env.example', () => {
  assert.ok(patterns.includes('.env.*'), 'every .env.<name> file (e.g. .env.production) is excluded');
  const negations = patterns.filter(p => p.startsWith('!') && p.includes('.env'));
  assert.deepEqual(negations, ['!.env.example']);
  // The re-include must come after the exclusion it overrides (later rules win).
  assert.ok(patterns.indexOf('!.env.example') > patterns.indexOf('.env.*'));
});

test('.dockerignore keeps test-only code out of the image (tests/, e2e/ with its server helper and screenshots)', () => {
  for (const dir of ['tests', 'e2e']) {
    assert.ok(patterns.includes(dir), `${dir} must be listed in .dockerignore`);
  }
});

test('the image is built on Node 22 and runs as a non-root user', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^FROM node:22-(alpine|slim)\b/m);
  const user = dockerfile.match(/^USER\s+(\S+)/m)?.[1];
  assert.ok(user && user !== 'root' && user !== '0', 'a USER other than root is set');
  assert.ok(dockerfile.indexOf('USER ') < dockerfile.indexOf('CMD ['), 'USER is set before the server starts');
});
