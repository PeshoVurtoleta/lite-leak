/**
 * @zakkster/lite-leak kernel: observer-orphan
 *
 * Detects and prevents leaks from MutationObserver / ResizeObserver /
 * IntersectionObserver instances that outlive their owner without being
 * explicitly disconnect()ed.
 *
 * Design: replaces each constructor on the target with a wrapper that
 * (a) instruments the returned instance's `disconnect()` for untrack /
 * registry reap; (b) wires `onCleanup(() => instance.disconnect())` when
 * `new Observer()` is called inside an effect/computed body; (c) emits
 * `onWarning` at construction time when outside any owner.
 *
 * Patch surfaces: 'MutationObserver', 'ResizeObserver',
 * 'IntersectionObserver'.
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';

const KIND = 'observer-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

const OBSERVER_KINDS = ['MutationObserver', 'ResizeObserver', 'IntersectionObserver'];

/**
 * Create the observer-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object whose observer constructors are replaced. Tests pass a mock
 *   target with any subset of the three observer classes.
 * @param {boolean} [options.warnOnNoOwner=true]
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createObserverOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // observer instance -> state
  const observers = new Map();
  let originals = null;

  function makePatchedCtor(kind, OriginalCtor) {
    return function PatchedObserver(cb, ctorOpts) {
      // Construct via Reflect so subclassing rules stay intact if the
      // original was itself subclassed.
      const instance = ctorOpts !== undefined
        ? Reflect.construct(OriginalCtor, [cb, ctorOpts])
        : Reflect.construct(OriginalCtor, [cb]);

      if (ctx === null) return instance;

      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const state = {
        kind: kind,
        instance: instance,
        cb: cb,
        ownerHandle: ownerHandle,
        origin: origin,
        handle: null,
      };

      // Track the callback so FR-refine can classify.
      const handle = ctx.track(cb, function () {}, {
        kind: 'observer',
        observerKind: kind,
      }, { audit: false });
      state.handle = handle;
      observers.set(instance, state);

      // Wrap the instance's disconnect() so we reap on manual disconnect.
      const origDisconnect = instance.disconnect.bind(instance);
      instance.disconnect = function patchedDisconnect() {
        if (ctx !== null) {
          observers.delete(instance);
          ctx.untrack(handle);
        }
        return origDisconnect();
      };

      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (ctx === null || originals === null) return;
          const s = observers.get(instance);
          if (s === undefined) return; // already disconnected
          observers.delete(instance);
          ctx.untrack(handle);
          origDisconnect();
        });
      } else if (warnOnNoOwner) {
        ctx.emitWarning({
          kind: KIND,
          reason: 'no-owner-set',
          observerKind: kind,
          origin: origin,
        });
      }
      return instance;
    };
  }

  const kernel = {
    name: 'observer-orphan',
    patchSurfaces: OBSERVER_KINDS,
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      originals = {};
      for (const kind of OBSERVER_KINDS) {
        const orig = target[kind];
        if (typeof orig === 'function') {
          originals[kind] = orig;
          target[kind] = makePatchedCtor(kind, orig);
        }
      }
    },

    uninstall() {
      if (originals === null) return;
      for (const kind of OBSERVER_KINDS) {
        if (typeof originals[kind] === 'function') target[kind] = originals[kind];
      }
      originals = null;
      observers.clear();
      ctx = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'observer') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        observerKind: tag.observerKind,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      for (const [instance, state] of observers) {
        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          const liveId = nodeId(state.ownerHandle);
          if (liveId === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-observer-pending',
              observerKind: state.kind,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-pending',
            observerKind: state.kind,
            origin: state.origin,
          });
        }
      }
      return findings;
    },

    _pendingCount() { return observers.size; },
  };

  return kernel;
}
