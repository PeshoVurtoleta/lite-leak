import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, computed, dispose, createRoot, signal } from '@zakkster/lite-signal';
import { createLeakTracker } from '../Leak.js';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function tryForceCollect() {
  if (!global.gc) return;
  for (let i = 0; i < 8; i++) { global.gc(); await delay(10); }
}

test('track inside effect auto-untracks on effect dispose', () => {
  const t = createLeakTracker();
  let handle;

  const e = effect(() => {
    handle = t.track({}, () => {}, 'inside');
  });
  assert.equal(t.size(), 1);
  assert.equal(handle.disposed, false);

  dispose(e);

  assert.equal(t.size(), 0, 'auto-untrack fired via onCleanup');
  assert.equal(handle.disposed, true);
});

test('track outside any owner leaves ownerPath as null (verified via leak report)', () => {
  const reports = [];
  const t = createLeakTracker({ onLeak: (r) => reports.push(r) });
  const h = t.track({}, () => {}, 'no-owner');
  t.untrack(h);
  // No FR fire on explicit untrack; ownerPath check is in leak-report.test.js.
  assert.equal(reports.length, 0);
});

test('nested effect ownership: track adopts inner-most owner', () => {
  const t = createLeakTracker();
  const s = signal(0);
  let innerHandle;

  const outer = effect(() => {
    s(); // dep to force re-run
    effect(() => {
      innerHandle = t.track({}, () => {}, 'inner');
    });
  });

  assert.equal(t.size(), 1);
  dispose(outer);
  // Disposing outer cascades: inner effect disposed, its onCleanup fires,
  // handle untracked.
  assert.equal(t.size(), 0);
  assert.equal(innerHandle.disposed, true);
});

test('effect re-run cascade-untracks previous iteration handles', () => {
  const t = createLeakTracker();
  const s = signal(0);
  const handles = [];

  const e = effect(() => {
    s();
    handles.push(t.track({}, () => {}, 'iter-' + handles.length));
  });

  assert.equal(t.size(), 1);
  s.set(1); // trigger re-run
  assert.equal(handles.length, 2);
  assert.equal(handles[0].disposed, true, 'previous iteration untracked via onCleanup');
  assert.equal(t.size(), 1, 'only current iteration handle remains live');

  dispose(e);
  assert.equal(t.size(), 0);
});

test('createRoot detaches ownership: no auto-untrack on outer disposal', () => {
  const t = createLeakTracker();
  let innerHandle;
  let rootDisposer;

  const outer = effect(() => {
    createRoot(() => {
      innerHandle = t.track({}, () => {}, 'in-root');
    });
  });

  assert.equal(t.size(), 1);
  dispose(outer);
  // createRoot detached ownership, so inner track was NOT adopted by outer.
  // Handle survives outer dispose.
  assert.equal(t.size(), 1);
  assert.equal(innerHandle.disposed, false);

  // Caller-managed cleanup.
  t.untrack(innerHandle);
  assert.equal(t.size(), 0);
});

test('track inside computed body also auto-untracks on re-compute', () => {
  const t = createLeakTracker();
  const s = signal(1);
  const c = computed(() => {
    t.track({}, () => {}, 'per-compute-' + s());
    return s();
  });

  // Force initial compute
  c();
  assert.equal(t.size(), 1);

  s.set(2);
  c();
  assert.equal(t.size(), 1, 'previous compute handle untracked, current one live');

  dispose(c);
  assert.equal(t.size(), 0);
});
