## Uncle Bob — Code Quality Review (v2)

**Verdict:** APPROVE (with one noted technical debt item)

---

### File sizes: CRITICAL issue in one file, rest OK

| File | Lines | Status |
|------|-------|--------|
| `packages/rfdb-server/src/bin/rfdb_server.rs` | 4831 | CRITICAL — 9x over limit |
| `packages/cli/src/commands/query.ts` | 1176 | CRITICAL — 2.3x over limit |
| `packages/rfdb/ts/client.ts` | 1366 | CRITICAL — 2.7x over limit |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 868 | WARNING — 1.7x over limit |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | 843 | WARNING — 1.7x over limit |
| `packages/types/src/rfdb.ts` | 569 | WARNING — just over limit |
| `packages/mcp/src/handlers/query-handlers.ts` | 286 | OK |
| `packages/rfdb-server/src/datalog/tests.rs` | 2104 | test file — different judgment |

**Critical note:** `rfdb_server.rs` at 4831 lines is a pre-existing structural problem, NOT created by this PR. This PR added ~291 lines to a file that was already ~4540 lines. Similarly, `query.ts` (1176) and `client.ts` (1366) are pre-existing over-limit files. The additions in this PR are not the source of these violations — they are adding to existing technical debt.

**The ~291 lines added to rfdb_server.rs by this PR are appropriate for the task.** The file split should be a separate tech debt task. This PR should not be blocked for pre-existing violations it did not create.

---

### Method quality: OK

**eval_explain.rs — methods examined:**

- `eval_query()` (38 lines): Clean conjunction loop pattern matching `eval_rule_body()`. Acceptable.
- `finalize_result()` (37 lines): Builds a `QueryResult` from raw bindings. Not a violation.
- `record_step()` (20 lines, 6 params): Each parameter is a distinct semantic role (`operation`, `predicate`, `args`, `result_count`, `duration`, `details`). Not a candidate for object reduction at this level of abstraction.
- `eval_node()` (74 lines): One over the candidate-for-split threshold. The four arms (`Var/Const`, `Const/Var`, `Const/Const`, `Var/Var`) are a direct mirror of the same method in the non-explain `Evaluator`. The length is inherent in the predicate semantics. Not blocking.
- `eval_edge()` (114 lines): Genuine concern, but mirrors the non-explain evaluator exactly.

**rfdb_server.rs (new methods):**

- `execute_check_guarantee()` (36 lines): Clean if/else on `explain`. OK.
- `execute_datalog_query()` (27 lines): OK.
- `execute_datalog()` (60 lines): The 2x2 branching (program vs direct query, explain vs non-explain) produces four paths. Each individual path is short. Acceptable given inherent branching.
- `query_result_to_wire_explain()` (33 lines): Pure conversion function, no branching. Clean.

**client.ts (new methods):**

- `_parseExplainResponse()` (9 lines): Correctly small, single purpose.
- Three overloaded methods (`datalogQuery`, `checkGuarantee`, `executeDatalog`): each ~10 lines. Clean, same pattern at each endpoint.

**RFDBServerBackend.ts (new methods):**

- Three overloaded methods: each ~12 lines. Same clean pattern.

**query.ts (new functions):**

- `executeRawQuery()` (45 lines): Clean separation of explain vs non-explain path. OK.
- `renderExplainOutput()` (36 lines): Sequential formatting, no branching. OK.

**query-handlers.ts (new functions):**

- `formatExplainOutput()` (45 lines): Formatting function with a few loops. Acceptable.
- Explain path in `handleQueryGraph()`: 5 lines, cleanly separated via early return. Clean.

---

### Patterns and naming: OK

**Naming quality:**
- `DatalogExplainResult` vs `DatalogResult` — clear distinction in types.
- `EvaluatorExplain` — precise, tells you it is the explain-capable variant.
- `explain_mode` / `explain_steps` / `step_counter` — consistent snake_case Rust.
- `_parseExplainResponse` — underscore prefix matches codebase private convention.
- `renderExplainOutput` (CLI) vs `formatExplainOutput` (MCP) — minor naming inconsistency. Both are accurate but diverge slightly.

**Duplication analysis:**

The most notable duplication is the bindings-to-map conversion in `rfdb_server.rs`, which appears 4 times across `execute_check_guarantee`, `execute_datalog_query`, and `execute_datalog`:

```rust
let mut map = std::collections::HashMap::new();
for (k, v) in b.iter() {
    map.insert(k.clone(), v.as_str());
}
WireViolation { bindings: map }
```

This block appears at approximately lines 1820–1826, 1860–1866, 1901–1907, and 1925–1932 — four occurrences. Rule of Three: should be extracted to a helper (`bindings_to_wire_violation`). This is minor tech debt; the pattern was inherited from existing pre-explain code paths and not introduced by this PR.

**Pattern consistency:** The explain overload pattern (`fn foo(args) -> T; fn foo(args, explain: true) -> ExplainResult`) is applied consistently across `IRFDBClient`, `RFDBClient`, and `RFDBServerBackend`. The doc comment "Pass literal `true` for explain — a boolean variable won't narrow the return type" is present on all three interfaces. Well-documented, intentional design.

**Note on zero placeholders in `finalize_result`:**
```rust
rule_eval_time_us: 0, // not yet tracked per-rule
projection_time_us: 0, // not yet tracked
```
These are documentation of current behavior, not TODO-style markers. Acceptable under the project's Forbidden Patterns policy.

---

### Test quality: GOOD

**JS tests (ExplainMode.test.js, 10 tests):**
- `assertExplainShape()` helper avoids duplication — used in 7 of 10 tests. Good DRY.
- Tests grouped by concern: shape, stats, explain steps, bindings format, regressions.
- Regression tests explicitly verify non-explain paths were not broken — this is the most important correctness check.
- `client._client` access (reaching into private state) is a test smell but acceptable for integration-level verification.

**Rust tests (tests.rs, 5 new tests):**
- `test_explain_bindings_match_plain_evaluator` — most valuable test: cross-checks that explain evaluator produces identical results to the non-explain evaluator. Guards against behavioral divergence.
- `test_explain_eval_query_no_explain_empty_steps` — verifies no trace overhead when explain=false.
- `test_explain_stats_populated` — verifies stats are not all zeros after a real query.
- All use the existing `setup_test_graph()` fixture pattern.

---

### Summary

The implementation is clean, consistent, and correctly threads explain mode through all five layers (Rust evaluator → server protocol → TS client → backend → CLI/MCP). Type safety is preserved via literal-`true` overloads. The test coverage is appropriate for the scope.

**Pre-existing violations** (rfdb_server.rs size, query.ts size, client.ts size) are not created by this PR and must not block it.

**Minor items to track as separate tech debt (not blocking):**
1. Extract `bindings_to_wire_violation()` helper in `rfdb_server.rs` — 4-line block duplicated 4 times.
2. `rfdb_server.rs` file split — pre-existing, 4831 lines, needs a dedicated refactor task.
