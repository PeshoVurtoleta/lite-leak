/**
 * Adversarial suite for @zakkster/lite-leak.
 *
 * Companion to torture.test.js. Where that file pins the patch-lifecycle
 * defects found before 1.1.0, this one pins the *input* defects found by
 * attacking the engine's boundaries before 1.2.1, plus the invariants that held
 * up under attack and must not regress.
 *
 * The organising question is not "does the detector find the leak" but "what
 * does it do when it cannot". Every defect below shared one shape: the tracker
 * accepted something it did not understand and then reported clean. A leak
 * detector's green is only worth anything if it means "I looked and found
 * nothing", never "I did not look".
 *
 * Notes for anyone extending this file:
 *
 *  - STRESS TESTS MUST ASSERT ON REAPING, not just on absence of throw. The
 *    interesting failure for a diagnostic is unbounded internal growth -- a
 *    leak in the leak detector -- which only shows up as a count that never
 *    comes back down.
 *
 *  - Use local hosts, never globalThis. Kernels claim patch surfaces per target
 *    for the life of the process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker, MAX_OWNER_WALK } from '../Leak.js';
import { createTimerOrphanKernel } from '../kernels/TimerOrphan.js';
import { effect, dispose as disposeNode } from '@zakkster/lite-signal';

const withOwner = (fn) => { let r; const e = effect(() => { r = fn(); }); return { r, dispose: () => disposeNode(e) }; };

/** Minimal valid kernel; override any field. @private */
const mk = (over) => Object.assign({
  name: 'k' + Math.random().toString(36).slice(2),
  patchSurfaces: [], priority: 0, install() {}, uninstall() {},
}, over);

/** A timer host whose callbacks can be fired on demand. @private */
function makeTimerHost() {
  const queue = [];
  return {
    setTimeout(fn) { queue.push(fn); return queue.length; },
    clearTimeout() {},
    _fireAll() { const q = queue.splice(0, queue.length); for (const fn of q) fn(); },
    _queued() { return queue.length; },
  };
}

// -----------------------------------------------------------------
// Fail-closed on configuration it does not understand
// -----------------------------------------------------------------

test('an unknown tracker option is rejected and names the key you meant', () => {
  // Was accepted in silence: every leak was observed, classified, and reported
  // to nobody, while the build stayed green.
  assert.throws(() => createLeakTracker({ onLeek: () => {} }),
    /unknown option "onLeek".*did you mean "onLeak"/);
  assert.throws(() => createLeakTracker({ captureStack: true }),
    /unknown option "captureStack".*did you mean "captureStacks"/);
  assert.throws(() => createLeakTracker({ onFindings: () => {} }),
    /did you mean "onFinding"/);
});

test('an unknown option with no near match still lists the known keys', () => {
  assert.throws(() => createLeakTracker({ wildlyUnrelatedKey: 1 }),
    /unknown option "wildlyUnrelatedKey".*Known options: name, captureStacks/s);
});

test('every valid tracker option is still accepted', () => {
  assert.doesNotThrow(() => createLeakTracker({
    name: 'ok', captureStacks: true,
    onLeak() {}, onError() {}, onFinding() {}, onWarning() {},
  }));
  assert.doesNotThrow(() => createLeakTracker());
  assert.doesNotThrow(() => createLeakTracker(undefined));
});

test('a non-callable handler is rejected at construction, not at report time', () => {
  // The dangerous version of this bug: the tracker worked perfectly until the
  // moment it had something to report, then destroyed the report and logged a
  // TypeError instead. Pass quietly, break only when you were right.
  for (const key of ['onLeak', 'onError', 'onFinding', 'onWarning']) {
    assert.throws(() => createLeakTracker({ [key]: 42 }),
      new RegExp('options\\.' + key + ' must be a function'),
      key + ' must be validated');
  }
  assert.throws(() => createLeakTracker({ onLeak: 'nope' }), /must be a function, got string/);
});

test('a non-object options argument is rejected', () => {
  assert.throws(() => createLeakTracker('name'), /options must be an object/);
  assert.throws(() => createLeakTracker(7), /options must be an object/);
});

// -----------------------------------------------------------------
// Fail-closed on track() input
// -----------------------------------------------------------------

test('an unknown track option is rejected and names the key you meant', () => {
  // `{ audti: true }` silently produced a record nobody audited, so audit()
  // reported clean on a resource that was never being watched.
  const tracker = createLeakTracker();
  assert.throws(() => tracker.track({}, () => {}, 'tag', { audti: true }),
    /unknown option "audti".*did you mean "audit"/);
  assert.throws(() => tracker.track({}, () => {}, 'tag', { Audit: true }),
    /unknown option "Audit"/);
});

test('the valid track option is still accepted, and still audits', () => {
  const tracker = createLeakTracker();
  let seen = 0;
  tracker.registerKernel(mk({
    install(ctx) { this._ctx = ctx; },
    audit() { this._ctx.forEachAuditedHandle(() => { seen++; }); return []; },
  }));
  assert.doesNotThrow(() => tracker.track({}, () => {}, 't', { audit: true }));
  tracker.audit();
  assert.equal(seen, 1, 'the audited record actually reached the walk');
});

test('a primitive target is rejected by name, not by a raw V8 message', () => {
  const tracker = createLeakTracker();
  for (const [label, value] of [['number', 1], ['string', 'x'], ['boolean', true]]) {
    assert.throws(() => tracker.track(value, () => {}, 't'),
      /track: target must be an object, function or symbol/, label);
  }
  assert.throws(() => tracker.track(null, () => {}, 't'), /got null/);
  assert.throws(() => tracker.track(undefined, () => {}, 't'), /got undefined/);
});

test('objects, functions and symbols remain trackable', () => {
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => tracker.track({}, () => {}, 't'));
  assert.doesNotThrow(() => tracker.track(function () {}, () => {}, 't'));
  assert.doesNotThrow(() => tracker.track(Symbol('s'), () => {}, 't'));
  assert.equal(tracker.size(), 3);
});

// -----------------------------------------------------------------
// Fail-closed on the kernel contract
// -----------------------------------------------------------------

test('a misspelled kernel hook is rejected, not read as "not implemented"', () => {
  // The worst failure this package can have: a kernel that registers happily
  // and detects nothing, so the detector reports clean because it never ran.
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel({
    name: 'typo', patchSurfaces: [], priority: 0, install() {}, uninstall() {},
    audti() { return []; },
  }), /has key "audti" -- did you mean "audit"/);

  assert.throws(() => tracker.registerKernel({
    name: 'typo2', patchSurfaces: [], priority: 0, instal() {}, uninstall() {},
  }), /did you mean "install"/);

  assert.throws(() => tracker.registerKernel({
    name: 'typo3', patchSurfaces: [], priority: 0, install() {}, unistall() {},
  }), /did you mean "uninstall"/);
});

test('underscore-prefixed and unrelated kernel keys are left alone', () => {
  // Kernels legitimately carry private probes (_liveCount) and their own state.
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => tracker.registerKernel(mk({
    name: 'private-ok', _liveCount() { return 0; }, _pendingCount() { return 0; },
  })));
  assert.doesNotThrow(() => tracker.registerKernel(mk({
    name: 'state-ok', frameBudget: 16, ctx: null, buffer: [],
  })));
});

test('a pure classifier kernel with no install() is still legal', () => {
  // Not every kernel patches something; requiring install would reject a
  // legitimate refine-only kernel.
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => tracker.registerKernel({
    name: 'classifier', priority: 0, refine() { return null; },
  }));
});

test('a kernel that declares patch surfaces but cannot install them is rejected', () => {
  // It would claim the surfaces and patch nothing -- worse than not
  // registering, because the claim blocks a kernel that would have worked.
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel({ name: 'claims', patchSurfaces: ['setTimeout'] }),
    /declares patchSurfaces but has no install\(\)/);
});

test('a non-function hook is rejected when present', () => {
  const tracker = createLeakTracker();
  for (const hook of ['install', 'uninstall', 'refine', 'audit', 'advise']) {
    assert.throws(() => tracker.registerKernel(mk({ name: 'h-' + hook, [hook]: 'nope' })),
      new RegExp('kernel\\.' + hook + ' must be a function'), hook);
  }
});

test('a non-finite priority is rejected instead of silently unsorting the chain', () => {
  // NaN compares false against every value, so a NaN priority did not sort
  // low -- it sorted nowhere, and the refine chain is first-non-null-wins.
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel(mk({ priority: NaN }), 'NaN'),
    /priority must be a finite number.*NaN/s);
  assert.throws(() => tracker.registerKernel(mk({ priority: Infinity })),
    /priority must be a finite number/);
  assert.throws(() => tracker.registerKernel(mk({ priority: '5' })),
    /priority must be a finite number.*string/s);
  assert.doesNotThrow(() => tracker.registerKernel(mk({ priority: -3 })));
  assert.doesNotThrow(() => tracker.registerKernel(mk({ priority: undefined })));
});

test('a non-array patchSurfaces is rejected instead of claiming nothing', () => {
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel(mk({ patchSurfaces: 'setTimeout' })),
    /patchSurfaces must be an array/);
});

test('priority order is respected once non-finite values cannot get in', () => {
  const order = [];
  const tracker = createLeakTracker();
  tracker.registerKernel(mk({ name: 'lo', priority: 1, audit() { order.push('lo'); return []; } }));
  tracker.registerKernel(mk({ name: 'hi', priority: 10, audit() { order.push('hi'); return []; } }));
  tracker.registerKernel(mk({ name: 'mid', priority: 5, audit() { order.push('mid'); return []; } }));
  tracker.audit();
  assert.deepEqual(order, ['hi', 'mid', 'lo']);
});

// -----------------------------------------------------------------
// Held up under attack: no unbounded growth (a leak in the leak detector)
// -----------------------------------------------------------------

test('the timer registry reaps fired timers instead of growing forever', () => {
  const host = makeTimerHost();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  for (let i = 0; i < 5000; i++) host.setTimeout(() => {}, 0);
  assert.equal(kernel._pendingCount(), 5000, 'all armed timers are tracked');

  host._fireAll();
  assert.equal(kernel._pendingCount(), 0,
    'a fired timer must leave the registry -- otherwise a hot setTimeout loop ' +
    'grows the detector without bound');
  tracker.unregisterKernel(kernel);
});

test('the audited-record set reaps on untrack across a large batch', () => {
  const tracker = createLeakTracker();
  const handles = [];
  for (let i = 0; i < 5000; i++) handles.push(tracker.track({}, () => {}, 'x', { audit: true }));
  assert.equal(tracker.size(), 5000);
  for (const h of handles) tracker.untrack(h);
  assert.equal(tracker.size(), 0, 'the detector must not retain what it stopped watching');
});

test('owner disposal releases a large tracked batch', () => {
  const tracker = createLeakTracker();
  const held = [];
  const o = withOwner(() => {
    for (let i = 0; i < 2000; i++) { const t = { i }; held.push(t); tracker.track(t, () => {}, 'batch'); }
  });
  assert.equal(tracker.size(), 2000);
  o.dispose();
  assert.equal(tracker.size(), 0);
});

test('repeated install/uninstall cycles do not accumulate claims', () => {
  const host = makeTimerHost();
  for (let i = 0; i < 200; i++) {
    const tracker = createLeakTracker();
    const kernel = createTimerOrphanKernel({ target: host, warnOnNoOwner: false });
    tracker.registerKernel(kernel);
    tracker.unregisterKernel(kernel);
  }
  // If claims leaked, the 201st install would report a contested surface.
  const findings = [];
  const tracker = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const kernel = createTimerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0);
  tracker.unregisterKernel(kernel);
});

// -----------------------------------------------------------------
// Held up under attack: error isolation and reentrancy
// -----------------------------------------------------------------

test('a throwing audit() is isolated and the other kernels still report', () => {
  const errors = [];
  const tracker = createLeakTracker({ onError: (e) => errors.push(e) });
  tracker.registerKernel(mk({ name: 'boom', priority: 10, audit() { throw new Error('audit boom'); } }));
  tracker.registerKernel(mk({ name: 'good', priority: 1, audit() { return [{ kind: 'good', reason: 'r' }]; } }));
  const findings = tracker.audit();
  assert.equal(findings.length, 1, 'a thrown audit must not suppress later kernels');
  assert.equal(findings[0].kind, 'good');
  assert.equal(errors.length, 1);
});

test('a kernel returning a non-array from audit() cannot corrupt the result', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(mk({ name: 'str', audit() { return 'not-an-array'; } }));
  tracker.registerKernel(mk({ name: 'nul', audit() { return null; } }));
  assert.deepEqual(tracker.audit(), []);
});

test('a throwing advise() does not break remediate()', () => {
  const tracker = createLeakTracker({ onError() {} });
  tracker.registerKernel(mk({ advise() { throw new Error('advise boom'); } }));
  const advice = tracker.remediate({ kind: 'x', reason: 'y' });
  assert.equal(typeof advice, 'string');
  assert.match(advice, /No kernel-provided remediation/);
});

test('a throwing uninstall() does not wedge the tracker', () => {
  const tracker = createLeakTracker({ onError() {} });
  const kernel = mk({ name: 'bad-uninstall', uninstall() { throw new Error('uninstall boom'); } });
  tracker.registerKernel(kernel);
  assert.doesNotThrow(() => tracker.unregisterKernel(kernel));
  // The name must be reusable afterwards.
  assert.doesNotThrow(() => tracker.registerKernel(mk({ name: 'bad-uninstall' })));
});

test('a failed install rolls back its claims so a retry can succeed', () => {
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel({
    name: 'c', patchSurfaces: ['surface-x'], install() { throw new Error('install failed'); },
    uninstall() {},
  }), /install failed/);
  assert.doesNotThrow(() => tracker.registerKernel({
    name: 'c', patchSurfaces: ['surface-x'], install() {}, uninstall() {},
  }), 'the failed attempt must not have kept the name or the surface');
});

test('unregistering a kernel from inside its own audit does not corrupt the walk', () => {
  const tracker = createLeakTracker();
  let k;
  k = mk({ name: 'self-remove', audit() { tracker.unregisterKernel(k); return []; } });
  tracker.registerKernel(k);
  assert.doesNotThrow(() => tracker.audit());
  assert.doesNotThrow(() => tracker.audit());
});

test('a foreign handle cannot deflate the live count (size() is a leak oracle)', () => {
  // The worst defect found in this pass. untrack() passed any object straight
  // to the peer registry, which decremented regardless of whether it had ever
  // issued that handle. Three foreign untracks against three live handles drove
  // size() to 0, so a gate asserting "size() === 0 means nothing pending" read
  // clean while every one of them was still tracked.
  const tracker = createLeakTracker();
  const live = [{}, {}, {}];
  for (const o of live) tracker.track(o, () => {}, 'real');
  assert.equal(tracker.size(), 3);

  for (let i = 0; i < 3; i++) tracker.untrack({ bogus: i });
  assert.equal(tracker.size(), 3, 'a foreign object must never decrement the count');

  tracker.untrack(null);
  tracker.untrack(undefined);
  tracker.untrack('not-a-handle');
  tracker.untrack(42);
  assert.equal(tracker.size(), 3, 'nor may a primitive');
});

test('the live count never goes negative under repeated abuse', () => {
  const tracker = createLeakTracker();
  for (let i = 0; i < 500; i++) tracker.untrack({ i });
  assert.equal(tracker.size(), 0);
  assert.ok(tracker.size() >= 0, 'size() must never report a negative count');
});

test('untrack is inert for null, foreign and repeated handles', () => {
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => tracker.untrack(null));
  assert.doesNotThrow(() => tracker.untrack(undefined));
  assert.doesNotThrow(() => tracker.untrack({ not: 'a handle' }));
  const h = tracker.track({}, () => {}, 't');
  tracker.untrack(h);
  tracker.untrack(h);
  assert.equal(tracker.size(), 0);
});

test('the owner walk is bounded by MAX_OWNER_WALK', () => {
  assert.equal(typeof MAX_OWNER_WALK, 'number');
  assert.ok(Number.isFinite(MAX_OWNER_WALK) && MAX_OWNER_WALK > 0,
    'an unbounded owner walk would hang on a cyclic owner chain');
});

test('a deep owner nest still tracks and releases cleanly', () => {
  const tracker = createLeakTracker();
  const held = {};
  let depth = 0;
  const nest = (n) => {
    if (n === 0) { tracker.track(held, () => {}, 'deep'); depth++; return; }
    effect(() => { nest(n - 1); });
  };
  const outer = effect(() => { nest(24); });
  assert.equal(depth, 1);
  assert.equal(tracker.size(), 1);
  disposeNode(outer);
  assert.equal(tracker.size(), 0, 'a deep cascade must still release');
});
