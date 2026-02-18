# REG-503: Exploration Report — Expose Explain Mode Through NAPI → Client → MCP → CLI

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-18
**Task:** REG-503 — Expose Explain mode through NAPI → Client → MCP → CLI

---

## Executive Summary

The Datalog explain infrastructure is fully implemented in Rust (`EvaluatorExplain` in
`eval_explain.rs`) and is already wired through the `engine_worker.rs` Command enum. However,
the explain capability is completely absent from every layer above Rust: NAPI bindings use the
old `Evaluator` (not `EvaluatorExplain`), the socket protocol has no `explain` field, the JS
client has no `explain` parameter, and neither MCP nor CLI expose it. Six distinct layers all
need changes.

---

## 1. Rust Side: What Exists

### 1.1 `eval_explain.rs` — EvaluatorExplain
**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/datalog/eval_explain.rs`

The entire evaluator with explain support is implemented and complete:

```rust
// Line 17-41: Query statistics
pub struct QueryStats {
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

// Line 50-66: One explain step
pub struct ExplainStep {
    pub step: usize,
    pub operation: String,
    pub predicate: String,
    pub args: Vec<String>,
    pub result_count: usize,
    pub duration_us: u64,
    pub details: Option<String>,
}

// Line 69-79: Profiling
pub struct QueryProfile {
    pub total_duration_us: u64,
    pub predicate_times: HashMap<String, u64>,
    pub rule_eval_time_us: u64,      // LINE 173: TODO: track separately — always 0
    pub projection_time_us: u64,     // always 0
}

// Line 82-92: Full result wrapping everything
pub struct QueryResult {
    pub bindings: Vec<HashMap<String, String>>,
    pub stats: QueryStats,
    pub profile: QueryProfile,
    pub explain_steps: Vec<ExplainStep>,  // empty when explain=false
}

// Line 95-110: The evaluator struct
pub struct EvaluatorExplain<'a> {
    engine: &'a dyn GraphStore,
    rules: HashMap<String, Vec<Rule>>,
    explain_mode: bool,
    stats: QueryStats,
    explain_steps: Vec<ExplainStep>,
    step_counter: usize,
    predicate_times: HashMap<String, Duration>,
    query_start: Option<Instant>,
}
```

**Known TODO (line 173):**
```rust
rule_eval_time_us: 0, // TODO: track separately
```
This is explicitly called out in the issue. `projection_time_us` is also always 0.

All structs derive `Serialize, Deserialize`, so they're ready for JSON serialization.

`EvaluatorExplain::query()` is the main entry point:
```rust
// Line 141:
pub fn query(&mut self, goal: &Atom) -> QueryResult { ... }
```

### 1.2 `engine_worker.rs` — explain piped through Command enum
**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/ffi/engine_worker.rs`

The `explain: bool` field is already present in both Command variants:

```rust
// Lines 121-134:
DatalogQuery {
    rule_source: String,
    explain: bool,                         // already here
    response_tx: Sender<Result<QueryResult, String>>,
},
CheckGuarantee {
    rule_source: String,
    explain: bool,                         // already here
    response_tx: Sender<Result<QueryResult, String>>,
},
```

Both methods on `EngineHandle` already accept `explain: bool`:
```rust
// Line 315:
pub fn datalog_query(&self, rule_source: String, explain: bool) -> Result<QueryResult, String>

// Line 322:
pub fn check_guarantee(&self, rule_source: String, explain: bool) -> Result<QueryResult, String>
```

The worker loop already dispatches to `execute_datalog_query` and `execute_check_guarantee`
helpers (lines 448-455) which both create `EvaluatorExplain::new(engine, explain)`.

**Conclusion: engine_worker.rs is 100% complete for explain. No changes needed here.**

### 1.3 `napi_bindings.rs` — the gap
**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/ffi/napi_bindings.rs`

The NAPI bindings use `Evaluator` (old, non-explain evaluator), not `EvaluatorExplain`:

```rust
// Line 13:
use crate::datalog::{Evaluator, parse_program, parse_atom, Rule};
// NOTE: EvaluatorExplain is NOT imported here

// Line 496-526: datalog_query — uses old Evaluator, no explain, returns Vec<JsDatalogResult>
#[napi]
pub fn datalog_query(&self, query: String) -> Result<Vec<JsDatalogResult>> {
    let atom = parse_atom(&query)...;
    let mut evaluator = Evaluator::new(&*engine_guard);  // old Evaluator
    ...
    let results = evaluator.query(&atom);  // returns Vec<Bindings>, not QueryResult
    Ok(results.into_iter().map(|bindings| JsDatalogResult {
        bindings: bindings.iter().map(|(name, value)| JsBinding { ... }).collect(),
    }).collect())
}

// Line 538-571: check_guarantee — also uses old Evaluator, returns Vec<JsDatalogResult>
#[napi]
pub fn check_guarantee(&self, rule_source: String) -> Result<Vec<JsDatalogResult>> {
    ...
    let mut evaluator = Evaluator::new(&*engine_guard);  // old Evaluator
    ...
}
```

The current JS types exposed via NAPI:
```rust
// Line 84-98:
#[napi(object)]
pub struct JsBinding {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct JsDatalogResult {
    pub bindings: Vec<JsBinding>,
}
```

There is no `JsQueryStats`, `JsExplainStep`, `JsQueryProfile`, or `JsQueryResultWithExplain`.

**NOTE:** The NAPI-based `GraphEngine` in napi_bindings.rs appears to be a legacy/direct path.
The production path goes through the socket protocol in `rfdb_server.rs`. The NAPI bindings
may no longer be the primary integration point (see section 4 below).

---

## 2. Socket Protocol (rfdb_server.rs) — the second gap
**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/bin/rfdb_server.rs`

The socket protocol is the production path used by `RFDBServerBackend`. It currently has:

```rust
// Line 195-203: Current request variants — NO explain field
CheckGuarantee {
    #[serde(rename = "ruleSource")]
    rule_source: String,
    // NO explain: bool here
},
DatalogLoadRules { source: String },
DatalogClearRules,
DatalogQuery { query: String },   // NO explain: bool here
ExecuteDatalog { source: String }, // NO explain: bool here
```

The response variants:
```rust
// Line 370-372:
Violations { violations: Vec<WireViolation> },
DatalogResults { results: Vec<WireViolation> },
// NO ExplainResult or similar
```

The `WireViolation` struct (line 495-497):
```rust
pub struct WireViolation {
    pub bindings: HashMap<String, String>,
}
```

The socket handlers use `Evaluator::new(engine)` (old evaluator), not `EvaluatorExplain`:

```rust
// Line 1697: execute_check_guarantee
let mut evaluator = Evaluator::new(engine);
// Line 1740: execute_datalog_query
let evaluator = Evaluator::new(engine);
// Line 1769, 1797: execute_datalog
let mut evaluator = Evaluator::new(engine);
```

**Conclusion:** The socket protocol needs:
1. `explain: bool` added to `CheckGuarantee`, `DatalogQuery`, and `ExecuteDatalog` request variants
2. New response type (or extended `WireViolation`) that includes stats, profile, explain_steps
3. Handlers to switch from `Evaluator::new` to `EvaluatorExplain::new(engine, explain)`

---

## 3. JS Client Layer — `RFDBClient` from `@grafema/rfdb-client`

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/storage/backends/RFDBServerBackend.ts`

The `RFDBServerBackend` wraps `RFDBClient` from `@grafema/rfdb-client` (external package, not
in this repo). The backend exposes these Datalog methods:

```typescript
// Line 678-685: checkGuarantee — no explain parameter
async checkGuarantee(ruleSource: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>

// Line 706-713: datalogQuery — no explain parameter
async datalogQuery(query: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>

// Line 719-725: executeDatalog — no explain parameter
async executeDatalog(source: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>
```

All three methods call `this.client.*` which maps to the `@grafema/rfdb-client` package methods.
The `RFDBClient` package is not in this repo — it's installed from npm at
`@grafema/rfdb-client`. The socket protocol changes must match what `RFDBClient` sends.

**Dependencies discovered:**
- The `@grafema/rfdb-client` npm package must also be updated to accept `explain: boolean`
  and return enhanced results. This is an external dependency not visible in this repo.
- However, looking at `rfdb-client.test.js` (test/scenarios/rfdb-client.test.js), the client
  is imported from `@grafema/core` as `RFDBClient`, suggesting there may be a client
  implementation inside core. Let me note: `packages/core/src/storage/backends/RFDBServerBackend.ts`
  imports from `@grafema/rfdb-client` on line 21.

**Current return type from JS client:** `Array<{ bindings: Array<{ name: string; value: string }> }>`
This needs to become something like:
```typescript
interface DatalogResultWithExplain {
  bindings: Array<{ name: string; value: string }>;
  stats?: QueryStats;
  profile?: QueryProfile;
  explainSteps?: ExplainStep[];
}
```

---

## 4. MCP Layer — query_graph tool
**File:** `/Users/vadimr/grafema-worker-1/packages/mcp/src/handlers/query-handlers.ts`

`handleQueryGraph` (line 27) already accepts `explain` in its args signature but does NOT use it:

```typescript
// Line 29: explain is destructured but prefixed with _ (unused)
const { query, limit: requestedLimit, offset: requestedOffset, format: _format, explain: _explain } = args;
```

`explain` is type-declared in `QueryGraphArgs` (types.ts line 43-49):
```typescript
export interface QueryGraphArgs {
  query: string;
  limit?: number;
  offset?: number;
  format?: 'table' | 'json' | 'tree';
  explain?: boolean;    // already declared
}
```

And the `query_graph` tool definition already exposes `explain` in schema (definitions.ts line 63-66):
```typescript
explain: {
  type: 'boolean',
  description: 'Show step-by-step query execution to debug empty results',
},
```

**Current gap:** The `explain` field is wired at the schema/types level but completely ignored
in the handler. It needs to:
1. Pass `explain` to the underlying `checkFn` call (which calls `checkGuarantee` or equivalent)
2. When explain results come back, format and return them to the user

The handler also calls `checkGuarantee` via an unsafe cast (line 40-41):
```typescript
const checkFn = (db as unknown as { checkGuarantee: (q: string) =>
  Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
const results = await checkFn(query);
```
This cast will need updating when `checkGuarantee` returns enhanced results.

---

## 5. CLI Layer — `grafema query --raw`
**File:** `/Users/vadimr/grafema-worker-1/packages/cli/src/commands/query.ts`

The `executeRawQuery` function (line 1077-1110) calls `backend.executeDatalog(query)`:

```typescript
// Line 1083:
const results = await backend.executeDatalog(query);
```

There is no `--explain` flag on the query command (line 79-138 — only `--raw`, `--type`, `-j`, `-l`).

The output formatter (lines 1088-1108) outputs:
```typescript
for (const result of limited) {
  const bindings = result.bindings.map((b) => `${b.name}=${b.value}`).join(', ');
  console.log(`  { ${bindings} }`);
}
```

No stats or explain steps are shown. The `--explain` flag needs to be added and the output
formatter needs to render `ExplainStep[]`, `QueryStats`, and `QueryProfile`.

---

## 6. TypeScript Type Definitions

No TypeScript interfaces for `QueryStats`, `QueryProfile`, `ExplainStep`, or enhanced Datalog
result types exist in the codebase. They need to be created in `packages/types/` or as local
interfaces.

**Existing type from core/GraphBackend.ts (partial):**
```typescript
// packages/mcp/src/types.ts line 188:
runDatalogQuery?(query: string): Promise<unknown[]>;
```
This is a very loose typing that needs to be made precise.

---

## 7. Test Infrastructure

### Rust Tests
**File:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/datalog/tests.rs`

All existing tests (lines 366-2005) use the old `Evaluator`, not `EvaluatorExplain`. There are
no tests for `EvaluatorExplain` in `tests.rs`. The `eval_explain.rs` file itself has no
`#[cfg(test)]` block.

Pattern from existing tests:
```rust
fn setup_test_graph() -> GraphEngine { ... }

#[test]
fn test_something() {
    let engine = setup_test_graph();
    let evaluator = Evaluator::new(&engine);
    let results = evaluator.eval_atom(&query);
    assert_eq!(results.len(), N);
}
```

For `EvaluatorExplain` tests, pattern would be:
```rust
let mut evaluator = EvaluatorExplain::new(&engine, true);
let result = evaluator.query(&atom);
assert!(!result.explain_steps.is_empty());
assert!(result.stats.nodes_visited > 0);
```

### JS Tests
**File:** `/Users/vadimr/grafema-worker-1/test/scenarios/rfdb-client.test.js`

Integration test that talks to real rfdb-server. Tests `datalogQuery`, `checkGuarantee` etc.
but without explain. Pattern for adding explain test would be:
```javascript
const result = await client.checkGuarantee(ruleSource, /* explain: */ true);
assert.ok(result.explainSteps.length > 0);
```

---

## 8. Architecture of Changes Needed (Layer by Layer)

### Layer 1: Rust — `rfdb_server.rs` (socket protocol)
- Add `explain: bool` to `CheckGuarantee`, `DatalogQuery`, `ExecuteDatalog` request variants
- Add new response type `ExplainResult { bindings, stats, profile, explain_steps }` OR extend
  `WireViolation` to `WireDatalogResult`
- Switch `execute_check_guarantee`, `execute_datalog_query`, `execute_datalog` to use
  `EvaluatorExplain` with `explain` parameter

### Layer 2: Rust — `napi_bindings.rs` (legacy NAPI — lower priority)
- Add `explain: Option<bool>` to `datalog_query` and `check_guarantee` NAPI methods
- Add NAPI-visible structs: `JsQueryStats`, `JsExplainStep`, `JsQueryProfile`, `JsQueryResultWithExplain`
- Switch from `Evaluator::new` to `EvaluatorExplain::new(engine, explain_mode)`
- Return the rich `JsQueryResultWithExplain` instead of `Vec<JsDatalogResult>`
- NOTE: This changes the return type — BREAKING for JS callers of NAPI directly

### Layer 3: `@grafema/rfdb-client` (external npm package)
- Update `checkGuarantee(ruleSource, explain?: boolean)` signature
- Update `datalogQuery(query, explain?: boolean)` signature
- Update `executeDatalog(source, explain?: boolean)` signature
- Return type must include stats/profile/explain_steps from server response
- This package is NOT in this repo — it's in the rfdb-client npm package (separate repo/build)

### Layer 4: `RFDBServerBackend.ts`
**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/storage/backends/RFDBServerBackend.ts`

- Update `checkGuarantee(ruleSource, explain?: boolean)` (line 678)
- Update `datalogQuery(query, explain?: boolean)` (line 706)
- Update `executeDatalog(source, explain?: boolean)` (line 719)
- Update return types to include optional explain data

### Layer 5: MCP handler
**File:** `/Users/vadimr/grafema-worker-1/packages/mcp/src/handlers/query-handlers.ts`

- Use `_explain` (currently unused, line 29) — pass to the underlying call
- Format and return explain steps + stats when present
- Update the `checkFn` type cast to use the new richer return type

### Layer 6: CLI query command
**File:** `/Users/vadimr/grafema-worker-1/packages/cli/src/commands/query.ts`

- Add `--explain` flag to `queryCommand` (line 79)
- Pass `explain: true` to `backend.executeDatalog(query, true)`
- Render explain output: steps table, stats summary

---

## 9. Key Complications and Risks

### 9.1 Return Type Change in NAPI Bindings
Changing `datalog_query` from `Vec<JsDatalogResult>` to `JsQueryResultWithExplain` is a
**breaking change** for any JS code that calls the NAPI binding directly. However, since the
production path now goes through the socket (RFDBServerBackend → RFDBClient → rfdb-server),
the NAPI path may be legacy and only used in tests or very old code.

### 9.2 External `@grafema/rfdb-client` Dependency
The RFDBClient is in a separate package (`@grafema/rfdb-client`). Changes to socket protocol
must be coordinated with changes to this client. The client needs to:
- Send `explain` in requests
- Parse the richer response format

### 9.3 Backwards Compatibility in Socket Protocol
The `explain` field should be optional in requests (default false) so existing clients
continue to work without changes. The response should only include stats/explain data when
the server has them, making it non-breaking.

### 9.4 `rule_eval_time_us: 0` Known Limitation
The `eval_explain.rs` line 173 has a `// TODO: track separately` comment. This is an
acknowledged limitation for now — the issue description mentions it. `projection_time_us` is
also always 0. These fields will exist in the wire format but will be 0. Should be documented
in the output format.

### 9.5 MCP Handler Uses Indirect `checkGuarantee` Call
The `handleQueryGraph` function (query-handlers.ts line 36-41) checks `if (!('checkGuarantee' in db))`
and calls it through an unsafe cast. When explain is passed, this cast type needs updating to
accept the `explain` parameter.

### 9.6 No Explain for `datalogLoadRules` / `datalogClearRules`
These are stateful operations in the NAPI path but are no-ops or lightweight in the socket
protocol path. Explain mode doesn't apply to them — only to query execution.

---

## 10. File Reference Map

| Component | File | Status |
|-----------|------|--------|
| `EvaluatorExplain` structs | `packages/rfdb-server/src/datalog/eval_explain.rs` | Complete |
| `engine_worker.rs` Command enum | `packages/rfdb-server/src/ffi/engine_worker.rs` | Complete |
| NAPI bindings `datalog_query` | `packages/rfdb-server/src/ffi/napi_bindings.rs:497-526` | Needs update |
| NAPI bindings `check_guarantee` | `packages/rfdb-server/src/ffi/napi_bindings.rs:539-571` | Needs update |
| Socket Request variants | `packages/rfdb-server/src/bin/rfdb_server.rs:195-203` | Needs update |
| Socket Response variants | `packages/rfdb-server/src/bin/rfdb_server.rs:369-372` | Needs update |
| `WireViolation` struct | `packages/rfdb-server/src/bin/rfdb_server.rs:495-497` | Needs update |
| Socket handlers `execute_*` | `packages/rfdb-server/src/bin/rfdb_server.rs:1156-1161,1178-1192` | Needs update |
| JS client methods | `packages/core/src/storage/backends/RFDBServerBackend.ts:678-725` | Needs update |
| MCP `QueryGraphArgs.explain` | `packages/mcp/src/types.ts:43-49` | Already declared |
| MCP `query_graph` schema | `packages/mcp/src/definitions.ts:63-66` | Already declared |
| MCP handler `_explain` | `packages/mcp/src/handlers/query-handlers.ts:29` | Needs to use it |
| CLI `--explain` flag | `packages/cli/src/commands/query.ts:79-138` | Not present yet |
| Rust tests for EvaluatorExplain | `packages/rfdb-server/src/datalog/tests.rs` | Need new tests |
| JS integration tests | `test/scenarios/rfdb-client.test.js` | Need new tests |

---

## 11. What Changes Nothing and What Changes Everything

**Nothing to change:**
- `eval_explain.rs` — fully implemented
- `engine_worker.rs` — fully wired with `explain: bool`
- `packages/mcp/src/types.ts` — `QueryGraphArgs.explain` already declared
- `packages/mcp/src/definitions.ts` — `query_graph` schema already has `explain`

**Everything (requires coordinated change across 4-5 files):**
- The socket protocol in `rfdb_server.rs` is the true blocker — once this is extended,
  all layers above it can consume the explain data
- The `@grafema/rfdb-client` package must be updated in tandem with socket protocol

---

## 12. Recommended Implementation Order

1. Write Rust tests for `EvaluatorExplain` (locks existing behavior, TDD)
2. Extend socket protocol: `rfdb_server.rs` — add `explain` to requests, new response type
3. Update `@grafema/rfdb-client` package — accept `explain`, parse new response
4. Update `RFDBServerBackend.ts` — forward `explain` parameter, update return types
5. Add TypeScript interfaces for `QueryStats`, `ExplainStep`, `QueryProfile`
6. Update MCP handler — use `explain`, format output
7. Update CLI — add `--explain` flag, render output
8. Update NAPI bindings (lower priority — legacy path)
9. Write JS integration tests
