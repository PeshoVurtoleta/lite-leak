import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createAsyncRetentionKernel,
  KernelConflictError,
} from '../Leak.js';

function makeTarget() {
  return { AbortController: globalThis.AbortController };
}

// --- Install / uninstall ---

test('install replaces target.AbortController; uninstall restores', () => {
  const target = makeTarget();
  const orig = target.AbortController;
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);
  assert.notEqual(target.AbortController, orig);
  tracker.unregisterKernel(kernel);
  assert.equal(target.AbortController, orig);
});

test('duplicate registration throws KernelConflictError', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const a = createAsyncRetentionKernel({ target });
  const b = createAsyncRetentionKernel({ target });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Owner-scoped auto-abort ---

test('AbortController inside effect auto-aborts on dispose', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  let ctrl;
  const e = effect(() => {
    ctrl = new target.AbortController();
  });
  assert.equal(ctrl.signal.aborted, false);
  assert.equal(kernel._pendingCount(), 1);

  dispose(e);
  assert.equal(ctrl.signal.aborted, true, 'signal aborted on owner dispose');
  assert.equal(kernel._pendingCount(), 0);
});

test('manual abort() removes registry entry', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  const e = effect(() => {
    const ctrl = new target.AbortController();
    ctrl.abort();
  });
  assert.equal(kernel._pendingCount(), 0);
  dispose(e);
});

test('effect re-run cascades abort via onCleanup', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  const controllers = [];
  const e = effect(() => {
    controllers.push(new target.AbortController());
  });
  assert.equal(kernel._pendingCount(), 1);
  assert.equal(controllers[0].signal.aborted, false);

  dispose(e);
  assert.equal(controllers[0].signal.aborted, true);
});

// --- No-owner warning ---

test('AbortController outside owner emits warning', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createAsyncRetentionKernel({ target }));

  new target.AbortController();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'async-retention');
  assert.equal(warnings[0].reason, 'no-owner-set');
});

test('warnOnNoOwner: false suppresses warning', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createAsyncRetentionKernel({ target, warnOnNoOwner: false }));

  new target.AbortController();
  assert.equal(warnings.length, 0);
});

test('createRoot: warning still fires (no owner in root scope)', () => {
  const target = makeTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createAsyncRetentionKernel({ target }));

  createRoot(() => {
    new target.AbortController();
  });
  assert.equal(warnings.length, 1);
});

// --- Audit ---

test('audit returns no-owner-pending for module-scope controller', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createAsyncRetentionKernel({ target, warnOnNoOwner: false }));

  new target.AbortController();
  new target.AbortController();
  const findings = tracker.audit();
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.kind, 'async-retention');
    assert.equal(f.reason, 'no-owner-pending');
  }
});

test('audit empty for healthy owner-scoped controller', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createAsyncRetentionKernel({ target }));

  const e = effect(() => {
    new target.AbortController();
  });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
});

// --- Refine ---

test('refine returns null for non-controller records', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  const report = { tag: 'x', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  assert.equal(kernel.refine(report, { tag: 'x' }), null);
});

test('refine classifies controller-tagged records', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  const report = { tag: 'x', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const record = { tag: { kind: 'abort-controller' }, ownerPath: null, origin: null };
  const refined = kernel.refine(report, record);
  assert.notEqual(refined, null);
  assert.equal(refined.kind, 'async-retention');
});

// --- Advise / remediate ---

test('advise() returns advisory text for each reason', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  const a = kernel.advise({ kind: 'async-retention', reason: 'no-owner-set' });
  const b = kernel.advise({ kind: 'async-retention', reason: 'no-owner-pending' });
  const c = kernel.advise({ kind: 'async-retention', reason: 'owner-disposed-controller-pending' });
  assert.equal(typeof a, 'string');
  assert.equal(typeof b, 'string');
  assert.equal(typeof c, 'string');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.match(a, /AbortController/);
});

test('advise() returns null for wrong kind', () => {
  const target = makeTarget();
  const tracker = createLeakTracker();
  const kernel = createAsyncRetentionKernel({ target });
  tracker.registerKernel(kernel);

  assert.equal(kernel.advise({ kind: 'timer-orphan', reason: 'no-owner-set' }), null);
});
