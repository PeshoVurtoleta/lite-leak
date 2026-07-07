import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker } from '../Leak.js';

test('4096 track/untrack cycles return size to 0', () => {
  const t = createLeakTracker();
  for (let i = 0; i < 4096; i++) {
    const h = t.track({}, () => {});
    t.untrack(h);
  }
  assert.equal(t.size(), 0);
});

test('2048 batched track then batched untrack', () => {
  const t = createLeakTracker();
  const handles = [];
  for (let i = 0; i < 2048; i++) {
    handles.push(t.track({}, () => {}));
  }
  assert.equal(t.size(), 2048);
  for (const h of handles) t.untrack(h);
  assert.equal(t.size(), 0);
});

test('1024 cycles with varied tag shapes do not leak size', () => {
  const t = createLeakTracker();
  for (let i = 0; i < 1024; i++) {
    const tag = i % 4 === 0 ? null
      : i % 4 === 1 ? 'string-' + i
      : i % 4 === 2 ? { obj: i }
      : i;
    const h = t.track({}, () => {}, tag);
    t.untrack(h);
  }
  assert.equal(t.size(), 0);
});

test('interleaved track/untrack across 4096 iterations stays consistent', () => {
  const t = createLeakTracker();
  const live = [];
  for (let i = 0; i < 4096; i++) {
    live.push(t.track({}, () => {}));
    if (live.length > 32) {
      const evict = live.shift();
      t.untrack(evict);
    }
  }
  assert.equal(t.size(), live.length);
  for (const h of live) t.untrack(h);
  assert.equal(t.size(), 0);
});
