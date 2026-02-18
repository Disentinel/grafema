## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

Grafema's vision is "AI should query the graph, not read code." This task is infrastructure — it unifies
how the RFDB server starts up. That's squarely in the right direction: a reliable, always-on graph server
is the prerequisite for the graph being the superior way to understand code. If the server is fragile,
inconsistent in how it launches, or riddled with duplicate spawn logic, agents can't trust the graph.

This task fixes exactly that. Before: three separate spawn sites with diverging logic, socket path bugs,
and no explicit lifecycle commands. After: one authoritative `startRfdbServer()` function, correct socket
paths everywhere, and `grafema server start/stop/status/restart` for explicit control.

This is not a feature that competes with the vision — it enables it.

### Architecture

**Complexity check (mandatory):** `startRfdbServer()` does no graph traversal. It spawns one OS process
and polls one file path. O(1). No iteration over nodes or edges. No RED FLAG.

**Duplication elimination:** The consolidation from three spawn sites to one is correct. Each caller
(RFDBServerBackend, CLI server command, ParallelAnalysisRunner) now delegates cleanly. This is the right
abstraction boundary — spawn logic belongs in one place, callers handle their own lifecycle concerns.

**Socket path consistency:** The fix to derive socket path as `dirname(dbPath) + /rfdb.sock` is correct
and consistent. Previously analysis-worker.ts had a hardcoded path that diverged from what the backend
computed. Now all three sites agree. This is the kind of silent correctness bug that causes mysterious
failures in production; fixing it here is essential.

**`autoStart` option in RFDBServerBackend:** The addition of `autoStart: false` mode gives operators
explicit control, which is good. The default remains `true` for backwards compatibility. This is pragmatic
and correct — don't break existing workflows while enabling new ones.

**Deprecation of `startServer()` in rfdb-server/index.js:** Correct call. The package-level API was
duplicating functionality that belongs in `@grafema/core`. Marking `getBinaryPath()` as deprecated while
keeping it available is the right migration path.

**CLI lifecycle commands:** `grafema server start/stop/status/restart` are necessary for the dogfooding
workflow described in CLAUDE.md. Before this task, the docs said to run a raw `rfdb-server` command
directly. Now there is a proper CLI surface. This is unambiguously better.

**`restart` command:** The restart implementation correctly stops then starts, re-using the shared
`startRfdbServer()` utility. No duplication. Stop logic is inline (not extracted), which is acceptable
at this scale — the stop path is short and contextual.

**PID file:** Optional, written only when `pidPath` is provided. The `status` command reads it for
display. Lightweight and correct.

**Tests:** 10 unit tests using dependency injection (`_deps`). This is the correct pattern for testing
process spawning without actually spawning processes. Tests cover binary resolution, stale socket
cleanup, PID file handling, timeout, logger integration, error handler wiring, and spawn arguments.
That is the right set of cases. Tests are self-contained and deterministic.

**Net -22 lines:** Removing more code than added is the sign of real cleanup. This is not scope creep
or feature addition masquerading as refactoring.

### One Observation (Not a Blocker)

The `restart` command in `server.ts` (lines 319-423) duplicates the binary resolution logic that is
also in `start` (lines 86-178): the same `options.binary → config → auto-detect` cascade appears
twice. This should be extracted to a shared helper inside `server.ts` at some point. It is small
enough not to block this PR, and is entirely within one file, but it is the kind of duplication that
grows. Worth a tech debt note.

### Summary

This is infrastructure done right. One canonical spawn function, correct socket paths, proper CLI
lifecycle, deprecation of dead API surface, unit tests with DI, net line reduction. Nothing here
embarrasses us. The graph server is now more reliable and consistent, which directly serves the product
vision.
