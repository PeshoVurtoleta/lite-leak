/**
 * Torture / adversarial regression suite for @zakkster/lite-leak.
 *
 * Each test pins a defect found during the v1.1.0 prepublish review, or an
 * invariant that held under attack and must not regress.
 *
 * Notes for anyone extending this file:
 *
 *  - THE ITERATION TEST MUST BE BOUNDED. On v1.1.0 the audited-handle walk did
 *    not terminate when a kernel tracked from inside it, so an unbounded
 *    assertion would hang the runner instead of failing it. The callback counts
 *    and throws past a ceiling; a hang becomes a fast, readable failure.
 *
 *  - PATCH TESTS USE A LOCAL TARGET, never globalThis or EventTarget.prototype.
 *    Kernels claim surfaces per target for the lifetime of the process, and the
 *    existing suite installs kernels without uninstalling them, so touching a
 *    global here would leak state into unrelated tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker, KernelConflictError, VERSION } from '../Leak.js';
import { createTimerOrphanKernel } from '../kernels/TimerOrphan.js';
import { tryForceCollect, delay, GC_AVAILABLE } from './_helpers/gc.js';
import { effect, dispose as disposeNode } from '@zakkster/lite-signal';

const withOwner = (fn) => { let r; const e = effect(() => { r = fn(); }); return { r, dispose: () => disposeNode(e) }; };

/** A timer host with named originals, so restore can be checked by identity. */
function makeHost() {
  return {
    setTimeout: function originalSetTimeout(cb, ms) { return 't' + ms; },
    clearTimeout: function originalClearTimeout() {},
    setInterval: function originalSetInterval() { return 'iv'; },
    clearInterval: function originalClearInterval() {},
  };
}

/* ── 1. Audited-handle iteration must terminate ───────────────────────────── */

test('forEachAuditedHandle terminates when a kernel tracks during the walk', () => {
  // A Set iterator visits entries added mid-iteration, so the reasonable
  // "found something suspicious, watch it too" kernel pattern fed its own walk
  // and never returned. Bounded here so the v1.1.0 behaviour fails fast
  // instead of hanging the runner.
  const CEILING = 500;
  const tracker = createLeakTracker({ name: 'iter' });
  const held = [];
  for (let i = 0; i < 5; i++) { const t = { i }; held.push(t); tracker.track(t, () => {}, 'seed', { audit: true }); }

  let visits = 0;
  let runaway = false;
  tracker.registerKernel({
    name: 'grower',
    install(ctx) { this._ctx = ctx; },
    audit() {
      this._ctx.forEachAuditedHandle(() => {
        visits++;
        if (visits > CEILING) { runaway = true; throw new Error('runaway'); }
        const t = { n: visits }; held.push(t);
        this._ctx.track(t, () => {}, 'grown', { audit: true });
      });
      return [];
    },
  });
  tracker.audit();
  assert.equal(runaway, false, 'the walk never terminated — it consumed handles it created');
  assert.equal(visits, 5, 'a pass should see exactly the records that existed when it started');
});

test('handles added during a walk are visited on the NEXT pass', () => {
  const tracker = createLeakTracker({ name: 'iter2' });
  const held = [];
  for (let i = 0; i < 3; i++) { const t = { i }; held.push(t); tracker.track(t, () => {}, 's', { audit: true }); }
  let pass = 0;
  const counts = [];
  tracker.registerKernel({
    name: 'grow-once',
    install(ctx) { this._ctx = ctx; },
    audit() {
      let n = 0;
      this._ctx.forEachAuditedHandle(() => {
        n++;
        if (pass === 0 && n === 1) {
          const t = { late: true }; held.push(t);
          this._ctx.track(t, () => {}, 'late', { audit: true });
        }
      });
      counts.push(n);
      pass++;
      return [];
    },
  });
  tracker.audit();
  tracker.audit();
  assert.equal(counts[0], 3, 'first pass must be bounded to the pre-existing records');
  assert.equal(counts[1], 4, 'the record added mid-walk must show up on the next pass');
});

test('untracking during a walk does not revisit stale records', () => {
  const tracker = createLeakTracker({ name: 'iter3' });
  const held = [];
  for (let i = 0; i < 10; i++) { const t = { i }; held.push(t); tracker.track(t, () => {}, 's', { audit: true }); }
  let visits = 0;
  tracker.registerKernel({
    name: 'reaper',
    install(ctx) { this._ctx = ctx; },
    audit() { this._ctx.forEachAuditedHandle((h) => { visits++; this._ctx.untrack(h); }); return []; },
  });
  tracker.audit();
  assert.equal(visits, 10);
  visits = 0;
  tracker.audit();
  assert.equal(visits, 0, 'reaped records were walked again');
});

/* ── 2. Patch layering ────────────────────────────────────────────────────── */

test('uninstall does not clobber a wrapper installed over ours', () => {
  // A blind `target.setTimeout = original` silently un-instruments any APM
  // agent, test framework or second diagnostic that wrapped us afterwards.
  const host = makeHost();
  const tracker = createLeakTracker({ name: 'layer' });
  const un = tracker.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));

  const kernelWrapper = host.setTimeout;
  let outerCalls = 0;
  host.setTimeout = function outerWrapper(cb, ms) { outerCalls++; return kernelWrapper.call(this, cb, ms); };

  un();
  assert.equal(host.setTimeout.name, 'outerWrapper', 'the outer wrapper was destroyed by uninstall');
  host.setTimeout(() => {}, 5);
  assert.equal(outerCalls, 1, 'the outer wrapper is installed but no longer reached');
});

test('a wrapper left in place still works after uninstall', () => {
  // Regression on the fix itself: declining to restore leaves our wrapper
  // reachable, so it must keep delegating. Nulling the captured originals
  // turned every later call into a TypeError and every clear into a no-op.
  const host = makeHost();
  const tracker = createLeakTracker({ name: 'layer2' });
  const un = tracker.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  const kernelWrapper = host.setTimeout;
  host.setTimeout = function outerWrapper(cb, ms) { return kernelWrapper.call(this, cb, ms); };
  un();
  let id;
  assert.doesNotThrow(() => { id = host.setTimeout(() => {}, 7); }, 'orphaned wrapper threw after uninstall');
  assert.equal(id, 't7', 'the orphaned wrapper stopped delegating to the original');
  assert.doesNotThrow(() => host.clearTimeout(id), 'clear path broke after uninstall');
});

test('uninstall DOES restore when the slot is still ours', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ name: 'layer3' });
  const un = tracker.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  assert.notEqual(host.setTimeout.name, 'originalSetTimeout', 'install did not patch');
  un();
  assert.equal(host.setTimeout.name, 'originalSetTimeout', 'uninstall failed to restore');
  assert.equal(host.clearTimeout.name, 'originalClearTimeout');
  assert.equal(host.setInterval.name, 'originalSetInterval');
});

test('a second kernel on the same target is reported, not silent', () => {
  // registerKernel's patchSurfaces guard is per-tracker, so two trackers could
  // both wrap one target with nothing said. Surfaced through onFinding, which
  // Leak.js documents as the install-time-detection channel; onWarning is
  // reserved for live per-event anomalies and must stay uncontaminated.
  const host = makeHost();
  const findings = [];
  const warnings = [];
  const t1 = createLeakTracker({ name: 'A' });
  const t2 = createLeakTracker({ name: 'B', onFinding: (f) => findings.push(f), onWarning: (w) => warnings.push(w) });
  const un1 = t1.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  const un2 = t2.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));

  const doubled = findings.filter((f) => f.reason === 'patch-double-install');
  assert.ok(doubled.length > 0, 'a double patch of the same target went unreported');
  assert.ok(doubled[0].surfaces.includes('setTimeout'));
  assert.equal(warnings.length, 0, 'install-time conditions must not pollute the warning stream');
  un2(); un1();
});

test('a claimed surface is released on uninstall', () => {
  const host = makeHost();
  const findings = [];
  const t1 = createLeakTracker({ name: 'C' });
  const un1 = t1.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  un1();
  const t2 = createLeakTracker({ name: 'D', onFinding: (f) => findings.push(f) });
  const un2 = t2.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0,
    'a released surface was still reported as claimed');
  un2();
});

test('the timer wrapper stays transparent', () => {
  const seen = [];
  const host = {
    setTimeout(cb, ms, ...extra) { this._last = { cb, extra }; return 'ID:' + ms; },
    clearTimeout() {}, setInterval() { return 'iv'; }, clearInterval() {},
  };
  const tracker = createLeakTracker({ name: 'transparent' });
  const un = tracker.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  const ret = host.setTimeout(function (...args) { seen.push({ this_: this, args }); }, 42, 'a', 'b');
  assert.equal(ret, 'ID:42', 'return value was not passed through');
  assert.deepEqual(host._last.extra, ['a', 'b'], 'extra arguments were dropped');
  host._last.cb.call({ marker: 1 }, 'x', 'y');
  assert.deepEqual(seen[0].args, ['x', 'y'], 'callback arguments were not forwarded');
  assert.deepEqual(seen[0].this_, { marker: 1 }, '`this` was not preserved');
  un();
});

test('cancelling an id the kernel never issued is inert', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ name: 'foreign' });
  const un = tracker.registerKernel(createTimerOrphanKernel({ target: host, handleRaf: false }));
  for (const bad of [99999, null, undefined, 'nope', {}]) {
    assert.doesNotThrow(() => host.clearTimeout(bad), `clearTimeout(${String(bad)}) threw`);
  }
  un();
});

/* ── 3. Version / packaging ───────────────────────────────────────────────── */

test('VERSION is not left behind by a release bump', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'Leak.js VERSION drifted from package.json');
});

/* ── 4. Detection invariants that held — guard against regression ─────────── */

test('kernel lifecycle: conflicts, rollback, re-registration', () => {
  const tracker = createLeakTracker({ name: 'life' });
  tracker.registerKernel({ name: 'a', patchSurfaces: ['s'], install() {} });
  assert.throws(() => tracker.registerKernel({ name: 'a' }), KernelConflictError);
  assert.throws(() => tracker.registerKernel({ name: 'b', patchSurfaces: ['s'], install() {} }), KernelConflictError);
  assert.throws(() => tracker.registerKernel({
    name: 'c', patchSurfaces: ['r'], install() { throw new Error('install failed'); },
  }), /install failed/);
  // A failed install must roll its claims back so a retry can succeed.
  assert.doesNotThrow(() => tracker.registerKernel({ name: 'c', patchSurfaces: ['r'], install() {} }));
});

test('auto-untrack: disposing the owner deregisters everything it tracked', () => {
  const tracker = createLeakTracker({ name: 'auto' });
  const held = [];
  const o = withOwner(() => { for (let i = 0; i < 50; i++) { const t = { i }; held.push(t); tracker.track(t, () => {}, 'o'); } });
  assert.equal(tracker.size(), 50);
  o.dispose();
  assert.equal(tracker.size(), 0, 'owner disposal left handles registered');
});

test('refine chain: priority order, first non-null wins, errors isolated', { skip: !GC_AVAILABLE }, async () => {
  const order = [];
  const kinds = [];
  const errors = [];
  const tracker = createLeakTracker({
    name: 'chain',
    onLeak: (r) => kinds.push(r.kind),
    onError: (e) => errors.push(e.message),
  });
  tracker.registerKernel({ name: 'boom', priority: 20, refine() { order.push('boom'); throw new Error('kernel exploded'); } });
  tracker.registerKernel({ name: 'low', priority: 0, refine(rep) { order.push('low'); return { ...rep, kind: 'low' }; } });
  tracker.registerKernel({ name: 'mid', priority: 5, refine(rep) { order.push('mid'); return { ...rep, kind: 'mid' }; } });
  (function () { tracker.track({ x: 1 }, () => {}, 'chain'); })();
  await tryForceCollect(10, 10);
  await delay(50);
  assert.deepEqual(order, ['boom', 'mid'], 'refine order or short-circuit changed');
  assert.deepEqual(kinds, ['mid'], 'a throwing kernel broke the chain');
  assert.equal(errors.length, 1, 'the kernel error was not routed');
});

test('no false positives: untracked and auto-untracked drops stay silent', { skip: !GC_AVAILABLE }, async () => {
  const leaks = [];
  const tracker = createLeakTracker({ name: 'fp', onLeak: (r) => leaks.push(r) });
  (function () {
    for (let i = 0; i < 20; i++) tracker.untrack(tracker.track({ i }, () => {}, 'u' + i));
  })();
  const o = withOwner(() => { for (let i = 0; i < 20; i++) tracker.track({ i }, () => {}, 'o' + i); });
  o.dispose();
  await tryForceCollect(10, 10);
  await delay(50);
  assert.equal(leaks.length, 0, 'reported a leak for something that was properly released');
});

test('a genuinely dropped target is reported, and the tracker never pins it', { skip: !GC_AVAILABLE }, async () => {
  const leaks = [];
  const tracker = createLeakTracker({ name: 'tp', onLeak: (r) => leaks.push(r) });
  let ref;
  (function () {
    const t = { big: new Array(500).fill(0) };
    ref = new WeakRef(t);
    tracker.track(t, () => {}, 'dropped');
  })();
  await tryForceCollect(10, 10);
  await delay(50);
  assert.equal(ref.deref(), undefined, 'the tracker holds a strong reference to its target');
  assert.equal(leaks.length, 1, 'a dropped target went unreported');
  assert.equal(leaks[0].kind, 'unknown', 'an unclassified leak should report kind "unknown"');
});

test('a throwing onLeak consumer does not stop later reports', { skip: !GC_AVAILABLE }, async () => {
  let calls = 0;
  const errors = [];
  const tracker = createLeakTracker({
    name: 'badconsumer',
    onError: (e) => errors.push(e.message),
    onLeak: () => { calls++; throw new Error('consumer exploded'); },
  });
  (function () { for (let i = 0; i < 5; i++) tracker.track({ i }, () => {}, 'c'); })();
  await tryForceCollect(10, 10);
  await delay(50);
  assert.equal(calls, 5, 'the tracker stopped reporting after a consumer threw');
  assert.equal(errors.length, 5, 'consumer errors were not routed to onError');
});
