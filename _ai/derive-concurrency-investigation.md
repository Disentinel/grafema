# Derive-phase concurrency: root-cause investigation + parallel-derive plan

**Branch:** `investigate/derive-concurrency` (off `feat/enrich-profiling`).
**Date:** 2026-06-19. **Method:** static read of the live code on `grafema-dev` + reconciliation
with the prior empirical evidence (rayon=1 / `RFDB_DISABLE_COMPACTION=1` isolation tests + the
2026-06-19 TSan run). **No fresh sanitizer reproduction was run** (see §5 for why and what that costs).

This report **refines and partially refutes** the leading hypothesis carried in the prior memory note.
Be explicit about what changed: the *empirical* facts (parallel crashes, single-thread doesn't;
disabling compaction stops it) are unchallenged. What changes is the **mechanism**: the named
"use-after-unmap of a memmap2 `Mmap` slice whose `Arc<Segment>` was reclaimed by GC under a rayon
reader" is **not** the mechanism on the disk-backed self-analyze path. The type system and the file
layout forbid it. The corruption is at the **global-allocator** layer, exercised by the *combination*
of two heavy concurrent rayon allocation bursts (derive `par_join_rows` + compaction merge), not by a
logical UAF in the engine's Rust.

---

## 1. What the code actually does (the lifecycle, verified)

### 1.1 Packs are fully serialized — there is NO cross-pack overlap
- Orchestrator (`packages/grafema-orchestrator/src/main.rs:736`) issues **39 separate
  `materialize_datalog(pack)` RPC calls**, one per pack, sequentially (`for pack in STDLIB_RULE_PACKS`).
- Each `MaterializeDatalog` request runs under **`with_engine_write`** — the *exclusive* `RwLock` write
  guard on `db.engine` (`bin/rfdb_server.rs:1763-1774`). The handler comment even says so
  ("@materialize ends in commit_batch_ext (&mut self), so it takes the exclusive write lock").
- ⇒ Pack N's eval + writeback + compaction completes and the write lock is **released** before pack
  N+1 acquires it. **No two packs overlap.** The memory note's "the materialize handler holds
  `db.engine.read()` but internally commits across 39 packs" model is **wrong** — it's 39 independent
  *write*-locked calls, not one read-locked loop. This matters for the fix (§3) and the plan (§4).

### 1.2 Within ONE pack, eval and compaction do NOT temporally overlap
`eval_derive_materialize_cached` (`graph/engine_v2.rs:955`) is strictly ordered:
1. `let snapshot = self.snapshot();` — pins manifest version V (MVCC B5 `VersionPins::pin`).
2. `derive_for_materialize(...)` — **the eval**, the only place `par_join_rows` runs. It is
   **read-only** over the snapshot (`grep`-confirmed: no `flush`/`commit`/`compact` inside the eval).
   It reads via `BorrowedLsmStorageView::new(&self.store, snapshot)` — i.e. `&self.store`.
3. `materialize_writeback_delta(...)` → `self.flush()` (`engine_v2.rs:1354`) →
   `commit_batch_ext` (`&mut self`) → which auto-triggers `should_compact` →
   `compact_with_threads(&mut self, …)`.

The engine holds **`store: MultiShardStore` BY VALUE, not behind a lock** (`engine_v2.rs:203`). So
step 2 borrows `&self.store` and step 3 borrows `&mut self.store`. **The Rust borrow checker has
already proven these cannot alias** — every read in the eval is dropped before the `&mut` writeback
begins. There is no safe-code path where a live derive read aliases a concurrent compaction of the
same store. (And no `UnsafeCell` / `unsafe impl Sync` / `static mut` / `transmute` / `get_unchecked`
escape hatch exists in `multi_shard.rs`, `shard.rs`, or `derive/exec.rs` — confirmed by grep; the only
`unsafe` in the crate is the two `Mmap::map` calls.)

### 1.3 The snapshot read path is mmap-UAF-safe (immortal Arc cache)
- Disk-backed reads resolve through `with_node_segment` / `with_edge_segment`
  (`multi_shard.rs:808-845`), which — when `db_path.is_some()` (the real analyze case) — go through
  **`SegmentCache::get_node_segment`** (`read_snapshot.rs:59`). The cache is
  `RwLock<HashMap<id, Arc<Segment>>>` and **never evicts** ("B5 will add eviction" — *not implemented*).
- The reader receives a **cloned `Arc<Segment>`** and calls `f(&seg)` synchronously; the `Arc` keeps the
  mmap alive for the closure's whole lifetime. Records are copied out owned (`get_record(j)` →
  `NodeRecordV2`; `NodeRow` is all-`String`, no borrow into mmap).
- **The Shard-owned by-value segments** (`shard.rs:216` `node_segments: Vec<NodeSegmentV2>`,
  `:235` `l1_node_segment: Option<NodeSegmentV2>`) are a *separate* set of mmaps. Compaction's
  `set_l1_segments` (`shard.rs:723-738`) drops one of those by value → `munmap`. But (a) the
  disk-backed read path doesn't read them (it reads the cache `Arc`s), and (b) the borrow checker
  already serialized this against the read anyway. Dropping the Shard-owned copy cannot invalidate the
  cache's independently-opened copy of the same immutable file.

### 1.4 Segment files are append-only — no in-place rewrite to corrupt a live mmap
Every compaction output is written to a **fresh `seg_{next_segment_id():06}_…seg` path** via
`fs::write` / `File::create` (`multi_shard.rs:3502/3549/3597/3622/2812/2852`). **No `set_len`,
`truncate`, `OpenOptions().write(true)`, `madvise`, or path-reuse** exists on the segment write path
(grep-confirmed). `prefetch_file` is read-only `posix_fadvise(WILLNEED)`. GC moves reclaimed files to
`gc/` then `remove_file`s them (`manifest.rs:1822/1948`), gated by `version_pins.min_pinned()` so a
pinned reader's file is never reclaimed — and on Linux `remove_file` of an mmap'd inode does **not**
invalidate the mapping regardless. ⇒ **No mechanism exists to corrupt a live mmap mapping.**

### 1.5 Compaction's own rayn region is internally clean
`compact_with_threads` (`multi_shard.rs:3338`) splits into Phase 2 (parallel: `par_iter` over shards,
each only **reads** `&self.shards[idx]`, returns owned bytes) and Phase 3 (sequential: `next_segment_id`
[atomic], `fs::write`, `set_l1_segments`). When `threads>1` it builds its **own private `ThreadPool`**
(not the global pool) and `pool.install`s the `par_iter`. No shared mutable state under its `par_iter`.

### 1.6 Every `par_join_rows` closure is borrow-check-`Sync`-safe
`par_join_rows` (`derive/exec.rs:317`) requires `F: Sync` and the doc-comment explicitly forbids
capturing `&self` (the executor owns `RefCell`s and is `!Sync`); callers build any index *before* the
parallel call and capture only the index + a `Sync` view. The crashing path
(`join_attr_bound_id_built_once`, `exec.rs:2481`) reads an **owned** `Arc<HashMap<u128, NodeRow>>`
(`:2519-2520`) — fully owned, cloned per chunk via `Arc`. The `join_derived` anti-join/positive paths
(`:1763`) build `HashSet<&[Value]>` / `HashMap<_, Vec<&DerivedFact>>` that **borrow `&rel.total`** and
capture that `&` into the parallel closure — borrow-checked safe because `relations: &HashMap` is
immutable across the parallel region. **No `RefCell` leaks into a parallel closure.**

---

## 2. Root cause — confirmed conclusion (with honest confidence)

**The crash is heap corruption in the GLOBAL ALLOCATOR, triggered by concurrent rayon allocation
churn — NOT a logical use-after-free / use-after-unmap in the engine's Rust.**

Evidence chain:
- **Empirical (prior, strong):** `RAYON_NUM_THREADS=1` ⇒ all 39 packs exit 0;
  parallel ⇒ non-deterministic `EXC_BAD_ACCESS` at a wild address (not stack overflow) in a
  `par_join_rows` closure. `RFDB_DISABLE_COMPACTION=1` ⇒ no crash. The 2026-06-19 TSan run did not
  produce a clean two-stack race report — **TSan itself SIGSEGV'd on corrupt allocator metadata while
  cloning a `BindRow` (`BTreeMap<String,Value>`)**. A corrupt-allocator-metadata crash inside `malloc`
  is the signature of *global heap corruption*, not a clean Rust aliasing race.
- **Static (this investigation, strong):** every candidate logical UAF is refuted —
  (1) reader/compactor store aliasing is **borrow-checker-impossible** (store is by-value, not locked;
  eval `&self.store` strictly precedes writeback `&mut self.store`); (2) the segment cache is
  **immortal** and the reader holds an `Arc`; (3) segment files are **append-only**, never rewritten in
  place; (4) GC file reclaim is version-pinned and mmap-survivable; (5) all parallel closures are
  borrow-checked `Sync` with **no `RefCell`/raw-pointer/`unsafe-Sync` leak**.
- **Reconciliation:** the only thing `RFDB_DISABLE_COMPACTION=1` removes is the **second heavy
  concurrent rayon allocation burst** (the compaction merge, `merge_node_segments` building large
  `Vec`s under `rayon::join`). With it gone, the *only* remaining MT allocation pressure is
  `par_join_rows`. Both isolation results (rayon=1; disable-compaction) are explained by the same
  cause: **remove concurrency, or remove the second allocator-churning rayon region, and the corruption
  stops.** The victim (`par_join_rows` row-clone) and the named corruptor (compaction) are both heavy
  allocators on the same global allocator; the corruption is between *whatever two allocator
  operations* race.

**What this means for the writer's identity:** I could NOT pin the exact two racing `file:line`s,
because there is no logical race in the safe Rust to pin — the corruption is sub-Rust (allocator).
The most probable concrete cause, in order of likelihood:
1. **A global-allocator / rayon interaction bug** — e.g. nested/global rayon pools + the system
   allocator under extreme concurrent alloc/free of small `BTreeMap`/`String` nodes. This is consistent
   with *every* observation and with TSan dying inside `malloc`.
2. **A latent bug in a transitive `unsafe` dependency** exercised only under this MT alloc pattern
   (memmap2 is the only memory-critical local `unsafe`, and §1.4 rules it out as a *logical* cause, but
   a dependency's allocator-adjacent `unsafe` cannot be excluded by reading our crate alone).
3. (Least likely, not yet excluded) a miscompilation.

**Confidence:** HIGH that it is global-heap corruption and NOT the named segment-UAF.
MEDIUM on the precise allocator-level writer (1 vs 2) — that requires the repro in §5 to settle.

---

## 3. The fix

### 3.1 Current state is a WORKAROUND that is ALSO a legitimate phase-ordering fix
The shipped `AutoCompactionSuppressGuard` (`storage_v2/compaction/coordinator.rs:43`, installed at
`bin/rfdb_server.rs:3071`) suppresses auto-compaction during the materialize call; deferred compaction
runs later at a barrier under the exclusive write lock. The memory note frames this as "removes the
concurrent compactor, doesn't fix the segment race." Given §1-2, that framing is **too pessimistic**:
there is no segment race to fix. What the guard actually does is **prevent two heavy rayon allocation
bursts from interleaving within one process** — which, whatever the exact allocator bug is, is a real
and correct mitigation. It is NOT masking a logical UAF (there is none).

**However**, it is a *mitigation of a symptom*, not a fix of the underlying allocator-level fault, and
it is **fragile**: it only works because today nothing *else* runs a concurrent allocator-heavy rayon
region during a materialize. The moment inter-pack parallelism (§4) runs two evals concurrently, the
guard does nothing — two `par_join_rows` bursts will race the same way. So the guard is necessary-today
but insufficient-for-the-plan.

### 3.2 The real root-cause fix (recommended): swap the global allocator to a hardened one
Because the fault is global-heap corruption under concurrent rayon allocation — not a logical bug we
can pin to a line — the correct root-cause fix is at the **allocator** layer, where the corruption
lives:

- **Adopt a high-concurrency allocator as the global allocator for `rfdb-server`** — `mimalloc` or
  `jemalloc` via `#[global_allocator]`. Both are explicitly hardened for many-thread alloc/free of
  small objects (exactly the `BTreeMap<String,Value>`/`String` churn here) and are the standard remedy
  for "the system allocator corrupts under heavy rayon." This is low-LOC (one `static GLOBAL: …`),
  reversible, and—critically—**if it makes parallel-derive run clean with compaction NOT suppressed,
  that is itself strong evidence the system allocator was the culprit (hypothesis §2.1).**
- This is the experiment that *both* root-causes AND fixes: run parallel derive, compaction enabled,
  with mimalloc → if green and repeatable, root cause = system-allocator concurrency fault; ship the
  allocator + keep the suppress-guard only as defense-in-depth (or drop it).

**Risk:** LOW. `#[global_allocator]` is a single, well-trodden change; mimalloc/jemalloc are mature.
The only real risk is a slightly different memory profile (watch the 11 GB OOM ceiling on heavy runs).
**This is the only "fix" I'd propose, and only after the §5 verification — see §6 for status.**

### 3.3 Fallbacks if the allocator swap does NOT fix it
Then the writer is hypothesis §2.2/§2.3 (a dependency `unsafe` or miscompile), and the responsible
posture is: **keep the suppress-guard, do NOT enable inter-pack parallelism**, and escalate to a full
ASan build (`-Zsanitizer=address`, which reports the *write*, unlike TSan which died) on the isolated
crashing pack. Do not ship a "fix" you can't explain.

I deliberately did **not** draft a code fix on the branch, because the honest verification bar
("parallel derive, compaction NOT suppressed, exit 0, repeatedly") was not met in this session (§5).
A wrong fix to a heap-corruption fault is worse than an accurate diagnosis + plan.

---

## 4. Inter-pack (vertical) parallelism design

### 4.1 The DAG and the headroom
Packs form a DAG: independent **language verticals** (js / rust / haskell / java / go — each an internal
`nodes→edges` chain) feed shared **sinks** (`depends` ← all `IMPORTS_FROM`; `method_calls` /
`shape_verifier` ← all `CALLS`). Profiled critical path: js 85s, rust 34s, haskell 17s, sinks 16s →
**critical path ≈ 101s** if verticals run concurrently then barrier→sinks, vs **158s** sequential =
**~57s headroom**.

### 4.2 What it requires (two independent enablers)
1. **Client side — multiple `RfdbClient` connections.** The orchestrator holds ONE `UnixStream`
   (`run_stdlib_rule_packs(rfdb: &mut RfdbClient)`). Vertical concurrency needs N connections (one per
   vertical) issuing `materialize_datalog` in parallel, then a barrier, then the sinks on one
   connection. Mechanically straightforward (spawn N client tasks over N sockets).
2. **Server side — concurrent `materialize_datalog` evals.** Today materialize forces
   `with_engine_write` (exclusive). Two concurrent evals therefore **serialize on the write lock** — no
   parallelism. To get vertical concurrency the server must let disjoint-edge-type evals run under a
   **shared** lock with a concurrency-safe commit. The machinery already exists:
   `supports_concurrent_commit()` + `handle_commit_batch_v2_concurrent` (MVCC B4 group-commit:
   `engine.read()` shared lock, each writer builds a **private segment file** then a leader publishes —
   `multi_shard.rs:2576`, `bin/rfdb_server.rs:1980`). Materialize would need to route through that B4
   concurrent path instead of `with_engine_write`.

### 4.3 Is concurrent disjoint-edge-type eval safe once allocation is fixed? — Assessment
- **Reads:** all evals read the same pinned snapshot (immutable, `Arc`-shared descriptors + immortal
  segment cache). Concurrent reads are already `Sync`-safe. ✅
- **Writes:** the B4 private-segment + leader-publish path is designed for exactly this (concurrent
  writers, disjoint or not, serialized only at the publish point). Two verticals writing different edge
  types (`EXTENDS` vs `CALLS`) are trivially disjoint at the record level. ✅ *for the storage layer.*
- **The blocker is exactly the allocator fault of §2.** Two concurrent `par_join_rows` bursts is
  *strictly more* concurrent allocation pressure than today's single-eval-plus-compaction. So:
  **inter-pack parallelism MUST NOT be enabled until §3.2 is verified.** The suppress-guard does
  nothing for it (it only stops *compaction* interleaving; it can't stop two evals interleaving).
- **Additional locking needed beyond B4:** the per-engine derive caches
  (`derive_materialize_cache`, the `RefCell` index caches, the durable-pin sidecar writes) are NOT
  built for concurrent `&mut self` materialize. Concurrent materialize would need either
  (a) per-connection executor state with a single serialized publish, or (b) a `Mutex` around the
  cache/sidecar mutation. This is real design work, scoped on top of the allocator fix.

### 4.4 Recommended staging
1. Fix + verify the allocator (§3.2) under the *existing* serial design first. (De-risks everything.)
2. Add multi-connection client fan-out (verticals concurrent, barrier, sinks). Cheap, isolated.
3. Route materialize through the B4 concurrent-commit path; add the cache/sidecar serialization (§4.3).
4. Re-verify parallel verticals → barrier → sinks, compaction enabled, equivalent graph, repeatedly.
Expected win after all four: **158s → ~101s critical path (~36% derive-phase reduction, ~57s).**

---

## 5. What I verified vs. what remains unproven

**Verified (static, this session):**
- Packs are 39 serialized write-locked calls; no cross-pack overlap (§1.1).
- Eval (`&self.store`) strictly precedes writeback/compaction (`&mut self.store`); store is by-value,
  not lock-wrapped; borrow checker forbids the aliasing the named hypothesis requires (§1.2).
- Snapshot read path uses an **immortal `Arc` segment cache**; readers hold the `Arc`; records are
  owned (§1.3).
- Segment files are **append-only**, never rewritten in place; GC is version-pinned + mmap-survivable
  (§1.4).
- Compaction's parallel phase is internally clean; all `par_join_rows` closures are borrow-checked
  `Sync` with no `RefCell`/raw-pointer leak (§1.5-1.6).
- ⇒ The named "segment-Arc-UAF under GC/compaction" mechanism is **REFUTED** on the disk-backed path.

**Unproven (NOT verified this session — be honest):**
- I did **NOT** run a fresh ASan/TSan reproduction. A full self-analyze-under-TSan is multi-hour and
  RAM-heavy (prior run OOM-killed at ~11 GB; another prior run got SIGTERM'd before reaching the derive
  packs); `grafema-dev` currently hosts other live Claude workers + MCP servers, and starting a
  heavy/RAM-hungry build risks OOM-killing co-tenants. I judged the cost/risk not worth it given the
  static evidence already settles the *named* hypothesis. **This means the precise allocator-level
  writer (system-allocator bug vs dependency `unsafe` vs miscompile, §2.1-2.3) is NOT pinned.**
- I did **NOT** draft or verify a code fix. The allocator-swap (§3.2) is the recommended next action
  but is **proposed, not verified** — the bar ("parallel derive, compaction NOT suppressed, exit 0,
  repeatedly, equivalent graph") was not met here.

**The single decisive next experiment** (cheap, settles both root cause and fix):
build `rfdb-server` with `#[global_allocator]` = mimalloc, run parallel-derive with the suppress-guard
**removed** and `RAYON_NUM_THREADS=16` on `grafema-dev` (one analyze at a time), 3× repeat. Green +
equivalent graph ⇒ root cause confirmed = system-allocator concurrency fault, and the allocator swap IS
the fix. Crash persists ⇒ escalate to ASan on the isolated `js_entrypoint_features_edges` pack.

---

## 6. Status / deliverable
- Report written, committed, pushed on `investigate/derive-concurrency`. **No PR to main; nothing
  merged.** No code fix drafted (verification bar not met — §3.3, §5).
- Recommendation to the reviewer: schedule the §5 mimalloc experiment as the next step; if green, that
  PR (allocator + retire/keep-as-defense the suppress-guard) is the real fix and unblocks the §4 plan.
