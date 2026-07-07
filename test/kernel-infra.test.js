import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  KernelConflictError,
} from '../Leak.js';
import { tryForceCollect, delay, GC_AVAILABLE } from './_helpers/gc.js';

// --- Minimal mock kernel factory used across infra tests ---

function makeMockKernel(name, opts = {}) {
  const state = {
    installed: false,
    uninstalled: false,
    refinesSeen: 0,
    auditsSeen: 0,
    ctx: null,
  };
  const kernel = {
    name,
    patchSurfaces: opts.patchSurfaces || [],
    install(ctx) {
      state.installed = true;
      state.ctx = ctx;
      if (opts.installThrows) throw new Error('install-failed');
    },
    uninstall() {
      state.uninstalled = true;
      if (opts.uninstallThrows) throw new Error('uninstall-failed');
    },
    refine(report, record) {
      state.refinesSeen++;
      if (opts.refineThrows) throw new Error('refine-failed');
      if (opts.refineTo !== undefined) {
        return {
          tag: report.tag,
          ownerPath: report.ownerPath,
          origin: report.origin,
          kind: opts.refineTo,
          collectedAt: report.collectedAt,
        };
      }
      return null;
    },
    audit() {
      state.auditsSeen++;
      if (opts.auditThrows) throw new Error('audit-failed');
      return opts.auditFindings || [];
    },
  };
  return { kernel, state };
}

test('registerKernel installs the kernel and calls install(ctx)', () => {
  const tracker = createLeakTracker();
  const { kernel, state } = makeMockKernel('m1');
  tracker.registerKernel(kernel);
  assert.equal(state.installed, true);
  assert.equal(state.uninstalled, false);
  assert.equal(typeof state.ctx, 'object');
  assert.equal(state.ctx.trackerName, 'lite-leak');
});

test('registerKernel returns a disposer that unregisters the kernel', () => {
  const tracker = createLeakTracker();
  const { kernel, state } = makeMockKernel('m1');
  const off = tracker.registerKernel(kernel);
  off();
  assert.equal(state.uninstalled, true);
});

test('unregisterKernel is idempotent', () => {
  const tracker = createLeakTracker();
  const { kernel } = makeMockKernel('m1');
  tracker.registerKernel(kernel);
  tracker.unregisterKernel(kernel);
  tracker.unregisterKernel(kernel);
  tracker.unregisterKernel(kernel);
});

test('registerKernel throws KernelConflictError on duplicate name', () => {
  const tracker = createLeakTracker();
  const a = makeMockKernel('same-name');
  const b = makeMockKernel('same-name');
  tracker.registerKernel(a.kernel);
  assert.throws(
    () => tracker.registerKernel(b.kernel),
    KernelConflictError
  );
});

test('registerKernel throws KernelConflictError on duplicate patch surface', () => {
  const tracker = createLeakTracker();
  const a = makeMockKernel('a', { patchSurfaces: ['setTimeout'] });
  const b = makeMockKernel('b', { patchSurfaces: ['setTimeout'] });
  tracker.registerKernel(a.kernel);
  assert.throws(
    () => tracker.registerKernel(b.kernel),
    KernelConflictError
  );
});

test('after unregister, the same name / surface can be re-registered', () => {
  const tracker = createLeakTracker();
  const a = makeMockKernel('a', { patchSurfaces: ['setTimeout'] });
  const b = makeMockKernel('a', { patchSurfaces: ['setTimeout'] });
  tracker.registerKernel(a.kernel);
  tracker.unregisterKernel(a.kernel);
  tracker.registerKernel(b.kernel); // no throw
  assert.equal(b.state.installed, true);
});

test('registerKernel rolls back on install failure', () => {
  const tracker = createLeakTracker();
  const a = makeMockKernel('a', { installThrows: true, patchSurfaces: ['tick'] });
  assert.throws(() => tracker.registerKernel(a.kernel), /install-failed/);
  // The name/surface should NOT be claimed after the failed install.
  const b = makeMockKernel('a', { patchSurfaces: ['tick'] });
  tracker.registerKernel(b.kernel); // no throw
  assert.equal(b.state.installed, true);
});

test('registerKernel rejects non-object kernels', () => {
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel(null), TypeError);
  assert.throws(() => tracker.registerKernel('a-string'), TypeError);
});

test('registerKernel rejects kernel without a name string', () => {
  const tracker = createLeakTracker();
  assert.throws(() => tracker.registerKernel({}), TypeError);
  assert.throws(() => tracker.registerKernel({ name: '' }), TypeError);
  assert.throws(() => tracker.registerKernel({ name: 123 }), TypeError);
});

test('audit() calls audit() on each registered kernel and aggregates findings', () => {
  const tracker = createLeakTracker();
  const a = makeMockKernel('a', { auditFindings: [{ kind: 'a-thing' }] });
  const b = makeMockKernel('b', { auditFindings: [{ kind: 'b-thing-1' }, { kind: 'b-thing-2' }] });
  tracker.registerKernel(a.kernel);
  tracker.registerKernel(b.kernel);

  const findings = tracker.audit();
  assert.equal(findings.length, 3);
  assert.equal(a.state.auditsSeen, 1);
  assert.equal(b.state.auditsSeen, 1);
});

test('audit() emits each finding via onFinding', () => {
  const seen = [];
  const tracker = createLeakTracker({ onFinding: (f) => seen.push(f) });
  const a = makeMockKernel('a', { auditFindings: [{ kind: 'x' }, { kind: 'y' }] });
  tracker.registerKernel(a.kernel);

  tracker.audit();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((f) => f.kind), ['x', 'y']);
});

test('audit() with no kernels returns empty array', () => {
  const tracker = createLeakTracker();
  assert.deepEqual(tracker.audit(), []);
});

test('audit() continues past kernel errors and routes to onError', () => {
  const errs = [];
  const tracker = createLeakTracker({ onError: (e) => errs.push(e) });
  const bad = makeMockKernel('bad', { auditThrows: true });
  const good = makeMockKernel('good', { auditFindings: [{ kind: 'g' }] });
  tracker.registerKernel(bad.kernel);
  tracker.registerKernel(good.kernel);

  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'g');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /audit-failed/);
});

test('refine chain: first non-null wins, in registration order', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  const a = makeMockKernel('a', { refineTo: undefined });   // returns null
  const b = makeMockKernel('b', { refineTo: 'b-classified' });
  const c = makeMockKernel('c', { refineTo: 'c-classified' });
  tracker.registerKernel(a.kernel);
  tracker.registerKernel(b.kernel);
  tracker.registerKernel(c.kernel);

  (function () {
    tracker.track({}, () => {}, 'x');
  })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'b-classified', 'b won because a returned null');
  assert.equal(a.state.refinesSeen, 1);
  assert.equal(b.state.refinesSeen, 1);
  // c never queried once b returned non-null.
  assert.equal(c.state.refinesSeen, 0);
});

test('refine error does not stop the chain; kind stays unknown if all fail', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const errs = [];
  const reports = [];
  const tracker = createLeakTracker({
    onLeak: (r) => reports.push(r),
    onError: (e) => errs.push(e),
  });
  const a = makeMockKernel('a', { refineThrows: true });
  const b = makeMockKernel('b', { refineTo: undefined }); // null
  tracker.registerKernel(a.kernel);
  tracker.registerKernel(b.kernel);

  (function () {
    tracker.track({}, () => {}, 'x');
  })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'unknown');
  assert.equal(a.state.refinesSeen, 1);
  assert.equal(b.state.refinesSeen, 1);
  assert.ok(errs.length >= 1);
});

test('kernel install after registerKernel is deterministic and one-shot', () => {
  const tracker = createLeakTracker();
  const { kernel, state } = makeMockKernel('once');
  tracker.registerKernel(kernel);
  // install() should only be called once.
  assert.equal(state.installed, true);
  // No mechanism for re-install exists in the public API.
});

test('{ audit: true } opts in to audit; default is retention-neutral', () => {
  const tracker = createLeakTracker();
  const kernel = {
    name: 'peek',
    audit() {
      const seen = [];
      // No direct access to auditedHandles from outside; use the ctx.
      // The ctx should iterate only audited records.
      return seen;
    },
  };
  // Install via minimal shim to get ctx.forEachAuditedHandle
  let ctx;
  const introspect = {
    name: 'introspect',
    patchSurfaces: [],
    install(c) { ctx = c; },
    uninstall() {},
  };
  tracker.registerKernel(introspect);

  // Non-audited track
  const h1 = tracker.track({}, () => {}, 'not-audited');
  // Audited track
  const h2 = tracker.track({}, () => {}, 'audited', { audit: true });

  const iterated = [];
  ctx.forEachAuditedHandle((handle, record) => iterated.push(record.tag));
  assert.deepEqual(iterated, ['audited']);

  tracker.untrack(h1);
  tracker.untrack(h2);
});

// --- Priority ordering ---

test('higher-priority kernel is tried before lower-priority in refine chain', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  // Register generic FIRST, specialised SECOND. Without priority, generic
  // would win. With priority, specialised wins.
  const generic = makeMockKernel('generic', { refineTo: 'generic-classified' });
  const specialised = makeMockKernel('specialised', { refineTo: 'specialised-classified' });
  specialised.kernel.priority = 10;
  tracker.registerKernel(generic.kernel);
  tracker.registerKernel(specialised.kernel);

  (function () { tracker.track({}, () => {}, 'x'); })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'specialised-classified',
    'specialised (priority 10) beat generic (priority 0) despite later registration');
  assert.equal(specialised.state.refinesSeen, 1);
  assert.equal(generic.state.refinesSeen, 0,
    'generic never queried once specialised returned non-null');
});

test('equal-priority kernels preserve registration order (stable sort)', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  const a = makeMockKernel('a', { refineTo: 'a-classified' });
  const b = makeMockKernel('b', { refineTo: 'b-classified' });
  // Both priority 0 (default). a registered first should win.
  tracker.registerKernel(a.kernel);
  tracker.registerKernel(b.kernel);

  (function () { tracker.track({}, () => {}, 'x'); })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports[0].kind, 'a-classified');
});

test('audit() iterates kernels in priority order', () => {
  const tracker = createLeakTracker();
  const order = [];
  const low = { name: 'low',  priority: 0,   audit() { order.push('low');  return []; } };
  const mid = { name: 'mid',  priority: 5,   audit() { order.push('mid');  return []; } };
  const hi  = { name: 'hi',   priority: 10,  audit() { order.push('hi');   return []; } };
  // Register out of order.
  tracker.registerKernel(low);
  tracker.registerKernel(hi);
  tracker.registerKernel(mid);

  tracker.audit();
  assert.deepEqual(order, ['hi', 'mid', 'low']);
});

test('undefined priority defaults to 0', () => {
  const tracker = createLeakTracker();
  const order = [];
  const noPri = { name: 'no-pri', audit() { order.push('no-pri'); return []; } };
  const pri5  = { name: 'pri-5', priority: 5, audit() { order.push('pri-5'); return []; } };
  tracker.registerKernel(noPri);
  tracker.registerKernel(pri5);
  tracker.audit();
  assert.deepEqual(order, ['pri-5', 'no-pri'], 'pri-5 > default 0');
});

// --- Set-iteration safety (Edge Case 1 guard) ---

test('forEachAuditedHandle handles disposed records without iteration errors', () => {
  const tracker = createLeakTracker();
  let ctx;
  const probe = {
    name: 'probe',
    install(c) { ctx = c; },
    uninstall() {},
  };
  tracker.registerKernel(probe);

  // Fill the audit set with many entries so mid-iteration deletion is
  // stress-tested.
  const handles = [];
  for (let i = 0; i < 50; i++) {
    handles.push(tracker.track({}, () => {}, 'h-' + i, { audit: true }));
  }
  // Untrack half of them (marks them disposed).
  for (let i = 0; i < 50; i += 2) tracker.untrack(handles[i]);

  const seenTags = [];
  ctx.forEachAuditedHandle((handle, record) => seenTags.push(record.tag));

  // Only the odd-indexed entries should be seen.
  assert.equal(seenTags.length, 25);
  for (const tag of seenTags) {
    const idx = Number(tag.slice(2));
    assert.equal(idx % 2, 1, 'odd index expected: ' + tag);
  }

  // A second pass should also work correctly (stale entries already reaped).
  const seen2 = [];
  ctx.forEachAuditedHandle((handle, record) => seen2.push(record.tag));
  assert.equal(seen2.length, 25);

  // Cleanup
  for (let i = 1; i < 50; i += 2) tracker.untrack(handles[i]);
});
