## Uncle Bob — Code Quality Review

**Verdict:** APPROVE (with noted issues)

---

**File sizes:** CRITICAL — two files exceed the hard limit
**Method quality:** OK — new methods are clear and focused
**Patterns & naming:** WARN — one visibility issue, one debug statement introduced

---

### File Size Analysis

| File | Lines | Status |
|------|-------|--------|
| `packages/rfdb-server/src/graph/engine.rs` | 3,790 | PRE-EXISTING CRITICAL — not introduced by this task |
| `packages/rfdb/ts/client.ts` | 1,324 | PRE-EXISTING CRITICAL — was 1,242 before, +82 lines |
| `packages/core/src/Orchestrator.ts` | 611 | PRE-EXISTING CRITICAL — was 524 before, +87 lines |
| `packages/core/src/PhaseRunner.ts` | 499 | OK |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 4,108 | PRE-EXISTING CRITICAL |

**Important context:** All files that exceed the 500-line limit were already in violation before REG-487. This task added ~82 lines to `client.ts` and ~87 lines to `Orchestrator.ts`. Neither addition makes the situation materially worse relative to the limit they were already blowing past. The violations must be tracked as tech debt but do not warrant blocking this task — the work should not be penalized for pre-existing conditions it did not create.

---

### Method Quality

#### `flush_data_only()` in `engine.rs` (~145 lines)

The method is clear and its purpose is well-stated in the doc comment. The structure is logical: early-exit for empty delta, early-exit for ephemeral, data collection, disk write, clear delta, reload segments (without index rebuild). The trailing SKIP comments at lines 1437–1439 clearly explain what was intentionally omitted.

**Issue: Code duplication with `flush()`.**

The data-collection body of `flush_data_only()` (lines 1316–1413) is a near-verbatim copy of the corresponding section in `flush()` (lines 1120–1221). Both collect all nodes from segment + delta with deduplication, collect all edges with deduplication, write to disk via `SegmentWriter`, update metadata, clear delta state, and reload segments. Approximately 120 lines are duplicated.

The correct factoring would be a private `_collect_and_write()` helper that both `flush()` and `flush_data_only()` call, with the two methods differing only in the index rebuild step that follows. The duplication means a future bug fix or behavioral change to the data-collection logic would need to be applied in two places. This is a DRY violation, not a blocker for merging, but it should be a follow-up tech-debt issue.

**Issue: `eprintln!` debug statement introduced at line 1311.**

```rust
eprintln!("[RUST FLUSH_DATA_ONLY] Flushing {} operations to disk (no index rebuild)", self.delta_log.len());
```

The `flush()` function has similar pre-existing `eprintln!` statements, but those are pre-existing. This one was added by this task (confirmed via `git diff origin/main`). In production code, diagnostics should go through `tracing::info!`, not `eprintln!`. The method already uses `tracing::info!` at line 1441 for its completion message. The opening debug line should do the same.

#### `rebuild_indexes()` in `engine.rs` (~32 lines)

Clean and correct. Clears all three secondary index structures (index_set, adjacency, reverse_adjacency, edge_keys), then rebuilds them from current segments in a single pass. Uses `tracing::info!` for timing. Well-scoped, no issues.

#### `_sendCommitBatch()` in `client.ts` (~58 lines)

The extraction from `commitBatch()` is clean. The chunking logic is unchanged from its previous inline location; now it's in a named method with a clear doc comment explaining its role. The two paths (small batch / large batch) are clearly separated.

**Issue: Missing `private` modifier.**

```typescript
async _sendCommitBatch(   // line 1116 — no 'private' keyword
```

All other underscore-prefixed methods in the file are declared with `private` (e.g., `_enhanceConnectionError`, `_handleData`, `_send`, `_buildServerQuery`, etc.). The reason `_sendCommitBatch` lacks `private` is that `BatchHandle.commit()` (line 1314) calls it as `this.client._sendCommitBatch(...)`. Since `BatchHandle` is a separate class, TypeScript's `private` keyword would block that call.

The cleanest solution is a package-internal access pattern. Either: (1) mark it as `/** @internal */` in the JSDoc and keep underscore convention as the signal, or (2) move `BatchHandle` into the same class scope. As-is, `_sendCommitBatch` is effectively part of the public API surface despite its intent as an internal detail, which is misleading. This is a minor naming/visibility clarity issue, not a correctness problem.

#### `BatchHandle` class in `client.ts` (~37 lines)

Clean and minimal. Four private fields, five methods, all self-explanatory. The `commit()` method correctly clears buffers before delegating (preventing double-commit). The `abort()` method correctly resets all three buffer types. Good atomicity pattern.

Naming is consistent with the existing codebase conventions. The class-level JSDoc explains the isolation guarantee clearly.

#### `_updatePhaseRunnerDeferIndexing()` in `Orchestrator.ts` (~15 lines)

The approach — recreating `PhaseRunner` with updated deps — is acknowledged in the comment as a workaround for `PhaseRunner`'s constructor-time dep injection. It is straightforward and matches the existing constructor call pattern exactly. The method name is accurate.

However, the same 5-line deferred indexing setup pattern is duplicated in both `run()` (lines 191–195) and `runMultiRoot()` (lines 310–314), and the same 4-line reset pattern appears at lines 274–276 and 397–400. This is a pattern that could be extracted to a method like `_enableDeferredIndexing()` and `_disableDeferredIndexing()`, but the duplication is minor enough (4–5 lines each) that it is not a hard requirement.

#### `_isEmptyGraph()` in `Orchestrator.ts` (~8 lines)

Clean, correct, minimal. The fallback to `true` on error is conservative and sensible — if we can't determine whether the graph is empty, treating it as empty (and deferring indexing) is safe.

---

### Forbidden Patterns

- No `TODO`, `FIXME`, `HACK`, `XXX` in new code (pre-existing ones in engine.rs at lines 464 and 1579 are not part of this task).
- No commented-out code.
- No mock/stub/fake outside tests.
- No empty implementations.

---

### Summary of Issues

| Severity | Location | Issue |
|----------|----------|-------|
| Tech debt | `engine.rs` `flush_data_only()` | ~120 lines duplicated from `flush()`. Should extract shared data-collection logic. |
| Minor | `engine.rs` line 1311 | `eprintln!` in production code. Should be `tracing::info!` to match the method's own line 1441. |
| Minor | `client.ts` line 1116 | `_sendCommitBatch` lacks `private` keyword unlike all other `_`-prefixed methods. Needs `/** @internal */` annotation or structural fix. |
| Pre-existing | Multiple files | File size violations existed before this task. Must be tracked as tech debt. |

None of the issues above are blockers. The implementation is correct, naming is clear, the refactoring of `commitBatch()` into `_sendCommitBatch()` is clean, and `BatchHandle` is a well-structured class. The deferred indexing integration across Orchestrator/PhaseRunner/JSASTAnalyzer is coherent and the two rebuild points are correctly placed.

**Verdict: APPROVE** — with the above issues filed as tech debt.
