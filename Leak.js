/**
 * @zakkster/lite-leak
 * Zero-GC leak diagnostic for the @zakkster/lite-* ecosystem.
 * Consumes @zakkster/lite-cleanup for FR bookkeeping and integrates with
 * @zakkster/lite-signal's owner tree for attribution, auto-untrack, and
 * on-demand audit passes.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { createDisposalRegistry } from '@zakkster/lite-cleanup';
import { getOwner, ownerOf, onCleanup, nodeId, describe } from '@zakkster/lite-signal';

export const VERSION = '1.2.0';

const EMPTY_OPTIONS = Object.freeze(Object.create(null));

// Bounded walk depth guards against pathological owner chains and preserves
// bounded reporting latency. 1024 is well past any realistic ownership depth.
// Exported so kernels can use the same boundary in their own walk logic.
export const MAX_OWNER_WALK = 1024;

/**
 * Factory for the tracker's error-routing helper. Kept as a top-level
 * factory (not closed over inside createLeakTracker) so the routing
 * behavior is one testable path and the main factory stays lean.
 *
 * The returned function:
 *   1. Calls `onError(err, tag)` if provided, swallowing anything it throws.
 *   2. Always logs to console.error, tagged with the tracker's name.
 *   3. Swallows console.error failure as a last resort.
 * @private
 */
function createErrorRouter(onError, name) {
  return function routeError(err, tag) {
    if (onError !== undefined) {
      try { onError(err, tag); } catch (_e) { /* swallowed */ }
    }
    try {
      console.error('[lite-leak/' + name + '] error:', err);
    } catch (_e) { /* swallowed */ }
  };
}

// -----------------------------------------------------------------
// KernelConflictError -- thrown on double-registration of a kernel name
// or when two kernels claim the same patch surface.
// -----------------------------------------------------------------

export class KernelConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KernelConflictError';
  }
}

/**
 * Walk from an owner handle to the root, snapshotting only id and kind of
 * each frame. Non-retaining: does NOT hold references to any owner node or
 * pool slot. The descriptors returned by ownerOf() carry a NODE_PTR symbol
 * that would retain the pool slot; we extract the primitive fields and drop
 * the descriptor immediately.
 *
 * ALLOCATION NOTE: This function allocates one small {id, kind} object per
 * owner-tree hop plus one array. For well-behaved apps with shallow
 * ownership chains (1-5 levels), the cost is negligible. For BURSTY track()
 * usage in massive dynamic graphs (ECS entity mount storms, thousands of
 * concurrent component mounts inside a 16ms frame), this can flood the
 * nursery and trigger Scavenger GC pressure. Guidance:
 *   1. Disable lite-leak entirely in production builds via a build-time
 *      flag; the tracker is a dev-time diagnostic.
 *   2. In dev, avoid { audit: true } on hot paths -- reserve it for handles
 *      whose lifecycle you actively suspect.
 *   3. If you must track hot paths in dev, expect scavenges and gate your
 *      perf benchmarks accordingly.
 * @private
 */
/**
 * Global patch claims: target object -> set of surface names patched on it.
 *
 * `registerKernel`'s patchSurfaces guard is scoped to ONE tracker, so two
 * trackers -- an app's and a test harness's, or two bundled copies -- each
 * installed a timer/listener kernel over the SAME global and neither
 * complained. Whichever uninstalled first then restored the pre-first-patch
 * original, silently disabling the other: a leak detector that stops detecting
 * without saying so. Patching is a property of the TARGET, not of the tracker,
 * so the claim lives here at module scope.
 *
 * @private
 */
const patchClaims = new WeakMap();

/**
 * Claim `surface` on `target`.
 *
 * Returns false when another kernel instance already holds it. Deliberately
 * does NOT throw: installing a kernel and never uninstalling it is a normal,
 * documented pattern (the suite does it), so a hard error would reject working
 * code. The failure worth eliminating is the SILENT one -- a second patch that
 * the first one's uninstall then destroys without a word -- and that is handled
 * by _restoreIfOurs. Callers surface the double-patch as a warning so a
 * duplicated install is visible rather than fatal.
 *
 * @returns {boolean} true if newly claimed, false if already held.
 * @private
 */
export function _claimPatchSurface(target, surface) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return true;
  let held = patchClaims.get(target);
  if (held === undefined) { held = new Set(); patchClaims.set(target, held); }
  if (held.has(surface)) return false;
  held.add(surface);
  return true;
}

/** Release a previously claimed surface. @private */
export function _releasePatchSurface(target, surface) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return;
  const held = patchClaims.get(target);
  if (held !== undefined) held.delete(surface);
}

/**
 * Restore `original` onto `target[prop]` ONLY if our wrapper is still the
 * installed value. A blind `target[prop] = original` destroys any wrapper a
 * third party (an APM agent, a test framework, another diagnostic) layered on
 * top of ours after install, silently un-instrumenting them.
 *
 * @returns {boolean} true if restored; false if someone else owns the slot now.
 * @private
 */
export function _restoreIfOurs(target, prop, ourWrapper, original) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return false;
  if (target[prop] !== ourWrapper) return false;
  target[prop] = original;
  return true;
}

function snapshotOwnerPath(ownerHandle) {
  const path = [];
  let cursor = ownerHandle;
  let hops = 0;
  while (cursor !== undefined && hops < MAX_OWNER_WALK) {
    path.push({ id: cursor.id, kind: cursor.kind });
    cursor = ownerOf(cursor);
    hops++;
  }
  return path;
}

/**
 * Create a leak tracker.
 *
 * @param {object} [options]
 * @param {string} [options.name='lite-leak']
 * @param {boolean} [options.captureStacks=false]
 * @param {(report: LeakReport) => void} [options.onLeak]
 * @param {(err: any, tag: any) => void} [options.onError]
 * @param {(finding: KernelFinding) => void} [options.onFinding]
 *   Called with structured findings emitted by kernels (either via install-
 *   time detection or from audit() results). Neutral channel; different
 *   from onWarning which conveys pre-FR anomaly detection.
 * @param {(warning: KernelFinding) => void} [options.onWarning]
 *   Called with live pre-FR anomaly warnings (e.g., "timer set outside any
 *   owner"). Different semantic urgency from onLeak (confirmed FR fire).
 */
export function createLeakTracker(options) {
  const opts = options || EMPTY_OPTIONS;
  const name = opts.name || 'lite-leak';
  const captureStacks = opts.captureStacks === true;
  const onLeak = opts.onLeak;
  const onError = opts.onError;
  const onFinding = opts.onFinding;
  const onWarning = opts.onWarning;

  // Registered kernels, in registration order (deterministic refine chain).
  const kernels = [];
  // Set of names claimed by installed kernels (uniqueness enforcement).
  const claimedNames = new Set();
  // Set of patch surfaces claimed by installed kernels (conflict guard).
  const claimedPatchSurfaces = new Set();
  // Set of leakRecord objects for handles registered with { audit: true }.
  // Iterated by kernels via ctx.forEachAuditedHandle. Disposed records are
  // reaped lazily during iteration.
  const auditedRecords = new Set();

  // Error routing is factored into a top-level helper so the factory stays
  // lean and the routing behavior is one testable path (see createErrorRouter).
  const routeError = createErrorRouter(onError, name);

  const registry = createDisposalRegistry({
    name: name,
    onError: function (err, leakRecord) {
      const tag = leakRecord !== null ? leakRecord.tag : null;
      routeError(err, tag);
    },
    onCollect: function (leakRecord) {
      if (leakRecord === null) return;
      // Fast path: nothing consumes leak reports.
      if (onLeak === undefined && kernels.length === 0) {
        // Still remove from audit set for hygiene.
        if (leakRecord.audit) auditedRecords.delete(leakRecord);
        return;
      }
      let report = {
        tag: leakRecord.tag,
        ownerPath: leakRecord.ownerPath,
        origin: leakRecord.origin,
        kind: 'unknown',
        collectedAt: performance.now(),
      };
      // Refine chain: first non-null wins. Kernels are tried in
      // priority-then-registration order (see registerKernel). Errors route
      // to onError + console and continue -- one bad kernel does not
      // silence the others.
      for (let i = 0; i < kernels.length; i++) {
        const k = kernels[i];
        if (k.refine === undefined) continue;
        try {
          const refined = k.refine(report, leakRecord);
          if (refined !== undefined && refined !== null) {
            report = refined;
            break;
          }
        } catch (err) {
          routeError(err, leakRecord.tag);
        }
      }
      // Delete from audit set BEFORE calling onLeak so listeners see
      // consistent state.
      if (leakRecord.audit) auditedRecords.delete(leakRecord);
      if (onLeak !== undefined) {
        try { onLeak(report); }
        catch (err) { routeError(err, leakRecord.tag); }
      }
    },
  });

  // -----------------------------------------------------------------
  // Kernel context: what kernels receive at install() time.
  // -----------------------------------------------------------------
  function forEachAuditedHandle(fn) {
    // Two-phase reap: identify stale records during iteration, delete after.
    // ES2015 Set iterators handle mid-iteration deletion of the current key,
    // but the pattern is fragile on legacy runtimes and mobile browsers;
    // reaping post-loop is spec-clean everywhere. Allocation only occurs
    // when stale entries are present (rare in well-behaved code).
    // Snapshot first. A Set iterator VISITS entries added during iteration, so a
    // kernel whose audit callback tracks a new { audit: true } handle -- a
    // perfectly reasonable "found something suspicious, watch it" pattern --
    // fed its own walk and never terminated. Iterating a snapshot bounds the
    // pass to the records that existed when it started; anything added lands in
    // the next pass. The array is the cost of not hanging the process.
    const snapshot = Array.from(auditedRecords);
    let toReap = null;
    for (const record of snapshot) {
      if (!auditedRecords.has(record)) continue;   // untracked mid-pass
      if (record.handle === null || record.handle.disposed === true) {
        if (toReap === null) toReap = [];
        toReap.push(record);
        continue;
      }
      try { fn(record.handle, record); }
      catch (err) { routeError(err, record.tag); }
    }
    if (toReap !== null) {
      for (let i = 0; i < toReap.length; i++) auditedRecords.delete(toReap[i]);
    }
  }

  function emitWarning(finding) {
    if (onWarning !== undefined) {
      try { onWarning(finding); }
      catch (err) { routeError(err, finding !== null && finding !== undefined ? finding.tag : null); }
    }
  }

  function emitFinding(finding) {
    if (onFinding !== undefined) {
      try { onFinding(finding); }
      catch (err) { routeError(err, finding !== null && finding !== undefined ? finding.tag : null); }
    }
  }

  const kernelCtx = {
    trackerName: name,
    forEachAuditedHandle: forEachAuditedHandle,
    emitWarning: emitWarning,
    emitFinding: emitFinding,
    reportError: routeError,
    // Kernels track and untrack via ctx so they are scoped to this tracker
    // instance, not the module-level default. Assigned below after track /
    // untrack are declared.
    track: null,
    untrack: null,
  };

  // -----------------------------------------------------------------
  // Public tracker API
  // -----------------------------------------------------------------
  function track(target, cleanup, tag, options) {
    const opts = options || EMPTY_OPTIONS;
    const audit = opts.audit === true;
    const ownerHandle = getOwner();
    const ownerPath = ownerHandle !== undefined
      ? snapshotOwnerPath(ownerHandle)
      : null;
    const origin = captureStacks ? new Error().stack : null;
    const leakRecord = {
      tag: tag === undefined ? null : tag,
      ownerPath: ownerPath,
      origin: origin,
      // Only retain the live owner handle if the caller opted in. This
      // handle carries a NODE_PTR that retains the owner's pool slot until
      // the record is disposed. Default off -- the cost is dev-tool-only.
      ownerHandle: audit ? ownerHandle : null,
      audit: audit,
      // Back-pointer set below after registry.register returns the handle.
      handle: null,
    };
    const handle = registry.register(target, cleanup, leakRecord);
    leakRecord.handle = handle;
    if (audit) auditedRecords.add(leakRecord);
    if (ownerHandle !== undefined) {
      onCleanup(function () { registry.unregister(handle); });
    }
    return handle;
  }

  function untrack(handle) {
    registry.unregister(handle);
    // Audited records reap lazily on next audit iteration -- no work here.
  }

  // Complete kernelCtx now that track/untrack are declared.
  kernelCtx.track = track;
  kernelCtx.untrack = untrack;

  function size() {
    return registry.size();
  }

  function registerKernel(kernel) {
    if (kernel === null || typeof kernel !== 'object') {
      throw new TypeError('registerKernel: kernel must be an object');
    }
    if (typeof kernel.name !== 'string' || kernel.name.length === 0) {
      throw new TypeError('registerKernel: kernel.name must be a non-empty string');
    }
    if (claimedNames.has(kernel.name)) {
      throw new KernelConflictError(
        'kernel with name "' + kernel.name + '" already registered'
      );
    }
    // Patch-surface conflict guard. Each kernel declares which globals /
    // shared resources it patches; two kernels claiming the same surface
    // must be manually reconciled.
    const patchSurfaces = Array.isArray(kernel.patchSurfaces) ? kernel.patchSurfaces : [];
    for (const s of patchSurfaces) {
      if (claimedPatchSurfaces.has(s)) {
        throw new KernelConflictError(
          'patch surface "' + s + '" already claimed by another kernel'
        );
      }
    }
    claimedNames.add(kernel.name);
    for (const s of patchSurfaces) claimedPatchSurfaces.add(s);
    if (typeof kernel.install === 'function') {
      try { kernel.install(kernelCtx); }
      catch (err) {
        // Roll back registration on install failure.
        claimedNames.delete(kernel.name);
        for (const s of patchSurfaces) claimedPatchSurfaces.delete(s);
        throw err;
      }
    }
    // Priority-based insertion: higher priority runs first (refine chain
    // and audit iteration). Ties broken by registration order (stable).
    // Default priority is 0. Specialised kernels should register with
    // higher priority than generic ones to avoid being masked.
    const priority = typeof kernel.priority === 'number' ? kernel.priority : 0;
    let insertAt = kernels.length;
    for (let i = 0; i < kernels.length; i++) {
      const existingPri = typeof kernels[i].priority === 'number' ? kernels[i].priority : 0;
      if (priority > existingPri) { insertAt = i; break; }
    }
    kernels.splice(insertAt, 0, kernel);
    return function unregisterThisKernel() { unregisterKernel(kernel); };
  }

  function unregisterKernel(kernel) {
    const idx = kernels.indexOf(kernel);
    if (idx < 0) return;
    kernels.splice(idx, 1);
    claimedNames.delete(kernel.name);
    const patchSurfaces = Array.isArray(kernel.patchSurfaces) ? kernel.patchSurfaces : [];
    for (const s of patchSurfaces) claimedPatchSurfaces.delete(s);
    if (typeof kernel.uninstall === 'function') {
      try { kernel.uninstall(); }
      catch (err) { routeError(err, null); }
    }
  }

  function audit() {
    const findings = [];
    for (let i = 0; i < kernels.length; i++) {
      const k = kernels[i];
      if (typeof k.audit !== 'function') continue;
      let kernelFindings;
      try { kernelFindings = k.audit(); }
      catch (err) {
        routeError(err, null);
        continue;
      }
      if (Array.isArray(kernelFindings)) {
        for (const f of kernelFindings) {
          findings.push(f);
          emitFinding(f);
        }
      }
    }
    return findings;
  }

  /**
   * M2: filter audit findings by kind. Convenience wrapper around audit().
   * Returns a fresh array; original audit() is called once per invocation.
   */
  function auditByKind(kind) {
    const all = audit();
    const filtered = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].kind === kind) filtered.push(all[i]);
    }
    return filtered;
  }

  /**
   * M2: filter audit findings whose ownerPath contains the given owner
   * handle (matching by node id).
   */
  function auditByOwner(ownerHandle) {
    if (ownerHandle === null || ownerHandle === undefined) return [];
    const targetId = typeof ownerHandle.id === 'number' ? ownerHandle.id : null;
    if (targetId === null) return [];
    const all = audit();
    const filtered = [];
    for (let i = 0; i < all.length; i++) {
      const f = all[i];
      if (Array.isArray(f.ownerPath)) {
        for (let j = 0; j < f.ownerPath.length; j++) {
          if (f.ownerPath[j].id === targetId) { filtered.push(f); break; }
        }
      }
    }
    return filtered;
  }

  /**
   * M2: produce a human-readable remediation advisory for a finding.
   * Walks registered kernels in priority-then-registration order asking
   * each for `advise(finding)`. First non-null string wins; else falls
   * back to a generic string.
   */
  function remediate(finding) {
    if (finding === null || typeof finding !== 'object') return '';
    for (let i = 0; i < kernels.length; i++) {
      const k = kernels[i];
      if (typeof k.advise !== 'function') continue;
      try {
        const advice = k.advise(finding);
        if (typeof advice === 'string' && advice.length > 0) return advice;
      } catch (err) {
        routeError(err, null);
      }
    }
    return 'No kernel-provided remediation advice for finding of kind "' + finding.kind + '".';
  }

  return {
    track: track,
    untrack: untrack,
    size: size,
    name: name,
    registerKernel: registerKernel,
    unregisterKernel: unregisterKernel,
    audit: audit,
    auditByKind: auditByKind,
    auditByOwner: auditByOwner,
    remediate: remediate,
  };
}

// --- Module-level convenience: default tracker (lazy) ---

let defaultTracker = null;

function getDefault() {
  if (defaultTracker === null) {
    defaultTracker = createLeakTracker();
  }
  return defaultTracker;
}

export function track(target, cleanup, tag, options) {
  return getDefault().track(target, cleanup, tag, options);
}

export function untrack(handle) {
  return getDefault().untrack(handle);
}

/**
 * Test-only: reset the module-level default tracker. Follows the
 * lite-observe / lite-floating underscore-prefix convention.
 * @private
 */
export function _resetDefault() {
  defaultTracker = null;
}

// -----------------------------------------------------------------
// Kernel re-exports
// -----------------------------------------------------------------
export { createOwnerCascadeOrphanKernel } from './kernels/OwnerCascadeOrphan.js';
export { createTimerOrphanKernel } from './kernels/TimerOrphan.js';
export { createListenerOrphanKernel } from './kernels/ListenerOrphan.js';
export { createObserverOrphanKernel } from './kernels/ObserverOrphan.js';
export { createDetachedDomKernel } from './kernels/DetachedDom.js';
export { createAsyncRetentionKernel } from './kernels/AsyncRetention.js';
export { createRafOrphanKernel } from './kernels/RafOrphan.js';
export { createWorkerOrphanKernel } from './kernels/WorkerOrphan.js';
export { createAudioNodeKernel } from './kernels/AudioNode.js';
export { createSocketOrphanKernel } from './kernels/SocketOrphan.js';

// -----------------------------------------------------------------
// Ecosystem sink re-exports (M2.5)
// -----------------------------------------------------------------
export {
  createTraceSink,
  createGenericSink,
} from './sinks/Sinks.js';
export {
  createProfilerSignalSink,
  createStudioSink,
} from './sinks/EcosystemSinks.js';
