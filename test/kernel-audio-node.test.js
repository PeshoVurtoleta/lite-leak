import test from 'node:test';
import assert from 'node:assert/strict';
import { effect, dispose, createRoot } from '@zakkster/lite-signal';
import { createLeakTracker, createAudioNodeKernel, KernelConflictError } from '../Leak.js';
import { makeAudioHost } from './_helpers/resources.js';

// --- Install / uninstall ---

test('install patches connect/disconnect; uninstall restores them', () => {
  const host = makeAudioHost();
  const proto = host.AudioNode.prototype;
  const origConnect = proto.connect;
  const origDisconnect = proto.disconnect;

  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);
  assert.notEqual(proto.connect, origConnect, 'connect patched');

  tracker.unregisterKernel(kernel);
  assert.equal(proto.connect, origConnect, 'connect restored');
  assert.equal(proto.disconnect, origDisconnect, 'disconnect restored');
});

test('two audio kernels on the same tracker collide on patch surfaces', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const a = createAudioNodeKernel({ target: host });
  const b = createAudioNodeKernel({ target: host });
  tracker.registerKernel(a);
  assert.throws(() => tracker.registerKernel(b), KernelConflictError);
  tracker.unregisterKernel(a);
});

// --- The hook is connect(), not construction ---

test('an unconnected node is inert and never tracked', () => {
  const host = makeAudioHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  host.makeGain();   // constructed, never connected
  assert.equal(kernel._liveCount(), 0, 'construction alone is not retention');
  assert.equal(warnings.length, 0);
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});

test('connecting inside an effect disconnects the node on dispose', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  let gain = null;
  const e = effect(() => {
    gain = host.makeGain();
    gain.connect(host.destination);
  });
  assert.equal(kernel._liveCount(), 1);
  assert.equal(gain.outputs.length, 1);

  dispose(e);
  assert.equal(gain.outputs.length, 0, 'auto-disconnected on owner disposal');
  assert.equal(kernel._liveCount(), 0);
  tracker.unregisterKernel(kernel);
});

test('connect() passes its arguments and return value through', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const gain = host.makeGain();
  const returned = gain.connect(host.destination);
  assert.equal(returned, host.destination, 'connect returns the destination');
  assert.equal(host._log.connects, 1);
  tracker.unregisterKernel(kernel);
});

// --- Partial vs full disconnect ---

test('full disconnect() reaps; partial disconnect(dest) does not', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const a = host.makeGain();
  const b = host.makeGain();
  const node = host.makeGain();
  node.connect(a);
  node.connect(b);
  assert.equal(kernel._liveCount(), 1);

  node.disconnect(a);
  assert.equal(kernel._liveCount(), 1, 'still audible through b -- keep tracking');

  node.disconnect();
  assert.equal(kernel._liveCount(), 0, 'full disconnect reaps');
  tracker.unregisterKernel(kernel);
});

test('re-connecting the same node does not double-track it', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const node = host.makeGain();
  node.connect(host.destination);
  node.connect(host.destination);
  node.connect(host.destination);
  assert.equal(kernel._liveCount(), 1);
  tracker.unregisterKernel(kernel);
});

// --- No-owner warning ---

test('connecting outside any owner warns once per node', () => {
  const host = makeAudioHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  const node = host.makeGain();
  node.connect(host.destination);
  node.connect(host.destination);
  assert.equal(warnings.length, 1, 'one warning for the node, not one per edge');
  assert.equal(warnings[0].kind, 'audio-node');
  assert.equal(warnings[0].reason, 'no-owner-connect');
  tracker.unregisterKernel(kernel);
});

test('createRoot detaches ownership: the warning still fires', () => {
  const host = makeAudioHost();
  const warnings = [];
  const tracker = createLeakTracker({ onWarning: (w) => warnings.push(w) });
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  createRoot(() => { host.makeGain().connect(host.destination); });
  assert.equal(warnings.length, 1);
  tracker.unregisterKernel(kernel);
});

// --- Sources ---

test('a source started and never stopped is reported', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const src = host.makeSource();
  src.connect(host.destination);
  src.start();

  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'source-started-not-stopped').length, 1);
  tracker.unregisterKernel(kernel);
});

test('a source that was stopped is not reported', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  const src = host.makeSource();
  src.connect(host.destination);
  src.start();
  src.stop();

  assert.equal(tracker.audit().filter((f) => f.reason === 'source-started-not-stopped').length, 0);
  tracker.unregisterKernel(kernel);
});

test('disposing the owner stops a playing source as well as disconnecting it', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  let src = null;
  const e = effect(() => {
    src = host.makeSource();
    src.connect(host.destination);
    src.start();
  });
  assert.equal(src.playing, true);

  dispose(e);
  assert.equal(src.playing, false, 'source silenced on disposal');
  assert.equal(src.outputs.length, 0, 'and disconnected');
  tracker.unregisterKernel(kernel);
});

test('trackSources:false leaves start/stop unpatched', () => {
  const host = makeAudioHost();
  const origStart = host.AudioScheduledSourceNode.prototype.start;
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, trackSources: false, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  assert.equal(host.AudioScheduledSourceNode.prototype.start, origStart, 'start not patched');
  assert.ok(!kernel.patchSurfaces.includes('AudioScheduledSourceNode.start'));

  const src = host.makeSource();
  src.connect(host.destination);
  src.start();
  assert.equal(tracker.audit().filter((f) => f.reason === 'source-started-not-stopped').length, 0);
  tracker.unregisterKernel(kernel);
});

// --- Audit ---

test('audit reports a connected node with no owner', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host, warnOnNoOwner: false });
  tracker.registerKernel(kernel);

  host.makeGain().connect(host.destination);
  const findings = tracker.audit();
  assert.equal(findings.filter((f) => f.reason === 'no-owner-node-connected').length, 1);
  tracker.unregisterKernel(kernel);
});

test('audit stays clean for a healthy owner-scoped graph', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  const e = effect(() => { host.makeGain().connect(host.destination); });
  assert.deepEqual(tracker.audit(), []);
  dispose(e);
  assert.deepEqual(tracker.audit(), []);
  tracker.unregisterKernel(kernel);
});

// --- refine / advise ---

test('refine classifies an audio-tagged record and ignores others', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  const kernel = createAudioNodeKernel({ target: host });
  tracker.registerKernel(kernel);

  assert.equal(kernel.refine({ tag: 'plain' }, { tag: 'plain' }), null);
  const tag = { kind: 'audio-node' };
  const refined = kernel.refine(
    { tag, ownerPath: null, origin: null, kind: 'unknown', collectedAt: 0 }, { tag }
  );
  assert.equal(refined.kind, 'audio-node');
  assert.equal(refined.wasDisconnected, false);
  tracker.unregisterKernel(kernel);
});

test('advise returns guidance per reason', () => {
  const host = makeAudioHost();
  const tracker = createLeakTracker();
  tracker.registerKernel(createAudioNodeKernel({ target: host }));
  for (const reason of ['no-owner-connect', 'no-owner-node-connected',
    'owner-disposed-node-connected', 'source-started-not-stopped']) {
    const advice = tracker.remediate({ kind: 'audio-node', reason });
    assert.equal(typeof advice, 'string');
    assert.ok(advice.length > 0, 'advice for ' + reason);
  }
});

test('claims are released on uninstall so a later install is clean', () => {
  const host = makeAudioHost();
  const t1 = createLeakTracker();
  const k1 = createAudioNodeKernel({ target: host });
  t1.registerKernel(k1);
  t1.unregisterKernel(k1);

  const findings = [];
  const t2 = createLeakTracker({ onFinding: (f) => findings.push(f) });
  const k2 = createAudioNodeKernel({ target: host });
  t2.registerKernel(k2);
  assert.equal(findings.filter((f) => f.reason === 'patch-double-install').length, 0);
  t2.unregisterKernel(k2);
});
