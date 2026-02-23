# REG-567: Test Report

## Test Added

**File:** `test/unit/DataFlowTracking.test.js`
**Location:** Line 345, at the end of the `describe('NewExpression Assignments', ...)` block
**Test name:** `should create VARIABLE node for const x = new SomeService() in ASTWorker parallel path (REG-567)`

## What It Tests

The test verifies that `const myService = new SomeService()` produces a `VARIABLE` node (not `CONSTANT`) when processed through the full analysis pipeline, which exercises the ASTWorker parallel path.

The test uses a user-defined class `SomeService` with a constructor and an `init()` method to represent a realistic scenario where a `const` declaration holds a mutable object instance created via `new`.

## Assertion

```js
assert.strictEqual(
  myService.type, 'VARIABLE',
  `REG-567: "const myService = new SomeService()" must create VARIABLE node, not CONSTANT. ...`
);
```

The assertion message explains the root cause: NewExpression initializers produce mutable object instances, so `shouldBeConstant` must be false for them.

## Result

Test passes after the fix (removal of `isNewExpr` from `shouldBeConstant` in ASTWorker.ts).
