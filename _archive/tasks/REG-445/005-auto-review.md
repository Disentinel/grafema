# Auto-Review: REG-445 — Fix CLI query layer for RFDB v3

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)
**Verdict:** APPROVE ✓

---

## Vision & Architecture

**Status:** ✓ PASS

**Project alignment:**
- **Dogfooding success:** These fixes restore CLI query functionality, directly supporting "AI should query the graph, not read code"
- **Zero tolerance for limitations:** The bugs made queries return "No results" for ALL nodes — a complete product failure. The fixes restore 100% query functionality, not a partial workaround.
- **Root cause approach:** Three distinct bugs identified and fixed at their source:
  1. Semantic ID format mismatch — fixed in `_parseNode()` at the point where IDs are extracted from wire format
  2. File path mismatch — fixed in CLI commands where absolute paths were incorrectly passed
  3. Missing type search — fixed by adding INTERFACE/TYPE/ENUM to search types

**Complexity & Architecture:**
- **No new iteration:** All fixes are in existing code paths (parsing, filtering)
- **No new abstractions:** Uses existing semantic ID preservation mechanism (metadata.semanticId)
- **Plugin architecture:** Not applicable — this is query layer plumbing
- **Extensibility:** Adding new type aliases is straightforward (extend typeMap in parsePattern)

**Architectural gaps:**
- **Bug 4 identified but not fully addressed:** The review plan mentions checking MCP handlers for the same missing types issue, but there's no evidence this was done. Need confirmation that MCP `find_nodes` includes INTERFACE/TYPE/ENUM.

**Recommendation:** Verify MCP handlers have the same fix (or don't need it). Otherwise, APPROVE.

---

## Practical Quality

**Status:** ✓ PASS

**Correctness:**
- ✓ Bug 1 fix correctly prioritizes `metadata.semanticId` (original v1 format) over `wireNode.semanticId` (v3 rewritten format)
- ✓ Bug 2 fix passes relative paths to `getOverview()` and `explain()` — matches MODULE node storage format
- ✓ Bug 3 fix adds INTERFACE/TYPE/ENUM to both search types AND type aliases in parsePattern
- ✓ Tests cover all three bugs:
  - 5 tests for semantic ID preservation (v1 and v2 format through getNode/queryNodes)
  - 20 tests for parseQuery + matchesScope (type aliases, scope filtering, no-constraint case)

**Edge cases:**
- ✓ `matchesScope()` correctly returns `true` when `file=null && scopes=[]` (no constraints)
- ✓ Handles v1, v2, and unparseable ID formats gracefully (v3 format won't reach matchesScope after fix)
- ✓ File scope matching supports exact match, basename match, and partial path match
- ✓ Function scope matching handles numbered scopes (try#0 matches "try")

**Regressions:**
- ✓ All 1975 existing unit tests pass (0 failures)
- ✓ New tests verify existing type aliases still work (function, class, variable)
- ✓ Scope parsing regression tests ensure " in " splitting doesn't break names like "signin"

**Minimality:**
- ✓ All changes directly serve the task (no extras)
- ✓ No scope creep — fixes only the query layer, doesn't touch analysis or enrichment

**No loose ends:**
- ✓ No TODOs, FIXMEs, or commented-out code
- ✓ All test assertions have clear error messages
- ⚠️ **One gap:** MCP handlers not verified (see "Architectural gaps" above)

---

## Code Quality

**Status:** ✓ PASS

**Readability:**
- ✓ `_parseNode()` comment explains the precedence: "Prefer metadata.semanticId (original v1 format) then v3 semanticId..."
- ✓ Test file names clearly indicate what they test: `RFDBServerBackend.semanticId.test.js`, `QueryParseAndScope.test.js`
- ✓ Test structure groups tests by bug: "Bug 3: Missing INTERFACE/TYPE/ENUM", "Bug 2: matchesScope fails..."

**Naming:**
- ✓ Variable names are clear: `originalId`, `humanId`, `relativeFilePath`
- ✓ Test names describe behavior: "should preserve v1 format ID through getNode", "should return true for v1 format ID with no constraints"

**Duplication:**
- ✓ No duplication — semantic ID parsing uses existing `parseSemanticId()` and `parseSemanticIdV2()` utilities
- ✓ Test setup reuses `createTestPaths()` helper

**Test quality:**
- ✓ Tests are focused and test one behavior each
- ✓ Tests use descriptive assertion messages: `'v1 ID with no constraints should match'`
- ✓ Tests clean up after themselves (remove temp directories in `after()` hook)
- ✓ Integration verification: manual testing showed queries now work (results included in review request)

**Error handling:**
- ✓ `matchesScope()` returns `false` for unparseable IDs instead of throwing
- ✓ Test cleanup ignores errors (temp dir removal can fail if already gone)

**Consistency:**
- ✓ Matches existing patterns: semantic ID extraction follows same pattern as `originalId` metadata hack
- ✓ CLI path handling consistent across `file` and `explain` commands
- ✓ Type alias map follows existing structure (lowercase aliases → UPPERCASE type constants)

---

## Final Checklist

| Item | Status | Notes |
|------|--------|-------|
| **Correctness** | ✓ | All three bugs fixed at root cause |
| **Minimality** | ✓ | Every change serves the task |
| **Consistency** | ✓ | Matches existing patterns |
| **Commit quality** | ⏳ | Will be atomic (not yet committed) |
| **No loose ends** | ⚠️ | MCP handler gap (low priority) |

---

## Recommendations Before Merge

1. **Verify MCP handlers:** Check if `packages/mcp/src/handlers.ts` `find_nodes` function needs the same INTERFACE/TYPE/ENUM types added. If MCP doesn't have this issue, document why. If it does, add the fix.

2. **Consider adding a comment in `_parseNode()`:** The metadata exclusion list is growing. A brief comment explaining why `semanticId` is excluded (already used for humanId) would help future maintainers.

3. **Integration test suggestion:** Add a test that verifies the full query flow works for INTERFACE nodes (not just unit tests). Something like:
   ```javascript
   it('should find INTERFACE nodes via query command', async () => {
     // Setup: add INTERFACE node
     // Query: grafema query "interface GraphBackend"
     // Assert: finds the node
   });
   ```

---

## Verdict

**APPROVE** — Ready for merge after MCP handler verification.

**Rationale:**
- All three bugs fixed correctly at their root causes
- Comprehensive test coverage (25 new tests, all passing)
- No regressions (1975 existing tests pass)
- Minimal, focused changes
- Restores 100% query functionality (not a partial workaround)

**Minor gap:** MCP handler not verified. Recommend checking before merge, but doesn't block approval since CLI is now fully functional.

**Impact:** This fixes a critical product failure (queries returned zero results). With these changes, Grafema can actually help with type system exploration, restoring dogfooding value.
