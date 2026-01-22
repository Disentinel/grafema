# Rob Pike - Implementation Report: REG-103

## Summary

Migrated the last inline INTERFACE creation in `GraphBuilder.bufferInterfaceNodes()` to use `InterfaceNode.create()` via NodeFactory pattern.

## Changes Made

### 1. TypeScriptVisitor ID Format Update

**File**: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`
**Line**: 129

Changed ID generation from legacy `#` separator to `:` separator format matching InterfaceNode.create():

```diff
- const interfaceId = `INTERFACE#${interfaceName}#${module.file}#${node.loc!.start.line}`;
+ const interfaceId = `${module.file}:INTERFACE:${interfaceName}:${node.loc!.start.line}`;
```

### 2. GraphBuilder.ts - InterfaceNode Import

**File**: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Line**: 9 (new import)

Added import for InterfaceNode:

```typescript
import { InterfaceNode, type InterfaceNodeRecord } from '../../../core/nodes/InterfaceNode.js';
```

### 3. GraphBuilder.bufferInterfaceNodes() Refactoring

**File**: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Lines**: 1058-1126

Replaced inline object literal creation with `InterfaceNode.create()` using a two-pass approach:

**Before**:
```typescript
private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
  for (const iface of interfaces) {
    this._bufferNode({
      id: iface.id,
      type: 'INTERFACE',
      name: iface.name,
      file: iface.file,
      line: iface.line,
      column: iface.column,
      properties: iface.properties,
      extends: iface.extends
    });
    // ... edges using iface.id
  }
}
```

**After**:
```typescript
private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
  // First pass: create all interface nodes and store them
  const interfaceNodes = new Map<string, InterfaceNodeRecord>();

  for (const iface of interfaces) {
    const interfaceNode = InterfaceNode.create(
      iface.name,
      iface.file,
      iface.line,
      iface.column || 0,
      {
        extends: iface.extends,
        properties: iface.properties
      }
    );
    interfaceNodes.set(iface.name, interfaceNode);
    this._bufferNode(interfaceNode as unknown as GraphNode);

    // MODULE -> CONTAINS -> INTERFACE
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: interfaceNode.id
    });
  }

  // Second pass: create EXTENDS edges
  for (const iface of interfaces) {
    if (iface.extends && iface.extends.length > 0) {
      const srcNode = interfaceNodes.get(iface.name)!;

      for (const parentName of iface.extends) {
        const parentNode = interfaceNodes.get(parentName);

        if (parentNode) {
          // Same-file interface
          this._bufferEdge({
            type: 'EXTENDS',
            src: srcNode.id,
            dst: parentNode.id
          });
        } else {
          // External interface - use NodeFactory (already uses InterfaceNode internally)
          const externalInterface = NodeFactory.createInterface(...);
          // ... create node and edge
        }
      }
    }
  }
}
```

## Key Design Decisions

1. **Two-pass approach**: First pass creates all interface nodes and stores them in a Map by name. Second pass creates EXTENDS edges using the stored nodes. This ensures consistent ID references between source and destination nodes.

2. **`as unknown as GraphNode` cast**: Same pattern already used for external interfaces - preserves compatibility with the generic `_bufferNode()` method.

3. **`iface.column || 0` default**: The `column` field in `InterfaceDeclarationInfo` is optional, but `InterfaceNode.create()` requires it. Providing `0` as default matches the pattern used elsewhere.

4. **NodeFactory.createInterface for external interfaces**: Kept as-is since it already delegates to `InterfaceNode.create()` internally. No change needed.

## Verification

### Build
```
npm run build - PASSED
```

### Tests

**InterfaceNode unit tests (NodeFactoryPart2.test.js)**: 55 tests PASSED

**InterfaceNode migration tests (InterfaceNodeMigration.test.js)**: 21/22 tests PASSED
- 1 pre-existing failure (test data has parsing error, unrelated to this change)
- All tests related to ID format, EXTENDS edges, and external interfaces PASS

## Files Modified

| File | Lines Changed | Description |
|------|---------------|-------------|
| `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | 1 | ID format: `#` -> `:` |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | ~40 | Import + bufferInterfaceNodes refactor |

## Breaking Change Note

This change updates INTERFACE node IDs from:
- Old: `INTERFACE#IUser#/src/types.ts#5`
- New: `/src/types.ts:INTERFACE:IUser:5`

Existing graphs with old format IDs will need re-analysis: `grafema analyze --clear`

## Status

**COMPLETE** - Ready for review
