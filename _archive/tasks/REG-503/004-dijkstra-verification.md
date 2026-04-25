## Dijkstra Plan Verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-18
**Plan verified:** `003-don-plan.md` — Expose Explain Mode through NAPI → Client → MCP → CLI

---

**Verdict:** REJECT

---

## Completeness Tables

### Table 1: Wire Response Variant — All request/explain combinations

| Request type | explain field | Current server returns | Plan says server returns |
|---|---|---|---|
| `CheckGuarantee` | absent (old client) | `Violations { violations }` | `Violations { violations }` — correct |
| `CheckGuarantee` | `false` | currently N/A (no field) | `Violations { violations }` — plan says this |
| `CheckGuarantee` | `true` | currently N/A (no field) | `ExplainResult { results }` |
| `DatalogQuery` | absent | `DatalogResults { results }` | `DatalogResults { results }` — correct |
| `DatalogQuery` | `false` | currently N/A | `DatalogResults { results }` |
| `DatalogQuery` | `true` | currently N/A | `ExplainResult { results }` |
| `ExecuteDatalog` (rules path) | absent | `DatalogResults { results }` | `DatalogResults { results }` — correct |
| `ExecuteDatalog` (rules path) | `false` | currently N/A | `DatalogResults { results }` |
| `ExecuteDatalog` (rules path) | `true` | currently N/A | `ExplainResult { results }` |
| `ExecuteDatalog` (direct query path) | absent | `DatalogResults { results }` | `DatalogResults { results }` — correct |
| `ExecuteDatalog` (direct query path) | `false` | currently N/A | `DatalogResults { results }` |
| `ExecuteDatalog` (direct query path) | `true` | currently N/A | `ExplainResult { results }` |

**Finding:** The plan acknowledges the two internal paths in `execute_datalog` (rules vs direct query) but the implementation description in Step 2d treats it as a single function. The plan says "each handler gets `if explain { ... } else { ... }`" — but `execute_datalog` already has an `if let Ok(program)` branch internally with two distinct code paths, each calling `Evaluator::new`. Each path must independently call `EvaluatorExplain::new` and build the `ExplainResult`. The plan does not show the branching logic for this specific case. **This is a coverage gap, not fatal, but Rob needs explicit guidance.**

### Table 2: JS Client `checkGuarantee` response key

| Path | Server response key | Client reads from | Correct? |
|---|---|---|---|
| Non-explain `CheckGuarantee` | `violations` | `response.violations` (client.ts line 880) | YES |
| Explain `CheckGuarantee` | `results` (new `ExplainResult` variant) | plan says read `response.results` | **YES — but client.ts currently reads `.violations`, plan must update this** |
| Non-explain `DatalogQuery` / `ExecuteDatalog` | `results` | `response.results` (client.ts lines 872, 889) | YES |
| Explain `DatalogQuery` / `ExecuteDatalog` | `results` (new `ExplainResult` variant) | plan says read `response.results` | YES — consistent |

**Finding:** For the explain path of `checkGuarantee`, the plan correctly routes to `response.results` (from `DatalogExplainResponse.results`). The non-explain path continues to use `response.violations`. This is handled in Step 4b where `explain=true` reads `(response as DatalogExplainResponse).results`. This is correct *only if* the server uses `results` as the key in `ExplainResult`, not `violations`. The plan's Rust struct uses `results: Vec<WireExplainResult>` — this is consistent. **No gap here, but implementor must be careful not to accidentally apply the violations key to the explain path.**

### Table 3: TypeScript overload — which signature matches which caller

| Call site | Argument passed | TypeScript resolves to | Return type |
|---|---|---|---|
| `client.datalogQuery(q)` | no second arg | first overload | `Promise<DatalogResult[]>` |
| `client.datalogQuery(q, true)` | literal `true` | second overload | `Promise<DatalogResultWithExplain[]>` |
| `client.datalogQuery(q, false)` | literal `false` | **FIRST overload** (no overload matches `false`) | `Promise<DatalogResult[]>` |
| `client.datalogQuery(q, explain)` where `explain: boolean` | widened `boolean` | **first overload** (no overload matches `boolean`) | `Promise<DatalogResult[]>` |
| `client.datalogQuery(q, explainMode)` where `explainMode: true` | literal type `true` | second overload | `Promise<DatalogResultWithExplain[]>` |

**Finding (Gap 2):** When a caller passes `explain: false` explicitly, TypeScript routes to the first overload and returns `DatalogResult[]`. The runtime implementation sends `explain: false` in the wire payload (the plan's code: `...(explain ? { explain: true } : {})`). When `false`, no `explain` field is sent — the server defaults to `false`. This is fine semantically. However, the behavior when a variable `explain: boolean` (not narrowed to `true`) is used is that TypeScript resolves to the first overload, even if at runtime the value is `true`. **This is a known TypeScript overload limitation**, not a bug in Don's design, but it must be documented as a precondition: callers must pass the literal `true`, not a runtime boolean variable, to get `DatalogResultWithExplain[]`. The plan mentions this in D4 but does not document it as a caller constraint anywhere.

### Table 4: `DatalogResultWithExplain` shape — one row vs full response

This is the most critical table. Let me enumerate the types at each boundary:

| Layer | Type of "bindings" in explain response | Source |
|---|---|---|
| Rust `QueryResult.bindings` | `Vec<HashMap<String, String>>` | `eval_explain.rs:85` |
| Plan's `WireExplainResult.bindings` | `HashMap<String, String>` (one row) | `003-don-plan.md` Step 2c |
| Plan's `DatalogResultWithExplain.bindings` | `DatalogBinding` = `{[key]: string}` (one row) | `003-don-plan.md` Step 1 |
| Rust `ExplainResult.results` (plan) | `Vec<WireExplainResult>` | `003-don-plan.md` Step 2b |
| Plan's `DatalogExplainResponse.results` (TS) | `DatalogResultWithExplain[]` | `003-don-plan.md` Step 1 |

**The plan's design decision:** `QueryResult` from `EvaluatorExplain` is a single object containing all result rows (`bindings: Vec<...>`) plus global stats and explain steps. Don's plan maps this to `WireExplainResult` where **one `WireExplainResult` = one binding row**, and `stats`/`profile`/`explain_steps` are repeated on every row. The server would build `Vec<WireExplainResult>` by iterating over `query_result.bindings` and attaching the same stats/profile/steps to each.

**Gap 3 (Structural correctness issue):** This design means that for a query returning 1000 rows, the explain steps (potentially 50+ step objects) and stats are serialized 1000 times. This is wasteful and potentially hits the MCP response size issue. More importantly, it means explain steps are conceptually "per row" when they are actually "per query". The correct wire shape should be:

```
ExplainResult {
  bindings: Vec<HashMap<String, String>>,  // all rows
  stats: WireQueryStats,                    // once per query
  profile: WireQueryProfile,               // once per query
  explain_steps: Vec<WireExplainStep>,     // once per query
}
```

The plan's shape is:
```
Vec<{
  bindings: HashMap<String, String>,       // one row
  stats: WireQueryStats,                   // repeated N times
  explain_steps: Vec<WireExplainStep>,     // repeated N times
}>
```

Don acknowledges this decision implicitly (D1: "always return the extended type") but the structural consequence — stats/explain repeated per row — is not explicitly called out as intentional. Given that `QueryResult` from Rust is a single object with `bindings: Vec<...>`, the most natural mapping is one-to-one, not exploded per binding. **The implementor (Rob) must be told which shape to use, and the choice must be explicit.**

---

## Gaps Found

### Gap 1: `execute_datalog` two-path coverage not shown in plan

**Location:** Step 2d, `rfdb_server.rs`

**Problem:** The plan says "each handler gets `if explain { ... } else { ... }`" but `execute_datalog` already has an internal `if let Ok(program)` branch. Inside the rules path (lines 1767-1790), there is an `Evaluator::new`, an `add_rule` loop, a `query()` call, and a `Vec<WireViolation>` result. Inside the direct query path (lines 1793-1810), there is a different `Evaluator::new` and `eval_query()` call. Both paths must be independently converted to use `EvaluatorExplain`. The plan does not provide this branching structure. Without it, Rob must infer it — risk of missing one path.

**Required fix:** Step 2d must show the branching logic for `execute_datalog` explicitly:
```
if explain {
  if rules path {
    EvaluatorExplain + query()  → ExplainResult
  } else {
    EvaluatorExplain + eval_query() → ExplainResult  // but EvaluatorExplain may not have eval_query
  }
} else {
  existing code verbatim
}
```

**Additional sub-gap:** The plan assumes `EvaluatorExplain` has `eval_query()`. The exploration confirmed `EvaluatorExplain::query()` exists (line 141 of `eval_explain.rs`) but only inspects `eval_atom`. The direct query path in `execute_datalog` uses `evaluator.eval_query(&literals)` on the old `Evaluator`. Does `EvaluatorExplain` expose `eval_query` or only `query(Atom)`? If not, the explain path for direct query strings needs to construct an `Atom` from the literals — which may not be a trivial conversion. **This must be verified before implementation.**

### Gap 2: TypeScript overload with runtime `boolean` variable (undocumented precondition)

**Location:** Step 1, Step 4 — `IRFDBClient` overloads

**Problem:** The overload `datalogQuery(q, explain: true)` only matches when the literal type `true` is passed. If a caller has `const explain: boolean = getExplainFlag()` and passes it, TypeScript resolves to the first overload and returns `DatalogResult[]`. The actual runtime behavior would still send `explain: true` to the server, and the server would return `ExplainResult`, but the client would try to read `.results` from the wrong path (since it checks `if (explain)` at runtime, it would actually work — but the *return type* would be wrong). **This is a type-safety gap, not a runtime bug in the simplest case**, but callers getting the wrong return type is confusing.

**Required fix:** Document this constraint in a JSDoc comment on the overloads:
```typescript
/** NOTE: `explain` must be the literal `true` for TypeScript to narrow the return type. */
datalogQuery(query: string, explain: true): Promise<DatalogResultWithExplain[]>;
```

### Gap 3: `DatalogResultWithExplain` structure — stats/explain per-row vs per-query

**Location:** Step 1 (TypeScript types), Step 2c (Rust `WireExplainResult`)

**Problem:** The plan places `stats`, `profile`, and `explainSteps` as fields of `DatalogResultWithExplain`, which represents one result row. This means if a query returns 100 rows, the explain steps (per-query information) are present 100 times in the response. This is:
1. Wasteful: for 100 rows x 50 explain steps, 5000 step objects are serialized
2. Semantically wrong: explain steps describe the *query* execution, not individual result rows
3. Inconsistent with Rust's `QueryResult` which is a single top-level object

**The source of truth** (`eval_explain.rs:83-92`) confirms `QueryResult` has:
- `bindings: Vec<HashMap<String, String>>` — all rows
- `stats: QueryStats` — once
- `profile: QueryProfile` — once
- `explain_steps: Vec<ExplainStep>` — once

The correct TypeScript mapping:
```typescript
// This is what the ExplainResult wire response contains — one per query
export interface DatalogExplainResponse extends RFDBResponse {
  bindings: DatalogBinding[];      // all result rows
  stats: QueryStats;               // once per query
  profile: QueryProfile;           // once per query
  explainSteps: ExplainStep[];     // once per query
}
```

And the JS client would return a single `DatalogResultWithExplain` (not an array), or return `DatalogResultWithExplain[]` where the array contains one element. **The plan must decide this and be explicit.**

**Required fix:** Redefine `DatalogResultWithExplain` to hold `bindings: DatalogBinding[]` (all rows) plus top-level stats/explain. Alternatively, keep per-row but strip stats/explain from individual rows and hoist them to a wrapper. Either way, the current plan produces a semantically incorrect and wasteful structure.

### Gap 4: `checkGuarantee` response key divergence across layers

**Location:** Step 4b (JS client), Step 5 (RFDBServerBackend)

**Problem:** The non-explain path of `checkGuarantee` reads `response.violations`. The explain path reads `response.results` (from `DatalogExplainResponse`). These are different keys on the same logical call. The plan handles this in Step 4b with the conditional branch — this is correct. However, the test in Step 4 (`rfdb-client.test.js`) only tests `checkGuarantee(..., true)` (explain path). There is no test asserting that the non-explain path's `violations` key still works after the method is refactored with overloads. **The test plan has a gap: the refactoring could accidentally break the `violations` key reading.**

**Required fix:** Add to Step 4 tests: "checkGuarantee without explain reads from response.violations and returns correct results."

### Gap 5: MCP handler `result.bindings` format mismatch with explain path

**Location:** `query-handlers.ts` lines 71-84, Step 6

**Problem:** The MCP handler reads bindings as an array-of-objects: `result.bindings?.find((b: DatalogBinding) => b.name === 'X')?.value`. This is the `Array<{ name: string; value: string }>` format produced by `RFDBServerBackend.checkGuarantee()` (which converts raw `{X: "foo"}` to `[{name: "X", value: "foo"}]`).

When explain is requested, `DatalogResultWithExplain.bindings` is `DatalogBinding` (the `{[key]: string}` form, NOT converted). The plan (Step 5a) states that explain callers get raw `DatalogBinding` format, not the `[{name, value}]` array. If the MCP handler tries to access `result.bindings.find(...)` on a `DatalogResultWithExplain` result, it will fail because `DatalogBinding` is an object, not an array.

The plan (Step 6) says format the explain output differently — but it shows calling `checkGuarantee(query, true)` and then formatting steps. It does NOT show reading individual node IDs from `result.bindings`. If explain mode needs to enrich results (look up nodes), it needs to access bindings in `{[key]: string}` form (i.e., `result.bindings['X']`), not `result.bindings.find(...)`. This is a type mismatch that will cause a runtime error if not handled.

**Required fix:** Step 6 must explicitly show how bindings are read in explain mode vs non-explain mode. For explain output, node enrichment either uses `bindings['X']` (raw DatalogBinding) or is skipped entirely (since the primary value of explain is the step trace, not node details).

### Gap 6: Stats/profile always shown, explain steps capped — asymmetry undocumented

**Location:** Step 6 (MCP output), Risk R5

**Problem:** The plan says cap explain steps to 50 with "... N more" indicator. But stats and profile are always shown. For a query with 200 explain steps where steps 51-200 are hidden, the `stats.totalResults` and `profile.totalDurationUs` still reflect the full execution. This is correct behavior, but the asymmetry (steps capped, stats not capped) is not explicitly stated. Additionally, the plan does not say whether `stats` are always shown (even with `explain=false`) — the plan's D1 says "when `explain=false`, `explainSteps` is empty and `stats`/`profile` have all-zero fields." This means stats ARE present even without explain. But the non-explain path returns `Violations`/`DatalogResults` variants (not `ExplainResult`), so stats are NOT present on non-explain responses. This contradicts D1.

**Required fix:** Clarify D1: "always return extended type" was rejected in favor of D2 (new variant only when explain=true). D1 and D2 are now mutually exclusive. D2 wins (per the plan text). The statement in D1 that "when explain=false, stats have all-zero fields" is dead code — the non-explain path never returns stats. Remove or correct D1's statement.

---

## Precondition Issues

### P1: Does `EvaluatorExplain` have `eval_query`?

The direct-query path in `execute_datalog` calls `evaluator.eval_query(&literals)` on the old `Evaluator`. The plan assumes `EvaluatorExplain` can be a drop-in replacement. Reading `eval_explain.rs`, `EvaluatorExplain` exposes only `query(&Atom)` as its public entry point. It does NOT expose `eval_query` (which takes a slice of `Literal` / `Atom` directly).

**This precondition is unverified by the plan.** If `EvaluatorExplain` does not expose `eval_query`, the explain path for direct queries requires either: (a) parsing the query into a conjunction Atom and calling `query()`, or (b) adding `eval_query` to `EvaluatorExplain`. The plan does not account for this.

### P2: `#[serde(default)]` on msgpack — behavior verified for JSON, not msgpack

The plan states that `#[serde(default)]` means old clients omitting `explain` get `false`. This is true for JSON. The wire format is msgpack (the client uses `@msgpack/msgpack`). Serde's `#[serde(default)]` applies to ALL serde-compatible formats, including msgpack via `rmp-serde`. This is correct.

**However:** msgpack encodes missing fields differently from JSON. In msgpack, a field is simply absent from the map. `#[serde(default)]` with `rmp-serde` correctly handles absent fields by applying the Rust `Default` trait. For `bool`, `Default::default()` is `false`. **This precondition holds.**

### P3: The `DatalogExplainResponse` extends `RFDBResponse` — but JS client does not use typed responses

The plan defines `DatalogExplainResponse extends RFDBResponse`. However, the JS client (`client.ts`) receives responses as generic `RFDBResponse` from the socket (`decode(msgBytes) as RFDBResponse`), then casts at the use site. The `extends RFDBResponse` inheritance is a TypeScript type-level claim; it does not enforce anything at runtime. The client checks `if (explain)` to decide which cast to apply. **This is fine — it's consistent with existing client patterns.** No gap.

### P4: `execute_datalog` rules path — `evaluator.query(head)` vs `EvaluatorExplain.query`

The rules path of `execute_datalog` calls `evaluator.query(head)` where `head` is `program.rules()[0].head()` (an `Atom`). `EvaluatorExplain::query` also takes `&Atom` — this signature matches. The `add_rule` loop also exists on `EvaluatorExplain` (line 128 of `eval_explain.rs`). **This precondition holds for the rules path.**

---

## Summary of Gaps Requiring Action

| # | Gap | Severity | Required Action |
|---|---|---|---|
| 1 | `execute_datalog` two-path coverage + `eval_query` availability on `EvaluatorExplain` | HIGH | Plan must explicitly address both internal paths; implementor must verify `eval_query` exists or how to handle it |
| 2 | TypeScript overload with runtime `boolean` variable | LOW | Add JSDoc comment; document precondition |
| 3 | `DatalogResultWithExplain` per-row vs per-query structure — stats/explain repeated N times | HIGH | Redesign the wire struct to put stats/explain at query level, not row level |
| 4 | Missing test: `checkGuarantee` non-explain path still reads `violations` after refactor | MEDIUM | Add regression test to Step 4 |
| 5 | MCP handler `result.bindings.find(...)` fails on `DatalogBinding` object in explain path | HIGH | Step 6 must show explicit binding access pattern for explain path |
| 6 | D1 contradicts D2 — stats presence on non-explain path | LOW | Remove incorrect statement from D1 |

**Gaps 1, 3, and 5 are blocking. The plan cannot be implemented correctly without resolving them.**

Gap 1 requires verifying whether `EvaluatorExplain` exposes an `eval_query` method or only `query(Atom)`. If not, the plan for the `ExecuteDatalog` direct-query path is incomplete.

Gap 3 requires a structural redesign of the wire format and TypeScript types — the current plan produces a semantically incorrect response where per-query information is duplicated per result row.

Gap 5 requires explicit guidance on how the MCP handler accesses bindings in explain mode, since `DatalogResultWithExplain.bindings` is `DatalogBinding` (object), not the array-of-objects form that the existing handler code uses.
