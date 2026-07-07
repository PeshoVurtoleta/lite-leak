import './_helpers/dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createOwnerCascadeOrphanKernel,
  createTimerOrphanKernel,
  createListenerOrphanKernel,
  createObserverOrphanKernel,
  createDetachedDomKernel,
  createAsyncRetentionKernel,
} from '../Leak.js';
import { GC_AVAILABLE, heapNow } from './_helpers/gc.js';
import { createMockClock } from './_helpers/clock.js';

// Per-kernel retained-heap budget suite. Each kernel is exercised over N
// cycles of (create/dispose) inside effects; heap delta measured before
// and after with the JIT warmed. Budgets are generous -- we're catching
// runaway growth, not micro-regressions -- and tests skip cleanly without
// --expose-gc.

const CYCLES = 5000;
const BUDGET_BYTES = 3 * 1024 * 1024; // 3 MB across 5k cycles

function runCycles(fn) {
  // Warm-up
  for (let i = 0; i < 500; i++) fn(i);
  heapNow(); // force GC
  const before = heapNow();
  for (let i = 0; i < CYCLES; i++) fn(i);
  const after = heapNow();
  return after - before;
}

test('owner-cascade-orphan: 5000 track/dispose cycles retain < budget', (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  const retained = runCycles(() => {
    const e = effect(() => {
      tracker.track({}, () => {}, 'x', { audit: true });
    });
    dispose(e);
  });
  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
});

test('timer-orphan: 5000 setTimeout/dispose cycles retain < budget', (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const clock = createMockClock();
  const target = Object.create(null);
  target.setTimeout = clock.setTimeout.bind(clock);
  target.clearTimeout = clock.clearTimeout.bind(clock);

  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target, warnOnNoOwner: false }));

  const retained = runCycles(() => {
    const e = effect(() => {
      target.setTimeout(() => {}, 100);
    });
    dispose(e);
  });
  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
});

test('listener-orphan: 5000 addEventListener/dispose cycles retain < budget', (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const tracker = createLeakTracker();
  tracker.registerKernel(createListenerOrphanKernel());

  const retained = runCycles(() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const e = effect(() => {
      el.addEventListener('click', () => {});
    });
    dispose(e);
    el.remove();
  });
  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
});

test('observer-orphan: 5000 MutationObserver/dispose cycles retain < budget', (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const target = {
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  const tracker = createLeakTracker();
  tracker.registerKernel(createObserverOrphanKernel({ target, warnOnNoOwner: false }));

  const retained = runCycles(() => {
    const e = effect(() => {
      new target.MutationObserver(() => {});
    });
    dispose(e);
  });
  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
});

test('detached-dom: 5000 watch/detach cycles retain < budget', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document, warnOnDetach: false });
  tracker.registerKernel(kernel);

  // Warm-up
  for (let i = 0; i < 500; i++) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    kernel.watch(el, 'w');
    el.remove();
  }
  // Let MutationObserver drain (it queues on microtasks; the sync loop
  // above accumulated 500 records that need processing).
  await new Promise((r) => setTimeout(r, 20));
  heapNow();
  const before = heapNow();

  const YIELD_EVERY = 200;
  for (let i = 0; i < CYCLES; i++) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    kernel.watch(el, 'x');
    el.remove();
    // Yield periodically so the MutationObserver's queued records get
    // processed and the kernel reaps stale entries. This models real-world
    // usage; without it the sync loop overwhelms the observer's queue.
    if (i % YIELD_EVERY === YIELD_EVERY - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // Final drain
  await new Promise((r) => setTimeout(r, 20));
  const after = heapNow();
  const retained = after - before;

  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
  tracker.unregisterKernel(kernel);
});

test('async-retention: 5000 AbortController/dispose cycles retain < budget', (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const target = { AbortController: globalThis.AbortController };
  const tracker = createLeakTracker();
  tracker.registerKernel(createAsyncRetentionKernel({ target, warnOnNoOwner: false }));

  const retained = runCycles(() => {
    const e = effect(() => {
      new target.AbortController();
    });
    dispose(e);
  });
  assert.ok(retained < BUDGET_BYTES,
    `retained ${retained} bytes over ${CYCLES} cycles (budget ${BUDGET_BYTES})`);
});
