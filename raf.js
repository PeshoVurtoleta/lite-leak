/**
 * Deterministic requestAnimationFrame harness. Adapted from the
 * ecosystem's installRaf/tick/armedCount pattern. Instead of patching
 * globalThis directly, returns an object whose requestAnimationFrame /
 * cancelAnimationFrame can be bound onto a kernel target (e.g.
 * `createRafOrphanKernel({ target })`) -- keeps tests hermetic.
 */

export function createMockRaf() {
  let nextId = 1;
  // id -> cb
  let queue = new Map();

  return {
    requestAnimationFrame(cb) {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      queue.delete(id);
    },
    /** Fire all currently-queued callbacks with the given timestamp. */
    tick(time) {
      const pending = queue;
      queue = new Map();
      let fired = 0;
      for (const [, cb] of pending) {
        try { cb(time); } catch (_e) { /* swallow */ }
        fired++;
      }
      return fired;
    },
    get armedCount() { return queue.size; },
  };
}
