// server/db/store.js
// The data-store interface the routes talk to. Exactly one backend is configured at startup
// (server/db/bootstrap.js) and every route goes through `store`, so handlers are identical in
// memory and MySQL mode.
//
// Backends: MemoryStore (demo, non-persistent) and MySqlStore (persistent). Both implement the
// same async methods and throw StoreError for business-level refusals.
//
// There is NO implicit backend in production: if nothing was configured, using the store throws
// instead of quietly serving demo data. Outside production an unconfigured store defaults to the
// in-memory store so tests and scripts can import routers directly.

import { MemoryStore } from './memoryStore.js';

let current = null;

export function configureStore(implementation) {
  current = implementation;
}

export function getStore() {
  if (!current) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('No data store configured. Call bootstrapStore() before serving requests.');
    }
    current = new MemoryStore();
  }
  return current;
}

/** Lazy delegate: routes import this once; the backend is resolved on each call. */
export const store = new Proxy({}, {
  get(_target, property) {
    const backend = getStore();
    const value = backend[property];
    return typeof value === 'function' ? value.bind(backend) : value;
  }
});

export default store;
