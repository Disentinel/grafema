# Kent Beck - Test Report for REG-223

## Summary

Added 10 new test cases for REG-223 (Complex Init Expressions) to the existing `DestructuringDataFlow.test.js` file. All new tests fail as expected (TDD RED phase), while all existing REG-201 tests continue to pass.

## Test File

**Path:** `/Users/vadimr/grafema-worker-4/test/unit/DestructuringDataFlow.test.js`

## New Test Suite: "Complex Init Expressions (REG-223)"

### Test Cases Added

| # | Test | Status | Description |
|---|------|--------|-------------|
| 1 | Basic CallExpression | FAIL | `const { apiKey } = getConfig()` should create ASSIGNED_FROM to EXPRESSION, DERIVES_FROM to CALL |
| 2 | AwaitExpression | FAIL | `const { name } = await fetchUser()` should unwrap await and connect to CALL |
| 3 | Method Call (array filter) | FAIL | `const [first] = arr.filter(x => x > 0)` should create edges to method call |
| 4 | Object Method Call | FAIL | `const { x } = obj.getConfig()` should handle MemberExpression callee |
| 5 | Nested Destructuring from Call | FAIL | `const { user: { name } } = fetchData()` should create path `fetchData().user.name` |
| 6 | Nested Await Destructuring | FAIL | `const { user: { name } } = await fetchProfile()` combines await + nesting |
| 7 | Mixed Pattern with Call | FAIL | `const { items: [first] } = getResponse()` combines object + array + call |
| 8 | Rest Element with Call | FAIL | `const { a, ...rest } = getConfig()` rest should point directly to CALL |
| 9 | Coordinate Validation (multi-line await) | FAIL | Tests that await on different line uses correct CallExpression coordinates |
| 10 | Multiple Calls Same Line | FAIL | `const { x } = f1(), { y } = f2()` tests function name disambiguation |

### REG-201 Regression Test

| Test | Status | Description |
|------|--------|-------------|
| REG-201 Regression | PASS | `const { apiKey } = config` (simple destructuring) still works correctly |

## Test Results

```
# tests 20
# suites 14
# pass 10
# fail 10

Existing tests (REG-201): 10 PASS
New tests (REG-223):       10 FAIL
```

**This is the expected RED state for TDD.**

## Test Design Decisions

### 1. Helper Function

Added `findVariable(backend, name)` helper to reduce code duplication:

```javascript
async function findVariable(backend, name) {
  for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === name) return node;
  }
  for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
    if (node.name === name) return node;
  }
  return null;
}
```

### 2. Assertions Structure

Each test follows the pattern from Joel's spec:
1. Find the destructured variable
2. Verify ASSIGNED_FROM edge exists and points to EXPRESSION
3. Verify EXPRESSION has correct properties (`object`, `property`, `expressionType`)
4. Verify DERIVES_FROM edge points to CALL node
5. Verify CALL node has correct `name`

### 3. Call Representation

Tests expect `object` field to contain call representation with parentheses:
- `getConfig()` for direct calls
- `arr.filter()` for method calls
- `obj.getConfig()` for object method calls

This distinguishes call-based expressions from variable-based expressions (REG-201).

### 4. Coordinate Validation Tests

Two specific tests for coordinate handling per Linus review:

1. **Multi-line await:** Tests that when await and call are on different lines, the coordinates point to the CallExpression, not AwaitExpression.

2. **Same-line disambiguation:** Tests that when multiple calls appear on the same line (`f1()` and `f2()`), the correct function name is used to disambiguate.

## Failure Analysis

All failures are of the form:
```
error: 'Should have ASSIGNED_FROM edge'
expected: 1
actual: 0
```

This confirms that the current implementation (REG-201) does not create ASSIGNED_FROM edges for CallExpression/AwaitExpression init nodes. The tests correctly identify the gap that REG-223 needs to fill.

## Implementation Notes for Rob Pike

### What Tests Expect

1. **EXPRESSION Node Properties:**
   - `type: 'EXPRESSION'`
   - `expressionType: 'MemberExpression'`
   - `object: 'functionName()'` (with parentheses)
   - `property: 'propName'`
   - `path: 'functionName().nested.prop'` (for nested)
   - `propertyPath: ['nested', 'prop']`
   - `arrayIndex: 0` (for array patterns)
   - `computed: true` (for array access)

2. **CALL Node Properties:**
   - `type: 'CALL'`
   - `name: 'functionName'` (without parentheses)

3. **Edges:**
   - `VARIABLE -> ASSIGNED_FROM -> EXPRESSION`
   - `EXPRESSION -> DERIVES_FROM -> CALL`

### Rest Element Behavior

For rest elements with call init:
- Tests expect direct edge to CALL node (not EXPRESSION)
- This matches spec: `rest -> ASSIGNED_FROM -> CALL(getConfig)`

## Running Tests

```bash
node --test test/unit/DestructuringDataFlow.test.js
```

Or just the REG-223 suite (for faster feedback during implementation):
```bash
node --test --test-name-pattern="Complex Init Expressions" test/unit/DestructuringDataFlow.test.js
```

## Next Steps

Rob Pike can now implement the feature. Tests will turn GREEN when:

1. `trackDestructuringAssignment()` handles CallExpression/AwaitExpression init
2. Helper functions (`unwrapAwaitExpression`, `extractCallInfo`) are implemented
3. GraphBuilder creates DERIVES_FROM edges to CALL_SITE nodes
4. EXPRESSION nodes store call representation in `object` field

---

**Kent Beck**
Test Engineer
2025-01-25
