# Don Melton - High-Level Plan for REG-101

## Current State Analysis

### What Already Exists (Complete)
1. **`ExportNode.create()`** - Implemented in `packages/core/src/core/nodes/ExportNode.ts:54-78`
2. **`ExportNode.createWithContext()`** - Also exists for semantic IDs (lines 92-119)
3. **`NodeFactory.createExport()`** - Implemented in `packages/core/src/core/NodeFactory.ts:377-386`
4. **`GraphBuilder.bufferExportNodes()`** - Already migrated to use `NodeFactory.createExport()` (lines 533-612)
5. **Comprehensive tests** - Exist in `NodeFactoryPart1.test.js` (lines 136-259) and `NodeFactoryPart2.test.js`

### What Still Needs Migration
1. **`ASTWorker.ts`** - 5 inline EXPORT creations with legacy `EXPORT#name#file#line` ID format:
   - Line 284-291: FunctionDeclaration export
   - Line 293-300: ClassDeclaration export
   - Line 304-311: VariableDeclaration exports
   - Line 321-328: Named specifier exports
   - Line 343-351: Default exports

### Key Observations

1. **Pattern from REG-99 (CLASS) and REG-100 (IMPORT):**
   - Both followed same pattern: update ASTWorker to use `NodeClass.create()` directly
   - Import statement added for the Node class
   - Interface for the old node type removed (if duplicated)
   - ID format changed from `TYPE#name#file#line` to semantic format

2. **ImportExportVisitor** does NOT create EXPORT nodes directly - it only collects export info which is then passed to `GraphBuilder.bufferExportNodes()`. No migration needed there.

3. **ASTWorker** is the only remaining location with inline EXPORT creation.

4. **ID Format Change:**
   - Current: `EXPORT#${name}#${filePath}#${line}`
   - Target: `${file}:EXPORT:${name}:${line}` (from ExportNode.create)

## Files Requiring Changes

| File | Changes Required |
|------|-----------------|
| `ASTWorker.ts` | Import ExportNode, remove duplicate interface, migrate 5 inline creations |

## Critical Concern: `exportType` Semantic Difference

ASTWorker uses `exportType: 'function'/'class'/'variable'` (WHAT is exported)
ExportNode uses `exportType: 'default'/'named'/'all'` (HOW it's exported)

These are different semantics. Need to verify:
1. Is the ASTWorker `exportType` still needed?
2. Does it map to a different field in ExportNode?
3. Or should we add a new field?

## High-Level Strategy

1. Import `ExportNode` in ASTWorker.ts
2. Remove duplicate `ExportNode` interface (lines 44-52)
3. Replace all 5 inline creations with `ExportNode.create()`
4. Update type annotation for `collections.exports` to use proper type
5. Verify tests pass - watch for old ID format dependencies

## Decision Needed

The `exportType` field semantic difference needs resolution before implementation.
