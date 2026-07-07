/**
 * Test helpers -- allocation and finalization support for --expose-gc mode.
 * Mirrors the setup.js pattern used across @zakkster/lite-* test suites.
 */

export const GC_AVAILABLE = typeof globalThis.gc === 'function';

/**
 * Force a GC and return the resulting heapUsed in bytes. Returns NaN if
 * --expose-gc isn't on.
 */
export function heapNow() {
  if (!GC_AVAILABLE) return NaN;
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

/**
 * Measure heap delta across a closure, in bytes. Returns NaN if --expose-gc
 * isn't on.
 */
export function heapDelta(fn) {
  if (!GC_AVAILABLE) { fn(); return NaN; }
  const before = heapNow();
  fn();
  const after = heapNow();
  return after - before;
}

/**
 * Force GC across multiple rounds with microtask yields. Returns a promise
 * that resolves after enough rounds for FinalizationRegistry callbacks to
 * fire in normal cases. Callers should still await an additional short delay
 * (5-20ms) before asserting on FR-driven side effects; the FR is not
 * synchronous with respect to GC.
 */
export async function tryForceCollect(rounds = 8, delayMs = 10) {
  if (!GC_AVAILABLE) return;
  for (let i = 0; i < rounds; i++) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Sleep for `ms` milliseconds. */
export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
