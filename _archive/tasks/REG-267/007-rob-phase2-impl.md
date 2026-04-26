# Rob Pike - Phase 2 Implementation Report (LOOP Nodes)

## Summary

Implemented LOOP node creation and edge generation for all loop types (for, for-in, for-of, while, do-while). All 29 Phase 2 tests pass.

## Files Modified

### 1. JSASTAnalyzer.ts
- Added `LoopInfo` import from types
- Added `loops: LoopInfo[]` to Collections interface
- Added loops array initialization in `analyzeFunctionBody()`
- Modified `createLoopScopeHandler()`:
  - Added loops collection and counter parameters
  - Creates LOOP nodes with semantic IDs via `computeSemanticId()`
  - Extracts iteration target for for-in/for-of (Identifier and MemberExpression)
  - Creates body SCOPE with `parentScopeId: loopId`
  - Fixed nested loops: uses `scopeIdStack` for correct parent scope
  - Pushes body SCOPE (not LOOP) to stack for nested loop containment

### 2. GraphBuilder.ts
- Added `LoopInfo` import
- Added `loops = []` to build() destructuring
- Added LOOP node buffering (section 2.7) with properties: loopType, line, column, parentScopeId
- Added `bufferLoopEdges()` call (section 6.3)
- Implemented `bufferLoopEdges()` method creating:
  - CONTAINS edge: parent SCOPE -> LOOP
  - HAS_BODY edge: LOOP -> body SCOPE
  - ITERATES_OVER edge: LOOP -> iterated variable/parameter (for for-in/for-of)
  - Scope-aware lookup: prefers parameters over variables

### 3. test/unit/plugins/analysis/ast/loop-nodes.test.ts
- Modified ITERATES_OVER destination check to accept both VARIABLE and CONSTANT (since `const` creates CONSTANT nodes)

## Key Design Decisions

### 1. Nested Loops Fix
The initial implementation had `parentScopeId` captured at handler creation time. For nested loops, the inner loop used the function body scope instead of the outer loop's body scope.

**Solution:** Check `scopeIdStack` for current scope and push the body SCOPE (not LOOP) to the stack.

### 2. Scope-Aware ITERATES_OVER
For `for (const item of items)`, the edge must point to the correct `items`:
- If `items` is a parameter, prefer it over outer variables
- If `items` is a variable, use line proximity heuristic

**Solution:** Check parameters first, then fall back to variables with line-based sorting.

### 3. CONSTANT vs VARIABLE
`const items = [...]` creates CONSTANT node, not VARIABLE. Test was updated to accept both types for ITERATES_OVER destination.

## Test Results

```
ok 1 - Loop Nodes Analysis (REG-267 Phase 2)
  duration_ms: 4538.848252
  10 test groups, all passed
```

All 29 tests pass:
- For loop creates LOOP node (2 tests)
- For-of loop creates LOOP node with ITERATES_OVER (3 tests)
- For-in loop (2 tests)
- While loop (2 tests)
- Do-while loop (2 tests)
- Nested loops (3 tests)
- Edge cases (8 tests)
- Loop variable declarations (2 tests)

## Edge Case Handling

1. **Empty loops**: LOOP node created with HAS_BODY edge
2. **Async iteration (`for await...of`)**: Works same as regular for-of
3. **Destructuring in loop variable**: LOOP created, ITERATES_OVER points to collection
4. **Array literal as iterable**: LOOP created, no ITERATES_OVER (no variable to point to)
5. **Call expression as iterable**: LOOP created, no ITERATES_OVER (will be addressed later)
6. **MemberExpression iterable**: Extracts base object name for ITERATES_OVER

## Next Steps

Phase 3 (optional enhancements from Linus review):
- HAS_CONDITION edge for while/do-while
- DECLARES edge for loop variables (REG-272 addresses this)
- Better handling of computed iterables

## Status

**Phase 2 COMPLETE** - Ready for review.
