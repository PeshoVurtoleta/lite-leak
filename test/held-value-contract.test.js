import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker } from '../Leak.js';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function tryForceCollect() {
  if (!global.gc) return;
  for (let i = 0; i < 8; i++) { global.gc(); await delay(10); }
}

test('target becomes unreachable -> onLeak fires (cleanup MUST NOT close over target)', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    const target = { id: 'ephemeral' };
    // CORRECT: cleanup captures nothing that references target
    tracker.track(target, () => {}, 'ok');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].tag, 'ok');
});

test('tag MUST NOT capture target either (documented contract)', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    const target = { id: 'ephemeral' };
    // CORRECT: tag is a plain primitive, does not reference target
    const tag = 'element-id-42';
    tracker.track(target, () => {}, tag);
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].tag, 'element-id-42');
});

test('untrack before GC prevents leak report even for unreachable target', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  let handle;
  (function () {
    const target = { id: 'ephemeral' };
    handle = tracker.track(target, () => {}, 'x');
  })();

  tracker.untrack(handle);

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 0, 'explicit untrack canceled the FR');
});

test('multiple leaked targets each produce their own report', async (t) => {
  if (!global.gc) return t.skip('run with --expose-gc');
  const reports = [];
  const tracker = createLeakTracker({ onLeak: (r) => reports.push(r) });

  (function () {
    const a = {}, b = {}, c = {};
    tracker.track(a, () => {}, 'a');
    tracker.track(b, () => {}, 'b');
    tracker.track(c, () => {}, 'c');
  })();

  await tryForceCollect();
  await delay(20);

  assert.equal(reports.length, 3);
  const tags = reports.map((r) => r.tag).sort();
  assert.deepEqual(tags, ['a', 'b', 'c']);
});
