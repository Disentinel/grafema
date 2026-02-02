# Don Melton: Try/Catch/Finally Scope Analysis

## Root Cause

The `handleTryStatement` method uses `tryPath.skip()` at the end (line 2030), which prevents Babel's traversal from visiting any child nodes. This means `CallExpression` and `NewExpression` visitors never see calls inside try/catch/finally blocks.

## Why skip() Was Added

The `skip()` was added during REG-142 to prevent double-processing of VariableDeclarations. The `processBlockVariables()` method already traverses the block - without `skip()`, the main traversal would also visit those same declarations.

## Architectural Mismatch

If/else and loop handlers use a different pattern:
- Return `{ enter, exit }` callbacks
- Use `scopeIdStack` for dynamic scope tracking
- Do NOT call `skip()` - allow main traversal to continue
- Variables are handled by the main `VariableDeclaration` visitor

`handleTryStatement` tries to do both: create scopes AND process variables separately. This dual approach necessitated `skip()`.

## Proposed Solution: Align with Existing Pattern

Refactor `handleTryStatement` to follow `createIfStatementHandler` pattern:

1. Create `createTryStatementHandler()` that returns `{ enter, exit }`
2. Remove `processBlockVariables()` - let main visitor handle variables
3. Push/pop try/catch/finally scopes to `scopeIdStack`
4. Remove `tryPath.skip()`
5. Use a map to track which block we're in (like `ifElseScopeMap`)

## Files to Modify

- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
  - Create `createTryStatementHandler()` method
  - Create `CatchClause` handler for scope transitions
  - Update traverse visitor registration
  - Handle catch parameter specially (it's not a VariableDeclaration)

## Risk Assessment

**Low:** Pattern is proven for if/else/loops
**Medium:** Catch parameter needs special handling (not a VariableDeclaration)
**Mitigation:** Tests already exist in ScopeContainsEdges.test.js
