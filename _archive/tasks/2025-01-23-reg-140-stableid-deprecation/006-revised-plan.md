# Revised Plan: REG-140 stableId Deprecation

**Decision:** Remove stableId references only. IncrementalAnalysisPlugin fix is out of scope (separate issue).

## Scope

1. Remove `stableId` field assignments from node creation
2. Remove `stableId` field from type definitions
3. Update ValueDomainAnalyzer to use `id` instead of `stableId`
4. Remove `getNodesByStableId` from IncrementalAnalysisPlugin interface (dead code)
5. DO NOT fix IncrementalAnalysisPlugin's other dead code (getNodesByVersion) - separate issue

## Implementation Steps

### Phase 1: Type Definitions

1. **packages/types/src/nodes.ts** - Remove `stableId` from BaseNodeRecord
2. **packages/core/src/plugins/analysis/ast/types.ts** - Remove `stableId` from FunctionInfo
3. **packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts** - Remove `stableId`
4. **packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts** - Remove `stableId` from ClassFunctionInfo
5. **packages/core/src/core/ASTWorker.ts** - Remove `stableId` from FunctionNode interface

### Phase 2: Remove Assignments

1. **packages/core/src/core/nodes/FunctionNode.ts** - Remove `stableId: id` (2 locations)
2. **packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts** - Remove `stableId: functionId` (2 locations)
3. **packages/core/src/core/ASTWorker.ts** - Remove `stableId` assignments (2 locations)
4. **packages/core/src/plugins/analysis/JSASTAnalyzer.ts** - Remove all `stableId` assignments

### Phase 3: Update Lookups

1. **packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts** - Remove `stableId` comparison
2. **packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts**:
   - Remove `getNodesByStableId` from VersionAwareGraph interface
   - Remove `getNodesByStableId` call in `findCalleeAndCreateEdge`
   - Add TODO comment about plugin needing refactoring

### Phase 4: DO NOT TOUCH

- **packages/core/src/core/VersionManager.ts** - Internal `_stableId` is independent

## Tech Debt to Track

Create Linear issue for:
- IncrementalAnalysisPlugin uses non-existent `getNodesByVersion` and `getNodesByStableId` methods
- Plugin needs refactoring to use existing GraphBackend methods

## Test Strategy

1. Run existing tests after each phase
2. Update any test snapshots that include stableId
3. Full test suite before commit

## Ready for Implementation

Next: Kent Beck writes tests → Rob Pike implements
