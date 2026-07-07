import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, signal } from '@zakkster/lite-signal';
import { createLeakTracker } from '../Leak.js';

test('auto-untrack fires exactly once per handle on owner cleanup', () => {
  const tracker = createLeakTracker();
  let handle;

  const e = effect(() => {
    handle = tracker.track({}, () => {}, 'x');
  });
  assert.equal(tracker.size(), 1);
  assert.equal(handle.disposed, false);

  dispose(e);
  assert.equal(tracker.size(), 0);
  assert.equal(handle.disposed, true);

  // Second dispose is a no-op.
  dispose(e);
  assert.equal(tracker.size(), 0);
});

test('auto-untrack does not fire on unrelated tracker', () => {
  const t1 = createLeakTracker({ name: 't1' });
  const t2 = createLeakTracker({ name: 't2' });

  const e = effect(() => {
    t1.track({}, () => {}, 'a');
  });

  assert.equal(t1.size(), 1);
  assert.equal(t2.size(), 0);

  dispose(e);
  assert.equal(t1.size(), 0);
  assert.equal(t2.size(), 0);
});

test('manual untrack before owner disposal still works; owner cleanup is no-op', () => {
  const tracker = createLeakTracker();
  let handle;

  const e = effect(() => {
    handle = tracker.track({}, () => {}, 'x');
  });
  assert.equal(tracker.size(), 1);

  tracker.untrack(handle);
  assert.equal(tracker.size(), 0);
  assert.equal(handle.disposed, true);

  // Owner cleanup fires but handle is already disposed -- lite-cleanup's
  // disposed guard makes this a no-op.
  dispose(e);
  assert.equal(tracker.size(), 0);
});

test('many tracks in one effect body all auto-untrack together', () => {
  const tracker = createLeakTracker();
  const handles = [];

  const e = effect(() => {
    for (let i = 0; i < 100; i++) {
      handles.push(tracker.track({}, () => {}, 'h-' + i));
    }
  });

  assert.equal(tracker.size(), 100);
  dispose(e);
  assert.equal(tracker.size(), 0);
  for (const h of handles) assert.equal(h.disposed, true);
});

test('effect that re-runs 10 times leaves exactly the last iterations handles live', () => {
  const tracker = createLeakTracker();
  const s = signal(0);
  const perRun = [];

  const e = effect(() => {
    const run = s();
    perRun.push([]);
    for (let i = 0; i < 3; i++) {
      perRun[perRun.length - 1].push(
        tracker.track({}, () => {}, 'run-' + run + '-i-' + i)
      );
    }
  });

  assert.equal(tracker.size(), 3);
  for (let r = 1; r <= 9; r++) {
    s.set(r);
    assert.equal(tracker.size(), 3, 'stays at 3 across re-runs');
  }

  // Verify all prior iterations are disposed.
  for (let i = 0; i < perRun.length - 1; i++) {
    for (const h of perRun[i]) assert.equal(h.disposed, true);
  }
  // Current iteration handles are live.
  for (const h of perRun[perRun.length - 1]) assert.equal(h.disposed, false);

  dispose(e);
  assert.equal(tracker.size(), 0);
});
