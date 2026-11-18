// server/services/executionHooks.js
// Named pause points inside the locking engines and stores, used ONLY by tests to force an exact
// interleaving of concurrent operations (for example: "hold this accept after it has locked the
// request row, then start a cancellation"), instead of relying on sleeps and timing.
//
// Production cost is a Map lookup per point: call sites guard with `if (hooks.active(name))` so no
// extra `await` (and therefore no extra interleaving opportunity) exists when nothing is installed.
// Handlers can only be installed in-process from code; nothing here is reachable from the API.

export class ExecutionHooks {
  constructor() {
    this._handlers = new Map();
  }

  /** True when a handler is installed for `point`. Call sites check this before awaiting run(). */
  active(point) {
    return this._handlers.has(point);
  }

  /** Invoke the handler for `point` (if any) and wait for it. */
  async run(point, context = {}) {
    const handler = this._handlers.get(point);
    if (handler) await handler(context);
  }

  /** Install `handler` for `point`, replacing any previous one. Returns a function that removes it. */
  on(point, handler) {
    this._handlers.set(point, handler);
    return () => {
      if (this._handlers.get(point) === handler) this._handlers.delete(point);
    };
  }

  /**
   * Install a handler that runs for the first matching call only, then removes itself.
   * `filter(context)` (optional) selects which call counts as the match.
   */
  once(point, handler, filter = () => true) {
    const wrapped = async context => {
      if (!filter(context)) return;
      if (this._handlers.get(point) === wrapped) this._handlers.delete(point);
      await handler(context);
    };
    return this.on(point, wrapped);
  }

  /** Remove every handler. */
  clear() {
    this._handlers.clear();
  }
}
