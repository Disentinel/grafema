# REG-507: Don's Plan — Datalog count() aggregation predicate

**Role:** Don Melton (Tech Lead)
**Date:** 2026-02-19
**Phase:** STEP 2 — Architecture Analysis & Plan

---

## 1. Architecture Analysis: Current Datalog Pipeline

### Full pipeline, top-to-bottom:

```
User/AI calls query_graph("violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\").")
  │
  ▼
packages/mcp/src/handlers/query-handlers.ts :: handleQueryGraph()
  │   calls: db.checkGuarantee(query)
  │
  ▼
packages/core/src/storage/backends/RFDBServerBackend.ts :: checkGuarantee()
  │   delegates to: RFDBClient.checkGuarantee(ruleSource)
  │
  ▼
packages/rfdb/ts/client.ts :: RFDBClient.checkGuarantee()
  │   sends: { cmd: "checkGuarantee", source: ruleSource } over Unix socket
  │
  ▼
packages/rfdb-server/src/bin/rfdb_server.rs :: Request::CheckGuarantee handler
  │   calls: execute_check_guarantee(engine, &rule_source, explain)
  │
  ▼
packages/rfdb-server/src/bin/rfdb_server.rs :: execute_check_guarantee()
  │   uses: EvaluatorExplain::new(engine, explain)
  │   queries: violation(X) atom
  │   returns: QueryResult { bindings: Vec<HashMap<String, String>>, stats, ... }
  │
  ▼
Response::DatalogResults { results: Vec<WireViolation> }
  │   where WireViolation = HashMap<String, String>
  │
  ▼ (back through client)
Array<{ bindings: { name, value }[] }> in TypeScript
  │
  ▼
handleQueryGraph() extracts bindings, enriches with node data, returns text
```

### Key structural observations:

**The evaluator (`eval.rs`, `eval_explain.rs`):**
- Core type: `Bindings = HashMap<String, Value>`
- `eval_query(literals)` returns `Vec<Bindings>` — one row per result
- No aggregation layer exists anywhere in the pipeline
- Built-in predicates matched in `eval_atom()` by predicate name string

**The parser (`parser.rs`):**
- Purely syntactic — parses to AST (Term, Atom, Literal, Rule)
- No semantic understanding of predicates
- `count(N)` would parse fine as `Atom { predicate: "count", args: [Var("N")] }`

**The protocol layer:**
- `QueryResult.bindings: Vec<HashMap<String, String>>` — the result wire format
- All values are strings (even node IDs)
- Adding a new field to `QueryResult` is straightforward (it already has `stats`, `warnings`, etc.)

**The MCP layer:**
- `handleQueryGraph()` already has `total = results.length` computed before pagination
- The `total` count is already formatted into the response text: `"Found ${total} result(s)"`
- Adding a `count: true` parameter to `QueryGraphArgs` is ~5 lines of TS

---

## 2. Prior Art: How Real Datalog Engines Handle count()

From research:

**Soufflé (production static analysis Datalog):**
```
B(s, c) :- W(s), c = count : { C(s, _) }.
```
Count is an aggregate in the rule body assigned to a variable. Uses stratification — the aggregate body must be in a lower stratum than the head. This requires semantic analysis of strata during compilation.

**Datomic:**
Uses `(count ?x)` as a find aggregation, separate from the WHERE clause.

**OpenStack Congress:**
Proposed `count(group_by_var, count_var)` as a built-in. Never fully implemented.

**Key insight from prior art:**
Full aggregate Datalog (Option A) requires stratification analysis — verifying that rules don't create circular dependencies through aggregation. This is a compiler-level concern, not just an evaluator concern. Every real production system that supports aggregates treats it as a separate compilation pass. This is non-trivial to implement correctly.

---

## 3. Evaluation of Options

### Option A: Built-in `count(Var, N)` predicate in Datalog

**What it would require:**
1. Parser change: recognize `count` as a special form (it already parses as a normal atom — so no parser change needed at the syntactic level)
2. Evaluator change: in `eval_atom()`, add a `"count"` arm that:
   - Takes the first argument as a "what to count" pattern
   - Evaluates the body so far, counts unique bindings, binds `N`
   - This requires the evaluator to have access to the "current conjunction state" — it doesn't
3. Stratification: `count(X, N)` where `X` is already computed from previous literals is safe. But verifying this statically requires analysis.
4. Semantic issue: The acceptance criteria `count(N) :- node(X, "CALL"), \+ edge(X, _, "CALLS").` treats the rule HEAD as the count output. This is semantically wrong — `N` isn't bound by any positive body literal, violating the safety check (`rule.is_safe()` would return false).

**Verdict: High complexity, semantic mismatch with the proposed syntax.**

The proposed syntax `count(N) :- ...` is not how real Datalog aggregation works. In standard Datalog, aggregates are in the body, not the head. Making `count(N)` in the HEAD work requires either:
- Treating it as a special post-processing step (not true Datalog semantics)
- Or accepting that it's a non-standard extension that needs special-casing

Either way, this is a significant design decision that touches the core evaluation model.

### Option B: `limit: 0` + response includes `totalCount`

**What it would require:**
- Client sends `{ limit: 0 }` to signal "count only"
- Server returns `{ count: 42 }` instead of full results
- Protocol change in `RFDBClient`, `RFDBServerBackend`, MCP handler

**Problems:**
- Semantic abuse of `limit: 0` — zero limit normally means "don't return anything", not "count mode"
- Requires a new server-side code path
- AI agent has no clear signal this is "count mode" vs "accidentally limit 0"

**Verdict: Clever but confusing. Semantic abuse of an existing parameter.**

### Option C: `count: true` at MCP/CLI level

**What it would require:**
1. Add `count?: boolean` to `QueryGraphArgs` in `packages/mcp/src/types.ts`
2. Add `count` parameter to `query_graph` tool definition in `packages/mcp/src/definitions.ts`
3. In `handleQueryGraph()`: if `count: true`, run the query normally, but return only the total count as text: `"Count: 42"`
4. No changes to Rust, no protocol changes, no evaluator changes

**Total scope:** ~20 LOC TypeScript, 0 LOC Rust.

**How it works:**
```typescript
if (args.count) {
  const results = await checkFn.call(db, query);
  return textResult(`Count: ${results.length}`);
}
```

**What it doesn't do:**
- Doesn't optimize — still fetches all results, counts them in TS
- For very large result sets (10k+ rows) this is wasteful
- But Grafema's current query results are already limited; the real bottleneck is graph traversal, not row count

**Verdict: Correct for the use case, minimal risk, immediately valuable.**

---

## 4. Recommended Approach

**Option C, with a refinement: return `{ count: N }` as structured data, not just text.**

Rationale for C over A:
1. **The right abstraction is at the tool level.** "How many unresolved calls?" is a question to the AI tool, not a Datalog language feature. The Datalog query defines *what* to count; the tool parameter says *return count, not list*.
2. **Option A's proposed syntax is semantically incorrect.** `count(N) :- node(X), \+ edge(X, _, "CALLS").` would fail the safety check since `N` is not bound by any positive literal. Implementing this requires bypassing core safety checks or adding special-case handling.
3. **Option A requires Rust changes.** Any change to the Rust evaluator requires rebuilding the native binary and bumping the NAPI binding. Option C is pure TypeScript.
4. **Prior art (Soufflé) validates that "count in body" is the right semantics.** The proposed head-syntax contradicts established Datalog theory. We should not introduce a non-standard extension that will confuse users and conflict with any future real aggregation support.
5. **Option C is composable.** The `count: true` parameter works with any query, not just queries designed for counting. It's orthogonal to query semantics.

**Why not Option B:** Semantic abuse of `limit: 0` creates confusion for both AI agents and human users. Option C is cleaner.

**Future path:** When real aggregate support is needed (Option A), it should be done correctly: `count` as a body aggregate function with stratification checking, following Soufflé's model. That is a larger v0.3+ task. Option C gives immediate value without blocking that future work.

---

## 5. Implementation Plan

### Files to modify:

**1. `packages/mcp/src/types.ts`** (~3 LOC)
- Add `count?: boolean` to `QueryGraphArgs` interface

**2. `packages/mcp/src/definitions.ts`** (~6 LOC)
- Add `count` property to `query_graph` tool's `inputSchema`
- Update description to mention count mode

**3. `packages/mcp/src/handlers/query-handlers.ts`** (~8 LOC)
- Destructure `count` from args
- Add early-return branch: if count mode, run query, return `"Count: ${total}"`
- Return before the enrichment loop (no need to fetch node details for count)

### Files to add (tests):

**4. `packages/mcp/test/mcp.test.ts` or a new test file** (~40 LOC)
- Test: `count: true` with a query that matches nodes — returns "Count: N"
- Test: `count: true` with a query that matches nothing — returns "Count: 0"
- Test: `count: true` + filter (e.g., with negation `\+ edge`) — returns correct count

### No changes to:
- Rust evaluator (`eval.rs`, `eval_explain.rs`)
- Rust parser (`parser.rs`)
- RFDB server binary
- Protocol types (`rfdb.ts`)
- RFDBClient
- RFDBServerBackend

---

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Option C doesn't optimize away data transfer | Low | Acceptable for v0.2; query results are already paginated server-side implicitly via OS socket buffering. Real optimization deferred. |
| `count` param name conflicts with future Datalog `count()` | Low | The MCP param is `count: boolean` (mode switch), not a Datalog predicate. Namespaces are different. |
| Test complexity (Datalog queries need a real graph) | Medium | MCPTestHarness already provides a mock backend; use existing patterns from `mcp.test.ts` |
| Acceptance criteria #1 (`count(N) :- ...`) can't be implemented as stated | Medium — requires user alignment | AC #1 is semantically invalid Datalog (unsafe rule). Recommend accepting AC #2 as the canonical syntax. Must communicate to Vadim. |

**Critical flag:** Acceptance Criteria #1 proposes syntax that violates Datalog safety (`N` unbound in positive body). This is not implementable without special-casing the `count` head predicate as a post-processing directive rather than a real Datalog rule. Option C satisfies AC #2 and #3. **Recommend confirming with Vadim that AC #2 is the target, not AC #1.**

---

## 7. Estimated LOC

| File | Change Type | LOC |
|------|-------------|-----|
| `mcp/src/types.ts` | Add field | +3 |
| `mcp/src/definitions.ts` | Add schema property + update description | +8 |
| `mcp/src/handlers/query-handlers.ts` | Add count branch | +10 |
| `mcp/test/mcp.test.ts` or new test | New tests | +40 |
| **Total** | | **~61 LOC** |

Rust: 0 LOC.

---

## 8. Recommendation to Team

Implement **Option C**. It is the minimal, correct, and safe solution.

**Do not implement Option A** until there is a real use case requiring Datalog-level aggregation (e.g., `sum`, `max`, `min` over attribute values). At that point, implement it correctly following Soufflé's stratification model, not the unsafe head-syntax proposed in AC #1.

**Do not implement Option B** — semantic abuse of `limit: 0` creates AI-agent confusion.

The question "how many unresolved calls?" is answered correctly and efficiently by:
```
query_graph({
  query: 'violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").',
  count: true
})
// → "Count: 42"
```

This is clean, obvious, and composable with any existing Datalog query.

---

*Sources:*
- [Soufflé Aggregates Documentation](https://souffle-lang.github.io/aggregates)
- [Aggregation in Datalog Under Set Semantics (Stanford)](https://web.stanford.edu/~abhijeet/papers/aggregates.pdf)
- [OpenStack Congress Datalog Aggregates Spec](https://specs.openstack.org/openstack/congress-specs/specs/liberty/datalog-aggregates.html)
