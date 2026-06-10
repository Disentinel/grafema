# Grafema Product Gaps

Gaps discovered during dogfooding. Each gap = graph couldn't answer a question it should.

## 2026-06-07: Orchestrator DEPENDS_ON derivation drops Haskell (`MODULE#`-sid) imports

- **Where**: `packages/grafema-orchestrator/src/main.rs:1745-1758` (phase 9, "Derive MODULE→MODULE
  DEPENDS_ON edges from IMPORTS_FROM"). For each `IMPORTS_FROM` edge it maps each endpoint to a file by
  STRING-PARSING the semantic_id — strip `grafema://{authority}/` prefix, ELSE `split("->").next()` — then
  `file_to_module.get(parsed_file)`.
- **Bug**: a Haskell `IMPORTS_FROM` runs IMPORT-node → MODULE-node. The MODULE endpoint's semantic_id has a
  `MODULE#` prefix (e.g. `MODULE#/Users/.../AST/Types.hs`), which matches NEITHER parse branch (`grafema://`
  nor `->`), so the parser leaves the whole `MODULE#/...` string → `file_to_module` miss → the edge is
  silently dropped. Affects all 16 Haskell packages.
- **Evidence (live, on `.grafema/grafema.rfdb`, snapshot v104, via the Gate B differential diagnostic,
  `src/datalog2/differential.rs`)**:
  - `805 of 1644` IMPORTS_FROM edges had an endpoint the orchestrator's sid-parse could not map.
  - `622` edges map both endpoints to distinct modules by FILE ATTR but NOT by sid-parse; sample dst:
    `sid=MODULE#/Users/.../AST/Types.hs file_attr="/Users/.../AST/Types.hs" sid_parsed="MODULE#/Users/.../AST/Types.hs"`.
  - Net: the orchestrator under-derives DEPENDS_ON by **127 real module-pairs** (v2's file-attr join finds
    622, orchestrator's sid-parse 495, only-v2=127, only-oracle=0).
- **Why it matters**: DEPENDS_ON is a core product edge; Haskell module-dependency queries (and anything
  built on DEPENDS_ON) are silently incomplete. The graph SHOULD answer this — it has the right `file` attr
  on every node; only the derivation's string-parse is lossy.
- **Fix (product, follow-up)**: derive the endpoint file from the node's `file` ATTR (what the v2 Datalog
  rule does) instead of parsing the semantic_id; OR, minimally, teach the parser the `MODULE#` prefix. The
  attr-based derivation is the robust fix (no format coupling). Until fixed, the v2 `depends.dl` (file-attr
  join) is the correct reference.
- **Severity**: real product gap (silent under-derivation on a first-class edge), not a v2-engine gap. The v2
  Datalog engine is the thing that SURFACED it (Gate B exit differential).

## 2026-04-28: Datalog same-function deadlock rule misses cross-file dispatch

- **Query attempted**: `node(Fn,"FUNCTION") ∧ Fn—CONTAINS→CALL{name=acquire_all,line=L1} ∧ Fn—CONTAINS→CALL{name=acquire,line=L2} ∧ lt(L1,L2)`
- **Expected**: Catch the `main.rs` deadlock — `acquire_all()` holds pool, then a later call to `stream_and_resolve_single_worker` triggers `pool.acquire()` inside it
- **Actual**: Zero results, but Rust IS in graph. `main.rs` has 1052 CALL nodes including `acquire_all` and `plugin::stream_and_resolve_single_worker`. The miss is **modeling**, not data: `pool.acquire()` lives in `plugin.rs::stream_and_resolve_single_worker`, not in `main.rs`. Cross-file CALLS edge needs to be traversed.
- **Correct rule (untested, draft)**: should join via `CALLS` edge to follow into callee bodies — `Caller —CONTAINS→ Site1{name=acquire_all,line=L1}` AND `Caller —CONTAINS→ Site2{name=Fn,line=L2,L2>L1}` AND `Site2 —CALLS→ Callee` AND `Callee —CONTAINS→ AcquireCall{name=acquire}`. Whether RFDB's Datalog engine handles this efficiently is open.
- **Severity**: minor — the dogfood-relevant deadlock pattern is real but the rule shape is more interesting than first sketched. Not a product gap.
- **Side finding (NOT a gap, recorded so I don't re-investigate it)**: `packages/rust-analyzer/` Haskell package is **dead code** — orchestrator switched to native in-process Rust analysis (`grafema-orchestrator/src/rust_analyzer.rs`, header comment: "Replaces the Haskell grafema-rust-analyzer"). The Haskell binary is not on the spawn path; whether it exists in `~/.grafema/bin/` is irrelevant. To-remove candidate.

**What would work (for JS/TS equivalents):** The rule is sound. If pool logic existed in TypeScript, the guarantee would fire:
```datalog
violation(FnName, L1, L2) :-
  node(Fn, "FUNCTION"), attr(Fn, "name", FnName),
  edge(Fn, C1, "CONTAINS"), node(C1, "CALL"), attr(C1, "name", "acquire_all"), attr(C1, "line", L1),
  edge(Fn, C2, "CONTAINS"), node(C2, "CALL"), attr(C2, "name", "acquire"), attr(C2, "line", L2),
  lt(L1, L2).
```

**Foundation exists for JS/TS:** BRANCH nodes (9,825), CALL nodes with line numbers (57,514), FUNCTION→CONTAINS→CALL (16,455 matches), GUARDED_WRITE edges (258). CFG ordering via `lt()` on line numbers is feasible without needing explicit PRECEDES edges.

## 2026-06-06: Datalog v2 engine — known gaps / roadmap (found by the Gate A real-data differential)

The v2 bottom-up engine (`packages/rfdb-server/src/datalog2/`) reached Gate A exit (51/51 v2 ≡ v1
on `.grafema/grafema.rfdb`). The differential surfaced these gaps, mapped to spec gates
(`_ai/research/rfdb-datalog-engine-v2-spec.md`):

- **Numeric literal parsing** — IMPLICIT gap. `Value` already includes `Int(i64)|Float(f64)` (§5),
  and `gt/lt/gte/lte` builtins exist, but the parser (`term := var | const | "_"`, `const` = quoted
  string) cannot lex a bare number. So `gt(A, 0)` fails to parse — in BOTH v1 and v2. Consequence:
  the production guarantee `call-with-args-has-passes-argument` (`.grafema/guarantees.yaml:371`) has
  **never worked in either engine** (dead `severity: warning` rule). Fix = lexer numbers + `Value::Int`
  terms; small, sits naturally with → **Gate C** (where numeric tags/aggregators land). Until then the
  differential honestly reports it as a both-engines rejection (the headline is **50/51 computed-
  identical + 1 awaiting numeric literals**, not a clean 51).
- **Aggregators `count/sum/min/max`** — spec'd (Appendix A grammar §363, semantics §4), scoped to
  → **Gate C** (need CountTag). Gate A parses-and-defers them. Recursive aggregates explicitly
  deferred (§13 Open). Arithmetic numeric FUNCTIONS (`A+B`, `A*2`) are NOT in the spec at all.
- **Planner ordering is cardinality-blind** — `order_literals` ranks by `static_cost` (bound-arg
  count), not by estimated cardinality; the per-type oracle lives only in the per-rule size guard
  (`leg_estimate`). And `cost_node`/`cost_edge` (the registered `BuiltinDef.cost`) are **dead code**
  (assigned but never called). Not a correctness issue (results are order-independent, I1) — a
  plan-quality one → **Gate D** ("planner median q-error ≤ 4"). [Partially closed 2026-06-06: ordering
  made per-type-cardinality aware; see commit.]
- **`attr` value-generator** — Gate A scoped `attr` to a bound-Id filter, so a rule using
  `attr(X,"k","v")` with X unbound (find nodes by attr value) errored E-PLAN-001 where v1's
  `find_by_attr` would run → capability gap vs v1. [Closed 2026-06-06: generator mode wired via the
  snapshot-pinned `find_node_ids_by_attr_at`, parity with v1.]
- **Parallel re-shuffle (I1 K=N)** — exec is single-worker (= K=1 of the I1 invariant); the spec's
  K=8 ≥ 3× K=1 speedup assertion is deferred → Gate A residual.
- **`bench/manifests/gate-a.yaml`** conformance manifest not yet authored (P1: "green = manifest") →
  Gate A residual.
- **Executor evaluated join legs per-row, not build-once hash-join** (Gate B blocker, 2026-06-06) —
  **RESOLVED 2026-06-07**. The `depends/2` EVAL never finished on the real graph; two coupled causes,
  both now fixed:
  1. **Per-row full scan.** `attr(FreeId,"file",F)` in generator mode called `nodes_by_attr` →
     `find_node_ids_by_attr_at` (a FULL node-segment scan, `multi_shard.rs:1485`) ONCE PER IMPORTS_FROM
     row ≈ 1644 × 137k ≈ 225M examinations. Fix (`exec.rs join_attr_generator_built_once`): build the
     `value→[id]` hash side ONCE from a single `sorted_run(Nodes)` pass, probe O(1) per row → O(nodes+rows)
     (proper build-once hash-join, spec §4); falls back to per-row for non-surface keys (metadata/`exported`/
     variable key). Mirrors the existing `build_anti_join_set` one-time set.
  2. **Intermediate row blowup (ordering).** `ordering_estimate` costed EVERY `attr` as 0 (via the blanket
     `is_filter_or_function("attr")`), so BOTH `attr` generators sorted ahead of their `node(_,"MODULE")`
     type-filters → ~12M-row intermediate set before any pruning. Fix (`plan.rs ordering_estimate`): a leg
     that binds NO new variable (filter / bound-id point check / anti-join) is the 0-cost leg; a leg that
     INTRODUCES a variable (incl. `attr` GENERATOR mode) is ranked by cardinality. Interleaves
     generator→filter→generator→filter; peak intermediate ~140k.
  Result: `depends.dl` eval finishes in **97.66s** (was: never / killed >15min). **Gate A re-verified
  50/51 match=50 mismatch=0 — no regression** (the change is ordering-only, I1 preserved). 122 datalog2
  unit tests green (added `attr_value_generator_is_built_once_not_per_row` contract test: 0 `nodes_by_attr`
  calls + bounded sorted-node passes). Benefits ALL multi-join rules, not just depends.

## 2026-06-09: Edge-vocabulary FORK — DERIVED_FROM (emitted) vs DERIVES_FROM (declared)

- **Found** while grounding the archetype claim-map (apparatus doc / I13) against the REAL graph
  (`.grafema/grafema.rfdb` probe): `DERIVED_FROM` is the **3rd-largest edge class (17,385 edges)** and
  is UNCLAIMED by `packages/util/src/notation/archetypes.ts` (`EDGE_ARCHETYPE_MAP`).
- **Root cause (NOT a typo-drift — a real fork across layers):**
  - `DERIVED_FROM` (past tense) is EMITTED by the analyzers + enricher + dataflow query:
    `packages/js-analyzer/src/Rules/Expressions.hs` (`geType="DERIVED_FROM"`, lines 109/675/685),
    `packages/haskell-analyzer/src/Rules/Expressions.hs`, `util/src/enrichers/libraryCallbackEnricher.ts`,
    `util/src/queries/traceDataflow.ts`.
  - `DERIVES_FROM` (present tense) is DECLARED + consumed by the type/query/cli layer:
    `packages/types/src/edges.ts`, `lang-spec/data/vocabulary/baseline.json`,
    `util/src/queries/{types,traceValues}.ts`, `util/src/storage/backends/typeValidation.ts`,
    `cli/src/commands/{explore,impact}.ts`, and the archetype map (`archetypes.ts:104`).
- **Impact:** the 17k emitted `DERIVED_FROM` edges are dark to type-tracing, the archetype
  notation/describe rendering, and any query keyed on `DERIVES_FROM`. Two synonyms split the dataflow
  vocabulary. (Also unclaimed: `AWAITS` 1016, `HAS_EFFECT` 27.)
- **RE-VERIFIED at HEAD (2026-06-09):** the original counts came from a Mar-4 graph snapshot
  (`.grafema/grafema.rfdb`, ~3mo stale — see report staleness caveat), but the FORK ITSELF is live at
  current HEAD: `DERIVED_FROM` is still emitted by `js-analyzer/src/Rules/Expressions.hs`
  (lines 109/675/685/716/726/757/819/830) + `haskell-analyzer`; `DERIVES_FROM` is still consumed by
  `types/src/edges.ts`, `util/src/queries/{types,traceValues}.ts`, `util/src/storage/backends/typeValidation.ts`,
  `util/src/notation/archetypes.ts` (6 emitter files vs 20 consumer files, grep at HEAD). Only the
  exact 17385 COUNT is stale; the cross-layer split stands and still needs the canonical-name decision.
- **Why NOT fixed autonomously (2026-06-09 overnight loop):** picking a canonical name is a cross-layer
  vocabulary decision — rename in the analyzers (changes analyzer OUTPUT → needs reanalyze, risks
  dataflow) OR add the synonym to types+queries+cli (two names forever). Analyzer-output change is not
  cleanly git-revertable and needs a human call on which name wins. Surfaced for decision.
- **Fix options:** (a) canonicalize to `DERIVED_FROM` (analyzers are the source of truth) — migrate
  types/queries/cli/vocab/map; reanalyze. (b) canonicalize to `DERIVES_FROM` — change the 2 analyzers'
  `geType` + reanalyze. (c) alias both in the archetype map short-term (stops the dark-edge bleed in
  notation) while deciding. Recommend (a): the emitted name is the ground truth; the 17k edges already exist.
- **Ties to:** I13 edge-vocabulary governance (apparatus doc); the archetype claim-map + W-code would
  have caught this at load time. This fork is the concrete motivation for that mechanism.

## Planner q-error: recursive transitive-closure over-estimates → spurious E-PLAN-003 (2026-06-09)

- **Gap:** the v2 planner rejects a recursive transitive-closure rule with `E-PLAN-003` because its
  per-rule output estimate compounds instead of saturating. On the real dogfood graph, cycle
  detection over `depends/2` (`dep_reach(A,B) :- depends(A,C), dep_reach(C,B)`) estimates ~54.3M
  output facts vs the 10M `MAX_MATERIALIZED_FACTS` guard — despite only ~622 base `depends` pairs
  (true closure ≤ modules², a few hundred² ≪ 54M).
- **Evidence:** `datalog2::differential::yaml_extract_tests::probe_real_module_dependency_cycles`
  (ignored) prints `E-PLAN-003 (dep_reach): per-rule output estimate 54259156 exceeds
  max_materialized_facts 10000000`. Logic is correct on a fixture
  (`datalog2::smoke::module_dependency_cycles_via_transitive_closure_over_depends`, green).
- **Root cause (hypothesis, not yet fixed):** the recursive leg's estimate multiplies the recursive
  relation's running magnitude by the base, with no fixpoint-saturation discount; transitive closure
  is bounded by |nodes|² but the estimator treats each iteration as an independent product.
- **Why NOT fixed autonomously:** the estimator lives next to the prod `MAX_MATERIALIZED_FACTS`
  safety guard (`plan.rs:43`); changing recursive-rule estimation risks under-guarding real runaway
  joins. Needs a deliberate estimator change + Gate A re-verify, not an overnight patch.
- **This is the roadmap's "planner q-error (Gate D)" residual (task #4)**, now with a concrete
  reproduction on real data. Fix options: (a) cap a recursive rule's estimate at |nodes|^arity
  (closure can't exceed the universe); (b) saturating estimate for self-recursive legs; (c) a
  bounded-depth reach formulation for cycle queries specifically.

### ✅ FIXED 2026-06-10 (decision #4 + the exec twin) — three q-error layers landed

1. **Derived-leg estimates (the spec below): DONE.** `plan_program` now threads a per-predicate
   cardinality map STRATUM-BOTTOM-UP into `plan_rule_with → leg_estimate → derived_estimate`;
   a recursive self-leg uses 2× its base-case estimate. The anchor test
   `recursive_closure_spuriously_tripped_by_global_magnitude_qerror` FLIPPED to assert success;
   new `derived_chain_uses_per_predicate_estimates_not_global_magnitude` pins the chain shape.
2. **Bound-endpoint edge legs: √E → average degree (⌈E/N⌉).** The √844k ≈ 920-per-hop model
   inflated a 3-hop chain (method_calls receiver walk) to 779M → spurious E-PLAN-003; real
   fan-out is ~3 (avg degree). `rejects_oversized_rule_estimate` updated to a dense-graph
   fixture (E/N = 1e5) where the guard legitimately fires.
3. **Exec `join_derived` was O(rows × facts) — now a build-once hash-join** (exec.rs): index the
   relation by the leg's bound positions once, probe per row; anti-join = build-once HashSet.
   This was invisible to depends.dl (no derived legs in its one rule) and fatal for any program
   with helper predicates. Measured on the method_calls fixture probe: n=20k **23.4s → 2.5s**
   (9.3×), identical fact counts, scaling 6.9x → 4.6x per 4× input.

Verification: datalog2 172/172, full lib 1091 green (5 pre-existing cypher-aggregate failures
reproduce on clean HEAD), Gate A differential 10/10 green (222s) WITH the hash-join.

### ✅ 4th LAYER FIXED (2026-06-10, commit 31d228c3, workflow wf_de9fc616-bfd)

Build-once base-leg joins in `join_extensional` (typed-index scan → hash buckets for
bound-endpoint edge legs; distinct-id dedup/batch for attr/node point reads; threshold-gated,
property-tested identical to the per-row path). **Full-graph headline: method_calls.dl scratch
4.08s (was >900s deadline), 2628 CALLS written; re-run 11.3s, 0 written (idempotent).** The
replaced plugin produced NOTHING in its 60s timeout. Real-LSM @20k differential test gates it
(24.6s release, counts ≡ fixture). Review follow-ups (non-blocking): index rebuilt per fixpoint
iteration (cache on (leg, view generation)); attr distinct-scan >1024 ids materializes the node
run. NOTE: maintain path (11.3s) is SLOWER than scratch here — the pack has negation/2 strata
(outside the monotone envelope → recompute + diff); fine, not a target.

### ~~THE REMAINING (4th) LAYER~~ (fixed above; original analysis follows)

method_calls.dl on the REAL graph still hits the 900s deadline AFTER the exec hash-join, while
the same program on the in-memory fixture runs 2.5s @ n=20k — the ONLY differential is the
StorageView. `join_extensional` evaluates base legs (`attr(C,"name",V)` point reads,
`edge(C,V,"READS_FROM")` bound-src probes) PER ROW against LsmStorageView: ~69k CALLs × 5-8
probes/row ≈ 0.5M LSM probes ≈ the 900s scale. depends.dl never hit this (its generator is 3k
IMPORTS_FROM rows). **Fix direction:** build-once base-leg joins — ONE type-index scan per leg
building src→rows / id→attr maps, then hash probes (mirror of the existing
`join_attr_generator_built_once`). Validate with a fixture-style test backed by a REAL
ephemeral LsmStorageView (engine test), per the small-fixture discipline.


### PRECISE FIX (code-grounded, 2026-06-09) — q-error root cause located + spec'd

- **Root cause (exact):** `derived_estimate(pattern, stats)` (`packages/rfdb-server/src/datalog2/plan.rs:668`)
  sizes EVERY derived leg at the global magnitude `total_nodes.max(total_edges)` — it has no
  per-predicate cardinality. For `dep_reach(A,B) :- depends(A,C), dep_reach(C,B)` BOTH derived legs
  (`depends` and the recursive `dep_reach`) get the whole-graph magnitude M, giving `rule_estimate ≈
  M^1.5`. On the real graph M ≈ 142k ⇒ 54,259,156, despite `depends` being only ~622 facts.
- **Why it's NOT a local tweak:** `derived_estimate`'s signature only has `(pattern, stats)` — no
  access to other predicates' sizes. The base-rule legs (`edge` const-type, `attr` point-read) were
  ALREADY fixed for the same 54M symptom (see `base_estimate` comments); only the DERIVED legs remain.
- **Spec'd fix:** thread a `HashMap<predicate, u64>` of estimated cardinality, populated
  **stratum-bottom-up** (a predicate's estimate is known before higher strata that reference it are
  planned), into `plan_rule → leg_estimate → derived_estimate`. A derived leg uses
  `estimates.get(pred)` instead of the global magnitude. For the **recursive self-leg** (`recursive ==
  true`, already computed in `classify()` at `plan.rs:589`) the predicate's own estimate isn't final
  (fixpoint) — use its BASE-CASE estimate (max over its non-recursive rules); a binary transitive
  closure is bounded by `(2·base_case)²`, which for depends (622) is ~1.5M < the 10M guard.
- **Safety note for the implementer:** lowering derived estimates can only make MORE rules pass the
  E-PLAN-003 guard (never fewer) and only reorders legs (I1 correctness-invariant), so Gate A
  correctness should hold — BUT it changes plan estimates for every prod materialize query, so verify
  beyond Gate A (estimate-accuracy isn't gated). This is why it was NOT done in the overnight loop.
- **In-tree anchor:** `datalog2::plan::tests::recursive_closure_spuriously_tripped_by_global_magnitude_qerror`
  reproduces it deterministically (50 edges, 50M nodes → spurious E-PLAN-003) and MUST FLIP to assert
  success when this fix lands.

### ~~why-not edge case: named existential var in negation~~ — CORRECTED: NOT a gap (2026-06-09)

- **CORRECTION (supersedes the original note below):** there is NO why-not footgun here. A NAMED var
  used ONLY inside a negated literal (`safe(X) :- node(X,"FUNCTION"), \+ edge(X, Y, "DANGER")`) is UNSAFE
  Datalog (it can never be positively bound), and the planner CORRECTLY REJECTS it with **E-PLAN-002
  Infeasible** ("cannot order bound-first: no feasible binding for [edge]") — it is NOT silently
  mis-handled. The wildcard form `\+ edge(X, _, "DANGER")` is the well-formed existential and evaluates
  correctly. Pinned by `named_existential_var_in_negation_is_rejected_as_unsafe` (named ⇒ E-PLAN-002;
  wildcard ⇒ only the unblocked node is safe).
- **Why the original note was wrong:** I read a test panic location (`exec.rs:2738`) WITHOUT its detail
  (grep filtered it) and assumed the `.expect(...gap)` Option-unwrap fired, concluding "explain_gap
  returned None (silent no-gap)". The detail actually showed the panic was the earlier
  `plan_program(...).expect("plan")` — a correct E-PLAN-002 rejection. Lesson: read the FULL panic
  (location AND message) before diagnosing; don't filter out the detail and infer which assertion fired.
- ~~Original (incorrect) claim:~~ *"explain_gap returned None for a node blocked by a present DANGER edge
  — why-not silently failed to detect a real gap; a FOOTGUN."* — **FALSE**; it was a correct plan rejection.

## `analyze --clear` is a placebo on the v2 engine — old-generation edges survive reanalysis (2026-06-09)

**Evidence (live, graph.rfdb):** after `analyze . --clear` with renamed analyzers, the graph held
`DERIVES_FROM: 52217` (gen 37, fresh) AND `DERIVED_FROM: 15531` (gen 36 = the MORNING run's
generation, per edge `_generation` metadata); 15014 (src,dst) pairs carry BOTH forms. Manifest
version continued 660 → 1001 across the "cleared" run — the on-disk DB was never wiped.

**Mechanism:** `analyzeAction.ts:340-346` does `backend.clear()` → `shutdownServer()` → `connect()`.
`GraphEngineV2::clear()` (engine_v2.rs:1539) swaps store+manifest to EPHEMERAL (in-memory, disk
untouched — the documented `rfdb-v2-clear-ephemeral-trap`); the shutdown then discards that
ephemeral state and the fresh auto-started server RELOADS the old on-disk DB intact. `--force`
re-analysis then supersedes most data per-file, but edges of prior generations partially survive
(15.5k here). The Feb-2026 skill documented the data-LOSS flavor (clear without restart); this is
the dual: clear+restart = no-op.

**Fix direction:** `GraphEngineV2::clear()` must clear the PERSISTENT store (tombstone-all or
segment truncation + empty-manifest flip at a new version, honoring MVCC pins), not swap to
ephemeral. Until then: the only real clear is `rm -rf .grafema/graph.rfdb` before the server starts.

**Also:** why do exactly ~15.5k edges survive `--force` per-file deletion while the rest are
superseded? Worth understanding the per-file delete path (suspect: edges whose src node id is
identical across generations are not tombstoned by changed-file deletion).

## @materialize_node advisory follow-ups (W4 review wf_4abcf48c-1d8, 2026-06-10 — none blocking)

1. **All-numeric semantic-id drift**: plan_node_writeback blake3-hashes unconditionally;
   the wire writer string_to_id() parses decimal FIRST — a bare-decimal sid mints a divergent
   u128. Unreachable by shipped packs (prefixed sids); extend E-MAT-010 to reject all-decimal sids.
2. **Auto-flush can tear run isolation under buffer pressure**: add_nodes/add_edges end with
   maybe_auto_flush which publishes WITHOUT the run's pending tombstones — a mid-delta flush
   shows adds before retractions (self-heals at the explicit flush). Suppress auto-flush during
   materialize write-back or weaken the one-flush docstring.
3. **attr(X,"type",T) bypasses the node-feedback stratifier dependency** (edge axis has no such
   bypass — edge_attr can't read the edge type). Track attr-type-const in node_type_arg or fix docs.
4. **O(owned²)**: removed_node_ids is a Vec scanned per node of the type; HashSet one-liner.
5. **Never-rewrite staleness for OWNED nodes**: a re-derived owned node with a CHANGED surface
   (e.g. ISSUE message after method rename on the same CALL) keeps the stale payload forever —
   diverges from the plugin's last-write-wins; rewrite owned-changed nodes or record the delta.
6. **Mixed-producer transition**: a plugin-written ISSUE at the same id is owned by NOBODY after
   the plugin retires (pack can't rewrite or retract it). Document or co-own _source='shape-verifier'.
7. **Cache pinning for always-scratch programs**: node-materializing entries still pin prior
   snapshots in datalog2_materialize_cache for zero benefit; skip the insert.
