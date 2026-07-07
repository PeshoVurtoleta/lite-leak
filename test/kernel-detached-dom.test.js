import './_helpers/dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createDetachedDomKernel,
  KernelConflictError,
} from '../Leak.js';
import { flushObserver } from './_helpers/dom.js';

test('install / uninstall', () => {
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);
  assert.equal(kernel._watchedCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('duplicate registration on same tracker throws KernelConflictError', () => {
  const tracker = createLeakTracker();
  const a = createDetachedDomKernel({ root: document });
  const b = createDetachedDomKernel({ root: document });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

test('watch() before install throws', () => {
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document });
  const el = document.createElement('div');
  assert.throws(() => kernel.watch(el), /before install/);
});

test('watch() adds node to registry', () => {
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);

  const el = document.createElement('span');
  document.body.appendChild(el);
  kernel.watch(el, 'my-el');
  assert.equal(kernel._watchedCount(), 1);

  tracker.unregisterKernel(kernel);
});

test('detachment via removeChild fires onWarning', async () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  el.id = 'sample';
  document.body.appendChild(el);
  kernel.watch(el, 'sample-tag');
  assert.equal(kernel._watchedCount(), 1);

  el.parentNode.removeChild(el);
  await flushObserver();

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'detached-dom');
  assert.equal(warnings[0].reason, 'detached-without-untrack');
  assert.equal(warnings[0].tag, 'sample-tag');
  assert.equal(kernel._watchedCount(), 0, 'entry reaped');

  tracker.unregisterKernel(kernel);
});

test('detachment of a subtree containing a watched descendant fires warning', async () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);

  const parent = document.createElement('div');
  const child = document.createElement('span');
  parent.appendChild(child);
  document.body.appendChild(parent);

  kernel.watch(child, 'child-tag');
  parent.parentNode.removeChild(parent);
  await flushObserver();

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].tag, 'child-tag');

  tracker.unregisterKernel(kernel);
});

test('warnOnDetach: false suppresses live warning', async () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createDetachedDomKernel({ root: document, warnOnDetach: false });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  document.body.appendChild(el);
  kernel.watch(el);

  el.parentNode.removeChild(el);
  await flushObserver();

  assert.equal(warnings.length, 0);
  tracker.unregisterKernel(kernel);
});

test('audit finds detached-at-audit for orphaned watched nodes', () => {
  const tracker = createLeakTracker();
  // Turn off live warning so we don't remove entry on MO fire.
  const kernel = createDetachedDomKernel({ root: document, warnOnDetach: false });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  // Never in the tree; watch anyway.
  kernel.watch(el, 'never-attached');

  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'detached-dom');
  assert.equal(findings[0].reason, 'detached-at-audit');
  assert.equal(findings[0].tag, 'never-attached');

  tracker.unregisterKernel(kernel);
});

test('watch() inside effect auto-cleans registry on effect dispose', () => {
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  document.body.appendChild(el);

  const e = effect(() => {
    kernel.watch(el, 'in-effect');
  });
  assert.equal(kernel._watchedCount(), 1);

  dispose(e);
  assert.equal(kernel._watchedCount(), 0);

  tracker.unregisterKernel(kernel);
});

test('refine classifies dom-node tagged records', () => {
  const tracker = createLeakTracker();
  const kernel = createDetachedDomKernel({ root: document });
  tracker.registerKernel(kernel);

  const report = { tag: 'x', ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 };
  const record = { tag: { kind: 'dom-node', tag: 'user-tag' }, ownerPath: null, origin: null };
  const refined = kernel.refine(report, record);
  assert.equal(refined.kind, 'detached-dom');
  assert.equal(refined.userTag, 'user-tag');

  tracker.unregisterKernel(kernel);
});

test('captureStacks attaches origin', async () => {
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createDetachedDomKernel({ root: document, captureStacks: true });
  tracker.registerKernel(kernel);

  const el = document.createElement('div');
  document.body.appendChild(el);
  function distinctivelyNamedWatchSite() {
    kernel.watch(el, 'stack-test');
  }
  distinctivelyNamedWatchSite();

  el.parentNode.removeChild(el);
  await flushObserver();

  assert.match(warnings[0].origin, /distinctivelyNamedWatchSite/);
  tracker.unregisterKernel(kernel);
});
