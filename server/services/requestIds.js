// server/services/requestIds.js
// Request id candidates, shared by both stores so they allocate ids the same way (review finding X8).
// The familiar four-digit REQ-#### space (9,000 ids) is tried first; after 20 collisions the candidate widens to six
// digits (900,000 ids). The number of attempts is bounded: a store that cannot find a free id fails with an error
// instead of looping forever.

export const MAX_REQUEST_ID_ATTEMPTS = 40;
export const NARROW_ATTEMPTS = 20;

export function candidateRequestId(attempt, random = Math.random) {
  return attempt < NARROW_ATTEMPTS
    ? `REQ-${Math.floor(1000 + random() * 9000)}`
    : `REQ-${Math.floor(100000 + random() * 900000)}`;
}

export class RequestIdExhaustedError extends Error {
  constructor() {
    super(`Could not allocate a unique request id after ${MAX_REQUEST_ID_ATTEMPTS} attempts.`);
    this.name = 'RequestIdExhaustedError';
  }
}
