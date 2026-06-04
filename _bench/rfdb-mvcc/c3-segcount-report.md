# RFDB MVCC C3 — kill the O(segments) per-commit ceiling — report (PARTIAL)

Branch `rfdb-mvcc` (off C2 `f96b2b00`). Built + verified independently 2026-06-04. **Honest verdict: partial.**

## What was built (all SAFE — review verdict `safe`, no deadlock/UAF/aliasing/durability bug)

- **C3.b — Arc descriptor vectors → O(1) capture.** `Manifest`'s 4 segment-descriptor vecs become `Arc<Vec<SegmentDescriptor>>`; `ReadSnapshot::capture` is now `Arc::clone` (O(1)) instead of a deep clone of vecs carrying heavy zone-map `HashSet`s. Copy-on-write (`Arc::make_mut`) on change → snapshot isolation preserved (test `c3_arc_descriptor_snapshot_isolation`). serde `rc` feature added to (de)serialize the Arc vecs. **This is a clean pure win, foundational.**
- **C3.a — auto-compaction to bound live segment count** — runs at SAFE single-writer points (`commit_batch_ext(&mut self)` during bulk + a final round in `end_bulk_load`), per-shard L0 threshold = 64. 62 compactions fired over a 4000-commit bulk → **peak live L0 = 126 segments vs ~8000 projected** without it.
- **C3.c — bounded reclaim** at `EndBulkLoad` via the B5 pin-aware GC (`gc_collect`/`gc_purge`, retain ≥ `min_pinned`) → disk after barrier = 10.8 MiB for 4000 commits (40k nodes + 40k edges). Bounded.

## Measured (`tests/bench_c3_bulkload.rs`, my independent run: 3 passed, 166s, watchdog never fired)

| commits | ms/commit (steady) | peak live L0 | read lookup @4000 | disk after barrier |
|---------|--------------------|--------------|-------------------|--------------------|
| 600     | 22.5               | (run peak 126) | —               | —                  |
| 2000    | 32.5               |              |                   |                    |
| 4000    | 49.6               | 126 (vs ~8000) | 0.052 ms        | 10.8 MiB           |

- **Read latency:** 0.052 ms/lookup at 4000 commits — flat/tiny (C3.b + bounded count delivered).
- **Segment count:** decisively bounded (126 vs ~8000). ✓
- **Durability:** reopen-from-disk == oracle, ×2 no drift. ✓ Regression: full lib 860/2 (known token only).
- **Write throughput vs C2:** C3 @2000 = 32.5 ms/commit vs C2 @2000 = 88.9 → **~2.7x faster, gap widens with size** (C2 was super-linear; C3 segment-count is bounded).

## The two honest gaps (NOT fixed — the user must decide)

1. **ms/commit is NOT flat — it climbs 22.5→49.6 (2.21x over 600→4000).** Root cause is no longer segment count or capture (both bounded by C3) — it is **the L1 FULL-rewrite inside each compaction, which is O(total DB size) per compaction round**. Bounding *that* requires **tiered/partial L1 compaction** (L0→L1→L2…, merge only bounded same-size runs → amortized, not full-rewrite). Out of C3 scope; this is the real remaining lever for true write flatness.
2. **The production SERVER path does NOT auto-compact mid-bulk (the C3.a headline doesn't reach prod).** The server's `CommitBatch` dispatch routes to the CONCURRENT `&self` path (`commit_batch_concurrent` → `commit_batch_private`) whenever `supports_concurrent_commit()` (disk-backed V2), independent of `bulk_load_active`. Auto-compaction is only on the serial `&mut self` (`commit_batch_ext`) path, which the bench drives. So a real server-driven `BeginBulkLoad → CommitBatch×N → EndBulkLoad` gets segment bounding ONLY at the final `end_bulk_load` compaction, not during ingest.
   - **Root cause:** compaction structurally mutates live in-memory shard state IN PLACE (`set_l1_segments`/`clear_l0`/rebuild `global_index`) on plain `Vec`/`Option` with no interior locks. A true concurrent `&self` compactor would race `&self` appenders (UAF/lost-update) → needs a full interior-mutability rewrite of `Shard` + `GlobalIndex`. The fallback (single-writer compaction) was the correct SAFE choice (scope + impl flagged it explicitly), but the win currently lands only on the in-process `&mut self` bulk API.
   - **Cheap close (candidate):** when `bulk_load_active`, route the server's `CommitBatch` through `commit_batch_ext(&mut self)` (serial) instead of the `&self` concurrent path — bulk ingest is often single-stream, and serial-with-bounded-segments may beat concurrent-with-8000-segments. Trade-off: loses C1 concurrency during bulk. Needs measurement.

## Verdict

C3 delivered a **safe foundation + real wins** (Arc O(1) capture; live segment count bounded 126 vs 8000; read latency flat 0.052 ms; bounded disk; durability intact; ~2.7x faster writes than C2 at 2000 commits). It did NOT deliver flat write throughput, for two reasons now precisely located: **(1) full-rewrite compaction is O(DB) → needs tiered compaction; (2) the concurrent server path can't auto-compact without interior-mutability on `Shard`.** Both are the next levers; neither is a bug in what shipped.
