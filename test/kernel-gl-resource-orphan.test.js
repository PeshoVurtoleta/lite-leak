import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker, createGlResourceOrphanKernel, KernelConflictError } from '../Leak.js';
import { makeGlHost } from './_helpers/resources.js';

// --- Construction contract ---

test('the context is required and validated', () => {
  assert.throws(() => createGlResourceOrphanKernel(), /options.gl must be a WebGL context object/);
  assert.throws(() => createGlResourceOrphanKernel({}), /options.gl must be a WebGL context object/);
  assert.throws(() => createGlResourceOrphanKernel({ gl: 'ctx' }), /must be a WebGL context object/);
  assert.throws(() => createGlResourceOrphanKernel({ gl: makeGlHost(), label: 7 }),
    /label must be a string/);
});

test('install patches create/delete pairs; uninstall restores them', () => {
  const gl = makeGlHost();
  const origCreate = gl.createBuffer;
  const origDelete = gl.deleteBuffer;

  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);
  assert.notEqual(gl.createBuffer, origCreate, 'createBuffer patched');

  tracker.unregisterKernel(kernel);
  assert.equal(gl.createBuffer, origCreate, 'createBuffer restored');
  assert.equal(gl.deleteBuffer, origDelete, 'deleteBuffer restored');
});

test('only resource kinds the context exposes are patched', () => {
  const gl = makeGlHost();
  delete gl.createSampler;   // WebGL1-style context
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);
  const kinds = kernel._presentKinds();
  assert.ok(kinds.includes('buffer'));
  assert.ok(!kinds.includes('sampler'), 'absent factories are skipped, not patched');
  assert.ok(!kernel.patchSurfaces.some((s) => s.endsWith('.createSampler')));
  tracker.unregisterKernel(kernel);
});

// --- Two contexts must not collide ---

test('two contexts can be instrumented at once without a false conflict', () => {
  // The tracker's patchSurfaces guard is a flat string set, so unnamespaced
  // surfaces would reject the second context as a conflict that does not exist.
  const main = makeGlHost();
  const picking = makeGlHost();
  const tracker = createLeakTracker();
  const kMain = createGlResourceOrphanKernel({ gl: main, label: 'main' });
  const kPick = createGlResourceOrphanKernel({ gl: picking, label: 'picking' });
  assert.doesNotThrow(() => { tracker.registerKernel(kMain); tracker.registerKernel(kPick); });
  assert.ok(kMain.patchSurfaces[0].startsWith('main.'));
  assert.ok(kPick.patchSurfaces[0].startsWith('picking.'));
  tracker.unregisterKernel(kPick);
  tracker.unregisterKernel(kMain);
});

test('labels are auto-generated and unique when omitted', () => {
  const a = createGlResourceOrphanKernel({ gl: makeGlHost() });
  const b = createGlResourceOrphanKernel({ gl: makeGlHost() });
  assert.notEqual(a._label, b._label);
  const tracker = createLeakTracker();
  assert.doesNotThrow(() => { tracker.registerKernel(a); tracker.registerKernel(b); });
});

test('two kernels on the SAME context are still reported as a double install', () => {
  // The real conflict, caught by the target-scoped claim rather than the name.
  const gl = makeGlHost();
  const findings = [];
  const tA = createLeakTracker();
  const tB = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const a = createGlResourceOrphanKernel({ gl, label: 'a' });
  const b = createGlResourceOrphanKernel({ gl, label: 'b' });
  tA.registerKernel(a);
  tB.registerKernel(b);
  const dbl = findings.filter((f) => f.reason === 'patch-double-install');
  assert.equal(dbl.length, 1, 'same-context double install must be reported');
  assert.ok(dbl[0].surfaces.some((s) => s.endsWith('.createBuffer')));
  tB.unregisterKernel(b);
  tA.unregisterKernel(a);
});

// --- Owner-scoped lifecycle ---

test('a resource created inside an effect is deleted on dispose', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  let buf = null;
  const e = effect(() => { buf = gl.createBuffer(); });
  assert.equal(buf.deleted, false);
  assert.equal(kernel._liveCount(), 1);

  dispose(e);
  assert.equal(buf.deleted, true, 'device memory released on owner disposal');
  assert.equal(gl._log.deleted, 1);
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('manual delete reaps the registration', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const tex = gl.createTexture();
  assert.equal(kernel._liveCount(), 1);
  gl.deleteTexture(tex);
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('each resource kind is tracked and reaped independently', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const buf = gl.createBuffer();
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  const prog = gl.createProgram();
  assert.equal(kernel._liveCount(), 4);

  gl.deleteBuffer(buf);
  gl.deleteTexture(tex);
  assert.equal(kernel._liveCount(), 2);

  const kinds = tracker.audit().map((f) => f.resourceKind).sort();
  assert.deepEqual(kinds, ['framebuffer', 'program']);
  tracker.unregisterKernel(kernel);
});

test('a factory returning null (allocation failure) is not tracked', () => {
  const gl = makeGlHost();
  gl.createBuffer = function () { return null; };
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  assert.equal(gl.createBuffer(), null, 'return value passed through');
  assert.equal(kernel._liveCount(), 0, 'a failed allocation is not a leak');
  tracker.unregisterKernel(kernel);
});

test('create passes arguments and return values through', () => {
  const gl = makeGlHost();
  let seenArg = null;
  const origCreateShader = gl.createShader;
  gl.createShader = function (type) { seenArg = type; return origCreateShader.call(gl); };

  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const sh = gl.createShader(35633);
  assert.equal(seenArg, 35633, 'shader type forwarded');
  assert.equal(typeof sh, 'object');
  tracker.unregisterKernel(kernel);
});

// --- No-owner warning ---

test('a resource created outside any owner warns once', () => {
  const gl = makeGlHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  gl.createBuffer();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'gl-resource-orphan');
  assert.equal(warnings[0].reason, 'no-owner-create');
  assert.equal(warnings[0].resourceKind, 'buffer');
  tracker.unregisterKernel(kernel);
});

test('createRoot detaches ownership: the warning still fires', () => {
  const gl = makeGlHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);
  createRoot(() => { gl.createTexture(); });
  assert.equal(warnings.length, 1);
  tracker.unregisterKernel(kernel);
});

test('warnOnNoOwner:false suppresses the warning', () => {
  const gl = makeGlHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);
  gl.createBuffer();
  assert.equal(warnings.length, 0);
  tracker.unregisterKernel(kernel);
});

// --- Audit ---

test('audit reports a live resource with no owner', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  gl.createTexture();
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'no-owner-resource-live');
  assert.equal(findings[0].resourceKind, 'texture');
  tracker.unregisterKernel(kernel);
});

test('audit stays clean for a healthy owner-scoped resource', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  const e = effect(() => { gl.createBuffer(); });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});

test('a lost context reports nothing: the driver already reclaimed it', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  gl.createBuffer();
  gl.createTexture();
  assert.equal(tracker.audit().length, 2, 'reported while the context is alive');

  gl._lose();
  assert.deepEqual(tracker.audit(), [],
    'a lost context destroyed everything it owned -- not a leak');
  tracker.unregisterKernel(kernel);
});

test('owner disposal after context loss does not throw', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  const e = effect(() => { gl.createBuffer(); });
  gl._lose();
  assert.doesNotThrow(() => dispose(e), 'deleting against a lost context must be a no-op');
  tracker.unregisterKernel(kernel);
});

// --- refine / advise ---

test('refine classifies a gl-tagged record and ignores others', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  assert.equal(kernel.refine({ tag: 'plain' }, { tag: 'plain' }), null);
  const tag = { kind: 'gl-resource', resourceKind: 'texture' };
  const refined = kernel.refine(
    { tag, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 }, { tag }
  );
  assert.equal(refined.kind, 'gl-resource-orphan');
  assert.equal(refined.resourceKind, 'texture');
  assert.equal(refined.wasDeleted, false);
  tracker.unregisterKernel(kernel);
});

test('advise returns guidance per reason', () => {
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  tracker.registerKernel(createGlResourceOrphanKernel({ gl }));
  for (const reason of ['no-owner-create', 'no-owner-resource-live',
    'owner-disposed-resource-live']) {
    const advice = tracker.remediate({ kind: 'gl-resource-orphan', reason });
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0, 'advice for ' + reason);
  }
});

test('claims are released on uninstall so a later install is clean', () => {
  const gl = makeGlHost();
  const t1 = createLeakTracker();
  const k1 = createGlResourceOrphanKernel({ gl });
  t1.registerKernel(k1);
  t1.unregisterKernel(k1);

  const findings = [];
  const t2 = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const k2 = createGlResourceOrphanKernel({ gl });
  t2.registerKernel(k2);
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0);
  t2.unregisterKernel(k2);
});

test('a scene-reload loop reaps fully and does not grow the kernel', () => {
  // The shape of the real bug this kernel exists for: repeated scene builds
  // that each allocate GPU resources. If the reap path missed, _liveCount grows
  // by one pass per reload while the JS heap looks perfectly clean.
  const gl = makeGlHost();
  const tracker = createLeakTracker();
  const kernel = createGlResourceOrphanKernel({ gl });
  tracker.registerKernel(kernel);

  for (let i = 0; i < 300; i++) {
    const e = effect(() => {
      gl.createBuffer(); gl.createTexture(); gl.createProgram();
    });
    dispose(e);
  }
  assert.equal(kernel._liveCount(), 0, 'every reload released its GPU resources');
  assert.equal(gl._log.created, 900);
  assert.equal(gl._log.deleted, 900, 'create/delete pairing held across 300 reloads');
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});
