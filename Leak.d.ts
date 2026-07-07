/**
 * @zakkster/lite-leak
 * Zero-GC leak diagnostic for the @zakkster/lite-* ecosystem.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

export const VERSION: string;

/**
 * Bounded walk depth for owner-tree traversal. Kernels that walk owner
 * chains should use this same boundary to remain consistent with the
 * tracker's own snapshot walker.
 */
export const MAX_OWNER_WALK: number;

// -----------------------------------------------------------------
// Errors
// -----------------------------------------------------------------

export class KernelConflictError extends Error {}

// -----------------------------------------------------------------
// Report shapes
// -----------------------------------------------------------------

export interface OwnerFrame {
  readonly id: number;
  readonly kind: 'effect' | 'computed' | 'signal';
}

export interface LeakReport<T = unknown> {
  readonly tag: T | null;
  readonly ownerPath: readonly OwnerFrame[] | null;
  readonly origin: string | null;
  readonly kind: string;
  readonly collectedAt: number;
}

/**
 * Kernel-emitted finding. Kernels are free to add their own fields.
 */
export interface KernelFinding<T = unknown> {
  readonly kind: string;
  readonly tag?: T | null;
  readonly ownerPath?: readonly OwnerFrame[] | null;
  readonly origin?: string | null;
  [k: string]: unknown;
}

// -----------------------------------------------------------------
// Track / options
// -----------------------------------------------------------------

export interface TrackOptions {
  /**
   * Opt in to audit-time kernel inspection. When true, the tracker retains
   * the direct owner handle on the internal record, allowing kernels to
   * walk upward from it. Default `false` -- retention-neutral.
   *
   * Enabling `audit` retains one owner pool slot per tracked handle for the
   * lifetime of the handle. This is a dev-tool cost accepted by the caller.
   */
  audit?: boolean;
}

export interface LeakHandle {
  readonly disposed: boolean;
}

// -----------------------------------------------------------------
// Tracker
// -----------------------------------------------------------------

export interface LeakTrackerOptions<T = unknown> {
  name?: string;
  captureStacks?: boolean;
  onLeak?: (report: LeakReport<T>) => void;
  onError?: (err: unknown, tag: T | null) => void;
  onFinding?: (finding: KernelFinding<T>) => void;
  onWarning?: (finding: KernelFinding<T>) => void;
}

/**
 * Kernel context passed to `install()`. Kernels use this to reach the
 * tracker without holding a direct tracker reference.
 */
export interface KernelContext {
  readonly trackerName: string;
  forEachAuditedHandle(fn: (handle: LeakHandle, record: unknown) => void): void;
  emitWarning(finding: KernelFinding): void;
  emitFinding(finding: KernelFinding): void;
  reportError(err: unknown, tag: unknown | null): void;
}

/**
 * Kernel shape. Kernels detect specific leak classes and (optionally)
 * refine FR reports.
 */
export interface Kernel {
  readonly name: string;
  /**
   * Global / shared resources this kernel patches. Two kernels claiming
   * the same surface trigger KernelConflictError at register time.
   */
  readonly patchSurfaces?: readonly string[];
  /**
   * Refine-chain and audit ordering weight. Higher priority runs first.
   * Ties broken by registration order. Default 0. Specialised kernels
   * should register with higher priority than generic ones to avoid
   * being masked in the FR-time refine chain.
   */
  readonly priority?: number;
  install?(ctx: KernelContext): void;
  uninstall?(): void;
  refine?(report: LeakReport, record: unknown): LeakReport | null | undefined;
  audit?(): KernelFinding[];
  /**
   * M2: kernel-provided remediation advisory. Consumed by tracker.remediate().
   * Returning null passes the finding to the next kernel in the chain.
   */
  advise?(finding: KernelFinding): string | null | undefined;
}

export interface LeakTracker<T = unknown> {
  track(target: object, cleanup: () => void, tag?: T, options?: TrackOptions): LeakHandle;
  untrack(handle: LeakHandle | null | undefined): void;
  size(): number;
  readonly name: string;
  registerKernel(kernel: Kernel): () => void;
  unregisterKernel(kernel: Kernel): void;
  audit(): KernelFinding[];
  /** M2: convenience filter over `audit()` findings. */
  auditByKind(kind: string): KernelFinding[];
  /** M2: filter audit findings whose ownerPath contains the owner's id. */
  auditByOwner(ownerHandle: unknown): KernelFinding[];
  /** M2: kernel-provided remediation advisory for a finding. */
  remediate(finding: KernelFinding): string;
}

export function createLeakTracker<T = unknown>(
  options?: LeakTrackerOptions<T>
): LeakTracker<T>;

// -----------------------------------------------------------------
// Module-level convenience
// -----------------------------------------------------------------

export function track<T = unknown>(
  target: object,
  cleanup: () => void,
  tag?: T,
  options?: TrackOptions
): LeakHandle;

export function untrack(handle: LeakHandle | null | undefined): void;

// -----------------------------------------------------------------
// Kernel: owner-cascade-orphan (M1-a)
// -----------------------------------------------------------------

export interface OwnerCascadeOrphanFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'owner-cascade-orphan';
  readonly tag: T | null;
  readonly ownerPath: readonly OwnerFrame[] | null;
  readonly origin: string | null;
  readonly brokenAt?: number;
  readonly reason: 'stale' | 'diverged' | 'kind-diverged' | 'truncated' | 'no-attribution';
  readonly liveFrame?: OwnerFrame | null;
  readonly handle?: LeakHandle;
}

export interface OwnerCascadeOrphanKernelOptions {
  /**
   * When true, records tracked with `{ audit: true }` but no capturable
   * owner context produce a `no-attribution` finding. Default false
   * preserves the original silent-skip behavior.
   */
  emitNoAttribution?: boolean;
  priority?: number;
}

export function createOwnerCascadeOrphanKernel(options?: OwnerCascadeOrphanKernelOptions): Kernel;

// -----------------------------------------------------------------
// Kernel: timer-orphan (M1-b)
// -----------------------------------------------------------------

export type TimerKind = 'setTimeout' | 'setInterval' | 'requestAnimationFrame';

/**
 * Any object that exposes the timer methods to be patched. In production
 * this is typically `globalThis`; in tests a mock clock / rAF harness.
 * The kernel patches only the methods that exist as functions on the
 * target, silently skipping the rest.
 */
export interface TimerTarget {
  setTimeout?: (...args: unknown[]) => unknown;
  clearTimeout?: (id: unknown) => void;
  setInterval?: (...args: unknown[]) => unknown;
  clearInterval?: (id: unknown) => void;
  requestAnimationFrame?: (cb: (t: number) => void) => unknown;
  cancelAnimationFrame?: (id: unknown) => void;
}

export interface TimerOrphanKernelOptions {
  target?: TimerTarget;
  warnOnNoOwner?: boolean;
  captureStacks?: boolean;
  priority?: number;
}

export interface TimerOrphanFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'timer-orphan';
  readonly reason:
    | 'no-owner-set'
    | 'no-owner-pending'
    | 'owner-disposed-timer-pending';
  readonly timerKind: TimerKind;
  readonly timerId: unknown;
  readonly origin: string | null;
}

export interface TimerOrphanRefinedReport<T = unknown> extends LeakReport<T> {
  readonly kind: 'timer-orphan';
  readonly timerKind: TimerKind;
  readonly timerId: unknown;
  readonly wasCleared: boolean;
}

export function createTimerOrphanKernel(options?: TimerOrphanKernelOptions): Kernel;

// -----------------------------------------------------------------
// Kernel: listener-orphan (M1-c)
// -----------------------------------------------------------------

export interface ListenerOrphanKernelOptions {
  EventTarget?: typeof EventTarget;
  warnOnNoOwner?: boolean;
  captureStacks?: boolean;
  priority?: number;
}

export interface ListenerOrphanFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'listener-orphan';
  readonly reason: 'no-owner-set';
  readonly type: string;
  readonly origin: string | null;
}

export function createListenerOrphanKernel(options?: ListenerOrphanKernelOptions): Kernel;

// -----------------------------------------------------------------
// Kernel: observer-orphan (M1-d)
// -----------------------------------------------------------------

export type ObserverKind = 'MutationObserver' | 'ResizeObserver' | 'IntersectionObserver';

export interface ObserverOrphanKernelOptions {
  target?: object;
  warnOnNoOwner?: boolean;
  captureStacks?: boolean;
  priority?: number;
}

export interface ObserverOrphanFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'observer-orphan';
  readonly reason: 'no-owner-set' | 'no-owner-pending' | 'owner-disposed-observer-pending';
  readonly observerKind: ObserverKind;
  readonly origin: string | null;
}

export function createObserverOrphanKernel(options?: ObserverOrphanKernelOptions): Kernel;

// -----------------------------------------------------------------
// Kernel: detached-dom (M1-e)
// -----------------------------------------------------------------

export interface DetachedDomKernelOptions {
  root?: Node;
  warnOnDetach?: boolean;
  captureStacks?: boolean;
  priority?: number;
}

export interface DetachedDomFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'detached-dom';
  readonly reason: 'detached-without-untrack' | 'detached-at-audit';
  readonly tag: T | null;
  readonly origin: string | null;
}

export interface DetachedDomKernel extends Kernel {
  watch(node: Node, tag?: unknown): LeakHandle;
}

export function createDetachedDomKernel(options?: DetachedDomKernelOptions): DetachedDomKernel;

// -----------------------------------------------------------------
// Kernel: async-retention (M1-f)
// -----------------------------------------------------------------

export interface AsyncRetentionKernelOptions {
  target?: { AbortController?: typeof AbortController };
  warnOnNoOwner?: boolean;
  captureStacks?: boolean;
  priority?: number;
}

export interface AsyncRetentionFinding<T = unknown> extends KernelFinding<T> {
  readonly kind: 'async-retention';
  readonly reason: 'no-owner-set' | 'no-owner-pending' | 'owner-disposed-controller-pending';
  readonly origin: string | null;
}

export function createAsyncRetentionKernel(options?: AsyncRetentionKernelOptions): Kernel;

// -----------------------------------------------------------------
// M2: audit API extensions -- see LeakTracker interface above.
// The following methods are present on every LeakTracker returned by
// createLeakTracker() from v0.8.0 onward:
//
//   tracker.auditByKind(kind: string): KernelFinding[]
//   tracker.auditByOwner(ownerHandle: unknown): KernelFinding[]
//   tracker.remediate(finding: KernelFinding): string
//
// The Kernel interface (also above) additionally supports an optional
// `advise(finding): string | null | undefined` for kernel-specific
// remediation advice consumed by tracker.remediate().
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// M2.5: ecosystem sinks
// -----------------------------------------------------------------

export interface TraceSinkTracer {
  begin(tag: string): unknown;
  end(): unknown;
}

export interface TraceSinkOptions {
  tracer: TraceSinkTracer;
  leakTagPrefix?: string;
  warningTagPrefix?: string;
  findingTagPrefix?: string;
  errorTag?: string;
}

export interface Sink {
  onLeak(report: LeakReport): void;
  onWarning(finding: KernelFinding): void;
  onFinding(finding: KernelFinding): void;
  onError(err: unknown, tag: unknown | null): void;
}

export function createTraceSink(options: TraceSinkOptions): Sink;

export interface GenericSinkOptions {
  onLeak?: (report: LeakReport) => void;
  onWarning?: (finding: KernelFinding) => void;
  onFinding?: (finding: KernelFinding) => void;
  onError?: (err: unknown, tag: unknown | null) => void;
}

export function createGenericSink(options?: GenericSinkOptions): Sink;

// -----------------------------------------------------------------
// M2.5: ecosystem sinks (1.0.0)
// -----------------------------------------------------------------

/** Read-only signal accessor (call to read; do not `.set`). */
export interface ReadonlySignal<T> {
  (): T;
}

export interface ProfilerSignalSink extends Sink {
  readonly leakCount: ReadonlySignal<number>;
  readonly warningCount: ReadonlySignal<number>;
  readonly findingCount: ReadonlySignal<number>;
  readonly errorCount: ReadonlySignal<number>;
  readonly lastLeakKind: ReadonlySignal<string | null>;
  readonly lastWarningKind: ReadonlySignal<string | null>;
  reset(): void;
  dispose(): void;
}

export function createProfilerSignalSink(): ProfilerSignalSink;

export interface StudioSinkOptions {
  /** Whether to mount the overlay at construction. Default true. */
  mount?: boolean;
  /** Panel title. Default 'lite-leak'. */
  title?: string;
  /** Max log rows before oldest is dropped. Default 60. */
  maxLogRows?: number;
  /** CSS z-index for the overlay. Default 2147482999 (one below lite-studio). */
  zIndex?: number;
}

export interface StudioSink extends Sink {
  mount(): void;
  unmount(): void;
  dispose(): void;
}

export function createStudioSink(options?: StudioSinkOptions): StudioSink;
