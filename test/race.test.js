import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker } from '../Leak.js';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function tryForceCollect() {
  if (!global.gc) return;
  for (let i = 0; i < 8; i++) { global.gc(); await delay(10); }
}

test('untrack AFTER FR has fired does not double-fire onLeak', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  let handle;

  (function () {
    const target = {};
    handle = tracker.track(target, () => {}, 'x');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1, 'FR fired once');

  // Caller (unaware) tries to untrack the already-disposed handle.
  tracker.untrack(handle);

  assert.equal(reports.length, 1, 'no double-fire');
  assert.equal(tracker.size(), 0);
});

test('untrack-then-target-death does not fire onLeak', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    const target = {};
    const handle = tracker.track(target, () => {}, 'x');
    tracker.untrack(handle);
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 0);
  assert.equal(tracker.size(), 0);
});
