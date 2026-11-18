// server/services/tracking/index.js
// The process's one TrackingEngine. server.js configures and starts it after the store is ready; until then (route
// tests that import routers directly) a default engine on the configured store with routing off is used.

import { store } from '../../db/store.js';
import { TrackingEngine } from './engine.js';
import { createRouter } from './routing.js';

let engine = null;

export function configureTracking(instance) {
  engine?.stop();
  engine = instance;
  return engine;
}

export function getTracking() {
  if (!engine) engine = new TrackingEngine({ store, router: createRouter({ url: null }) });
  return engine;
}
