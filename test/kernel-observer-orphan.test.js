import './_helpers/dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createObserverOrphanKernel,
  KernelConflictError,
} from '../Leak.js';

function makeTarget() {
  return {
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
}

// --- Install / uninstall ---

test('install replaces observer constructors; uninstall restores', () => {
  const target = makeTarget();
  const orig = target.MutationObserver;
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);
  assert.notEqual(target.MutationObserver, orig);

  tracker.unregisterKernel(kernel);
  assert.equal(target.MutationObserver, orig);
});

test('patches only present constructors', () => {
  const target = { MutationObserver: globalThis.MutationObserver };
  const tracker = createLeakTracker();
  tracker.registerKernel(createObserverOrphanKernel({ target }));
  assert.equal(target.ResizeObserver, undefined);
  assert.equal(target.IntersectionObserver, undefined);
});

test('duplicate registration throws KernelConflictError', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const a = createObserverOrphanKernel({ target });
  const b = createObserverOrphanKernel({ target });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Owner-scoped auto-disconnect ---

test('MutationObserver inside effect auto-disconnects on dispose', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  document.body.appendChild(el);
  let mo;
  const e = effect(() => {
    mo = new target.MutationObserver(() => {});
    mo.observe(el, { childList: true });
  });
  assert.equal(kernel._pendingCount(), 1);

  dispose(e);
  assert.equal(kernel._pendingCount(), 0, 'disconnect fired on cleanup');
});

test('ResizeObserver inside effect auto-disconnects', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  const e = effect(() => {
    const ro = new target.ResizeObserver(() => {});
    ro.observe(el);
  });
  assert.equal(kernel._pendingCount(), 1);
  dispose(e);
  assert.equal(kernel._pendingCount(), 0);
});

test('IntersectionObserver inside effect auto-disconnects', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  const e = effect(() => {
    const io = new target.IntersectionObserver(() => {});
    io.observe(el);
  });
  assert.equal(kernel._pendingCount(), 1);
  dispose(e);
  assert.equal(kernel._pendingCount(), 0);
});

test('manual disconnect() removes registry entry', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const e = effect(() => {
    const mo = new target.MutationObserver(() => {});
    mo.disconnect();
  });
  assert.equal(kernel._pendingCount(), 0);
  dispose(e);
});

// --- No-owner warning ---

test('constructor outside owner emits warning', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createObserverOrphanKernel({ target }));

  new target.MutationObserver(() => {});
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'observer-orphan');
  assert.equal(warnings[0].observerKind, 'MutationObserver');
});

test('warnOnNoOwner: false suppresses warning', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createObserverOrphanKernel({ target, warnOnNoOwner: false }));

  new target.MutationObserver(() => {});
  assert.equal(warnings.length, 0);
});

test('createRoot: warning still fires', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createObserverOrphanKernel({ target }));

  createRoot(() => {
    new target.MutationObserver(() => {});
  });
  assert.equal(warnings.length, 1);
});

// --- Audit ---

test('audit returns no-owner-pending for module-scope observer', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createObserverOrphanKernel({ target, warnOnNoOwner: false }));

  new target.MutationObserver(() => {});
  new target.ResizeObserver(() => {});
  const findings = tracker.audit();
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.kind, 'observer-orphan');
    assert.equal(f.reason, 'no-owner-pending');
  }
});

test('audit empty for healthy owner-scoped observer', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createObserverOrphanKernel({ target }));

  const e = effect(() => {
    new target.MutationObserver(() => {});
  });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
});

// --- Refine ---

test('refine classifies observer-tagged records', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createObserverOrphanKernel({ target });
  tracker.registerKernel(kernel);

  const report = { tag: 'x', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const record = { tag: { kind: 'observer', observerKind: 'MutationObserver' }, ownerPath: null, origin: null };
  const refined = kernel.refine(report, record);
  assert.equal(refined.kind, 'observer-orphan');
  assert.equal(refined.observerKind, 'MutationObserver');
});
