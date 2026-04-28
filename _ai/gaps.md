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
