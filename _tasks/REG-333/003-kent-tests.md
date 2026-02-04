# REG-333: Kent Beck Test Report

## Summary

Created TDD tests for ExpressRouteAnalyzer wrapper unwrapping functionality. Tests are designed to fail until the implementation is complete - this is proper TDD.

## Test File

**Created**: `/Users/vadimr/grafema-worker-1/test/unit/plugins/analysis/ExpressRouteAnalyzer-wrapper.test.ts`

## Test Cases

### 1. `asyncHandler(async (req, res) => {...})` - Async Arrow Function Wrapper
- **What it tests**: Standard async handler wrapper pattern (~3M weekly downloads)
- **Expected**: HANDLED_BY points to inner arrow function at line 5, not asyncHandler CallExpression
- **Status**: FAILS (as expected - no HANDLED_BY edge created because no FUNCTION at asyncHandler position)

### 2. `catchAsync((req, res) => {...})` - Non-async Wrapper
- **What it tests**: Synchronous wrapper pattern
- **Expected**: HANDLED_BY points to inner arrow function
- **Status**: FAILS

### 3. `wrapAsync(function handler(req, res) {...})` - FunctionExpression
- **What it tests**: Named FunctionExpression inside wrapper (not arrow function)
- **Expected**: HANDLED_BY points to inner FunctionExpression
- **Status**: FAILS

### 4. Multiple Handlers with Wrapper
- **Code**: `router.get('/path', middleware, asyncHandler(handler))`
- **What it tests**: Last argument is wrapper, middleware in between
- **Expected**: HANDLED_BY from route points to inner function of last argument
- **Status**: FAILS

### 5. Nested Wrappers `outer(inner(handler))`
- **What it tests**: Double-wrapped handlers
- **Expected**: Should unwrap to innermost function
- **Status**: FAILS

### 6. Non-wrapper CallExpression
- **Code**: `router.post('/items', validate('/items'), (req, res) => {...})`
- **What it tests**: CallExpression that returns non-function (middleware, not wrapper)
- **Expected**: Should not crash, HANDLED_BY points to actual handler arrow function
- **Status**: SHOULD PASS (direct arrow function is last argument)

### 7. Direct Inline Handler (Regression Test)
- **What it tests**: Existing functionality - handlers without wrappers
- **Expected**: Still works after the fix
- **Status**: SHOULD PASS

### 8. Integration with ExpressResponseAnalyzer
- **What it tests**: Once HANDLED_BY is fixed, ExpressResponseAnalyzer can detect res.json() inside wrapped handlers
- **Expected**: RESPONDS_WITH edge created from route to response
- **Status**: FAILS (because HANDLED_BY is missing)

### 9. Anonymous FunctionExpression Wrapper
- **Code**: `asyncHandler(async function(req, res) {...})`
- **What it tests**: Anonymous function expression (not arrow)
- **Status**: FAILS

### 10. Multiline Wrapper
- **What it tests**: Wrapper spanning multiple lines with proper line number detection
- **Status**: FAILS

## Test Run Results (Partial)

From test output:
```
# Subtest: should unwrap asyncHandler(async (req, res) => {...}) and link HANDLED_BY to inner function
not ok 1 - should unwrap asyncHandler(async (req, res) => {...}) and link HANDLED_BY to inner function
  error: 'Should have 1 HANDLED_BY edge'
  expected: 1
  actual: 0
```

This confirms the bug: when the route handler is a CallExpression wrapper like `asyncHandler(...)`, no HANDLED_BY edge is created because ExpressRouteAnalyzer looks for a FUNCTION node at the asyncHandler's position, but the FUNCTION node is at the inner arrow function's position.

## Test Pattern

Tests follow existing patterns from:
- `ExpressRouteAnalyzer-HANDLED_BY.test.ts`
- `ExpressResponseAnalyzer.test.ts`

Using:
- `createTestBackend()` for RFDB connection
- `createTestOrchestrator()` with `ExpressRouteAnalyzer` plugin
- `getNodesByType()` and `getEdgesByType()` helpers
- Standard node:test framework with beforeEach/after cleanup

## Running Tests

```bash
node --import tsx --test test/unit/plugins/analysis/ExpressRouteAnalyzer-wrapper.test.ts
```

## Next Steps

1. Rob Pike implements the fix in `ExpressRouteAnalyzer.ts` (lines 218-240)
2. Tests should pass after implementation
3. Verify existing tests still pass (regression check)

## Files Changed

| File | Action |
|------|--------|
| `test/unit/plugins/analysis/ExpressRouteAnalyzer-wrapper.test.ts` | Created |

## Verification

The test file:
1. Uses same imports and patterns as existing tests
2. Properly sets up test backend with RFDB
3. Includes cleanup in beforeEach/after
4. Tests communicate intent clearly per TDD principles
5. Covers all cases from Don's plan plus regression cases
