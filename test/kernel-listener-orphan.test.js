import './_helpers/dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createListenerOrphanKernel,
  KernelConflictError,
} from '../Leak.js';

// --- Install / uninstall ---

test('install replaces addEventListener; uninstall restores', () => {
  class MyET extends EventTarget {}
  const origAdd = MyET.prototype.addEventListener;
  const origRemove = MyET.prototype.removeEventListener;

  const tracker = createLeakTracker();
  const kernel = createListenerOrphanKernel({ EventTarget: MyET });
  tracker.registerKernel(kernel);
  assert.notEqual(MyET.prototype.addEventListener, origAdd);
  assert.notEqual(MyET.prototype.removeEventListener, origRemove);

  tracker.unregisterKernel(kernel);
  assert.equal(MyET.prototype.addEventListener, origAdd);
  assert.equal(MyET.prototype.removeEventListener, origRemove);
});

test('duplicate kernel throws KernelConflictError on patch surface', () => {
  const tracker = createLeakTracker();
  const a = createListenerOrphanKernel();
  const b = createListenerOrphanKernel();
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Owner-scoped auto-remove ---

test('addEventListener inside effect auto-removes on dispose', () => {
  const tracker = createLeakTracker();
  const kernel = createListenerOrphanKernel();
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  document.body.appendChild(el);

  let clicked = 0;
  const handler = () => { clicked++; };
  const e = effect(() => {
    el.addEventListener('click', handler);
  });
  el.click();
  assert.equal(clicked, 1);

  dispose(e);
  el.click();
  assert.equal(clicked, 1, 'listener was removed on effect dispose');

  tracker.unregisterKernel(kernel);
});

test('multiple listeners in one effect all auto-remove', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createListenerOrphanKernel());

  const el = document.createElement('div');
  document.body.appendChild(el);
  let a = 0, b = 0, c = 0;

  const e = effect(() => {
    el.addEventListener('click', () => a++);
    el.addEventListener('click', () => b++);
    el.addEventListener('mousedown', () => c++);
  });
  el.click();
  el.dispatchEvent(new Event('mousedown'));
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(c, 1);

  dispose(e);
  el.click();
  el.dispatchEvent(new Event('mousedown'));
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(c, 1);
});

test('addEventListener with options object still auto-removes', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createListenerOrphanKernel());

  const el = document.createElement('div');
  document.body.appendChild(el);
  let count = 0;
  const handler = () => count++;

  const e = effect(() => {
    el.addEventListener('click', handler, { capture: true });
  });
  el.click();
  dispose(e);
  el.click();
  assert.equal(count, 1, 'capture-phase listener also removed');
});

// --- No-owner warning ---

test('addEventListener outside owner emits warning', () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createListenerOrphanKernel());

  const el = document.createElement('div');
  el.addEventListener('click', () => {});
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'listener-orphan');
  assert.equal(warnings[0].reason, 'no-owner-set');
  assert.equal(warnings[0].type, 'click');
});

test('warnOnNoOwner: false suppresses warning', () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createListenerOrphanKernel({ warnOnNoOwner: false }));

  const el = document.createElement('div');
  el.addEventListener('click', () => {});
  assert.equal(warnings.length, 0);
});

test('createRoot detaches ownership -> warning fires', () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createListenerOrphanKernel());

  createRoot(() => {
    const el = document.createElement('div');
    el.addEventListener('click', () => {});
  });
  assert.equal(warnings.length, 1);
});

test('captureStacks: true attaches origin', () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  tracker.registerKernel(createListenerOrphanKernel({ captureStacks: true }));

  function distinctiveSite() {
    document.createElement('div').addEventListener('click', () => {});
  }
  distinctiveSite();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].origin, /distinctiveSite/);
});

// --- Refine ---

test('refine classifies listener-tagged records; null for others', () => {
  const tracker = createLeakTracker();
  const kernel = createListenerOrphanKernel();
  tracker.registerKernel(kernel);

  const report = { tag: 'x', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const nonListenerRecord = { tag: 'x', ownerPath: null, origin: null };
  assert.equal(kernel.refine(report, nonListenerRecord), null);

  const listenerRecord = { tag: { kind: 'listener', type: 'click' }, ownerPath: null, origin: null };
  const refined = kernel.refine(report, listenerRecord);
  assert.notEqual(refined, null);
  assert.equal(refined.kind, 'listener-orphan');
  assert.equal(refined.listenerType, 'click');
});

// --- audit is empty ---

test('audit returns empty (no enumeration registry for listeners)', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createListenerOrphanKernel());
  const el = document.createElement('div');
  el.addEventListener('click', () => {});
  assert.deepEqual(tracker.audit(), []);
});
