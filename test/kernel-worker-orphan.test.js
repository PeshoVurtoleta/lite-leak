import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker, createWorkerOrphanKernel, KernelConflictError } from '../Leak.js';
import { makeWorkerHost } from './_helpers/resources.js';

// --- Install / uninstall ---

test('install patches Worker; uninstall restores it', () => {
  const host = makeWorkerHost();
  const orig = host.Worker;
  const origRevoke = host.URL.revokeObjectURL;

  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);
  assert.notEqual(host.Worker, orig, 'Worker patched');

  tracker.unregisterKernel(kernel);
  assert.equal(host.Worker, orig, 'Worker restored');
  assert.equal(host.URL.revokeObjectURL, origRevoke, 'revokeObjectURL restored');
});

test('two worker kernels on the same tracker collide on patch surfaces', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const a = createWorkerOrphanKernel({ target: host });
  const b = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

test('a second kernel instance on the same target is reported, not silent', () => {
  const host = makeWorkerHost();
  const findings = [];
  const tA = createLeakTracker();
  const tB = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const a = createWorkerOrphanKernel({ target: host });
  const b = createWorkerOrphanKernel({ target: host });
  tA.registerKernel(a);
  tB.registerKernel(b);   // separate tracker: the per-tracker guard cannot see it
  const dbl = findings.filter((f) => f.reason === 'patch-double-install');
  assert.equal(dbl.length, 1);
  assert.ok(dbl[0].surfaces.includes('Worker'));
  tB.unregisterKernel(b);
  tA.unregisterKernel(a);
});

// --- Owner-scoped lifecycle ---

test('a worker constructed inside an effect is terminated on dispose', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  let w = null;
  const e = effect(() => { w = new host.Worker('worker.js'); });
  assert.equal(w.alive, true);
  assert.equal(kernel._liveCount(), 1);

  dispose(e);
  assert.equal(w.alive, false, 'auto-terminated on owner disposal');
  assert.equal(host._log.terminated, 1);
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('manual terminate() reaps the registration', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  const e = effect(() => { new host.Worker('worker.js'); });
  assert.equal(kernel._liveCount(), 1);

  // Reach the instance through the effect-scoped construction.
  const w = new host.Worker('second.js');
  w.terminate();
  assert.equal(kernel._liveCount(), 1, 'only the effect-scoped worker remains');

  dispose(e);
  tracker.unregisterKernel(kernel);
});

test('double terminate() is inert', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  const w = new host.Worker('worker.js');
  w.terminate();
  w.terminate();
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

// --- No-owner warning ---

test('a worker constructed outside any owner warns once', () => {
  const host = makeWorkerHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  new host.Worker('worker.js');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'worker-orphan');
  assert.equal(warnings[0].reason, 'no-owner-set');
  assert.equal(warnings[0].workerKind, 'Worker');
  tracker.unregisterKernel(kernel);
});

test('createRoot detaches ownership: the warning still fires', () => {
  const host = makeWorkerHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  createRoot(() => { new host.Worker('worker.js'); });
  assert.equal(warnings.length, 1);
  tracker.unregisterKernel(kernel);
});

test('warnOnNoOwner:false suppresses the warning', () => {
  const host = makeWorkerHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);
  new host.Worker('worker.js');
  assert.equal(warnings.length, 0);
  tracker.unregisterKernel(kernel);
});

// --- Audit ---

test('audit reports a live worker with no owner', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  new host.Worker('worker.js');
  const findings = tracker.audit();
  const live = findings.filter((f) => f.reason === 'no-owner-worker-live');
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'worker-orphan');
  tracker.unregisterKernel(kernel);
});

test('a SharedWorker outliving its owner is reported (nothing can terminate it)', () => {
  const host = makeWorkerHost();
  // SharedWorker exposes no terminate(): the constructing context cannot stop
  // it, so a disposed owner leaves a genuinely live agent behind.
  host.SharedWorker = class MockSharedWorker {
    constructor(url) { this.url = url; this.alive = true; }
  };
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  const e = effect(() => { new host.SharedWorker('shared.js'); });
  assert.deepEqual(tracker.audit(), [], 'clean while the owner is alive');

  dispose(e);
  const findings = tracker.audit();
  const live = findings.filter((f) => f.reason === 'owner-disposed-worker-live');
  assert.equal(live.length, 1, 'reported rather than silently reaped');
  assert.equal(live[0].workerKind, 'SharedWorker');
  tracker.unregisterKernel(kernel);
});

test('audit stays clean for a healthy owner-scoped worker', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  const e = effect(() => { new host.Worker('worker.js'); });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});

// --- Object URLs ---

test('a blob URL revoked after construction is clean (the lite-worker pattern)', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  // Exactly what @zakkster/lite-worker does: mint, construct, revoke at once.
  const url = host.URL.createObjectURL({});
  new host.Worker(url);
  host.URL.revokeObjectURL(url);

  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'blob-url-unrevoked').length, 0,
    'revoking immediately after construction must not be reported');
  tracker.unregisterKernel(kernel);
});

test('a blob URL never revoked is reported', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const url = host.URL.createObjectURL({});
  new host.Worker(url);

  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'blob-url-unrevoked').length, 1);
  tracker.unregisterKernel(kernel);
});

test('a non-blob script URL is never reported as an object-URL leak', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  new host.Worker('/static/worker.js');
  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'blob-url-unrevoked').length, 0);
  tracker.unregisterKernel(kernel);
});

test('trackObjectURLs:false leaves the URL surface untouched', () => {
  const host = makeWorkerHost();
  const origRevoke = host.URL.revokeObjectURL;
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, trackObjectURLs: false, warnOnNoOwner: false });
  tracker.registerKernel(kernel);
  assert.equal(host.URL.revokeObjectURL, origRevoke, 'revokeObjectURL not patched');
  assert.ok(!kernel.patchSurfaces.includes('URL.revokeObjectURL'));

  const url = host.URL.createObjectURL({});
  new host.Worker(url);
  assert.equal(tracker.audit().filter((f) => f.reason === 'blob-url-unrevoked').length, 0);
  tracker.unregisterKernel(kernel);
});

// --- refine / advise ---

test('refine classifies a worker-tagged record and ignores others', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  assert.equal(kernel.refine({ tag: 'plain' }, { tag: 'plain' }), null);

  const tag = { kind: 'worker', workerKind: 'Worker' };
  const refined = kernel.refine(
    { tag, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 }, { tag }
  );
  assert.equal(refined.kind, 'worker-orphan');
  assert.equal(refined.workerKind, 'Worker');
  assert.equal(refined.wasTerminated, false);
  tracker.unregisterKernel(kernel);
});

test('advise returns guidance per reason and null for foreign findings', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  tracker.registerKernel(createWorkerOrphanKernel({ target: host }));
  for (const reason of ['no-owner-set', 'no-owner-worker-live',
    'owner-disposed-worker-live', 'blob-url-unrevoked']) {
    const advice = tracker.remediate({ kind: 'worker-orphan', reason });
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0, 'advice for ' + reason);
  }
  assert.match(tracker.remediate({ kind: 'worker-orphan', reason: 'bogus' }),
    /No kernel-provided remediation/);
});

// --- Claim release ---

test('claims are released on uninstall so a later install is clean', () => {
  const host = makeWorkerHost();
  const t1 = createLeakTracker();
  const k1 = createWorkerOrphanKernel({ target: host });
  t1.registerKernel(k1);
  t1.unregisterKernel(k1);

  const findings = [];
  const t2 = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const k2 = createWorkerOrphanKernel({ target: host });
  t2.registerKernel(k2);
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0);
  t2.unregisterKernel(k2);
});

test('the constructor wrapper stays transparent', () => {
  const host = makeWorkerHost();
  const tracker = createLeakTracker();
  const kernel = createWorkerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const w = new host.Worker('worker.js', { type: 'module' });
  assert.equal(w.url, 'worker.js', 'first argument passed through');
  assert.deepEqual(w.opts, { type: 'module' }, 'second argument passed through');
  assert.equal(host._log.constructed, 1);
  tracker.unregisterKernel(kernel);
});
