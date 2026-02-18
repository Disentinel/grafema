# REG-503 Batch 2 Reviews

## Dijkstra — Correctness Review

**Verdict:** APPROVE (with one advisory)

**Functions reviewed:**
- `EvaluatorExplain::eval_query` (`eval_explain.rs:190–261`)
- `EvaluatorExplain::query` (`eval_explain.rs:141–187`) — for comparison
- `execute_check_guarantee` (`rfdb_server.rs:1795–1832`)
- `execute_datalog_query` (`rfdb_server.rs:1844–1876`)
- `execute_datalog` (`rfdb_server.rs:1877–1936`)
- `datalogQuery` / `checkGuarantee` / `executeDatalog` in `client.ts`
- `datalogQuery` / `checkGuarantee` / `executeDatalog` in `RFDBServerBackend.ts`
- `handleQueryGraph` in `query-handlers.ts`
- `executeRawQuery` + `renderExplainOutput` in `query.ts`

---

### `EvaluatorExplain::eval_query` (eval_explain.rs:190–261)

**Inputs:** `&[Literal]` — an empty slice, a single literal, or a conjunction.

- Empty slice (`[]`): The loop body never executes. `current` stays `[Bindings::new()]`. `total_results = 1`. This produces one empty binding. This matches the semantics of a vacuously-true conjunction — it is the same behavior as in the regular `Evaluator`. Correct.
- Single positive literal: The loop runs once, `eval_atom` is called, results are merged with the empty starting binding, and the results become `current`. Correct.
- Single negative literal: If `eval_atom` returns empty, the starting binding is kept; otherwise `current` becomes empty. Correct.
- Multi-literal conjunction: Each literal narrows `current` via merge. The early-exit on `current.is_empty()` avoids unnecessary work. Correct.
- `explain_mode = false`: `explain_steps` is empty. Stats are still accumulated (predicate_times via `record_step`). Bindings are still returned correctly. Correct.
- `explain_mode = true`: Steps are recorded in `record_step`. The return collects `self.explain_steps.clone()`. Correct.

**One structural note:** `eval_query` and `query` share roughly 30 lines of identical code for building `bindings_out`, `profile`, and `QueryResult`. The difference is only in how `current` is initially populated (`eval_atom(goal)` vs the literal loop). This duplication is a code quality concern, not a correctness defect. The logic in both is correct.

---

### `execute_check_guarantee` (rfdb_server.rs:1795–1832)

**Inputs:** `engine`, `rule_source: &str`, `explain: bool`

- `explain = false`: Parses the program, builds a plain `Evaluator`, runs `query(&violation_query)`. Returns `DatalogResponse::Violations`. Identical logic to the pre-patch code. Correct.
- `explain = true`: Parses the program, builds `EvaluatorExplain::new(engine, true)`, runs the same query. Returns `DatalogResponse::Explain`. Correct.
- Parse error: `?` propagates as `Err(String)` in both branches. Correct.
- Empty rule set: `program.rules()` is iterable as empty — both evaluators handle this gracefully (they will return no results from `query`). Correct.

---

### `execute_datalog_query` (rfdb_server.rs:1844–1876)

**Inputs:** `engine`, `query_source: &str`, `explain: bool`

- `explain = false`: Calls `Evaluator::eval_query`. Note: `Evaluator` is not `mut` here (line 1923). It does not need to be, as `eval_query` on the plain `Evaluator` takes `&self`. Correct.
- `explain = true`: Creates `EvaluatorExplain` (which requires `mut`), calls `eval_query`. Correct.
- Parse error: Returns `Err`. Correct.

---

### `execute_datalog` (rfdb_server.rs:1877–1936)

**Inputs:** `engine`, `source: &str`, `explain: bool`

**Program-with-rules path:** Parses as a program. If it has rules, applies them. In both explain and non-explain branches, the query is `program.rules()[0].head()` — the first rule's head atom.

**Edge case — multi-rule programs:** When `source` contains multiple rules with different head predicates (e.g., `foo(X) :- ... bar(Y) :- ...`), only the first rule's head is queried. This is pre-existing behavior (not introduced by this patch) and is a known limitation of `executeDatalog`. Not a regression.

**Fallback path:** If the program has no rules (empty program, or parse as program fails), falls through to `parse_query`. The explain branching applies identically in the fallback. Correct.

---

### `datalogQuery`, `checkGuarantee`, `executeDatalog` in `client.ts`

All three follow the same pattern:

1. Build payload, add `explain: true` only when requested.
2. Call `_send`.
3. If `explain`: cast the response and reconstruct a `DatalogExplainResult`. The cast uses `as unknown as DatalogExplainResult & { requestId?: string }`. The `|| []` defaults on `bindings` and `explainSteps` handle the case where the server returns unexpected shape.
4. If not explain: cast to the pre-existing result shape.

**Wire format alignment:** The server's `Response::ExplainResult(WireExplainResult)` is serialized via `#[serde(untagged)]`, so the wire object has top-level keys: `bindings`, `stats`, `profile`, `explainSteps` (due to `#[serde(rename_all = "camelCase")]` on `WireExplainResult`, which converts `explain_steps` to `explainSteps`). The client reads `r.explainSteps`. This matches. Correct.

**The client does not check `response.error`** before accessing the explain fields. If the server returns an error response, `r.bindings` will be `undefined`, and the `|| []` default will silently return an empty result instead of throwing. However, this is a pre-existing pattern in the client — the existing non-explain paths also don't check for errors inline — so it is not a regression.

---

### `datalogQuery`, `checkGuarantee`, `executeDatalog` in `RFDBServerBackend.ts`

Each follows the pattern:
- If `explain`: delegate directly to `this.client.X(arg, true)` and return the `DatalogExplainResult` as-is. No transformation. Correct.
- If not `explain`: delegate to `this.client.X(arg)` and apply the `bindings` → `[{name, value}]` transformation. Correct.

The explain path skips the `bindings` transformation intentionally — the `DatalogExplainResult.bindings` is already in `DatalogBinding[]` (dict) format. Correct.

---

### `handleQueryGraph` in `query-handlers.ts`

**explain = true path (lines 42–46):**
```ts
const checkFn = (db as unknown as { checkGuarantee: (q: string, explain: true) => Promise<DatalogExplainResult> }).checkGuarantee;
const result = await checkFn.call(db, query, true);
```

This uses `checkGuarantee` with `explain=true`. Note that `handleQueryGraph` is the MCP tool for running **Datalog programs** (guarantees). The MCP tool routes programs through `checkGuarantee`, not `executeDatalog`. This is the correct endpoint for the MCP tool's intended use (rule-based violation queries). The `explain` flag in `QueryGraphArgs` is optional (`boolean | undefined`), so only `explain = true` triggers this path.

**Advisory:** Using `checkFn.call(db, query, true)` while the non-explain path uses `checkFn(query)` without `.call` is inconsistent. The non-explain path drops `this` context (line 49: `checkFn(query)` without binding). Both happen to work because the actual `checkGuarantee` method uses `this.client` which is captured as a closure in the underlying `RFDBServerBackend`. However, the asymmetry is fragile. In particular, if `db` ever implements `checkGuarantee` as a true method with `this`, the non-explain path at line 49 would break while the explain path at line 44 would work correctly. This is a pre-existing issue in the non-explain path, not introduced by this patch.

---

### `executeRawQuery` + `renderExplainOutput` in `query.ts`

**`executeRawQuery` with `explain = true`:**
- Calls `backend.executeDatalog(query, true)` — routes through the unified Datalog endpoint (not `checkGuarantee`). Correct for CLI raw-query use case.
- If `json`: outputs `JSON.stringify(result, null, 2)` of the `DatalogExplainResult`. Correct.
- If not `json`: calls `renderExplainOutput(result, limit)`. Correct.

**`executeRawQuery` with `explain = undefined` (original path):**
- Falls through to `backend.executeDatalog(query)`. Unchanged. Correct.

**`renderExplainOutput(result, limit)`:**
- Iterates `result.explainSteps`. If empty (explain_mode=false or no steps), the loop body is skipped — output is just stats and bindings. This is safe.
- `result.bindings.slice(0, limit)`: If `result.bindings` is empty, `bindingsToShow.length === 0`, prints "No results." Correct.
- Stats access (`result.stats.nodesVisited`, etc.) — these are always present in the server's `WireExplainResult`. No null-safety issue.

**No step limit in CLI `renderExplainOutput`:** The MCP `formatExplainOutput` caps at `maxSteps = 50`, but the CLI version has no cap — it iterates all steps. For queries with many predicates this could produce verbose output, but it is not incorrect behavior for a CLI diagnostic tool.

---

**Issues found:** None blocking. One advisory: inconsistent `this` binding in `query-handlers.ts` line 49 (pre-existing, not introduced by this patch). One advisory: `TODO` comment at `eval_explain.rs:173` (`rule_eval_time_us: 0, // TODO: track separately`) violates the project's "no TODO in production code" policy.

---

## Uncle Bob — Code Quality Review

**Verdict:** REJECT

**Reason:** `rfdb_server.rs` is 4831 lines and `handle_request` is 722 lines — both massively exceed the project's 500-line file / 50-line method thresholds. The patch adds ~200 lines of structurally duplicated Rust code to this already-oversized file. While the file's size is pre-existing, the patch makes it worse and does not include any step toward addressing it.

---

### File Sizes

| File | Lines | Verdict |
|------|-------|---------|
| `packages/rfdb-server/src/bin/rfdb_server.rs` | 4831 | FAR EXCEEDS 500-line limit |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | 874 | EXCEEDS 500-line limit |
| `packages/cli/src/commands/query.ts` | 1167 | EXCEEDS 500-line limit |
| `packages/rfdb/ts/client.ts` | 1375 | EXCEEDS 500-line limit |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 868 | EXCEEDS 500-line limit |
| `packages/types/src/rfdb.ts` | 569 | Slightly over |
| `packages/mcp/src/handlers/query-handlers.ts` | 286 | OK |

All oversize files are pre-existing problems. The patch adds non-trivial amounts to `rfdb_server.rs` (approx +200 lines), `eval_explain.rs` (+80 lines), `client.ts` (+70 lines), `query.ts` (+55 lines), and `RFDBServerBackend.ts` (+35 lines).

---

### Method Lengths

**`handle_request` in `rfdb_server.rs` (lines 839–1561):** 722 lines. This is a pre-existing monolith. The patch adds 3 new match arms, each ~10 lines. Not significantly worse, but no improvement was made.

**`execute_datalog` in `rfdb_server.rs` (lines 1877–1936):** 59 lines. Exceeds 50-line threshold due to duplication between the explain and non-explain branches. The two branches are nearly identical — the only difference is which evaluator is used and what enum variant is returned. This pattern is repeated identically in `execute_check_guarantee` and `execute_datalog_query`. See **Duplication** below.

**`eval_explain.rs::query` (lines 141–187) and `eval_explain.rs::eval_query` (lines 190–261):** Both methods build the same `bindings_out` conversion, the same `QueryProfile` struct, and the same `QueryResult` return. This is ~30 lines of verbatim duplication between two methods in the same `impl` block. A private `fn finalize_result(&mut self, bindings: Vec<Bindings>) -> QueryResult` would eliminate it.

---

### Duplication

**Rust side — `execute_check_guarantee`, `execute_datalog_query`, `execute_datalog`:** Each function independently has a branch:
```rust
if explain {
    let mut evaluator = EvaluatorExplain::new(engine, true);
    for rule in program.rules() { evaluator.add_rule(rule.clone()); }
    let result = evaluator.query(head);
    Ok(DatalogResponse::Explain(query_result_to_wire_explain(result)))
} else {
    let mut evaluator = Evaluator::new(engine);
    for rule in program.rules() { evaluator.add_rule(rule.clone()); }
    let bindings = evaluator.query(head);
    let results: Vec<WireViolation> = bindings.into_iter().map(|b| { ... }).collect();
    Ok(DatalogResponse::Violations(results))
}
```
This block is structurally identical in all three functions (~40 lines each). A helper function `fn run_with_explain(engine, program, explain, query_atom) -> Result<DatalogResponse, String>` would eliminate the duplication.

**TypeScript side — `client.ts`:** `datalogQuery`, `checkGuarantee`, and `executeDatalog` share identical 8-line explain-response parsing blocks:
```ts
const r = response as unknown as DatalogExplainResult & { requestId?: string };
return { bindings: r.bindings || [], stats: r.stats, profile: r.profile, explainSteps: r.explainSteps || [] };
```
A private `parseExplainResponse(response: RFDBResponse): DatalogExplainResult` helper would remove this.

---

### Naming

- `DatalogResponse` (Rust internal enum) is clear and correct.
- `query_result_to_wire_explain` is descriptive. Acceptable.
- `WireExplainResult`, `WireQueryStats`, `WireQueryProfile`, `WireExplainStep` — consistently named, match existing `Wire*` naming convention. Good.
- `renderExplainOutput` (CLI) and `formatExplainOutput` (MCP) — same responsibility, different names. Minor inconsistency, not blocking.
- The `checkFn` variable name in `query-handlers.ts` is used twice for different types (line 43 and line 48). Two different `const checkFn = ...` in the same function scope — this is acceptable because the second is unreachable when explain is true, but it reads as if there might be a naming conflict. A more specific name like `checkFnExplain` vs `checkFn` would be clearer.

---

### Forbidden Patterns

`eval_explain.rs:173` contains:
```rust
rule_eval_time_us: 0, // TODO: track separately
```
The project's CLAUDE.md explicitly forbids `TODO` in production code. This must be removed before merge. Either implement it or hardcode 0 permanently with no comment.

---

### Patterns — Match Existing Code?

- TypeScript overloads with `explain: true` literal type: follows established patterns in this codebase (e.g., `napi`-adjacent overloads). Good.
- `#[serde(rename_all = "camelCase")]` on all new Wire structs: matches all existing Wire structs. Good.
- `#[serde(default)]` on new `explain` fields in Request enum variants: correct — the field defaults to `false` when absent, preserving backward compatibility with clients that don't send `explain`. Good.
- `DatalogResponse` internal enum in `rfdb_server.rs`: clean separation of internal vs wire types. Matches the existing pattern of not leaking wire types into business logic.

---

### Summary of Issues

| Severity | Location | Issue |
|----------|----------|-------|
| REJECT | `rfdb_server.rs:1877–1936` | `execute_datalog` duplicates the evaluator dispatch pattern 3 times across 3 functions |
| REJECT | `eval_explain.rs:141–261` | `query()` and `eval_query()` duplicate ~30 lines of result-building code |
| REJECT | `client.ts` | Explain-response parsing block duplicated 3 times |
| REJECT | `eval_explain.rs:173` | `TODO` comment forbidden in production code per CLAUDE.md |
| WARN | `rfdb_server.rs` | File grows further beyond 500-line limit with no mitigation |
| WARN | `query-handlers.ts:43,48` | Two `checkFn` bindings with different types in same scope |
