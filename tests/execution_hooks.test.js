// Unit tests for the test-only pause points (server/services/executionHooks.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionHooks } from '../server/services/executionHooks.js';
import { lockingEngine } from '../server/services/lockingEngine.js';

test('no handler: inactive, and run() resolves without doing anything', async () => {
  const hooks = new ExecutionHooks();
  assert.equal(hooks.active('x'), false);
  await hooks.run('x', { any: 1 });
});

test('on(): the handler receives the context; the returned function removes only that handler', async () => {
  const hooks = new ExecutionHooks();
  const seen = [];
  const off = hooks.on('p', ctx => { seen.push(ctx.n); });
  await hooks.run('p', { n: 1 });
  const offStale = off;
  const replacement = hooks.on('p', ctx => { seen.push(-ctx.n); }); // replaces the first
  offStale(); // must not remove the replacement
  await hooks.run('p', { n: 2 });
  replacement();
  assert.equal(hooks.active('p'), false);
  assert.deepEqual(seen, [1, -2]);
});

test('once(): runs for the first matching call only, honouring the filter', async () => {
  const hooks = new ExecutionHooks();
  const seen = [];
  hooks.once('p', ctx => { seen.push(ctx.n); }, ctx => ctx.n >= 2);
  await hooks.run('p', { n: 1 }); // filtered out, handler stays installed
  assert.equal(hooks.active('p'), true);
  await hooks.run('p', { n: 2 });
  await hooks.run('p', { n: 3 });
  assert.deepEqual(seen, [2]);
  assert.equal(hooks.active('p'), false);
});

test('run() waits for an async handler before continuing', async () => {
  const hooks = new ExecutionHooks();
  const order = [];
  let release;
  hooks.on('p', () => new Promise(resolve => { release = resolve; order.push('paused'); }));
  const running = hooks.run('p').then(() => order.push('resumed'));
  await Promise.resolve();
  order.push('other work');
  release();
  await running;
  assert.deepEqual(order, ['paused', 'other work', 'resumed']);
});

test('the in-memory engine exposes an inactive hook registry by default', () => {
  assert.ok(lockingEngine.hooks instanceof ExecutionHooks);
  assert.equal(lockingEngine.hooks.active('commit:requestLocked'), false);
});
