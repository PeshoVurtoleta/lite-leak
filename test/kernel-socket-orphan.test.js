import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker, createSocketOrphanKernel, KernelConflictError } from '../Leak.js';
import { makeSocketHost } from './_helpers/resources.js';

// --- Install / uninstall ---

test('install patches WebSocket/EventSource; uninstall restores them', () => {
  const host = makeSocketHost();
  const origWS = host.WebSocket;
  const origES = host.EventSource;

  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);
  assert.notEqual(host.WebSocket, origWS, 'WebSocket patched');

  tracker.unregisterKernel(kernel);
  assert.equal(host.WebSocket, origWS, 'WebSocket restored');
  assert.equal(host.EventSource, origES, 'EventSource restored');
});

test('two socket kernels on the same tracker collide on patch surfaces', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const a = createSocketOrphanKernel({ target: host });
  const b = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- Owner-scoped lifecycle ---

test('a socket opened inside an effect is closed on dispose', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  let ws = null;
  const e = effect(() => { ws = new host.WebSocket('wss://example.test'); });
  assert.equal(ws.readyState, 1, 'open');
  assert.equal(kernel._liveCount(), 1);

  dispose(e);
  assert.equal(ws.readyState, 3, 'closed on owner disposal');
  assert.equal(host._log.closed, 1);
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('manual close() reaps the registration', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const ws = new host.WebSocket('wss://example.test');
  assert.equal(kernel._liveCount(), 1);
  ws.close();
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('an EventSource is tracked the same way', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const es = new host.EventSource('/stream');
  assert.equal(kernel._liveCount(), 1);
  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.socketKind === 'EventSource').length, 1);
  es.close();
  tracker.unregisterKernel(kernel);
});

// --- No-owner warning ---

test('a socket opened outside any owner warns once', () => {
  const host = makeSocketHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  new host.WebSocket('wss://example.test');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'socket-orphan');
  assert.equal(warnings[0].reason, 'no-owner-open');
  assert.equal(warnings[0].socketKind, 'WebSocket');
  tracker.unregisterKernel(kernel);
});

test('createRoot detaches ownership: the warning still fires', () => {
  const host = makeSocketHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  createRoot(() => { new host.WebSocket('wss://example.test'); });
  assert.equal(warnings.length, 1);
  tracker.unregisterKernel(kernel);
});

// --- Audit ---

test('audit reports an open socket with no owner', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  new host.WebSocket('wss://example.test');
  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'no-owner-socket-open').length, 1);
  tracker.unregisterKernel(kernel);
});

test('a socket the peer closed is not reported', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const ws = new host.WebSocket('wss://example.test');
  // Peer-initiated close: readyState flips without close() being called here.
  ws.readyState = 3;
  assert.deepEqual(tracker.audit(), [], 'a dead connection is not a leak');
  tracker.unregisterKernel(kernel);
});

test('audit stays clean for a healthy owner-scoped socket', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  const e = effect(() => { new host.WebSocket('wss://example.test'); });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});

// --- refine / advise ---

test('refine classifies a socket-tagged record and ignores others', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host });
  tracker.registerKernel(kernel);

  assert.equal(kernel.refine({ tag: 'plain' }, { tag: 'plain' }), null);
  const tag = { kind: 'socket', socketKind: 'WebSocket' };
  const refined = kernel.refine(
    { tag, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 }, { tag }
  );
  assert.equal(refined.kind, 'socket-orphan');
  assert.equal(refined.socketKind, 'WebSocket');
  assert.equal(refined.wasClosed, false);
  tracker.unregisterKernel(kernel);
});

test('advise returns guidance per reason', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  tracker.registerKernel(createSocketOrphanKernel({ target: host }));
  for (const reason of ['no-owner-open', 'no-owner-socket-open', 'owner-disposed-socket-open']) {
    const advice = tracker.remediate({ kind: 'socket-orphan', reason });
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0, 'advice for ' + reason);
  }
});

test('the constructor wrapper passes arguments through', () => {
  const host = makeSocketHost();
  const tracker = createLeakTracker();
  const kernel = createSocketOrphanKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const ws = new host.WebSocket('wss://example.test/path');
  assert.equal(ws.url, 'wss://example.test/path');
  assert.equal(host._log.opened, 1);
  tracker.unregisterKernel(kernel);
});

test('claims are released on uninstall so a later install is clean', () => {
  const host = makeSocketHost();
  const t1 = createLeakTracker();
  const k1 = createSocketOrphanKernel({ target: host });
  t1.registerKernel(k1);
  t1.unregisterKernel(k1);

  const findings = [];
  const t2 = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const k2 = createSocketOrphanKernel({ target: host });
  t2.registerKernel(k2);
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0);
  t2.unregisterKernel(k2);
});
