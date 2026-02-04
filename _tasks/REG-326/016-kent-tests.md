# Kent Beck - Test Report for REG-326

**Date:** 2026-02-04

## Test Files

### Part A: ExpressResponseAnalyzer Linking Tests

**File:** `test/unit/plugins/analysis/ExpressResponseAnalyzer.linking.test.ts`

Tests for the new functionality that links `res.json(identifier)` to existing VARIABLE/PARAMETER/CONSTANT nodes instead of creating stub nodes.

**Test Cases:**

1. **res.json(localVar) - links to existing function-local VARIABLE**
   - Verifies that when response uses a local variable, the RESPONDS_WITH edge points to the existing VARIABLE node created by JSASTAnalyzer
   - No stub node should be created

2. **res.json(param) - links to existing PARAMETER (e.g., req.body)**
   - Verifies that when response uses a function parameter (like `req`), the RESPONDS_WITH edge points to the existing PARAMETER node
   - Tests the `parentFunctionId` matching logic

3. **res.json(moduleVar) - links to existing module-level VARIABLE/CONSTANT**
   - Verifies that module-level variables are properly found and linked
   - Tests scope prefix extraction for broader scope

4. **res.json(externalVar) - creates stub when variable not found**
   - When a variable is not in the handler's scope (external/global), fall back to creating a stub
   - Preserves backward compatibility

5. **res.json({ ... }) - creates OBJECT_LITERAL (unchanged behavior)**
   - ObjectExpression arguments should still create OBJECT_LITERAL stub nodes
   - Verifies existing behavior is preserved

6. **res.json(fn()) - creates CALL stub (unchanged behavior)**
   - CallExpression arguments should still create CALL stub nodes
   - Verifies existing behavior is preserved

7. **Multiple routes with same variable name - correct scope linking**
   - Two handlers each with `res.json(userId)` in different scopes
   - Each route should link to its own scoped `userId` variable
   - Verifies no cross-scope pollution

8. **extractScopePrefix() edge cases**
   - Test the helper method that parses semantic IDs
   - Various input patterns including edge cases

### Part B: CLI --from-route Tests

**File:** `test/unit/cli/trace-route.test.ts`

Tests for the new `--from-route` CLI option.

**Test Cases:**

1. **findRouteByPattern() - exact match "METHOD /path"**
   - Pattern "GET /status" matches route with method=GET, path=/status
   - Returns correct route node info

2. **findRouteByPattern() - path-only match "/path"**
   - Pattern "/status" matches any route with path=/status (ignores method)
   - Useful for quick lookups

3. **findRouteByPattern() - route not found**
   - Non-existent pattern returns null
   - Graceful handling

4. **Route output shows traced values**
   - Route with RESPONDS_WITH edges shows traced data sources
   - Verifies end-to-end output format

5. **Route without responses - helpful hint**
   - Route with no RESPONDS_WITH edges shows hint about ExpressResponseAnalyzer
   - User guidance

6. **Route not found - helpful hint**
   - Non-existent route shows hint to use `grafema query`
   - User guidance

## Design Decisions

### Test Approach for Part A

The Part A tests use the same infrastructure as the existing `ExpressResponseAnalyzer.test.ts`:
- `createTestBackend()` from `test/helpers/TestRFDB.js`
- `createTestOrchestrator()` from `test/helpers/createTestOrchestrator.js`
- ExpressRouteAnalyzer + ExpressResponseAnalyzer plugins

Key difference: We need to verify that:
1. The RESPONDS_WITH edge destination is an **existing** node (not a stub)
2. The existing node has the correct semantic ID from JSASTAnalyzer

### Test Approach for Part B

The CLI tests use a mock graph backend to avoid needing to run full analysis:
- Create mock http:route nodes with method/path
- Create mock RESPONDS_WITH edges
- Test route matching and output formatting logic

This approach is more unit-test focused and faster than integration tests.

## Uncertainties / Questions

1. **Scope prefix extraction accuracy**: The `extractScopePrefix()` function assumes semantic IDs follow a specific format. Need to verify this covers all cases JSASTAnalyzer produces.

2. **PARAMETER parentFunctionId**: The tech spec assumes PARAMETER nodes have `parentFunctionId` field. Need to verify this field exists in the current implementation.

3. **Module-level variables**: The scope matching for module-level variables may need special handling - they don't have a function scope prefix.

## Next Steps

1. Write Part A tests (ExpressResponseAnalyzer linking)
2. Write Part B tests (CLI --from-route)
3. Run tests to verify they fail (TDD)
4. Hand off to Rob Pike for implementation

---

## Test Results (TDD)

### Part A: ExpressResponseAnalyzer.linking.test.ts

Tests correctly FAIL as expected (TDD pattern):

```
not ok 1 - should link to existing local VARIABLE node, not create stub
  error: 'Should NOT create stub node - should link to existing variable'
  expected: '<response>'
  actual: '<response>'
  operator: 'notStrictEqual'
```

This failure confirms:
1. Tests are correctly structured
2. Current implementation creates stub nodes with `<response>` name
3. Tests will pass once Rob Pike implements the linking logic

### Part B: trace-route.test.ts

All 20 tests PASS:

```
# tests 20
# suites 10
# pass 20
# fail 0
```

These tests define the expected behavior for `findRouteByPattern()` and output formatting.
The mock implementation in the test file serves as a specification for the CLI implementation.

### Running Tests

```bash
# Part A (will fail until implementation)
node --import tsx --test test/unit/plugins/analysis/ExpressResponseAnalyzer.linking.test.ts

# Part B (passes - documents expected behavior)
node --import tsx --test test/unit/cli/trace-route.test.ts
```

---

*Test report by Kent Beck, Test Engineer*
