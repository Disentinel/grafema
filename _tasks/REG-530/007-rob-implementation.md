# REG-530: Implementation Report

## Summary

Implemented per-specifier column tracking for IMPORT nodes so that `findNodeAtCursor` can distinguish between multiple import specifiers on the same line.

## Files Changed

### 1. `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`

- **Line 31**: Added `getEndLocation` to the import from `../utils/location.js`
- **Lines 44-45**: Added `column?: number` and `endColumn?: number` fields to `ImportSpecifierInfo` interface
- **Lines 119-120**: Extract `column` and `endColumn` from Babel AST for `ImportSpecifier` nodes
- **Lines 127-128**: Extract `column` and `endColumn` for `ImportDefaultSpecifier` nodes
- **Lines 135-136**: Extract `column` and `endColumn` for `ImportNamespaceSpecifier` nodes

### 2. `packages/core/src/plugins/analysis/ast/types.ts`

- **Lines 514-515**: Added `column?: number` and `endColumn?: number` fields to the shared `ImportSpecifier` interface

### 3. `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`

- **Line 108**: Changed `column || 0` to `spec.column ?? column ?? 0` to prefer per-specifier column over declaration column
- **Line 120**: Added `endColumn: spec.endColumn` to `ImportNodeOptions` for per-specifier end column

### 4. `packages/core/src/core/nodes/ImportNode.ts`

- **Line 13**: Added `endColumn?: number` field to `ImportNodeRecord` interface
- **Line 33**: Added `endColumn?: number` field to `ImportNodeOptions` interface
- **Lines 103-105**: Added conditional assignment of `endColumn` in `create()` method, following the existing pattern for optional fields

### 5. `packages/vscode/src/nodeLocator.ts`

- **Lines 45-56**: Replaced simple distance-based matching with range-aware matching:
  - If `endColumn` is present and cursor is within `[column, endColumn)`, use specificity 2000 (exact range match)
  - Otherwise fall back to distance-based matching with specificity `1000 - distance`
  - Uses strict less-than (`column < nodeEndColumn`) since Babel end positions are exclusive

## Verification

- **Build**: `pnpm build` completed with zero TypeScript errors across all packages
- **Tests**: All 84 import-related tests pass (NodeFactoryImport, GraphBuilderImport, DynamicImportTracking)
