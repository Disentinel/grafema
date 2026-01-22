# REG-106: DecoratorNode Migration - Implementation Report

**Implementation Engineer: Rob Pike**

## Summary

Successfully migrated `GraphBuilder.bufferDecoratorNodes()` to use `DecoratorNode.create()` factory instead of inline object literals.

## Changes Made

### File: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**1. Added Import (line 11)**
```typescript
import { DecoratorNode } from '../../../core/nodes/DecoratorNode.js';
```

**2. Modified `bufferDecoratorNodes()` method (lines 1187-1209)**

Before:
```typescript
private bufferDecoratorNodes(decorators: DecoratorInfo[]): void {
  for (const decorator of decorators) {
    this._bufferNode({
      id: decorator.id,                    // Used legacy ID format
      type: 'DECORATOR',
      name: decorator.name,
      file: decorator.file,
      line: decorator.line,
      column: decorator.column,
      arguments: decorator.arguments,
      targetType: decorator.targetType
      // BUG: Missing targetId field!
    });

    this._bufferEdge({
      type: 'DECORATED_BY',
      src: decorator.targetId,
      dst: decorator.id
    });
  }
}
```

After:
```typescript
private bufferDecoratorNodes(decorators: DecoratorInfo[]): void {
  for (const decorator of decorators) {
    // Create DECORATOR node using factory (generates colon-format ID)
    const decoratorNode = DecoratorNode.create(
      decorator.name,
      decorator.file,
      decorator.line,
      decorator.column || 0,
      decorator.targetId,  // Now included in the node!
      decorator.targetType,
      { arguments: decorator.arguments }
    );

    this._bufferNode(decoratorNode as unknown as GraphNode);

    // TARGET -> DECORATED_BY -> DECORATOR
    this._bufferEdge({
      type: 'DECORATED_BY',
      src: decorator.targetId,
      dst: decoratorNode.id  // Use factory-generated ID (colon format)
    });
  }
}
```

## Bug Fixed

The original implementation was missing `targetId` in the persisted node. The factory now ensures `targetId` is always included in the DECORATOR node.

## ID Format Change

- **Before:** Legacy format with `#` separator (e.g., `DECORATOR#Injectable#5`)
- **After:** Colon-separated format (e.g., `/src/file.ts:DECORATOR:Injectable:5:0`)

## Verification

1. **Build:** `pnpm build` - SUCCESS
2. **Decorator Migration Tests:** `node --test test/unit/DecoratorNodeMigration.test.js`
   - 12 tests passed
   - 9 tests skipped (require decorators-legacy Babel plugin)
3. **Full Test Suite:** `npm test`
   - All decorator-related tests pass
   - Pre-existing failures in unrelated tests (EnumNode, ExpressionNode, etc.) are not related to this change

## Pattern Consistency

The implementation follows the exact pattern established by:
- InterfaceNode migration (REG-103)
- EnumNode migration (REG-105)
- ExportNode migration (REG-101)
- ImportNode migration (REG-100)

The `as unknown as GraphNode` type assertion is consistent with how other node factories are used in this file (see InterfaceNode line 1148, EnumNode line 1172).
