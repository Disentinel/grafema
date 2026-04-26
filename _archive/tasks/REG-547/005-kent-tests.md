# REG-547: Kent Test Report

## Summary

Tests written and verified for the CONSTRUCTOR_CALL fix that removes spurious `CALL(isNew:true)` duplicate nodes from `new X()` expressions.

## Tests Added

### File: `test/unit/ConstructorCallTracking.test.js`

Added a new describe block: **"No spurious CALL(isNew:true) duplicates (REG-547)"** with 8 test cases:

1. **should NOT produce a CALL node with isNew:true for new Foo()** -- Asserts that `new Foo()` produces a `CONSTRUCTOR_CALL` and zero `CALL` nodes with `isNew === true`.

2. **should produce only CONSTRUCTOR_CALL for module-level new expression** -- Module-level `const x = new Foo()` produces exactly one `CONSTRUCTOR_CALL` with correct file/line attributes and zero spurious `CALL(isNew:true)`.

3. **should produce exactly N CONSTRUCTOR_CALL nodes and 0 CALL(isNew:true) for N new expressions** -- A file with 3 `new` expressions (`Date`, `Map`, `Set`) produces exactly 3 `CONSTRUCTOR_CALL` nodes and 0 `CALL(isNew:true)`.

4. **should produce CONSTRUCTOR_CALL with className for namespaced new ns.Foo()** -- `new ns.Foo()` produces a `CONSTRUCTOR_CALL` with `className='Foo'` (rightmost identifier) and no `CALL(isNew:true)`.

5. **should not produce CALL(isNew:true) duplicates inside functions** -- `new Map()` inside a function body produces `CONSTRUCTOR_CALL` only.

6. **should not produce CALL(isNew:true) duplicates for thrown constructors** -- `throw new Error('boom')` produces `CONSTRUCTOR_CALL` only.

7. **should not produce CALL(isNew:true) duplicates for constructor in return** -- `return new Foo()` produces `CONSTRUCTOR_CALL` only.

8. **should not produce CALL(isNew:true) duplicates for constructor passed as argument** -- `console.log(new Foo())` produces `CONSTRUCTOR_CALL` for Foo only, no spurious CALL.

### File: `test/unit/CallExpressionVisitorSemanticIds.test.js`

Updated 2 existing tests in the "constructor calls (new)" describe block:

1. **"should generate semantic ID for new expression"** -- Previously searched for `CALL` with `isNew === true` using an `if` guard (tolerant of either behavior). Updated to explicitly assert `CONSTRUCTOR_CALL` exists and no `CALL(isNew:true)` exists. This is the correct post-fix behavior.

2. **"should handle multiple constructor calls"** -- Previously searched for `CALL` nodes with `isNew === true`. Updated to search for `CONSTRUCTOR_CALL` nodes with matching `className`, assert their IDs are unique, and assert zero `CALL(isNew:true)` nodes.

## Existing Tests with isNew:true

### Snapshot files (already updated by the implementation)

5 snapshot files contained `"isNew": true` on CALL nodes (736 lines removed total):
- `test/snapshots/02-api-service.snapshot.json` (2 occurrences)
- `test/snapshots/03-complex-async.snapshot.json` (46 occurrences)
- `test/snapshots/04-control-flow.snapshot.json` (3 occurrences)
- `test/snapshots/07-http-requests.snapshot.json` (1 occurrence)
- `test/snapshots/nodejs-builtins.snapshot.json` (7 occurrences)

These were already updated by the implementation (Rob) to remove the spurious CALL(isNew:true) entries.

## Test Results

All tests pass with the fix applied:

```
ConstructorCallTracking.test.js: 30 tests, 0 failures
CallExpressionVisitorSemanticIds.test.js: 24 tests, 0 failures
```

The tests correctly verify the post-fix behavior: `new X()` produces exactly one `CONSTRUCTOR_CALL` node and zero `CALL(isNew:true)` nodes.

## Architecture Note

The fix removed the spurious CALL(isNew:true) path from two locations:
- `NewExpressionHandler.ts` -- in-function new expressions (lines 105-171 removed)
- `CallExpressionVisitor.ts` -- module-level new expressions (`handleNewExpression` method removed entirely, `NewExpression` handler removed from `getHandlers()`)

Both paths now produce only `CONSTRUCTOR_CALL` nodes via their respective handlers.
