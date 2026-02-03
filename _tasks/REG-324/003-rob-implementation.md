# Rob Implementation Report - REG-324

## Summary

Fixed `findResponseJsonCall()` to link to the correct `response.json()` call when multiple functions in the same file use the same variable name.

## Changes

### `packages/core/src/plugins/analysis/FetchAnalyzer.ts`

1. **Updated `findResponseJsonCall()` signature** - Added `fetchLine` parameter

2. **Implemented scope-aware filtering**:
   - Collect all matching CALL nodes (file, object name, consumption method)
   - Filter to only those with `line > fetchLine` (comes AFTER the fetch call)
   - Sort by line number and return the closest match

3. **Updated call site** - Pass `request.line` to `findResponseJsonCall()`

## Before vs After

**Before**: Returns the FIRST `response.json()` in the file matching variable name
```
fetchUsers (line 4: fetch) → response.json (line 12) ❌ WRONG
fetchPosts (line 11: fetch) → response.json (line 12) ✓
```

**After**: Returns the CLOSEST `response.json()` AFTER the fetch line
```
fetchUsers (line 4: fetch) → response.json (line 5) ✓
fetchPosts (line 11: fetch) → response.json (line 12) ✓
```

## Tests

New test file `test/unit/FetchAnalyzerResponseDataNode.test.js`:
1. `should link to correct response.json() when multiple functions use same variable name` ✓
2. `should link to closest response.json() after fetch call` ✓

## Complexity

Same O(n) complexity, just with post-filtering and sorting (O(n log n) for sort, but n is typically small - number of matching calls in file).
