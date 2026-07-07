/**
 * Deterministic mock clock for timer-kernel tests.
 *
 * Provides setTimeout/clearTimeout/setInterval/clearInterval on a
 * user-controlled clock. `advance(ms)` fires every timer that comes due
 * within the window in chronological order. Ports and extends the
 * createMockClock harness used across the @zakkster/lite-* ecosystem.
 */

export function createMockClock(initial = 0) {
  let current = initial;
  let nextId = 1;
  // id -> { at, fn, kind: 'timeout' | 'interval', ms }
  const timers = new Map();

  function schedule(fn, ms, kind) {
    const id = nextId++;
    timers.set(id, { at: current + ms, fn, kind, ms });
    return id;
  }

  return {
    now: () => current,

    setTimeout(fn, ms) { return schedule(fn, ms, 'timeout'); },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { return schedule(fn, ms, 'interval'); },
    clearInterval(id) { timers.delete(id); },

    /**
     * Advance the clock by `ms`, firing every timer that comes due in
     * chronological order. Intervals re-schedule themselves after firing.
     */
    advance(ms) {
      const target = current + ms;
      while (true) {
        let dueId = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) { dueId = id; dueAt = t.at; }
        }
        if (dueId === null) break;
        const t = timers.get(dueId);
        current = t.at;
        if (t.kind === 'interval') {
          // Re-schedule BEFORE firing so a clearInterval inside the callback
          // actually sticks.
          t.at = current + t.ms;
          try { t.fn(); } catch (_e) { /* swallow */ }
        } else {
          timers.delete(dueId);
          try { t.fn(); } catch (_e) { /* swallow */ }
        }
      }
      current = target;
    },

    async flush() {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },

    get pendingCount() { return timers.size; },
  };
}
