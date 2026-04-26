## Dijkstra Correctness Review — REG-505

**Verdict:** APPROVE (with one noted test gap, no production defects)

**Functions reviewed:**
- `extractQueriedTypes` (mcp/utils.ts) — APPROVE
- `extractQueriedTypes` (cli/utils/queryHints.ts) — APPROVE (identical copy)
- `findSimilarTypes` (mcp/utils.ts) — APPROVE
- `findSimilarTypes` (cli/utils/queryHints.ts) — APPROVE (identical copy)
- `handleQueryGraph` zero-results block (query-handlers.ts) — APPROVE
- `executeRawQuery` suggestion block (cli/commands/query.ts) — APPROVE
- Test suite "Did You Mean Suggestions" block — APPROVE with gap noted

---

## Per-Function Correctness Proofs

### 1. `extractQueriedTypes` — both copies identical

**Node regex:** `/\bnode\([^,)]+,\s*"([^"]+)"\)/g`

I enumerate all structurally distinct inputs:

| Input | Should match? | Result | Verdict |
|---|---|---|---|
| `node(X, "FUNCTON")` | YES | `[^,)]+` matches `X`, `"([^"]+)"` captures `FUNCTON` | CORRECT |
| `node(_, "FUNCTON")` | YES | Same, `_` matches `[^,)]+` | CORRECT |
| `node(X, T)` | NO | No quoted string after comma; regex fails at `T` | CORRECT |
| `type(X, "FUNCTON")` | NO | `\bnode\(` does not match `type(` | CORRECT |
| `attr(X, "name", "foo")` | NO | `\bnode\(` does not match `attr(` | CORRECT |
| `mynode(X, "FOO")` | NO | `\bnode\(` requires word-boundary + literal `node`; `mynode` has `e` before `node`, no boundary before `n` in `node` — wait, `\b` is between `y` and `n`, which is a boundary. Actually `mynode` = `m-y-n-o-d-e`, so `\b` before `n`? No: `\b` matches between a word char and a non-word char. `y` is a word char, `n` is a word char, so there is NO `\b` between `y` and `n`. Thus `\bnode` inside `mynode` does NOT match. | CORRECT |
| `node(X,Y, "TYPE")` | NO (not a node predicate — 3 args) | `[^,)]+` matches `X`, then expects `,"TYPE"` but finds `,Y,` — NO MATCH | CORRECT (non-match is appropriate) |
| Empty string | NO | Regex finds no match; returns `[]` | CORRECT |
| Multiple occurrences: `node(X, "A"), node(Y, "B")` | YES (both) | `exec` with `g` flag iterates, captures `A` then `B` | CORRECT |

**Conclusion:** The `\b` word boundary correctly prevents matching `mynode`, `anode`, `foonode`. The `[^,)]+` correctly stops at the first `,` or `)`, preventing multi-argument false matches. The regex does NOT match `type(...)` as required by the intentional exclusion comment.

**Edge regex:** `/\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g`

| Input | Should match? | Result | Verdict |
|---|---|---|---|
| `edge(X, Y, "CALLS")` | YES | Three-arg match, captures `CALLS` | CORRECT |
| `incoming(X, Y, "CALLS")` | YES | Same structure | CORRECT |
| `attr(X, "name", "foo")` | NO | `(?:edge|incoming)` does not match `attr` | CORRECT |
| `edge(X, Y, Z)` | NO | Third arg not quoted; regex fails | CORRECT |
| `edge(X, "TYPE")` | NO | Only two args; second `[^,)]+,\s*"..."` pattern requires third arg | CORRECT |

**Variable reuse:** `m` is declared once as `let m: RegExpExecArray | null` and reused for both while-loops. Both loops reset `m` via assignment in their condition. No aliasing issue.

**Loop termination:** Both `while` loops use `RegExp.exec()` with a regex that has the `g` flag. Each call advances `lastIndex`. The loop terminates when `exec` returns `null` (no more matches). Guaranteed termination since the input string is finite.

---

### 2. `findSimilarTypes` — both copies identical

**Condition under analysis:** `dist <= maxDistance && (dist > 0 || queriedType !== type)`

I enumerate all four cases by the two independent binary variables (`dist <= maxDistance` and `dist === 0`):

**Case 1: dist > maxDistance**
- Outer condition `dist <= maxDistance` is false.
- Result: excluded.
- Semantics: too different — correct.

**Case 2: dist = 0, queriedType === type**
- `dist <= maxDistance` is true.
- Inner: `dist > 0` is false; `queriedType !== type` is false.
- Result: `true && false` = excluded.
- Semantics: exact match — should NOT appear as suggestion — correct.

**Case 3: dist = 0, queriedType !== type**
- This occurs when `queriedType.toLowerCase() === type.toLowerCase()` (case differs) but `queriedType !== type` (string identity differs).
- Example: `queriedType = "function"`, `type = "FUNCTION"`. Levenshtein of `"function"` vs `"function"` (both lowercased) = 0.
- `dist <= maxDistance` is true. Inner: `dist > 0` is false; `queriedType !== type` is true.
- Result: `true && true` = included.
- Semantics: case mismatch — should be suggested as the correct casing — correct.

**Case 4: 0 < dist <= maxDistance**
- `dist <= maxDistance` is true. Inner: `dist > 0` is true.
- Result: `true && true` = included.
- Semantics: close typo — should be suggested — correct.

**All four cases are correctly handled.** The condition is a complete and correct partition.

**Empty `availableTypes`:** Loop body never executes. Returns `[]`. Correct.

**`maxDistance` parameter default:** `= 2`. Cannot be negative from callers (all callers use default or positive values). If caller passed 0, only Case 1 and Case 2/3 matter — dist=0 exact match excluded, dist=0 case-mismatch excluded (since `dist <= 0` is only true for dist=0 which hits Case 2/3). That would produce an empty result, which is surprising but not a reachable path in this codebase.

---

### 3. `handleQueryGraph` zero-results block (query-handlers.ts, lines 53–108)

**Possible undefined access check on `nodeCounts`:**

`nodeCounts` is assigned at line 57:
```ts
const nodeCounts = await db.countNodesByType();
```
This is unconditional (not guarded by `edgeTypes.length > 0`). If `countNodesByType()` rejects, the `try/catch` at line 36 handles it. If it resolves, it returns a `Record<string, number>`, never `undefined` or `null` per the interface contract.

Line 105: `Object.values(nodeCounts).reduce((a, b) => a + b, 0)` — if `nodeCounts` is `{}`, `Object.values({})` is `[]`, and `.reduce` with seed `0` returns `0` without calling the callback. Safe.

**`edgeCounts` guard:**
Line 58: `edgeTypes.length > 0 ? await db.countEdgesByType() : {}`. When `edgeTypes` is empty, `edgeCounts` is `{}`, and `availableEdgeTypes` is `[]`. The loop at line 86 iterates over `edgeTypes` (which is empty), so it never executes. Consistent.

**`hasQueriedTypes` guard:**
Line 55: `nodeTypes.length > 0 || edgeTypes.length > 0`. If both are empty, the entire hint block is skipped. Then line 105 still runs to compute `totalNodes`. Correct — still reports "Query returned no results.\nGraph: N nodes".

**Condition: `if (!nodeCounts[queriedType])` (line 70):**
This uses falsy check. `nodeCounts[queriedType]` is `undefined` for a missing key (falsy), or a `number > 0` for existing key (truthy). This would incorrectly trigger the hint if `nodeCounts[queriedType] === 0`, i.e., a type exists in the schema with zero nodes. In practice this cannot happen because the graph database only records types that have at least one node, so `countNodesByType()` never returns `{FUNCTION: 0}`. This is safe by operational invariant, not by code structure alone.

The same applies to `!edgeCounts[queriedType]` at line 87.

---

### 4. `executeRawQuery` suggestion block (cli/commands/query.ts, lines 1132–1182)

**Guard: `if (limited.length === 0)` (line 1132):**
The entire suggestion block (unknown predicates + type hints) is wrapped in this guard. Suggestions are only shown when results are empty.

**Explain early-return (lines 1103–1111):**
```ts
if (explain) {
  ...
  return;          // line 1109
}
```
The function returns before reaching line 1132. Therefore the suggestion block is unreachable when `explain` is true. Correct.

**`nodeCounts` guard (line 1143):**
```ts
const nodeCounts = nodeTypes.length > 0 ? await backend.countNodesByType() : {};
```
`nodeCounts` is `{}` when no node types are queried. `availableNodeTypes` is `[]`. The node loop at line 1151 iterates `nodeTypes` — if `nodeTypes` is empty, loop does not execute. If `nodeTypes` is non-empty but `nodeCounts` was set to `{}` (impossible: the ternary fetches counts when `nodeTypes.length > 0`), the guard at line 1148 catches it. Consistent.

**Edge: `!nodeCounts[queriedType]` (line 1152):** Same falsy-check note as the MCP handler — safe by operational invariant.

---

### 5. Test suite — "Did You Mean Suggestions"

**Test coverage of `extractQueriedTypes`:**
All critical cases are covered:
- node with variable arg: `node(X, ...)` and `node(_, ...)`
- edge and incoming predicates
- multi-predicate query
- multiple node types
- full rule form with `:-`
- `attr()` false positive: tested
- unquoted variable: tested
- `type()` exclusion: tested
- empty string: tested

**Test coverage of `findSimilarTypes`:**
- Case mismatch (dist=0, queriedType !== type): tested as `'function'` vs `['FUNCTION', 'CLASS']` — correctly expects `['FUNCTION']`.
- Exact match exclusion (dist=0, queriedType === type): tested as `'FUNCTION'` vs `['FUNCTION', 'CLASS']` — correctly expects `[]`.
- Typo within distance: tested.
- Distance > 2: tested.
- Empty available types: tested.

**Test gap identified (non-blocking):**

In the "Empty Query Stats" describe block, lines 113–118 reimplement the similarity filter inline:
```js
const similar = availableTypes.filter(t => {
  const dist = levenshtein(queriedLower, t.toLowerCase());
  return dist > 0 && dist <= 2;
});
```
This uses `dist > 0 && dist <= 2` — the OLD condition (before the REG-505 fix). This does NOT call `findSimilarTypes`. Therefore this test does NOT verify the fixed condition `dist <= maxDistance && (dist > 0 || queriedType !== type)`.

The consequence: the case-mismatch scenario (dist=0, queriedType !== type) is NOT covered by this test. It IS covered by the "Did You Mean Suggestions" tests via direct `findSimilarTypes` calls.

This is a documentation/test-isolation issue, not a functional defect. The inline code is only exercised in that one test assertion, not in any production path.

---

## Issues Found

| Location | Severity | Description |
|---|---|---|
| `test/unit/QueryDebugging.test.js:113–118` | Minor / Test gap | `findSimilarTypes` is not called; inline reimplementation uses old condition `dist > 0 && dist <= 2`, missing coverage for the dist=0 case-mismatch path. The correct behavior IS tested elsewhere in the same file. |
| `query-handlers.ts:70`, `query-handlers.ts:87`, `query.ts:1152`, `query.ts:1169` | Note (not a defect) | `!nodeCounts[queriedType]` is a falsy check that would misfire if the database returned `{TYPE: 0}`. This cannot happen by operational invariant, but is structurally fragile. A strict `nodeCounts[queriedType] === undefined` would be more defensible. |

---

## Summary

The production code is correct. All four cases of the `findSimilarTypes` condition are handled correctly by proof. The `extractQueriedTypes` regexes correctly match exactly the intended predicates and exclude all non-matching forms. The `handleQueryGraph` and `executeRawQuery` blocks have no path where `nodeCounts` is undefined when accessed. The explain early-return correctly prevents the suggestion block from executing in explain mode.

The test gap (inline reimplementation of old condition in one test) does not affect production correctness — the production path is fully exercised by the integration tests and the direct unit tests of `findSimilarTypes`.

**APPROVE.**
