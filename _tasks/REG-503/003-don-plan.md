# REG-503: Implementation Plan — Expose Explain Mode Through NAPI → Client → MCP → CLI

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-18
**Based on:** `002-don-exploration.md`

---

## Overview

The Datalog explain infrastructure is fully implemented in Rust (`EvaluatorExplain`) and wired
through `engine_worker.rs`. Six layers above it are unaware of explain: the socket protocol,
the JS client (`packages/rfdb`), `RFDBServerBackend`, the MCP handler, and the CLI. The NAPI
path is a lower-priority legacy concern.

Implementation proceeds **bottom-up**: Rust socket protocol → JS client → Backend → MCP → CLI.
At each layer: write tests first, then implement.

---

## Design Decisions

### D1: Return Type Strategy — Conditional vs Always-Extended

**Decision: Always return the extended type, with optional/nullable explain fields.**

**Rationale:**
- If `explain=false`, the server returns `stats`, `profile`, `explainSteps` as absent fields
  (or zeroed). The response type is always `DatalogResultWithExplain`.
- Avoids two different TypeScript return types that callers must discriminate with `instanceof`
  or conditional checks.
- Backward-compatible at the *value* level: when `explain=false`, `explainSteps` is an empty
  array and `stats` / `profile` have all-zero fields. Callers that only use `.bindings` still
  work without changes.
- The alternative (union return type `DatalogResult | DatalogResultWithExplain`) forces
  type-narrowing boilerplate at every call site and is strictly worse.

### D2: Wire Format — Extend Existing Responses vs New Response Variant

**Decision: Add a new response variant `ExplainResult` in `rfdb_server.rs` and keep
`Violations` / `DatalogResults` unchanged.**

**Rationale:**
- Adding fields to `WireViolation` changes what existing clients see on every response, even
  when explain is not requested. That is a larger surface area change.
- A dedicated `ExplainResult` variant is returned **only when `explain: true`** in the request.
  When `explain: false` (the default), the server returns the existing `Violations` /
  `DatalogResults` variants — zero protocol change for non-explain calls.
- The JS client inspects the response variant tag and handles both. Old clients that don't
  send `explain` never receive `ExplainResult`, so they are not affected.

### D3: TypeScript Types Location

**Decision: Add `QueryStats`, `QueryProfile`, `ExplainStep`, and `DatalogResultWithExplain`
to `packages/types/src/rfdb.ts`.**

**Rationale:**
- `rfdb.ts` already owns `DatalogResult`, `IRFDBClient`, and all protocol types.
- These types are needed by at least three packages: `rfdb` (client), `core` (backend),
  `mcp` (handler). Putting them in `packages/types` avoids circular imports.
- Naming follows the existing `DatalogResult` convention.

### D4: `IRFDBClient` Interface Update Strategy

**Decision: Add overloads — keep the existing `(source: string): Promise<DatalogResult[]>`
signature and add `(source: string, explain: true): Promise<DatalogResultWithExplain[]>`.**

**Rationale:**
- TypeScript function overloads allow the existing return type to remain when `explain` is
  absent or `false`. This means ALL existing callers that don't pass `explain` continue to
  compile without changes.
- When `explain: true` is explicitly passed, TypeScript narrows the return type to
  `DatalogResultWithExplain[]`, giving callers access to `stats`, `profile`, `explainSteps`.
- Implementation in `RFDBClient` class uses a single method body with the overloads as
  declaration-only signatures.

### D5: NAPI Bindings Priority

**Decision: NAPI bindings (`napi_bindings.rs`) are out of scope for this task.**

**Rationale:**
- The production path goes through the socket protocol. NAPI bindings are used only in
  legacy or test contexts.
- The exploration report confirms: napi_bindings.rs uses old `Evaluator`, not `EvaluatorExplain`.
  Changing the return type from `Vec<JsDatalogResult>` to a richer type IS a breaking change
  for any direct NAPI callers.
- Deferring NAPI to a follow-up task (REG-504 or similar) keeps this PR focused.

### D6: `rule_eval_time_us` and `projection_time_us` Known Limitation

**Decision: Expose these fields with their current values (always 0), document in CLI output.**

**Rationale:**
- The exploration report confirms `eval_explain.rs` line 173 has `// TODO: track separately`.
  The issue description acknowledges this.
- Zero values are correct — they don't lie, they just don't provide data yet.
- The CLI `--explain` output should note "(not yet tracked)" next to these fields.
- No Rust changes needed for this; it's a display concern only.

---

## Implementation Steps

### Step 1: TypeScript Types in `packages/types`

**File:** `/Users/vadimr/grafema-worker-1/packages/types/src/rfdb.ts`

**What changes:**
- Add `QueryStats` interface (mirrors Rust `QueryStats` struct)
- Add `QueryProfile` interface (mirrors Rust `QueryProfile` struct)
- Add `ExplainStep` interface (mirrors Rust `ExplainStep` struct)
- Add `DatalogResultWithExplain` interface extending `DatalogResult`
- Add `DatalogExplainResponse` interface for the wire-level response
- Update `IRFDBClient` Datalog method signatures with overloads

**Approximate LOC:** ~60 lines added to `rfdb.ts`

**Tests:** None needed — pure type declarations. Compile errors catch mistakes.

**New interfaces to add (section after existing `DatalogResult`):**

```typescript
export interface QueryStats {
  nodesVisited: number;
  edgesTraversed: number;
  findByTypeCalls: number;
  getNodeCalls: number;
  outgoingEdgeCalls: number;
  incomingEdgeCalls: number;
  allEdgesCalls: number;
  bfsCalls: number;
  totalResults: number;
  ruleEvaluations: number;
  intermediateCounts: number[];
}

export interface QueryProfile {
  totalDurationUs: number;
  predicateTimes: Record<string, number>;
  ruleEvalTimeUs: number;       // always 0 — not yet tracked
  projectionTimeUs: number;     // always 0 — not yet tracked
}

export interface ExplainStep {
  step: number;
  operation: string;
  predicate: string;
  args: string[];
  resultCount: number;
  durationUs: number;
  details: string | null;
}

export interface DatalogResultWithExplain {
  bindings: DatalogBinding;
  stats: QueryStats;
  profile: QueryProfile;
  explainSteps: ExplainStep[];
}

// Wire-level response when explain=true
export interface DatalogExplainResponse extends RFDBResponse {
  results: DatalogResultWithExplain[];
}
```

**IRFDBClient overloads (replace existing `datalogQuery`, `checkGuarantee`, `executeDatalog`):**

```typescript
datalogQuery(query: string): Promise<DatalogResult[]>;
datalogQuery(query: string, explain: true): Promise<DatalogResultWithExplain[]>;

checkGuarantee(ruleSource: string): Promise<DatalogResult[]>;
checkGuarantee(ruleSource: string, explain: true): Promise<DatalogResultWithExplain[]>;

executeDatalog(source: string): Promise<DatalogResult[]>;
executeDatalog(source: string, explain: true): Promise<DatalogResultWithExplain[]>;
```

---

### Step 2: Rust Socket Protocol — `rfdb_server.rs`

**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/bin/rfdb_server.rs`

**What changes:**

**2a. Request variants — add `explain: bool` with serde default=false:**

```rust
CheckGuarantee {
    #[serde(rename = "ruleSource")]
    rule_source: String,
    #[serde(default)]
    explain: bool,
},
DatalogQuery {
    query: String,
    #[serde(default)]
    explain: bool,
},
ExecuteDatalog {
    source: String,
    #[serde(default)]
    explain: bool,
},
```

The `#[serde(default)]` means old clients that omit `explain` get `false` automatically.
`DatalogLoadRules` and `DatalogClearRules` do not need `explain` (no query execution).

**2b. New response variant `ExplainResult`:**

Add after existing `DatalogResults` variant:

```rust
ExplainResult {
    results: Vec<WireExplainResult>,
},
```

**2c. New wire struct `WireExplainResult`:**

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExplainResult {
    pub bindings: HashMap<String, String>,
    pub stats: WireQueryStats,
    pub profile: WireQueryProfile,
    pub explain_steps: Vec<WireExplainStep>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQueryStats {
    pub nodes_visited: usize,
    pub edges_traversed: usize,
    pub find_by_type_calls: usize,
    pub get_node_calls: usize,
    pub outgoing_edge_calls: usize,
    pub incoming_edge_calls: usize,
    pub all_edges_calls: usize,
    pub bfs_calls: usize,
    pub total_results: usize,
    pub rule_evaluations: usize,
    pub intermediate_counts: Vec<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQueryProfile {
    pub total_duration_us: u64,
    pub predicate_times: HashMap<String, u64>,
    pub rule_eval_time_us: u64,
    pub projection_time_us: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExplainStep {
    pub step: usize,
    pub operation: String,
    pub predicate: String,
    pub args: Vec<String>,
    pub result_count: usize,
    pub duration_us: u64,
    pub details: Option<String>,
}
```

**2d. Update handler functions:**

`execute_check_guarantee`, `execute_datalog_query`, and `execute_datalog` all need `explain: bool`
parameter. When `explain=true`, call `EvaluatorExplain::new(engine, true)` and return a
`QueryResult`. When `explain=false`, keep the existing path (use `Evaluator`, return
`Vec<WireViolation>`). The call sites (the big match arm dispatcher) branch on `explain` to
choose which response variant to build.

Alternatively: always use `EvaluatorExplain::new(engine, explain)` — when `explain=false`,
`EvaluatorExplain` still works correctly and produces an empty `explain_steps` vec. But this
changes what's returned on every non-explain call (adds the stats/profile fields). Per D2,
this is NOT what we want — non-explain calls must return the unchanged `Violations` /
`DatalogResults` variants.

**Therefore:** the handlers get a signature change and an `if explain { ... } else { ... }`
branch in each. The else-branch is the existing code verbatim.

**Approximate LOC:** ~120 lines (new structs ~60, handler changes ~60)

**Tests:**

Add to `packages/rfdb-server/src/bin/rfdb_server.rs` integration test section (or a new
`tests/socket_protocol_explain.rs`):

- `test_check_guarantee_without_explain` — sends request without `explain` field, asserts
  response is `Violations` variant (not `ExplainResult`)
- `test_check_guarantee_with_explain_false` — sends `explain: false` explicitly, same assertion
- `test_check_guarantee_with_explain_true` — sends `explain: true`, asserts response is
  `ExplainResult` with `explainSteps.length > 0` and `stats.nodesVisited >= 0`
- `test_execute_datalog_with_explain` — same pattern for `ExecuteDatalog`

These tests use the existing server test harness pattern from the rfdb-client scenario tests.

---

### Step 3: Rust Tests for `EvaluatorExplain`

**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/datalog/tests.rs`

**What changes:**

Add a new test module `eval_explain_tests` using the existing `setup_test_graph()` helper.

Tests to add:
- `test_explain_mode_produces_steps` — `EvaluatorExplain::new(&engine, true)`, query a known
  predicate, assert `result.explain_steps` is non-empty and first step has `step == 1`
- `test_no_explain_mode_empty_steps` — `EvaluatorExplain::new(&engine, false)`, query same
  predicate, assert `result.explain_steps.is_empty()`
- `test_stats_nodes_visited_nonzero` — after a `type(X, "FUNCTION")` query, assert
  `result.stats.nodes_visited > 0`
- `test_profile_total_duration_nonzero` — assert `result.profile.total_duration_us > 0`
- `test_bindings_match_plain_evaluator` — run same query with `Evaluator` and
  `EvaluatorExplain`, assert same binding sets

**Approximate LOC:** ~80 lines

**Note:** These tests run against `dist/` via `cargo test`, not `node --test`. They lock
`EvaluatorExplain` behavior before any protocol wiring is touched.

---

### Step 4: JS Client — `packages/rfdb/ts/client.ts`

**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb/ts/client.ts`

**What changes:**

**4a. Import new types:**

```typescript
import type {
  // ... existing imports ...
  DatalogResultWithExplain,
  DatalogExplainResponse,
  ExplainStep,
  QueryStats,
  QueryProfile,
} from '@grafema/types';
```

**4b. Update `datalogQuery` with overloads:**

```typescript
async datalogQuery(query: string): Promise<DatalogResult[]>;
async datalogQuery(query: string, explain: true): Promise<DatalogResultWithExplain[]>;
async datalogQuery(query: string, explain?: boolean): Promise<DatalogResult[] | DatalogResultWithExplain[]> {
  const response = await this._send('datalogQuery', { query, ...(explain ? { explain: true } : {}) });
  if (explain) {
    return (response as DatalogExplainResponse).results || [];
  }
  return (response as { results?: DatalogResult[] }).results || [];
}
```

Same pattern for `checkGuarantee` (note: response key is `violations` for non-explain, but
the server should use `results` for `ExplainResult` — need to verify this matches server-side
naming in Step 2) and `executeDatalog`.

**Important:** The `_send` method accepts `Record<string, unknown>` as payload, so passing
`explain: true` in the payload object works without any changes to `_send`.

**4c. Update `IRFDBClient` implementation** to match the overloaded signatures declared in
`packages/types/src/rfdb.ts` (Step 1).

**Approximate LOC:** ~40 lines changed/added

**Tests:**

Add to `test/scenarios/rfdb-client.test.js`:
- `test: 'checkGuarantee with explain=true returns explainSteps'` — requires running rfdb-server,
  calls `client.checkGuarantee(ruleSource, true)`, asserts `result[0].explainSteps.length > 0`
- `test: 'checkGuarantee without explain returns plain DatalogResult'` — calls
  `client.checkGuarantee(ruleSource)`, asserts result has `bindings` but no `explainSteps`
- `test: 'executeDatalog with explain=true returns stats'` — asserts
  `result[0].stats.nodesVisited >= 0`

These tests are integration tests that require a live server — they follow the existing pattern
in `rfdb-client.test.js` (start server in `before`, stop in `after`).

---

### Step 5: `RFDBServerBackend.ts` — Backend Layer

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/storage/backends/RFDBServerBackend.ts`

**What changes:**

**5a. Import new types:**

```typescript
import type {
  // ... existing ...
  DatalogResultWithExplain,
  QueryStats,
  ExplainStep,
} from '@grafema/types';
```

**5b. Update method signatures with overloads:**

```typescript
async checkGuarantee(ruleSource: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>;
async checkGuarantee(ruleSource: string, explain: true): Promise<DatalogResultWithExplain[]>;
async checkGuarantee(ruleSource: string, explain?: boolean): Promise<...> {
  if (!this.client) throw new Error('Not connected');
  if (explain) {
    return await this.client.checkGuarantee(ruleSource, true);
    // DatalogResultWithExplain already has bindings as DatalogBinding ({[key]: string})
    // The conversion to [{name, value}] format is NOT needed here — explain callers
    // use the raw DatalogBinding format, consistent with DatalogResultWithExplain
  }
  const violations = await this.client.checkGuarantee(ruleSource);
  return violations.map(v => ({
    bindings: Object.entries(v.bindings).map(([name, value]) => ({ name, value }))
  }));
}
```

Same pattern for `datalogQuery` and `executeDatalog`.

**Note on binding format discrepancy:** The existing backend converts `{X: "foo"}` to
`[{name: "X", value: "foo"}]`. This conversion was added for compatibility with the MCP
handler's `DatalogBinding` type. When `explain=true`, the MCP handler will receive
`DatalogResultWithExplain` with raw `{[key]: string}` bindings — which is what `DatalogBinding`
is. This is consistent.

**Approximate LOC:** ~30 lines changed

**Tests:**

File: `test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js` (or new file)

- `test: 'checkGuarantee passes explain=true to client'` — mock `this.client`, assert that
  when `checkGuarantee(source, true)` is called, `client.checkGuarantee(source, true)` is
  called and result is passed through
- `test: 'checkGuarantee without explain uses existing format'` — existing tests should pass
  unchanged (backward compat)

---

### Step 6: MCP Handler — `packages/mcp/src/handlers/query-handlers.ts`

**File:** `/Users/vadimr/grafema-worker-1/packages/mcp/src/handlers/query-handlers.ts`

**What changes:**

**6a. Use `_explain` (currently unused):**

```typescript
const { query, limit: requestedLimit, offset: requestedOffset, format: _format, explain } = args;
```

Remove the `_` prefix from `explain`.

**6b. Branch on `explain` in the handler:**

When `explain=true`, call `checkGuarantee(query, true)` via the cast. Format and return the
explain output. When `explain=false` or absent, existing logic is unchanged.

**6c. Update the cast type:**

The current cast is:
```typescript
const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<...> }).checkGuarantee;
```

This becomes typed to accept the `explain` overload. One clean approach: instead of the cast,
check for the explain-capable method signature. But since the cast is already an escape hatch,
the simplest fix is to widen the cast type:

```typescript
type CheckGuaranteeFn = {
  (q: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>;
  (q: string, explain: true): Promise<DatalogResultWithExplain[]>;
};
const checkFn = (db as unknown as { checkGuarantee: CheckGuaranteeFn }).checkGuarantee;
```

**6d. Explain output formatting:**

When `explain=true` and results come back with `explainSteps`:

```
Explain: query returned N result(s).

Step-by-step execution:
  1. [type] type(X, "FUNCTION") → 42 results (123 µs)
  2. [attr] attr(X, "name", "main") → 1 result (12 µs)

Statistics:
  Nodes visited:    42
  Edges traversed:  0
  Total results:    1
  Duration:         135 µs
```

This is text output returned via `textResult()`. The format prioritizes LLM readability — the
primary consumer is an AI agent debugging empty query results.

**Zero-results + explain case:** When the query returns no results AND explain was requested,
the explain steps show *where the funnel dropped to zero* — this is the primary use case from
the issue description. The MCP handler should show explain output even when result count is 0.

**Approximate LOC:** ~50 lines changed/added

**Tests:**

File: `test/unit/` (new file: `test/unit/mcp/query-handlers-explain.test.js`)

- `test: 'handleQueryGraph with explain=true passes explain to checkGuarantee'` — mock the `db`
  object, assert `checkGuarantee` called with `(query, true)`
- `test: 'handleQueryGraph with explain=true formats explain steps in output'` — mock db
  returning a `DatalogResultWithExplain`, assert output text contains "Step-by-step execution"
- `test: 'handleQueryGraph without explain uses existing path'` — existing tests pass unchanged

---

### Step 7: CLI — `packages/cli/src/commands/query.ts`

**File:** `/Users/vadimr/grafema-worker-1/packages/cli/src/commands/query.ts`

**What changes:**

**7a. Add `--explain` flag:**

Add to the `queryCommand` options (after `--raw`):

```typescript
.option(
  '--explain',
  `Show step-by-step query execution (use with --raw).

Displays each predicate evaluation, result counts, and timing.
Useful when a query returns no results — shows where the funnel drops to zero.

Example:
  grafema query --raw 'type(X, "FUNCTION"), attr(X, "name", "main")' --explain`
)
```

**7b. Update `QueryOptions` type:**

```typescript
interface QueryOptions {
  project: string;
  json: boolean;
  limit: string;
  raw: boolean;
  type?: string;
  explain?: boolean;  // add this
}
```

**7c. Update `executeRawQuery` signature:**

```typescript
async function executeRawQuery(
  backend: RFDBServerBackend,
  query: string,
  limit: number,
  json?: boolean,
  explain?: boolean
): Promise<void>
```

**7d. Pass `explain` to `backend.executeDatalog`:**

```typescript
const results = explain
  ? await backend.executeDatalog(query, true)
  : await backend.executeDatalog(query);
```

**7e. Render explain output:**

When `explain=true`, render steps, stats, and profile before/after the results:

```
Explain mode — step-by-step execution:

  Step 1: [type] type(X, "FUNCTION")
          → 42 results in 123 µs

  Step 2: [attr] attr(X, "name", "main")
          → 1 result in 12 µs

Query statistics:
  Nodes visited:    42
  Edges traversed:  0
  Rule evaluations: 0
  Total results:    1
  Total duration:   135 µs
  (rule_eval_time and projection_time: not yet tracked)

Results (1):
  { X=<node-id> }
```

**7f. Guard: `--explain` without `--raw` prints a warning and falls back to normal mode.**

The `--explain` flag only makes sense with `--raw`. If `--raw` is absent, warn:
```
Note: --explain requires --raw. Ignoring --explain.
```

**Approximate LOC:** ~70 lines changed/added

**Tests:**

File: `test/unit/commands/` (new file `query-explain.test.js`)

- `test: '--explain flag is accepted'` — parse CLI options, assert `options.explain === true`
- `test: 'executeRawQuery with explain renders steps'` — mock `backend.executeDatalog` to return
  a `DatalogResultWithExplain[]`, capture `console.log` output, assert it contains
  "Step-by-step execution" and "Query statistics"
- `test: '--explain without --raw prints warning'` — assert warning message appears

---

## File Summary

| # | File | Change Type | Approx LOC |
|---|------|-------------|-----------|
| 1 | `packages/types/src/rfdb.ts` | Add interfaces + overloads | +60 |
| 2 | `packages/rfdb-server/src/bin/rfdb_server.rs` | Add structs + protocol fields + handler branches | +120 |
| 3 | `packages/rfdb-server/src/datalog/tests.rs` | New test module | +80 |
| 4 | `packages/rfdb/ts/client.ts` | Add overloads + explain branch | +40 |
| 5 | `packages/core/src/storage/backends/RFDBServerBackend.ts` | Add overloads + explain pass-through | +30 |
| 6 | `packages/mcp/src/handlers/query-handlers.ts` | Use explain, format output | +50 |
| 7 | `packages/cli/src/commands/query.ts` | Add flag, render explain | +70 |
| 8 | `test/scenarios/rfdb-client.test.js` | New test cases | +40 |
| 9 | `test/unit/mcp/query-handlers-explain.test.js` | New test file | +60 |
| 10 | `test/unit/commands/query-explain.test.js` | New test file | +50 |
| **Total** | | | **~600 LOC** |

---

## Test Strategy Per Layer

| Layer | Test Type | File | Key Assertions |
|-------|-----------|------|----------------|
| Rust `EvaluatorExplain` | Unit (cargo test) | `src/datalog/tests.rs` | steps non-empty, stats.nodesVisited > 0, bindings match plain evaluator |
| Socket protocol | Integration (cargo test) | `rfdb_server.rs` tests | explain=false → `Violations`, explain=true → `ExplainResult` |
| JS Client | Integration (real server) | `test/scenarios/rfdb-client.test.js` | `explainSteps.length > 0`, plain path unchanged |
| RFDBServerBackend | Unit (mock client) | `RFDBServerBackend.*.test.js` | explain forwarded to client, existing format unchanged |
| MCP handler | Unit (mock db) | `test/unit/mcp/*.test.js` | explain passed to checkGuarantee, output format |
| CLI | Unit (mock backend) | `test/unit/commands/*.test.js` | flag parsing, render output, --explain without --raw warning |

**Build reminder:** After any TypeScript changes, run `pnpm build` before running JS tests.
Cargo tests can be run directly with `cargo test` from the `packages/rfdb-server` directory.

---

## Risk Assessment

### R1: `execute_datalog` branching complexity — MEDIUM

`execute_datalog` in `rfdb_server.rs` (lines 1762-1809) already has two paths: rules vs direct
query. Adding `explain` branches each path into two. The function grows in complexity. Risk of
regression in the non-explain path.

**Mitigation:** TDD — write Rust tests for the non-explain path behavior first (Step 3), so any
regression is caught immediately.

### R2: Binding format mismatch between explain and non-explain paths — LOW-MEDIUM

The existing `RFDBServerBackend` converts `{X: "foo"}` bindings to `[{name: "X", value: "foo"}]`.
The `DatalogResultWithExplain` type uses raw `DatalogBinding` (the `{X: "foo"}` form). If the
MCP handler mixes up the two forms, it will silently produce wrong output.

**Mitigation:** The type system enforces this at compile time if overloads are correctly
declared. The MCP handler test (Step 6 tests) should verify binding access works correctly.

### R3: `checkGuarantee` vs `executeDatalog` — which one does MCP use? — LOW

The MCP `handleQueryGraph` calls `checkGuarantee` (line 40). The CLI `executeRawQuery` calls
`executeDatalog`. These are different wire requests. The explain changes must be applied to
BOTH. The socket protocol handler must handle `explain` in both `CheckGuarantee` AND
`ExecuteDatalog` variants. Easy to miss one.

**Mitigation:** Protocol changes in Step 2 touch all three variants (`CheckGuarantee`,
`DatalogQuery`, `ExecuteDatalog`) together.

### R4: Serde field naming — camelCase vs snake_case consistency — LOW

Rust structs use `snake_case` field names internally. The `#[serde(rename_all = "camelCase")]`
attribute on `WireExplainResult` and related structs controls JSON serialization. The TypeScript
types in `packages/types/src/rfdb.ts` must use the same camelCase names that serde produces.
A mismatch means fields arrive as `undefined` on the client.

**Mitigation:** All new wire structs in `rfdb_server.rs` use `#[serde(rename_all = "camelCase")]`
(matching the existing convention in that file). TypeScript interfaces use the camelCase names.

### R5: MCP output verbosity — LLM may not handle large explain outputs well — LOW

Explain output for complex queries could be hundreds of steps. An MCP tool response with 200
lines of explain steps may exceed reasonable response sizes or confuse the LLM.

**Mitigation:** The MCP handler already uses `guardResponseSize` for regular results. Apply the
same guard to explain output. Additionally, cap explain steps display to first 50 steps with a
"... N more steps" indicator.

---

## Out of Scope

- NAPI bindings (`packages/rfdb-server/src/ffi/napi_bindings.rs`) — deferred per D5
- `rule_eval_time_us` and `projection_time_us` actual tracking — deferred (Rust TODO)
- GUI (`packages/vscode`) — no explain visualization
- `DatalogLoadRules` and `DatalogClearRules` — no explain applies

---

## Acceptance Criteria (from REG-503)

1. `grafema query --raw 'type(X, "FUNCTION")' --explain` outputs step-by-step execution with
   timing, statistics, and result counts at each step
2. `query_graph` MCP tool with `explain: true` returns formatted explain steps in the text
   response
3. When `explain=false` (default), behavior is byte-for-byte identical to today — zero overhead
4. All new code has tests at its layer
5. TypeScript compiles without errors across all packages after the changes
