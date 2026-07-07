import './_helpers/dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose } from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createProfilerSignalSink,
  createStudioSink,
  createTimerOrphanKernel,
} from '../Leak.js';

// --- ProfilerSignalSink ---

test('createProfilerSignalSink initial state', () => {
  const sink = createProfilerSignalSink();
  assert.equal(sink.leakCount(), 0);
  assert.equal(sink.warningCount(), 0);
  assert.equal(sink.findingCount(), 0);
  assert.equal(sink.errorCount(), 0);
  assert.equal(sink.lastLeakKind(), null);
  assert.equal(sink.lastWarningKind(), null);
  sink.dispose();
});

test('onLeak increments leakCount and updates lastLeakKind', () => {
  const sink = createProfilerSignalSink();
  sink.onLeak({ kind: 'timer-orphan' });
  assert.equal(sink.leakCount(), 1);
  assert.equal(sink.lastLeakKind(), 'timer-orphan');
  sink.onLeak({ kind: 'listener-orphan' });
  assert.equal(sink.leakCount(), 2);
  assert.equal(sink.lastLeakKind(), 'listener-orphan');
  sink.dispose();
});

test('all four channels increment their counters', () => {
  const sink = createProfilerSignalSink();
  sink.onLeak({ kind: 'a' });
  sink.onWarning({ kind: 'b' });
  sink.onFinding({ kind: 'c' });
  sink.onError(new Error('e'), null);
  assert.equal(sink.leakCount(), 1);
  assert.equal(sink.warningCount(), 1);
  assert.equal(sink.findingCount(), 1);
  assert.equal(sink.errorCount(), 1);
  sink.dispose();
});

test('signals drive effect re-runs', () => {
  const sink = createProfilerSignalSink();
  let runs = 0;
  const e = effect(() => { sink.leakCount(); runs++; });
  const initial = runs;
  sink.onLeak({ kind: 'x' });
  sink.onLeak({ kind: 'y' });
  assert.ok(runs > initial, 'effect re-ran on signal writes');
  dispose(e);
  sink.dispose();
});

test('leak + lastLeakKind writes are batched (one effect run per event)', () => {
  const sink = createProfilerSignalSink();
  let runs = 0;
  const e = effect(() => { sink.leakCount(); sink.lastLeakKind(); runs++; });
  const initial = runs;
  sink.onLeak({ kind: 'foo' });
  // Should have re-run exactly once even though 2 signals changed.
  assert.equal(runs, initial + 1);
  dispose(e);
  sink.dispose();
});

test('reset() zeros counters and clears last-kind signals', () => {
  const sink = createProfilerSignalSink();
  sink.onLeak({ kind: 'x' });
  sink.onWarning({ kind: 'y' });
  sink.onFinding({ kind: 'z' });
  sink.onError(new Error('e'));
  sink.reset();
  assert.equal(sink.leakCount(), 0);
  assert.equal(sink.warningCount(), 0);
  assert.equal(sink.findingCount(), 0);
  assert.equal(sink.errorCount(), 0);
  assert.equal(sink.lastLeakKind(), null);
  assert.equal(sink.lastWarningKind(), null);
  sink.dispose();
});

test('dispose() blocks further writes', () => {
  const sink = createProfilerSignalSink();
  sink.onLeak({ kind: 'a' });
  sink.dispose();
  sink.onLeak({ kind: 'b' });
  assert.equal(sink.leakCount(), 1, 'no further increment after dispose');
});

test('dispose() is idempotent', () => {
  const sink = createProfilerSignalSink();
  sink.dispose();
  sink.dispose();
  sink.dispose();
});

test('null/missing kinds default to "unknown"', () => {
  const sink = createProfilerSignalSink();
  sink.onLeak(null);
  sink.onLeak({});
  sink.onLeak({ kind: 42 }); // non-string
  assert.equal(sink.lastLeakKind(), 'unknown');
  sink.dispose();
});

// --- StudioSink ---

test('createStudioSink mounts by default', () => {
  const sink = createStudioSink();
  assert.equal(sink._isMounted(), true);
  sink.dispose();
});

test('createStudioSink({ mount: false }) does not mount at construction', () => {
  const sink = createStudioSink({ mount: false });
  assert.equal(sink._isMounted(), false);
  sink.mount();
  assert.equal(sink._isMounted(), true);
  sink.dispose();
});

test('onLeak / onWarning / onFinding / onError bump counters and rows', () => {
  const sink = createStudioSink();
  sink.onLeak({ kind: 'a' });
  sink.onWarning({ kind: 'b' });
  sink.onFinding({ kind: 'c' });
  sink.onError(new Error('boom'));
  const counts = sink._counts();
  assert.equal(counts.leaks, 1);
  assert.equal(counts.warnings, 1);
  assert.equal(counts.findings, 1);
  assert.equal(counts.errors, 1);
  assert.equal(sink._rowCount(), 4);
  sink.dispose();
});

test('log respects maxLogRows cap', () => {
  const sink = createStudioSink({ maxLogRows: 3 });
  for (let i = 0; i < 10; i++) sink.onLeak({ kind: 'x' });
  assert.equal(sink._rowCount(), 3, 'row count capped');
  sink.dispose();
});

test('unmount() removes overlay from DOM', () => {
  const sink = createStudioSink();
  assert.equal(sink._isMounted(), true);
  sink.unmount();
  assert.equal(sink._isMounted(), false);
  sink.dispose();
});

test('unmount() is idempotent', () => {
  const sink = createStudioSink();
  sink.unmount();
  sink.unmount();
  sink.unmount();
});

test('dispose() unmounts and blocks further writes', () => {
  const sink = createStudioSink();
  sink.onLeak({ kind: 'a' });
  sink.dispose();
  sink.onLeak({ kind: 'b' });
  assert.equal(sink._isMounted(), false);
  assert.equal(sink._counts().leaks, 1);
});

test('null/missing kinds default to "unknown"', () => {
  const sink = createStudioSink();
  sink.onLeak(null);
  sink.onLeak({});
  sink.onLeak({ kind: 42 });
  assert.equal(sink._counts().leaks, 3);
  sink.dispose();
});

test('style tag is injected exactly once even across multiple mounts', () => {
  const s1 = createStudioSink();
  const s2 = createStudioSink();
  const s3 = createStudioSink();
  const styles = document.querySelectorAll('#lite-leak-studio-style');
  assert.equal(styles.length, 1);
  s1.dispose(); s2.dispose(); s3.dispose();
});

// --- E2E integration ---

test('profiler-signal sink integrated with tracker sees kernel warnings', () => {
  const psink = createProfilerSignalSink();
  const target = Object.create(null);
  target.setTimeout = () => 1;
  target.clearTimeout = () => {};
  const tracker = createLeakTracker({
    onWarning: psink.onWarning,
  });
  tracker.registerKernel(createTimerOrphanKernel({ target }));
  target.setTimeout(() => {}, 100);
  assert.equal(psink.warningCount(), 1);
  assert.equal(psink.lastWarningKind(), 'timer-orphan');
  psink.dispose();
});

test('both sinks composed via generic fanout receive same event', () => {
  const psink = createProfilerSignalSink();
  const ssink = createStudioSink();
  const tracker = createLeakTracker({
    onWarning: (w) => { psink.onWarning(w); ssink.onWarning(w); },
  });
  const target = Object.create(null);
  target.setTimeout = () => 1;
  target.clearTimeout = () => {};
  tracker.registerKernel(createTimerOrphanKernel({ target }));
  target.setTimeout(() => {}, 100);
  assert.equal(psink.warningCount(), 1);
  assert.equal(ssink._counts().warnings, 1);
  psink.dispose();
  ssink.dispose();
});
