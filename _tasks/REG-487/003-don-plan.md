# REG-487: Don Melton — Implementation Plan

## Problem Summary

`grafema analyze --clear` on a 330-module codebase takes ~15 minutes due to two compounding issues:

1. **O(n²) indexing**: Each per-module `commitBatch` triggers a full `flush()` on the RFDB server, which rebuilds ALL secondary indexes from scratch over the ENTIRE segment. For 330 modules, this is 330 index rebuilds on a growing dataset — 5.5 million node iterations total.

2. **Race condition on batch state**: `RFDBClient._batching/_batchNodes/_batchEdges/_batchFiles` are instance-level shared mutable state. With `workerCount > 1`, concurrent workers corrupt each other's batches. Currently mitigated (not fixed) by `workerCount: 1`, which eliminates parallelism.

## Prior Art Review

Deferred indexing during bulk loads is a well-established pattern across graph databases:

- **NebulaGraph** ([documentation](https://www.nebula-graph.io/posts/how-indexing-works-in-nebula-graph)): explicitly recommends loading data without indexes, then rebuilding offline after bulk load. Index rebuild is described as "heavy IO — not during online serving."
- **JanusGraph** ([bulk load guide](https://nitinpoddar.medium.com/bulk-loading-data-into-janusgraph-ace7d146af05)): separates bulk load mode from normal operation. Schema created first, data loaded without index maintenance, indexes rebuilt at the end.
- **FairCom** ([deferred indexing](https://docs.faircom.com/doc/ctreeplus/deferred-indexing.htm)): dedicated "deferred index" mode for bulk operations — data written to segment, index update deferred until explicit `rebuild`.

The chosen approach (flush data to disk per-commit, rebuild indexes once at the end) directly mirrors industry practice for graph database bulk loading.

---

## Architecture of the Fix

### Problem 1: O(n²) Indexing — "Deferred Index Mode"

**Core idea**: During initial analysis, split `flush()` into two operations:
1. `flush_data_only()` — writes nodes/edges to disk segment, skips index rebuild
2. `rebuild_indexes()` — rebuilds all secondary indexes and adjacency from segment

Each per-module `commitBatch` calls `flush_data_only()`. One `rebuildIndexes` command is sent at the end of all ANALYSIS phases, before ENRICHMENT starts. ENRICHMENT and VALIDATION need accurate indexes; ANALYSIS only queries the delta (in-memory), so deferred indexing is safe.

**Why this approach over alternatives:**

| Option | Pros | Cons | Decision |
|--------|------|------|---------|
| A: Skip flush entirely | Zero disk I/O | Data lost on crash | Rejected — crash safety matters |
| B: flush_data_only + rebuild at end | Safe, fast, minimal change | One rebuild at the end | **CHOSEN** |
| C: One big commit | One flush total | ECONNRESET (already reverted, commit c37eff9) | Rejected — known failure |
| D: Per-worker clients | Fixes race only | Doesn't fix O(n²) | Used only for Problem 2 |

**Key safety invariant**: During ANALYSIS, JSASTAnalyzer only reads from the graph to check `shouldAnalyzeModule`. That check uses `queryNodes({ type: 'FUNCTION', file })` — which reads from the delta (in-memory), not the segment index. This is verified in the code: delta nodes are kept in `self.delta_nodes` until flush. After `flush_data_only()`, delta is cleared but index is not yet rebuilt — so delta reads return empty, segment index reads return empty. This is safe because `shouldAnalyzeModule` with `forceAnalysis=true` always returns `true` (bypasses the check entirely). For incremental analysis (`forceAnalysis=false`), we should NOT defer indexing (see "When to Defer" section below).

### Problem 2: Race Condition — Per-Worker Batch Isolation

**Core idea**: Extract batch state from `RFDBClient` instance into a `BatchHandle` class. Each worker creates its own `BatchHandle`. The `BatchHandle` calls the client's internal send methods directly, bypassing the shared instance-level `_batching` flag.

**Design**:

```typescript
class BatchHandle {
  private _nodes: WireNode[] = [];
  private _edges: WireEdge[] = [];
  private _files: Set<string> = new Set();

  constructor(private client: RFDBClient) {}

  addNode(node: WireNode, file?: string): void { ... }
  addEdge(edge: WireEdge): void { ... }

  async commit(tags?: string[], deferIndex?: boolean): Promise<CommitDelta> { ... }
  abort(): void { ... }
}
```

`RFDBClient` gets a new method: `createBatch(): BatchHandle`. This returns an isolated handle with its own buffers. Multiple workers can each call `createBatch()` and operate independently.

The existing `beginBatch()/commitBatch()/abortBatch()` on the instance remain unchanged for backwards compatibility (PhaseRunner uses them for ENRICHMENT/VALIDATION phase batches, which are sequential and not affected by the race).

---

## "When to Defer" Logic

Deferred indexing is ONLY applied during initial/full analysis:

```
forceAnalysis=true → defer indexing during ANALYSIS phase → rebuild once after ANALYSIS
forceAnalysis=false AND graph empty → same (detected by node_count=0 before analysis start)
forceAnalysis=false AND graph has data → incremental → do NOT defer (normal flush)
```

The `Orchestrator` detects the mode and passes a `deferIndexing: boolean` flag through `PhaseRunnerDeps` to the JSASTAnalyzer context. JSASTAnalyzer passes `deferIndex: true` in `commitBatch()` when in deferred mode.

After ALL ANALYSIS phase plugins complete, the Orchestrator sends one `RebuildIndexes` command before starting ENRICHMENT.

---

## Files to Modify

### Layer 1: Rust (RFDB Server)

**File 1: `packages/rfdb-server/src/graph/engine.rs`**

Add two new public methods to `GraphEngine`:

```rust
/// Flush data to disk WITHOUT rebuilding secondary indexes or adjacency.
/// Used during bulk load (initial analysis) for O(1) per-commit cost.
/// IMPORTANT: After flush_data_only(), indexes are stale.
/// Call rebuild_indexes() once when bulk load is complete.
pub fn flush_data_only(&mut self) -> Result<()> {
    // [same as flush() up to and including self.edges_segment reload]
    // STOP BEFORE: index_set.rebuild_from_segment()
    // STOP BEFORE: adjacency rebuild loop
    Ok(())
}

/// Rebuild all secondary indexes and adjacency from current segment.
/// Called once after bulk load to materialize all deferred index updates.
pub fn rebuild_indexes(&mut self) -> Result<()> {
    self.index_set.clear();
    if let Some(ref nodes_seg) = self.nodes_segment {
        self.index_set.rebuild_from_segment(nodes_seg, &self.declared_fields);
    }
    self.adjacency.clear();
    self.reverse_adjacency.clear();
    if let Some(ref edges_seg) = self.edges_segment {
        for idx in 0..edges_seg.edge_count() {
            // ... same as current flush() adjacency rebuild
        }
    }
    Ok(())
}
```

**File 2: `packages/rfdb-server/src/graph/mod.rs`**

Add `flush_data_only()` and `rebuild_indexes()` to the `GraphStore` trait:

```rust
/// Flush data only, skip index rebuild (for bulk load mode)
fn flush_data_only(&mut self) -> Result<()> {
    // Default: call full flush() for backwards compatibility with engine_v2
    self.flush()
}

/// Rebuild all secondary indexes from current segment (called after bulk load)
fn rebuild_indexes(&mut self) -> Result<()>;
```

Note: `engine_v2.rs` needs a stub `rebuild_indexes()` that calls `flush()` — v2 already handles this differently and is not performance-critical here.

**File 3: `packages/rfdb-server/src/bin/rfdb_server.rs`**

a) Add `deferIndex` field to `CommitBatch` request variant:

```rust
CommitBatch {
    #[serde(rename = "changedFiles")]
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default, rename = "fileContext")]
    file_context: Option<String>,
    /// When true, write data to disk but skip index rebuild.
    /// Caller must send RebuildIndexes after all deferred commits complete.
    #[serde(default, rename = "deferIndex")]
    defer_index: bool,
},
```

b) Add `RebuildIndexes` request variant:

```rust
/// Rebuild all secondary indexes from current segment.
/// Send after a series of deferIndex=true CommitBatch commands.
RebuildIndexes,
```

c) Modify `handle_commit_batch()` to accept and respect `defer_index`:

```rust
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    ...,
    defer_index: bool,
) -> Response {
    // ... existing deletion + add_nodes + add_edges logic unchanged ...

    let flush_result = if defer_index {
        engine.flush_data_only()
    } else {
        engine.flush()
    };

    if let Err(e) = flush_result {
        return Response::Error { error: format!("Flush failed during commit: {}", e) };
    }

    // ... return BatchCommitted response unchanged ...
}
```

d) Add handler for `RebuildIndexes`:

```rust
Request::RebuildIndexes => {
    with_engine_write(session, |engine| {
        if let Err(e) = engine.rebuild_indexes() {
            return Response::Error { error: format!("Index rebuild failed: {}", e) };
        }
        Response::Ok { message: "Indexes rebuilt".to_string() }
    })
}
```

e) Add `RebuildIndexes` to the request-name debug formatter (line ~751):

```rust
Request::RebuildIndexes => "RebuildIndexes".to_string(),
```

### Layer 2: TypeScript Client

**File 4: `packages/rfdb/ts/client.ts`**

a) Add `deferIndex` parameter to `commitBatch()`:

```typescript
async commitBatch(tags?: string[], deferIndex?: boolean): Promise<CommitDelta> {
    // ... existing buffer extraction ...

    // In both the simple path and the chunked path:
    await this._send('commitBatch', {
        changedFiles, nodes, edges, tags,
        ...(deferIndex ? { deferIndex: true } : {}),
    });
    // ...
}
```

b) Add `rebuildIndexes()` method:

```typescript
/**
 * Rebuild all secondary indexes after a series of deferred-index commits.
 * Call this once after bulk loading data with commitBatch(tags, true).
 */
async rebuildIndexes(): Promise<void> {
    await this._send('rebuildIndexes', {});
}
```

c) Add `BatchHandle` class and `createBatch()` method:

```typescript
export class BatchHandle {
    private _nodes: WireNode[] = [];
    private _edges: WireEdge[] = [];
    private _files: Set<string> = new Set();

    constructor(private client: RFDBClient) {}

    addNode(node: WireNode, file?: string): void {
        this._nodes.push(node);
        if (file) this._files.add(file);
    }

    addEdge(edge: WireEdge): void {
        this._edges.push(edge);
    }

    addFile(file: string): void {
        this._files.add(file);
    }

    async commit(tags?: string[], deferIndex?: boolean): Promise<CommitDelta> {
        const nodes = this._nodes;
        const edges = this._edges;
        const changedFiles = [...this._files];
        this._nodes = [];
        this._edges = [];
        this._files = new Set();
        // Use client's internal _send directly
        return this.client._sendCommitBatch(changedFiles, nodes, edges, tags, deferIndex);
    }

    abort(): void {
        this._nodes = [];
        this._edges = [];
        this._files = new Set();
    }
}
```

Note: `_sendCommitBatch` is a new internal helper on `RFDBClient` that extracts the chunked-commit logic from `commitBatch()` into a reusable form, called by both the instance-level `commitBatch()` and `BatchHandle.commit()`.

d) Add `createBatch()` to `RFDBClient`:

```typescript
createBatch(): BatchHandle {
    return new BatchHandle(this);
}
```

### Layer 3: RFDBServerBackend

**File 5: `packages/core/src/storage/backends/RFDBServerBackend.ts`**

Expose `rebuildIndexes()` and `createBatch()` through the backend:

```typescript
async rebuildIndexes(): Promise<void> {
    await this.client.rebuildIndexes();
}

createBatch(): BatchHandle {
    return this.client.createBatch();
}
```

These are optional methods on the backend — callers check for their existence before using them, consistent with the existing `beginBatch`/`commitBatch` optional pattern.

### Layer 4: Orchestrator

**File 6: `packages/core/src/Orchestrator.ts`**

After ANALYSIS completes (line ~248), add an explicit `rebuildIndexes` call if deferred mode was used:

```typescript
// PHASE 2: ANALYSIS
await this.runPhase('ANALYSIS', { manifest, graph: this.graph, workerCount: this.analysisWorkerCount, deferIndexing: this._deferIndexing });

// If initial analysis with deferred indexing, rebuild indexes now before ENRICHMENT
if (this._deferIndexing && this.graph.rebuildIndexes) {
    this.logger.info('Rebuilding indexes after deferred bulk load...');
    await this.graph.rebuildIndexes();
}
```

Where `this._deferIndexing` is set once at run start:

```typescript
// Determine if we should defer indexing (initial analysis only)
this._deferIndexing = this.forceAnalysis || (await this.isEmptyGraph());

private async isEmptyGraph(): Promise<boolean> {
    const stats = await this.graph.getStats();
    return stats.nodeCount === 0;
}
```

### Layer 5: PhaseRunnerDeps + JSASTAnalyzer

**File 7: `packages/core/src/PhaseRunner.ts`**

Add `deferIndexing?: boolean` to `PhaseRunnerDeps` (optional, defaults to false):

```typescript
export interface PhaseRunnerDeps {
    // ... existing fields ...
    deferIndexing?: boolean;
}
```

Pass it through to plugin context in `buildPluginContext()`:

```typescript
const pluginContext: PluginContext = {
    ...baseContext,
    deferIndexing: this.deps.deferIndexing ?? false,
    // ... existing fields ...
};
```

**File 8: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**

a) Replace shared-instance `beginBatch/commitBatch` pattern with `createBatch()` in the worker handler, resolving the race condition and passing `deferIndex`:

```typescript
pool.registerHandler('ANALYZE_MODULE', async (task) => {
    if (graph.createBatch) {
        // Per-worker isolated batch — no race condition
        const batch = graph.createBatch();
        try {
            // analyzeModule adds nodes/edges to the batch handle
            const result = await this.analyzeModule(task.data.module, graph, projectPath, batch);
            await batch.commit(
                ['JSASTAnalyzer', 'ANALYSIS', task.data.module.file],
                context.deferIndexing ?? false
            );
            return result;
        } catch (err) {
            batch.abort();
            throw err;
        }
    }
    // Fallback: shared instance batching (workerCount=1 only, legacy path)
    if (graph.beginBatch && graph.commitBatch) {
        graph.beginBatch();
        try {
            const result = await this.analyzeModule(task.data.module, graph, projectPath);
            await graph.commitBatch(['JSASTAnalyzer', 'ANALYSIS', task.data.module.file]);
            return result;
        } catch (err) {
            if (graph.abortBatch) graph.abortBatch();
            throw err;
        }
    }
    return await this.analyzeModule(task.data.module, graph, projectPath);
});
```

b) `analyzeModule` signature needs to accept an optional `batch?: BatchHandle` parameter. When provided, it calls `batch.addNode()`/`batch.addEdge()` instead of `graph.addNode()`/`graph.addEdge()`. This is a breaking change within the internal method — but since `analyzeModule` is not public API, it's safe.

c) With `createBatch()` working correctly, **raise `workerCount` from 1 to a safe parallel value** for ANALYSIS. Suggested: `workerCount: Math.min(os.cpus().length, 4)` — configurable, defaults to 4. This is a separate option from `deferIndexing` but they work together.

**File 9: `packages/core/src/plugins/Plugin.ts`** (PluginContext interface)

Add optional `deferIndexing` field:

```typescript
export interface PluginContext {
    // ... existing fields ...
    deferIndexing?: boolean;
}
```

---

## Implementation Order (Dependencies)

```
Step 1 — Rust: GraphEngine.flush_data_only() + rebuild_indexes()
    → No deps, standalone change in engine.rs

Step 2 — Rust: GraphStore trait extension
    → Depends on Step 1 (trait matches implementation)

Step 3 — Rust: rfdb_server.rs — CommitBatch deferIndex + RebuildIndexes command
    → Depends on Steps 1-2

Step 4 — TypeScript: client.ts — deferIndex param, rebuildIndexes(), BatchHandle, createBatch()
    → Depends on Step 3 (protocol contract)

Step 5 — TypeScript: RFDBServerBackend.ts — expose rebuildIndexes(), createBatch()
    → Depends on Step 4

Step 6 — TypeScript: Plugin.ts — deferIndexing in PluginContext
    → No deps (interface only)

Step 7 — TypeScript: PhaseRunner.ts — deferIndexing in PhaseRunnerDeps
    → Depends on Step 6

Step 8 — TypeScript: JSASTAnalyzer.ts — BatchHandle pattern, deferIndex forwarding, workerCount increase
    → Depends on Steps 5, 6, 7

Step 9 — TypeScript: Orchestrator.ts — deferIndexing detection, rebuildIndexes() call, workerCount
    → Depends on Steps 5, 7, 8
```

Steps 1-3 can be developed and tested independently (Rust test suite). Steps 4-5 can follow immediately after the Rust binary is built. Steps 6-9 form the TypeScript orchestration layer.

---

## Risk Assessment

| Step | Risk | Mitigation |
|------|------|------------|
| 1. flush_data_only() | Medium — must NOT touch index or adjacency code | Clear comment + test: verify index_set unchanged after flush_data_only |
| 2. GraphStore trait | Low — adding optional methods with defaults | engine_v2 stub defaults to full flush(), no breakage |
| 3. CommitBatch deferIndex | Low — additive field with `#[serde(default)]` | Old clients send no field → default false → existing behavior |
| 3. RebuildIndexes command | Low — new command, no impact on existing | Test independently in Rust tests |
| 4. BatchHandle | Medium — internal `_sendCommitBatch` refactor | Existing commitBatch behavior preserved via shared helper |
| 8. analyzeModule batch param | Medium — method signature change | Optional param — existing tests using null/undefined path still work |
| 8. workerCount increase | High — race condition must be gone first | Only increase after `createBatch()` is working and tested |
| 9. deferIndexing detection | Medium — empty graph check timing | isEmptyGraph() called BEFORE any INDEXING phase commits |

**Highest risk**: Increasing `workerCount` before the race condition is fully fixed. The plan sequentially gates this: `createBatch()` must be in place and tested before `workerCount` is changed.

**Second highest risk**: Query correctness during deferred mode. The key invariant is:

- ANALYSIS with `forceAnalysis=true` always passes `shouldAnalyzeModule` without querying (bypasses the `queryNodes` call). Verified in JSASTAnalyzer.ts:307.
- For incremental (`forceAnalysis=false`), `deferIndexing` is false — normal flush() applies.
- ENRICHMENT always sees rebuilt indexes (rebuild happens between ANALYSIS and ENRICHMENT).

---

## Testing Strategy

### Rust-level tests (in rfdb_server.rs test module)

**Test: flush_data_only() does not rebuild indexes**

```rust
#[test]
fn test_flush_data_only_skips_index_rebuild() {
    // Create engine, add nodes, call flush_data_only()
    // Verify: nodes are on disk (NodesSegment has data)
    // Verify: index_set.type_index is EMPTY (no rebuild happened)
    // Then call rebuild_indexes()
    // Verify: index_set.type_index has entries
}
```

**Test: CommitBatch with deferIndex=true**

```rust
#[test]
fn test_commit_batch_defer_index() {
    // CommitBatch { deferIndex: true, nodes: [...], ... }
    // Verify: Response::BatchCommitted returned
    // Verify: find_by_type() returns EMPTY (index not built yet)
    // Send RebuildIndexes
    // Verify: find_by_type() returns correct results
}
```

**Test: CommitBatch with deferIndex=false (existing behavior)**

```rust
#[test]
fn test_commit_batch_immediate_index() {
    // CommitBatch { deferIndex: false, nodes: [...] }
    // Verify: find_by_type() immediately returns correct results
}
```

### TypeScript unit tests (test/unit/)

**Test: DeferredIndexing.test.js**

```javascript
describe('Deferred Index Mode (REG-487)', () => {
    it('commitBatch with deferIndex=true does not make nodes queryable via index', ...);
    it('rebuildIndexes() after deferred commits makes nodes queryable', ...);
    it('commitBatch with deferIndex=false immediately makes nodes queryable', ...);
    it('multiple deferred commits followed by one rebuildIndexes is correct', ...);
});
```

**Test: BatchHandle.test.js**

```javascript
describe('BatchHandle (REG-487)', () => {
    it('createBatch() returns isolated handle', ...);
    it('two concurrent BatchHandles do not interfere', async () => {
        // Create two handles, add different nodes to each,
        // commit both, verify correct node counts
    });
    it('BatchHandle.abort() discards buffered data', ...);
    it('commit() on empty handle is a no-op', ...);
});
```

**Test: ParallelAnalysis.test.js** (integration)

```javascript
describe('Parallel ANALYSIS with workerCount=4 (REG-487)', () => {
    it('produces identical node count as workerCount=1', async () => {
        // Analyze same 10-module project with workerCount=1 and workerCount=4
        // Node counts must match exactly
    });
    it('no data loss with concurrent workers', ...);
});
```

**Regression test: existing ClearAndRebuild.test.js must still pass.**

### Performance benchmark (manual, not automated)

```bash
# Baseline (before fix)
time node packages/cli/dist/cli.js analyze --clear

# After fix
time node packages/cli/dist/cli.js analyze --clear
```

Acceptance criterion: `grafema analyze --clear` on the grafema codebase itself completes in < 3 minutes.

---

## Protocol Compatibility

All changes are backwards-compatible:

1. `CommitBatch.deferIndex` has `#[serde(default)]` — old clients omit it → default `false` → existing behavior preserved.
2. `RebuildIndexes` is a new command — old clients never send it → no impact.
3. `beginBatch()/commitBatch()/abortBatch()` on `RFDBClient` instance remain unchanged — all callers outside JSASTAnalyzer (PhaseRunner) continue working.
4. `BatchHandle` is additive — nothing is removed.
5. `GraphBackend.rebuildIndexes()` and `GraphBackend.createBatch()` are optional — callers check for existence before calling (same pattern as `beginBatch`/`commitBatch` checks in PhaseRunner line 81).

---

## What We Are NOT Doing

- **Not changing INDEXING phase**: JSModuleIndexer's per-module commits during INDEXING also trigger flush+rebuild (same O(n²)), but INDEXING runs over a smaller set and its results ARE queried during ANALYSIS (to enumerate modules). Adding deferred indexing to INDEXING requires verifying that ANALYSIS doesn't depend on segment indexes from INDEXING — this is out of scope for REG-487. If INDEXING proves slow, it becomes REG-488.

- **Not touching ENRICHMENT/VALIDATION**: These phases use sequential PhaseRunner-managed batches, not JSASTAnalyzer's per-module pattern. No race condition there.

- **Not changing parallelParsing path**: JSASTAnalyzer has a separate `executeParallel()` path using `ASTWorkerPool` (worker_threads). That path already handles batching separately. Out of scope.

- **Not fixing engine_v2**: The v2 engine (used by RFDB's v2 storage format) gets stub implementations that fall back to the existing `flush()`. Performance optimization of v2 is a separate concern.

---

## Acceptance Criteria

1. `grafema analyze --clear` on the grafema codebase completes in < 3 minutes (down from ~15 minutes)
2. `grafema analyze` (incremental) continues to work correctly — unchanged behavior
3. All existing tests pass: `node --test --test-concurrency=1 'test/unit/*.test.js'`
4. New tests pass: DeferredIndexing.test.js, BatchHandle.test.js, ParallelAnalysis.test.js
5. Protocol is backwards-compatible: MCP server and existing integrations unaffected
6. Rust test suite passes: `cargo test` in `packages/rfdb-server/`

---

## Out of Scope for This Task

- INDEXING phase O(n²) (if significant — create REG-488 after benchmarking)
- GUI/MCP performance
- RFDB v2 engine optimization
- `parallelParsing` path (ASTWorkerPool-based)
- Cross-worker result merging (not needed — each worker commits its own module)
