# Steve Jobs — Implementation Review: REG-506

**Verdict: REJECT**

---

## Summary

The implementation is almost right. The Rust core is correct, the wire format change is clean, the TypeScript types are updated, the client.ts fix from my planning review was applied correctly, and the CLI renders warnings to stderr as specified. Six out of seven requirements land cleanly.

But there is one concrete, demonstrable defect that will embarrass us in real use: **warnings can fire multiple times per query, and the implementation has no deduplication.** The planning review explicitly called this out and assigned it to implementation to resolve. It was not resolved.

---

## The Defect: Duplicate Warnings

### The mechanism

`eval_query` iterates over literals in order. For each literal, it calls `eval_atom` once per element in `current` (the running binding set):

```rust
for bindings in &current {
    match literal {
        Literal::Positive(atom) => {
            let substituted = self.substitute_atom(atom, bindings);
            let results = self.eval_atom(&substituted);  // fires once per binding
```

`eval_node` pushes a warning every time the `(Var, Var)` arm is hit:

```rust
(Term::Var(id_var), Term::Var(type_var)) => {
    self.warnings.push("Full node scan: consider binding type".to_string());
```

No deduplication. No guard. Just push.

### Why `reorder_literals` does not save us

`reorder_literals` marks `node` as always-placeable and always places it first when type is unbound. So `node(X, A)` appears as the first literal. Good — it fires once against `[Bindings::new()]`, pushing exactly one warning. X and A then become bound for downstream literals.

However, consider any query with **two free-type node literals**:

```
node(X, A), node(Y, B), edge(X, Y, T)
```

After reordering: `node(X, A)` is placed first (always-placeable), returning M bindings. Then `node(Y, B)` is evaluated M times — once per binding where X is now a Const, but Y is still a Var. Each call hits the `(Var(id_var), Var(type_var))` arm and pushes a warning. On a graph with 1000 nodes of mixed types, this produces 1001 warning entries in the Vec.

The CLI would then print 1001 lines of "Full node scan: consider binding type" to stderr. This is not a warning — it is an stdout blizzard that buries all actual output.

The same explosion happens inside derived rules: `eval_rule_body` calls `eval_atom` for each binding context, so any rule body containing `node(X, Y)` after another free node literal exhibits identical behavior.

### Why the tests don't catch this

The 7 new tests cover:
- Single `node(X, Y)` — fires once. Correct.
- Single `edge(X, Y, T)` — fires once. Correct.
- Bound variants — no warnings. Correct.
- Without explain mode — warnings still collected. Correct.
- Efficient multi-literal query (`node(X, "FUNCTION"), edge(X, Y, "CALLS")`) — no warnings. Correct.
- Cross-query contamination — cleared on reset. Correct.

**No test exercises a multi-literal query with two unbound-type nodes or two unbound-source edges.** The duplicate emission path is untested.

### The fix

The planning Steve said: "Don should verify that warning deduplication (e.g., using a HashSet instead of Vec in the accumulator) is considered. This is implementation detail for Joel/Kent to nail down, not a plan-level rejection."

Joel/Kent did not nail it down. The fix is straightforward: change `warnings: Vec<String>` to `warnings: HashSet<String>` in `EvaluatorExplain`, push via `insert()` instead of `push()`, and convert to `Vec` in `finalize_result`. Alternatively, deduplicate before moving into `QueryResult`. Either way, one warning message per warning type per query — not one per binding evaluation.

A test must be added: multi-literal query with two `node(X, A), node(Y, B)` forms must produce exactly **one** warning, not N.

---

## What Is Correct

Everything else is clean:

**Rust core (`eval_explain.rs`):** The `warnings` field placement on `QueryResult` (not `QueryStats`) is correct. The structural pattern detection (match arm, not threshold) is correct. The `std::mem::take` in `finalize_result` is the right pattern — avoids clone. The `warnings.clear()` in both `query()` and `eval_query()` is correct.

**Wire format (`rfdb_server.rs`):** `WireExplainResult` gets `warnings: Vec<String>`, mapped directly from `result.warnings`. Clean.

**TypeScript types (`rfdb.ts`):** `DatalogExplainResult` gets `warnings: string[]`. Correct.

**Client fix (`rfdb/ts/client.ts`):** The planning review's mandatory fix was applied: `warnings: r.warnings || []` in `_parseExplainResponse`. All three explain paths (datalogQuery, checkGuarantee, executeDatalog) go through this method. The end-to-end pipeline works.

**CLI (`query.ts`):** Warnings printed to stderr before explain output, with blank line separator. Format matches the AC. The `result.warnings && result.warnings.length > 0` guard handles both empty array and undefined defensively.

**Tests (what exists):** The 7 new tests are well-structured. They test the right things for the cases they cover. Names are clear, assertions communicate intent. The `test_warnings_without_explain_mode` test is particularly good — confirms warnings are independent of explain mode. The `test_warnings_cleared_between_queries` test demonstrates clean state isolation.

---

## Vision Alignment

This feature directly serves "AI should query the graph, not read code." An AI agent writing bad Datalog queries gets immediate feedback. The implementation is additive only, zero overhead on the non-explain path. Scope is tight. This is the right feature implemented in mostly the right way.

The defect is not architectural. It does not require rethinking the design. It requires a one-line fix (Vec → HashSet dedup) and one additional test. But shipping it with explosive duplicate warnings in the CLI would be embarrassing — imagine an AI agent trying to parse 1000 identical warning lines before seeing results.

---

## Required Before Approval

1. **Deduplicate warnings.** Change accumulation strategy so each unique warning string appears at most once per query execution. HashSet on the accumulator, or dedup before `finalize_result`. Either approach is fine.

2. **Add a test for duplicate suppression.** A multi-literal query that would fire the same warning multiple times under a naive Vec implementation must produce exactly one instance of that warning in the result.

---

**REJECT**
