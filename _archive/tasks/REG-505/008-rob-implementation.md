# REG-505: Rob Pike Implementation Report

## Summary

Implemented "Did you mean" suggestions for Datalog queries with misspelled types, covering both the MCP handler and the CLI raw query path. The implementation follows the Don Melton plan v2 exactly.

## What Was Already Done (Prior Work)

Steps 1-4 from the plan were already implemented before this session:

1. **`findSimilarTypes()` fix** in `packages/mcp/src/utils.ts` (line 111) -- condition already changed from `dist > 0 && dist <= maxDistance` to `dist <= maxDistance && (dist > 0 || queriedType !== type)`.

2. **`extractQueriedTypes()` added** to `packages/mcp/src/utils.ts` (lines 119-139) -- pure function that extracts node/edge types from Datalog query strings via regex. Only matches `node()` (not `type()`). Matches `edge()` and `incoming()` for edge types.

3. **MCP exports** -- `@grafema/mcp` package.json already exports `./utils` path, making `extractQueriedTypes` accessible.

4. **`handleQueryGraph()` rewritten** in `packages/mcp/src/handlers/query-handlers.ts` (lines 53-108) -- imports `extractQueriedTypes`, extracts all queried types, provides edge type suggestions via `countEdgesByType()`, adds empty graph guard, removes emoji, consolidates `countNodesByType()` into a single call.

5. **Tests already added** to `test/unit/QueryDebugging.test.js` -- `describe('Did You Mean Suggestions')` block with pure unit tests for `extractQueriedTypes`, case-sensitivity tests for `findSimilarTypes`, and integration tests with DB fixtures.

## What I Implemented

### Step 5: Created `packages/cli/src/utils/queryHints.ts`

New file with private copies of `extractQueriedTypes` and `findSimilarTypes` for CLI use. The CLI cannot import from `@grafema/mcp` (dependency direction: CLI depends on core, not on MCP). Uses `levenshtein` from `@grafema/core`. Documented the duplication with a header comment explaining the constraint.

### Step 6: Added suggestion logic to CLI `executeRawQuery()`

In `packages/cli/src/commands/query.ts`:

- Added import: `import { extractQueriedTypes, findSimilarTypes } from '../utils/queryHints.js';`
- Added suggestion logic after the existing unknown-predicate warning block, inside the `if (limited.length === 0)` branch
- All output goes to `console.error` (safe for `--json` mode, consistent with existing unknown-predicate warning pattern)
- Handles: node type typos, edge type typos, empty graph (no nodes/edges), completely alien types (falls back to listing available types), multiple queried types in a single query
- `explain=true` is unaffected (returns early at line 1102, before the suggestion block)

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/utils/queryHints.ts` | **New file**: private `extractQueriedTypes()` + `findSimilarTypes()` for CLI use |
| `packages/cli/src/commands/query.ts` | Added import for queryHints, added type suggestion logic to `executeRawQuery()` zero-results branch |

## Files Not Changed (Already Done)

| File | Status |
|------|--------|
| `packages/mcp/src/utils.ts` | `findSimilarTypes` fix + `extractQueriedTypes` already present |
| `packages/mcp/src/handlers/query-handlers.ts` | `handleQueryGraph()` already rewritten with full suggestion logic |
| `test/unit/QueryDebugging.test.js` | "Did You Mean Suggestions" tests already present |

## Build Results

```
pnpm build -- all packages compiled successfully (0 errors)
```

## Test Results

```
node --test test/unit/QueryDebugging.test.js
# tests 32
# suites 9
# pass 32
# fail 0
# duration_ms 2854
```

All 32 tests pass including all "Did You Mean Suggestions" tests:
- `extractQueriedTypes` pure function tests (11 tests)
- `findSimilarTypes` case sensitivity tests (5 tests)
- Integration tests with DB fixture (4 tests)

## Behavior Coverage

| Scenario | MCP | CLI |
|----------|-----|-----|
| Misspelled node type (FUNCTON -> FUNCTION) | "Did you mean: FUNCTION? (node type)" | stderr: `Note: unknown node type "FUNCTON". Did you mean: FUNCTION?` |
| Case mismatch (function -> FUNCTION) | "Did you mean: FUNCTION? (node type)" | stderr: `Note: unknown node type "function". Did you mean: FUNCTION?` |
| Misspelled edge type (CALS -> CALLS) | "Did you mean: CALLS? (edge type)" | stderr: `Note: unknown edge type "CALS". Did you mean: CALLS?` |
| Completely alien type | "Available node types: ..." | stderr: `Note: unknown node type "...". Available: ...` |
| Empty graph | "Graph has no nodes" | stderr: `Note: graph has no nodes` |
| `type()` predicate | No suggestion (excluded by design) | No suggestion (excluded by design) |
| `--json` mode | N/A (MCP is always structured) | stdout: `[]`, suggestions on stderr |
| `--explain` mode | Returns early, no suggestions | Returns early, no suggestions |
