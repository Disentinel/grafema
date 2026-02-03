# Rob Implementation Report - REG-321

## Summary

Added MAKES_REQUEST edge from CALL nodes to http:request nodes in FetchAnalyzer.

## Changes

### `packages/core/src/plugins/analysis/FetchAnalyzer.ts`

1. **Added `getExpectedCallNames()` helper method** (lines 512-531)
   - Returns expected CALL node names based on library and HTTP method
   - For `fetch` library: returns `['fetch']`
   - For `axios` library: returns `['axios.get', 'axios']` (or appropriate method)
   - For custom wrappers: returns the library name (e.g., `['authFetch']`)

2. **Added CALL node linking logic** (lines 386-402)
   - After creating MAKES_REQUEST edge from FUNCTION to http:request
   - Queries all CALL nodes and finds matching one by:
     - Same file path
     - Same line number
     - Matching call name (from expectedCallNames)
   - Creates MAKES_REQUEST edge from CALL to http:request

## Graph Structure (Updated)

Before:
```
FUNCTION --MAKES_REQUEST--> http:request
```

After:
```
FUNCTION --MAKES_REQUEST--> http:request
CALL --MAKES_REQUEST--> http:request
```

## Tests

Added new test file `test/unit/FetchAnalyzerCallEdge.test.js` with 3 tests:
1. `should create MAKES_REQUEST edge from CALL node for fetch()` ✓
2. `should create MAKES_REQUEST edge from axios.get() CALL node` ✓
3. `should create MAKES_REQUEST edge from custom wrapper authFetch()` ✓

Also added tests to existing `test/unit/plugins/analysis/FetchAnalyzer.test.ts` for TypeScript coverage.

## Complexity

O(n) where n = number of CALL nodes in the module. This is acceptable since:
- CALL node iteration is already done for other purposes
- Most modules have a reasonable number of CALL nodes
- The lookup is bounded by module scope (same file)

## Verification

```bash
node test-fetch-call.js
```

Output shows both edges:
```
=== MAKES_REQUEST EDGES ===
  FUNCTION(fetchUsers) --> http:request
  CALL(fetch) --> http:request
```
