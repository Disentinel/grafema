## Rob Pike — Tech Debt Fixes (REG-487)

Four tech debt items identified during 4-Review, fixed before merge.

### Fix 1: DRY violation — Extract shared helper from flush()/flush_data_only()

**File:** `packages/rfdb-server/src/graph/engine.rs`

`flush()` and `flush_data_only()` shared ~120 lines of identical data-collection logic. Extracted the shared body into a private helper method `collect_and_write_data()` in the `impl GraphEngine` block.

**Contract:** Returns `Result<bool>` — `Ok(true)` means data was written to disk, `Ok(false)` means early return (empty delta or ephemeral database). Both callers check the bool and skip their post-write work on `false`.

**Before:**
- `flush()`: 190 lines (data collection + index rebuild)
- `flush_data_only()`: 145 lines (data collection, no index rebuild)
- Shared code: ~120 lines duplicated

**After:**
- `collect_and_write_data()`: ~155 lines (in `impl GraphEngine` block)
- `flush()`: ~35 lines (calls helper, then rebuilds indexes)
- `flush_data_only()`: ~10 lines (calls helper, skips indexes)

### Fix 2: eprintln! to tracing::info!

**File:** `packages/rfdb-server/src/graph/engine.rs`

The old `eprintln!("[RUST FLUSH_DATA_ONLY] ...")` and the multiple `eprintln!("[RUST FLUSH] ...")` calls have been replaced with `tracing::info!(...)` in the new `collect_and_write_data()` helper. This happened naturally as part of Fix 1 — the helper uses `tracing::info!` consistently.

### Fix 3: @internal annotation on _sendCommitBatch

**File:** `packages/rfdb/ts/client.ts`

Added `@internal` JSDoc tag to `_sendCommitBatch()` method. This method is public (no `private` keyword) because `BatchHandle` needs to call it from a separate class, but it's not part of the public API. The `@internal` annotation signals this to both developers and documentation generators.

### Fix 4: Move _isEmptyGraph() check before graphInitializer.init()

**File:** `packages/core/src/Orchestrator.ts`

In both `run()` and `runMultiRoot()`, the `_isEmptyGraph()` check was after `graphInitializer.init()`. Since `init()` adds plugin nodes and GRAPH_META to the delta, `nodeCount()` would return non-zero even on a truly empty graph, defeating the deferred indexing detection.

**Fix:** Moved the `_deferIndexing` assignment and `_updatePhaseRunnerDeferIndexing()` call to BEFORE `graphInitializer.init()` in both methods. The graph is truly empty at that point (after `clear()` for forceAnalysis, or genuinely empty on first run).

### Test Results

- **Rust:** 677 passed, 0 failed, 3 ignored (all suites green)
- **TypeScript:** 2058 tests, 0 failures, 5 skipped, 22 todo
