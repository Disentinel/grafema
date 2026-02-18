# REG-503: Plan Revision — Addressing Dijkstra's Gaps

**Date:** 2026-02-18
**Fixes:** Gaps 1, 3, 5 from `004-dijkstra-verification.md`

---

## Gap 1 Fix: `eval_query` on `EvaluatorExplain`

**Problem:** `EvaluatorExplain` only has `query(&Atom)` (single atom with rules), but `execute_datalog_query` and `execute_datalog`'s direct-query path use `eval_query(&[Literal])` (conjunction of literals). `EvaluatorExplain` does not expose `eval_query`.

**Fix:** Add `eval_query(&mut self, literals: &[Literal]) -> QueryResult` to `EvaluatorExplain`. The logic mirrors `Evaluator::eval_query` (iterate literals, handle positive/negative, merge bindings) but wraps with explain tracking (query_start, stats reset, explain_steps, profile building) — same as `query()` does.

The implementation:
```rust
/// Evaluate a conjunction of literals with explain support
pub fn eval_query(&mut self, literals: &[Literal]) -> QueryResult {
    self.query_start = Some(Instant::now());
    self.stats = QueryStats::new();
    self.explain_steps.clear();
    self.step_counter = 0;
    self.predicate_times.clear();

    let mut current = vec![Bindings::new()];
    for literal in literals {
        let mut next = vec![];
        for bindings in &current {
            match literal {
                Literal::Positive(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);
                    for result in results {
                        if let Some(merged) = bindings.extend(&result) {
                            next.push(merged);
                        }
                    }
                }
                Literal::Negative(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);
                    if results.is_empty() {
                        next.push(bindings.clone());
                    }
                }
            }
        }
        current = next;
        if current.is_empty() { break; }
    }

    self.stats.total_results = current.len();

    // ... same profile/bindings conversion as query() ...

    QueryResult { bindings: bindings_out, stats, profile, explain_steps }
}
```

This also requires adding `substitute_atom` to `EvaluatorExplain`. Check if it exists — if not, port from `Evaluator`.

**Impact on rfdb_server.rs:** All three handlers (`execute_check_guarantee`, `execute_datalog_query`, `execute_datalog`) can now use `EvaluatorExplain` for both the rules path (`evaluator.query(&atom)`) and the direct query path (`evaluator.eval_query(&literals)`).

---

## Gap 3 Fix: Wire Struct — Per-Query, Not Per-Row

**Problem:** Plan had `Vec<WireExplainResult>` where each element carries stats/profile/steps. This duplicates query-level info N times for N result rows.

**Fix:** `ExplainResult` is a **single object** at the response level:

### Rust wire struct:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExplainResult {
    pub bindings: Vec<HashMap<String, String>>,  // ALL result rows
    pub stats: WireQueryStats,                    // once per query
    pub profile: WireQueryProfile,               // once per query
    pub explain_steps: Vec<WireExplainStep>,     // once per query
}
```

Response variant:
```rust
ExplainResult(WireExplainResult),
// NOT ExplainResult { results: Vec<WireExplainResult> }
```

### TypeScript type:
```typescript
export interface DatalogExplainResult {
  bindings: DatalogBinding[];       // all result rows as array of {[key]: value}
  stats: QueryStats;
  profile: QueryProfile;
  explainSteps: ExplainStep[];
}
```

### JS Client return type:
```typescript
// Non-explain: returns DatalogResult[] (array of per-row objects — existing behavior)
checkGuarantee(ruleSource: string): Promise<DatalogResult[]>;

// Explain: returns a SINGLE DatalogExplainResult object (not array)
checkGuarantee(ruleSource: string, explain: true): Promise<DatalogExplainResult>;
```

This maps 1:1 to Rust's `QueryResult` which is already a single top-level object.

### Direct mapping from QueryResult:
```
Rust QueryResult.bindings        → TS DatalogExplainResult.bindings
Rust QueryResult.stats           → TS DatalogExplainResult.stats
Rust QueryResult.profile         → TS DatalogExplainResult.profile
Rust QueryResult.explain_steps   → TS DatalogExplainResult.explainSteps
```

---

## Gap 5 Fix: MCP Handler Binding Access

**Problem:** Non-explain path uses `result.bindings.find(b => b.name === 'X')` (array-of-objects). Explain path has `bindings: DatalogBinding[]` where each is `{X: "value"}` (plain object).

**Fix:** The MCP handler has two distinct output paths:

**Non-explain path (unchanged):** Existing code. Results come as `Array<{ bindings: Array<{ name, value }> }>`. Existing table/formatting logic works.

**Explain path (new):** Call `checkGuarantee(query, true)` which returns `DatalogExplainResult`. Format output as:
1. Step-by-step execution trace (from `explainSteps`)
2. Query statistics (from `stats`)
3. Result bindings in simple format: iterate `bindings` array, for each row show `key=value` pairs

The explain output does NOT use the `result.bindings.find()` pattern at all — it renders a completely different text format focused on debugging. No enrichment, no node lookup. The bindings are shown as raw key-value pairs.

```typescript
if (explain) {
  const result = await checkFn.call(db, query, true);
  // result is DatalogExplainResult — single object
  return formatExplainOutput(result);
}
// else: existing non-explain path unchanged
```

The `formatExplainOutput` function renders the text table from `result.explainSteps` and appends the bindings as simple text. No `.find()` on bindings.

---

## Gap 2 Fix (LOW): TypeScript Overload Documentation

Add JSDoc to overloads:
```typescript
/**
 * Execute Datalog query.
 * @param explain Pass literal `true` to get explain data.
 *   A boolean variable won't narrow the return type.
 */
```

## Gap 4 Fix (MEDIUM): Missing Regression Test

Add test to Step 4 (rfdb-client.test.js):
```javascript
test('checkGuarantee without explain still returns violations correctly', async () => {
  const results = await client.checkGuarantee(ruleSource);
  assert.ok(Array.isArray(results));
  assert.ok(results[0].bindings);
});
```

## Gap 6 Fix (LOW): D1/D2 Contradiction

Remove D1. D2 is the correct design. Non-explain responses are unchanged wire format (`Violations`/`DatalogResults`). Stats/profile/steps only appear in `ExplainResult` variant.

---

## Revised Implementation Order

1. **Rust: Add `eval_query` to `EvaluatorExplain`** + tests (eval_explain.rs, tests.rs)
2. **Rust: Socket protocol** — add `explain` to requests, add `ExplainResult` response variant, update 3 handler functions (rfdb_server.rs)
3. **TypeScript types** — `DatalogExplainResult`, `QueryStats`, `QueryProfile`, `ExplainStep` (types/src/rfdb.ts)
4. **JS Client** — overloads + explain branch (rfdb/ts/client.ts) + regression test
5. **RFDBServerBackend** — forward explain (core/src/storage/backends/RFDBServerBackend.ts)
6. **MCP handler** — use explain, format output (mcp/src/handlers/query-handlers.ts)
7. **CLI** — `--explain` flag + output formatting (cli/src/commands/query.ts)
