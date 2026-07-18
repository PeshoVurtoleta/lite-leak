import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot, signal, getOwner } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createRafOrphanKernel,
  createTimerOrphanKernel,
  KernelConflictError,
} from '../Leak.js';
import { createMockRaf } from './_helpers/raf.js';

function makeTarget(raf) {
  const r = raf || createMockRaf();
  const target = Object.create(null);
  target.requestAnimationFrame = r.requestAnimationFrame.bind(r);
  target.cancelAnimationFrame = r.cancelAnimationFrame.bind(r);
  return { target, raf: r };
}

// --- Install / uninstall ---

test('install patches rAF/cancelRAF; uninstall restores them', () => {
  const { target } = makeTarget();
  const orig = target.requestAnimationFrame;
  const origCancel = target.cancelAnimationFrame;

  const tracker = createLeakTracker();
  const kernel = createRafOrphanKernel({ target });
  tracker.registerKernel(kernel);
  assert.notEqual(target.requestAnimationFrame, orig, 'rAF patched');

  tracker.unregisterKernel(kernel);
  assert.equal(target.requestAnimationFrame, orig, 'rAF restored');
  assert.equal(target.cancelAnimationFrame, origCancel, 'cancelRAF restored');
});

test('two raf-orphan kernels collide on patch surfaces', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const a = createRafOrphanKernel({ target });
  const b = createRafOrphanKernel({ target });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Coexistence with timer-orphan ---

test('raf-orphan collides with default timer-orphan on the rAF surface', () => {
  const { target } = makeTarget();
  target.setTimeout = () => 1;
  target.clearTimeout = () => {};
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target })); // handleRaf: true
  assert.throws(
    () => tracker.registerKernel(createRafOrphanKernel({ target })),
    KernelConflictError
  );
});

test('timer-orphan { handleRaf:false } cedes rAF; both kernels coexist', () => {
  const { target } = makeTarget();
  target.setTimeout = () => 1;
  target.clearTimeout = () => {};
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => {
    tracker.registerKernel(createTimerOrphanKernel({ target, handleRaf: false }));
    tracker.registerKernel(createRafOrphanKernel({ target }));
  });
  // timer-orphan left the rAF surface alone -> raf-orphan owns it.
  const { raf } = makeTarget();
  target.requestAnimationFrame = raf.requestAnimationFrame.bind(raf);
});

// --- One-shot rAF (subsumes timer-orphan's rAF behaviour) ---

test('owner-scoped one-shot rAF cancels on dispose', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target }));

  let fired = 0;
  const e = effect(() => { target.requestAnimationFrame(() => { fired++; }); });
  assert.equal(raf.armedCount, 1);

  dispose(e);
  assert.equal(raf.armedCount, 0, 'cancelled on dispose');
  raf.tick(16);
  assert.equal(fired, 0);
});

test('manual cancelAnimationFrame inside effect removes the armed frame', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createRafOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const e = effect(() => {
    const id = target.requestAnimationFrame(() => {});
    target.cancelAnimationFrame(id);
  });
  assert.equal(kernel._armedCount(), 0);
  assert.equal(raf.armedCount, 0);
  dispose(e);
});

// --- The marquee: self-rescheduling loop, owner inheritance ---

test('owner-scoped LOOP auto-cancels the live frame on dispose (timer-orphan cannot)', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target }));

  let frames = 0;
  function loop() { frames++; target.requestAnimationFrame(loop); }
  const e = effect(() => { target.requestAnimationFrame(loop); });

  raf.tick(16); // frame 1 fires, reschedules frame 2 (inherits owner)
  raf.tick(16); // frame 2 fires, reschedules frame 3
  assert.equal(frames, 2);
  assert.equal(raf.armedCount, 1, 'exactly one frame armed');

  dispose(e);
  assert.equal(raf.armedCount, 0, 'the CURRENTLY armed frame was cancelled');
  raf.tick(16);
  assert.equal(frames, 2, 'loop is dead');
});

test('a rescheduling loop inherits the owner: no per-frame warnings', () => {
  const { target, raf } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target }));

  function loop() { target.requestAnimationFrame(loop); }
  const e = effect(() => { target.requestAnimationFrame(loop); });

  raf.tick(16);
  raf.tick(16);
  raf.tick(16);
  assert.equal(warnings.length, 0, 'owned loop never warns, on any frame');
  dispose(e);
});

test('no-owner loop emits exactly ONE no-owner-set warning, not one per frame', () => {
  const { target, raf } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target }));

  function loop() { target.requestAnimationFrame(loop); }
  target.requestAnimationFrame(loop); // module scope: no owner

  raf.tick(16);
  raf.tick(16);
  raf.tick(16);
  assert.equal(warnings.length, 1, 'single warning for the whole loop');
  assert.equal(warnings[0].kind, 'raf-orphan');
  assert.equal(warnings[0].reason, 'no-owner-set');
});

test('warnOnNoOwner:false suppresses the no-owner-set warning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target, warnOnNoOwner: false }));

  target.requestAnimationFrame(() => {});
  assert.equal(warnings.length, 0);
});

test('createRoot detaches ownership: loop warns no-owner-set', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target }));

  createRoot(() => { target.requestAnimationFrame(() => {}); });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].reason, 'no-owner-set');
});

// --- reschedule-after-dispose: the defense-in-depth signal ---

test('loop that disposes its own owner mid-frame then reschedules is caught', () => {
  const { target, raf } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target }));

  let e = null;
  let frames = 0;
  function loop() {
    frames++;
    if (frames === 2) dispose(e); // owner dies mid-callback...
    target.requestAnimationFrame(loop); // ...then the loop reschedules anyway
  }
  e = effect(() => { target.requestAnimationFrame(loop); });

  raf.tick(16); // frame 1: healthy continuation
  assert.equal(warnings.length, 0);
  raf.tick(16); // frame 2: dispose + reschedule-after-dispose

  const rd = warnings.filter((w) => w.reason === 'reschedule-after-dispose');
  assert.equal(rd.length, 1, 'exactly one reschedule-after-dispose warning');
  assert.equal(rd[0].kind, 'raf-orphan');

  // The loop is now armed with a disposed origin owner -> audit surfaces it.
  const findings = tracker.audit();
  const armed = findings.filter((f) => f.reason === 'owner-disposed-loop-armed');
  assert.equal(armed.length, 1);
});

test('reschedule-after-dispose warns ONCE, not once per frame (latched)', () => {
  const { target, raf } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target }));

  let e = null;
  let frames = 0;
  function loop() {
    frames++;
    if (frames === 1) dispose(e);
    target.requestAnimationFrame(loop);
  }
  e = effect(() => { target.requestAnimationFrame(loop); });

  for (let i = 0; i < 6; i++) raf.tick(16); // keep rescheduling past dispose
  const rd = warnings.filter((w) => w.reason === 'reschedule-after-dispose');
  assert.equal(rd.length, 1, 'exactly one warning despite many post-dispose frames');
});

test('warnOnRescheduleAfterDispose:false suppresses that warning', () => {
  const { target, raf } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({
    target,
    warnOnRescheduleAfterDispose: false,
  }));

  let e = null;
  let frames = 0;
  function loop() {
    frames++;
    if (frames === 1) dispose(e);
    target.requestAnimationFrame(loop);
  }
  e = effect(() => { target.requestAnimationFrame(loop); });
  raf.tick(16);
  assert.equal(warnings.filter((w) => w.reason === 'reschedule-after-dispose').length, 0);
});

// --- Audit ---

test('audit returns no-owner-loop-armed for a module-scope armed loop', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target, warnOnNoOwner: false }));

  target.requestAnimationFrame(() => {});
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'raf-orphan');
  assert.equal(findings[0].reason, 'no-owner-loop-armed');
});

test('audit returns nothing for a healthy owner-scoped loop', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target }));

  function loop() { target.requestAnimationFrame(loop); }
  const e = effect(() => { target.requestAnimationFrame(loop); });
  raf.tick(16);
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
});

test('audit onFinding channel emits findings', () => {
  const { target } = makeTarget();
  const seen = [];
  const tracker = createLeakTracker({ onFinding: (f) => seen.push(f) });
  tracker.registerKernel(createRafOrphanKernel({ target, warnOnNoOwner: false }));

  target.requestAnimationFrame(() => {});
  tracker.audit();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'raf-orphan');
});

// --- FR refine path ---

test('refine returns null for non-raf tagged records', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createRafOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const fakeReport = { tag: 'plain', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const fakeRecord = { tag: 'plain', ownerPath: null, origin: null };
  assert.equal(kernel.refine(fakeReport, fakeRecord), null);
});

test('refine classifies a raf-tagged record; wasCleared reflects armed state', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createRafOrphanKernel({ target });
  tracker.registerKernel(kernel);

  // Fresh kernel: the first top-level schedule is chainId 1 and stays armed.
  const e = effect(() => { target.requestAnimationFrame(() => {}); });
  const tag = { kind: 'raf-orphan', chainId: 1 };
  const report = { tag, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const refined = kernel.refine(report, { tag });
  assert.equal(refined.kind, 'raf-orphan');
  assert.equal(refined.chainId, 1);
  assert.equal(refined.wasCleared, false, 'still armed -> not cleared');

  dispose(e);
  raf.tick(16);
  // Unknown chain -> treated as cleared.
  const gone = kernel.refine(
    { tag: { kind: 'raf-orphan', chainId: 9999 }, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 },
    { tag: { kind: 'raf-orphan', chainId: 9999 } }
  );
  assert.equal(gone.wasCleared, true);
});

// --- captureStacks ---

test('captureStacks:true attaches origin to the no-owner warning', () => {
  const { target } = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createRafOrphanKernel({ target, captureStacks: true }));

  function distinctiveLoopSite() { target.requestAnimationFrame(() => {}); }
  distinctiveLoopSite();
  assert.equal(warnings.length, 1);
  assert.equal(typeof warnings[0].origin, 'string');
  assert.match(warnings[0].origin, /distinctiveLoopSite/);
});

// --- advise ---

test('advise returns per-reason guidance; remediate resolves it', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target }));

  for (const reason of [
    'no-owner-set',
    'reschedule-after-dispose',
    'no-owner-loop-armed',
    'owner-disposed-loop-armed',
  ]) {
    const advice = tracker.remediate({ kind: 'raf-orphan', reason });
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0, 'advice for ' + reason);
  }
  const generic = tracker.remediate({ kind: 'raf-orphan', reason: 'bogus' });
  assert.match(generic, /No kernel-provided remediation/);
});

// --- Priority ---

test('kernel accepts priority option', () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const order = [];
  const generic = { name: 'generic', priority: 0, audit() { order.push('generic'); return []; } };
  const raf = createRafOrphanKernel({ target, priority: 10 });
  const origAudit = raf.audit.bind(raf);
  raf.audit = function () { order.push('raf'); return origAudit(); };

  tracker.registerKernel(generic);
  tracker.registerKernel(raf);
  tracker.audit();
  assert.deepEqual(order, ['raf', 'generic']);
});

// --- Uninstall mid-flight ---

test('uninstall clears registry; an already-armed wrapper still runs its cb', () => {
  const { target, raf } = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createRafOrphanKernel({ target });
  tracker.registerKernel(kernel);

  let fired = 0;
  const e = effect(() => { target.requestAnimationFrame(() => { fired++; }); });
  assert.equal(kernel._armedCount(), 1);

  tracker.unregisterKernel(kernel);
  assert.equal(kernel._armedCount(), 0);
  // The underlying rAF is still queued; uninstall does not cancel user frames.
  assert.equal(raf.armedCount, 1);
  raf.tick(16);
  assert.equal(fired, 1, 'cb still ran after uninstall');
  dispose(e);
});

// --- Owner-cascade composability ---

test('raf-orphan coexists with owner-cascade-orphan', async () => {
  const { target } = makeTarget();
  const tracker = createLeakTracker();
  const { createOwnerCascadeOrphanKernel } = await import('../Leak.js');
  tracker.registerKernel(createOwnerCascadeOrphanKernel());
  tracker.registerKernel(createRafOrphanKernel({ target, warnOnNoOwner: false }));

  function loop() { target.requestAnimationFrame(loop); }
  const e = effect(() => { target.requestAnimationFrame(loop); });
  assert.deepEqual(tracker.audit(), []);

  target.requestAnimationFrame(() => {}); // module-scope armed loop
  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.kind === 'raf-orphan').length, 1);
  dispose(e);
});
