// server/services/accountEvents.js
// In-process notice that an account changed (admin API). server.js re-checks that account's live sockets at once, so
// a revoked or re-scoped session does not wait for the periodic re-check (Batch 6 round 2).

import { EventEmitter } from 'node:events';

export const accountEvents = new EventEmitter();

export const announceAccountChange = userId => accountEvents.emit('changed', userId);
