import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeakTracker, groupFindings } from '../Leak.js';
import { createTimerOrphanKernel } from '../kernels/TimerOrphan.js';

/**
 * Timer host whose callbacks never fire, so registrations stay pending.
 * Ids must be unique -- the kernel keys its registry by id, so a host that
 * returns a constant would silently keep only one registration.
 */
function makeTimerHost() {
  let seq = 0;
  return { setTimeout: function () { return ++seq; }, clearTimeout: function () {} };
}

const F = (kind, reason, origin) => ({ kind, reason, origin: origin || null });

// --- Grouping ---

test('identical findings collapse into one group with a count', () => {
  const groups = groupFindings([
    F('listener-orphan', 'no-owner-add'),
    F('listener-orphan', 'no-owner-add'),
    F('listener-orphan', 'no-owner-add'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].kind, 'listener-orphan');
  assert.equal(groups[0].reason, 'no-owner-add');
});

test('different kinds and reasons stay separate', () => {
  const groups = groupFindings([
    F('listener-orphan', 'no-owner-add'),
    F('listener-orphan', 'owner-disposed-listener-live'),
    F('timer-orphan', 'no-owner-add'),
  ]);
  assert.equal(groups.length, 3);
  for (const g of groups) assert.equal(g.count, 1);
});

test('the representative is the first occurrence, not the last', () => {
  const first = F('timer-orphan', 'no-owner-pending');
  first.marker = 'first';
  const second = F('timer-orphan', 'no-owner-pending');
  second.marker = 'second';

  const groups = groupFindings([first, second]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].representative.marker, 'first');
  assert.equal(groups[0].representative, first, 'representative is the finding itself');
});

test('an empty findings array groups to nothing', () => {
  assert.deepEqual(groupFindings([]), []);
});

// --- Origin splitting ---

test('the same reason from two call sites forms two groups', () => {
  const groups = groupFindings([
    F('timer-orphan', 'no-owner-pending', 'at siteA (file.js:10:5)'),
    F('timer-orphan', 'no-owner-pending', 'at siteA (file.js:10:5)'),
    F('timer-orphan', 'no-owner-pending', 'at siteB (file.js:99:3)'),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2, 'ordered by count descending');
  assert.equal(groups[1].count, 1);
  assert.notEqual(groups[0].key, groups[1].key, 'distinct call sites get distinct keys');
});

test('byOrigin:false collapses call sites into one group', () => {
  const groups = groupFindings([
    F('timer-orphan', 'no-owner-pending', 'at siteA'),
    F('timer-orphan', 'no-owner-pending', 'at siteB'),
  ], { byOrigin: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].origin, null, 'a collapsed group claims no single origin');
});

test('an absent origin does not split groups', () => {
  // captureStacks off is the default, so origin is null everywhere.
  const groups = groupFindings([
    F('timer-orphan', 'no-owner-pending'),
    F('timer-orphan', 'no-owner-pending'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});

test('an empty-string origin is treated as absent', () => {
  const groups = groupFindings([
    F('timer-orphan', 'no-owner-pending', ''),
    F('timer-orphan', 'no-owner-pending'),
  ]);
  assert.equal(groups.length, 1, 'an empty stack is not a distinct call site');
});

// --- Determinism ---

test('group order and keys are stable across runs', () => {
  const input = [
    F('a-kernel', 'r1'), F('b-kernel', 'r2'), F('b-kernel', 'r2'),
    F('c-kernel', 'r3'), F('a-kernel', 'r1'), F('c-kernel', 'r3'),
  ];
  const first = groupFindings(input).map((g) => g.key + '=' + g.count);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(groupFindings(input).map((g) => g.key + '=' + g.count), first);
  }
});

test('ties break on key, not on input order', () => {
  // Equal counts must not let input ordering shuffle a CI diff.
  const forward = groupFindings([F('z-kernel', 'r'), F('a-kernel', 'r')]);
  const reverse = groupFindings([F('a-kernel', 'r'), F('z-kernel', 'r')]);
  assert.deepEqual(forward.map((g) => g.key), reverse.map((g) => g.key));
  assert.equal(forward[0].kind, 'a-kernel', 'sorted by key ascending on a tie');
});

test('the same origin always hashes to the same key', () => {
  const origin = 'at renderLoop (app.js:42:7)';
  const a = groupFindings([F('k', 'r', origin)])[0].key;
  const b = groupFindings([F('k', 'r', origin)])[0].key;
  assert.equal(a, b);
  assert.match(a, /^k:r:[0-9a-z]+$/, 'key is kind:reason:hash');
});

// --- Robustness: a reporting helper must never throw on kernel output ---

test('malformed findings are skipped rather than thrown on', () => {
  const groups = groupFindings([
    null, undefined, 42, 'string',
    F('real-kernel', 'real-reason'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'real-kernel');
});

test('findings missing kind or reason fall back to "unknown"', () => {
  const groups = groupFindings([{}, { kind: 'k' }, { reason: 'r' }]);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['k:unknown', 'unknown:r', 'unknown:unknown']);
});

test('groupFindings validates its own input fail-closed', () => {
  assert.throws(() => groupFindings('not-an-array'), /findings must be an array/);
  assert.throws(() => groupFindings(null), /findings must be an array/);
  assert.throws(() => groupFindings([], { byOrigins: true }),
    /unknown option "byOrigins".*did you mean "byOrigin"/);
});

// --- Ordering contract ---

test('groups are ordered by count descending', () => {
  const findings = [];
  for (let i = 0; i < 5; i++) findings.push(F('few', 'r'));
  for (let i = 0; i < 50; i++) findings.push(F('many', 'r'));
  for (let i = 0; i < 20; i++) findings.push(F('some', 'r'));

  const groups = groupFindings(findings);
  assert.deepEqual(groups.map((g) => g.count), [50, 20, 5]);
  assert.equal(groups[0].kind, 'many');
});

test('no severity field is invented', () => {
  // Ranking a broken cascade against a never-owned resource would be an
  // unfalsifiable claim. Count is a frequency signal and nothing more.
  const g = groupFindings([F('k', 'r')])[0];
  assert.equal(g.severity, undefined);
  assert.deepEqual(Object.keys(g).sort(),
    ['count', 'key', 'kind', 'origin', 'reason', 'representative']);
});

// --- tracker.auditGrouped ---

test('auditGrouped collapses a real audit', () => {
  const host = makeTimerHost();
  const tracker = createLeakTracker({ onWarning() {} });
  const kernel = createTimerOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  for (let i = 0; i < 400; i++) host.setTimeout(function () {}, 1000);

  const flat = tracker.audit();
  assert.equal(flat.length, 400, 'the flat audit is unreadable at this scale');

  const groups = tracker.auditGrouped();
  assert.equal(groups.length, 1, '400 findings collapse to one cluster');
  assert.equal(groups[0].count, 400);
  assert.equal(groups[0].kind, 'timer-orphan');
  assert.ok(groups[0].representative, 'a representative finding is kept');
  tracker.unregisterKernel(kernel);
});

test('auditGrouped forwards its options', () => {
  const host = makeTimerHost();
  const tracker = createLeakTracker({ onWarning() {} });
  const kernel = createTimerOrphanKernel({
    target: host, warnOnNoOwner: false, captureStacks: true,
  });
  tracker.registerKernel(kernel);

  function siteA() { host.setTimeout(function () {}, 1000); }
  function siteB() { host.setTimeout(function () {}, 1000); }
  siteA(); siteA(); siteB();

  const split = tracker.auditGrouped();
  assert.ok(split.length >= 2, 'distinct call sites split with captureStacks on');

  const merged = tracker.auditGrouped({ byOrigin: false });
  assert.equal(merged.length, 1, 'byOrigin:false merges them');
  assert.equal(merged[0].count, 3);
  tracker.unregisterKernel(kernel);
});

test('auditGrouped on a clean tracker returns an empty array', () => {
  const tracker = createLeakTracker();
  assert.deepEqual(tracker.auditGrouped(), []);
});

test('auditGrouped validates options fail-closed', () => {
  const tracker = createLeakTracker();
  assert.throws(() => tracker.auditGrouped({ byOrigins: false }), /unknown option/);
});
