# Rob Pike - Implementation Report (REG-104)

## Summary

Migrated TYPE node creation in `GraphBuilder.bufferTypeAliasNodes()` to use `NodeFactory.createType()`.

## Changes Made

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Method:** `bufferTypeAliasNodes()` (lines 1131-1150)

### Before

```typescript
private bufferTypeAliasNodes(module: ModuleNode, typeAliases: TypeAliasInfo[]): void {
  for (const typeAlias of typeAliases) {
    // Buffer TYPE node
    this._bufferNode({
      id: typeAlias.id,
      type: 'TYPE',
      name: typeAlias.name,
      file: typeAlias.file,
      line: typeAlias.line,
      column: typeAlias.column,
      aliasOf: typeAlias.aliasOf
    });

    // MODULE -> CONTAINS -> TYPE
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: typeAlias.id
    });
  }
}
```

### After

```typescript
private bufferTypeAliasNodes(module: ModuleNode, typeAliases: TypeAliasInfo[]): void {
  for (const typeAlias of typeAliases) {
    // Create TYPE node using factory
    const typeNode = NodeFactory.createType(
      typeAlias.name,
      typeAlias.file,
      typeAlias.line,
      typeAlias.column || 0,
      { aliasOf: typeAlias.aliasOf }
    );
    this._bufferNode(typeNode as unknown as GraphNode);

    // MODULE -> CONTAINS -> TYPE
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: typeNode.id
    });
  }
}
```

## Key Points

1. Replaced inline object construction with `NodeFactory.createType()` call
2. Used `typeAlias.column || 0` for default column value (handles undefined)
3. Used `typeNode as unknown as GraphNode` cast - matches existing pattern in `bufferInterfaceNodes()`
4. Changed edge destination from `typeAlias.id` to `typeNode.id`
5. `NodeFactory` was already imported at line 10

## Verification

### Tests: PASS
```
node --test test/unit/TypeNodeMigration.test.js
# tests 32
# pass 32
# fail 0
```

### Build: PASS
```
npm run build
packages/core build: Done
```

## Pattern Consistency

The implementation follows the same pattern as `bufferInterfaceNodes()` which was migrated in REG-103. Both use:
- Factory method for node creation
- `|| 0` pattern for optional column
- `as unknown as GraphNode` cast for buffer compatibility
- Factory-generated ID for edge destinations
