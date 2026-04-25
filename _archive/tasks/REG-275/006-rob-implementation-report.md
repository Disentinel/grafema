# REG-275: Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-01-26
**Status:** Complete - All tests passing

## Summary

Implemented SwitchStatement BRANCH nodes following Joel's tech plan. The implementation creates BRANCH and CASE nodes for switch statements with HAS_CONDITION, HAS_CASE, and HAS_DEFAULT edges.

## Files Modified

### 1. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Change 1: Keep parentScopeId on BRANCH nodes (line 157-162)**
- Previously, `parentScopeId` was destructured out and not stored on the node
- Now keeping it on the node for query support (REG-275 test requirement)

```typescript
// Before:
const { parentScopeId, discriminantExpressionId, ... } = branch;
this._bufferNode(branchData as GraphNode);

// After:
const { discriminantExpressionId, ... } = branch;  // parentScopeId kept in branchData
this._bufferNode(branchData as GraphNode);
```

**Change 2: Pass callSites to bufferBranchEdges (line 218-225)**
- Added `callSites` parameter to support CallExpression discriminant lookup
- For `switch(getType())` patterns, looks up CALL_SITE node by coordinates
- CALL_SITE nodes use semantic IDs, so coordinate-based lookup is required

**Change 3: bufferBranchEdges now handles CallExpression discriminants (line 381-422)**
- For CallExpression discriminants, looks up actual CALL_SITE by file/line/column
- Falls back to generated ID if no CALL_SITE found

**Change 4: bufferDiscriminantExpressions skips CallExpression (line 439-468)**
- Skips CallExpression discriminants since they link to existing CALL_SITE nodes
- Only creates EXPRESSION nodes for Identifier and MemberExpression discriminants

### 2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes from previous session (wiring up collections):**
- Added `branches` and `cases` to Collections interface
- Added `branchCounterRef` and `caseCounterRef` to Collections interface
- Added array declarations for branches and cases
- Added counter declarations
- Added branches and cases to `allCollections` object
- Added branches and cases to `graphBuilder.build()` call

## Tests

All 27 tests passing in `test/unit/plugins/analysis/ast/switch-statement.test.ts`:

1. **Basic BRANCH node creation** (2 tests)
   - should create BRANCH node for simple switch
   - should create BRANCH node with correct semantic ID format

2. **HAS_CONDITION edge creation** (3 tests)
   - should create HAS_CONDITION edge from BRANCH to EXPRESSION for simple identifier
   - should handle MemberExpression discriminant
   - should handle CallExpression discriminant

3. **HAS_CASE edge creation** (5 tests)
   - should create CASE nodes for each case clause
   - should create HAS_CASE edges from BRANCH to each CASE
   - should include case value in CASE node
   - should handle numeric case values
   - should handle identifier case values

4. **HAS_DEFAULT edge creation** (3 tests)
   - should create HAS_DEFAULT edge for default case
   - should mark default CASE node with isDefault: true
   - should handle switch without default case

5. **Fall-through detection** (5 tests)
   - should mark case as fallsThrough when no break/return
   - should NOT mark case as fallsThrough when has break
   - should NOT mark case as fallsThrough when has return
   - should handle empty case (intentional fall-through)
   - should mark empty cases with isEmpty: true

6. **Edge cases** (4 tests)
   - should handle switch with single case
   - should handle switch with only default
   - should handle nested switch statements
   - should handle switch inside function with correct parent scope

7. **Edge connectivity** (2 tests)
   - should have valid src and dst node IDs in all switch-related edges
   - should connect BRANCH to correct CASE nodes

8. **Complex switch patterns** (3 tests)
   - should handle switch with throw statements
   - should handle switch with continue in loop context
   - should handle MemberExpression case values

## Deviations from Plan

### 1. CallExpression discriminant handling

**Joel's plan:** Create EXPRESSION node for CallExpression discriminants

**Actual implementation:** Link to existing CALL_SITE node by coordinates

**Reason:** CALL_SITE nodes use semantic IDs (e.g., `{file}->{scope}->CALL->{name}#{N}`) which cannot be predicted at discriminant extraction time. Looking up by coordinates ensures we link to the actual CALL_SITE node created by CallExpressionVisitor.

### 2. parentScopeId on BRANCH nodes

**Joel's plan:** Use parentScopeId only for CONTAINS edge creation

**Actual implementation:** Keep parentScopeId as a property on the BRANCH node

**Reason:** Tests expect `parentScopeId` to be queryable on the node (test: "should handle switch inside function with correct parent scope"). This matches how other nodes (FUNCTION, VARIABLE) store parent references.

## Technical Notes

1. **Semantic ID format for BRANCH/CASE nodes:** Uses `computeSemanticId` with discriminator counter for uniqueness within scope.

2. **Coordinate-based CALL_SITE lookup:** Required because semantic IDs depend on scope context unavailable during discriminant extraction.

3. **Fall-through detection:** Uses `caseTerminates()` to check for break/return/throw/continue statements.

## Files Already Implemented (from earlier phases)

These files were already implemented before this session:
- `packages/types/src/nodes.ts` - BRANCH and CASE types
- `packages/types/src/edges.ts` - HAS_CONDITION, HAS_CASE, HAS_DEFAULT edges
- `packages/core/src/core/nodes/BranchNode.ts` - Node contract
- `packages/core/src/core/nodes/CaseNode.ts` - Node contract
- `packages/core/src/core/NodeFactory.ts` - createBranch() and createCase() methods
- `packages/core/src/plugins/analysis/ast/types.ts` - BranchInfo and CaseInfo interfaces
