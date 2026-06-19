# Self-analyze performance: measured sinks + plan (perf/self-analyze)

Profiled `grafema analyze` on grafema's OWN monorepo, on grafema-dev
(16 vCPU / 30 GB), `RFDB_MATERIALIZE_DEADLINE_SECS=3600
RFDB_MAX_MATERIALIZED_FACTS=200000000`. Graph: **513,005 nodes / 1,107,496 edges**.

## Measured phase breakdown (baseline, before this branch's fix)

| Phase | Wall time | Notes |
|-------|-----------|-------|
| **Analysis** | **241.5 s** | 660 commit batches; dominated by 25 BEAM `.ex` files |
| JS resolve | 11.3 s | 309 JS/TS files, per-file streaming (1 worker) |
| Haskell resolve | 23.9 s | |
| Rust resolve | 53.1 s | streams all ~200k Rust nodes to 1 worker |
| **Derive** | **180 s** | 40 stdlib rule packs |
| Compact | <1 s | |
| TS enrichers/plugins | large tail | `type-inference` + `shape-tracker` (NOT in this lane) |

Per-commit `commit_batch` server time stayed ~350–500 ms with only mild growth
(451 ms → 1332 ms avg across 33 profiled batches) — **no O(N²) `commit_batch`
blow-up** observed at this scale (RFD-51's old symptom is not reproducing here).

`clear_durable()` is already **O(1)** — swap to ephemeral placeholders, `rm`
the manifest authority + data trees, recreate the empty skeleton (W8 Part 2).
It is **not** O(graph); the "slow clear" hypothesis did not hold.
`queryNodesByFile` prunes via an **exact** per-segment `file_paths` zone-map
(`SegmentDescriptor::may_contain`), so per-file resolve is **not** a full scan.

## TOP SINK (analysis phase): BEAM daemon latin1 timeout — FIXED here

Per-extension file-analyze time (sum of per-file `total_ms`):

| ext | files | total | avg/file |
|-----|-------|-------|----------|
| **ex** | **25** | **3003 s** | **~120 s** |
| ts | 309 | 21.2 s | 69 ms |
| hs | 210 | 18.1 s | 86 ms |
| rs | 116 | 16.5 s | 142 ms |

`beam-analyzer` is an Erlang **escript**. When the host locale is not UTF-8 the
Erlang VM falls back to **`latin1` native name encoding**, which mangles the
length-prefixed binary stdin protocol the orchestrator `ProcessPool` speaks.
The `--daemon` never replies, so **every** per-file request burns the full
`DEFAULT_REQUEST_TIMEOUT` (**120 s**) before the pool abandons it — exactly the
~120 s/file measured, and the "Pool request failed" errors in the log.

The same `.ex` file analyzed in single-shot (non-daemon) mode runs in **309 ms**,
confirming the cost is the daemon-encoding hang, not BEAM parsing.

### What this branch lands

1. **`PoolConfig.extra_env`** pinned on the BEAM analyzer and resolve pools,
   setting `ELIXIR_ERL_OPTIONS=+fnu` (force UTF-8) + `LANG`/`LC_ALL=C.UTF-8`.
   This removes the `latin1` mis-encoding (verified: 0 latin1 warnings after).
   NOTE — on grafema-dev the daemon STILL fails to reply even with UTF-8 (it
   raises `{:error, :enxio}`, a deeper escript-daemon problem independent of
   locale), so on THIS host the encoding fix alone does not recover the time.
   It is still correct and portable: on a host where the daemon's only problem
   is the locale, it fully fixes the 120 s/file timeout.

2. **Pool circuit breaker** (`TIMEOUT_CIRCUIT_BREAKER_THRESHOLD`, tested):
   after N consecutive request timeouts with no success, a pool fails every
   further `request()` IMMEDIATELY instead of paying `request_timeout` again. A
   single success resets it. This bounds a dead daemon to `N × request_timeout`
   on any **serial** daemon request stream — i.e. the resolve daemons (JS
   per-file `resolve-file`, the single-worker Haskell/Rust/Java/BEAM resolve
   pools — exactly the REG-1128 N+1 hot path). Zero-risk: a merely-slow daemon
   never trips it.

   LIMITATION (measured): the breaker does NOT help the **parallel analysis
   fan-out**. `analyze_*_files_parallel_pooled` dispatches all files
   concurrently, so every request passes the breaker check at t≈0 (counter
   still 0) and they all time out together at t=120 s — the counter climbs
   1→2→…→N but no request arrives AFTER the trip point. Confirmed on the BEAM
   analysis fan-out: counter reached 17, 0 circuit-open events, analysis still
   241 s.

### Precise plan for the parallel analysis fan-out (deferred, larger change)

Add a **sequential liveness probe** at the top of each
`analyze_<lang>_files_parallel_pooled` (there are ~3 structurally-identical
fan-out blocks — BEAM, and the Java/Kotlin/Go/Swift/ObjC parser+analyzer pools):
analyze `files[0]` synchronously BEFORE fanning out the rest. A healthy daemon
answers in <1 s and the normal parallel path proceeds (re-using the probe's
result for file 0). A dead daemon fails the probe in ONE `request_timeout` and
the remaining files are returned failed-fast — bounding a dead daemon to a
single 120 s timeout instead of `ceil(N / jobs)` waves of it (25 `.ex` files:
241 s → ~120 s, and with a shorter probe timeout, → seconds). RISK: the
fan-out blocks are shared across languages; the probe must be added carefully
(unique per-call-site context) and must re-use `files[0]`'s result so file 0
is not double-analyzed. Each call site needs its own before/after timing check.
Effort: medium; reward: removes the analysis phase's single largest sink.

## Derive phase (180 s / 40 packs) — DOCUMENTED PLAN, not landed here

Top packs (no single dominant one — the cost is spread):

| ms | edges | pack |
|----|-------|------|
| 22.2 s | 2374 | `@stdlib/rust_calls` |
| 19.3 s | 187 | `@stdlib/js_local_refs` (stratified scope-walk) |
| 12.5 s | 75759 | `@stdlib/haskell_local_refs` |
| 10.1 s | 1213 | `@stdlib/js_same_file_calls` |
| 8.3 s | 7820 | `@stdlib/js_runtime_globals_edges` |
| 7.0 s | 5764 | `@stdlib/method_calls` |

Why it is expensive: each pack runs a full Datalog `@materialize` over the live
500k-node snapshot. Index reuse across packs is already implemented
(`SharedIndexCaches` + `retain_for_commit` for additive commits), and joins are
already rayon-parallel (`par_join_rows`). The remaining cost is genuine join
work (scope-walk transitive `inner_of`/`ref_scope` closures, ::-qualified call
arms). Notably the per-pack flush bumps the manifest version, which **misses**
`derive_stats_cache` (version-keyed) and forces `count_nodes_by_type_at` to
re-scan once per pack.

Candidate wins (ranked; all carry derive-engine SIGSEGV-regression risk —
the 40-pack derive must still complete with 0 SIGSEGV, and auto-compaction must
stay suppressed during materialize per the 2026-06-19 use-after-unmap fix):

1. **Run independent packs concurrently.** The 40 packs have a partial order
   (producers before `depends`), but many are independent (e.g. the rust_* and
   haskell_* and js_* families don't read each other's slices). A topological
   batching that materializes independent packs in parallel could cut the 180 s
   substantially. RISK: each `@materialize` commits via `flush()` (a manifest
   flip under `&mut self`); concurrent materialize needs the `&self`
   private-buffer commit path + conflict retry, and must not overlap
   auto-compaction. Medium-high effort, high reward.

2. **Hoist `derive_stats` across the pack run.** Per-type node counts only
   change when a pack adds NODES (few packs do — most add edges only). For the
   edge-only majority, the per-version stats recompute is redundant work; a
   stats delta keyed on "did this commit add nodes" avoids the re-scan. Low
   risk, modest reward.

3. **`js_local_refs` scope-walk:** bound the `inner_of` transitive closure by
   chain depth / pre-index DECLARES-by-name so the negation stratum starts from
   a smaller candidate set. High risk (correctness of shadowing resolution),
   pack-specific reward (~19 s).

The BEAM fix is landed and measured; the derive plan is deferred because each
option touches the derive engine's commit/compaction invariants and needs its
own SIGSEGV-safe verification pass.
