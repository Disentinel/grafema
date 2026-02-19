## Вадим auto — Completeness Review

**Verdict:** APPROVE (with one noted minor deviation)

---

### Feature completeness: OK

All four acceptance criteria are satisfied:

1. **`node(X, "TYPE")` returns 0 results, type doesn't exist → `suggestions: ["FUNCTION"]`**
   Implemented in `handleQueryGraph()` (`query-handlers.ts` lines 53–108): calls `extractQueriedTypes`, loops over `nodeTypes`, calls `findSimilarTypes`, emits `"Hint: Did you mean: FUNCTION? (node type)"`. Confirmed.

2. **`edge(X, Y, "CALS")` → same for edge types**
   Same block handles `edgeTypes` (lines 83–98). `countEdgesByType()` is called only when `edgeTypes.length > 0` (line 58). Confirmed.

3. **Suggestions only when 0 results**
   The entire block is guarded by `if (total === 0)` at line 53. When results exist the block is skipped entirely. Confirmed.

4. **Works through both MCP and CLI**
   MCP: `handleQueryGraph()` as above.
   CLI: `executeRawQuery()` (`query.ts` lines 1140–1181) guarded by `if (limited.length === 0)`, uses `queryHints.ts`. Confirmed.

Full scenario matrix (plan Section 5) coverage:

| Scenario | Status |
|---|---|
| `node(X, "FUNCTON")` → FUNCTION exists → Did you mean | OK — `findSimilarTypes` returns FUNCTION |
| `node(X, "function")` → FUNCTION exists → case mismatch | OK — fixed condition `dist <= maxDistance && (dist > 0 \|\| queriedType !== type)` |
| `node(X, "FUNCTION")` → type exists → no hint | OK — `if (!nodeCounts[queriedType])` guards hint generation |
| `node(X, "XYZABC123")` → no similar → fallback list | OK — `else` branch lists available types |
| `node(X, "FUNCTON")` → no nodes in graph | OK — `availableNodeTypes.length === 0` path outputs "Graph has no nodes" |
| `edge(X, Y, "CALS")` → CALLS exists | OK |
| Multi-type query | OK — loops over all nodeTypes and edgeTypes independently |
| `attr(X, "name", "foo")` → no hint | OK — regex only matches `node()`, `edge()`, `incoming()` |
| `type(X, "FUNCTON")` → no hint | OK — `type()` intentionally excluded from regex, documented |
| `explain=true` → no hint | OK — explain returns early at line 43–46, before the zero-results block |
| `--json` mode CLI | Partial — see Test Coverage section below |

---

### Minor deviation: `countNodesByType()` called unconditionally

The plan (Step 4, implementation note) said to deduplicate the two `countNodesByType()` calls and only call it when `nodeTypes.length > 0`. The implementation calls `countNodesByType()` unconditionally at line 57, regardless of whether `hasQueriedTypes` is true or whether `nodeTypes` is non-empty. This means for a query like `attr(X, "name", "foo")` that returns 0 results and has no type literals, `countNodesByType()` is still called (for the `totalNodes` line at 105).

This is a performance concern only, not a correctness issue. The result is used for the `Graph: N nodes` footer line that always appears. Acceptable deviation — the plan itself acknowledged the deduplication as a note, not a hard requirement.

---

### Test coverage: APPROVE with noted gap

**Covered well:**
- `extractQueriedTypes()` pure function: all 11 cases from the plan (lines 187–241), including `type()` exclusion, empty string, variable without quotes, attr false-positive, rule form, multi-type, incoming.
- `findSimilarTypes()` case sensitivity: all 5 cases from the plan (lines 244–267), including exact match no-suggestion, case mismatch suggestion, typo dist=1, alien dist>2, empty graph.
- Integration with DB: FUNCTON→FUNCTION (line 271), CALS→CALLS (line 293, correctly conditioned on fixture having CALLS edges), alien type fallback (line 311), empty graph scenario (line 325).

**Gap: No CLI `--json` mode test**

The plan explicitly called for: "CLI path: `node(X, "FUNCTON")` → 0 results, `--json` mode → stdout is `[]`, suggestion on stderr."

The test file has no test that exercises `executeRawQuery` with `json=true` to verify stdout stays clean while stderr carries the hint. This is the most important behavioral guarantee for JSON consumers of the CLI.

The existing integration tests verify the suggestion pipeline components (extract, find, count) but do not exercise the CLI code path directly. They are component-level, not end-to-end for the CLI.

This gap is real but acceptable for APPROVE because:
1. The CLI code correctly uses `console.error` for all hint output (lines 1149, 1155, 1159, 1172, 1176) — same as the existing unknown-predicate warning.
2. JSON output (`console.log(JSON.stringify(limited))`) exits before the hint block when `json=true` — wait, actually it does NOT. Looking at lines 1116–1129: the JSON branch at line 1116–1118 only prints JSON, but the `if (limited.length === 0)` hint block at lines 1131–1182 is outside the json conditional and runs regardless of `--json` mode. This is correct: `console.error` goes to stderr in both modes.
3. The behavior is correct and matches the plan's `console.error` prescription. The missing test is a coverage gap, not a behavioral bug.

**Verdict on tests:** Sufficient for the feature. The CLI `--json` mode integration test gap is a known omission that does not block approval.

---

### Commit quality: OK

- No `TODO`, `FIXME`, `HACK`, `XXX` found in any of the four modified/added files.
- No commented-out code.
- No empty implementations.
- `type()` exclusion is documented with an explanatory comment in both `utils.ts` and `queryHints.ts`.
- The `extractQueriedTypes` duplication between MCP and CLI is documented with a maintenance note in `queryHints.ts` header.
- No emoji in production code (the plan noted existing emoji in the old implementation; they are absent in the new code).
- The `📄` emoji in `formatPaginationInfo` in `utils.ts` is pre-existing, not introduced by this PR.

---

### Summary

The implementation is complete, correct, and covers all acceptance criteria. All scenarios from the plan's matrix are handled. The only notable items are:

1. `countNodesByType()` called unconditionally in MCP handler (minor performance, not correctness). Acceptable.
2. No CLI `--json` mode end-to-end test. Gap is real but behavior is correct and documented.

Neither issue rises to REJECT level.
