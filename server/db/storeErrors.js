// server/db/storeErrors.js
// Business-level refusals raised by a data store. Routes translate them into HTTP responses;
// anything else (connection loss, SQL error) propagates as a 500 and is never shown to clients.

export class StoreError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
  }
}

/** Send a StoreError as its HTTP response; returns false for any other error so the caller can rethrow. */
export function respondStoreError(res, err) {
  if (!(err instanceof StoreError)) return false;
  res.status(err.status).json({ error: err.message });
  return true;
}
