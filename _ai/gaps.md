# Grafema Product Gaps

Gaps discovered during dogfooding. Each gap = graph couldn't answer a question it should.

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
- **Executor evaluates join legs per-row, not build-once hash-join** (Gate B blocker, 2026-06-06). The
  Gate B exit `depends/2` rule PLANS (estimate 148k) but its EVAL does not finish on the real graph in debug
  OR release (algorithmic): the `node(M,"MODULE"), attr(M,"file",F)` sub-pattern does a `nodes_by_attr` index
  probe PER IMPORTS_FROM row (1644×2). Same class as the earlier anti-join O(rows×M) hang. Fix = build the hash
  side ONCE for a shared-variable generator leg (proper semi-naive hash-join, spec §4), in `exec.rs` (mirror the
  existing `build_anti_join_set` one-time set). Benefits ALL multi-join rules. **This is the immediate next task to
  reach the Gate B exit** (see `_ai/research/rfdb-datalog-RESUME.md`).
