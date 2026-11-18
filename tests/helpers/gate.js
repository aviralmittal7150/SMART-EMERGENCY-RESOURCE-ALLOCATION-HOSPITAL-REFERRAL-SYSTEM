// A one-shot rendezvous for forcing interleavings with ExecutionHooks (server/services/executionHooks.js).
//
//   const g = gate();
//   engine.hooks.once('commit:requestLocked', g.hold);   // the operation pauses here...
//   const accept = store.commitReferral(id);
//   const ctx = await g.reached;                          // ...we know it is paused (and see its context)
//   ... start the competing operation ...
//   g.release();                                          // let the paused operation continue
//
// No sleeps: every step waits for an explicit event.

export function gate() {
  let arrive;
  let open;
  const reached = new Promise(resolve => { arrive = resolve; });
  const opened = new Promise(resolve => { open = resolve; });
  return {
    reached,
    release: () => open(),
    hold: async context => {
      arrive(context);
      await opened;
    }
  };
}
