/**
 * PEER MATRIX -- owner-frame assumption contract.
 *
 * lite-leak reaches deep into lite-signal's owner tree: it snapshots
 * `{id, kind}` frames, treats `nodeId(handle) === undefined` as the
 * owner-disposed signal, relies on `onCleanup` cascade order for
 * auto-untrack, and assumes `createRoot` detaches owner attribution. Those
 * are lite-signal INTERNALS that happen to be observable; if a lite-signal
 * release changes any of them, leak attribution breaks silently on the
 * consumer side.
 *
 * This suite pins every such assumption. CI (`.github/workflows/peer-
 * matrix.yml`) runs it against each version in `peers.json` -- the 1.8.0
 * clean base and the latest rebuilt 1.9-1.12 prerelease -- on every release
 * of EITHER package. A lite-signal owner-tree change that would break leak
 * attribution fails HERE, before it ships there. This is the cheapest
 * insurance in the roadmap.
 *
 * Each test names the lite-leak code path it protects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effect,
  computed,
  signal,
  getOwner,
  ownerOf,
  onCleanup,
  nodeId,
  describe as describeOwner,
  dispose,
  createRoot,
} from '@zakkster/lite-signal';
import {
  createLeakTracker,
  createTimerOrphanKernel,
  createRafOrphanKernel,
  MAX_OWNER_WALK,
} from '../Leak.js';
import { installedSignalVersion } from './_helpers/peerVersion.js';
import { createMockRaf } from './_helpers/raf.js';

const PEER = installedSignalVersion();

test('peer matrix: running against @zakkster/lite-signal ' + PEER, () => {
  // Banner test -- always passes; surfaces the peer version in the TAP log
  // so a failing matrix cell is immediately attributable to a version.
  assert.ok(typeof PEER === 'string');
});

// -----------------------------------------------------------------
// Assumption 1: owner frame is a { id:number, kind:string } snapshot.
// Protects: snapshotOwnerPath() in Leak.js and OwnerFrame in Leak.d.ts.
// -----------------------------------------------------------------

test('[frame-shape] getOwner() inside an effect yields {id:number, kind:string}', () => {
  let frame = null;
  const e = effect(() => {
    const o = getOwner();
    frame = { id: o.id, kind: o.kind };
  });
  assert.equal(typeof frame.id, 'number', 'owner id is numeric');
  assert.equal(typeof frame.kind, 'string', 'owner kind is a string');
  assert.ok(frame.kind.length > 0, 'owner kind is non-empty');
  dispose(e);
});

test('[frame-shape] describe(owner) mirrors the {id, kind} snapshot', () => {
  let live = null;
  let desc = null;
  const e = effect(() => {
    const o = getOwner();
    live = { id: o.id, kind: o.kind };
    desc = describeOwner(o);
  });
  assert.deepEqual({ id: desc.id, kind: desc.kind }, live);
  dispose(e);
});

test('[frame-shape] computed owner reports kind "computed"', () => {
  const c = computed(() => {
    const o = getOwner();
    return o ? o.kind : null;
  });
  assert.equal(c(), 'computed');
});

// -----------------------------------------------------------------
// Assumption 2: ownerOf() walks child -> parent and terminates.
// Protects: snapshotOwnerPath()'s bounded walk; MAX_OWNER_WALK boundary.
// -----------------------------------------------------------------

test('[owner-walk] ownerOf() walks to a root and terminates', () => {
  let leaf = null;
  const e = effect(() => {
    // nested effect: child owner whose ownerOf() is the parent.
    effect(() => { leaf = getOwner(); });
  });
  assert.ok(leaf !== undefined && leaf !== null);
  let cursor = leaf;
  let hops = 0;
  while (cursor !== undefined && cursor !== null && hops < MAX_OWNER_WALK) {
    assert.equal(typeof cursor.id, 'number');
    cursor = ownerOf(cursor);
    hops++;
  }
  assert.ok(hops < MAX_OWNER_WALK, 'walk terminated well within the bound');
  assert.ok(hops >= 1, 'walk produced at least one frame');
  dispose(e);
});

// -----------------------------------------------------------------
// Assumption 3: nodeId(handle) is the liveness oracle.
//   live   -> number
//   posthumous -> undefined
// Protects: audit() in TimerOrphan / RafOrphan / ObserverOrphan, which use
// `nodeId(ownerHandle) === undefined` to mean "origin owner disposed".
// -----------------------------------------------------------------

test('[liveness] nodeId(handle) is numeric while live, undefined after dispose', () => {
  let handle = null;
  const e = effect(() => { handle = getOwner(); });
  assert.equal(typeof nodeId(handle), 'number', 'live owner -> numeric id');
  dispose(e);
  assert.equal(nodeId(handle), undefined, 'disposed owner -> undefined');
});

// -----------------------------------------------------------------
// Assumption 4: onCleanup cascade order.
//   effect re-run runs the PRIOR iteration's cleanups before the next run;
//   dispose runs the final iteration's cleanups.
// Protects: the auto-untrack contract -- track() wires
// onCleanup(() => registry.unregister(handle)); a re-run must reap the
// previous iteration's registration before the new one is created.
// -----------------------------------------------------------------

test('[cascade] onCleanup fires per-iteration on re-run and once on dispose', () => {
  const s = signal(0);
  const log = [];
  const e = effect(() => {
    const v = s();
    onCleanup(() => log.push('clean-' + v));
    log.push('run-' + v);
  });
  s.set(1);
  s.set(2);
  assert.deepEqual(log, ['run-0', 'clean-0', 'run-1', 'clean-1', 'run-2']);
  dispose(e);
  assert.deepEqual(
    log,
    ['run-0', 'clean-0', 'run-1', 'clean-1', 'run-2', 'clean-2'],
    'final iteration cleanup runs exactly once on dispose'
  );
});

// -----------------------------------------------------------------
// Assumption 5: createRoot detaches owner attribution.
// Protects: every kernel's no-owner path (warnOnNoOwner / no-owner-set),
// and lite-leak's decision NOT to auto-untrack createRoot-scoped tracks.
// -----------------------------------------------------------------

test('[create-root] getOwner() inside createRoot is undefined', () => {
  let seen = 'UNSET';
  createRoot(() => { seen = getOwner(); });
  assert.equal(seen, undefined);
});

// -----------------------------------------------------------------
// Assumption 6: end-to-end auto-untrack through the real tracker.
// This is the load-bearing integration -- if the peer's onCleanup wiring
// regresses, tracker.size() will not return to baseline on dispose.
// -----------------------------------------------------------------

test('[auto-untrack] a tracked handle inside an effect is unregistered on dispose', () => {
  const tracker = createLeakTracker();
  const before = tracker.size();
  const e = effect(() => {
    tracker.track({}, function () {}, 'peer-probe');
  });
  assert.equal(tracker.size(), before + 1, 'tracked once inside the effect');
  dispose(e);
  assert.equal(tracker.size(), before, 'auto-untracked on owner disposal');
});

// -----------------------------------------------------------------
// Assumption 7: raf-orphan auto-cancel rides the same cascade.
// The marquee v1.1.0 kernel depends on onCleanup firing to cancel the
// frame that is armed at disposal. Validate it against the live peer.
// -----------------------------------------------------------------

test('[raf-orphan] owner-scoped rAF loop auto-cancels on dispose against this peer', () => {
  const raf = createMockRaf();
  const target = Object.create(null);
  target.requestAnimationFrame = raf.requestAnimationFrame.bind(raf);
  target.cancelAnimationFrame = raf.cancelAnimationFrame.bind(raf);

  const tracker = createLeakTracker();
  tracker.registerKernel(createRafOrphanKernel({ target }));

  let frames = 0;
  function loop() { frames++; target.requestAnimationFrame(loop); }
  const e = effect(() => { target.requestAnimationFrame(loop); });

  raf.tick(16); // frame 1 fires, reschedules frame 2 (inherits owner)
  raf.tick(16); // frame 2 fires, reschedules frame 3
  assert.equal(frames, 2);
  assert.equal(raf.armedCount, 1, 'loop is armed');

  dispose(e);
  assert.equal(raf.armedCount, 0, 'auto-cancel stopped the loop on dispose');
  raf.tick(16);
  assert.equal(frames, 2, 'no further frames after dispose');
});

// -----------------------------------------------------------------
// Assumption 8: timer-orphan <-> raf-orphan coexistence handoff.
// With handleRaf:false, timer-orphan cedes the rAF surface; both install
// together without a KernelConflictError. Protects the documented
// two-kernel setup on this peer.
// -----------------------------------------------------------------

test('[coexist] timer-orphan (handleRaf:false) + raf-orphan install together', () => {
  const raf = createMockRaf();
  const target = Object.create(null);
  target.setTimeout = (fn) => 1;
  target.clearTimeout = () => {};
  target.requestAnimationFrame = raf.requestAnimationFrame.bind(raf);
  target.cancelAnimationFrame = raf.cancelAnimationFrame.bind(raf);

  const tracker = createLeakTracker();
  assert.doesNotThrow(() => {
    tracker.registerKernel(createTimerOrphanKernel({ target, handleRaf: false }));
    tracker.registerKernel(createRafOrphanKernel({ target }));
  });
});
