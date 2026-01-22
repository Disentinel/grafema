# REG-106: DecoratorNode Migration - Detailed Technical Plan

**Implementation Planner: Joel Spolsky**

## Overview

This is a straightforward migration following the proven pattern from InterfaceNode (REG-103), EnumNode (REG-105), ExportNode (REG-101), and ImportNode (REG-100).

**Scope:** One file change only - `GraphBuilder.bufferDecoratorNodes()` to use `DecoratorNode.create()` instead of inline object literals.

**Why This Matters:**
1. Fixes a bug: the inline literal is missing the `targetId` field in the persisted node
2. Ensures consistent ID format: colon-separated instead of legacy `#` format
3. Centralizes validation through NodeFactory

---

## Part 1: Kent Beck - Test Requirements

### Test File
`/test/unit/DecoratorNodeMigration.test.js`

Follow the exact structure of `InterfaceNodeMigration.test.js` and `EnumNodeMigration.test.js`.

### Test Suite 1: DecoratorNode.create() ID Format Verification

1. **Basic ID Format with Colon Separators** - ID format: `{file}:DECORATOR:{name}:{line}:{column}`
2. **Should NOT Use # Separator in ID**
3. **Column is Required for Disambiguation** - Multiple decorators on same line
4. **Required Fields** - targetId and targetType validation
5. **Preserve All Fields** - All required and optional fields
6. **targetType Values** - CLASS, METHOD, PROPERTY, PARAMETER
7. **Consistent IDs for Same Parameters**

### Test Suite 2: DecoratorNode Validation

1. **Valid decorator node** - empty errors
2. **Missing required fields** - targetId detection

### Test Suite 3: NodeFactory.createDecorator Compatibility

1. **Factory Method Alias** - Same result as DecoratorNode.create
2. **Validation passes** through NodeFactory

### Test Suite 4: GraphBuilder Integration Tests

1. **DECORATED_BY Edge Uses Correct IDs** - colon format verification
2. **Include targetId in persisted node** - BUG FIX verification
3. **Create DECORATED_BY edge with correct node IDs**
4. **Handle multiple decorators on same target**
5. **Handle decorators on methods**
6. **Handle decorators with arguments**
7. **Handle decorators on properties**
8. **Handle decorators on parameters**

---

## Part 2: Rob Pike - Implementation Specifications

### File: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Import Addition (around line 10)

```typescript
import { DecoratorNode } from '../../../core/nodes/DecoratorNode.js';
```

### Before (Lines 1186-1207)

```typescript
private bufferDecoratorNodes(decorators: DecoratorInfo[]): void {
  for (const decorator of decorators) {
    this._bufferNode({
      id: decorator.id,                    // WRONG: uses old legacy ID format
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

### After

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

    this._bufferNode(decoratorNode);

    this._bufferEdge({
      type: 'DECORATED_BY',
      src: decorator.targetId,
      dst: decoratorNode.id  // Use factory-generated ID (colon format)
    });
  }
}
```

---

## Verification Steps

1. **Build Check:** `pnpm build`
2. **Run Decorator Migration Tests:** `node --test test/unit/DecoratorNodeMigration.test.js`
3. **Run Full Test Suite:** `npm test`
4. **Verify ID Format in Database:** DECORATOR nodes should have colon format IDs

---

## Summary

| File | Change |
|------|--------|
| `/test/unit/DecoratorNodeMigration.test.js` | NEW (TDD) |
| `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | MODIFY import + bufferDecoratorNodes() |
