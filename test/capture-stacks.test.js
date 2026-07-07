import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker } from '../Leak.js';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function tryForceCollect() {
  if (!global.gc) return;
  for (let i = 0; i < 8; i++) { global.gc(); await delay(10); }
}

test('captureStacks: false (default) sets origin to null', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    tracker.track({}, () => {}, 'x');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].origin, null);
});

test('captureStacks: true populates origin with stack string', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({
    captureStacks: true,
    onLeak: (r) => reports.push(r),
  });

  function distinctivelyNamedCallSite() {
    (function () {
      tracker.track({}, () => {}, 'stacked');
    })();
  }
  distinctivelyNamedCallSite();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(typeof reports[0].origin, 'string');
  assert.ok(reports[0].origin.length > 0);
  // The stack should contain the wrapping function's name.
  assert.match(reports[0].origin, /distinctivelyNamedCallSite/);
});

test('captureStacks: explicit false behaves like default', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({
    captureStacks: false,
    onLeak: (r) => reports.push(r),
  });

  (function () { tracker.track({}, () => {}); })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports[0].origin, null);
});

test('captureStacks: truthy-but-not-true values are treated as false', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  // Only strict `=== true` enables capture (documented). This guards against
  // accidental enabling via truthy but non-boolean options.
  const tracker = createLeakTracker({
    captureStacks: 1, // truthy but not === true
    onLeak: (r) => reports.push(r),
  });

  (function () { tracker.track({}, () => {}); })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports[0].origin, null, 'only === true enables capture');
});
