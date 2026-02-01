# REG-227: Kent Beck - Test Report

## Summary

Added 4 new test cases and updated 1 existing test for the `CallResolverValidator` changes as specified in Joel's tech spec. All 5 tests fail as expected - this is correct TDD behavior since the implementation has not been done yet.

## Tests Added

### New Test Section: "REG-227: Resolution Type Categorization"

Located at lines 840-1005 in `/Users/vadimr/grafema-worker-7/test/unit/CallResolverValidator.test.js`

#### Test 1: Built-in calls not reported as warnings
```javascript
it('should NOT flag JavaScript built-in function calls', async () => { ... })
```
- **Purpose**: Verify that `parseInt`, `setTimeout`, `require` are recognized as built-ins
- **Expected behavior**: 0 errors, summary shows `resolvedBuiltin: 3`
- **Current failure**: Reports 3 errors (built-ins incorrectly flagged as unresolved)

#### Test 2: External package calls not reported
```javascript
it('should NOT flag external package calls with CALLS edges', async () => { ... })
```
- **Purpose**: Verify CALLS edges to EXTERNAL_MODULE nodes are recognized
- **Expected behavior**: 0 errors, summary shows `resolvedExternal: 1`
- **Current failure**: `summary.resolvedExternal` is undefined (field doesn't exist)

#### Test 3: Unresolved calls as warnings
```javascript
it('should flag truly unresolved calls as warnings (not errors)', async () => { ... })
```
- **Purpose**: Verify unresolved calls have severity `warning` and code `WARN_UNRESOLVED_CALL`
- **Expected behavior**: 1 warning with correct severity and code
- **Current failure**: Error code is `ERR_UNRESOLVED_CALL` instead of `WARN_UNRESOLVED_CALL`

#### Test 4: Mixed resolution types summary
```javascript
it('should correctly categorize mixed resolution types in summary', async () => { ... })
```
- **Purpose**: Verify summary correctly categorizes internal, external, builtin, method, unresolved
- **Expected behavior**: Summary with all new fields populated correctly
- **Current failure**: Summary lacks the new categorized fields

### Updated Test: eval/Function handling

Located at lines 396-431 in the "Edge Cases - Dynamic and Computed Calls" section.

**Before (original test name)**: "should flag eval/Function constructor calls"
**After (updated test name)**: "should handle eval as builtin but flag Function constructor"

```javascript
it('should handle eval as builtin but flag Function constructor', async () => { ... })
```
- **Purpose**: Verify `eval` is recognized as built-in but `Function` constructor is flagged
- **Expected behavior**: 1 error (only Function), `summary.resolvedBuiltin: 1`
- **Current failure**: Reports 2 errors (both eval and Function flagged)

## Test Pattern

All new tests follow the existing pattern:
1. Use `setupTest()` helper to create test environment
2. Add nodes manually via `backend.addNodes()`
3. Add edges via `backend.addEdge()` when needed
4. Call `backend.flush()`
5. Import and instantiate `CallResolverValidator` from `@grafema/core`
6. Call `validator.execute()` with graph context
7. Assert on `result.errors` and `result.metadata.summary`
8. Clean up via `backend.close()` in finally block

## Test Execution Results

```
REG-227: Resolution Type Categorization
  NOT OK - should NOT flag JavaScript built-in function calls
    error: 'Built-in calls should not be flagged'
    expected: 0, actual: 3

  NOT OK - should NOT flag external package calls with CALLS edges
    error: 'Should count 1 external call'
    expected: 1, actual: undefined

  NOT OK - should flag truly unresolved calls as warnings (not errors)
    error: Expected 'ERR_UNRESOLVED_CALL' to equal 'WARN_UNRESOLVED_CALL'

  NOT OK - should correctly categorize mixed resolution types in summary
    error: 'Should count 1 internal'
    expected: 1, actual: undefined

Edge Cases - Dynamic and Computed Calls
  NOT OK - should handle eval as builtin but flag Function constructor
    error: 'Only Function should be flagged'
    expected: 1, actual: 2
```

## Files Modified

- `/Users/vadimr/grafema-worker-7/test/unit/CallResolverValidator.test.js`
  - Updated test at line 396 (eval/Function test)
  - Added new test section at line 840 (REG-227: Resolution Type Categorization)

## Next Steps

Implementation by Rob:
1. Create `jsGlobals.ts` with `JS_GLOBAL_FUNCTIONS` constant
2. Update `builtins/index.ts` to export it
3. Update `ExternalCallResolver.ts` to import from shared location
4. Rewrite `CallResolverValidator.ts` with new resolution categorization

After implementation, all 5 tests should pass.
