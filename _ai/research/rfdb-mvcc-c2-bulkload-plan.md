# RFDB MVCC — Stage C2 plan (bulk-load mode: deferred durability)

Self-contained spec. Model: `_ai/research/rfdb-mvcc-design.md`. Prior: B1–B5 + C1 (group-commit).
Base: worktree branch `rfdb-mvcc` at `707e3f7e` (B1–B5 snapshot-isolation MVCC + C1 group-commit, 3.02x).

## Goal of C2

The remaining throughput ceiling after C1 is the **commit-point fsync itself**. C1 amortizes it across
*concurrent* commits (mean batch ~3.5 → 3.02x). But the dominant Grafema workload — **initial bulk ingest
of a codebase (millions of nodes/edges, committed batch-by-batch)** — does NOT need per-commit durability:
if the process crashes mid-ingest, you just re-run the analysis. C2 adds a **bulk-load mode** that DEFERS
all fsync during ingest and does it ONCE at the end (a durable barrier), so per-commit fsync cost → ~0 during
the bulk phase. This helps even SERIAL bulk ingest (orthogonal to, and composable with, C1's concurrent path).

## What already exists (SCOPE must verify exact lines)

- `DurabilityMode { Strict, Relaxed }` — `manifest.rs:59`. `Relaxed` = "skip fsync (OS handles flush)".
- The commit/publish path reads `m.durability()` under the manifest Mutex (`multi_shard.rs:2581`, `let (snap, durability) = { ...; (self.snapshot(&m), m.durability()) }`).
- Segment `sync_all()` + shard-dir `fsync_dir` in the lock-free build phase are **already gated on `== Strict`** (`multi_shard.rs:2795, 2830, 2850`) → `Relaxed` already skips them.
- Manifest durable writes: `atomic_write_json` / `DurabilityMode::Strict` fsync at `manifest.rs:724, 1867` (temp+fsync+rename); under `Relaxed` the fsync is skipped but the **rename stays atomic** (POSIX) → current.json is never torn, only the un-fsync'd tail can be lost on crash.
- Durability is fixed at store creation: `ManifestStore::create_with_config / open_with_config(db_path, durability)` (`manifest.rs:896, 953`). **No runtime setter yet.** Accessor `durability()` at `manifest.rs:1080`.
- Protocol: `Request` enum + dispatch in `src/bin/rfdb_server.rs`. `Request::Flush => with_engine_write(|e| e.flush())` (`rfdb_server.rs:1477`) is the model for new control commands. Concurrent commit entry is `Request::CommitBatch` (`rfdb_server.rs:1738`, runs under `db.engine.read()` with bounded retry — C1/B4).

## C2 design

### C2.1 — runtime durability switch
Add `ManifestStore::set_durability(&mut self, DurabilityMode)` (sets `self.durability`). It is mutated under
the **manifest Mutex** (the commit point already locks it). Consistency: any commit that grabs the lock AFTER
the switch reads the new mode via `m.durability()`; a commit already past its `m.durability()` read finishes in
its old mode (fine — at worst one extra/skipped fsync at the boundary, never a correctness issue).

### C2.2 — durable barrier `make_durable()`
A method on the store (and an engine passthrough) that makes the **entire current published state** durable in
ONE pass, regardless of what `Relaxed` skipped:
- For every segment descriptor in the **current** manifest version (all shards, nodes+edges): open the seg file, `sync_all()`. (Files already written; this flushes page-cache → disk.)
- `fsync_dir` each unique shard directory + the manifest directory + db root (dir-entry durability on ext4/XFS; no-op on macOS — keep the existing `fsync_dir` helper's platform behaviour).
- Re-persist the manifest pointer (`current.json` + any pending edit/checkpoint) under `Strict` (one fsync) so the version pointer itself is durable.
- O(segments), but ONCE. After it returns, the full current state is on stable storage.

### C2.3 — protocol commands
Two new `Request` variants in `rfdb_server.rs`, each via `with_engine_write` (rare control ops; taking the
engine write lock briefly is correct — `EndBulkLoad` SHOULD serialize against in-flight commits so all ingest
is done before the barrier):
- `BeginBulkLoad` → `store.set_durability(Relaxed)`. Respond Ok.
- `EndBulkLoad` → `store.make_durable()` then `store.set_durability(Strict)`. Respond Ok.
(SCOPE: pick the minimal wiring through `engine_v2` / `MultiShardStore` to reach the `ManifestStore` behind its Mutex. A thin `engine.begin_bulk_load()` / `engine.end_bulk_load()` passthrough mirroring `engine.flush()` is the expected shape.)

### C2.4 — crash contract (document in code + prove in test)
- **Crash BEFORE `EndBulkLoad`**: tail commits may be lost (Relaxed skipped their fsync). Reopen MUST NOT
  panic or corrupt — it loads the last consistent manifest pointer (atomic rename guarantees current.json is
  never torn). If current.json points at an edit whose bytes didn't reach disk, load must fail **cleanly**
  (recoverable error / fall back to last checkpoint), never panic. Contract: *crash mid-bulk ⇒ re-run analysis.*
- **Crash AFTER `EndBulkLoad`**: reopen sees the FULL bulk-loaded state, bit-faithful. This is the guarantee.

### C2.5 — composition with C1
Bulk-load only flips the durability flag the C1 publish reads. Concurrent (C1) commits under `Relaxed` +
final barrier must compose: the C1 stress must still pass in bulk mode, and `EndBulkLoad` must make that
concurrently-built state fully durable.

## Acceptance (the measure + the safety)

⚠️ **MANDATORY in-process watchdog** (`std::process::abort()` @~60s) on every concurrency test. Shell-timeout too.

1. **Throughput — the headline.** SERIAL bulk ingest of N batches (e.g. 2000 commits, disjoint files, the C1
   throughput-bench shape but single-threaded):
   - baseline: `Strict` (per-commit fsync) wall.
   - bulk: `BeginBulkLoad` → same N commits in `Relaxed` → `EndBulkLoad` (barrier) wall (INCLUDING the barrier).
   - Report `BULK_SPEEDUP = strict_wall / bulk_wall` + the single-barrier cost (ms) + segment count fsynced.
   Expect a large win (fsync ~5–10ms/commit dominates serial latency). Also report **bulk + concurrent (C1)**
   combined wall for completeness. If the win is small, report why (where the cost moved).
2. **Durability barrier works (THE safety).** Bulk-load N commits, call `EndBulkLoad`, then **reopen the store
   from disk** (fresh `open`, not the in-memory handle) → counts == independent oracle, data bit-faithful. Do
   this for both serial and concurrent (C1) bulk loads.
3. **Crash-before-barrier is safe (not corrupt).** Bulk-load some commits, do NOT call the barrier, simulate a
   crash (drop/forget the store without the barrier, or a child process killed -9 mid-bulk), then reopen →
   either a consistent older state OR a clean recoverable error; **never a panic / unrecoverable corruption**.
   Assert the reopen does not panic and the manifest is parseable (possibly to an earlier version).
4. **Mode restored + Strict still durable.** After `EndBulkLoad`, a subsequent normal commit is `Strict`
   again (per-commit durable): reopen after that single commit (no extra barrier) sees it.
5. **No regression:** full lib + graph + B1–B5 + C1 acceptance green (minus the 2 known token fails:
   `test_search_cross_convention`, `test_search_fuzzy_heartbeat`).

## Constraints (every agent)
- Work ONLY in the worktree `/Users/vadimr/grafema/.claude/worktrees/rfdb-mvcc/packages/rfdb-server` (branch `rfdb-mvcc` at `707e3f7e`). cd there for cargo.
- Do NOT git commit/push. Do NOT touch the main checkout. Do NOT call Enox (it hangs).
- Builds slow; generous timeouts. CONCURRENT tests → in-process watchdog MANDATORY; diagnose a hang via ps/sample + kill -9, never wait.
- Durability/crash-safety is the point — a barrier that doesn't actually fsync, or a reopen that panics on a partial bulk, is a FAIL. If full crash-safety needs more than is safe here, implement the conservative version (barrier fsyncs everything; reopen tolerates partial) and report exactly where you stopped. Never ship a silent data-loss-on-clean-shutdown path (clean `EndBulkLoad` MUST be durable).
- Evidence: file:line + measured numbers (the speedup + the barrier cost are the headline; the reopen-after-barrier oracle is the safety proof).

## Out of scope
- Auto-detecting bulk-load (heuristics). Explicit Begin/End only.
- Landing `rfdb-mvcc` onto the user's branch (needs explicit user request).
- Full per-shard tombstone-field cleanup (deferred).
