# Changelog

All notable changes to `@zakkster/lite-leak` will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-19

**Three resource kernels.** Worker, WebAudio and socket lifecycles -- the three
remaining leak surfaces in the ecosystem where dropping a JS reference frees
nothing, because the resource is held by a thread, a render graph or the network
stack rather than by your heap.

Each kernel ships with its leakforge specimen in the same release
(`@zakkster/lite-leakforge` 1.2.0). A kernel without an acceptance specimen is
an untested claim.

### Added -- `worker-orphan` kernel (8th kernel)

- **`createWorkerOrphanKernel(options?)`** -- Worker / SharedWorker instances
  that outlive their owner without `terminate()`. Dropping the last reference
  does not stop the thread: the agent keeps its heap and message queue for the
  lifetime of the document.
  - Auto-terminates on owner disposal; warns `no-owner-set` at construction
    outside any owner.
  - `audit()` surfaces `no-owner-worker-live` and `owner-disposed-worker-live`.
    A **SharedWorker is deliberately never auto-reaped**: it exposes no
    `terminate()`, so the constructing context cannot stop it. Reaping it would
    report clean on an agent that is provably still running, so the
    registration stays and audit reports it.
  - **Object URLs are attributed, not policed.** Only a `blob:` URL actually
    passed to a worker constructor is recorded, and `URL.revokeObjectURL` is
    patched for bookkeeping alone. Patching `createObjectURL` wholesale would
    report every image and download blob as a worker finding -- the same
    category error that made `timer-orphan` model a render loop as a fire-once
    timer. Reason: `blob-url-unrevoked`. Disable with `trackObjectURLs: false`.
  - Revoking immediately after construction is correct (the worker script is
    fetched during construction), so `@zakkster/lite-worker` -- which revokes on
    the next line -- is clean here by design rather than by luck.
  - Options: `target`, `warnOnNoOwner`, `trackObjectURLs`, `captureStacks`,
    `priority`.

### Added -- `audio-node` kernel (9th kernel)

- **`createAudioNodeKernel(options?)`** -- WebAudio nodes left wired into the
  render graph, and scheduled sources started but never stopped. A connected
  node is referenced by the audio graph, so a heap snapshot showing no JS
  references is not evidence of anything.
  - **The hook is `connect()`, not the factory methods.** A node that is
    constructed and never connected is inert and collectable; it becomes
    retained at the moment it joins the graph. Patching `createGain` and friends
    would tag hundreds of harmless nodes and miss the one property that matters.
  - A full `disconnect()` reaps. A partial `disconnect(destination)` does not --
    the node is still audible, and treating a partial teardown as a full one
    would report clean on a node that is still rendering.
  - Owner disposal stops a playing source before disconnecting it: leaving a
    started source connected is the audible half of the leak.
  - Reasons: `no-owner-connect` (warning), `no-owner-node-connected`,
    `owner-disposed-node-connected`, `source-started-not-stopped`.
  - Options: `target`, `warnOnNoOwner`, `trackSources`, `captureStacks`,
    `priority`. In-house consumer: `@zakkster/lite-audio` v1.1.0, whose
    `destroy()` should leave `audit()` empty.

### Added -- `socket-orphan` kernel (10th kernel)

- **`createSocketOrphanKernel(options?)`** -- WebSocket / EventSource
  connections never `close()`d. An open socket is held by the network stack;
  an EventSource additionally keeps reconnecting on a timer forever.
  - `audit()` reports by `readyState`, not by bookkeeping: a connection the peer
    already closed is not a leak, so only `CONNECTING` or `OPEN` counts.
  - Reasons: `no-owner-open` (warning), `no-owner-socket-open`,
    `owner-disposed-socket-open`. In-house consumer: `@zakkster/lite-ws`.

### Changed

- **The new kernels never pin what they watch.** Their live registries hold
  `WeakRef`s behind a `WeakMap`, unlike `observer-orphan`'s strong `Map`. A
  detector that pins its subjects prevents the very collection it exists to
  observe -- a tracked worker could never reach the FR path. `audit()` prunes
  dead refs as it walks, so a dropped-and-never-terminated resource surfaces on
  the FR channel and is classified by `refine()`.
- All three kernels are built on the 1.1.0 patch-claim hardening: target-scoped
  claims, `patch-double-install` / `patch-layered` findings, identity-checked
  restore. `PatchLifecycleFinding` in `Leak.d.ts` widened to cover them.
- `test/_helpers/resources.js` -- deterministic mock Worker, WebAudio and socket
  hosts. Node has none of these globals, and patching a real one would leak
  claims into unrelated tests, so every host is a fresh local object.

## [1.1.0] - 2026-07-15

**Peer matrix + raf-orphan kernel.** The urgent half of the level-up: CI
insurance against lite-signal owner-tree drift, and coverage for the single
most common leak-prone resource in the ecosystem.

### Added -- `raf-orphan` kernel (7th kernel)

- **`createRafOrphanKernel(options?)`** -- loop-aware requestAnimationFrame
  leak detection. `timer-orphan` already patches rAF, but it treats every
  frame as a fire-once timer; a self-rescheduling loop defeats that model
  (the reschedule runs outside any owner, so cleanup cancels a long-consumed
  frame id and the loop leaks forever). This kernel models the loop as a
  **chain**: the owner captured at the first schedule is inherited by every
  continuation scheduled from inside the chain's own callback.
  - **Auto-cancel that actually stops the loop.** On owner disposal, cancels
    the frame that is *currently armed*, not the one armed at schedule-time.
  - **One warning per loop, not per frame.** A module-scope loop emits a
    single `no-owner-set` warning; `timer-orphan` emitted one every ~16 ms.
  - **`reschedule-after-dispose`** warning -- defense-in-depth for a broken
    owner cascade or a callback that disposes its own owner mid-frame and
    then reschedules.
  - **`audit()`** surfaces `no-owner-loop-armed` and
    `owner-disposed-loop-armed`; **`refine()`** classifies FR-collected loop
    callbacks; **`advise()`** carries per-reason remediation.
  - Options: `target`, `warnOnNoOwner`, `warnOnRescheduleAfterDispose`,
    `captureStacks`, `priority`. Re-exported from `Leak.js`; typed in
    `Leak.d.ts` (`RafOrphanKernelOptions`, `RafOrphanFinding`,
    `RafOrphanRefinedReport`).

- **`createTimerOrphanKernel({ handleRaf })`** -- new option (default
  `true`, fully backward compatible). Set `false` to make `timer-orphan`
  cede the rAF patch surface to `raf-orphan`, so both kernels install on the
  same tracker without a `KernelConflictError`. With `handleRaf: true`, the
  registry's patch-surface guard correctly refuses to install both -- two
  kernels double-wrapping rAF is never right.

### Added -- peer matrix (lite-signal assumption contract)

- **`test/peer-assumptions.test.js`** pins every lite-signal owner-tree
  internal that leak attribution depends on: the `{id, kind}` frame snapshot
  shape, `ownerOf()` walk termination, `nodeId()` liveness oracle
  (numeric while live, `undefined` after dispose), `onCleanup` cascade order,
  `createRoot` owner detachment, and the end-to-end auto-untrack wiring
  through the real tracker. Runs against whatever lite-signal is installed
  and banners the resolved version.
- **`peers.json`** -- single source of truth listing the peer versions the
  matrix expands over (`baseline` = the 1.8.0 clean base, `rebuilt-latest` =
  the latest rebuilt 1.9-1.12 prerelease). Edit to point at your exact
  targets.
- **`.github/workflows/peer-matrix.yml`** -- fans out over `peers.json` x
  Node {20, 22}, pins each `@zakkster/lite-signal` spec, and runs the
  assumptions suite plus the owner-dependent kernel suites. Fires on push/PR,
  `workflow_dispatch`, and `repository_dispatch: lite-signal-release` so a
  lite-signal owner-tree change that would break leak attribution fails here
  *before* it ships there.
- **`scripts/peer-matrix.mjs`** (`npm run peers:matrix`) -- local sweep that
  installs each peer in turn, runs the suite, and restores the original
  installed version on exit. `npm run test:peers` runs the suite against the
  currently-installed peer.

### Demo

- **`demo/index.html`** -- single-file oscilloscope-themed demo (esm.sh for
  lite-signal/lite-cleanup, `../Leak.js` for the package). Live rAF-loop
  scene contrasting an owned loop (auto-cancels on dispose) against an
  orphaned one (warns, then shows `audit()` catching the armed loop), plus a
  timer scene. Not shipped in `package.json` `files[]`.

### Hardening (prepublish review)

Four defects found while reviewing 1.1.0 before publish. All are cross-cutting
patch-lifecycle bugs whose common failure mode is *silence*: a leak detector
that stops detecting without saying so.

- **Audited-handle walk could not terminate.** A `Set` iterator visits entries
  added *during* iteration, so a kernel that tracked a new `{ audit: true }`
  handle from inside its own `forEachAuditedHandle` callback -- the natural
  "found something suspicious, watch it" pattern -- fed its own walk and hung
  the process. The walk now iterates a snapshot taken at entry and skips
  records untracked mid-pass; handles added during a pass are visited on the
  next one.
- **Patch claims are now target-scoped, not tracker-scoped.** `registerKernel`'s
  `patchSurfaces` guard only covers a single tracker, so two trackers (an app's
  and a test harness's, or two bundled copies) each wrapped the *same* global
  and neither complained -- then whichever uninstalled first restored the
  pre-first-patch original, silently disabling the other. Claims now live in a
  module-scope `WeakMap` keyed by the patch target. A contested surface emits a
  **`patch-double-install`** finding rather than throwing, since install-without-
  uninstall is a documented, working pattern.
- **`uninstall()` no longer clobbers third-party wrappers.** A blind
  `target[prop] = original` destroyed any wrapper (an APM agent, a test
  framework, another diagnostic) layered over ours after install. Restore is now
  identity-checked: our slot is restored, someone else's is left in place and
  reported as a **`patch-layered`** finding.
- **`originals` outlives a deliberately-orphaned wrapper.** When a wrapper is
  left installed, nulling `originals` turned every subsequent timer call into a
  `TypeError` and every clear into a silent no-op. It is now released only once
  every slot is ours again.

New finding reasons on `timer-orphan`, `listener-orphan`, and
`async-retention`: `patch-double-install` and `patch-layered`, each carrying
`surfaces: string[]` and a human-readable `detail`.

- **`test/torture.test.js`** -- 17-test adversarial suite pinning each defect
  above plus the invariants that held under attack (wrapper transparency,
  inert cancel of an unissued id, refine-chain priority and error isolation,
  no false positives on auto-untracked drops, a throwing `onLeak` consumer not
  suppressing later reports). The iteration test is deliberately bounded so a
  regression fails fast instead of hanging the runner.

## [1.0.0] - 2026-07-07

**Stable release.** Six detection kernels, M2 audit API, M2.5 ecosystem sinks,
retained-heap budget suite, rationale docs.

### Production-hardening (pre-publish)

- **`MAX_OWNER_WALK` exported** from `Leak.js`. Kernels that walk owner
  chains can now reference the same boundary constant as the tracker's own
  snapshot walker (`OwnerCascadeOrphan.js` cut over). Also exported from
  the `.d.ts` for type-level references.
- **`createErrorRouter` factored out** as a top-level helper. The tracker's
  error-routing logic is now one testable factory (`onError`-safe,
  `console.error`-safe) instead of a closure inside `createLeakTracker`.
  Behavior identical; factory is leaner and easier to audit.
- **Record contract resilience.** `OwnerCascadeOrphan` now handles the
  minimal record shape `track(target, null, null, { audit: true })`
  gracefully. Optional `{ emitNoAttribution: true }` kernel option emits a
  `'no-attribution'` finding for audit-opt-in records that lack owner
  context (top-level, `createRoot`, or synthetic null-record shape).
  Default remains silent-skip for backward compatibility. Kernel
  `advise(finding)` includes a per-reason advisory for `'no-attribution'`.

### Added -- ecosystem sinks

- **`createProfilerSignalSink()`** -- lifts leak-event counters into
  `@zakkster/lite-signal` signals (`leakCount`, `warningCount`,
  `findingCount`, `errorCount`, `lastLeakKind`, `lastWarningKind`).
  Users bind these to any HUD or effect. Batches related writes so
  effects fire once per event. Includes `reset()` and `dispose()`.
  Zero per-frame graph churn -- creates ~6 signals total at
  construction, mirroring the discipline of
  `@zakkster/lite-profiler-signal`.

- **`createStudioSink({ mount?, title?, maxLogRows?, zIndex? })`** --
  DOM overlay in the visual style of `@zakkster/lite-studio` (dark theme,
  monospace, fixed position). Rolling log of leak events, warnings,
  findings, errors, capped at `maxLogRows` (default 60). Companion to
  lite-studio's main panel; no dependency on lite-studio itself, just
  visual affinity. Ghost-safe: no signals, imperative DOM updates only.

### Added -- documentation

- `WHY-1.0.md` -- rationale for load-bearing decisions.
- `REJECTED.md` -- ledger of ten disqualified architectural approaches.

### Added -- tests

- **`test/retained-heap-full.test.js`** -- 5000-cycle retained-heap budget
  suite covering all six kernels under `--expose-gc`. Budget: 3 MB.
- **`test/sinks-ecosystem.test.js`** -- profiler-signal + studio sink
  coverage.
- **`test/hardening.test.js`** -- `MAX_OWNER_WALK` export, record contract
  resilience (null cleanup / null tag / audit=true), routeError behavior.

### Notes

- No breaking changes from 0.9.0.
- 212/212 tests pass across the full suite.
- All ecosystem sinks are optional -- consuming lite-leak without any sinks
  is fully supported.

## [0.9.0] - 2026-07-07

M2.5 -- ecosystem sinks. Adapters that route lite-leak events into other
`@zakkster/lite-*` packages.

### Added

- **`createTraceSink({ tracer, leakTagPrefix?, warningTagPrefix?, findingTagPrefix?, errorTag? })`**
  Routes leak reports, warnings, findings, and errors into
  `@zakkster/lite-trace` as zero-duration spans. Each event becomes
  `tracer.begin(tag); tracer.end()` -- a Perfetto-visible instant marker
  when the trace is exported via `toChromeTrace()`. Default tags:
  `lite-leak/leak/{kind}`, `lite-leak/warning/{kind}`,
  `lite-leak/finding/{kind}`, `lite-leak/error`.

- **`createGenericSink({ onLeak?, onWarning?, onFinding?, onError? })`**
  Composable sink adapter for arbitrary destinations (studio panels,
  observability pipelines, additional sinks). Swallows callback throws.
  Missing callbacks are no-ops.

- `sinks/` subdirectory added to `files[]`.

### Notes

- Sinks live in `sinks/Sinks.js`, re-exported from `Leak.js`.
- Trace sink is safe against tracer objects missing `begin`/`end` --
  no-ops silently.
- Compose two sinks by constructing both and dispatching each channel to
  both in the tracker's option callback (see README).

## [0.8.0] - 2026-07-07

M2 -- audit API extensions + `remediate()`.

### Added

- **`tracker.auditByKind(kind)`** -- convenience wrapper around `audit()`
  that filters findings by `kind`. Returns a fresh array.
- **`tracker.auditByOwner(ownerHandle)`** -- filters audit findings whose
  `ownerPath` contains the given owner handle's id. Requires the finding
  to carry `ownerPath: OwnerFrame[]`.
- **`tracker.remediate(finding)`** -- returns a human-readable remediation
  advisory string. Walks registered kernels in priority-then-registration
  order asking each for `advise(finding)`. First non-null string wins;
  else a generic fallback message.

### Added -- kernel shape extension

- Optional **`kernel.advise(finding) -> string | null`** -- kernel-provided
  advisory generator. Consumed by `tracker.remediate()`. Returning `null`
  passes the finding to the next kernel in the chain.

## [0.6.0] - 2026-07-07

M1-f -- `async-retention` kernel.

### Added

- **Kernel: `createAsyncRetentionKernel({ target?, warnOnNoOwner?, captureStacks?, priority? })`**
  Replaces `target.AbortController` (default `globalThis`) with a wrapper.
  Controllers created inside effect/computed auto-`abort()` on owner
  disposal via `onCleanup`. Controllers created outside any owner emit
  `onWarning` at construction time. `audit()` enumerates pending
  controllers with `no-owner-pending` and `owner-disposed-controller-pending`
  reasons.
  Patch surface: `'AbortController'`. Refines FR reports on tracked
  `'abort-controller'` records.
- Kernel exposes `advise(finding)` returning per-reason advisory text.
  Consumed by `tracker.remediate()` (M2). Interoperates with
  `@zakkster/lite-await`'s structural cleanup contract -- lite-await's
  own AbortController usage always wires abort into the settlement path,
  so kernels never fire on well-behaved lite-await code.

## [0.5.0] - 2026-07-07

M1-c + M1-d + M1-e -- three DOM-adjacent kernels shipped together.

### Added

- **Kernel: `createListenerOrphanKernel({ EventTarget?, warnOnNoOwner?, captureStacks?, priority? })`**
  Patches `EventTarget.prototype.addEventListener` / `removeEventListener`.
  Listeners registered inside an effect/computed auto-remove on owner
  disposal via `onCleanup`. Registrations outside any owner emit
  `onWarning` with `{ kind: 'listener-orphan', reason: 'no-owner-set',
  type, origin }`. Refines FR reports on tracked listener records.
  Patch surface: `'EventTarget.addEventListener'`.

- **Kernel: `createObserverOrphanKernel({ target?, warnOnNoOwner?, captureStacks?, priority? })`**
  Replaces `MutationObserver` / `ResizeObserver` /
  `IntersectionObserver` constructors on the target (default
  `globalThis`). Auto-`disconnect()` on owner disposal. No-owner
  construction emits `onWarning`. `audit()` enumerates pending observers
  with `no-owner-pending` / `owner-disposed-observer-pending` reasons.
  Refines FR reports. Patches only the constructors present on target.
  Patch surfaces: `'MutationObserver'`, `'ResizeObserver'`,
  `'IntersectionObserver'`.

- **Kernel: `createDetachedDomKernel({ root?, warnOnDetach?, captureStacks?, priority? })`**
  User-facing `kernel.watch(node, tag?)` opts nodes in. Installs a
  `MutationObserver` on the configured root (default `document`). When a
  watched node (or one of its ancestors) is removed from the tree without
  a prior `untrack`, emits `onWarning` with
  `{ kind: 'detached-dom', reason: 'detached-without-untrack', tag, origin }`.
  `audit()` walks `node.isConnected` and emits `detached-at-audit` for
  detached-but-still-watched entries. Patch surface: `'detached-dom.root'`
  (per-root uniqueness).

### Added -- test helpers

- `test/_helpers/dom.js` -- jsdom bootstrap matching the ecosystem's
  `lite-signal-dom/dom-setup.js` convention. Installs `document`, `Node`,
  `Element`, `EventTarget`, `MutationObserver`, `ResizeObserver`,
  `IntersectionObserver`, `Event`, `CustomEvent` on `globalThis`.
  Provides `flushObserver()` for microtask draining. `ResizeObserver` /
  `IntersectionObserver` are stubbed (jsdom lacks them) with real
  constructors that support `observe` / `disconnect` for kernel patching.

### Dependencies

- **Added devDep**: `jsdom`. Ecosystem-consistent; not shipped.

### Notes

- No breaking changes from 0.3.0.
- Three kernels shipped in one 0.5.0 bump per the plan.
- 141/141 tests pass across the full suite (35 new tests).

## [0.3.0] - 2026-07-07

M1-b -- `timer-orphan` kernel + timer/rAF test harnesses.

### Added

- **Kernel: `createTimerOrphanKernel({ target?, warnOnNoOwner?, captureStacks?, priority? })`**
  - Patches `target.setTimeout` / `clearTimeout` / `setInterval` /
    `clearInterval` / `requestAnimationFrame` / `cancelAnimationFrame`.
    Default target is `globalThis`; tests pass a mock harness.
  - Patches only methods present on target -- silently skips missing ones.
  - Timer set inside effect/computed body: auto-wires the appropriate
    clear/cancel on owner disposal via `onCleanup`.
  - Timer set outside any owner: emits `onWarning` at set-time with
    `{ kind: 'timer-orphan', reason: 'no-owner-set', timerKind, timerId }`.
    Suppressible via `warnOnNoOwner: false`.
  - Patch surfaces claimed: `'setTimeout'`, `'setInterval'`,
    `'requestAnimationFrame'`. Two of these kernels on one tracker throw
    `KernelConflictError`.
  - FR-refine path: classifies leak reports on tracked callback closures
    as `'timer-orphan'` with `timerKind`, `timerId`, `wasCleared`.
  - Audit path: enumerates currently-pending timers. Findings:
    `no-owner-pending` (module-scope timers still armed) and
    `owner-disposed-timer-pending` (engine-anomaly guard).
  - Uninstall restores originals AND leaves in-flight wrappers safe --
    they detect the null ctx and fall through to running cb directly.

### Added -- kernel context extension

- `ctx.track` and `ctx.untrack` exposed to kernels via `KernelContext`.
  Kernels track/untrack scoped to the parent tracker, not the module-level
  default.

### Added -- test helpers

- `test/_helpers/clock.js` -- `createMockClock()`: `setTimeout`,
  `clearTimeout`, `setInterval`, `clearInterval`, `advance(ms)`, `flush()`,
  `pendingCount`. Derived from the ecosystem's `createMockClock` pattern
  (see setup.js).
- `test/_helpers/raf.js` -- `createMockRaf()`: `requestAnimationFrame`,
  `cancelAnimationFrame`, `tick(time)`, `armedCount`. Adapted from the
  `installRaf/tick/armedCount` ecosystem harness.

### Notes

- No breaking changes from 0.2.0.
- kernels/ subdirectory continues to hold all detection kernels.
- 106/106 tests pass across the full suite.

## [0.2.0] - 2026-07-07

M1-a -- kernel infrastructure + first detection kernel.

### Added

- Pluggable kernel infrastructure: `tracker.registerKernel(kernel)` /
  `tracker.unregisterKernel(kernel)` / `tracker.audit()`
- Kernel shape: `{ name, patchSurfaces?, priority?, install?, uninstall?,
  refine?, audit? }`
- `KernelConflictError` -- thrown on duplicate kernel name or patch surface
- `KernelContext` passed to `install()`: `forEachAuditedHandle`, `emitWarning`,
  `emitFinding`, `reportError`, `trackerName`
- FR-time refinement chain: registered kernels' `refine(report, record)` are
  tried in priority-then-registration order; first non-null return wins
- Kernel priority: optional `kernel.priority` (default 0). Higher priority
  runs first; ties broken by registration order (stable). Prevents broad
  kernels registered early from masking specialised kernels registered late.
- On-demand `audit()` aggregates findings across all registered kernels
- Split reporting channels: `onFinding` (kernel-emitted, neutral),
  `onWarning` (kernel-emitted, pre-FR anomaly). `onLeak` still terminates
  the FR path.
- New optional 4th arg to `track()`: `{ audit: true }` opts in to
  owner-handle retention for audit-time inspection. Default off preserves
  M0 retention behavior byte-for-byte.
- **Kernel: `createOwnerCascadeOrphanKernel`** -- walks each audited
  handle's owner chain via `ownerOf`, compares against the frozen
  ownerPath snapshot. Findings: `{ kind: 'owner-cascade-orphan',
  brokenAt, reason: 'stale' | 'diverged' | 'kind-diverged' | 'truncated',
  liveFrame? }`. Zero global state, no patched globals.

### Error handling

- Kernel errors route to `onError` **and** log to `console.error` (per (i)
  + (iii)). Kernels never auto-uninstall on error; the chain continues.

### Safety

- `forEachAuditedHandle` uses two-phase reap (collect stale records during
  iteration, delete after) instead of mid-iteration `Set.delete()`. Safer
  on legacy runtimes and mobile browsers where mid-iteration deletion
  behavior can vary from spec.
- `snapshotOwnerPath` documents its allocation cost prominently: one
  `{id, kind}` object per owner hop plus one array. Bursty `track()` in
  large dynamic graphs (ECS mount storms) can trigger Scavenger GC
  pressure; guidance is to gate lite-leak behind a dev-only build flag.

### Notes

- No breaking changes from 0.1.0.
- kernels/ subdirectory added to `files[]`.

## [0.1.0] - 2026-07-06

M0 -- primitive layer. Kernels for leak classification land in 0.5.0.

### Added

- `createLeakTracker({ name?, captureStacks?, onLeak?, onError? })` factory
- `track(target, cleanup, tag?)` -> opaque handle
- `untrack(handle)` -- idempotent, null-safe; cancels FR without running cleanup
- `size()` -- live tracked-handle count
- Module-level `track` / `untrack` bound to a lazy default tracker
- Automatic `onCleanup` wiring when `track()` is called inside an
  `effect`/`computed` body -- clean owner disposal is not a leak
- Owner-path snapshot at track-time: `readonly OwnerFrame[]` of
  `{id, kind}` frames, non-retaining
- Opt-in `captureStacks` for call-site attribution (dev only)
- Structured `LeakReport` shape with `kind: 'unknown'` reserved for M1 kernels
- Full TypeScript declarations (`Leak.d.ts`)

### Guarantees

- Zero-GC steady state on `untrack` and FR callback
- Held-value contract documented and asserted: neither `cleanup` nor `tag`
  may close over `target`
- 4096-cycle leak probe and 10K-cycle retained-heap budget

### Dependencies

- `@zakkster/lite-cleanup ^1.0.0` (runtime)
- `@zakkster/lite-signal >=1.5.0-beta.3 <2.0.0` (peer)

### Notes

- Requires `FinalizationRegistry` (Node 20+, all modern browsers)
- ASCII-only source, single file
