## Uncle Bob PREPARE Review: REG-487

**Task context:** Adding `covers` / `consumes` metadata fields to `PluginMetadata`, propagating them through `PluginContext`, and using them in `PhaseRunner.runPhase()` for selective ANALYSIS plugin filtering and ENRICHMENT propagation.

---

## File 1: `packages/rfdb/ts/client.ts`

**File size:** 1242 lines — CRITICAL (>500 lines)

**Methods we will modify:** `commitBatch()` (lines 1093–1150, ~58 lines)

**File-level:**
- At 1242 lines this file is large. However it is a single class (`RFDBClient`) that is a protocol-level socket client — all methods are cohesive (they are all RPC calls or protocol helpers). SRP is satisfied: one class, one transport abstraction. The sections are logically grouped by clear dividers (Write / Read / Traversal / Stats / Batch / etc.). Splitting it would require extracting sub-clients, which would be architectural, not a local cleanup.
- Recommendation: accept the size. The class is a thin, flat list of RPC wrappers with zero nesting — size does not indicate complexity here.

**Method-level: `commitBatch()` (lines 1093–1150, ~58 lines)**
- Slightly over the 50-line soft limit.
- The body has a clear two-branch structure: small batch (fast path, ~5 lines) vs. chunked batch (loop, ~30 lines with delta merging).
- The chunked path could be extracted to a private `_commitChunked(allNodes, allEdges, changedFiles, tags)` method (~25 lines), leaving `commitBatch` as a clean dispatcher (~20 lines).
- **Recommendation: REFACTOR** — extract `_commitChunked()`. Low risk (pure private helper), improves readability, reduces `commitBatch` to a single-responsibility dispatcher.
- Parameter count: 1 (optional `tags`). OK.
- Nesting depth: 2. OK.

**Risk:** LOW
**Estimated scope:** ~10 lines moved, no logic change

---

## File 2: `packages/core/src/storage/backends/RFDBServerBackend.ts`

**File size:** 859 lines — CRITICAL (>500 lines)

**Methods we will modify:** `commitBatch()` (lines 773–776, 4 lines — pure delegation to `this.client.commitBatch()`)

**File-level:**
- 859 lines in a single class. However, the class is a backend adapter: it wraps every method of `RFDBClient` and translates input/output types. This is the Adapter pattern — all methods are related to the same responsibility (adapting between `InputNode/InputEdge` and `WireNode/WireEdge`).
- The large size is a design consequence of having ~30 proxy methods. Splitting would require extracting e.g. `RFDBEdgeAdapter` + `RFDBNodeAdapter`, which is architectural, beyond PREPARE scope.
- No method over 50 lines in the relevant surface area.

**Method-level: `commitBatch()` (lines 773–776)**
- 4 lines. Pure delegation. Nothing to refactor.
- `batchNode()` (lines 782–798, ~17 lines): protocol-awareness logic is inlined. Acceptable.
- `batchEdge()` (lines 803–815, ~13 lines): acceptable.

**Recommendation: SKIP** — no actionable refactoring in the methods we will touch. The file size is large but stable and low-risk.

**Risk:** LOW
**Estimated scope:** 0 lines

---

## File 3: `packages/core/src/plugins/Plugin.ts`

**File size:** 117 lines — OK

**Methods we will modify:** The `PluginContext` type is imported from `@grafema/types`, not defined here. The Plugin base class is 117 lines with clear, short methods.

**File-level:** Single responsibility, clean. No issues.

**Method-level:**
- `log()` (lines 79–115, ~37 lines): slightly long due to the console-fallback `Logger` construction, but self-contained and readable. Not in scope for REG-487.
- No methods we'll directly modify are above 50 lines.

**Recommendation: SKIP** — file is clean, no refactoring needed.

**Risk:** LOW
**Estimated scope:** 0 lines

---

## File 4: `packages/core/src/PhaseRunner.ts`

**File size:** 494 lines — OK (under 500)

**Methods we will modify:**
- `runPhase()` (lines 307–400, ~93 lines) — CANDIDATE FOR SPLIT
- `extractServiceDependencies()` (lines 183–222, ~40 lines) — OK
- `executePlugin()` (lines 229–305, ~77 lines) — borderline

**File-level:** Single class, single responsibility (phase execution). OK.

**Method-level: `runPhase()` (~93 lines)**
- Over the 50-line limit. The method does four distinct things:
  1. Filter plugins for this phase
  2. Toposort + build dependency graph
  3. Decide propagation strategy (ENRICHMENT + batch vs. fallback)
  4. Execute the fallback sequential loop with ANALYSIS filter

- REG-487 will add more logic to the ANALYSIS filter block (lines 354–376). Adding to a 93-line method risks pushing it toward 110+ lines.
- **Recommendation: REFACTOR** — extract the sequential fallback loop (lines 358–398) to a private `_runSequentialPhase()` helper. This leaves `runPhase()` as a ~50-line dispatcher and gives the sequential loop a clear name.
- The extraction is purely mechanical: no logic change, just a private method boundary.

**Method-level: `executePlugin()` (~77 lines)**
- Over 50 lines but the body is a flat try/catch with sequential steps (build context, run batch, log, collect diagnostics, check fatal). Not modified by REG-487.
- **Recommendation: SKIP** — not in REG-487 scope, non-trivial to split without changing the fatal-error detection logic.

**Risk:** LOW
**Estimated scope:** ~40 lines moved into `_runSequentialPhase()`

---

## File 5: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**File size:** 4094 lines — CRITICAL (>>500 lines, >>700 lines)

**Methods we will modify:** `execute()` (lines 342–481, ~140 lines)

**File-level:**
- 4094 lines is extreme. However, this file is a known god-object that pre-dates the PREPARE process. The complexity is in the AST visitor logic, which has been partially extracted to `ast/visitors/` submodules.
- REG-487 adds a `covers` metadata field to `PluginMetadata`. The only change to `JSASTAnalyzer` is populating that field in `get metadata()` — a 1-2 line change. No structural impact.
- A full split of `JSASTAnalyzer` is beyond PREPARE scope (>20% of task time, high risk). Create a tech debt issue instead.

**Method-level: `execute()` (lines 342–481, ~140 lines)**
- Far over the 50-line limit. The method orchestrates: guard/setup, module filtering, conditional parallel-vs-sequential dispatch, queue setup, pool event handlers, completion stats.
- However, the parallel dispatch (`executeParallel`) is already extracted. The sequential path is ~80 lines.
- REG-487 does NOT modify `execute()` directly — only `get metadata()` (5-10 lines). The execute method stays as-is for this task.

**Method-level: `get metadata()` (lines 255–338, ~84 lines)**
- This is a large metadata object definition. REG-487 adds `covers: ['express', 'axios', ...]` — a one-liner addition.
- **Recommendation: SKIP refactoring** — the metadata getter is data, not logic. Size doesn't indicate complexity here.

**Recommendation: SKIP** — changes for REG-487 are surgical (add one field to `get metadata()`). Full file refactor would exceed 20% task budget and is high-risk.

**Tech debt to create:** `JSASTAnalyzer.ts` at 4094 lines violates file size limits. Needs incremental decomposition (separate issue, not this task).

**Risk:** LOW for this task (1-2 line change in `get metadata()`)
**Estimated scope:** 0 refactoring lines

---

## File 6: `packages/core/src/Orchestrator.ts`

**File size:** 524 lines — CRITICAL (>500 lines)

**Methods we will modify:** None directly. `Orchestrator.runPhase()` (lines 474–476) is a 3-line delegation to `phaseRunner.runPhase()`. No changes needed here.

**File-level:**
- 524 lines, slightly over the 500 limit. The file has been previously refactored (REG-462) and now delegates to `PhaseRunner`, `GraphInitializer`, `DiscoveryManager`, `GuaranteeChecker`, `ParallelAnalysisRunner`. The constructor is long (~75 lines) due to initializing all the delegated objects.
- No further splitting is needed for REG-487.

**Method-level: `run()` (lines 159–258, ~99 lines)**
- Over 50 lines. However, `run()` is the main analysis pipeline coordinator — it is intentionally sequential. NOT in REG-487 scope.

**Method-level: `runMultiRoot()` (lines 265–358, ~93 lines)**
- Over 50 lines. NOT in REG-487 scope.

**Recommendation: SKIP** — no methods we directly modify. The 3-line delegation is trivial.

**Risk:** LOW
**Estimated scope:** 0 lines

---

## Rust Files

### File 7: `packages/rfdb-server/src/graph/engine.rs`

**File size:** 3351 lines — CRITICAL

**Methods we will modify:** None. REG-487 is TypeScript-only (plugin metadata + phase filtering). The Rust server is not modified.

**Recommendation: SKIP** — no Rust changes in REG-487.

---

### File 8: `packages/rfdb-server/src/graph/mod.rs`

**File size:** 157 lines — OK

**Recommendation: SKIP** — no changes needed, file is clean.

---

### File 9: `packages/rfdb-server/src/bin/rfdb_server.rs`

**File size:** 4162 lines — CRITICAL

**Key concern: `handle_request()`** (lines 766–1476, ~710 lines) is a massive match arm dispatcher. This is a known architectural pattern for protocol handlers in Rust (single match over all command variants). For REG-487, no changes are made to this file.

**`handle_commit_batch()`** (lines 1476–1590, ~114 lines) — over 50 lines but Rust. Not in scope.

**Recommendation: SKIP** — no Rust changes in REG-487. The large functions are pre-existing tech debt.

---

## Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `packages/rfdb/ts/client.ts` | 1242 | CRITICAL (size) | REFACTOR: extract `_commitChunked()` from `commitBatch()` |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 859 | CRITICAL (size) | SKIP: delegation only, no logic to clean |
| `packages/core/src/plugins/Plugin.ts` | 117 | OK | SKIP |
| `packages/core/src/PhaseRunner.ts` | 494 | OK | REFACTOR: extract `_runSequentialPhase()` from `runPhase()` |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 4094 | CRITICAL (extreme) | SKIP: surgical 1-line change; file too large to refactor safely in this task |
| `packages/core/src/Orchestrator.ts` | 524 | CRITICAL (size) | SKIP: 3-line delegation, no changes needed |
| `packages/rfdb-server/src/graph/engine.rs` | 3351 | CRITICAL (size, Rust) | SKIP: no Rust changes |
| `packages/rfdb-server/src/graph/mod.rs` | 157 | OK | SKIP |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | 4162 | CRITICAL (size, Rust) | SKIP: no Rust changes |

## Recommended Refactoring Before Implementation

**Two targeted refactors, both low risk:**

### Refactor 1: `client.ts` — extract `_commitChunked()`

Split `commitBatch()` at line 1093 into:
- `commitBatch()` (~20 lines): state reset + fast-path single-chunk + delegate to `_commitChunked()`
- `_commitChunked(nodes, edges, changedFiles, tags)` (~35 lines): the loop with delta merging

No logic change. Purely extracting the else-branch of the existing fast-path check.

### Refactor 2: `PhaseRunner.ts` — extract `_runSequentialPhase()`

Split `runPhase()` at line 307 into:
- `runPhase()` (~50 lines): setup (filter, toposort, strategy decision) + delegation
- `_runSequentialPhase(phasePlugins, phaseName, context, serviceDeps)` (~45 lines): the `for` loop at lines 358–398

This keeps `runPhase()` under 50 lines and gives the REG-487 logic (ANALYSIS filter) a clean home inside `_runSequentialPhase()`.

## Tech Debt Issues to Create

1. `JSASTAnalyzer.ts` at 4094 lines — incremental decomposition needed (separate REG issue, v0.2)
2. `client.ts` at 1242 lines — could be split into connection/protocol vs. commands, but cohesion is acceptable now
3. `rfdb_server.rs` `handle_request()` at ~710 lines — Rust architectural debt (RFD team)
