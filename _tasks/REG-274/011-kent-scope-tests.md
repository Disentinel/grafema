# Kent Beck: Scope CONTAINS Edges Tests Report

## Summary

Created test file `/Users/vadimr/grafema-worker-3/test/unit/ScopeContainsEdges.test.js` with 16 test cases covering the scope tracking fix for REG-274.

## Test File Location

```
test/unit/ScopeContainsEdges.test.js
```

## Test Coverage

### 1. Call inside if statement (2 tests)
- `should link call to if-scope via CONTAINS edge` - Verifies parentScopeId points to if-scope
- `should preserve semantic ID with if-scope in path` - Verifies semantic ID format includes if#N

### 2. Call inside nested if statements (2 tests)
- `should link call to innermost if-scope` - Verifies nested if scopes (if#0->if#0) in ID
- `should link calls at different nesting levels to correct scopes` - Multiple calls at different depths

### 3. Call inside else block (2 tests)
- `should link call to else-scope via CONTAINS edge` - Verifies else-scope in parentScopeId
- `should distinguish if-scope from else-scope` - Verifies different parentScopeIds for if/else

### 4. Call inside for loop (3 tests)
- `should link call to for-loop scope via CONTAINS edge` - Verifies loop-scope in parentScopeId
- `should handle while loop scope` - While loop coverage
- `should handle nested loop and conditional` - for + if combination

### 5. Call outside conditional (function body) (2 tests)
- `should link call to function body scope` - No conditional scope in parentScopeId
- `should handle mix of conditional and non-conditional calls` - before/inside/after if

### 6. Variable inside conditional scope (2 tests)
- `should link variable to if-scope via parentScopeId` - Variable declared in if block
- `should link variable to loop scope` - Variable declared in loop

### 7. Try/catch/finally scopes (2 tests)
- `should link call in try block to try-scope` - try vs catch differentiation
- `should link call in finally block to finally-scope` - finally scope coverage

### 8. CONTAINS edge verification (1 test)
- `should create CONTAINS edge from correct scope to call` - Edge source matches parentScopeId

## Test Approach

Per TDD methodology, tests are written to **fail initially** until Rob implements the fix.

Key assertions verify:
1. `parentScopeId` on CallSiteInfo/VariableDeclarationInfo contains correct scope ID
2. CONTAINS edge `src` field matches the `parentScopeId`
3. Semantic IDs include correct scope path (e.g., `file->func->if#0->CALL->name#0`)

## Current Status

**Tests will fail** because:
- `parentScopeId` is currently undefined on call nodes (line 111 assertion)
- CONTAINS edges currently point to function body scope, not conditional scope

The semantic ID already includes conditional scope in path (test 2 passes), but the `parentScopeId` field and CONTAINS edge source need to be fixed.

## Verified Test Execution

Initial test run shows:
- Test 1 fails: `deleteAllRecords should have parentScopeId` - Expected, parentScopeId is undefined
- Test 2 passes: Semantic ID already includes `if#` in path

This confirms tests correctly detect the issue described in the spec.

## Recommendations for Rob

1. Add `scopeIdStack` in `analyzeFunctionBody` as per Joel's spec
2. Update conditional scope handlers to push/pop scope IDs
3. Pass `getCurrentScopeId()` to call/variable handlers instead of fixed `parentScopeId`
4. Run `node --test test/unit/ScopeContainsEdges.test.js` to verify fix

## Files Changed

- `test/unit/ScopeContainsEdges.test.js` - Created (16 test cases)
