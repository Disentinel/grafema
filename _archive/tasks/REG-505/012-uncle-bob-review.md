## Uncle Bob — Code Quality Review

**Verdict:** APPROVE (with observations)

---

### File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/mcp/src/utils.ts` | 226 | OK |
| `packages/mcp/src/handlers/query-handlers.ts` | 321 | OK |
| `packages/cli/src/utils/queryHints.ts` | 46 | OK |
| `packages/cli/src/commands/query.ts` | 1220 | CRITICAL — pre-existing, not caused by this PR |
| `test/unit/QueryDebugging.test.js` | 386 | OK |

`query.ts` at 1220 lines violates the hard limit. However, the REG-505 changes are confined to:
- import of `extractQueriedTypes, findSimilarTypes` (line 20)
- the suggestion block inside `executeRawQuery` (~lines 1131–1182)

The excess is pre-existing and was not introduced by this task. The concern is noted but is out of scope for this review.

---

### Method Quality

**`extractQueriedTypes` (utils.ts, ~20 lines) — GOOD**
Single responsibility, stateless, correctly documented. The comment explaining why
`type(VAR, "TYPE")` is intentionally excluded is important context that belongs exactly
here — this is the right place for it.

**`findSimilarTypes` (utils.ts, ~17 lines) — GOOD**
Simple, clean, correct. The condition `dist > 0 || queriedType !== type` handles both the
case-mismatch suggestion (dist > 0 across lowercase comparison) and the exact-match
exclusion. The logic is subtle but documented by tests.

**`levenshtein` (utils.ts, ~25 lines) — GOOD**
Textbook DP implementation. Clear variable names (`m`, `n`, `dp`, `cost`). No issues.

**`handleQueryGraph` zero-results block (query-handlers.ts, lines 53–108) — ONE ISSUE**

The node/edge hint-building logic (lines 63–98) is duplicated between:
- `handleQueryGraph` in `query-handlers.ts`
- `executeRawQuery` in `query.ts` (lines 1140–1181)

Both blocks perform the same algorithm:
1. Extract types from query
2. Fetch available counts
3. For each queried type: find similar or list available
4. Format hint lines

This is the same pattern repeated twice, ~40 lines each. The `findSimilarTypes` and
`extractQueriedTypes` helpers were correctly extracted, but the *orchestration* that
calls them was not. A `buildTypeHints(query, nodeCounts, edgeCounts)` pure function
would eliminate the duplication. This does not rise to a REJECT because:
- The duplication is in two separate packages that cannot import each other
- The file-level comment in `queryHints.ts` explicitly acknowledges the cross-package
  constraint and the intentional duplication of `extractQueriedTypes`

The orchestration duplication, however, is *within* the logic flow and could be
factored into `queryHints.ts` as a `buildTypeHintLines(...)` helper, callable from
both. This is an improvement, not a blocker.

**`executeRawQuery` (query.ts, lines 1096–1183) — ACCEPTABLE**
The method is 87 lines. Above the 50-line guideline but not egregiously so. The
structure is: early-exit explain path, main results path, then the zero-results
diagnostics block. Three distinct phases, clearly separated. The length is partially
driven by the diagnostic block that should ideally be extracted (see above).

No forbidden nested-function parameters or excessive nesting (max depth ~3 in the
type-suggestion loops).

---

### Patterns and Naming

**Naming — GOOD**
`extractQueriedTypes`, `findSimilarTypes`, `buildTypeHints` — all names accurately
describe intent. `hintLines`, `similar`, `queriedType`, `availableNodeTypes` — all
clear. No abbreviations, no magic names.

**`hint` variable (query-handlers.ts, line 62) — MINOR**
The variable starts as `''` and is only written if `hasQueriedTypes && hintLines.length > 0`.
This is a mutable variable inside a conditional block, assembled via string concatenation.
A cleaner pattern would be early-computed or function-extracted. However, this is a
style matter, not a defect.

**`hintLines` array (query-handlers.ts) — GOOD**
Collecting into an array then joining with `map(l => ...)` is correct. The `l` loop
variable is a one-letter shorthand but it is a terminal consumer, not a logic variable —
acceptable.

**`more` variable (e.g., line 76) — MINOR**
```ts
const more = availableNodeTypes.length > 10 ? '...' : '';
```
The name `more` is slightly vague. `ellipsis` or `suffix` would be more precise. Minor.

**No forbidden patterns** — no `TODO`, `FIXME`, `HACK`, `XXX`, no mock/stub outside
tests, no commented-out code, no empty implementations.

---

### Test Quality

The "Did You Mean Suggestions" test describe block is well-structured:

1. **Pure function tests** — `extractQueriedTypes` and `findSimilarTypes` tested in
   isolation with representative and edge cases.
2. **Integration tests** — pipeline tested against an actual DB.
3. **Negative cases** — alien type with no suggestions, empty graph, empty available
   types. These are present and cover the fallback paths.

Test naming communicates intent well: "should suggest FUNCTION for case mismatch
'function'", "should not match type() predicate (excluded intentionally)".

One observation: the integration test for CALS/CALLS (lines 293–309) is conditionally
skipped with `if (hasCallsEdges)`. This is acceptable given that the fixture may not
always produce CALLS edges, but it means the test may never actually assert anything.
A comment explaining when CALLS edges are expected (or a guaranteed fixture) would
improve confidence. This is advisory, not a blocker.

The "empty graph scenario" test (lines 325–336) is interesting — it verifies the
*condition inputs* rather than the integrated behavior. The comment explains the intent.
This is acceptable as a structural/logic verification test, though it is closer to
a documentation test than a behavioral one.

---

### Cross-Package Duplication Policy

The file-level comment in `queryHints.ts` explicitly acknowledges the copy of
`extractQueriedTypes` and explains the dependency direction constraint. This is the
correct approach — document it, don't fight the module boundary. The comment is clear
and actionable ("If the Datalog syntax changes, both copies must be updated").

This is an example of the right trade-off between DRY and architectural correctness.
The decision is sound.

---

### Summary

The implementation is clean, well-named, and the new helpers are properly extracted
and tested. The main observation is that the hint-orchestration logic (the loop over
queried types to produce hint lines) is duplicated across the MCP and CLI paths. This
is an improvement opportunity rather than a defect, given the acknowledged package
boundary constraint.

No forbidden patterns. No over-abstraction. No quick fixes or workarounds disguised
as features. The `type()` exclusion is documented at the point of decision.

**Verdict: APPROVE**
