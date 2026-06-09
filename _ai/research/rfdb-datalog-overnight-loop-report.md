# Datalog v2 — overnight autonomous loop report (2026-06-09)

Branch `feat/datalog`. All work committed + pushed, each a green revertable unit. This is
the decision-ready handoff: what landed, what's proven, and the supervised decisions waiting
for you. Running ledger stays in `rfdb-datalog-RESUME.md`; this is the morning-scannable digest.

## What landed this loop (newest first)

| Commit | Unit | Evidence |
|---|---|---|
| `e00268c1` | roadmap: sim() primitive logged | doc |
| `0c2e9c3b` | **sim() engine primitive** — hypothetical-edit query = read-only `maintain_incremental` over a hypothetical `BaseDelta` | `sim_hypothetical_edit_predicts_derived_facts_without_mutating_base`; datalog2::exec 21/21 |
| `e039371a` | apparatus iter6 — deployment-binding resolution closes frontend→backend chain | datalog2 smoke green |
| `427fbe63` | apparatus §8 — 5 prior-art citations web-verified | doc |
| `b0368872` | apparatus iter5 — express library-semantics as a Datalog rule | smoke green |
| `7fd8e080` | apparatus iter4 — value-domain via derived congruence (points-to) | smoke green |
| `c2071947` | coverage-as-negation on the REAL corpus — CALL resolution probe | 13634 CALL sites, 16.2% direct-resolved (honest Layout-A lower bound) |
| `6e316f49` | gaps: DERIVED_FROM vs DERIVES_FROM edge-vocab fork | 17385 dark edges |

## ⚠️ STALENESS CAVEAT (added 2026-06-09 after verification)

**The dogfood graph `.grafema/grafema.rfdb` is ~3 months stale: snapshot dated Mar 4 2026, HEAD is
Jun 9 2026.** Since then `packages/core` was renamed to `packages/util` and the dead JS-analysis
pipeline was removed (commit `e063fc4e`). So EVERY "real-code" number below is **as-of-Mar-4**, not
current HEAD — the v2 ENGINE behavior they exercise is valid, but the specific paths/counts are stale.
For current numbers, re-run `analyze` to refresh the graph (not done autonomously: a full pipeline run
is heavy + the data-plane was flaky this session). Lesson recorded:
[[feedback_verify_graph_freshness_before_real_code_claims]].

**How to refresh (feasibility checked 2026-06-09):** `.grafema/grafema.rfdb` is gitignored (safe to
overwrite), and the toolchain is present — `packages/rfdb-server/target/release/rfdb-server`,
`packages/grafema-orchestrator/target/release/grafema-orchestrator`, analyzer binaries in
`~/.grafema/bin/`. Refresh = run the CLI `analyze` with `--auto-start` (it launches RFDB itself) from
the repo root. **TWO HAZARDS before trusting the result:** (1) the `~/.grafema/bin/` analyzer binaries
may be STALE vs current analyzer source — rebuild via `scripts/build-native.sh` (or `cabal install` +
copy, per `grafema-haskell-binary-stale-priority`) first, else the "fresh" graph reflects old analyzer
logic; (2) this session's RFDB data-plane returned ping timeouts twice — confirm the server is healthy
(`get_stats` nodeCount > 0) before relying on queries. NOT done autonomously precisely because a
mis-run would replace a known-stale graph with a fresh-but-wrong one.

## Real-code findings (the loop ran v2 queries on the actual — but STALE — dogfood graph)

1. **A real source-level import cycle** (NOT a runtime circular dependency) — surfaced by a bounded
   mutual-import query (`mutual(A,B) :- depends(A,B), depends(B,A), lt(A,B)`) on the Mar-4 graph (622
   depends pairs → exactly 1 mutual pair, 35.8s). The graph reported the OLD `core` paths; **verified
   against current HEAD** the pair is real but renamed:
   > `packages/util/src/errors/GrafemaError.ts` ⇄ `packages/util/src/diagnostics/DiagnosticCollector.ts`
   **Nuance (verified by reading the source):** `GrafemaError.ts:17` imports `Diagnostic` as
   `import type` (erased at compile time → no runtime edge); only `DiagnosticCollector.ts:20` imports
   `GrafemaError` as a runtime value. So it is a source-level **type↔value** cycle TypeScript handles
   fine — a mild smell, not a runtime circular dependency. The v2 query correctly found the mutual
   IMPORTS_FROM; the severity is lower than "circular dependency" implied. Probe:
   `datalog2::differential::yaml_extract_tests::probe_real_mutual_module_imports`.
2. **A planner q-error** (recursive transitive-closure over-estimates → spurious E-PLAN-003) — see
   `_ai/gaps.md`; roadmap task #4. The full transitive-closure cycle query can't run on the real graph
   until the estimator is fixed; the bounded 2-cycle query above is the safe workaround that does run.
3. **CALL-resolution coverage** 16.2% direct-resolved (13634 CALL sites) — honest Layout-A lower bound.
4. **Import→MODULE coverage / depends recall** already characterized by `probe_imports_from_shape` +
   the differential's `unmapped_endpoints` (endpoints whose file has no MODULE node are dark to depends).

## What is now PROVEN (no decision needed)

- **The abstract-interpretation apparatus** (`semantic-graph-as-abstract-interpretation.md`) is
  empirically validated end-to-end on the engine: value-domains (iter1/2/4), library-semantics
  (iter5), deployment-binding resolution (iter6), coverage-as-negation (iter3 + real data §6).
  Prior art (§8) cross-checked against DOOP, egg, chase/Datalog±, provenance-semirings, why-not/PUG.
- **sim()** (what-if) is the read-only dual of **why()** (already wired to MCP). Both soundness
  obligations pinned: `sim(base,Δ) ≡ scratch(base ∪ Δ)` and non-destructive (base untouched).
- **v2 `depends/2` ⊋ orchestrator DEPENDS_ON** on the real corpus is already characterized by
  `differential.rs` (the only-v2 delta = endpoints the orchestrator's MODULE#-sid parser drops but
  the file-attr join maps; diagnostic prints samples). This is evidence the legacy path is
  retireable after Gate E + one release (task #8 lock in place).

## Decisions WAITING on you (I did NOT do these autonomously — out of safe-revertable scope)

1. **`DERIVED_FROM` vs `DERIVES_FROM` vocabulary fork** (`_ai/gaps.md`, `6e316f49`).
   Analyzers emit `DERIVED_FROM` (Expressions.hs); types/edges.ts + queries + archetypes.ts use
   `DERIVES_FROM`. ~17k edges are dark to every consumer. *Cross-layer rename — needs your call on
   the canonical spelling before I touch analyzer + TS in lockstep.* Recommendation: canonicalize on
   `DERIVES_FROM` (the consumer side; fewer call-sites than re-pointing all queries) and emit a
   one-shot migration. Low risk once the name is chosen.

2. **sim() production vertical.** Engine primitive proven AND **now proven on the REAL store**:
   `OverlayStorageView` (base `&dyn StorageView` ∪ in-memory hypothetical Δ) is built + verified
   (`f5ab49f2`) — `sim_on_real_store_predicts_new_depends_without_commit` runs a hypothetical
   `IMPORTS_FROM` through `depends.dl`/`maintain_incremental` over a live `LsmStorageView` and confirms
   `sim ≡ scratch(base ∪ Δ)` (622→623 depends) + non-destructive, on real data. The overlay was the
   risky infra piece and it's done + verified (additive, Gate A unaffected). **`GraphEngineV2::sim_datalog_v2`
   is ALSO done now** (`29b261f4`): the read-only engine method (snapshot → BorrowedLsmStorageView →
   OverlayStorageView → eval base+overlay → `sim ∖ base`), verified deterministically
   (`sim_datalog_v2_predicts_new_depends_without_committing`, engine_v2 48/48). **REMAINING = ONLY the
   product surface:** server `SimDatalog{source, hypothetical:[edits]}` dispatch calling
   `engine.sim_datalog_v2` + TS/MCP `sim_fact`, mirroring the `explain_fact` vertical exactly — now a
   ~30-min wire job, not a feature. *Held off ONLY on the user-facing surface (a product decision: the
   edit-input wire shape).* Recommendation: green-light — the entire engine layer is done + verified;
   it directly powers "what fact closes this gap?" for agents.

3. **Plugin system shape.** *(GROUNDED — corrects an earlier under-grounded version of this item;
   see `datalog-v2-in-the-plugin-pipeline.md`.)* The plugin system already exists: `packages/lang-spec/`
   generates analyzer plugins (rule-table + walk/post-file/post-project enrichers) from a language
   descriptor, with a human-reviewed vocabulary (= archetypes) and an edge-phase model. The v2 seam is
   concrete: a **post-project** edge with a `crossFile` requirement profile is exactly the apparatus's
   Datalog atom — currently emitted as a TypeScript `post-project-enricher`, the natural thing to lower
   to a `.dl` rule-pack + `@materialize`. **`depends.dl` is already the first such migration** (a
   post-project crossFile MODULE→MODULE edge replacing the orchestrator's TS derivation, proven ≡ on the
   real corpus). The rule-table is the IR ("future Rust implementation can consume it", README:185) and
   datalog2 is that runtime. Recommendation: first migration target = the JS analyzer's post-project
   relational edges (enumerate from `05-edge-requirements.json` `phaseDistribution['post-project']`),
   following depends.dl's template. *The one fact I couldn't ground from source: whether `rule-table.json`
   encodes enough to MECHANICALLY lower those edges (stage-10 codegen change) or each is hand-authored
   like depends.dl — needs a read of a real `{corpus}/.pipeline/` artifact (paid LLM run, not in-tree).*

## Why I stopped grinding tests

The engine and its real-corpus validation are mature; further *autonomous* safe units were trending
toward marginal coverage-probe variants (declining insight). The remaining high-leverage work is the
three decisions above, all of which need your input or change a product surface. Synthesizing rather
than manufacturing more green commits is the honest call. The loop continues; if a safe, consumer-backed
unit surfaces (e.g. a real-code dragons-probe you'd act on), I'll take it.
