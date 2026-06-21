# Parallelism & self-analyze — open tasks (handoff)

_As of 2026-06-21. Context: making `grafema analyze` complete + fast on grafema's own
monorepo, and parallelizing the pipeline. The resolve-phase parallelization is LANDED on
this branch; the rest is sequenced below._

Profiled full self-analyze (16 vCPU, ~705k nodes): analysis 39s (already ∥) → resolve 102s
→ diagnostics 12s → derive 158s → enrich 98s → compact 1s ≈ 415s. "What could run in
parallel" = `total_work − critical_path` (now a graph query, see profile-subgraph below).

## DONE on this branch
- **Resolve phase parallelized** (commit `7577055b`). 12 language resolvers → one `tokio::join!`,
  each its own `RfdbClient` connection + `ProcessPool`, deterministic-order merge of `IMPORTS_FROM`
  with first-error `?` propagation. Re-derived onto v0.4.1 (couldn't cherry-pick #478 — `PoolConfig`
  diverged). Verified graph-equivalent on a js+rust+haskell fixture (byte-identical node/edge/CALLS/
  IMPORTS_FROM/READS_FROM/DEPENDS_ON; interleaving confirmed real concurrency). cargo test 448 ✓.
  **Win: resolve_ms 102s → ~60s (−42%) — but only materializes at full-monorepo scale once the
  hardening below also lands here (see #1).**

## OPEN — in dependency order
1. **Bring the self-analyze hardening to feat/datalog.** Without it the un-hardened engine cannot
   analyze the full monorepo at all (engine walls: query-default cap 100k leaking into batch
   materialize; parallel-derive SIGSEGV; 60s RPC client timeouts; planner MAX_MATERIALIZED_FACTS on a
   q-error). Branches on origin (held, NOT in feat/datalog): `feat/self-analyze-hardening` (PR #475),
   `feat/pipeline-profile-graph` (PR #476), `feat/enrich-profiling` (PR #477). The resolve win and
   everything below depend on the engine being able to run at scale.

2. **Derive concurrency root-cause — the ~57s win is BLOCKED here.** Derive packs run as a flat
   sequential loop; independent language verticals (js 85s / rust 34s / haskell 17s) → shared sinks
   (`depends` ← all IMPORTS_FROM; `method_calls`/`shape_verifier` ← all CALLS, 16s) could run
   concurrently (critical path ~101s vs 158s). BLOCKED by a heap-corruption race that needs
   `RAYON>1` AND compaction to manifest. Investigation (branch `investigate/derive-concurrency`,
   `_ai/derive-concurrency-investigation.md`): the "segment-UAF under GC" theory is REFUTED; an
   allocator-swap "fix" was REJECTED as masking (a thread-safe allocator doesn't corrupt without
   underlying UB — same anti-pattern as the reverted REG-1190 костыль). **Real root-cause needs an
   ASan repro in rfdb-server to pin the actual bad write** — deliberately PAUSED because rfdb-server
   is the core of this (feat/datalog) rewrite; do it as part of the engine rewrite, not a side patch.

3. **Inter-pack (vertical) derive parallelism (~57s).** On top of #2: run verticals concurrently →
   barrier → sinks. Needs N `RfdbClient` connections (orchestrator holds one) routed through the B4
   concurrent-commit path (`supports_concurrent_commit` + private-segment + leader-publish) instead of
   the exclusive write lock, plus serializing the per-engine derive caches. Gated on #2's fix.

4. **TS enrichers producer∥→consumer∥ (minor).** In `packages/cli/src/commands/analyzeAction.ts` the
   6 enrichers run sequentially; producers {library-callbacks, mcp-tool-defs, package-api} are
   independent → ∥, consumers {contract, speced-contract, behavior} → ∥ after a barrier. Small on
   grafema, larger on feature-heavy repos. Also surfaces a pre-existing slow/hanging `mcp-tool-defs`
   enricher (queryNodesStream that no longer fails fast).

## Observability that makes the above measurable (in #476/#477, not yet here)
- **Profile subgraph**: `profile:run → phase → stage` with per-derive-pack/resolver/enricher `wall_ms`,
  `PRECEDES` (the route) + `REQUIRES` (true data deps) edges, reusing METRIC/OBSERVES. Critical path =
  longest PRECEDES chain; dead stages = `wall≥1s ∧ edges=0`; **parallelism headroom =
  total_work − critical_path** as a graph query (per-phase + run-level METRICs).
- **Enrich phase profiled**: type-inference/shape-tracker de-conflated from resolve_ms into enrich_ms;
  TS enrichers append `enrich_step_complete` to the JSONL.

_Engine-zone reminder: resolve / rfdb* / datalog-resolution-logic = this feat/datalog rewrite. The
items above were produced as held, reviewable branches; #2 (rfdb-server) is paused for the rewrite._
