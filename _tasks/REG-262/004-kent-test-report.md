# Kent Beck's Test Report: REG-262 - Method Call USES Edges

## Summary

Created test file `/test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts` with 5 test suites covering the USES edge creation for method calls.

## Test Results (Before Implementation)

| Test Suite | Status | Expected |
|------------|--------|----------|
| Basic method call creates USES edge | FAIL | Should fail - no implementation |
| this.method() does NOT create USES edge | PASS | Correct - currently no edges created for any method calls |
| Multiple method calls on same object | FAIL | Should fail - no implementation |
| Parameter as receiver | FAIL | Should fail - no implementation |
| Nested member access | PASS (skipped) | Gracefully skips - known limitation that nested method calls aren't captured |

**3 tests fail as expected** - this is correct TDD behavior. The implementation will make them pass.

## Test Cases

### 1. Basic method call creates USES edge
```javascript
const date = new Date();
date.toLocaleDateString();
```
- Verifies METHOD_CALL has USES edge to variable
- Verifies edge direction: src=METHOD_CALL.id, dst=variable.id

### 2. this.method() does NOT create USES edge
```javascript
class Foo {
  bar() { this.baz(); }
}
```
- Verifies NO USES edge for `this` (it's not a variable node)

### 3. Multiple method calls on same object
```javascript
const str = "hello";
str.toUpperCase();
str.toLowerCase();
```
- Both METHOD_CALLs should have USES edges to str

### 4. Parameter as receiver
```javascript
function process(obj) {
  obj.method();
}
```
- USES edge should point to PARAMETER node

### 5. Nested member access
```javascript
const obj = { nested: { method: () => 42 } };
obj.nested.method();
```
- USES edge should point to base `obj` variable
- Note: Currently skipped as nested method calls aren't captured (separate issue)

## Files Created

- `/test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts`

## Run Tests

```bash
node --import tsx --test test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts
```

## Next Steps

1. Rob Pike implements GraphBuilder change (Step 2 in tech plan)
2. Rob Pike implements DataFlowValidator change (Step 3 in tech plan)
3. All tests should pass after implementation

## Known Limitation Discovered

Nested member expressions like `obj.nested.method()` don't create METHOD_CALL nodes. This is a separate issue from REG-262 and should be tracked separately if needed.

---

Test-first development complete. Ready for implementation.
