# REG-272: Loop Variable Declaration Implementation

**Date:** 2026-01-26
**Engineer:** Rob Pike (Implementation)
**Status:** Partial - Core functionality implemented, scope issue discovered

## Summary

Implemented tracking of loop variable declarations in for...of and for...in statements. Loop variables with `const` are now correctly marked as CONSTANT, and DERIVES_FROM edges are created to source collections.

**Discovered issue:** Module-level loops don't create scopes in the current implementation, so loop variables are scoped to global/module instead of the loop body. This is an architectural gap that needs to be addressed.

## Changes Made

### 1. VariableVisitor.ts (Module-Level Variables)

**File:** `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Lines 221-239:** Added loop variable detection and proper CONSTANT type assignment

```typescript
// Check if this is a loop variable (for...of or for...in)
const parent = path.parent;
const isLoopVariable = (parent.type === 'ForOfStatement' || parent.type === 'ForInStatement')
  && (parent as {left?: unknown}).left === varNode;

...

// Loop variables with const should be CONSTANT (they can't be reassigned in loop body)
// Regular variables with const are CONSTANT only if initialized with literal or new expression
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

**Lines 295-300:** Added loop variable assignment tracking

```typescript
// For loop variables, the "init" is the right side of for...of/for...in
const initExpression = isLoopVariable
  ? (parent as {right?: Node}).right
  : declarator.init;
```

This ensures that DERIVES_FROM edges are created from loop variables to their source collections.

### 2. JSASTAnalyzer.ts (Function-Level Variables)

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Lines 1635-1637:** Added loop variable detection in `handleVariableDeclaration()`

```typescript
// Check if this is a loop variable (for...of or for...in)
const parent = varPath.parent;
const isLoopVariable = (t.isForOfStatement(parent) || t.isForInStatement(parent)) && parent.left === varNode;
```

**Lines 1648-1651:** Updated CONSTANT type logic

```typescript
// Loop variables with const should be CONSTANT (they can't be reassigned in loop body)
// Regular variables with const are CONSTANT only if initialized with literal or new expression
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

**Lines 1716-1763:** Added loop variable assignment tracking

```typescript
if (isLoopVariable) {
  // For loop variables, track assignment from the source collection (right side of for...of/for...in)
  const loopParent = parent as t.ForOfStatement | t.ForInStatement;
  const sourceExpression = loopParent.right;

  // Handle both simple and destructured loop variables...
}
```

## Test Results

### Passing Tests

1. ✅ "should track let loop variable" - `let` loop variables correctly marked as VARIABLE
2. ✅ "should track var loop variable" - `var` loop variables correctly marked as VARIABLE
3. ✅ CONSTANT type assignment - `const` loop variables now correctly marked as CONSTANT (was VARIABLE before)

### Failing Tests

1. ❌ "should track simple loop variable: for (const x of arr)" - Fails on scope check
   - **Expected:** ID should include `for-of` or `for#`
   - **Actual:** ID is `index.js->global->CONSTANT->x`
   - **Root Cause:** Module-level loops don't create scopes

2. ❌ Tests expecting DERIVES_FROM edges to source collections
   - **Status:** Not fully tested yet due to scope issue blocking earlier tests

## Root Cause Analysis

The implementation correctly:
- Detects loop variables (checking if parent is ForOfStatement/ForInStatement)
- Assigns CONSTANT type to `const` loop variables
- Tracks assignments from source collections (the `right` side of for...of/for...in)

However, there's an **architectural gap**:

**Module-level loops don't create scopes.**

- `analyzeFunctionBody()` has loop scope handlers via `createLoopScopeHandler()`
- Module-level code only has separate traversals for variables, calls, etc., but no loop scope creation
- This means loop variables at module level are scoped to global/module, not to the loop body

## Design Decision Required

Two options:

### Option A: Add Module-Level Loop Scope Handler (Proper Fix)

Add a traverse for module-level loops that creates scopes, similar to how `analyzeFunctionBody` does it:

```typescript
// In analyze() method, after traverse_variables
this.profiler.start('traverse_loops');
traverse(ast, {
  ForOfStatement: createModuleLevelLoopScopeHandler('for-of', ...),
  ForInStatement: createModuleLevelLoopScopeHandler('for-in', ...),
  // etc.
});
this.profiler.end('traverse_loops');
```

**Pros:**
- Architecturally correct
- Loop variables properly scoped
- Consistent with function-level behavior

**Cons:**
- Requires new module-level loop traversal
- Need to coordinate scope creation timing with variable declaration processing
- More complex change

### Option B: Document as Limitation (Quick Fix)

Accept that module-level loop variables are in module scope, update tests to match reality.

**Pros:**
- No code changes needed
- Tests can pass immediately

**Cons:**
- Incorrect semantics (loop variables should be in loop scope)
- Inconsistent with function-level loops
- Affects data flow analysis accuracy

## Recommendation

**Implement Option A (proper fix).** The scope structure is fundamental to the graph model, and incorrect scoping will cause issues in:
- Variable shadowing analysis
- Closure detection
- Data flow tracing

The implementation is straightforward - we just need to add module-level loop handlers similar to the existing `analyzeFunctionBody` pattern.

## Next Steps

1. **Add module-level loop scope handlers** (if Option A chosen)
2. **Run full test suite** to verify all 40+ tests pass
3. **Test DERIVES_FROM edges** after scope issue is resolved
4. **Test destructuring patterns** (object and array)

## Files Modified

- `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
- `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

## Technical Notes

### Why Two Files?

Grafema has separate paths for module-level and function-level code:
- **VariableVisitor** handles module-level variables (when `!getFunctionParent()`)
- **JSASTAnalyzer.handleVariableDeclaration()** handles function-level variables

Both needed the same fix:
1. Detect loop variables by checking parent type
2. Mark `const` loop variables as CONSTANT
3. Track assignments from source collection (the `right` side)

### Assignment Tracking Pattern

The existing `trackVariableAssignment()` infrastructure works perfectly for loop variables - we just needed to pass the `right` side of the for...of/for...in statement as the "init" expression. The rest happens automatically:

- For `Identifier` sources → creates VARIABLE_TO_VARIABLE edge
- For destructuring → uses existing `trackDestructuringAssignment()` logic
- For expressions → follows existing expression tracking patterns

