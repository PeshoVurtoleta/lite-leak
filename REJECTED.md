# Rejected

An accumulated ledger of architectural approaches that could plausibly have
shipped but were disqualified. Each entry is the design, the reason, and
the alternative that was chosen instead.

## `forEachRoot()` in `@zakkster/lite-signal`

**Design.** Add an engine-level enumeration of top-level owner-tree roots so
that `owner-cascade-orphan` (and future tools) can walk from every root
downward via `forEachOwned`, comparing against the tracker's own inventory.

**Rejected on three counts:**

1. **The strong-ref trap.** A global `Set<Node>` of roots means the engine
   retains every root that was ever created until someone explicitly
   disposes it. That's the exact failure mode `lite-leak` exists to
   diagnose -- a user drops the `createRoot` disposer, the tree stays
   alive. If the engine itself holds the strong ref, the leak is invisible
   to `FinalizationRegistry` too, because the node is still reachable.
   The diagnostic tool doesn't just fail to find the leak, it causes the
   leak. Disqualifying on its own.

2. **`WeakRef` doesn't escape the trap.** `new WeakRef(node)` on every
   `createRoot` is a heap allocation on a hot path (any consumer using
   ownership trees hits it -- `lite-query`, `lite-headless`, `lite-observe`
   internally). Enumeration also becomes non-deterministic: `forEachRoot`
   returns a different set depending on whether V8 ran a scavenge since
   the last orphan was dropped. A test that asserts "there should be 3
   roots" can pass five times and fail on the sixth because GC happened
   to collect a fourth root's `WeakRef` between two calls. You can't
   build a reliable leak detector on a non-deterministic enumerator.

3. **Dev/prod asymmetry is long-term poison.** Even behind `__DEV__`, a
   strong-ref registry changes the retention graph. Users profiling
   memory in dev see a different picture than production. An app that
   leaks in prod might look clean in dev (the root registry keeps
   everything alive), or vice versa. Either way the dev experience lies
   to the developer.

**Chosen instead.** `owner-cascade-orphan` walks upward from the tracker's
own audited-handle inventory via `ownerOf`. Zero engine changes, zero
retention delta, O(audited handles) per audit call. The engine stays
deterministic and retention-neutral; `lite-leak` carries its own
`WeakRef`/`FinalizationRegistry` machinery, documents its allocation
cost, and gates itself behind an explicit `{ audit: true }` opt-in.

## `effect-orphan` as a separate kernel

**Design.** Ship seven kernels total: `owner-cascade-orphan`, `effect-orphan`,
`detached-dom`, `listener-orphan`, `timer-orphan`, `observer-orphan`,
`async-retention`. `effect-orphan` flags effects whose owner tree broke.

**Rejected.** The mechanism collapses into `owner-cascade-orphan`. Both
walk owner chains, compare against snapshots, report divergence. The only
differences would be which nodes are inspected (any tracked handle vs
effect-classified) and the `kind` field. That's a filter on the same
data, not a separate detector.

**Chosen instead.** Six kernels, with `owner-cascade-orphan` covering both
roles. If a future minor wants effect-specific findings, extend the
existing kernel with an `elementKind` field derived from the descriptor.
Six kernels shipped; the seven-target from the roadmap is met.

## Per-package inlined `FinalizationRegistry`

**Design.** Every package that needs FR-based cleanup inlines the pattern
(one `FinalizationRegistry` per module, held-value contract, `disposed`
guard). This is what `lite-observe` and `lite-floating` shipped with in
1.0.

**Rejected for anything new.** The pattern is subtle (the held-value rule
alone is easy to get wrong), and duplicating it across N packages means
N places to audit for correctness. Any bug found in one has to be found
in the others by hand.

**Chosen instead.** Extract to `@zakkster/lite-cleanup` 1.0.0 as the canonical
primitive. `lite-observe` and `lite-floating` cut over in patch releases
with no behavior change; `lite-leak` consumes it. One place to audit, one
place to document, one place to test the load-bearing rule.

## `WeakRef`-based leak enumeration

**Design.** The tracker holds tracked targets via `WeakRef` so it doesn't
retain them. `audit()` walks the tracker's inventory, dereferences each
`WeakRef`, and skips `undefined`s (which indicate GC).

**Rejected on two counts:**

1. **Non-deterministic enumeration.** Same as the `forEachRoot` case. GC
   timing controls what audit sees; two consecutive audit calls can
   return different sets.

2. **Allocation per track.** Every `WeakRef` construction is a heap
   allocation. For a diagnostic that a user might reach for during a
   perf-sensitive dev session, adding allocations to track paths is
   backwards.

**Chosen instead.** Direct references from the tracker's records to the
targets, with the FR mechanism providing the "target became unreachable"
signal via `onCollect`. The tracker's own records are what `audit()`
iterates; that inventory is deterministic and cheap.

## Kernel priority via docs-only

**Design.** Kernels are stored in registration order. Documentation
instructs users to register specialized kernels before generic ones so
the FR-refine chain doesn't get masked.

**Rejected.** Docs aren't enforced. A user who reads the docs writes
correct code; a user who doesn't gets silent masking. The failure mode is
invisible: all the tests pass, refine returns the wrong classification,
and the leak report says "unknown" or "the wrong thing" instead of what
the specialized kernel would have said. That's the worst kind of bug --
silent, correct-looking, wrong.

**Chosen instead.** `kernel.priority` (default 0). Higher priority runs
first; ties broken by registration order. Enforced by the tracker. Docs
still explain the reasoning, but the correct behavior is achievable
without reading them.

## Mid-iteration `Set.delete()` in `forEachAuditedHandle`

**Design.** Iterate `auditedRecords` with `for..of`; delete disposed
records inline during iteration.

**Rejected.** ES2015 Set iterators handle mid-iteration deletion of the
current key, but the pattern is fragile on legacy runtimes and mobile
browsers where iterator semantics can vary from spec. `lite-leak` may
run on the same hardware profile that hits Zahary's testbed (10-year-old
mobile), where iterator behavior isn't guaranteed to match V8.

**Chosen instead.** Two-phase reap: identify stale records into a lazily-
allocated array during iteration, delete after the loop. Spec-clean on
any ES2015 engine. Allocation cost only when stale entries exist (rare in
healthy code).

## `record.audit !== true` verbose form

**Design.** Guard against `undefined`/non-boolean audit field with strict
comparison: `if (record.audit !== true) return null`.

**Rejected as unnecessary verbosity.** The tracker coerces the field to
strict boolean at the `track()` boundary (`const audit = opts.audit === true`).
Downstream code that reads `record.audit` sees a definite boolean, so
`if (!record.audit)` and `if (record.audit !== true)` are equivalent.

**Chosen instead.** `if (!record.audit)`. The strict `=== true` boundary
check stays for coercion; downstream uses the terse form.

## `combineSinks(...sinks)` helper

**Design.** A helper that takes N sinks and returns a single sink whose
channels fan out to each in registration order.

**Rejected.** The fanout is what the user is doing anyway, one indirection
removed. Making it magical via a helper hides the ordering (which sink
fires first? does it matter?), hides the failure mode (what if one
throws?), and adds a factory that provides no new capability.

**Chosen instead.** Explicit fanout in the tracker's option callback.
Three or four lines per tracker, reads as what it does, no hidden
semantics.

## Object.create(null) for owner-path frame allocations

**Design.** Use `Object.assign(Object.create(null), { id, kind })` for each
owner-path frame instead of a plain object literal, avoiding prototype-
chain lookup cost.

**Rejected.** For a two-field diagnostic record accessed a handful of
times per audit, the prototype-chain savings are unmeasurable. The
`Object.create(null)` idiom pays a construction cost (an extra function
call) to save an access cost (a hidden-class lookup) -- and V8's
monomorphic-access optimization makes the plain literal cheaper in
practice.

**Chosen instead.** Plain object literal `{ id: cursor.id, kind: cursor.kind }`.
Frozen `EMPTY_OPTIONS = Object.freeze(Object.create(null))` retained for
the shared default options constant, where the construction cost is
paid once and reads happen everywhere.

## Automatic instrumentation via patched globals for every kernel

**Design.** Every kernel could patch its target globals unconditionally
at install time (no per-call opt-in). Timer kernel patches `setTimeout`
worldwide; listener kernel patches `addEventListener` on every EventTarget
subclass; etc. Users get automatic detection with zero setup beyond
registerKernel.

**Rejected as too invasive.** Patching global constructors and prototype
methods has ripple effects that a diagnostic library shouldn't force.
Framework internals, other libraries, third-party scripts all route
through the same patched functions. Silent behavior changes at the global
level are hostile.

**Chosen instead.** Kernels patch a configurable `target` (default `globalThis`
or the appropriate prototype); tests pass mocks. Users can scope patching
to a specific subclass or object. The default is convenient; the override
is available when convenience causes problems.

## `bench/gate.mjs` in v1.0.0

**Design.** Ship a `bench/` directory with `@zakkster/lite-perf-gate`-based
benchmarks for every kernel's hot paths (track, untrack, refine, audit).

**Rejected for v1.0.0.** The kernels are dev-only tools; hot-path perf is
covered by the retained-heap suite. Adding a full bench suite would add
another package dependency and another CI dimension without a concrete
regression to prevent.

**Chosen instead.** Ship v1.0.0 without `bench/`. If a real perf regression
bites in the field, add `bench/gate.mjs` in a later minor version using
`@zakkster/lite-perf-gate`. The infrastructure is in place; the trigger
just hasn't fired yet.
