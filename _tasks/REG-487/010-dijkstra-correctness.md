## Dijkstra Correctness Review

**Verdict:** APPROVE (with one noted gap)

**Functions reviewed:**
- `flush_data_only()` — APPROVE
- `rebuild_indexes()` — APPROVE
- `handle_commit_batch` with `defer_index` — APPROVE (with caveat noted below)
- `_sendCommitBatch()` — APPROVE
- `JSASTAnalyzer.execute()` rebuildIndexes call — APPROVE
- Orchestrator detection logic — APPROVE with noted optimization miss
- `_updatePhaseRunnerDeferIndexing()` — APPROVE

---

### 1. `flush_data_only()` — engine.rs:1300

**Input universe:**
- Empty delta log → correctly returns `Ok(())` immediately (line 1301)
- Ephemeral database → correctly clears delta and returns (line 1306)
- Normal database with data → proceeds to write

**Correctness of data collection (lines 1314–1403):**
The code is structurally identical to `flush()`. Comparison:
- Segment nodes: collects non-deleted, non-delta-overridden nodes ✓
- Delta nodes: collects non-deleted delta nodes ✓
- Edges: delta edges first (priority), then segment edges not in delta ✓
- Deduplication via `edges_map` HashMap by `(src, dst, type)` key ✓

**What is correctly SKIPPED:**
- `index_set.rebuild_from_segment()` — skipped ✓
- `adjacency`/`reverse_adjacency`/`edge_keys` rebuild — skipped ✓
- Comment at line 1437 accurately describes the contract ✓

**After the call, engine state:**
- `nodes_segment`, `edges_segment` reloaded from disk ✓
- `delta_log`, `delta_nodes`, `delta_edges`, `deleted_segment_ids`, `deleted_segment_edge_keys` cleared ✓
- `edge_keys` cleared (line 1431) — cross-batch edge dedup via in-memory set is lost, but `flush_data_only()` merge logic handles it via `edges_map` dedup ✓
- `adjacency`, `reverse_adjacency` — NOT cleared, remain stale (intentional — rebuild_indexes() rebuilds them) ✓

**Can engine be left in inconsistent state?**
No. Disk write happens atomically from memory, and segments are reloaded from disk before returning. If `write_nodes()` or `write_edges()` fail, the `?` operator propagates the error and the in-memory state remains at the pre-close point (segments set to None at line 1406-1407). This is the same behavior as `flush()`.

**Verdict: APPROVE.**

---

### 2. `rebuild_indexes()` — engine.rs:1449

**Input universe: what segment states can exist?**

| State | Expected behavior |
|-------|-------------------|
| `nodes_segment = None` | `if let Some` guard at line 1453 → skips index rebuild safely. Returns Ok. |
| `edges_segment = None` | `if let Some` guard at line 1460 → skips adjacency rebuild safely. Returns Ok. |
| Both segments empty (0 nodes/edges) | Loops execute 0 iterations. All indexes cleared but empty. Correct. |
| Both segments populated | Full rebuild. Correct. |

**Index types rebuilt:**

| Index | Rebuilt? | Code |
|-------|----------|------|
| `index_set` (id_index, type_index, file_index, field_indexes) | YES | lines 1452-1455 |
| `adjacency` | YES | line 1457, 1466 |
| `reverse_adjacency` | YES | line 1458, 1467 |
| `edge_keys` | YES | line 1459, 1472 |

All five index structures that `flush()` rebuilds are also rebuilt here. Coverage is complete.

**Equivalence with flush()'s index rebuild section:**
Comparing `flush()` lines 1261-1286 with `rebuild_indexes()` lines 1452-1475 — structurally identical. ✓

**Idempotent?** Yes — clears before rebuilding. Calling twice produces same result.

**Verdict: APPROVE.**

---

### 3. `handle_commit_batch` with `defer_index` — rfdb_server.rs:1494

**`defer_index` field threading:**
- Added to `CommitBatch` variant with `#[serde(default)]` — old clients default to `false` ✓
- Extracted at line 1290: `Request::CommitBatch { ..., defer_index }` ✓
- Passed to handler at line 1292 ✓
- Branch at line 1594: `if defer_index { engine.flush_data_only() } else { engine.flush() }` ✓

**Error propagation on data write failure:**
```rust
let flush_result = if defer_index { engine.flush_data_only() } else { engine.flush() };
if let Err(e) = flush_result {
    return Response::Error { error: format!("Flush failed during commit: {}", e) };
}
```
Errors from `flush_data_only()` are surfaced correctly. ✓

**Latent correctness concern (not a current bug):**

The DELETION PHASE of `handle_commit_batch` calls `engine.find_by_attr(&attr_query)` with `query.file = Some(file)`. When `use_file_index = true` and `use_type_index = false`, this uses `self.index_set.find_by_file()` for the segment candidate set. After `flush_data_only()`, `index_set` is stale (empty), so segment nodes are MISSED — old nodes for the file would not be found and not deleted.

**Why this does NOT cause a bug in current implementation:**
Deferred indexing is only activated when `_deferIndexing = true`, which requires `forceAnalysis = true` OR `_isEmptyGraph() = true`. Both paths guarantee the graph starts empty before the bulk load. An empty graph has no existing segment nodes to delete. Therefore the deletion phase correctly returns empty results (nothing to delete) in all paths where `defer_index = true` is used.

**If in the future deferred indexing were enabled on a non-empty graph:** the deletion phase would silently fail to delete old segment nodes, causing node duplication. This should be documented as a precondition of `defer_index = true`.

**Verdict: APPROVE** (precondition holds in all current activation paths).

---

### 4. `_sendCommitBatch()` — client.ts:1116

**Chunking logic:**

Single-chunk path (line 1127-1133):
```typescript
...(deferIndex ? { deferIndex: true } : {}),
```
`deferIndex` included in the single send. ✓

Multi-chunk path (lines 1150-1165):
```typescript
for (let i = 0; i < maxI; i++) {
    const response = await this._send('commitBatch', {
        changedFiles: i === 0 ? changedFiles : [],
        nodes, edges, tags,
        ...(deferIndex ? { deferIndex: true } : {}),
    });
```
`deferIndex` is included in EVERY chunk (not just the first). ✓

**Input universe for chunk count:**

| Scenario | maxI | Behavior |
|----------|------|----------|
| 0 nodes, 0 edges | max(0, 0, 1) = 1 | Single iteration, sends empty batch. OK. |
| Exactly CHUNK nodes | Single-chunk path | No loop. OK. |
| CHUNK+1 nodes | maxI = 2 | Two chunks. Both get deferIndex. OK. |
| CHUNK nodes, CHUNK+1 edges | maxI = max(1, 2, 1) = 2 | Two chunks. Both get deferIndex. OK. |

`changedFiles` correctly sent only in first chunk (i === 0) — deletion of old nodes only triggered once. ✓

**Verdict: APPROVE.**

---

### 5. JSASTAnalyzer `rebuildIndexes()` call — JSASTAnalyzer.ts:455

**Timing:**
```typescript
await pool.processQueue(queue);   // all module commits complete
clearInterval(progressInterval);

if (deferIndex && graph.rebuildIndexes) {
    await graph.rebuildIndexes();  // runs AFTER all commits
}
```
`pool.processQueue()` is `await`-ed before `rebuildIndexes()`. All deferred commits are complete when rebuild runs. ✓

**Condition correctness:**
- `deferIndex` captured at line 386 from `context.deferIndexing ?? false`. Immutable closure variable — no race possible. ✓
- `graph.rebuildIndexes` guard prevents runtime error if backend doesn't implement it. ✓

**`workerCount = 1` (enforced by Orchestrator line 265):**
WorkerPool runs tasks sequentially with `workerCount=1`. No concurrent `beginBatch`/`commitBatch` calls. ✓

**Failure propagation:**
`await graph.rebuildIndexes()` — if it throws, the error propagates out of `execute()` and up through PhaseRunner to Orchestrator. No silencing. ✓

**Verdict: APPROVE.**

---

### 6. Orchestrator detection logic

**`_deferIndexing = forceAnalysis || await _isEmptyGraph()` — timing issue (optimization miss, not a bug):**

Execution order in `run()`:
1. Line 182: `await this.graph.clear()` (if forceAnalysis) — empties the database
2. Line 187: `await this.graphInitializer.init(...)` — writes GRAPH_META + plugin nodes (20-35 nodes) to DELTA (not committed)
3. Line 191: `_deferIndexing = this.forceAnalysis || await this._isEmptyGraph()`

`_isEmptyGraph()` calls `nodeCount()` on the Rust engine. `node_count()` at engine.rs:1489 counts `new_live` delta nodes (those not in the segment). After step 2, delta has 20-35 nodes that are NOT in the (now-empty) segment → `new_live > 0` → `nodeCount() > 0` → `_isEmptyGraph() = false`.

**Consequence:**
- `forceAnalysis = true`: `_deferIndexing = true` (short-circuit, `_isEmptyGraph()` not called). Correct. ✓
- `forceAnalysis = false`, fresh graph (first ever run): `_deferIndexing = false` even though graph was empty before graphInitializer. The optimization does NOT engage for first-ever runs without `--force`/`--clear`.

**Is this a correctness bug?**
No. The analysis still completes correctly with normal `flush()` calls — just without the performance optimization. The result is correct data in the graph.

**Is this a product gap?**
Yes — the optimization misses the "first run without --force" case. Deferred indexing could be enabled in 2 additional cases: (a) after graph.clear() in the forceAnalysis path (already handled) and (b) before graphInitializer.init() runs. This should be tracked as a follow-up improvement.

**`runMultiRoot()` timing:** Same pattern at lines 307-314. Same conclusion. ✓

**Verdict: APPROVE** (correctness unaffected; optimization miss noted).

---

### 7. `_updatePhaseRunnerDeferIndexing()` — Orchestrator.ts:586

**State preserved by reconstruction:**
```typescript
this.phaseRunner = new PhaseRunner({
    plugins: this.plugins,
    onProgress: this.onProgress,
    forceAnalysis: this.forceAnalysis,
    logger: this.logger,
    strictMode: this.strictMode,
    diagnosticCollector: this.diagnosticCollector,
    resourceRegistry: this.resourceRegistry,
    configServices: this.configServices,
    routing: this.routing,
    deferIndexing,
});
```

All constructor deps are re-passed. The only state NOT preserved is `suppressedByIgnoreCount` (private instance var, resets to 0).

**Is `suppressedByIgnoreCount` loss a bug?**
No. `suppressedByIgnoreCount` is only incremented for `phaseName === 'ENRICHMENT'` (PhaseRunner.ts line 262). The two calls to `_updatePhaseRunnerDeferIndexing()`:
1. `_updatePhaseRunnerDeferIndexing(true)` at line 194 — before any phase runs. Count is 0 anyway. ✓
2. `_updatePhaseRunnerDeferIndexing(false)` at line 276 — after ANALYSIS completes, BEFORE ENRICHMENT runs. Count is 0 (no ENRICHMENT plugin has run yet). ✓

ENRICHMENT runs AFTER both updates, on the new PhaseRunner instance. Its counts accumulate correctly. `getSuppressedByIgnoreCount()` is read during ENRICHMENT's strict mode barrier (line 496), which is on the same (final) PhaseRunner instance. ✓

**Verdict: APPROVE.**

---

### Summary of Issues Found

| Severity | Location | Issue |
|----------|----------|-------|
| Optimization miss (not a bug) | Orchestrator.ts:191 | `_isEmptyGraph()` called after `graphInitializer.init()` adds delta nodes → deferred indexing disabled for first-ever runs without `--force`. No correctness impact. |
| Latent risk (not a current bug) | rfdb_server.rs:1526 | If `defer_index=true` were used on a non-empty graph, `find_by_attr` with file filter would miss segment nodes → silent deletion failure. Current activation paths preclude this. Precondition should be documented in code. |

### Conclusion

The implementation is correct for all currently activated paths. The deferred indexing optimization engages correctly when `forceAnalysis=true` (via `--force`/`--clear`), the indexes are rebuilt at the two correct points (after INDEXING, after JSASTAnalyzer), error propagation is sound throughout, and the PhaseRunner reconstruction does not lose observable state.

The optimization miss for first-ever runs without `--force` is a minor product gap (suboptimal performance, not incorrect behavior). The latent `find_by_attr` risk is not exploitable by the current orchestrator logic but should be documented as a precondition on `flush_data_only()` and `defer_index=true`.
