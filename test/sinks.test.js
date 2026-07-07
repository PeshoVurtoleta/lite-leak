import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLeakTracker,
  createTraceSink,
  createGenericSink,
} from '../Leak.js';

function makeMockTracer() {
  const calls = [];
  return {
    calls,
    begin(tag) { calls.push(['begin', tag]); },
    end() { calls.push(['end']); },
  };
}

// --- Trace sink ---

test('createTraceSink requires tracer option', () => {
  assert.throws(() => createTraceSink(), TypeError);
  assert.throws(() => createTraceSink({}), TypeError);
  assert.throws(() => createTraceSink({ tracer: undefined }), TypeError);
});

test('trace sink emits begin/end for onLeak', () => {
  const tracer = makeMockTracer();
  const sink = createTraceSink({ tracer });
  sink.onLeak({ kind: 'timer-orphan' });
  assert.deepEqual(tracer.calls, [
    ['begin', 'lite-leak/leak/timer-orphan'],
    ['end'],
  ]);
});

test('trace sink uses custom prefixes', () => {
  const tracer = makeMockTracer();
  const sink = createTraceSink({
    tracer,
    leakTagPrefix: 'my/leak',
    warningTagPrefix: 'my/warn',
    findingTagPrefix: 'my/find',
    errorTag: 'my/err',
  });
  sink.onLeak({ kind: 'a' });
  sink.onWarning({ kind: 'b' });
  sink.onFinding({ kind: 'c' });
  sink.onError(new Error('x'));
  assert.deepEqual(tracer.calls, [
    ['begin', 'my/leak/a'], ['end'],
    ['begin', 'my/warn/b'], ['end'],
    ['begin', 'my/find/c'], ['end'],
    ['begin', 'my/err'], ['end'],
  ]);
});

test('trace sink handles null/undefined kinds gracefully', () => {
  const tracer = makeMockTracer();
  const sink = createTraceSink({ tracer });
  sink.onLeak(null);
  sink.onLeak({});
  sink.onLeak({ kind: 42 }); // non-string
  assert.equal(tracer.calls.length, 6);
  for (let i = 0; i < 6; i += 2) {
    assert.match(tracer.calls[i][1], /unknown/);
  }
});

test('trace sink is safe against tracer without begin/end', () => {
  const sink = createTraceSink({ tracer: {} });
  // Should not throw
  sink.onLeak({ kind: 'x' });
  sink.onWarning({ kind: 'y' });
});

// --- Generic sink ---

test('generic sink dispatches to provided callbacks', () => {
  const events = [];
  const sink = createGenericSink({
    onLeak: (r) => events.push(['leak', r]),
    onWarning: (w) => events.push(['warn', w]),
    onFinding: (f) => events.push(['find', f]),
    onError: (e, t) => events.push(['err', t]),
  });
  sink.onLeak({ kind: 'a' });
  sink.onWarning({ kind: 'b' });
  sink.onFinding({ kind: 'c' });
  sink.onError(new Error('x'), 'tag');
  assert.equal(events.length, 4);
  assert.equal(events[0][0], 'leak');
  assert.equal(events[3][1], 'tag');
});

test('generic sink is a no-op when no callback is provided', () => {
  const sink = createGenericSink({});
  // Should not throw
  sink.onLeak({ kind: 'x' });
  sink.onWarning({ kind: 'y' });
  sink.onFinding({ kind: 'z' });
  sink.onError(new Error('e'), null);
});

test('generic sink swallows callback throws', () => {
  const sink = createGenericSink({
    onLeak: () => { throw new Error('boom'); },
  });
  // Should not throw
  sink.onLeak({ kind: 'x' });
});

// --- End-to-end integration ---

test('trace sink integrates with tracker end-to-end', () => {
  const tracer = makeMockTracer();
  const sink = createTraceSink({ tracer });
  const tracker = createLeakTracker({
    onLeak: sink.onLeak,
    onWarning: sink.onWarning,
    onFinding: sink.onFinding,
    onError: sink.onError,
  });

  // Register a mock kernel that emits a warning via ctx
  const kernel = {
    name: 'test-mock',
    install(ctx) {
      ctx.emitWarning({ kind: 'test-mock-warning' });
      ctx.emitFinding({ kind: 'test-mock-finding' });
    },
    audit() { return []; },
  };
  tracker.registerKernel(kernel);

  assert.deepEqual(tracer.calls, [
    ['begin', 'lite-leak/warning/test-mock-warning'], ['end'],
    ['begin', 'lite-leak/finding/test-mock-finding'], ['end'],
  ]);
});

test('composing two sinks via generic wrapper', () => {
  const traceCalls = [];
  const otherEvents = [];
  const trace = createTraceSink({
    tracer: { begin: (t) => traceCalls.push(t), end: () => {} },
  });
  const other = createGenericSink({
    onLeak: (r) => otherEvents.push(r.kind),
  });
  const combined = {
    onLeak: (r) => { trace.onLeak(r); other.onLeak(r); },
    onWarning: trace.onWarning,
    onFinding: trace.onFinding,
    onError: trace.onError,
  };
  combined.onLeak({ kind: 'test-kind' });
  assert.deepEqual(traceCalls, ['lite-leak/leak/test-kind']);
  assert.deepEqual(otherEvents, ['test-kind']);
});
