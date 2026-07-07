import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, signal, runWithOwner, getOwner, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker, createOwnerCascadeOrphanKernel } from '../Leak.js';
import { tryForceCollect, delay, GC_AVAILABLE } from './_helpers/gc.js';

// --- Healthy case: no findings ---

test('audit on healthy tracker returns no findings', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  const e = effect(() => {
    tracker.track({}, () => {}, 'a', { audit: true });
    tracker.track({}, () => {}, 'b', { audit: true });
  });

  const findings = tracker.audit();
  assert.deepEqual(findings, []);
  dispose(e);
});

test('audit ignores non-audited handles even if they leak', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  // Track without audit
  const e = effect(() => {
    tracker.track({}, () => {}, 'no-audit'); // default { audit: false }
  });

  const findings = tracker.audit();
  assert.deepEqual(findings, []);
  dispose(e);
});

test('audit skips handles tracked outside any owner (createRoot / top-level)', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  createRoot(() => {
    tracker.track({}, () => {}, 'in-root', { audit: true });
  });

  const findings = tracker.audit();
  assert.deepEqual(findings, [], 'no owner path -> not applicable');
});

test('audit skips handle whose owner is still-live-and-matching-snapshot', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  const e = effect(() => {
    tracker.track({}, () => {}, 'clean', { audit: true });
  });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
});

// --- Refine (FR-time) path ---

test('refine returns null for FR fire when no audit opt-in was made', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  (function () {
    tracker.track({}, () => {}, 'no-audit');
  })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'unknown', 'kernel does not classify without audit opt-in');
});

// --- Pathological case: synthetic broken cascade via direct kernel invocation ---
//
// A well-behaved lite-signal cascades ownership correctly; we cannot exhibit
// a real broken cascade through normal API use (the auto-untrack always
// fires). To verify the KERNEL detects the pathology when it occurs, we
// invoke the kernel's audit() with a mock ctx that yields a hand-crafted
// record: an ownerHandle pointing to a disposed owner.

test('kernel.audit finds a stale ownerHandle via mock ctx (synthetic)', () => {
  // Build a real stale handle: create an effect, capture its owner
  // descriptor, then dispose the effect. nodeId(handle) will now return
  // undefined.
  let staleOwnerHandle;
  const e = effect(() => {
    staleOwnerHandle = getOwner();
  });
  const expectedFrame = { id: staleOwnerHandle.id, kind: staleOwnerHandle.kind };
  dispose(e);
  // At this point staleOwnerHandle is a gen-stamped descriptor whose live
  // gen no longer matches -- nodeId(staleOwnerHandle) is undefined.

  const kernel = createOwnerCascadeOrphanKernel();
  // Fake ctx: yields one hand-crafted record.
  const mockCtx = {
    trackerName: 'mock',
    forEachAuditedHandle(fn) {
      const fakeHandle = { disposed: false };
      const fakeRecord = {
        tag: 'synthetic',
        ownerPath: [expectedFrame],
        origin: null,
        ownerHandle: staleOwnerHandle,
        audit: true,
        handle: fakeHandle,
      };
      fn(fakeHandle, fakeRecord);
    },
    emitWarning() {},
    emitFinding() {},
    reportError() {},
  };
  kernel.install(mockCtx);

  const findings = kernel.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'owner-cascade-orphan');
  assert.equal(findings[0].tag, 'synthetic');
  assert.equal(findings[0].brokenAt, 0);
  assert.equal(findings[0].reason, 'stale');
});

test('kernel.audit finds a diverged owner via mock ctx (synthetic id mismatch)', () => {
  // Real live handle, but the expected snapshot says a different id.
  let liveOwnerHandle;
  const e = effect(() => {
    liveOwnerHandle = getOwner();
  });

  const kernel = createOwnerCascadeOrphanKernel();
  const mockCtx = {
    trackerName: 'mock',
    forEachAuditedHandle(fn) {
      const fakeHandle = { disposed: false };
      const fakeRecord = {
        tag: 'diverged',
        // Snapshot claims id 99999 (fictitious); real id differs.
        ownerPath: [{ id: 99999, kind: 'effect' }],
        origin: null,
        ownerHandle: liveOwnerHandle,
        audit: true,
        handle: fakeHandle,
      };
      fn(fakeHandle, fakeRecord);
    },
    emitWarning() {},
    emitFinding() {},
    reportError() {},
  };
  kernel.install(mockCtx);

  const findings = kernel.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'diverged');
  assert.equal(findings[0].brokenAt, 0);
  assert.ok(findings[0].liveFrame !== null);
  assert.equal(findings[0].liveFrame.id, liveOwnerHandle.id);
  dispose(e);
});

test('kernel.audit finds truncation when snapshot has more depth than live tree', () => {
  // Live: one-level effect. Snapshot: pretend three levels.
  let liveOwnerHandle;
  const e = effect(() => {
    liveOwnerHandle = getOwner();
  });

  const kernel = createOwnerCascadeOrphanKernel();
  const mockCtx = {
    trackerName: 'mock',
    forEachAuditedHandle(fn) {
      const fakeHandle = { disposed: false };
      const fakeRecord = {
        tag: 'truncated',
        // Snapshot claims two frames, but the real owner has only one.
        // The first frame's id must match to survive past depth 0.
        ownerPath: [
          { id: liveOwnerHandle.id, kind: liveOwnerHandle.kind },
          { id: 99998, kind: 'effect' },
        ],
        origin: null,
        ownerHandle: liveOwnerHandle,
        audit: true,
        handle: fakeHandle,
      };
      fn(fakeHandle, fakeRecord);
    },
    emitWarning() {},
    emitFinding() {},
    reportError() {},
  };
  kernel.install(mockCtx);

  const findings = kernel.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'truncated');
  assert.equal(findings[0].brokenAt, 1);
  dispose(e);
});

test('kernel.refine returns null for FR fire on healthy audited record', async (t) => {
  if (!GC_AVAILABLE) return t.skip('run with --expose-gc');
  // In practice this needs an audit-opt-in track whose owner is still healthy
  // when the FR fires. Because auto-untrack fires on owner dispose BEFORE
  // the FR can, healthy audited handles never reach the FR path via clean
  // owner-driven code. Verify via a manual synthetic reflow.
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  // Track outside owner: ownerPath null -> refine returns null -> report is 'unknown'.
  (function () {
    tracker.track({}, () => {}, 'top-level', { audit: true });
  })();
  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'unknown');
});

// --- Multi-kernel integration: cascade kernel plus another --

test('cascade kernel co-exists with a no-op passthrough kernel', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());
  tracker.registerKernel({
    name: 'noop',
    audit() { return [{ kind: 'noop-tick' }]; },
  });

  const e = effect(() => {
    tracker.track({}, () => {}, 'x', { audit: true });
  });

  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'noop-tick');
  dispose(e);
});

test('multiple audited handles across nested effects: healthy tree has no findings', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  const s = signal(0);
  const e = effect(() => {
    s();
    tracker.track({}, () => {}, 'outer', { audit: true });
    effect(() => {
      tracker.track({}, () => {}, 'inner', { audit: true });
    });
  });

  assert.deepEqual(tracker.audit(), [], 'nested healthy tree is clean');

  s.set(1);
  assert.deepEqual(tracker.audit(), [], 'still clean after re-run');

  dispose(e);
  assert.deepEqual(tracker.audit(), []);
});
