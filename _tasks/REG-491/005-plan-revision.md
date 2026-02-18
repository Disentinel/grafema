# REG-491: Revised Plan (post-Dijkstra)

## Summary

Add CONTAINS edges from parent scope → CONSTRUCTOR_CALL for ALL constructor calls, fixing 65% disconnected nodes.

Dijkstra found a second code path for constructor call collection in `JSASTAnalyzer.ts` that the original plan missed. Revised plan adds Change 4.

## Changes

### Change 1 — `types.ts`: Add parentScopeId to ConstructorCallInfo
- **File:** `packages/core/src/plugins/analysis/ast/types.ts`
- Add `parentScopeId?: string` to `ConstructorCallInfo` interface

### Change 2 — `NewExpressionHandler.ts`: Capture parentScopeId (in-function calls)
- **File:** `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts:43`
- Add `parentScopeId: ctx.getCurrentScopeId()` to the `ctx.constructorCalls.push({...})` block
- This handles all constructor calls INSIDE functions

### Change 3 — `GraphBuilder.ts`: Create CONTAINS edge in step 4.5
- **File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (step 4.5 loop)
- After `_bufferNode()`, add guarded `_bufferEdge({ type: 'CONTAINS', src: constructorCall.parentScopeId, dst: constructorCall.id })`
- Guard: `if (constructorCall.parentScopeId)`

### Change 4 — `JSASTAnalyzer.ts`: Fix module-level traverse_new (Dijkstra's finding)
- **File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts:1732`
- Add `getFunctionParent()` guard after dedup check — skip in-function calls (already handled by Change 2)
- For remaining module-level calls, add `parentScopeId: module.id` to the push
- This also eliminates pre-existing double-processing of in-function constructor calls

### Tests — `test/unit/ConstructorCallTracking.test.js`
New CONTAINS edge tests:
1. Module-level assigned: `const x = new Foo()` → MODULE CONTAINS CONSTRUCTOR_CALL
2. Function-scoped: `function f() { new Foo() }` → FUNCTION CONTAINS CONSTRUCTOR_CALL
3. Thrown unassigned: `throw new Error()` → scope CONTAINS CONSTRUCTOR_CALL
4. Argument unassigned: `fn(new Foo())` → scope CONTAINS CONSTRUCTOR_CALL
5. Return unassigned: `return new Foo()` → scope CONTAINS CONSTRUCTOR_CALL

## Scope
- ~15 LOC implementation across 4 files
- ~60 LOC tests
- No architectural decisions
- Follows existing CALL_SITE CONTAINS pattern
