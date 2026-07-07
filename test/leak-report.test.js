import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker } from '../Leak.js';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function tryForceCollect() {
  if (!global.gc) return;
  for (let i = 0; i < 8; i++) { global.gc(); await delay(10); }
}

test('onLeak fires with correct report shape when target GCd without untrack', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    const target = { id: 'leaked' };
    tracker.track(target, () => {}, 'my-tag');
    // target goes out of scope, no untrack called
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.tag, 'my-tag');
  assert.equal(r.ownerPath, null, 'no owner context');
  assert.equal(r.origin, null, 'captureStacks default false');
  assert.equal(r.kind, 'unknown', 'M0 does not classify');
  assert.equal(typeof r.collectedAt, 'number');
  assert.ok(r.collectedAt >= 0);
  assert.equal(tracker.size(), 0);
});

test('onLeak does NOT fire on explicit untrack', () => {
  let count = 0;
  const t = createLeakTracker({ onLeak: () => { count++; } });
  const h = t.track({}, () => {}, 'x');
  t.untrack(h);
  assert.equal(count, 0);
});

test('onLeak does NOT fire on auto-untrack via owner cleanup', () => {
  let count = 0;
  const t = createLeakTracker({ onLeak: () => { count++; } });

  const e = effect(() => {
    t.track({}, () => {}, 'auto');
  });
  dispose(e);

  assert.equal(count, 0, 'clean owner disposal is not a leak');
});

test('onLeak fires when target created inside createRoot leaks', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  createRoot(() => {
    (function () {
      const target = { id: 'in-root' };
      tracker.track(target, () => {}, 'root-leak');
    })();
  });

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].tag, 'root-leak');
  assert.equal(reports[0].ownerPath, null, 'createRoot detached ownership');
});

test('ownerPath is populated when track happens inside an effect that leaks target externally', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  // Simulate the pathological case: effect adopts a target that escapes into
  // an external cache. If the effect is disposed and cleanup runs, the auto-
  // untrack fires -- no leak. To exhibit a real leak, we need to prevent
  // auto-untrack: use createRoot, but manually record an owner context via
  // a nested effect that we deliberately do NOT dispose.
  //
  // For a controlled test, we simulate leaking BEFORE the auto-onCleanup
  // wires up. That requires bypass, which isn't available at M0. So this
  // test verifies that when track IS called with an owner context, the
  // ownerPath is captured -- verified by inspecting the handle path via a
  // sentinel target that leaks through a global that outlives the effect.
  const escaped = [];

  const e = effect(() => {
    (function () {
      const target = { id: 'escaper' };
      escaped.push(target); // externalize
      tracker.track(target, () => {}, 'escaped');
    })();
  });

  // Effect is still live; handle is tracked. Now drop the external ref.
  escaped.length = 0;

  await tryForceCollect();
  await delay(20);

  // The effect is still alive, holding the handle via onCleanup closure.
  // But the target is dead (no external refs, its identity was closed over
  // only by the auto-onCleanup closure which retains the HANDLE not the
  // TARGET). FR fires.
  assert.equal(reports.length, 1, 'FR fired despite live effect');
  assert.equal(reports[0].tag, 'escaped');
  assert.ok(Array.isArray(reports[0].ownerPath), 'ownerPath is populated');
  assert.ok(reports[0].ownerPath.length >= 1, 'at least one frame');
  const frame = reports[0].ownerPath[0];
  assert.equal(typeof frame.id, 'number');
  assert.equal(frame.kind, 'effect');

  dispose(e);
});

test('onError fires with tag when cleanup throws on FR path', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const errs = [];
  const tracker = createLeakTracker({
    onError: (err, tag) => errs.push({ err, tag }),
  });

  (function () {
    tracker.track({}, () => { throw new Error('cleanup-boom'); }, 'thrower');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(errs.length, 1);
  assert.equal(errs[0].err.message, 'cleanup-boom');
  assert.equal(errs[0].tag, 'thrower');
});

test('missing onLeak / onError are optional; no crash', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const tracker = createLeakTracker();

  (function () {
    tracker.track({}, () => { throw new Error('boom'); }, 'silent');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(tracker.size(), 0);
});
