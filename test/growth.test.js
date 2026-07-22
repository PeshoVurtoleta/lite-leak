import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLeakTracker, diffSnapshots, createCollectionGrowthKernel,
  createTimerOrphanKernel, createListenerOrphanKernel,
} from '../Leak.js';

function makeHost() {
  let seq = 0;
  return {
    setTimeout: function () { return ++seq; }, clearTimeout: function () {},
    setInterval: function () { return ++seq; }, clearInterval: function () {},
    EventTarget: class EventTarget { addEventListener() {} removeEventListener() {} },
  };
}

// -----------------------------------------------------------------
// snapshot()
// -----------------------------------------------------------------

test('snapshot reports a count per registered kernel', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));

  const before = tracker.snapshot();
  assert.equal(before.byKind['timer-orphan'], 0);
  assert.equal(typeof before.at, 'number');
  assert.equal(before.tracked, 0);

  for (let i = 0; i < 5; i++) host.setTimeout(function () {}, 1000);
  assert.equal(tracker.snapshot().byKind['timer-orphan'], 5);
});

test('a kernel with no count() reports null, never zero', () => {
  // listener-orphan has no countable registry. Reporting 0 would be a claim
  // that it is watching nothing leak, which is a different fact from "cannot
  // say".
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  tracker.registerKernel(createListenerOrphanKernel({ target: host, warnOnNoOwner: false }));

  const snap = tracker.snapshot();
  assert.equal(snap.byKind['listener-orphan'], null);
  assert.notEqual(snap.byKind['listener-orphan'], 0);
});

test('snapshot emits nothing', () => {
  const host = makeHost();
  const events = [];
  const tracker = createLeakTracker({
    onWarning: () => events.push('w'), onFinding: () => events.push('f'),
  });
  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));
  host.setTimeout(function () {}, 1000);

  tracker.snapshot();
  tracker.snapshot();
  assert.deepEqual(events, [], 'snapshot is an observation, not an audit');
});

test('a kernel whose count() throws degrades to null and routes the error', () => {
  const errors = [];
  const tracker = createLeakTracker({ onError: (e) => errors.push(e) });
  tracker.registerKernel({
    name: 'boom', priority: 0, count() { throw new Error('count boom'); },
  });
  assert.equal(tracker.snapshot().byKind.boom, null);
  assert.equal(errors.length, 1);
});

test('a kernel returning junk from count() degrades to null', () => {
  const tracker = createLeakTracker();
  for (const [name, value] of [['nan', NaN], ['inf', Infinity], ['neg', -1],
    ['str', '5'], ['nul', null]]) {
    tracker.registerKernel({ name, priority: 0, count: () => value });
  }
  const snap = tracker.snapshot();
  for (const name of ['nan', 'inf', 'neg', 'str', 'nul']) {
    assert.equal(snap.byKind[name], null, name + ' must not be trusted as a number');
  }
});

// -----------------------------------------------------------------
// diffSnapshots()
// -----------------------------------------------------------------

test('diff reports the delta for measurable kinds', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));

  const before = tracker.snapshot();
  for (let i = 0; i < 7; i++) host.setTimeout(function () {}, 1000);
  const diff = diffSnapshots(before, tracker.snapshot());

  assert.equal(diff.byKind['timer-orphan'], 7);
  assert.equal(diff.measured, 1);
  assert.deepEqual(diff.unknown, []);
});

test('an unmeasurable kind diffs to null and is listed in unknown', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));
  tracker.registerKernel(createListenerOrphanKernel({ target: host, warnOnNoOwner: false }));

  const diff = diffSnapshots(tracker.snapshot(), tracker.snapshot());
  assert.equal(diff.byKind['listener-orphan'], null);
  assert.deepEqual(diff.unknown, ['listener-orphan']);
  assert.equal(diff.measured, 1, 'only the countable kernel was actually measured');
});

test('a kernel registered between snapshots is unknown, not a jump from zero', () => {
  // It was not at zero beforehand -- it was unobserved. Reporting +N would
  // manufacture a measurement that never happened.
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  const before = tracker.snapshot();

  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));
  for (let i = 0; i < 3; i++) host.setTimeout(function () {}, 1000);

  const diff = diffSnapshots(before, tracker.snapshot());
  assert.equal(diff.byKind['timer-orphan'], null);
  assert.ok(diff.unknown.includes('timer-orphan'));
});

test('a clean round trip diffs to zero', () => {
  const host = makeHost();
  const tracker = createLeakTracker({ onWarning() {} });
  tracker.registerKernel(createTimerOrphanKernel({ target: host, warnOnNoOwner: false }));

  const before = tracker.snapshot();
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(host.setTimeout(function () {}, 1000));
  for (const id of ids) host.clearTimeout(id);

  const diff = diffSnapshots(before, tracker.snapshot());
  assert.equal(diff.byKind['timer-orphan'], 0, 'armed and cleared nets to nothing');
});

test('diffSnapshots validates its arguments', () => {
  const tracker = createLeakTracker();
  const snap = tracker.snapshot();
  assert.throws(() => diffSnapshots(null, snap), /before must be a snapshot/);
  assert.throws(() => diffSnapshots(snap, {}), /after must be a snapshot/);
  assert.throws(() => diffSnapshots(snap, 'nope'), /after must be a snapshot/);
});

// -----------------------------------------------------------------
// collection-growth kernel
// -----------------------------------------------------------------

test('a monotonically growing collection is reported after minSamples', () => {
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({
    collections: { cache }, minSamples: 3, window: 5,
  }));

  cache.set('a', 1); assert.deepEqual(tracker.audit(), [], 'one sample proves nothing');
  cache.set('b', 2); assert.deepEqual(tracker.audit(), [], 'two samples prove nothing');
  cache.set('c', 3);
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'collection-growth');
  assert.equal(findings[0].reason, 'monotonic-growth');
  assert.equal(findings[0].collection, 'cache');
  assert.equal(findings[0].growth, 2);
});

test('a plateau clears the finding on its own', () => {
  // The window slides, so a cache that fills and settles stops being reported
  // without anyone resetting anything. This is what keeps warmup from being
  // permanently indicted.
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({
    collections: { cache }, minSamples: 3, window: 4,
  }));

  for (let i = 0; i < 5; i++) { cache.set('k' + i, i); tracker.audit(); }
  assert.equal(tracker.audit().length, 1, 'still growing');

  let last = 1;
  for (let i = 0; i < 6; i++) last = tracker.audit().length;
  assert.equal(last, 0, 'a plateaued cache stops being reported');
});

test('a collection that shrinks is never reported', () => {
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({
    collections: { cache }, minSamples: 3, window: 5,
  }));

  for (let i = 0; i < 5; i++) { cache.set('k' + i, i); tracker.audit(); }
  cache.delete('k0');
  tracker.audit();
  assert.deepEqual(tracker.audit(), [], 'a single eviction breaks monotonicity');
});

test('minGrowth suppresses trivial drift', () => {
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({
    collections: { cache }, minSamples: 3, window: 6, minGrowth: 10,
  }));

  for (let i = 0; i < 6; i++) { cache.set('k' + i, i); tracker.audit(); }
  assert.deepEqual(tracker.audit(), [], 'growth of 6 is below the threshold of 10');
});

test('several collections are tracked independently', () => {
  const growing = new Map();
  const stable = new Set(['x']);
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({
    collections: { growing, stable }, minSamples: 3, window: 5,
  }));

  for (let i = 0; i < 4; i++) { growing.set('k' + i, i); tracker.audit(); }
  const findings = tracker.audit();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].collection, 'growing');
});

test('arrays and sets are measurable, and count() totals them', () => {
  const list = [];
  const set = new Set();
  const tracker = createLeakTracker();
  const kernel = createCollectionGrowthKernel({ collections: { list, set } });
  tracker.registerKernel(kernel);

  list.push(1, 2, 3);
  set.add('a');
  assert.equal(kernel.count(), 4, 'count() sums every watched collection');
  assert.equal(tracker.snapshot().byKind['collection-growth'], 4);
});

test('snapshot around an interaction measures collection growth exactly', () => {
  // The heuristic is for continuous monitoring; two snapshots answer the CI
  // question without any heuristic at all.
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({ collections: { cache } }));

  const before = tracker.snapshot();
  for (let i = 0; i < 12; i++) cache.set('k' + i, i);
  const diff = diffSnapshots(before, tracker.snapshot());
  assert.equal(diff.byKind['collection-growth'], 12);
});

test('an unmeasurable collection is rejected at construction', () => {
  assert.throws(() => createCollectionGrowthKernel({ collections: { bad: {} } }),
    /exposes neither a numeric size nor length/);
  assert.throws(() => createCollectionGrowthKernel({ collections: { bad: null } }),
    /exposes neither a numeric size nor length/);
});

test('the kernel validates its own configuration fail-closed', () => {
  const cache = new Map();
  assert.throws(() => createCollectionGrowthKernel(), /collections is required/);
  assert.throws(() => createCollectionGrowthKernel({ collections: {} }),
    /collections is empty/);
  assert.throws(() => createCollectionGrowthKernel({ collection: { cache } }),
    /unknown option "collection"/);
  assert.throws(() => createCollectionGrowthKernel({ collections: { cache }, window: 1 }),
    /window must be a finite number >= 2/);
  assert.throws(() => createCollectionGrowthKernel({ collections: { cache }, window: NaN }),
    /window must be a finite number/);
  assert.throws(() => createCollectionGrowthKernel({
    collections: { cache }, window: 4, minSamples: 5,
  }), /cannot exceed window/);
});

test('remediate frames the finding as evidence, not proof', () => {
  const cache = new Map();
  const tracker = createLeakTracker();
  tracker.registerKernel(createCollectionGrowthKernel({ collections: { cache } }));
  const advice = tracker.remediate({
    kind: 'collection-growth', reason: 'monotonic-growth',
    collection: 'cache', from: 1, to: 9,
  });
  assert.match(advice, /evidence, not proof/);
  assert.match(advice, /plateau/);
});

test('sampling is bounded: the window never grows', () => {
  const cache = new Map();
  const tracker = createLeakTracker();
  const kernel = createCollectionGrowthKernel({
    collections: { cache }, window: 4, minSamples: 2,
  });
  tracker.registerKernel(kernel);

  for (let i = 0; i < 500; i++) { cache.set('k' + i, i); tracker.audit(); }
  assert.equal(kernel._samplesTaken().cache, 4,
    'a growth detector that accumulated samples forever would be its own leak');
});
