# Kent Beck — Test Report: REG-491 CONTAINS edges for CONSTRUCTOR_CALL

## Summary

Added 5 tests in a new `describe('CONTAINS edges for CONSTRUCTOR_CALL nodes')` block to `test/unit/ConstructorCallTracking.test.js`.

## Discovery: Implementation Already Exists

During test execution, all 5 tests passed GREEN immediately. Investigation revealed that the implementation described in the plan (Changes 1-4) is **already present in the codebase**:

1. **`types.ts`** — `parentScopeId?: string` already exists on `ConstructorCallInfo` (line 341)
2. **`NewExpressionHandler.ts`** — `parentScopeId: ctx.getCurrentScopeId()` already set (line 51)
3. **`GraphBuilder.ts`** — CONTAINS edge creation already guarded by `if (constructorCall.parentScopeId)` (lines 315-320)
4. **`JSASTAnalyzer.ts`** — Module-level path already sets `parentScopeId: module.id` (line 1767) with `getFunctionParent()` guard (line 1740-1741)

All four changes from the plan were already implemented before this task branch was created.

## Tests Added

All tests are in the new `describe('CONTAINS edges for CONSTRUCTOR_CALL nodes')` block (lines 602-768).

### Test 1: Module-level assigned constructor call
```js
'index.js': `const x = new Foo();`
```
Verifies: MODULE node has a CONTAINS edge pointing to the CONSTRUCTOR_CALL node.

### Test 2: Function-scoped assigned constructor call
```js
'index.js': `function f() { const x = new Foo(); }`
```
Verifies: CONTAINS edge exists to CONSTRUCTOR_CALL, and its source is NOT the MODULE node (should be function scope).

### Test 3: Thrown unassigned constructor call
```js
'index.js': `function f() { throw new Error('something went wrong'); }`
```
Verifies: No ASSIGNED_FROM edge exists (not assigned to variable), but CONTAINS edge still connects the node to its scope. This is the key case — previously disconnected constructor calls.

### Test 4: Constructor call passed as argument
```js
'index.js': `function f() { console.log(new Foo()); }`
```
Verifies: CONTAINS edge exists even when the constructor call is an inline argument.

### Test 5: Constructor call in return statement
```js
'index.js': `function f() { return new Foo(); }`
```
Verifies: CONTAINS edge exists for constructor calls used directly in return statements.

## Test Results

```
# tests 5
# pass 5
# fail 0
```

All 5 tests are GREEN. They serve as regression guards for the existing CONTAINS edge behavior on CONSTRUCTOR_CALL nodes.

## File Modified

- `/Users/vadimr/grafema-worker-2/test/unit/ConstructorCallTracking.test.js` — added lines 599-768 (new describe block with 5 tests)

## Style Compliance

- Matches existing test file patterns exactly (imports, `setupTest()` helper, `beforeEach`/`after` lifecycle, assertion style)
- Uses same `backend.getAllNodes()` / `backend.getAllEdges()` + `.find()` pattern as all other tests in the file
- Descriptive assertion messages include JSON debug output for CONTAINS edges on failure
- Tests 3-5 specifically target unassigned constructor calls (the 65% disconnected case from the task description)
