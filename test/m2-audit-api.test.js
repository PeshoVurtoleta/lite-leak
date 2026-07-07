import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, getOwner } from '@zakkster/lite-signal';
import { createLeakTracker } from '../Leak.js';

// Minimal mock kernel that returns pre-canned findings from audit().
function makeMockKernel(name, findings, advice) {
  return {
    name,
    audit() { return findings; },
    advise(f) { return advice ? advice(f) : null; },
  };
}

// --- auditByKind ---

test('auditByKind filters findings by kind', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(makeMockKernel('a', [
    { kind: 'timer-orphan', tag: 'a1' },
    { kind: 'listener-orphan', tag: 'a2' },
    { kind: 'timer-orphan', tag: 'a3' },
  ]));
  const timers = tracker.auditByKind('timer-orphan');
  assert.equal(timers.length, 2);
  assert.deepEqual(timers.map((f) => f.tag), ['a1', 'a3']);

  const listeners = tracker.auditByKind('listener-orphan');
  assert.equal(listeners.length, 1);

  const nonExistent = tracker.auditByKind('nonexistent-orphan');
  assert.equal(nonExistent.length, 0);
});

test('auditByKind returns empty for no kernels', () => {
  const tracker = createLeakTracker();
  assert.deepEqual(tracker.auditByKind('anything'), []);
});

// --- auditByOwner ---

test('auditByOwner filters findings whose ownerPath contains the owner id', () => {
  let capturedOwner;
  const e = effect(() => {
    capturedOwner = getOwner();
  });
  const ownerId = capturedOwner.id;

  const tracker = createLeakTracker();
  tracker.registerKernel(makeMockKernel('a', [
    { kind: 'x', tag: 'match', ownerPath: [{ id: ownerId, kind: 'effect' }, { id: 999, kind: 'effect' }] },
    { kind: 'x', tag: 'nomatch', ownerPath: [{ id: 999, kind: 'effect' }] },
    { kind: 'x', tag: 'no-path' /* no ownerPath */ },
  ]));

  const findings = tracker.auditByOwner(capturedOwner);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tag, 'match');
  dispose(e);
});

test('auditByOwner returns empty for null/undefined handle', () => {
  const tracker = createLeakTracker();
  assert.deepEqual(tracker.auditByOwner(null), []);
  assert.deepEqual(tracker.auditByOwner(undefined), []);
});

test('auditByOwner returns empty when no findings match', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel(makeMockKernel('a', [
    { kind: 'x', ownerPath: [{ id: 111, kind: 'effect' }] },
  ]));
  const findings = tracker.auditByOwner({ id: 999, kind: 'effect' });
  assert.equal(findings.length, 0);
});

// --- remediate ---

test('remediate returns kernel advice for known finding', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel({
    name: 'k1',
    audit() { return []; },
    advise: (f) => f.kind === 'my-leak' ? 'my advice' : null,
  });
  const advice = tracker.remediate({ kind: 'my-leak' });
  assert.equal(advice, 'my advice');
});

test('remediate returns fallback when no kernel provides advice', () => {
  const tracker = createLeakTracker();
  const advice = tracker.remediate({ kind: 'unknown-kind' });
  assert.match(advice, /No kernel-provided remediation/);
});

test('remediate returns empty string for non-object finding', () => {
  const tracker = createLeakTracker();
  assert.equal(tracker.remediate(null), '');
  assert.equal(tracker.remediate('not-an-object'), '');
});

test('remediate walks kernels in priority order (first non-null wins)', () => {
  const tracker = createLeakTracker();
  tracker.registerKernel({
    name: 'generic',
    priority: 0,
    audit() { return []; },
    advise: () => 'generic advice',
  });
  tracker.registerKernel({
    name: 'specialised',
    priority: 10,
    audit() { return []; },
    advise: () => 'specialised advice',
  });
  const advice = tracker.remediate({ kind: 'anything' });
  assert.equal(advice, 'specialised advice');
});

test('remediate handles kernel throw gracefully via routeError', () => {
  const errs = [];
  const tracker = createLeakTracker({ onError: (e) => errs.push(e) });
  tracker.registerKernel({
    name: 'bad',
    audit() { return []; },
    advise: () => { throw new Error('advise-broke'); },
  });
  tracker.registerKernel({
    name: 'good',
    audit() { return []; },
    advise: () => 'good advice',
  });
  const advice = tracker.remediate({ kind: 'x' });
  assert.equal(advice, 'good advice');
  assert.equal(errs.length, 1);
});
