import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker } from '../Leak.js';

test('10000 track/untrack cycles retain < 2 MB', (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');

  const tracker = createLeakTracker();

  // Warm up JIT and any lazy allocations.
  for (let i = 0; i < 1000; i++) {
    const h = tracker.track({}, () => {});
    tracker.untrack(h);
  }
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;

  for (let i = 0; i < 10000; i++) {
    const h = tracker.track({}, () => {});
    tracker.untrack(h);
  }
  global.gc();
  global.gc();
  const after = process.memoryUsage().heapUsed;

  const retained = after - before;
  const budget = 2 * 1024 * 1024;

  assert.ok(
    retained < budget,
    `retained ${retained} bytes over 10K cycles (budget: ${budget})`
  );
  assert.equal(tracker.size(), 0);
});

test('10000 tracks with tags then bulk untrack returns near baseline', (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');

  const tracker = createLeakTracker();

  for (let i = 0; i < 1000; i++) {
    const h = tracker.track({}, () => {});
    tracker.untrack(h);
  }
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;

  const handles = new Array(10000);
  for (let i = 0; i < 10000; i++) {
    handles[i] = tracker.track({}, () => {}, 'tag-' + i);
  }
  for (let i = 0; i < 10000; i++) {
    tracker.untrack(handles[i]);
    handles[i] = null;
  }
  global.gc();
  global.gc();
  const after = process.memoryUsage().heapUsed;

  const retained = after - before;
  // Larger budget because tag strings interned during the cycle live longer.
  const budget = 3 * 1024 * 1024;

  assert.ok(
    retained < budget,
    `retained ${retained} bytes over 10K batched cycles (budget: ${budget})`
  );
  assert.equal(tracker.size(), 0);
});
