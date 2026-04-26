# REG-487: Don Melton — Architecture Exploration

## Overview

This report covers the architecture of RFDB batch commits, server-side indexing, and the worker pool as relevant to REG-487. The two problems are:

1. **O(n²) indexing**: every `commitBatch` triggers a full `flush()` on the RFDB server, which rebuilds all in-memory indexes from scratch over the entire segment. With 330 modules each committing once, this is 330 index rebuilds on an ever-growing dataset.

2. **Race condition**: JSASTAnalyzer's `WorkerPool` runs 10 parallel async workers, all sharing the same `RFDBClient` instance, which has shared mutable batch state (`_batching`, `_batchNodes`, `_batchEdges`).

---

## 1. RFDB Server (Rust Side)

### Source files

- `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/graph/engine.rs` — GraphEngine (v1 storage)
- `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/graph/index_set.rs` — Secondary indexes
- `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/bin/rfdb_server.rs` — Request handler, `handle_commit_batch()`
- `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/session.rs` — Per-connection session state

### CommitBatch handler (rfdb_server.rs:1281)

```rust
Request::CommitBatch { changed_files, nodes, edges, tags: _, file_context } => {
    with_engine_write(session, |engine| {
        handle_commit_batch(engine, changed_files, nodes, edges, file_context)
    })
}
```

`handle_commit_batch` (lines 1476–1589):
1. Deletes all nodes/edges for `changed_files` from the engine
2. Adds new nodes via `engine.add_nodes()`
3. Adds new edges via `engine.add_edges()`
4. **Calls `engine.flush()` unconditionally** (line 1575)
5. Returns the delta

```rust
if let Err(e) = engine.flush() {
    return Response::Error { error: format!("Flush failed during commit: {}", e) };
}
```

### flush() triggers full index rebuild (engine.rs:1257–1265)

The `flush()` function writes all delta nodes/edges to disk segments, then **rebuilds all secondary indexes from scratch**:

```rust
// Rebuild secondary indexes from new segment
self.index_set.clear();
if let Some(ref nodes_seg) = self.nodes_segment {
    self.index_set.rebuild_from_segment(nodes_seg, &self.declared_fields);  // O(N) over ALL nodes
}

// Rebuild adjacency, reverse_adjacency, and edge_keys (O(E) over ALL edges)
self.adjacency.clear();
self.reverse_adjacency.clear();
for idx in 0..edges_seg.edge_count() { ... }  // walks entire edge segment
```

### IndexSet.rebuild_from_segment (index_set.rs:53)

Single O(N) pass over ALL nodes in segment (not just changed ones):

```rust
pub fn rebuild_from_segment(&mut self, segment: &NodesSegment, declared_fields: &[FieldDecl]) {
    self.id_index.clear();
    self.type_index.clear();
    self.file_index.clear();
    self.field_indexes.clear();

    self.id_index.reserve(segment.node_count());

    for idx in 0..segment.node_count() {  // iterates ALL nodes
        // ... builds id_index, type_index, file_index, field_indexes
    }
}
```

**This is the O(n²) source**: with N modules committing one-by-one, the k-th commit rebuilds indexes over all nodes from modules 1..k-1 plus the new ones. Total work = 1 + 2 + ... + N = O(N²).

For 330 modules: ~54,000 index rebuild iterations, each potentially over millions of nodes.

### No existing deferred/lazy indexing support

There is NO flag or mode for "skip indexing on commit" in the current server. Every `flush()` path unconditionally rebuilds. The `declare_fields()` call (which enables metadata field indexes) also triggers an immediate `rebuild_from_segment`.

There is no `setIndexMode()`, no batched index building, no concept of "bulk load" mode.

### Session state (session.rs)

Each client connection has a `ClientSession` with:
- `pending_batch_id`: tracks server-side batch (BeginBatch/AbortBatch protocol — currently unused by the TS client)
- The server-side BeginBatch/CommitBatch protocol is distinct from the client-side batch buffering

Note: The client's `beginBatch()`/`commitBatch()` is purely client-side buffering. The server sees only `commitBatch` requests (no `beginBatch` command sent for the current batching pattern).

---

## 2. RFDB Client (TypeScript Side)

**File**: `/Users/vadimr/grafema-worker-1/packages/rfdb/ts/client.ts`

### Batch state (lines 53–57)

```typescript
// Batch state — SHARED MUTABLE STATE on the client instance
private _batching: boolean = false;
private _batchNodes: WireNode[] = [];
private _batchEdges: WireEdge[] = [];
private _batchFiles: Set<string> = new Set();
```

### beginBatch() (line 1037)

```typescript
beginBatch(): void {
    if (this._batching) throw new Error('Batch already in progress');
    this._batching = true;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
}
```

### commitBatch() (line 1093)

```typescript
async commitBatch(tags?: string[]): Promise<CommitDelta> {
    if (!this._batching) throw new Error('No batch in progress');

    const allNodes = this._batchNodes;
    const allEdges = this._batchEdges;
    const changedFiles = [...this._batchFiles];

    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();

    // Chunks large batches, sends 'commitBatch' commands to server
    // Each commitBatch triggers flush() on server => full index rebuild
    return this._send('commitBatch', { changedFiles, nodes: allNodes, edges: allEdges, tags });
}
```

### The race condition

`RFDBClient` is a single instance shared across all WorkerPool workers. The `_batching`, `_batchNodes`, `_batchEdges` fields are **instance-level, not per-worker**. With 10 workers running concurrently:

**Scenario**:
- Worker A calls `graph.beginBatch()` → sets `_batching = true`, clears buffers
- Worker B calls `graph.beginBatch()` → throws "Batch already in progress" (if A is still batching)
- OR: Worker A calls `graph.beginBatch()`, Worker B calls `addNodes(...)` — which goes into A's buffer
- Worker C calls `graph.commitBatch()` while Worker A hasn't finished yet → commits A's partial data + loses A's remaining nodes

This is a classic TOCTOU (time-of-check-to-time-of-use) race on shared mutable state without any mutex. Since Node.js is single-threaded (event loop), the race can only happen at `await` points — but `commitBatch` is async, so between `this._batching = false` and the `_send` resolution, another worker can call `beginBatch()`.

**However**: Looking at the Orchestrator code (line 244-246), the ANALYSIS phase passes `workerCount: 1`:
```typescript
// workerCount: 1 — JSASTAnalyzer uses WorkerPool(workerCount) for concurrent module analysis.
// Sequential processing avoids concurrent graph writes that cause race conditions.
await this.runPhase('ANALYSIS', { manifest, graph: this.graph, workerCount: 1 });
```

So the race condition is **currently mitigated** by forcing `workerCount: 1` for ANALYSIS. But JSASTAnalyzer itself creates a `WorkerPool(context.workerCount || 10)` — with `workerCount: 1`, this creates 1 worker, so no parallelism. The comment explicitly acknowledges the race condition as the reason.

The race condition IS real — it's just been worked around by disabling parallelism, which is a significant performance sacrifice.

---

## 3. Orchestrator / PhaseRunner

**Files**:
- `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`
- `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts`

### Analysis flow

```
Orchestrator.run(projectPath)
├── if forceAnalysis && graph.clear → graph.clear()   [--clear flag]
├── graphInitializer.init()
├── discoveryManager.discover()
├── runBatchPhase('INDEXING', units)
├── runPhase('ANALYSIS', { manifest, graph, workerCount: 1 })
│   └── phaseRunner.runPhase('ANALYSIS', context)
│       └── for each plugin:
│           └── executePlugin(plugin, context, 'ANALYSIS')
│               └── runPluginWithBatch(plugin, context, 'ANALYSIS')
│                   ├── graph.beginBatch()
│                   ├── plugin.execute(context)   [JSASTAnalyzer.execute()]
│                   │   └── WorkerPool(1).processQueue()
│                   │       └── for each module:
│                   │           ├── graph.beginBatch()  [per-module batch in worker handler]
│                   │           ├── analyzeModule(module, graph, ...)
│                   │           └── graph.commitBatch()  [→ server flush+index rebuild]
│                   └── graph.commitBatch()  [PhaseRunner outer batch — but JSASTAnalyzer has managesBatch:true]
└── runPipelineEpilogue(manifest, projectPath)
```

### managesBatch:true flag (JSASTAnalyzer.ts:278)

```typescript
metadata = {
    ...
    managesBatch: true,  // Tells PhaseRunner to NOT wrap in outer batch
    ...
}
```

PhaseRunner checks this (line 82):
```typescript
if (!graph.beginBatch || !graph.commitBatch || !graph.abortBatch
    || plugin.metadata.managesBatch) {
    const result = await plugin.execute(pluginContext);
    return { result, delta: null };
}
```

So for JSASTAnalyzer, PhaseRunner does NOT add an outer batch. JSASTAnalyzer manages its own batches at the per-module level.

### forceAnalysis / --clear flag

In `analyzeAction.ts` (line 168):
```typescript
forceAnalysis: options.clear || false,
```

In `Orchestrator.run()` (lines 178–181):
```typescript
if (this.forceAnalysis && this.graph.clear) {
    this.logger.info('Clearing entire graph (forceAnalysis=true)');
    await this.graph.clear();
}
```

`forceAnalysis` is passed into `PluginContext` (PhaseRunner.buildPluginContext, line 118). JSASTAnalyzer uses it to bypass hash-based caching.

There is NO existing mechanism to detect "initial analysis" vs "incremental" beyond `forceAnalysis`. The distinction is:
- `forceAnalysis=true` → initial/rebuild (user passed `--clear`)
- `forceAnalysis=false` AND graph is empty → also initial (first run)
- `forceAnalysis=false` AND graph has data → incremental

### Extension points in PhaseRunner

The `PhaseRunnerDeps` interface (lines 43–53) is injected at construction. Adding a new field (e.g., `deferIndexing: boolean`) would propagate cleanly to all phase execution.

`PhaseRunner.runPluginWithBatch()` (lines 73–101) is where batch begin/commit happens. The `tags` passed to `commitBatch` could include an `indexMode` hint, or a new parameter could be added.

---

## 4. WorkerPool

**File**: `/Users/vadimr/grafema-worker-1/packages/core/src/core/WorkerPool.ts`

### Architecture

`WorkerPool` is a simple async worker pool using Node.js event loop concurrency (NOT worker_threads). All workers run in the same thread.

```typescript
async processQueue(queue: WorkerQueue): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.workerCount; i++) {
        workers.push(this._worker(i, queue));
    }
    await Promise.all(workers);  // All N workers run concurrently via async/await
}

private async _worker(workerId: number, queue: WorkerQueue): Promise<void> {
    while (true) {
        const task = queue.next();
        if (!task) { await this._sleep(10); continue; }
        this.activeWorkers++;
        const result = await handler(task);  // await here = other workers can run
        this.activeWorkers--;
    }
}
```

### How JSASTAnalyzer uses WorkerPool

In JSASTAnalyzer (lines 384–401):
```typescript
const pool = new WorkerPool(context.workerCount || 10);

pool.registerHandler('ANALYZE_MODULE', async (task) => {
    if (graph.beginBatch && graph.commitBatch) {
        graph.beginBatch();           // Sets _batching=true on SHARED client
        try {
            const result = await this.analyzeModule(...);  // await: other workers can run here
            await graph.commitBatch([...]);  // await: other workers can run here
            return result;
        } catch (err) {
            if (graph.abortBatch) graph.abortBatch();
            throw err;
        }
    }
    return await this.analyzeModule(...);
});
```

With `workerCount > 1`, the race:
1. Worker A: `graph.beginBatch()` → `_batching = true`
2. Worker A: `await this.analyzeModule(...)` → yields to event loop
3. Worker B: `graph.beginBatch()` → `_batching` is already `true` → **throws "Batch already in progress"**
4. Worker B's task fails, which triggers `graph.abortBatch()` → sets `_batching = false`
5. Worker A resumes: calls `await graph.commitBatch(...)` → **throws "No batch in progress"** (because B aborted it)

This causes data loss and failures. Hence the workaround: `workerCount: 1`.

### ASTWorkerPool (separate, different)

`ASTWorkerPool` uses actual `worker_threads` for Babel parsing only. It does NOT touch the graph — it returns AST collections to the main thread, which then writes to the graph. No race condition there.

`AnalysisQueue` (used by `ParallelAnalysisRunner`) creates worker_thread-based `QueueWorker` processes — these are a separate parallel analysis path only used when `parallelConfig.enabled` is set.

---

## 5. PluginContext

**File**: `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/Plugin.ts` (inferred from imports)

The `PluginContext` passed to plugins includes:
- `graph: GraphBackend` — the shared graph instance (RFDBServerBackend wrapping RFDBClient)
- `manifest: DiscoveryManifest | UnitManifest`
- `workerCount: number` — passed through from Orchestrator
- `forceAnalysis: boolean`
- `logger: Logger`
- `strictMode: boolean`
- `resources: ResourceRegistry`
- `config: { projectPath, services, routing }`

The `graph` object exposes `beginBatch`, `commitBatch`, `abortBatch` directly — so plugins and workers call these directly on the shared client.

---

## 6. Current Batch/Indexing Flow (Complete)

For a 330-module codebase with `grafema analyze --clear`:

```
1. Orchestrator.run() — forceAnalysis=true
2. graph.clear() — clears RFDB server, triggers flush (no data, fast)
3. graphInitializer.init() — adds plugin nodes, declares fields
4. discoveryManager.discover() — finds all services/modules
5. runBatchPhase('INDEXING', units)
   └── for each unit:
       └── runPhase('INDEXING', ...)
           └── JSModuleIndexer.execute()
               └── commitBatch() for each file → flush+index (330 total for indexing)
6. runPhase('ANALYSIS', { workerCount: 1 })
   └── JSASTAnalyzer.execute() [managesBatch:true]
       └── WorkerPool(1).processQueue() [single worker!]
           └── for module_1 of 330:
               ├── graph.beginBatch()
               ├── analyzeModule(module_1) — Babel parse + add ~50-200 nodes
               └── graph.commitBatch()
                   └── → RFDBClient._send('commitBatch', {nodes, edges, changedFiles})
                       └── → RFDB server: handle_commit_batch()
                           ├── delete old nodes for changedFiles
                           ├── engine.add_nodes(new_nodes)
                           ├── engine.add_edges(new_edges)
                           └── engine.flush()
                               ├── writes nodes+edges to disk
                               ├── index_set.rebuild_from_segment()  ← O(all nodes so far)
                               └── rebuild adjacency (O(all edges so far))
           └── for module_2 of 330:
               └── ... same, now index over module_1's nodes too ...
           [...]
           └── for module_330:
               └── commitBatch() → index rebuild over ALL 330 modules' nodes
7. ENRICHMENT, VALIDATION phases (each plugin wrapped in batch by PhaseRunner)
8. graph.flush()
```

**Performance math**: If each module contributes ~100 nodes on average, and indexing is O(N) per commit:
- Commit 1: index 100 nodes
- Commit 2: index 200 nodes
- ...
- Commit 330: index 33,000 nodes
- Total: 100 × (1 + 2 + ... + 330) = 100 × 54,945 ≈ 5.5 million node iterations

Plus edge adjacency rebuilding on the same schedule.

---

## 7. Extension Points for the Fix

### Option A: Server-side "bulk load" mode

Add a new RFDB protocol command `setIndexMode(mode: 'immediate' | 'deferred')`:

- `'deferred'`: `commitBatch` skips `flush()` entirely, data stays in memory delta
- `'immediate'`: current behavior (default)
- A separate `buildIndexes()` command triggers one final `flush()` + index build

**Where to add**:
- Rust: `rfdb_server.rs` — new `Request::SetIndexMode` variant, stored on `ClientSession`
- Rust: `handle_commit_batch` checks session index mode before calling `engine.flush()`
- TS client: `client.ts` — new `setIndexMode()` method
- TS backend: `RFDBServerBackend.ts` — expose `setIndexMode()` on `GraphBackend`

**Risk**: If process crashes in deferred mode, all data is lost (no flush). Acceptable for initial analysis since `--clear` would re-run anyway.

### Option B: Flush without index rebuild

Add a `flush_no_index()` to GraphEngine — writes to disk but does NOT call `rebuild_from_segment`. Faster, but queries against flushed data wouldn't work until `rebuild_from_segment` is called explicitly.

Since ANALYSIS phase runs with `workerCount=1` sequentially, and queries only happen in ENRICHMENT/VALIDATION (after ANALYSIS), this is safe.

### Option C: Merge all module commits into one big commit

Instead of per-module `beginBatch/commitBatch`, accumulate all 330 modules' data in one big batch and commit once at the end. One flush, one index build.

**Problem**: This is exactly what was NOT done (see commit c37eff9 — per-module commits were added to prevent connection timeouts on large codebases). One huge commit = ECONNRESET.

Unless chunked carefully (as `commitBatch` already does with `CHUNK = 10_000`), this brings back the timeout problem.

### Option D: Fix race condition first (separate from indexing)

Since `workerCount=1` is the current workaround for the race, solving the race condition would allow `workerCount > 1` again, which would speed up analysis independently of the indexing issue.

Options:
- **Per-worker RFDBClient instances**: Each worker creates its own client connection. Server handles concurrent connections fine (it uses `RwLock<dyn GraphStore>`). Each worker batches independently, sends commitBatch independently. Multiple concurrent flushes = still O(n²) but parallelized.
- **Serialize batch access with a queue/mutex**: A simple request queue where workers submit batch operations and a single consumer executes them. More complex.
- **Remove batching from workers, batch at module level outside WorkerPool**: The outer PhaseRunner batch (which JSASTAnalyzer bypasses with `managesBatch:true`) could be reconsidered.

---

## 8. Key Findings Summary

| Component | File | Key Finding |
|-----------|------|-------------|
| RFDB flush | `engine.rs:1263` | Every `flush()` rebuilds entire `IndexSet` — O(N) per commit |
| CommitBatch handler | `rfdb_server.rs:1575` | Unconditionally calls `flush()` after every commitBatch |
| No deferred mode | server-wide | No existing "bulk load" or "skip indexing" mode |
| Race condition | `client.ts:53-57` | `_batching`/`_batchNodes`/`_batchEdges` are shared instance state |
| Race workaround | `Orchestrator.ts:246` | `workerCount: 1` passed to ANALYSIS phase — serializes workers |
| JSASTAnalyzer | `JSASTAnalyzer.ts:278` | `managesBatch: true` — manages its own per-module batches |
| Per-module batch | `JSASTAnalyzer.ts:389-394` | Each module is a separate beginBatch/commitBatch cycle |
| Initial vs incremental | `Orchestrator.ts:178` | Only distinction is `forceAnalysis` flag from `--clear` |
| Extension point | `PhaseRunnerDeps` | Clean place to inject `deferIndexing: boolean` flag |
| Extension point | `commitBatch` call | `tags` parameter could carry mode hints, OR new protocol command |

---

## 9. Recommended Investigation Areas for Planning

1. **What's the minimum protocol change?** Can we add a `deferIndex: boolean` flag to the existing `commitBatch` command (no new command needed) vs a separate `setIndexMode` session command?

2. **Are there any ANALYSIS-phase queries that need index accuracy?** JSASTAnalyzer's `shouldAnalyzeModule` calls `queryNodes({ type: 'FUNCTION', file })` — this would fail if indexes are deferred. Need to check if delta-based lookup works without segment index.

3. **What about INDEXING phase?** The INDEXING phase (JSModuleIndexer) also commits per-module. Should deferred indexing apply there too? The modules written by INDEXING are needed by ANALYSIS to enumerate files. Delta-based queries should still work.

4. **Incremental analysis detection**: Need a reliable way to detect "no existing graph" (first run) vs "graph exists" beyond just `forceAnalysis`. Could check `graph.nodeCount() === 0` before analysis.

5. **One-time index build trigger**: After all analysis phases, call an explicit `buildIndexes()` / `flush()` to materialize all indexes at once. This is the "end of bulk load" signal.
