# RFDB Storage-V2 Write-Path Performance Investigation

Scope: write/commit hot path of RFDB-server storage_v2 at HEAD (`97f0678f`). Goal: locate the weak spots that pin write throughput and inflate per-commit latency, and judge what RFD-71 (per-shard locking) actually fixes. Every claim below carries a verified `file:line` or a measured number from the three prebuilt probes (`bench_lock_contention`, `bench_manifest_growth`).

---

## 1. Executive summary — ranked weak spots

1. **Engine-wide write lock pins all writes to ~1 core.** Every write op routes through one `RwLock<Box<dyn GraphStore>>` (`src/database_manager.rs:125`, `src/bin/rfdb_server.rs:2391`). Measured: engine-wide speedup caps at **1.45x @ 4 threads** vs **2.19x** for per-shard — ~1.5x write parallelism left on the table. **Severity: critical. Fixed by RFD-71: yes.**

2. **Manifest is re-serialized in full under the lock on every commit, O(segment count).** Cumulative cost is quadratic without compaction. Measured: commit latency **78 ms -> 535 ms** as segments grow **200 -> 2000** (6.9x for 10x); current-manifest **44.6 KB -> 447 KB** at ~446 B/commit unbounded. **Severity: high. Fixed by RFD-71: no** (serial serde, single writer at P8).

3. **Compaction is never auto-triggered during ingest, so segment count grows O(commits) unbounded.** No `should_compact()` call exists in the commit path (`src/storage_v2/multi_shard.rs` commit_batch_ext 1076-1391); compaction only fires on explicit `Compact` RPC. This is the *root cause* that makes #2 unbounded. **Severity: critical. Fixed by RFD-71: no.**

4. **Phase-7 flush is a serial `for` loop across K shards inside the lock** (`src/storage_v2/multi_shard.rs:1308`). Real per-commit cost is dominated by P8 manifest serialization, not P7 (adversarial decomposition: P7 ~ constant ~20 ms/commit, P8 scales). **Severity: medium (downgraded from high). Fixed by RFD-71: partial** (frees the lock for *other* threads; does not parallelize the loop).

5. **Tombstone clone-on-write happens twice per commit (P4 + P5.5).** Each clone is O(T) on a global `Arc<TombstoneSet>` shared across shards (`src/storage_v2/multi_shard.rs:1212-1233`, `1273-1279`). Bounded by compaction (`clear()` on compact). **Severity: medium. Fixed by RFD-71: no** (global set is architecturally required for query semantics).

REFUTED: the global-index **data-race** claim is false — all index mutations are under the exclusive `RwLock`, no concurrent writer can run (see Section 3). The `query-read` P2 "250K all-shard scan" claim is false — P2's `find_edge_keys_by_src_ids` is shard-targeted with bloom pruning, not all-shard linear (see Section 3).

---

## 2. The manifest finding (front and center)

**Mechanism.** Every commit, `manifest_store.commit()` serializes the *entire* `Manifest` struct via `atomic_write_json` (`src/storage_v2/manifest.rs:875`), then writes the index file and the current pointer — three atomic JSON writes per commit (`manifest.rs:875`, `881`, `885`). The manifest carries one `SegmentDescriptor` per segment, each with zone maps `node_types` / `file_paths` / `edge_types` as `HashSet<String>` (`src/storage_v2/manifest.rs:159-169`), serialized in full unless empty. Each commit clones the current segment list and extends it (`src/storage_v2/multi_shard.rs:1353-1356`), so **all prior segment descriptors are re-serialized every commit**. This runs at phase P8, inside the engine-wide lock.

**Per-commit cost is O(S)** (S = total segment count). Because S grows linearly with commits when compaction is off, **cumulative write cost is quadratic.**

**Measured, no compaction (`--compact-every 0`):**

| commit | #seg | cur manifest B | manifests/ dir B | commit ms |
|-------:|-----:|---------------:|-----------------:|----------:|
|    100 |  200 |         44,618 |          175,791 |     77.99 |
|    300 |  600 |        133,881 |          532,848 |    180.50 |
|    500 | 1000 |        223,143 |          889,893 |    293.13 |
|   1000 | 2000 |        447,315 |        1,786,555 |    535.08 |

Manifest bytes track segment count exactly at **~446 B/commit, dead-linear, unbounded**; commit latency climbs 6.9x for a 10x segment growth.

**Does compaction bound it? Yes — structurally, but it is not free.** With `--compact-every 50`, at commit 1000:

| metric @ commit 1000 | no-compact | compact | delta |
|---|---:|---:|---|
| cur manifest B | 447,315 | 61,598 | **7.3x smaller** |
| manifests/ dir B | 1,786,555 | 164,006 | **10.9x smaller** |
| commit ms | 535.08 | 244.14 | **2.2x faster** |
| segments/ dir B | 11,077,500 | 112,816,166 | **10.2x LARGER (disk)** |

Compaction collapses the L0 descriptor pile-up: it filters out compacted shards' segments (`src/storage_v2/multi_shard.rs:1658-1660`) and clears tombstone lists. Residual manifest growth under compaction is only **2.4x** over the run (26,080 -> 61,598 B) — that residue is the *live* zone-map set scaling with node count, not descriptor accumulation. The per-commit floor flattens to **~53-75 ms** regardless of graph size (8k -> 80k nodes); the only spikes (205.88, 244.14 ms) land on compaction-boundary commits, not on graph size.

**The cost is shifted, not erased.** Compaction time rises monotonically **116 ms -> 490 ms @ commit 1000** (the `compact()` `global_index` rebuild is O(N) over the whole store, `src/storage_v2/multi_shard.rs:1648-1651`), and the on-disk `segments/` directory bloats **10.2x** because superseded segments are not reclaimed within the run. Net: compaction trades steady-state per-commit latency + manifest size for a growing periodic CPU stall and disk amplification.

**vscode-scale projection:** 9065 files with no auto-compact ~ 9065+ L0 segments ~ ~4 MB manifest re-serialized under the lock per commit (446 B/segment x ~9065), per the measured slope. This is the unbounded tail RFD-71 does *not* touch.

---

## 3. Weak-spot table (post-verification)

| dimension | cost model | scaling | in serialized section | severity (verified) | fixed by per-shard lock? |
|---|---|---|---|---|---|
| **lock** | every write op -> one `RwLock`; commit_batch_ext phases 1-8 all `&mut self` | superlinear | yes | **critical** | **yes** — disjoint shards commit in parallel; 1.45x->2.19x @4t |
| **compaction (not auto-triggered)** | S grows O(commits); no `should_compact()` in commit path | superlinear | yes | **critical** | **no** — manifest/disk cost independent of lock granularity |
| **manifest** | full JSON re-serialize O(S); zone maps ~70% of descriptor bytes | linear/commit, quadratic cumulative | yes | **high** | **no** — serde is serial, single writer at P8 |
| **commit-phases (P8 dominant)** | P8 manifest serialize O(S) is the scaling term | superlinear | yes | **high** | **no** — P5 par_iter already parallel; P8 stays in lock |
| **flush (P7 serial loop)** | `for shard_idx in 0..K` flush, not par_iter (`multi_shard.rs:1308`) | constant-ish per commit | yes | **medium** (down from high) | **partial** — frees lock for other threads; loop stays serial |
| **tombstone clone** | 2x O(T) clone of global `Arc<TombstoneSet>` per commit | superlinear (unbounded w/o compaction) | yes | **medium** | **no** — global set required for query correctness |
| **query-read** | find_nodes fan-out K shards w/ zone-map prune; get_incoming_edges no dst routing | linear | partial | **medium** (down from high) | **no** (helps indirectly: lock freed sooner) |
| **global-indexes** | 3 in-mem maps mutated per commit; ~944 MB @ 6.34M nodes | linear | yes | **medium** (down from high) | **no** — and the *data-race* claim is **REFUTED** |

**Refutations (do not act on these as stated):**
- **global-indexes "data race":** FALSE. All mutations (`node_to_shard` insert `src/storage_v2/multi_shard.rs:342`, `file_to_node_ids` `343-346`/`1243`, `enrichment_edge_to_shard` `384-387`) occur under the exclusive `RwLock`; readers take a shared lock that blocks writers. No race exists *today*. It only becomes a constraint *if* RFD-71 removes the engine lock without re-protecting these maps — that is a refactor requirement, not a pre-existing bug.
- **query-read P2 "250K all-shard scan / O(KxSxN)":** FALSE as the dominant cost. `find_edge_keys_by_src_ids` is shard-targeted via `node_to_shard` with per-shard bloom filters (`src/storage_v2/multi_shard.rs:954-1021`, `src/storage_v2/shard.rs:528-551`); all-shard fallback only for unmapped IDs. The measured scaling tracks manifest serialization, not P2.

---

## 4. RFD-71 implications (per-shard locking)

**What RFD-71 fixes.** The engine-wide `RwLock` is the only thing serializing *unrelated* commits. Measured: engine-wide caps at **1.45x @ 4 threads** (~1 core); per-shard reaches **2.19x** (`bench_lock_contention`, reproduces the prior 0.98-core vs 2.04-core result). Two commits on disjoint shard sets ({0,1} vs {3,5}) can proceed concurrently once each shard has its own lock. This is the single highest-leverage write-throughput fix and the direct RFD-71 root cause.

**What RFD-71 does NOT fix — the serialized residue.** Even with the lock split, three costs remain in a serial section:
- **Manifest serialization (P8).** `to_writer_pretty` is inherently serial and runs once per commit *after* all shard work (`src/storage_v2/manifest.rs:875`; P8 at `multi_shard.rs:1350-1372`). A single global manifest = single writer. Per-shard locks cannot move it out of the critical path.
- **Tombstone clone (P4/P5.5).** The global `Arc<TombstoneSet>` is required so any shard's query sees a consistent tombstone view (`is_node_tombstoned` reads `shards[0]` as the global source, `multi_shard.rs:456-467`). Splitting it per-shard would force union-on-query or K-fan-out checks — slower reads. So the clone payload, not the lock, is the cost.
- **Phase-7 flush loop.** Serial across K shards within one commit (`multi_shard.rs:1308`). RFD-71 lets *other* threads progress on other shards during this I/O, but does not parallelize the loop itself.

**Bottom line for RFD-71:** lifting the engine lock is **necessary but not sufficient.** It unlocks ~1.5x more write parallelism, but the manifest-serialization + unbounded-segment-count ceiling is *orthogonal* and remains lock-held. Both ceilings must be addressed separately, and the manifest ceiling is the one that grows with graph size.

---

## 5. Recommended next steps (prioritized)

1. **Auto-trigger compaction during ingest.** `should_compact()` exists (`src/storage_v2/multi_shard.rs:1468`, threshold from `src/storage_v2/resource.rs:110`) but is only consulted inside explicit `compact()`. Wire a check into `commit_batch_ext` (`src/storage_v2/multi_shard.rs:1076`) so L0 segment count is bounded automatically. *Rationale:* measured 7.3x manifest shrink + 2.2x commit-latency drop + flat per-commit floor. This is the biggest single win and gates the manifest ceiling that RFD-71 cannot.

2. **Ship per-shard locking (RFD-71), but re-protect the global indexes.** Split the engine lock into per-shard locks; keep a fast spinlock/short critical section around the `node_to_shard` / `file_to_node_ids` / `enrichment_edge_to_shard` mutations (`src/storage_v2/multi_shard.rs:342-346`, `384-387`, `1243`) so the refuted "future race" never materializes. *Rationale:* measured 2.19x vs 1.45x write parallelism; indexes are otherwise the one shared structure that would race.

3. **Make manifest writes incremental / dedup zone maps.** Today `create_manifest` re-serializes all prior descriptors every commit (`src/storage_v2/multi_shard.rs:1353-1356`) and zone maps are full `HashSet<String>` per descriptor (`src/storage_v2/manifest.rs:159-169`, ~70% of bytes). Intern zone-map strings or write only changed descriptors. *Rationale:* even with compaction, manifest residue scales with node count; this attacks the serial P8 term RFD-71 leaves untouched.

4. **Reclaim superseded segments at compaction time.** `segments/` bloats 10.2x (11 MB -> 113 MB) because compaction rewrites merged segments without dropping the originals within a run. *Rationale:* otherwise auto-compaction (step 1) trades a manifest problem for a disk problem at scale.

5. **Batch the two tombstone clone-broadcast cycles into one.** P4 and P5.5 each clone+rebroadcast the full `Arc<TombstoneSet>` (`src/storage_v2/multi_shard.rs:1212-1233`, `1273-1279`). Compute the final set once, broadcast once. *Rationale:* halves O(T) clone work per commit in delete-heavy workloads; lower priority since compaction already clears tombstones.

---

## 6. Evidence appendix

**Code (verified at HEAD `97f0678f`):**
- `src/database_manager.rs:125` — `engine: RwLock<Box<dyn GraphStore>>` (single engine-wide lock). *Verified by Read.*
- `src/bin/rfdb_server.rs:2391` — `let mut engine = db.engine.write().unwrap();` (all writes route here). *Verified by Read.*
- `src/storage_v2/manifest.rs:873-885` — `atomic_write_json(&manifest_path, &manifest, ...)` + index file + current pointer = 3 atomic JSON writes per commit. *Verified by Read.*
- `src/storage_v2/manifest.rs:893-904` — tombstone lists cleared post-commit; `gc_manifests(MANIFEST_GC_KEEP=3)` runs every 10 commits, bounds FILE COUNT only, not per-commit serialization size. *Verified by Read.*
- `src/storage_v2/manifest.rs:159-169` — `SegmentDescriptor` zone maps `node_types`/`file_paths`/`edge_types` as `HashSet<String>`, serialized in full unless empty.
- `src/storage_v2/multi_shard.rs:1076-1391` — `commit_batch_ext` 9-phase body, all `&mut self` under the lock; no `should_compact()` call in path.
- `src/storage_v2/multi_shard.rs:1308` — Phase-7 flush is `for shard_idx in 0..shard_count` (serial, not par_iter).
- `src/storage_v2/multi_shard.rs:1212-1233`, `1273-1279` — P4 and P5.5 clone + rebroadcast `Arc<TombstoneSet>` (two clone cycles per commit).
- `src/storage_v2/multi_shard.rs:1353-1356` — manifest creation clones current segment lists and extends (all prior descriptors re-serialized).
- `src/storage_v2/multi_shard.rs:456-467` — `is_node_tombstoned`/`is_edge_tombstoned` read `shards[0]` as the global source.
- `src/storage_v2/multi_shard.rs:1468` + `src/storage_v2/resource.rs:110` — `should_compact()` and `segment_threshold` (2/4/8 by RAM) exist but are only consulted inside explicit `compact()`.
- `src/storage_v2/multi_shard.rs:1648-1660` — explicit `compact()` rebuilds `global_index` O(N) and filters compacted shards' segments out of the manifest.
- `src/storage_v2/multi_shard.rs:342-346`, `384-387`, `1243` — global-index mutations, all under the exclusive lock (refutes the "data race" claim).
- `src/storage_v2/multi_shard.rs:954-1021`, `src/storage_v2/shard.rs:528-551` — `find_edge_keys_by_src_ids` is shard-targeted + bloom-pruned (refutes the "250K all-shard scan" claim).

**Measured (probes, do-not-rerun):**
- Lock contention @ 4 threads: engine-wide **1.45x** speedup (~1 core ceiling), per-shard **2.19x** — `bench_lock_contention`.
- Manifest, no compaction: cur-manifest **44,618 B @100 -> 447,315 B @1000 commits** (~446 B/commit, linear); commit latency **77.99 ms -> 535.08 ms**; segments **200 -> 2000** — `bench_manifest_growth`.
- Manifest, compact-every-50 @ commit 1000: cur-manifest **61,598 B** (7.3x smaller), manifests/ dir **164,006 B** (10.9x smaller), commit **244.14 ms** (2.2x faster), segments/ dir **112,816,166 B** (10.2x larger), compaction time **116 ms -> 490 ms** over the run — `bench_manifest_growth`.
- Per-commit floor under compaction stays flat **53.35-75.41 ms** across 8k->80k nodes; spikes only on compaction-boundary commits (205.88, 244.14 ms) — `bench_manifest_growth`.
