# RFDB MVCC — Stage C3 plan (kill the O(segments) per-commit ceiling)

Self-contained spec. Model: `_ai/research/rfdb-mvcc-design.md`. Prior: B1–B5 + C1 (group-commit) + C2 (bulk-load).
Base: worktree branch `rfdb-mvcc` at `f96b2b00` (C2 bulk-load / deferred durability).

## The ceiling C3 removes (measured, not theory)

C2 proved fsync is NOT the dominant serial-bulk cost. After deferring fsync, per-commit wall still CLIMBS with
DB size: bulk **37.9 ms/commit @600 commits → 88.9 ms/commit @2000** (`_bench/rfdb-mvcc/c2-bulkload-report.md`).
Root cause: **O(segments) per-commit work that grows because segment count grows** (no compaction during bulk):
1. `ReadSnapshot::capture` (read_snapshot.rs) DEEP-CLONES all 4 segment-descriptor `Vec`s (`m.node_segments.clone()` ×4) every snapshot/commit. `SegmentDescriptor` carries a zone-map `HashSet<String>` → the clone is heavy.
2. The commit produces the next version's descriptor vec by appending (O(segments) per commit).
Both scale with live segment count → serial bulk ≈ **O(commits × segments) = O(N²)**.

## Strategy (user decision 2026-06-04 — disk-for-speed)

Trade disk for speed deliberately: keep the **LIVE segment count bounded** via aggressive compaction during
bulk; leave superseded segments on disk in-run (cheap); reclaim them at the bulk boundary / a size threshold so
usage is bounded ("eats disk but super fast, не весь диск"). See memory `project_rfdb_disk_for_speed`. Plus a
free algorithmic win (Arc descriptors) so capture/read is O(1) regardless of count.

## C3 design — two complementary levers

### C3.a — auto-compaction during bulk (bounds live segment count) — THE headline
- Trigger L0→L1 compaction automatically when live L0 segment count (per shard, or total) crosses a threshold,
  WHILE bulk-load is active (and optionally generally). Goal: live segment count stays ~bounded → the O(segments)
  per-commit cost becomes O(bounded) ≈ flat. Reuse existing `should_compact`/`compact_shard`/`compact_with_threads`
  (multi_shard.rs:3294/3346) — do NOT rewrite compaction, just trigger it.
- **THE RISK (SCOPE must resolve first):** compaction currently runs via explicit `store.compact(&mut manifest, …)`
  and (per B5) under the engine WRITE lock; but bulk commits run concurrently via `commit_batch_private(&self)`
  through the manifest `Mutex` (B4/C1). Auto-compaction must publish its new (compacted) version using the SAME
  MVCC commit-point discipline (new immutable L1 segments built lock-free, then a short manifest-mutex publish),
  **deadlock-free** (no lock spanning the rewrite I/O), and reader-safe (B5 pins: a live reader on an old version
  keeps its L0 segments — compaction must NOT delete pinned segment files; it only publishes new L1 + marks old
  L0 superseded; reclaim is deferred). SCOPE: determine the safe mechanism — leader-triggered at the C1 commit
  point (build compacted L1 lock-free, publish in the same short critical section) vs a dedicated bounded
  background compactor that commits like any other writer. Pick the one that is deadlock-free BY CONSTRUCTION and
  does the slow rewrite I/O OUTSIDE the manifest mutex. If neither is safely achievable here, implement the
  conservative version (compact only at safe single-writer points, e.g. folded into EndBulkLoad and/or when no
  concurrent commit is in flight) and REPORT the limitation — never ship a deadlock or a reader UAF.
- **Superseded segments: do NOT reclaim in-run** (disk-for-speed). They pile on disk; the manifest's live version
  references only the compacted L1 + recent L0.

### C3.b — Arc descriptor vectors (O(1) capture) — free pure win
- Change `Manifest`'s 4 segment vecs (`node_segments`/`edge_segments`/`l1_node_segments`/`l1_edge_segments`,
  manifest.rs:151/154/187/191) so `ReadSnapshot::capture` no longer DEEP-clones them — hold `Arc<Vec<SegmentDescriptor>>`
  (or equivalent) so capture = O(1) `Arc::clone`. SCOPE maps every site that constructs/mutates these vecs
  (apply/reconstruct/commit/compact) and keeps them correct (copy-on-write: build a new Arc<Vec> only when a
  version actually changes the set). This removes the read-side and capture-at-commit O(segments) entirely.
  (The commit-side append remains O(current-live-count), which C3.a keeps bounded.)

### C3.c — bounded reclaim (so it's "не весь диск")
- At `EndBulkLoad` (extend `make_durable` or add a step) AND when superseded-on-disk crosses a threshold during
  bulk, run the B5 pin-aware GC (`gc_collect`/`gc_purge`, manifest.rs:1755/1850 — retain ≥ `min_pinned`) to
  reclaim superseded segment files. Net: disk grows during bulk, drops at the boundary; bounded multiple of
  logical size, never unbounded. Must respect live-reader pins (never delete a pinned segment).

## Acceptance (the measure + safety)

⚠️ **MANDATORY in-process watchdog** (`std::process::abort()` @~60–180s, label per test) on EVERY concurrency
test (auto-compaction-under-concurrent-commits is a NEW deadlock surface). Shell-timeout too.

1. **FLATNESS — the headline.** Serial bulk ingest, measure bulk ms/commit at **600 / 2000 / 4000 commits**.
   With C3.a, ms/commit must stay ~FLAT (bounded) instead of climbing 38→89. Report the three numbers + the live
   segment count at each (should be bounded, not ~2×commits). Also report BULK_SPEEDUP vs Strict at 2000+ (should
   now be large AND non-decaying). If still climbing, report why (where the O(segments) cost survived).
2. **Read latency bounded.** A query/scan after a large bulk-load is O(bounded segments), not O(commits) — show a
   number (e.g. a full scan or a point lookup latency at 600 vs 4000 commits stays ~flat).
3. **Durability + integrity unchanged.** C2 still holds: reopen-from-disk after EndBulkLoad == independent oracle,
   bit-faithful; crash-before-barrier no panic. Concurrent storm (disjoint + same-file + deletes) WITH
   auto-compaction running → counts == oracle, reopen ×2 faithful, no loss.
4. **Reader-safety under in-bulk compaction (B5).** A long reader pins a version; auto-compaction + commits churn;
   the reader keeps returning ITS-version correct data; no panic, no deleted-pinned-segment (UAF). Watchdog armed.
5. **Disk bounded.** After EndBulkLoad's reclaim, `segments/` disk is a BOUNDED multiple of logical size (assert a
   ceiling), and superseded files from the bulk are gone (or below threshold). During bulk it may bloat — that's OK.
6. **No deadlock (liveness).** The concurrent-commit + auto-compaction stress completes (watchdog never fires).
7. **No regression:** full lib + graph + B1–B5 + C1 + C2 acceptance green (minus the 2 known token fails:
   `test_search_cross_convention`, `test_search_fuzzy_heartbeat`).

## Constraints (every agent)
- Work ONLY in the worktree `/Users/vadimr/grafema/.claude/worktrees/rfdb-mvcc/packages/rfdb-server` (branch `rfdb-mvcc` at `f96b2b00`). cd there for cargo.
- Do NOT git commit/push. Do NOT touch the main checkout. Do NOT call Enox (it hangs).
- Builds slow; generous timeouts. CONCURRENT + auto-compaction is a NEW deadlock/UAF surface — in-process watchdog MANDATORY on every concurrency test; diagnose a hang via ps/sample + kill -9, never wait.
- Data integrity + deadlock-freedom + reader-safety (B5 pins) are non-negotiable. The slow compaction rewrite I/O MUST run OUTSIDE the manifest mutex (else it re-serializes / can deadlock). If full concurrent auto-compaction isn't safely achievable here, do the conservative safe version + report exactly where you stopped. Never ship a probable deadlock, a reader UAF, or a lost update.
- Evidence: file:line + measured numbers (the ms/commit flatness curve across 600/2000/4000 is the headline).

## Out of scope
- Landing `rfdb-mvcc` onto the user's branch (needs explicit user request).
- Full per-shard tombstone-field cleanup (deferred).
- Tuning the compaction threshold to an optimum — pick a reasonable bound, report it, leave tuning for later.
