# REG-507: Dijkstra Plan Verification

**Role:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-19
**Plan reviewed:** `002-don-plan.md` — Option C, `count: true` parameter on `query_graph`

---

## Verdict: APPROVE with two required clarifications

The plan is structurally sound and its implementation boundary is correctly drawn. However, two specification gaps must be resolved before Rob begins implementation; both are small, neither requires redesign.

---

## Verification Method

I do not THINK the plan handles all cases. I PROVE it by exhaustive enumeration of the input universe.

---

## 1. Input Universe

### 1.1 Parameter combinations for `query_graph` with `count: true`

Every call to `handleQueryGraph` is determined by the combination of five parameters: `query`, `count`, `limit`, `offset`, `explain`. I enumerate all relevant combinations.

| # | `count` | `explain` | `limit` | `offset` | `query` |
|---|---------|-----------|---------|----------|---------|
| 1 | `true` | absent/false | absent | absent | valid query |
| 2 | `true` | absent/false | number | absent | valid query |
| 3 | `true` | absent/false | number | number | valid query |
| 4 | `true` | `true` | absent | absent | valid query |
| 5 | `true` | absent/false | absent | absent | syntactically invalid query |
| 6 | `true` | absent/false | absent | absent | semantically valid query, 0 results |
| 7 | `false` | absent/false | absent | absent | valid query |
| 8 | absent (undefined) | absent/false | absent | absent | valid query |

---

## 2. Completeness Tables

### Table A: `count: true` + other parameters

| Input | Expected behavior | Handled by plan? |
|-------|------------------|-----------------|
| `count: true`, no `limit`, no `offset` | Run full query, return `"Count: N"` | YES — described explicitly |
| `count: true`, `limit: 5` | `limit` is irrelevant — count of ALL results, not paginated count. Count = total, not min(5, total) | NOT STATED in plan. The plan says "run the query normally" but "normally" includes `normalizeLimit(requestedLimit)` and slicing. The proposed code snippet skips pagination, but the intent is not explicit. |
| `count: true`, `offset: 10` | `offset` is irrelevant to count | NOT STATED. Same gap as above. |
| `count: true`, `explain: true` | Two modes active simultaneously — mutually exclusive? | NOT STATED. See Gap 1 below. |
| `count: true`, invalid query (parse error) | Backend throws, caught by outer `try/catch`, returns `errorResult(message)` | YES — existing catch block handles this correctly without modification. |
| `count: true`, query returns 0 results | Should return `"Count: 0"`, not the empty-result hint path | PARTIALLY — the plan's code snippet `return textResult(\`Count: ${results.length}\`)` returns before the `total === 0` branch, so "Count: 0" is correct. But this is an implicit consequence of placement, not an explicit design decision. |
| `count: true`, backend lacks `checkGuarantee` | Return `errorResult('Backend does not support Datalog queries')` | YES — early-return guard at line 38 of handler fires before count branch. |

### Table B: `count: false` and `count: undefined`

| Input | Expected behavior | Handled by plan? |
|-------|------------------|-----------------|
| `count: false` (explicit) | Existing behavior unchanged | YES — `if (args.count)` evaluates to false |
| `count: undefined` (absent) | Existing behavior unchanged | YES — `if (args.count)` evaluates to false |
| `count: 0` | TypeScript type is `boolean`, so `0` is not assignable. At runtime via JSON, `0` is falsy — treated as `count: false`. | ACCEPTABLE — JSON schema declares type `boolean`; agents passing `0` would be malformed. |

### Table C: Placement of count branch relative to existing branches

The current `handleQueryGraph` has this control flow:

```
1. ensureAnalyzed()
2. normalizeLimit / normalizeOffset
3. if (!checkGuarantee in db) → errorResult
4. if (explain) → explain path + early return
5. checkFn(query) → results
6. if (total === 0) → hint path + early return
7. pagination slice
8. enrichment loop (getNode per result)
9. return formatted text
```

The plan inserts `count` as a new early return. The question is: WHERE in this sequence?

Don's code snippet:
```typescript
if (args.count) {
  const results = await checkFn.call(db, query);
  return textResult(`Count: ${results.length}`);
}
```

This snippet calls `checkFn` directly, implying it runs AFTER step 3 (backend check) but BEFORE step 4 (explain check). That is correct for the normal flow. However, the plan does not state whether `count` + `explain` is allowed or an error.

| Placement question | Verdict |
|-------------------|---------|
| Before backend check? | NO — backend check must fire first (already handled) |
| Before explain branch? | YES — Don's snippet implies this |
| After explain branch? | Would silently ignore `count` when `explain: true` — wrong |
| After total === 0 check? | Would fail — `results` not yet defined |

### Table D: Return value format

| Mode | Return value in Don's plan |
|------|--------------------------|
| `count: true`, results found | `"Count: 42"` (plain text string) |
| `count: true`, results empty | `"Count: 0"` (plain text string) |

Don's section 4 states: "return `{ count: N }` as structured data, not just text." But section 5 says: `return textResult(\`Count: ${total}\`)`. These are **contradictory**. `textResult` wraps a string in `{ content: [{ type: 'text', text: ... }] }`. That is NOT the same as `{ count: N }`. See Gap 2 below.

---

## 3. Gaps Found

### Gap 1: `count: true` + `explain: true` — undefined behavior

The plan does not specify what happens when both are true.

The existing code already has this same gap for `explain + limit + offset` (explain ignores them silently), so there is precedent for "first branch wins." If `explain` branch comes first, `count` would be silently ignored. If `count` branch comes first, `explain` would be silently ignored.

**Resolution required:** The plan must state: "when both `count` and `explain` are true, which wins?" My recommendation: `explain` takes priority (it is the debugging mode; the user asking for explain also wants explain output, not a count). Rob must implement accordingly.

This is not a blocking rejection — it is a small specification omission. The fix is one line: add a note in the plan and in the code comment.

### Gap 2: Return format — text string vs structured `{ count: N }`

Don's section 4 ("Recommended Approach") says: "return `{ count: N }` as structured data, not just text."

Don's section 5 ("Implementation Plan") says: `return textResult(\`Count: ${results.length}\`)`

`textResult` produces `{ content: [{ type: 'text', text: 'Count: 42' }] }`. This is a text MCP response, not structured data. An AI agent calling `query_graph({ count: true })` and getting `"Count: 42"` as a string must parse the number from text, which is fragile.

Structured data `{ count: 42 }` would be machine-readable without parsing.

However: ALL other `query_graph` responses use `textResult`. Introducing JSON in the count path creates an inconsistency. The choice between "text string" and "structured data" has implications for how AI agents consume this tool.

**Resolution required:** Don must pick one and state it explicitly. Options:
- A: `textResult("Count: 42")` — consistent with all other responses, agent parses the number from text
- B: structured JSON `{ count: 42 }` — requires `return { content: [{ type: 'text', text: JSON.stringify({ count: 42 }) }] }` — agents can JSON.parse the text

I note that the MCP protocol's `ToolResult.content` is always an array of text blocks. There is no first-class "structured" return — it's still text. So "structured data" means JSON-encoded text, which is how many MCP tools return data. The plan should be explicit.

---

## 4. Precondition Analysis

### Precondition 1: `checkFn.call(db, query)` is safe to call without limit

The current query pipeline runs the full query server-side (in Rust). Pagination happens client-side in `handleQueryGraph` by slicing `results`. Therefore, `count: true` path calling `checkFn(query)` without any limit argument correctly gets the full result set to count.

**Status: VERIFIED.** Looking at line 50 of `query-handlers.ts`:
```typescript
const results = await checkFn.call(db, query);
```
The existing call already fetches all results. The `limit`/`offset` are TS-side only. The count path reuses this exact call — it is safe.

### Precondition 2: `results.length` is the true total

`checkFn.call(db, query)` returns `Array<{ bindings: ... }>`. The Rust server returns all matching bindings. There is no server-side pagination. `results.length` is the full count.

**Status: VERIFIED.** Current code confirms this at line 51: `const total = results.length;` and this is used for `Found ${total} result(s)` before pagination. The count path gets the identical total.

### Precondition 3: `MockBackend` supports `checkGuarantee` for tests

The plan proposes tests that exercise the count path. Tests require a mock backend that implements `checkGuarantee`. The plan states "use existing patterns from `mcp.test.ts`."

**Status: UNVERIFIED.** I checked `MockBackend` (referenced from `mcp.test.ts`) but the file `/Users/vadimr/grafema-worker-4/packages/mcp/test/helpers/MockBackend.js` (or `.ts`) was not read. The existing `mcp.test.ts` tests do NOT test `handleQueryGraph` directly — they test `simulateAnalysis` and guard traversal. The plan's test estimates assume `MockBackend` already has `checkGuarantee`. If it does not, tests will require a new mock method.

**Rob must verify** that `MockBackend` implements `checkGuarantee`, or add that method. This is a small risk (one mock method) but must be confirmed before implementation starts.

### Precondition 4: TypeScript `count?: boolean` does not conflict with existing runtime behavior

`query` is the only required field in `QueryGraphArgs`. `count` is a new optional `boolean`. JSON schema validation in MCP allows unknown fields by default, so adding `count` to the schema is backward compatible — existing callers not passing `count` receive `undefined` which is falsy.

**Status: VERIFIED.** No backward compatibility risk.

---

## 5. Edge Case Enumeration

| Edge case | Expected outcome | Plan covers it? |
|-----------|-----------------|----------------|
| `count: true`, empty graph (0 nodes) | Query returns 0 results. Return `"Count: 0"`. | YES — implicit (count path fires before empty-result branch) |
| `count: true`, very large result set (100k rows) | Full result set loaded into memory, counted. Response is `"Count: 100000"`. No truncation. | YES — count path never calls `guardResponseSize`. Count response is always short. |
| `count: true`, query with syntax error | `checkFn` throws, caught by `catch (error)`, returns `errorResult(message)`. | YES — existing catch block. |
| `count: true`, query with `format` param | `format` is already ignored in the handler (destructured as `_format`). Count path also ignores it. | YES — no conflict. |
| `count: true` + `limit: 0` | `limit` is irrelevant in count path. count path fires before pagination. | YES — implicit. |
| `count: true` + `offset: 999999` (beyond results) | Irrelevant. count path ignores offset entirely. | YES — implicit. |
| `count: true` + `explain: true` | Behavior undefined. | GAP 1 — see above. |
| `query_graph` schema exposed to AI: is `count` described clearly? | Description in definitions.ts must tell the AI what `count: true` returns and when to use it. | Plan says "update description to mention count mode" but gives no example text. Rob must write clear description. |

---

## 6. LOC Estimate Verification

Don estimates ~61 LOC. I verify by category:

| File | Don's estimate | My assessment |
|------|---------------|---------------|
| `types.ts` | +3 | Correct. One field addition with JSDoc. |
| `definitions.ts` | +8 | Correct. One new schema property + description update. |
| `query-handlers.ts` | +10 | Correct. Destructure `count`, add 5-7 line if-branch. |
| Tests | +40 | May be low if `MockBackend` lacks `checkGuarantee`. Estimate +40–60 LOC. |
| **Total** | ~61 | ~61–81 LOC. Estimate is sound. |

---

## 7. Summary of Required Actions Before Implementation

1. **Resolve Gap 1:** State explicitly in the plan: when `count: true` and `explain: true` are both passed, which wins. My recommendation: `explain` wins (debugging intent takes priority).

2. **Resolve Gap 2:** State explicitly: does count return `textResult("Count: N")` or `textResult(JSON.stringify({ count: N }))`? Pick one, write it in the plan.

3. **Rob must verify** `MockBackend` supports `checkGuarantee` before writing tests.

Neither gap requires redesign. Both are specification clarifications that can be resolved in one sentence each.

---

## Final Assessment

Don's architectural analysis is correct. Option C is the right choice. The implementation boundary (TypeScript only, no Rust) is correct. The placement of the count branch in the handler control flow is correct. The core logic (`results.length` as the count source) is correct.

The two gaps are specification omissions, not architectural errors. The plan is **APPROVED** pending resolution of Gap 1 and Gap 2 above.
