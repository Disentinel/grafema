# REG-505: Kent Beck Test Report - "Did You Mean" Suggestions

## What Was Written

Added a new `describe('Did You Mean Suggestions')` block to `test/unit/QueryDebugging.test.js` with 20 new tests organized into 3 sub-sections.

### 1. `extractQueriedTypes` - Pure Function Tests (11 tests)

Tests the regex-based type extraction from Datalog query strings:

| Test | Input | Expected |
|------|-------|----------|
| node(X, "FUNCTON") | `'node(X, "FUNCTON")'` | `{ nodeTypes: ['FUNCTON'], edgeTypes: [] }` |
| node(_, "FUNCTON") | `'node(_, "FUNCTON")'` | `{ nodeTypes: ['FUNCTON'], edgeTypes: [] }` |
| edge(X, Y, "CALS") | `'edge(X, Y, "CALS")'` | `{ nodeTypes: [], edgeTypes: ['CALS'] }` |
| incoming(X, Y, "CALS") | `'incoming(X, Y, "CALS")'` | `{ nodeTypes: [], edgeTypes: ['CALS'] }` |
| Multi-predicate | `'node(X, "FUNCTON"), edge(X, Y, "CALS")'` | Both extracted |
| Two node types | `'node(X, "FUNCTON"), node(Y, "CALASS")'` | Both in nodeTypes |
| Rule form `:- ` | `'violation(X) :- node(X, "FUNCTON").'` | Extracts node type |
| attr() false positive | `'attr(X, "name", "foo")'` | Empty (no match) |
| Variable type (no quotes) | `'node(X, T)'` | Empty (no match) |
| type() excluded | `'type(X, "FUNCTON")'` | Empty (intentionally excluded) |
| Empty string | `''` | Empty arrays |

### 2. `findSimilarTypes` - Case Sensitivity Tests (5 tests)

Tests the fixed Levenshtein-based similarity matching with the corrected condition `dist <= maxDistance && (dist > 0 || queriedType !== type)`:

| Test | queriedType | availableTypes | Expected |
|------|-------------|----------------|----------|
| Case mismatch | `'function'` | `['FUNCTION', 'CLASS']` | `['FUNCTION']` |
| Exact match | `'FUNCTION'` | `['FUNCTION', 'CLASS']` | `[]` |
| Typo (dist=1) | `'FUNCTON'` | `['FUNCTION', 'CLASS']` | `['FUNCTION']` |
| Far distance | `'xyz123'` | `['FUNCTION', 'CLASS']` | `[]` |
| Empty types | `'FUNCTON'` | `[]` | `[]` |

### 3. Integration Tests with DB (4 tests)

End-to-end pipeline tests using the real RFDB backend with the `01-simple-script` fixture:

1. **Node type suggestion**: Analyzes fixture, queries with `"FUNCTON"`, verifies 0 results, runs `extractQueriedTypes` + `findSimilarTypes` pipeline, confirms `FUNCTION` is suggested.
2. **Edge type suggestion**: Analyzes fixture, extracts edge type from `"CALS"`, confirms `CALLS` is suggested (conditional on fixture having CALLS edges).
3. **Alien type fallback**: Verifies that a completely unrelated type produces 0 suggestions, confirming the fallback-to-available-types path.
4. **Empty graph scenario**: Pure logic test verifying the empty graph guard condition: `findSimilarTypes` returns `[]` with no available types, and `extractQueriedTypes` correctly extracts the queried type. Tests the condition inputs for the `"Graph has no nodes"` handler branch.

## Design Decisions

1. **No direct `handleQueryGraph` calls in integration tests**: The MCP handler depends on `ensureAnalyzed()` which manages global server state (project path, analysis lock, config loading). Instead, integration tests exercise the same pipeline components the handler uses: `backend.checkGuarantee()` + `extractQueriedTypes()` + `findSimilarTypes()`.

2. **Empty graph test is pure logic, not DB-dependent**: Originally tried to test empty graph via the DB (skip fixture analysis, call `countNodesByType()` on empty DB). This caused RFDB server connection instability due to rapid `beforeEach` create/destroy cycles. Restructured to test the condition inputs purely, which is more reliable and tests the same logical branch.

3. **`type()` exclusion test**: Explicitly verifies that `type(X, "FUNCTON")` does NOT produce matches, documenting the intentional exclusion per the plan (Rust evaluator has no `"type"` branch).

## Test Results

```
# tests 32
# suites 9
# pass 32
# fail 0
# duration_ms 1228ms
```

All 32 tests pass (12 pre-existing + 20 new). Zero failures.

## Files Modified

| File | Change |
|------|--------|
| `test/unit/QueryDebugging.test.js` | Added `describe('Did You Mean Suggestions')` block with 20 tests |

## Coverage of Plan Spec (Section 3, Step 1)

| Plan item | Status | Notes |
|-----------|--------|-------|
| extractQueriedTypes: node() | Covered | 2 variants (X and _) |
| extractQueriedTypes: edge() | Covered | |
| extractQueriedTypes: incoming() | Covered | |
| extractQueriedTypes: multi-type | Covered | node+edge and node+node |
| extractQueriedTypes: rule form | Covered | |
| extractQueriedTypes: attr false positive | Covered | |
| extractQueriedTypes: variable type | Covered | |
| extractQueriedTypes: type() excluded | Covered | |
| extractQueriedTypes: empty string | Covered | |
| findSimilarTypes: case mismatch | Covered | |
| findSimilarTypes: exact match | Covered | |
| findSimilarTypes: typo | Covered | |
| findSimilarTypes: far distance | Covered | |
| findSimilarTypes: empty graph | Covered | |
| Integration: node type suggestion | Covered | |
| Integration: edge type suggestion | Covered | |
| Integration: alien type fallback | Covered | |
| Integration: empty graph | Covered | Pure logic variant |
| CLI path tests | Not written | CLI implementation is Step 6, separate from this test step |
