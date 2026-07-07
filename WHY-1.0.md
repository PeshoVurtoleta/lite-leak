# WHY 1.0

Design decisions worth writing down before v1.0 ships. The audience for this
document is the person maintaining `@zakkster/lite-leak` in six months, or
Andrii Volynets running a code review against the ecosystem.

## FR is a safety net, not the primary path

`FinalizationRegistry` timing is non-deterministic. Callbacks fire "at some
point after" the target becomes unreachable, subject to when V8 decides to
run a full GC. Fired callbacks may batch, may run on a delay measured in
seconds, and may not fire at all if the process exits first.

**We do not rely on FR for correctness of anything.** The primary leak-
detection mechanism in `lite-leak` is:

1. `track()` inside an effect body auto-registers `onCleanup(() => untrack())`.
2. When the owner disposes cleanly, `untrack()` fires deterministically,
   synchronously, in the same tick as the disposal.
3. FR is armed as a backstop. If the auto-untrack path fires, `handle.disposed`
   is set, and lite-cleanup's finalize callback checks that flag and no-ops.
4. FR fires only in the pathological case where the target became unreachable
   *without* prior untrack. That's the operational definition of a leak.

Callers who want deterministic notification use `onCleanup` themselves; kernels
that need to react to disposal (timer-orphan clearing pending timers,
observer-orphan disconnecting instances) also wire `onCleanup` directly. FR
is what tells us we missed a case.

Because FR is non-deterministic, `onLeak` may fire seconds or minutes after
the actual leak occurred. That's acceptable for a diagnostic tool; it's not
acceptable for a control mechanism. Nothing in `lite-leak` uses FR to gate
program behavior -- only to raise diagnostic alerts.

## Auto-untrack via `onCleanup` was the right call

The design considered three options for `track()` inside an owner:

1. **Manual untrack.** Caller must pair every `track()` with `untrack()`.
   Simple, but users forget -- the leak-tracker itself leaks entries.
2. **`WeakRef`-based auto-cleanup.** Store target as a `WeakRef`; reap
   entries when the ref goes null. Rejected: `WeakRef` deref returns
   `undefined` non-deterministically, and enumerating live entries during
   audit requires walking every entry checking for `undefined`. Adds cost
   per audit call proportional to lifetime entry count, not live entry count.
3. **`onCleanup` auto-wiring.** Track inside owner registers `onCleanup(() =>
   untrack())`. Chosen.

Option 3 makes clean owner disposal a first-class contract. The leak semantic
becomes *precise*: a leak is defined as "target GC'd without its owner having
run cleanup." Well-behaved code never fires FR; ill-behaved code fires FR
exactly when the cleanup cascade breaks.

This composability is the ecosystem's core discipline: `lite-signal`'s
`onCleanup` was designed to make disposal cascades explicit; `lite-leak`
piggybacks on that discipline rather than inventing its own.

## No `forEachRoot` in the engine

Extended discussion in the rejection ledger (see `REJECTED.md#foreachroot`).
Summary: adding root enumeration to `@zakkster/lite-signal` would either
require the engine to hold strong references to every root (making leaks
invisible to FR and to the tool that's supposed to detect them), or use
`WeakRef` (making enumeration non-deterministic and per-call allocating).
Either way, the diagnostic tool would change the retention graph it
diagnoses -- disqualifying.

The `owner-cascade-orphan` kernel walks from the tracker's own inventory of
audited handles upward via `ownerOf`. That's O(audited) per audit call,
zero engine changes, no retention delta, and precisely as much information
as we need.

## `effect-orphan` collapsed into `owner-cascade-orphan`

An earlier plan had `effect-orphan` as the seventh detection kernel. During
M1-a design the two collapsed:

- `owner-cascade-orphan` walks a tracked handle's owner chain upward and
  flags when a stale/diverged/truncated frame appears.
- `effect-orphan` would have flagged effects whose owner tree broke.

The mechanism is identical: walk owner chains, compare against snapshots,
report divergence. The only differences would be which nodes were being
inspected (any tracked handle vs. effect-classified handles) and the finding
`kind`. That's a filter on the same data, not a separate detector.

Rather than ship two kernels that were 90% identical code, we ship one
kernel and let `auditByKind` / `finding.kind` filter as needed. The `kind`
field in `owner-cascade-orphan` findings could be extended in a future
minor to include an `elementKind: 'effect' | 'computed' | 'signal'` derived
from the handle's own descriptor -- but that would be additive.

The seven-kernel target from the original roadmap is met with six kernels
plus the `owner-cascade-orphan` covering both roles. The advantage: less
code to maintain, one shared inspection routine, less user confusion about
which kernel to reach for.

## Held-value contract

Two rules for `track(target, cleanup, tag)`:

1. `cleanup` must not close over `target`.
2. `tag` must not close over `target`.

Both are because those values are retained on the internal record until
FR fires or `untrack` is called. Capturing `target` via either defeats
finalization -- the target stays reachable through the record, the FR never
fires, the leak is invisible.

This rule is un-enforceable at runtime. It's caller discipline. The tests
verify the mechanism works when the contract is honored; if a user violates
it, their FR path just silently doesn't fire. That's a documented failure
mode, not a bug.

`lite-observe` and `lite-floating` codified this rule when they inlined
their own `FinalizationRegistry` usage. Extracting the pattern into
`@zakkster/lite-cleanup` and documenting it as *the* rule for FR-based
disposal is what lets `lite-leak` sit on top of the primitive cleanly.

## Priority-based kernel ordering

Kernels register with an optional `priority` field (default 0). Higher
priority runs first in the FR-refine chain and audit iteration; ties broken
by registration order.

Considered documentation-only ("register specialized kernels first") but
rejected. Docs aren't enforced. A user who reads the docs writes correct
code; a user who doesn't gets silent masking. Priority is O(n) insertion
where n is tiny (a handful of kernels), no per-refine cost, and makes the
correct behavior available to code that doesn't know the docs.

## Sinks compose via fanout, not automatic combining

Multiple sinks are combined by dispatching the tracker's option callback
to each sink explicitly:

```js
onLeak: (r) => { trace.onLeak(r); studio.onLeak(r); profiler.onLeak(r); }
```

This is verbose. Considered building an `combineSinks(...sinks)` helper
that returns a sink whose channels fan out. Rejected: the fanout is exactly
what the user is doing anyway, one indirection removed. Making it magical
via a helper hides the ordering (which sink fires first? does it matter?),
hides the failure mode (what if one throws?), and adds a factory that
provides no new capability. Explicit fanout is at most three or four lines
per tracker construction and reads as what it does.

## FR-refine chain semantics

The chain runs kernels in priority-then-registration order, taking the
first non-null return. Alternatives considered:

- **All kernels fire; last-one-wins.** Rejected: hides which kernel
  classified. Bad for debugging.
- **All kernels fire; return an array.** Rejected: consumer would have to
  pick one anyway; deferring that decision to the consumer is more work,
  not less.
- **First non-null wins.** Chosen. Deterministic, cheap, and forces the
  design decision (which kernel is authoritative for this record class?)
  to the priority assignment where it belongs.

Kernels are expected to identify their records by tag shape (`tag.kind`
matches). A kernel that doesn't recognize the tag returns `null` and the
chain continues. That's the composable primitive.

## Advisories via `kernel.advise()` not centralized dictionary

`remediate(finding)` asks each kernel for advice on the finding. Alternatives:

- **Centralized advisory dictionary in `Leak.js`.** Rejected: every kernel
  would need `Leak.js` to know about it; adding a new kernel would require
  editing the main module.
- **Static advisories on the finding object.** Rejected: findings are
  structured data, not text carriers. Also, the same finding might get
  different advice based on runtime context (e.g. is lite-await installed?);
  static text can't handle that.
- **Kernels provide advisories.** Chosen. The kernel that knows how to
  detect a class of leak also knows how to describe fixing it. Sinks and
  UIs consume the text via `tracker.remediate()`. Multi-kernel systems
  compose via priority.

## What was rejected outright

See `REJECTED.md`. Nine architectural approaches that could plausibly have
shipped but were disqualified for concrete reasons.

## Testing philosophy

Three principles the test suite is written under:

1. **Hermetic where possible.** Mock DOM via jsdom (matching ecosystem
   convention); mock clocks and rAF; no real network, no real timers.
2. **Synthetic where necessary.** Pathological cases (broken cascades,
   stale handles) are constructed by hand-crafting records the kernels
   inspect. The kernels are pure functions of (handle, record); tests
   verify the pure function does the right thing given synthetic input.
3. **Live where load-bearing.** The end-to-end integration tests use
   real `lite-signal` effects, real DOM operations under jsdom, real
   `AbortController` instances. Those verify the integration seams, not
   just the kernel logic.

The 175 tests split roughly 50/50 between kernel-unit and integration.
Retained-heap tests skip cleanly without `--expose-gc`; the rest run
without special flags.

## What v1.0 does not include

- **`bench/` directory.** The kernels are dev-only; hot-path perf is
  covered by the retained-heap suite. If real perf regressions bite, add
  `bench/gate.mjs` in a later minor using `@zakkster/lite-perf-gate`.
- **A dedicated `lite-devtools` panel adapter.** Sinks + generic fanout
  cover the integration. If the panel wants first-class support later,
  add `createDevtoolsPanelSink()` as a thin adapter.
- **`lite-leakforge`.** The forge-tier priority-tier demo lives in a
  separate package. `lite-leak` remains the library; `lite-leakforge`
  will be the demo/toolkit built on top.

## The lifespan of these decisions

Everything above is versioned. If the ecosystem's discipline shifts, the
right response is to update this document alongside the decision.
Rejection reasons are worth keeping longer than the code they blocked --
the reason a design was rejected in 2026 is usually still the reason in
2027.
