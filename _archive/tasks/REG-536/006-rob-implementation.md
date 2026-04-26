# REG-536: Implementation Report -- Rob Pike

## Summary

Fixed disconnected nodes in switch/case blocks by creating body SCOPE nodes for each non-empty case clause, following the same enter/exit pattern used by LoopHandler and TryCatchHandler.

## Root Cause

Two issues caused 47.4% of nodes inside switch/case blocks to be unreachable:

1. **`handleSwitchStatement` never created body SCOPE nodes** for case clauses. Unlike if/for/try which all create body SCOPEs and push them onto `scopeIdStack`, switch/case left all inner nodes parented to the function body scope -- breaking the CONTAINS chain.

2. **`BranchHandler` passed `ctx.parentScopeId`** (stale, initial function body scope) to `handleSwitchStatement` instead of `ctx.getCurrentScopeId()` (dynamic, top of stack). This meant nested switches inside loops/ifs would get incorrect parent scope IDs.

## Changes

### 1. `packages/core/src/plugins/analysis/ast/FunctionBodyContext.ts`

- Added `switchCaseScopeMap: Map<t.SwitchCase, string>` to `FunctionBodyContext` interface
- Initialized it in `createFunctionBodyContext()` factory function
- Purpose: maps each SwitchCase AST node to its corresponding `caseId` (from CaseInfo), so the SwitchCase visitor can create a SCOPE node parented to the correct CASE

### 2. `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`

- **Fix 1:** Changed `ctx.parentScopeId` to `ctx.getCurrentScopeId()` in the SwitchStatement handler call. This ensures switch statements nested inside loops/ifs/try get the correct dynamic parent scope.
- **Fix 2:** Added `ctx.switchCaseScopeMap` parameter to the `handleSwitchStatement` call.
- **Fix 3:** Added `SwitchCase: this.createSwitchCaseVisitor()` to the handlers.
- **New method `createSwitchCaseVisitor()`:** Creates SCOPE nodes for each non-empty case clause body following the LoopHandler enter/exit pattern:
  - `enter`: Skip empty cases (fall-through). Look up caseId from map. Enter scopeTracker. Create SCOPE with `parentScopeId = caseId`. Push scopeId onto `scopeIdStack`.
  - `exit`: Pop scopeId from stack. Exit scopeTracker. Clean up map entry.

### 3. `packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts`

- Added optional `switchCaseScopeMap?: Map<t.SwitchCase, string>` parameter to `handleSwitchStatement` interface method.

### 4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

- Added `switchCaseScopeMap` parameter to `handleSwitchStatement` method signature.
- After each non-empty CASE is created, populates `switchCaseScopeMap.set(caseNode, caseId)`.

### 5. `test/snapshots/04-control-flow.snapshot.json`

- Updated snapshot to include new SCOPE nodes (`switch-case`, `default-case` scope types) and `CASE -> CONTAINS -> SCOPE` edges.
- Call nodes previously parented to function body scope are now correctly parented to case-body SCOPE nodes.

## Graph Structure (Before vs After)

**Before:**
```
FUNCTION_BODY SCOPE -> CONTAINS -> BRANCH (switch)
BRANCH -> HAS_CASE -> CASE
FUNCTION_BODY SCOPE -> CONTAINS -> CALL (inside case)  // WRONG: skips CASE
FUNCTION_BODY SCOPE -> CONTAINS -> LITERAL (inside case)  // WRONG: disconnected
```

**After:**
```
FUNCTION_BODY SCOPE -> CONTAINS -> BRANCH (switch)
BRANCH -> HAS_CASE -> CASE
CASE -> CONTAINS -> SCOPE (case body)
SCOPE (case body) -> CONTAINS -> CALL (inside case)  // CORRECT
SCOPE (case body) -> CONTAINS -> LITERAL (inside case)  // CORRECT
```

## Design Decisions

- **Followed LoopHandler pattern exactly:** enter creates SCOPE + pushes stack, exit pops stack. No new patterns invented.
- **Empty cases (fall-through) skip SCOPE creation:** Cases with `consequent.length === 0` are intentional fall-throughs and have no body to scope.
- **Default case treated identically to named cases:** Uses `default-case` scope type string (vs `switch-case`), but same mechanism.
- **scopeTracker.enterCountedScope called BEFORE generating SCOPE id:** Following Dijkstra's correction to ensure semantic IDs use correct scope context.

## Test Results

- **Snapshot tests:** All 6 snapshots pass (04-control-flow updated with new SCOPE nodes and CASE -> CONTAINS -> SCOPE edges).
- **Expression tests:** 19/19 pass
- **SemanticId tests:** All pass (SemanticIdV2, SemanticIdPipelineIntegration)
- **FunctionCallResolver:** 19/19 pass
- **DataFlowTracking:** 9/9 pass
- **LoopVariableDeclaration:** Pass
- **UpdateExpression:** Pass
- **ConstructorCallTracking:** Pass
- **NoLegacyExpressionIds:** Pass

All other test failures observed during the run are pre-existing RFDB server connection issues (EPIPE errors), not related to this change.
