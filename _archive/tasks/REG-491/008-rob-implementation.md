# Rob Pike Implementation Report: REG-491

## Summary

Added CONTAINS edges from parent scope to CONSTRUCTOR_CALL for all constructor calls, across both code paths (in-function via `NewExpressionHandler` and module-level via `traverse_new` in `JSASTAnalyzer`).

4 files changed, ~12 LOC added.

## Changes

### Change 1 -- `packages/core/src/plugins/analysis/ast/types.ts` (line 341)

Added `parentScopeId?: string` field to `ConstructorCallInfo` interface. Optional to maintain backward compatibility with any code paths that don't set it.

### Change 2 -- `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts` (line 51)

Added `parentScopeId: ctx.getCurrentScopeId()` to the `ctx.constructorCalls.push({...})` call. This captures the enclosing function-body scope ID for all constructor calls inside functions. `getCurrentScopeId()` is already used at lines 112 and 151 in the same handler for CALL_SITE nodes.

### Change 3 -- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 315-322)

In step 4.5 (the loop over constructor calls), after the `_bufferNode()` call, added a guarded `_bufferEdge()` for the CONTAINS edge:

```typescript
// SCOPE -> CONTAINS -> CONSTRUCTOR_CALL
if (constructorCall.parentScopeId) {
  this._bufferEdge({
    type: 'CONTAINS',
    src: constructorCall.parentScopeId,
    dst: constructorCall.id
  });
}
```

Pattern matches existing CALL_SITE CONTAINS edge creation in `CoreBuilder.ts` lines 138-143.

### Change 4 -- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 1739-1741, 1767)

Two sub-changes in the `traverse_new` section:

1. Added `getFunctionParent()` guard after the dedup check to skip in-function calls (those are already handled by `NewExpressionHandler` via Change 2). This eliminates pre-existing double-processing of in-function constructor calls. Pattern matches other module-level traversals (e.g., `traverse_updates` at line 1620, `traverse_assignments` at line 1539).

2. Added `parentScopeId: module.id` to the `constructorCalls.push({...})` call for remaining module-level calls.

## Tests

All existing tests pass:
- `ConstructorCallTracking.test.js`: 22/22 pass
- `GraphBuilderClassEdges.test.js`: 17/17 pass
- `GraphBuilderImport.test.js`: 26/26 pass

New CONTAINS edge tests are Kent's responsibility (separate test file).

## Verification

- Build: clean (no TypeScript errors)
- The `getFunctionParent()` guard in Change 4 ensures no double CONTAINS edges -- in-function calls get scope from `NewExpressionHandler`, module-level calls get `module.id`
- The `if (constructorCall.parentScopeId)` guard in Change 3 is defensive -- should never be triggered since both code paths now set `parentScopeId`, but protects against any unforeseen code path
