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
