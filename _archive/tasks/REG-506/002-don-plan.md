# Don Melton — Tech Lead Plan: REG-506 Datalog Slow Query Warnings

## Executive Summary

Straightforward additive feature. No architectural conflicts. All the infrastructure exists — warnings slot cleanly into `QueryResult` and flow through the established pipeline: `eval_explain.rs` → `WireExplainResult` → TypeScript `DatalogExplainResult` → CLI `renderExplainOutput`.

---

## Design Decisions

### 1. Both evaluators or just explain?

**Decision: Add warnings to `QueryResult` only (explain evaluator path). Basic `Evaluator` stays unchanged.**

Rationale:
- AC #4 says "warnings available in explain mode response" — this is the scope
- AC #5 says "CLI outputs warnings in stderr" — CLI already uses `executeDatalog(query, true)` when `--explain` is passed
- Changing basic `Evaluator` return type (`Vec<Bindings>` → new struct) would ripple through all callers: `execute_check_guarantee`, test code, everywhere. Disproportionate cost for zero user benefit (non-explain path shows no stats anyway)
- `all_edges_calls > 0` is already tracked in `QueryStats`. Users who care about performance use `--explain`

**Not option (b):** Always routing through `EvaluatorExplain` internally to get warnings on non-explain queries introduces silent overhead and complexity with no AC requirement. Scope creep.

### 2. Where to store warnings?

**Decision: Add `warnings: Vec<String>` directly to `QueryResult` (not in `QueryStats`).**

Rationale:
- `QueryStats` is a metrics bag (counts, timers). Warnings are user-facing diagnostic messages — different semantic layer.
- `QueryResult` already owns the top-level response shape. Adding `warnings` there mirrors the AC language: "QueryStats/QueryProfile includes `warnings`" is slightly loose — the AC says it should be in the explain response, not specifically in stats.
- Cleaner: `result.warnings` vs `result.stats.warnings`
- Wire format consequence: `WireExplainResult` gets a `warnings: Vec<String>` field. TypeScript `DatalogExplainResult` gets `warnings: string[]`. Direct and obvious.

### 3. Detection mechanism: pattern-based or threshold-based?

**Decision: Pattern-based detection at eval time, not threshold-based.**

Rationale:
- AC says: "Warning on `node(X, Y)` with both variables" — this is a structural pattern, not a count check
- Pattern detection happens once at the top of `eval_node`/`eval_edge` when we enter the `(Var, Var)` / unbound-source branch. Zero overhead — we're already branching on Term types
- Threshold-based (warn if result > 1000) is a weaker signal: a full scan over a small graph shouldn't warn; a full scan over a large graph with 0 results definitely should warn. Threshold creates false negatives and false positives
- The issue notes say "Threshold: warn if result > 1000" — but this contradicts the AC which specifies structural pattern detection. AC wins. The issue note was a suggestion, not a requirement
- Edge case: if both vars are bound by prior literals (substitution), they become `Const` before reaching `eval_node`. Substitution happens in `substitute_atom` before `eval_atom` is called. So by the time we check Term types, unbound vars are genuinely unbound. No false positives from substituted queries.

### 4. What about `incoming` and `path`?

**Decision: Warn on `incoming(X, ...)` with unbound destination only (currently returns `vec![]`). Do NOT warn on `path`.**

Looking at the code:
- `eval_incoming` with `Term::Var(_var)` for destination currently returns `vec![]` silently — it's a silent no-op. This is a different problem (it should either work or error, not silently return nothing). Out of scope for this task.
- `eval_path` with unbound source returns `vec![]` (no match arm for `(Var, ...)`) — same issue, different problem.
- `path(X, "dst")` with bound destination does BFS from a specific node to depth 100. This is potentially expensive but it's the intended use — warning here would be noise.

Scope: warn only on the two patterns named in AC. `incoming` and `path` edge cases stay out of scope, tracked separately if needed.

---

## High-Level Plan

### Layer 1: Rust — `eval_explain.rs`

Add `warnings: Vec<String>` to `QueryResult`. Collect warnings during evaluation:

1. `QueryResult` struct: add `pub warnings: Vec<String>`
2. `EvaluatorExplain` struct: add `warnings: Vec<String>` field (reset in `query()`/`eval_query()`)
3. `eval_node()`: in the `(Var(id_var), Var(type_var))` arm, push warning before iterating
4. `eval_edge()`: in the `Term::Var(src_var)` arm, push warning before calling `get_all_edges()`
5. `finalize_result()`: move `self.warnings` into `QueryResult`

Warning messages (exact strings per AC):
- node full scan: `"Full node scan: consider binding type"`
- edge full scan: `"Full edge scan: consider binding source node"`

### Layer 2: Rust — `rfdb_server.rs`

1. `WireExplainResult`: add `pub warnings: Vec<String>`
2. `query_result_to_wire_explain()`: map `result.warnings` to wire struct

### Layer 3: TypeScript — `packages/types/src/rfdb.ts`

1. `DatalogExplainResult`: add `warnings: string[]`

### Layer 4: TypeScript — `packages/core/src/storage/backends/RFDBServerBackend.ts`

No changes needed. The `client.executeDatalog(source, true)` call returns the wire JSON directly. As long as `DatalogExplainResult` has `warnings`, the field comes through automatically (JSON deserialization). Verify this assumption — if the client applies field mapping, add `warnings` there.

### Layer 5: TypeScript — `packages/cli/src/commands/query.ts`

In `renderExplainOutput()`: after printing stats, if `result.warnings.length > 0`, print each warning to `process.stderr`.

```
Warnings:
  Full node scan: consider binding type
```

---

## Order of Changes

1. Rust: `eval_explain.rs` — add `warnings` field and detection logic
2. Rust: `rfdb_server.rs` — add `warnings` to wire format and conversion
3. TypeScript: `types/src/rfdb.ts` — extend `DatalogExplainResult`
4. TypeScript: `cli/src/commands/query.ts` — render warnings in `renderExplainOutput()`
5. Tests: Rust unit tests in `tests.rs` for warning generation; TypeScript integration test if applicable

---

## Risk Assessment

**Low risk overall.**

- Additive only — no existing behavior changes
- `QueryResult` is only constructed in one place (`finalize_result`) and consumed in one place (`query_result_to_wire_explain`). Scope is tight.
- The `#[serde(rename_all = "camelCase")]` on `WireExplainResult` means `warnings` will serialize as `warnings` (already camelCase). TypeScript field name matches. No renaming needed.
- One gotcha: `WireExplainResult` derives `Serialize` but not `Deserialize`. Safe — it's outbound only.
- TypeScript `DatalogExplainResult` is used in `renderExplainOutput` and `json` output path. Both are additive — existing code won't break if `warnings` is an empty array.

**Potential issue:** Check if the RFDB client in `RFDBServerBackend.ts` does explicit field mapping when deserializing explain results. If it does, `warnings` needs to be added there. Quick grep of the client code will confirm.

---

## Scope Boundaries — What NOT to Do

- Do NOT add warnings to basic `Evaluator` (eval.rs) — return type change not worth it
- Do NOT warn on `path()` patterns — intended use
- Do NOT warn on `incoming(X, ...)` unbound destination — it silently returns empty already, separate problem
- Do NOT use threshold-based detection — structural pattern detection is correct
- Do NOT add warnings to `QueryStats` — wrong semantic layer
- Do NOT change any behavior, only add observability
- Do NOT add warnings for the non-explain CLI path — not in AC

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Add `warnings` field to `QueryResult` and `EvaluatorExplain`; detection logic in `eval_node`/`eval_edge` |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Add `warnings` to `WireExplainResult`; update `query_result_to_wire_explain` |
| `packages/types/src/rfdb.ts` | Add `warnings: string[]` to `DatalogExplainResult` |
| `packages/cli/src/commands/query.ts` | Print warnings to stderr in `renderExplainOutput` |
| `packages/rfdb-server/src/datalog/tests.rs` | Add tests for warning generation |

Check (read-only): `packages/core/src/storage/backends/RFDBServerBackend.ts` — verify client does not need explicit `warnings` field mapping.
