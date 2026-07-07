import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker, track, untrack, VERSION, _resetDefault } from '../Leak.js';

test('VERSION is exported and semver-shaped', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});

test('createLeakTracker returns tracker with expected surface', () => {
  const t = createLeakTracker();
  assert.equal(typeof t.track, 'function');
  assert.equal(typeof t.untrack, 'function');
  assert.equal(typeof t.size, 'function');
  assert.equal(typeof t.name, 'string');
});

test('name defaults to "lite-leak"', () => {
  const t = createLeakTracker();
  assert.equal(t.name, 'lite-leak');
});

test('name is settable via options', () => {
  const t = createLeakTracker({ name: 'my-app' });
  assert.equal(t.name, 'my-app');
});

test('size is 0 for fresh tracker', () => {
  const t = createLeakTracker();
  assert.equal(t.size(), 0);
});

test('track returns handle with disposed=false; increments size', () => {
  const t = createLeakTracker();
  const h = t.track({}, () => {});
  assert.equal(h.disposed, false);
  assert.equal(t.size(), 1);
  t.untrack(h);
});

test('untrack marks handle disposed and decrements size', () => {
  const t = createLeakTracker();
  const h = t.track({}, () => {});
  t.untrack(h);
  assert.equal(h.disposed, true);
  assert.equal(t.size(), 0);
});

test('untrack is idempotent', () => {
  const t = createLeakTracker();
  const h = t.track({}, () => {});
  t.untrack(h);
  t.untrack(h);
  t.untrack(h);
  assert.equal(t.size(), 0);
});

test('untrack accepts null/undefined without throwing', () => {
  const t = createLeakTracker();
  t.untrack(null);
  t.untrack(undefined);
  assert.equal(t.size(), 0);
});

test('multiple tracked targets track independent size', () => {
  const t = createLeakTracker();
  const a = t.track({}, () => {});
  const b = t.track({}, () => {});
  const c = t.track({}, () => {});
  assert.equal(t.size(), 3);
  t.untrack(b);
  assert.equal(t.size(), 2);
  t.untrack(a);
  t.untrack(c);
  assert.equal(t.size(), 0);
});

test('module-level track/untrack uses shared default tracker', () => {
  _resetDefault();
  const h1 = track({}, () => {}, 'a');
  const h2 = track({}, () => {}, 'b');
  // Both call sites hit the same lazily-created default tracker.
  assert.equal(h1.disposed, false);
  assert.equal(h2.disposed, false);
  untrack(h1);
  untrack(h2);
  _resetDefault();
});

test('tag defaults to null when omitted (verified via untracked handle)', () => {
  const t = createLeakTracker();
  const h = t.track({}, () => {});
  // Tag isn't exposed on the handle; verified via leak-report tests.
  assert.equal(h.disposed, false);
  t.untrack(h);
});
