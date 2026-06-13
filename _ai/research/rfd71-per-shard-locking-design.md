# RFD-71 — Per-Shard Locking Design

Status: design (2026-05-31). Prereq DONE: delta-manifest (manifest commit is now O(Δ), so the serialized manifest-append is short — this is what makes a brief global critical section viable).

## Target structure

```
Database { engine: Arc<PerShardEngine> }

PerShardEngine {
    shards: Vec<RwLock<Shard>>,        // independent per-shard locks
    global_state: Mutex<GlobalState>,  // node_to_shard, file_to_node_ids, enrichment_edge_to_shard
    manifest_store: RwLock<ManifestStore>,
    planner: ShardPlanner,             // immutable after init
}
```

`PerShardEngine` implements `GraphStore` via interior mutability → **no trait signature change** (`src/graph/mod.rs:18`). Callers keep `with_engine_write(|e| e.add_nodes(...))`. `Database.engine` type flips from `RwLock<Box<dyn GraphStore>>` (`database_manager.rs:125`).

## Lock order (deadlock-free, strict total order)

1. `Mutex<GlobalState>` → 2. `RwLock<ManifestStore>` → 3. `RwLock<Shard[i]>` by ascending shard_id.

Reads acquire only the target shard's `read()`. Tombstones stay GLOBAL (per perf report — splitting breaks query correctness).

## commit_batch_ext phase → lock map

| Phase | Work | Lock |
|---|---|---|
| 1 snapshot old | read file_to_node_ids + nodes | brief `GlobalState` (+ shard reads) |
| 2–6 compute tombstones/types | analysis on snapshots | **none** |
| 4.5 drop old index entries | mutate file_to_node_ids | brief `GlobalState` |
| 5 add nodes/edges | per-shard write buffers | per-shard `write()` (parallel across disjoint shards) |
| 5.5 un-tombstone re-added | mutate tomb set | brief `GlobalState` |
| 7 flush | segment I/O | per-shard `write()` (later: threaded) |
| 8 manifest commit_edit | O(Δ) append | `ManifestStore::write()` (short) |
| 9 build delta | — | none |

`next_segment_id()` is already atomic — concurrent commits get disjoint segment ids.

## GlobalState protection: `Mutex<GlobalState>` (recommended) over DashMap

Commits are file-scoped; two concurrent re-analyses almost never touch the same file/shard. Mutex held ~1–5 ms/commit; µs overhead dwarfed by commit latency. DashMap's `file_to_node_ids` inner `HashSet` still needs inner sync and complicates reasoning — not worth it.

## Staged plan (each green-testable, revertable)

1. **PerShardEngine wrapper** impl GraphStore, flip `Database.engine` type, update `with_engine_read/write` (`rfdb_server.rs:2362-2399`). Locks still sequential. Risk: MED (core abstraction, trait API unchanged).
2. **Per-shard write locks** in add_nodes/upsert_edges (reuse existing `par_iter_mut` `multi_shard.rs:337-366`). Verify via `bench_lock_contention`. Risk: LOW.
3. **Global critical sections**: phases 1/4.5/5.5 under `Mutex<GlobalState>`, 2–6 lock-free. Risk: MED (phase ordering).
4. **Parallel flush** (phase 7 threaded per shard). Risk: MED.
5. **Manifest under its own `RwLock`** only at phase 8 (decoupled from GlobalState). Multi-writer throughput test. Risk: MED.
6. (stretch) **Per-shard read locks** — reads scale with shard count. Risk: LOW.

## ⚠️ Editor's critical caveat (gap the design under-addresses)

**Same-shard transaction isolation / TOCTOU.** The plan runs phases 1–6 lock-free on a *snapshot*, acquiring shard write locks only at phase 5/7. Two concurrent commits hitting the **same shard** can both snapshot (phase 1), both compute tombstones, then both write — classic read-then-write race. "Same-shard commits serialize" is NOT guaranteed by phase-5 write locks alone, because the snapshot was taken earlier without holding the lock.

Resolution options to decide BEFORE Stage 3:
- **Per-shard (or per-file) commit lock** spanning the whole transaction for shards it touches — simplest, serializes same-shard commits fully (acceptable: same-file concurrent re-analysis is rare).
- **Optimistic concurrency**: re-validate the snapshot under the phase-5 write lock; retry on conflict.
- Recommendation: start with a coarse per-touched-shard transaction lock (correctness first), measure, optimize only if same-shard contention shows up.

**Load-bearing assumption (verify first):** RFD-71 only pays off if real workloads spread commits across shards. If most concurrent commits hit one shard, no win. Stage 1 must ship a contention histogram before investing in stages 3–5. (Files route to shards by directory hash via ShardPlanner — measure the actual distribution on vscode-scale.)

## References
- `database_manager.rs:125`, `bin/rfdb_server.rs:2362-2399` (engine lock)
- `multi_shard.rs:1076-1430` (commit_batch_ext phases), `:111/120/125` (global indexes), `:337-366` (par_iter_mut)
- `graph/mod.rs:18` (GraphStore trait), `manifest.rs:commit_edit` (O(Δ) append)
- Bench: `bench_lock_contention` (engine-wide ~1 core vs per-shard ~2 on 4-core)
