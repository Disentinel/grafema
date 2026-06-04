# RFDB MVCC C2 — bulk-load (deferred durability) report

Branch `rfdb-mvcc` (off C1 `707e3f7e`). Built + verified independently 2026-06-04.

## What was built

A **bulk-load mode = deferred durability**: during initial bulk ingest, per-commit fsync is skipped
(`DurabilityMode::Relaxed`), and durability is established ONCE at the end via an explicit barrier.

- **`ManifestStore::set_durability`** (manifest.rs) — runtime durability switch, mutated under the manifest mutex (consistent with the commit point's `m.durability()` read).
- **`ManifestStore::make_durable`** (manifest.rs) — the barrier. In stable-storage order (data before pointer): (1) `sync_all` every segment file of the **current published version** (all shards, L0+L1, nodes+edges, enumerated from the immutable manifest snapshot — NOT the live shard buffers); (2) `sync_all` the version's manifest-chain JSON (checkpoint + edits up to current + index); (3) `fsync_dir` each shard dir + manifests dir + db root; (4) re-persist `current.json` LAST under `Strict`. Visibility never advances past durability across the barrier. Any fsync error propagates (does NOT silently restore Strict).
- **`GraphStore::begin_bulk_load` / `end_bulk_load`** (graph/mod.rs default no-op; engine_v2.rs override) + **`Request::BeginBulkLoad` / `EndBulkLoad`** protocol commands (rfdb_server.rs), both via `with_engine_write` (serialized vs in-flight commits — all ingest is done before the barrier).
- Composes with C1: bulk only flips the durability flag the C1 group-commit publish reads.

## The measurement (the honest result)

Serial bulk ingest, N small disjoint commits, `tests/bench_c2_bulkload.rs::c2_throughput_and_serial_durability`:

| N commits | ~segments | strict ms/commit | bulk ms/commit | fsync fraction | BULK_SPEEDUP |
|-----------|-----------|------------------|----------------|----------------|--------------|
| 600       | 1200      | 71.5             | 37.9           | ~47%           | **1.88x**    |
| 2000      | 4000      | 122.4            | 88.9           | ~27%           | **1.38x**    |

**The premise was wrong.** Going in we assumed "the commit-point fsync is the serial bulk ceiling, so
deferring it gives near-linear ingest." Measurement refutes it: the fsync part is ~**constant ~33 ms/commit**;
everything above that is **O(segments) per-commit work that GROWS with DB size** (bulk ms/commit climbs
37.9 → 88.9 as segments go 1200 → 4000). So the bulk speedup **decays** as the DB grows — fsync becomes a
smaller and smaller fraction. C2 is a real but modest win (1.4–1.9x), bounded by the fsync fraction.

**Root cause of the O(segments) cost (identified, not yet fixed):** `ReadSnapshot::capture` (read_snapshot.rs)
deep-clones all four segment-descriptor `Vec`s (`m.node_segments.clone()` ×4) on every snapshot/commit. With
no compaction during bulk, segment count grows linearly with commits → snapshot capture is O(segments) per
commit → total serial bulk ingest is ~O(commits × segments) = O(N²). **This is the next ceiling** (matches the
known "second write-path ceiling": O(segments) manifest/snapshot work). Fix directions: `Arc<Vec<descriptor>>`
per segment-class so capture is O(1) refcount bumps; and/or periodic compaction during bulk to keep segment
count bounded; and/or larger commit batches (fewer, bigger segments).

## Durability + safety (the actual C2 guarantee — all proven green)

`tests/bench_c2_bulkload.rs`, 4 tests, my independent run `4 passed; 0 failed` (99.3s):
- **Barrier durability:** bulk-load 600 commits → `EndBulkLoad` → reopen FROM DISK → node/edge counts == oracle (2400==2400), bit-faithful sample. PASS.
- **Crash-before-barrier safe:** bulk-load, DROP handle without barrier, reopen → no panic, counts ≤ committed, stable on second reopen. PASS.
- **Mode restored:** after `EndBulkLoad`, a subsequent normal commit is `Strict` again, durable without a second barrier. PASS.
- **Bulk + concurrent (C1) durability:** 8 threads × 60 commits under Relaxed → one barrier (39ms, 960 seg files) → reopen == oracle (1920). combined_wall 9.6s. PASS.

Regression: full lib `860 passed; 2 failed` (the 2 known token tests only).

## Verdict

C2 DELIVERED as a **durability primitive** (deferred-fsync + correct barrier, crash-safe, composes with C1),
but the throughput win is modest and decaying because **fsync was not the dominant serial-bulk cost**. The
real, larger lever for bulk ingest is the **O(segments) per-commit snapshot/manifest cost** (next stage).

## Lesson

Violated `feedback_perf_measure_first` — should have measured the fsync FRACTION of one commit before building
the whole stage. The earliest catchable signal was a one-commit cost breakdown. Recorded.
