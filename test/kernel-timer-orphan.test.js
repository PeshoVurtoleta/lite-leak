import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot, signal } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createTimerOrphanKernel,
  KernelConflictError,
} from '../Leak.js';
import { createMockClock } from './_helpers/clock.js';
import { createMockRaf } from './_helpers/raf.js';

// Build a null-prototype target combining clock + rAF, so patching cannot
// collide with global inheritance during tests.
function makeTarget({ clock, raf } = {}) {
  const c = clock || createMockClock();
  const r = raf || createMockRaf();
  const target = Object.create(null);
  target.setTimeout = c.setTimeout.bind(c);
  target.clearTimeout = c.clearTimeout.bind(c);
  target.setInterval = c.setInterval.bind(c);
  target.clearInterval = c.clearInterval.bind(c);
  target.requestAnimationFrame = r.requestAnimationFrame.bind(r);
  target.cancelAnimationFrame = r.cancelAnimationFrame.bind(r);
  return { target, clock: c, raf: r };
}

// --- Install / uninstall ---

test('install replaces target methods; uninstall restores them', () => {
  const target = Object.create(null);
  target.setTimeout = function orig() { return 'ORIG'; };
  target.clearTimeout = function origClear() {};
  const orig = target.setTimeout;
  const origClear = target.clearTimeout;

  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);
  assert.notEqual(target.setTimeout, orig, 'setTimeout was patched');

  tracker.unregisterKernel(kernel);
  assert.equal(target.setTimeout, orig, 'setTimeout restored');
  assert.equal(target.clearTimeout, origClear, 'clearTimeout restored');
});

test('kernel patches only what target exposes', () => {
  const target = Object.create(null);
  target.setTimeout = () => 1;
  target.clearTimeout = () => {};
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);
  assert.equal(target.setInterval, undefined);
  assert.equal(target.requestAnimationFrame, undefined);
  tracker.unregisterKernel(kernel);
});

test('two timer-orphan kernels on the same tracker collide on patch surfaces', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const a = createTimerOrphanKernel({ target });
  const b = createTimerOrphanKernel({ target });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Owner-scoped auto-clear ---

test('setTimeout inside effect auto-clears on effect dispose', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  let fired = 0;
  const e = effect(() => {
    target.setTimeout(() => { fired++; }, 100);
  });
  assert.equal(clock.pendingCount, 1);

  dispose(e);
  assert.equal(clock.pendingCount, 0, 'clearTimeout was called on dispose');

  clock.advance(500);
  assert.equal(fired, 0, 'callback never fired');
});

test('setInterval inside effect auto-clears on effect dispose', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  let ticks = 0;
  const e = effect(() => {
    target.setInterval(() => { ticks++; }, 50);
  });
  clock.advance(200);
  assert.equal(ticks, 4);

  dispose(e);
  clock.advance(1000);
  assert.equal(ticks, 4, 'interval stopped');
});

test('rAF inside effect cancels on effect dispose', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  let fired = 0;
  const e = effect(() => {
    target.requestAnimationFrame(() => { fired++; });
  });
  assert.equal(raf.armedCount, 1);

  dispose(e);
  assert.equal(raf.armedCount, 0, 'cancelAnimationFrame was called');
  raf.tick(16);
  assert.equal(fired, 0);
});

test('setTimeout fires normally when it comes due before effect disposes', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  let fired = 0;
  const e = effect(() => {
    target.setTimeout(() => { fired++; }, 100);
  });

  clock.advance(200);
  assert.equal(fired, 1);
  assert.equal(kernel._pendingCount(), 0, 'registry drained after fire');
  dispose(e);
});

test('interval keeps firing until effect disposes', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  let ticks = 0;
  const e = effect(() => {
    target.setInterval(() => { ticks++; }, 25);
  });

  clock.advance(100);
  assert.equal(ticks, 4);
  clock.advance(100);
  assert.equal(ticks, 8);
  assert.equal(kernel._pendingCount(), 1);

  dispose(e);
  clock.advance(1000);
  assert.equal(ticks, 8);
});

test('manual clearTimeout inside effect removes registry entry', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const e = effect(() => {
    const id = target.setTimeout(() => {}, 100);
    target.clearTimeout(id);
  });

  assert.equal(kernel._pendingCount(), 0);
  assert.equal(clock.pendingCount, 0);
  dispose(e);
});

test('effect re-run cascade-clears prior iteration timer via onCleanup', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const s = signal(0);
  let firedFirst = 0;
  let firedSecond = 0;
  const e = effect(() => {
    const run = s();
    target.setTimeout(() => {
      if (run === 0) firedFirst++;
      else firedSecond++;
    }, 100);
  });

  assert.equal(kernel._pendingCount(), 1);
  s.set(1);
  assert.equal(kernel._pendingCount(), 1, 'previous cleared, new one live');

  clock.advance(200);
  assert.equal(firedFirst, 0, 'first-iteration timer cleared before fire');
  assert.equal(firedSecond, 1);

  dispose(e);
});

// --- No-owner warning ---

test('setTimeout outside owner emits onWarning at set-time', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  target.setTimeout(() => {}, 100);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'timer-orphan');
  assert.equal(warnings[0].reason, 'no-owner-set');
  assert.equal(warnings[0].timerKind, 'setTimeout');
});

test('setInterval outside owner emits onWarning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  target.setInterval(() => {}, 100);
  assert.equal(warnings[0].timerKind, 'setInterval');
});

test('rAF outside owner emits onWarning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  target.requestAnimationFrame(() => {});
  assert.equal(warnings[0].timerKind, 'requestAnimationFrame');
});

test('warnOnNoOwner: false suppresses the warning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({ target, warnOnNoOwner: false }));

  target.setTimeout(() => {}, 100);
  assert.equal(warnings.length, 0);
});

test('createRoot detaches ownership: warning still fires (no owner)', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  createRoot(() => {
    target.setTimeout(() => {}, 100);
  });
  assert.equal(warnings.length, 1);
});

test('captureStacks: true attaches origin to warning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createTimerOrphanKernel({
    target,
    captureStacks: true,
  }));

  function distinctiveCallSite() {
    target.setTimeout(() => {}, 100);
  }
  distinctiveCallSite();
  assert.equal(warnings.length, 1);
  assert.equal(typeof warnings[0].origin, 'string');
  assert.match(warnings[0].origin, /distinctiveCallSite/);
});

// --- Audit ---

test('audit returns no-owner-pending finding for module-scope timer', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target, warnOnNoOwner: false }));

  target.setTimeout(() => {}, 10000);
  target.setTimeout(() => {}, 20000);
  const findings = tracker.audit();
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.kind, 'timer-orphan');
    assert.equal(f.reason, 'no-owner-pending');
    assert.equal(f.timerKind, 'setTimeout');
  }
});

test('audit returns nothing for a healthy owner-scoped timer', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target }));

  const e = effect(() => {
    target.setTimeout(() => {}, 10000);
  });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
});

test('audit onFinding channel emits findings', () => {
  const { target } = makeTarget();
  const seen = [];
  const tracker = createLeakTracker({ onFinding: (f) => seen.push(f) });
  tracker.registerKernel(createTimerOrphanKernel({ target, warnOnNoOwner: false }));

  target.setTimeout(() => {}, 100);
  tracker.audit();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'timer-orphan');
});

// --- FR refine path ---

test('refine returns null for non-timer tagged records', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const fakeReport = {
    tag: 'plain-string',
    ownerPath: null,
    origin: null,
    kind: 'unknown',
    collectedAt: 0,
  };
  const fakeRecord = { tag: 'plain-string', ownerPath: null, origin: null };
  const result = kernel.refine(fakeReport, fakeRecord);
  assert.equal(result, null);
});

test('refine classifies via synthetic record with timer tag', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const id = target.setTimeout(() => {}, 100);
  const fakeReport = {
    tag: { kind: 'setTimeout', id },
    ownerPath: null,
    origin: null,
    kind: 'unknown',
    collectedAt: 0,
  };
  const fakeRecord = { tag: { kind: 'setTimeout', id }, ownerPath: null, origin: null };
  const refined = kernel.refine(fakeReport, fakeRecord);
  assert.notEqual(refined, null);
  assert.equal(refined.kind, 'timer-orphan');
  assert.equal(refined.timerKind, 'setTimeout');
  assert.equal(refined.timerId, id);
  assert.equal(refined.wasCleared, false, 'still in registry -> not cleared');
});

test('refine wasCleared=true after entry removed via clearTimeout', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const id = target.setTimeout(() => {}, 100);
  target.clearTimeout(id);

  const fakeReport = {
    tag: { kind: 'setTimeout', id },
    ownerPath: null,
    origin: null,
    kind: 'unknown',
    collectedAt: 0,
  };
  const fakeRecord = { tag: { kind: 'setTimeout', id }, ownerPath: null, origin: null };
  const refined = kernel.refine(fakeReport, fakeRecord);
  assert.equal(refined.wasCleared, true);
});

// --- Uninstall correctness with in-flight wrappers ---

test('uninstall clears registry; already-scheduled wrapper still runs cb, skips bookkeeping', () => {
  const { target, clock } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createTimerOrphanKernel({ target });
  tracker.registerKernel(kernel);

  let fired = 0;
  const e = effect(() => {
    target.setTimeout(() => { fired++; }, 100);
  });
  assert.equal(kernel._pendingCount(), 1);

  tracker.unregisterKernel(kernel);
  assert.equal(kernel._pendingCount(), 0);
  // Note: the clock STILL has the wrapper queued because uninstall only
  // clears our registry, not the underlying clock. This is intentional --
  // we don't cancel user-scheduled timers on uninstall.
  assert.equal(clock.pendingCount, 1);

  clock.advance(200);
  assert.equal(fired, 1);
  dispose(e);
});

// --- Priority ---

test('kernel accepts priority option', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const order = [];
  const generic = {
    name: 'generic',
    priority: 0,
    audit() { order.push('generic'); return []; },
  };
  const timer = createTimerOrphanKernel({ target, priority: 10 });
  const origAudit = timer.audit.bind(timer);
  timer.audit = function () {
    order.push('timer');
    return origAudit();
  };

  tracker.registerKernel(generic);
  tracker.registerKernel(timer);
  tracker.audit();
  assert.deepEqual(order, ['timer', 'generic']);
});

// --- Owner-cascade integration (composability with M1-a kernel) ---

test('timer-orphan kernel co-exists with owner-cascade-orphan kernel', async () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const { createOwnerCascadeOrphanKernel } = await import('../Leak.js');
  tracker.registerKernel(createOwnerCascadeOrphanKernel());
  tracker.registerKernel(createTimerOrphanKernel({ target, warnOnNoOwner: false }));

  const e = effect(() => {
    target.setTimeout(() => {}, 100);
  });
  assert.deepEqual(tracker.audit(), []);

  target.setTimeout(() => {}, 10000); // module-scope
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'timer-orphan');

  dispose(e);
});
