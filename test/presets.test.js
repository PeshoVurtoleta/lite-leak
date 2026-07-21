import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker, createDefaultKernels, KernelConflictError,
  createTimerOrphanKernel, createRafOrphanKernel } from '../Leak.js';

/** A target exposing every global the preset probes for. @private */
function makeFullTarget() {
  const noop = function () {};
  return {
    setTimeout: function () { return 1; }, clearTimeout: noop,
    setInterval: function () { return 1; }, clearInterval: noop,
    requestAnimationFrame: function () { return 1; }, cancelAnimationFrame: noop,
    EventTarget: class EventTarget { addEventListener() {} removeEventListener() {} },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
    IntersectionObserver: class IntersectionObserver { observe() {} disconnect() {} },
    AbortController: class AbortController { constructor() { this.signal = {}; } abort() {} },
    Worker: class Worker { terminate() {} },
    SharedWorker: class SharedWorker {},
    AudioNode: class AudioNode { connect() {} disconnect() {} },
    AudioScheduledSourceNode: class AudioScheduledSourceNode { start() {} stop() {} },
    WebSocket: class WebSocket { close() {} },
    EventSource: class EventSource { close() {} },
    URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
  };
}

test('the preset registers every kernel a full runtime supports, with no conflicts', () => {
  const target = makeFullTarget();
  const { kernels, skipped } = createDefaultKernels({ target });
  assert.deepEqual(skipped, [], 'nothing should be skipped on a complete target');

  const tracker = createLeakTracker();
  assert.doesNotThrow(() => { for (const k of kernels) tracker.registerKernel(k); },
    'the preset must compose without a KernelConflictError');
  assert.equal(kernels.length, 9);
  for (const k of kernels) tracker.unregisterKernel(k);
});

test('timer-orphan cedes requestAnimationFrame so raf-orphan can claim it', () => {
  // The trap this preset exists for: composing them in the obvious order throws,
  // and the weaker rAF detector wins if you resolve it the other way.
  const target = makeFullTarget();
  const tracker = createLeakTracker();
  tracker.registerKernel(createTimerOrphanKernel({ target }));
  assert.throws(() => tracker.registerKernel(createRafOrphanKernel({ target })),
    KernelConflictError, 'hand-rolled composition collides on requestAnimationFrame');

  const clean = createLeakTracker();
  const { kernels } = createDefaultKernels({ target });
  assert.doesNotThrow(() => { for (const k of kernels) clean.registerKernel(k); });
  const timer = kernels.find((k) => k.name === 'timer-orphan');
  const raf = kernels.find((k) => k.name === 'raf-orphan');
  assert.ok(!timer.patchSurfaces.includes('requestAnimationFrame'),
    'timer-orphan must not claim rAF in the preset');
  assert.ok(raf.patchSurfaces.includes('requestAnimationFrame'),
    'raf-orphan takes the surface');
});

test('kernels whose globals are absent are skipped with a reason, not silently inert', () => {
  // Registering them would claim surfaces, patch nothing, and report clean
  // forever, which is indistinguishable from a quiet run.
  const bare = { setTimeout: function () { return 1; }, clearTimeout: function () {} };
  const { kernels, skipped } = createDefaultKernels({ target: bare });
  const names = kernels.map((k) => k.name);
  assert.ok(names.includes('timer-orphan'));
  assert.ok(!names.includes('worker-orphan'));

  const skippedNames = skipped.map((s) => s.name);
  for (const expected of ['raf-orphan', 'observer-orphan', 'worker-orphan',
    'audio-node', 'socket-orphan', 'listener-orphan', 'async-retention']) {
    assert.ok(skippedNames.includes(expected), expected + ' should be skipped');
  }
  for (const s of skipped) {
    assert.equal(typeof s.reason, 'string');
    assert.ok(s.reason.length > 0, 'every skip must carry a reason');
  }
});

test('owner-cascade-orphan is always available: it needs no globals', () => {
  const { kernels } = createDefaultKernels({ target: {} });
  assert.deepEqual(kernels.map((k) => k.name), ['owner-cascade-orphan']);
});

test('exclude leaves kernels out and records them as skipped', () => {
  const target = makeFullTarget();
  const { kernels, skipped } = createDefaultKernels({
    target, exclude: ['audio-node', 'socket-orphan'],
  });
  const names = kernels.map((k) => k.name);
  assert.ok(!names.includes('audio-node'));
  assert.ok(!names.includes('socket-orphan'));
  const excluded = skipped.filter((s) => s.reason === 'excluded by caller').map((s) => s.name);
  assert.deepEqual(excluded.sort(), ['audio-node', 'socket-orphan']);
});

test('detached-dom and gl-resource-orphan are never included', () => {
  // Both need configuration that cannot be guessed; a wrong guess would watch
  // the wrong subtree or the wrong context and report clean forever.
  const { kernels } = createDefaultKernels({ target: makeFullTarget() });
  const names = kernels.map((k) => k.name);
  assert.ok(!names.includes('detached-dom'));
  assert.ok(!names.some((n) => n.startsWith('gl-resource-orphan')));
});

test('shared options are forwarded to the kernels', () => {
  const target = makeFullTarget();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const { kernels } = createDefaultKernels({ target, warnOnNoOwner: false });
  for (const k of kernels) tracker.registerKernel(k);

  new target.WebSocket('wss://example.test');   // outside any owner
  assert.equal(warnings.length, 0, 'warnOnNoOwner:false must reach the kernels');
  for (const k of kernels) tracker.unregisterKernel(k);
});

test('the preset validates its own options', () => {
  assert.throws(() => createDefaultKernels({ targt: {} }), /unknown option "targt"/);
  assert.throws(() => createDefaultKernels('globalThis'), /options must be an object/);
  assert.doesNotThrow(() => createDefaultKernels());
  assert.doesNotThrow(() => createDefaultKernels(undefined));
});

test('the preset actually detects a leak end to end', () => {
  const target = makeFullTarget();
  const tracker = createLeakTracker();
  const { kernels } = createDefaultKernels({ target });
  for (const k of kernels) tracker.registerKernel(k);

  target.setTimeout(function () {}, 1000);   // armed outside any owner
  const findings = tracker.audit();
  assert.ok(findings.length > 0, 'a preset-assembled tracker must actually report');
  assert.ok(findings.some((f) => f.kind === 'timer-orphan'));
  for (const k of kernels) tracker.unregisterKernel(k);
});
