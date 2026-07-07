/**
 * @zakkster/lite-leak kernel: listener-orphan
 *
 * Detects and prevents event-listener leaks. Patches an EventTarget
 * subclass's prototype so `addEventListener` calls inside an
 * effect/computed body auto-wire `removeEventListener` via `onCleanup`.
 * Calls outside any owner emit `onWarning` at set-time.
 *
 * Design: no internal enumeration registry. Auto-remove is wired directly
 * via the `onCleanup` closure captured at `addEventListener` time -- the
 * closure retains only (target, type, listener, options), not the target
 * itself in any way that changes GC (target and listener are also live
 * via the DOM). Refine path classifies leaks on tracked listener records
 * by tag shape.
 *
 * Patch surface claimed: 'EventTarget.addEventListener'.
 */

import { getOwner, onCleanup } from '@zakkster/lite-signal';

const KIND = 'listener-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Create the listener-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.EventTarget=globalThis.EventTarget]
 *   The EventTarget class whose prototype is patched. Default is the
 *   global. Tests may pass a specific subclass for surgical control.
 * @param {boolean} [options.warnOnNoOwner=true]
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createListenerOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const EvTarget = opts.EventTarget || (typeof globalThis.EventTarget === 'function' ? globalThis.EventTarget : null);
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  let originals = null;

  const kernel = {
    name: 'listener-orphan',
    patchSurfaces: ['EventTarget.addEventListener'],
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      if (EvTarget === null || typeof EvTarget.prototype !== 'object') {
        // No target to patch (unusual environment); install is a no-op.
        originals = null;
        return;
      }
      originals = {
        addEventListener: EvTarget.prototype.addEventListener,
        removeEventListener: EvTarget.prototype.removeEventListener,
      };
      const origAdd = originals.addEventListener;
      const origRemove = originals.removeEventListener;

      EvTarget.prototype.addEventListener = function patchedAdd(type, listener, listenerOptions) {
        // Call original first so the listener is actually attached even if
        // our bookkeeping throws.
        origAdd.call(this, type, listener, listenerOptions);
        if (ctx === null) return; // uninstalled mid-call, edge case

        const target = this;
        const ownerHandle = getOwner();
        const origin = captureStacks ? new Error().stack : null;

        // Track the listener function so the FR-refine path can classify
        // leaks on it. Tag carries only primitives; target and listener
        // are already retained via the DOM (element -> listener), so this
        // adds no new retention.
        const handle = ctx.track(listener, function () {}, {
          kind: 'listener',
          type: type,
          origin: origin,
        }, { audit: false });

        if (ownerHandle !== undefined) {
          onCleanup(function () {
            if (ctx !== null) ctx.untrack(handle);
            if (originals !== null) {
              origRemove.call(target, type, listener, listenerOptions);
            }
          });
        } else if (warnOnNoOwner) {
          ctx.emitWarning({
            kind: KIND,
            reason: 'no-owner-set',
            type: type,
            origin: origin,
          });
        }
      };

      EvTarget.prototype.removeEventListener = function patchedRemove(type, listener, listenerOptions) {
        // We have no reliable way to look up the handle without a strong
        // registry. The auto-untrack via onCleanup already runs on owner
        // dispose. For manual removeEventListener calls outside our
        // auto-cleanup path, the listener's tracked handle stays live
        // until FR fires -- harmless (no leak, just a stale registration).
        return origRemove.call(this, type, listener, listenerOptions);
      };
    },

    uninstall() {
      if (originals === null) return;
      EvTarget.prototype.addEventListener = originals.addEventListener;
      EvTarget.prototype.removeEventListener = originals.removeEventListener;
      originals = null;
      ctx = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'listener') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        listenerType: tag.type,
      };
    },

    // No global-enumeration audit for listeners; the auto-cleanup path is
    // sufficient. Returning empty keeps the audit() surface consistent.
    audit() { return []; },
  };

  return kernel;
}
