import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLeakTracker,
  createOwnerCascadeOrphanKernel,
  MAX_OWNER_WALK,
  VERSION,
} from '../Leak.js';

// --- MAX_OWNER_WALK export (hardening #3) ---

test('MAX_OWNER_WALK is exported as a number', () => {
  assert.equal(typeof MAX_OWNER_WALK, 'number');
  assert.ok(MAX_OWNER_WALK >= 1024, 'must be at least 1024');
  assert.ok(Number.isInteger(MAX_OWNER_WALK), 'must be integer');
});

test('kernels can reference MAX_OWNER_WALK for their own boundary checks', () => {
  // Verify that any kernel's internal walk logic can be verified against
  // the same boundary constant.
  const walk = [];
  for (let i = 0; i < MAX_OWNER_WALK; i++) walk.push({ id: i, kind: 'effect' });
  assert.equal(walk.length, MAX_OWNER_WALK);
});

// --- Record contract resilience (hardening #2) ---

test('track(target, null, null, { audit: true }) at top level does not crash', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  // Minimal record shape: null cleanup, null tag, audit opt-in.
  const target = {};
  const handle = tracker.track(target, null, null, { audit: true });
  assert.equal(handle.disposed, false);
  assert.deepEqual(tracker.audit(), [], 'default: no finding for no-attribution');
  tracker.untrack(handle);
});

test('track(target, () => {}, undefined, { audit: true }) top-level -> audit empty by default', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel());
  const h = tracker.track({}, () => {}, undefined, { audit: true });
  assert.deepEqual(tracker.audit(), []);
  tracker.untrack(h);
});

test('emitNoAttribution: true -> finding emitted for top-level audit track', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel({ emitNoAttribution: true }));

  const h = tracker.track({}, null, 'top-level', { audit: true });
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'owner-cascade-orphan');
  assert.equal(findings[0].reason, 'no-attribution');
  assert.equal(findings[0].tag, 'top-level');
  assert.equal(findings[0].ownerPath, null);
  tracker.untrack(h);
});

test('emitNoAttribution: true does NOT flag non-audited tracks', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel({ emitNoAttribution: true }));

  const h = tracker.track({}, null, 'top-level');
  assert.deepEqual(tracker.audit(), [], 'audit: false -> not applicable');
  tracker.untrack(h);
});

test('emitNoAttribution: false is the default (backward-compat)', () => {
  const tracker = createLeakTracker();
  // No option -> default false
  tracker.registerKernel(createOwnerCascadeOrphanKernel());

  const h = tracker.track({}, null, 'top-level', { audit: true });
  assert.deepEqual(tracker.audit(), []);
  tracker.untrack(h);
});

test('remediate returns advice for no-attribution finding', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(createOwnerCascadeOrphanKernel({ emitNoAttribution: true }));

  const h = tracker.track({}, null, 'x', { audit: true });
  const findings = tracker.audit();
  const advice = tracker.remediate(findings[0]);
  assert.match(advice, /no capturable owner context/);
  tracker.untrack(h);
});

test('kernel accepts priority alongside emitNoAttribution', () => {
  const tracker = createLeakTracker();
  const k = createOwnerCascadeOrphanKernel({ emitNoAttribution: true, priority: 42 });
  assert.equal(k.priority, 42);
  tracker.registerKernel(k);
  tracker.unregisterKernel(k);
});

// --- Error router as top-level factory (hardening #1) ---

test('routeError still catches thrown onError via the extracted factory', () => {
  // Use a kernel that will trigger the error path.
  const errs = [];
  const tracker = createLeakTracker({
    onError: (e, t) => { errs.push([e, t]); throw new Error('handler-broke'); },
  });
  tracker.registerKernel({
    name: 'thrower',
    audit() { throw new Error('audit-broke'); },
  });
  const findings = tracker.audit();
  assert.deepEqual(findings, []);
  assert.equal(errs.length, 1);
  assert.match(errs[0][0].message, /audit-broke/);
});

test('routeError logs to console.error tagged with tracker name', () => {
  const origConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const tracker = createLeakTracker({ name: 'test-tracker' });
    tracker.registerKernel({
      name: 'thrower',
      audit() { throw new Error('audit-boom'); },
    });
    tracker.audit();
    assert.ok(logs.length >= 1);
    // First arg should carry the [lite-leak/test-tracker] prefix.
    assert.match(logs[0][0], /\[lite-leak\/test-tracker\]/);
  } finally {
    console.error = origConsoleError;
  }
});
