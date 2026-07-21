/**
 * Executable checks for COOKBOOK.md.
 *
 * A cookbook whose recipes no longer run is worse than no cookbook, because the
 * reader trusts it. Each test here corresponds to a numbered recipe and asserts
 * the behaviour that recipe promises. If one fails, fix the recipe as well as
 * the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLeakTracker, createDefaultKernels, createTimerOrphanKernel,
  createRafOrphanKernel, createGenericSink, KernelConflictError,
} from '../Leak.js';

/** Target exposing timers plus rAF, enough for the composition recipes. */
function makeTarget() {
  return {
    setTimeout: function () { return 1; }, clearTimeout: function () {},
    setInterval: function () { return 1; }, clearInterval: function () {},
    requestAnimationFrame: function () { return 1; }, cancelAnimationFrame: function () {},
  };
}

test('recipe 1: the preset returns kernels plus an honest skipped list', () => {
  const { kernels, skipped } = createDefaultKernels({ target: makeTarget() });
  assert.ok(Array.isArray(kernels) && kernels.length > 0);
  assert.ok(Array.isArray(skipped));
  for (const s of skipped) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.reason.length > 0, 'every skip carries a reason the reader can act on');
  }
});

test('recipe 2: audit() is synchronous and remediate() answers for its findings', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const { kernels } = createDefaultKernels({ target });
  for (const k of kernels) tracker.registerKernel(k);

  target.setTimeout(function () {}, 1000);
  const findings = tracker.audit();
  assert.ok(findings.length > 0);
  for (const f of findings) {
    const advice = tracker.remediate(f);
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0);
  }
  for (const k of kernels) tracker.unregisterKernel(k);
});

test('recipe 3: track returns a handle and untrack releases it', () => {
  const tracker = createLeakTracker();
  const conn = { id: 1 };
  const handle = tracker.track(conn, function () {}, 'db-connection');
  assert.equal(tracker.size(), 1);
  tracker.untrack(handle);
  assert.equal(tracker.size(), 0);
});

test('recipe 5: composing timer + raf by hand throws, and handleRaf:false fixes it', () => {
  const target = makeTarget();
  const bad = createLeakTracker();
  bad.registerKernel(createTimerOrphanKernel({ target }));
  assert.throws(() => bad.registerKernel(createRafOrphanKernel({ target })), KernelConflictError,
    'the cookbook documents this collision -- if it stops throwing, update recipe 5');

  const good = createLeakTracker();
  assert.doesNotThrow(() => {
    good.registerKernel(createTimerOrphanKernel({ target, handleRaf: false }));
    good.registerKernel(createRafOrphanKernel({ target }));
  });
});

test('recipe 5: the preset already cedes rAF to raf-orphan', () => {
  const { kernels } = createDefaultKernels({ target: makeTarget() });
  const timer = kernels.find((k) => k.name === 'timer-orphan');
  const raf = kernels.find((k) => k.name === 'raf-orphan');
  assert.ok(!timer.patchSurfaces.includes('requestAnimationFrame'));
  assert.ok(raf.patchSurfaces.includes('requestAnimationFrame'));
});

test('recipe 12: a repeated mount/unmount loop returns the counts to zero', () => {
  const tracker = createLeakTracker();
  for (let i = 0; i < 200; i++) {
    const handle = tracker.track({ i }, function () {}, 'row');
    tracker.untrack(handle);
  }
  assert.deepEqual(tracker.audit(), []);
  assert.equal(tracker.size(), 0);
});

test('recipe 16: a sink is four handlers wired at construction', () => {
  const seen = [];
  const sink = createGenericSink({ onFinding: (f) => seen.push(f) });
  for (const key of ['onLeak', 'onWarning', 'onFinding', 'onError']) {
    assert.equal(typeof sink[key], 'function', key + ' must exist on a sink');
  }
  assert.doesNotThrow(() => createLeakTracker({
    onLeak: sink.onLeak, onWarning: sink.onWarning,
    onFinding: sink.onFinding, onError: sink.onError,
  }));
});

test('recipe 18: the documented custom-kernel shape registers and reports', () => {
  const tracker = createLeakTracker();
  let leased = 1;
  const kernel = {
    name: 'db-pool-orphan',
    patchSurfaces: [],
    priority: 0,
    install(ctx) { this._ctx = ctx; },
    uninstall() { this._ctx = null; },
    audit() {
      return leased > 0 ? [{ kind: 'db-pool-orphan', reason: 'lease-not-returned' }] : [];
    },
    advise(f) {
      return f.reason === 'lease-not-returned'
        ? 'Return the lease in the same scope that took it.' : null;
    },
  };
  tracker.registerKernel(kernel);
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.match(tracker.remediate(findings[0]), /Return the lease/);

  leased = 0;
  assert.deepEqual(tracker.audit(), []);
});

test('recipe 18: a pure classifier with no install() is legal', () => {
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => tracker.registerKernel({
    name: 'classifier-only', priority: 0, refine() { return null; },
  }));
});

test('recipe 19: every documented rejection actually throws', () => {
  const tracker = createLeakTracker();
  assert.throws(() => createLeakTracker({ onLeek: function () {} }), /did you mean "onLeak"/);
  assert.throws(() => createLeakTracker({ onWarning: 42 }), /must be a function/);
  assert.throws(() => tracker.track({}, function () {}, 'tag', { audti: true }), /did you mean "audit"/);
  assert.throws(() => tracker.track(42, function () {}, 'tag'), /must be an object, function or symbol/);
});

test('recipe 19: untrack with a foreign handle is a no-op, never a decrement', () => {
  const tracker = createLeakTracker();
  tracker.track({}, function () {}, 'real');
  tracker.untrack({ not: 'a handle' });
  assert.equal(tracker.size(), 1, 'size() must not be talked down by a stray object');
});

test('reading a finding: kind, reason and origin are present as documented', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const { kernels } = createDefaultKernels({ target, captureStacks: true });
  for (const k of kernels) tracker.registerKernel(k);

  target.setTimeout(function () {}, 1000);
  const f = tracker.audit()[0];
  assert.equal(typeof f.kind, 'string');
  assert.equal(typeof f.reason, 'string');
  assert.ok('origin' in f, 'origin is documented as present (null unless captureStacks)');
  assert.notEqual(f.origin, null, 'captureStacks:true must populate origin');
  for (const k of kernels) tracker.unregisterKernel(k);
});
