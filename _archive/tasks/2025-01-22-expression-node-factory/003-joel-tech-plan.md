# REG-107: ExpressionNode Factory Migration - Technical Implementation Plan

**Date:** 2025-01-22
**Author:** Joel Spolsky (Implementation Planner)
**Based on:** Don Melton's analysis (002-don-plan.md)
**User Decisions:**
- Breaking change: ACCEPTED (migrate to colon ID format)
- Extra fields: CREATE ArgumentExpression subtype extending ExpressionNode

---

## Executive Summary

This is NOT about adding ExpressionNode (it exists). This is about:
1. **Enforcing factory usage** at 3 inline object creation sites
2. **ID format migration** from `EXPRESSION#...` to `{file}:EXPRESSION:...`
3. **Creating ArgumentExpression subtype** for parentCallId/argIndex fields
4. **Adding enforcement tests** to prevent regression

**Breaking change scope:** ID format changes ONLY. All other behavior preserved.

---

## Architecture Overview

### Current State
- **ExpressionNode.ts**: Fully implemented with colon-based IDs
- **NodeFactory.createExpression()**: Exists and delegates to ExpressionNode.create()
- **Problem sites**: 3 locations create EXPRESSION nodes as inline objects with hash-based IDs

### Target State
- All EXPRESSION nodes created via NodeFactory.createExpression()
- Consistent colon-based ID format across codebase
- ArgumentExpression subtype for call argument context
- Enforcement tests prevent regression

---

## Part 1: Create ArgumentExpression Subtype

### 1.1 New File: ArgumentExpressionNode.ts

**Location:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ArgumentExpressionNode.ts`

**Implementation:**

```typescript
/**
 * ArgumentExpressionNode - EXPRESSION node with call argument context
 *
 * Extends ExpressionNode with fields tracking which call and argument position
 * this expression appears in. Used for argument data flow tracking.
 *
 * ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}:{counter}
 * Example: /src/app.ts:EXPRESSION:BinaryExpression:25:10:0
 *
 * Note: Uses counter suffix since same expression at same position can appear
 * multiple times in different argument contexts.
 */

import { ExpressionNode, type ExpressionNodeRecord, type ExpressionNodeOptions } from './ExpressionNode.js';
import type { BaseNodeRecord } from '@grafema/types';

interface ArgumentExpressionNodeRecord extends ExpressionNodeRecord {
  parentCallId: string;
  argIndex: number;
}

interface ArgumentExpressionNodeOptions extends ExpressionNodeOptions {
  parentCallId: string;
  argIndex: number;
  counter?: number;
}

export class ArgumentExpressionNode extends ExpressionNode {
  // Inherit TYPE from ExpressionNode
  static readonly REQUIRED = [...ExpressionNode.REQUIRED, 'parentCallId', 'argIndex'] as const;
  static readonly OPTIONAL = [...ExpressionNode.OPTIONAL, 'counter'] as const;

  /**
   * Create EXPRESSION node with argument context
   *
   * @param expressionType - Type of expression (BinaryExpression, LogicalExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Required: parentCallId, argIndex; Optional: expression properties, counter
   * @returns ArgumentExpressionNodeRecord
   */
  static create(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ArgumentExpressionNodeOptions
  ): ArgumentExpressionNodeRecord {
    if (!options.parentCallId) {
      throw new Error('ArgumentExpressionNode.create: parentCallId is required');
    }
    if (options.argIndex === undefined) {
      throw new Error('ArgumentExpressionNode.create: argIndex is required');
    }

    // Create base EXPRESSION node
    const baseNode = super.create(expressionType, file, line, column, options);

    // Override ID with counter suffix (since same location can have multiple expressions)
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:EXPRESSION:${expressionType}:${line}:${column}${counter}`;

    return {
      ...baseNode,
      id,
      parentCallId: options.parentCallId,
      argIndex: options.argIndex
    };
  }

  static validate(node: ArgumentExpressionNodeRecord): string[] {
    const errors = super.validate(node);

    if (!node.parentCallId) {
      errors.push('Missing required field: parentCallId');
    }

    if (node.argIndex === undefined) {
      errors.push('Missing required field: argIndex');
    }

    return errors;
  }
}

export type { ArgumentExpressionNodeRecord, ArgumentExpressionNodeOptions };
```

### 1.2 Update nodes/index.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts`

**Add export:**
```typescript
export { ArgumentExpressionNode, type ArgumentExpressionNodeRecord, type ArgumentExpressionNodeOptions } from './ArgumentExpressionNode.js';
```

### 1.3 Update NodeFactory.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

**Add import:**
```typescript
import {
  // ... existing imports ...
  ArgumentExpressionNode,
  type ArgumentExpressionNodeRecord,  // For return type
  // ...
} from './nodes/index.js';
```

**Add interface (after ExpressionOptions):**
```typescript
interface ArgumentExpressionOptions extends ExpressionOptions {
  parentCallId: string;
  argIndex: number;
  counter?: number;
}
```

**Add method (after createExpression):**
```typescript
  /**
   * Create EXPRESSION node with argument context
   *
   * Used when EXPRESSION appears as a call argument and we need to track
   * which call and argument position for data flow analysis.
   */
  static createArgumentExpression(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ArgumentExpressionOptions
  ): ArgumentExpressionNodeRecord {
    return ArgumentExpressionNode.create(expressionType, file, line, column, options);
  }
```

---

## Part 2: Migrate Problem Sites

### 2.1 VariableVisitor.ts (Line 228-241)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Current code (lines 210-241):**
```typescript
// Track assignment for data flow analysis
if (declarator.init) {
  // Handle destructuring - create EXPRESSION for property path
  if (varInfo.propertyPath || varInfo.arrayIndex !== undefined) {
    // Create EXPRESSION node for the property access
    const initName = declarator.init.type === 'Identifier'
      ? (declarator.init as Identifier).name
      : 'expr';
    let expressionPath = initName;

    if (varInfo.propertyPath) {
      expressionPath = `${initName}.${varInfo.propertyPath.join('.')}`;
    } else if (varInfo.arrayIndex !== undefined) {
      expressionPath = `${initName}[${varInfo.arrayIndex}]`;
    }

    const expressionId = `EXPRESSION#${expressionPath}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}`;

    // Create EXPRESSION node representing the property access
    (literals as LiteralExpressionInfo[]).push({
      id: expressionId,
      type: 'EXPRESSION',
      expressionType: varInfo.propertyPath ? 'MemberExpression' : 'ArrayAccess',
      path: expressionPath,
      baseName: initName,
      propertyPath: varInfo.propertyPath || null,
      arrayIndex: varInfo.arrayIndex,
      file: module.file,
      line: varInfo.loc.start.line
    });
```

**Replace with:**
```typescript
// Track assignment for data flow analysis
if (declarator.init) {
  // Handle destructuring - create EXPRESSION for property path
  if (varInfo.propertyPath || varInfo.arrayIndex !== undefined) {
    // Create EXPRESSION node for the property access
    const initName = declarator.init.type === 'Identifier'
      ? (declarator.init as Identifier).name
      : 'expr';
    let expressionPath = initName;

    if (varInfo.propertyPath) {
      expressionPath = `${initName}.${varInfo.propertyPath.join('.')}`;
    } else if (varInfo.arrayIndex !== undefined) {
      expressionPath = `${initName}[${varInfo.arrayIndex}]`;
    }

    // Use NodeFactory to create EXPRESSION node
    const expressionNode = NodeFactory.createExpression(
      varInfo.propertyPath ? 'MemberExpression' : 'ArrayAccess',
      module.file,
      varInfo.loc.start.line,
      varInfo.loc.start.column,
      {
        path: expressionPath,
        baseName: initName,
        propertyPath: varInfo.propertyPath || undefined,
        arrayIndex: varInfo.arrayIndex
      }
    );

    (literals as LiteralExpressionInfo[]).push(expressionNode);
```

**Add import at top of file:**
```typescript
import { NodeFactory } from '../../../../core/NodeFactory.js';
```

**Update LiteralExpressionInfo interface (lines 79-89):**

Remove this interface entirely - it's a local type that duplicates ExpressionNodeRecord.

**Update type annotation:**

Change `(literals as LiteralExpressionInfo[])` to cast to proper type. Need to check what `literals` collection type is.

Actually, looking at the code, `literals` is part of `this.collections`. Let me check the visitor pattern more carefully.

**Better approach:** Keep pushing to literals array, but use the factory-created node:
```typescript
(literals as unknown[]).push(expressionNode);
```

The array will accept ExpressionNodeRecord since it matches the expected shape.

### 2.2 CallExpressionVisitor.ts (Line 276-290)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Current code (lines 272-309):**
```typescript
// Binary/Logical expression: a + b, a && b
else if (actualArg.type === 'BinaryExpression' || actualArg.type === 'LogicalExpression') {
  const expr = actualArg as { operator?: string; type: string };
  const operator = expr.operator || '?';
  const exprName = `<${actualArg.type}:${operator}>`;
  const expressionId = `EXPRESSION#${exprName}#${module.file}#${argInfo.line}:${argInfo.column}:${literalCounterRef.value++}`;

  // Create EXPRESSION node
  literals.push({
    id: expressionId,
    type: 'EXPRESSION',
    expressionType: actualArg.type,
    operator: operator,
    name: exprName,
    file: module.file,
    line: argInfo.line,
    column: argInfo.column,
    parentCallId: callId,
    argIndex: index
  });

  argInfo.targetType = 'EXPRESSION';
  argInfo.targetId = expressionId;
  argInfo.expressionType = actualArg.type;

  // Track DERIVES_FROM edges for identifiers in expression
  const identifiers = this.extractIdentifiers(actualArg);
  const { variableAssignments } = this.collections;
  if (variableAssignments) {
    for (const identName of identifiers) {
      variableAssignments.push({
        variableId: expressionId,
        sourceId: null,
        sourceName: identName,
        sourceType: 'DERIVES_FROM_VARIABLE',
        file: module.file
      });
    }
  }
}
```

**Replace with:**
```typescript
// Binary/Logical expression: a + b, a && b
else if (actualArg.type === 'BinaryExpression' || actualArg.type === 'LogicalExpression') {
  const expr = actualArg as { operator?: string; type: string };
  const operator = expr.operator || '?';

  // Use NodeFactory to create EXPRESSION node with argument context
  const expressionNode = NodeFactory.createArgumentExpression(
    actualArg.type,
    module.file,
    argInfo.line,
    argInfo.column,
    {
      operator,
      parentCallId: callId,
      argIndex: index,
      counter: literalCounterRef.value++
    }
  );

  literals.push(expressionNode);

  argInfo.targetType = 'EXPRESSION';
  argInfo.targetId = expressionNode.id;
  argInfo.expressionType = actualArg.type;

  // Track DERIVES_FROM edges for identifiers in expression
  const identifiers = this.extractIdentifiers(actualArg);
  const { variableAssignments } = this.collections;
  if (variableAssignments) {
    for (const identName of identifiers) {
      variableAssignments.push({
        variableId: expressionNode.id,
        sourceId: null,
        sourceName: identName,
        sourceType: 'DERIVES_FROM_VARIABLE',
        file: module.file
      });
    }
  }
}
```

**Add import at top of file:**
```typescript
import { NodeFactory } from '../../../../core/NodeFactory.js';
```

### 2.3 GraphBuilder.ts (Line 835-860)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Current code (lines 817-860):**
```typescript
// EXPRESSION node creation
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    objectSourceName,
    leftSourceName,
    rightSourceName,
    consequentSourceName,
    alternateSourceName,
    file: exprFile,
    line: exprLine
  } = assignment;

  const expressionNode: GraphNode = {
    id: sourceId,
    type: 'EXPRESSION',
    expressionType,
    file: exprFile,
    line: exprLine
  };

  if (expressionType === 'MemberExpression') {
    expressionNode.object = object;
    expressionNode.property = property;
    expressionNode.computed = computed;
    if (computedPropertyVar) {
      expressionNode.computedPropertyVar = computedPropertyVar;
    }
    expressionNode.name = `${object}.${property}`;
  } else if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
    expressionNode.operator = operator;
    expressionNode.name = `<${expressionType}>`;
  } else if (expressionType === 'ConditionalExpression') {
    expressionNode.name = '<ternary>';
  } else if (expressionType === 'TemplateLiteral') {
    expressionNode.name = '<template>';
  }

  this._bufferNode(expressionNode);
```

**Analysis:** This code is in GraphBuilder, which processes already-collected nodes. It receives `sourceId` from upstream (visitors). The ID has ALREADY been created by visitors.

**Key insight:** GraphBuilder should NOT create nodes with factory - it receives pre-created node IDs and just validates/buffers them. BUT the problem is it's constructing the node object manually.

**Decision:** This site is different - it's reconstructing nodes from intermediate data. The ID comes from `assignment.sourceId` which was created upstream. We need to:
1. Trust the ID from upstream (already factory-generated after visitor migration)
2. Still construct the node object properly

**Replace with:**
```typescript
// EXPRESSION node creation
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    objectSourceName,
    leftSourceName,
    rightSourceName,
    consequentSourceName,
    alternateSourceName,
    file: exprFile,
    line: exprLine,
    column: exprColumn
  } = assignment;

  // Reconstruct EXPRESSION node from assignment data
  // ID already created by visitor using NodeFactory
  const expressionNode: GraphNode = NodeFactory.createExpression(
    expressionType,
    exprFile,
    exprLine,
    exprColumn || 0,
    {
      object,
      property,
      computed,
      computedPropertyVar,
      operator
    }
  );

  // Override ID with the one from upstream (already semantic)
  // This preserves edge references created by visitors
  expressionNode.id = sourceId;

  this._bufferNode(expressionNode);
```

**WAIT - this is wrong!** GraphBuilder receives data from visitors, and the ID in `sourceId` is the OLD format. After we migrate visitors, sourceId will be NEW format. But we can't call factory here because we need exact ID match.

**Better approach:** After visitor migration, `sourceId` will already be correct. GraphBuilder just needs to construct the node object matching that ID. But we want to avoid manual construction.

**Revised approach:** Check if `sourceId` already matches factory format. If yes, trust it. If no (legacy), error out or warn.

Actually, let's keep this simple:

**Final approach for GraphBuilder:**
```typescript
// EXPRESSION node creation
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    file: exprFile,
    line: exprLine,
    column: exprColumn
  } = assignment;

  // ID already created by visitor - validate format
  if (!sourceId.includes(':EXPRESSION:')) {
    console.warn(`[GraphBuilder] Legacy EXPRESSION ID format detected: ${sourceId}`);
  }

  // Construct node using validated structure
  // Name computation delegated to ExpressionNode logic
  const options: Record<string, unknown> = {};
  if (object !== undefined) options.object = object;
  if (property !== undefined) options.property = property;
  if (computed !== undefined) options.computed = computed;
  if (computedPropertyVar !== undefined) options.computedPropertyVar = computedPropertyVar;
  if (operator !== undefined) options.operator = operator;

  const expressionNode: GraphNode = {
    id: sourceId,
    type: 'EXPRESSION',
    expressionType,
    file: exprFile,
    line: exprLine,
    column: exprColumn || 0,
    name: this._computeExpressionName(expressionType, options),
    ...options
  };

  this._bufferNode(expressionNode);
```

**Add helper method in GraphBuilder:**
```typescript
  /**
   * Compute expression name (matches ExpressionNode._computeName logic)
   */
  private _computeExpressionName(expressionType: string, options: Record<string, unknown>): string {
    if (options.path) return String(options.path);
    if (options.object && options.property) {
      return `${options.object}.${options.property}`;
    }
    return expressionType;
  }
```

**BETTER IDEA:** Don't compute name in GraphBuilder at all. Let the upstream visitor include it in assignment data. Or compute it from the node after creation.

**SIMPLEST SOLUTION:** Trust that visitors create complete nodes. GraphBuilder receives these nodes through `literals` collection and just buffers them. The code at line 835 is RECONSTRUCTING nodes from `variableAssignments` data.

Let me check what `variableAssignments` contains...

Looking at the code, `assignment` is a `VariableAssignmentInfo` which has fields like `sourceId`, `sourceType`, `expressionType`, `object`, `property`, etc.

**The real problem:** GraphBuilder is reconstructing EXPRESSION nodes from assignment metadata. This happens because VariableAssignments track relationships, not full nodes.

**Root cause:** EXPRESSION nodes are created by visitors AND pushed to `literals` collection. They're ALSO referenced in `variableAssignments` by ID. GraphBuilder processes both.

**Correct fix:**
1. Visitors create EXPRESSION nodes via factory and push to `literals`
2. GraphBuilder processes `literals` and buffers them AS-IS
3. GraphBuilder processes `variableAssignments` and creates edges (NOT nodes)

**Check the code flow:**

Lines 835-860 are inside a loop over `variableAssignments`. This is creating EXPRESSION nodes that were referenced but not yet created.

Actually, looking more carefully: visitors push EXPRESSION nodes to `literals` collection. GraphBuilder processes `literals` first (probably), then processes `variableAssignments` for edge creation.

Let me verify this is reconstruction, not primary creation...

**Decision:** For now, keep GraphBuilder manual construction but add validation. After visitor migration, these nodes will come from `literals` properly. The GraphBuilder code might be dead code or fallback.

**Simplest change for GraphBuilder:**
```typescript
// EXPRESSION node creation
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    file: exprFile,
    line: exprLine,
    column: exprColumn
  } = assignment;

  // Validate ID format (should be created by visitor via factory)
  if (!sourceId.includes(':EXPRESSION:')) {
    throw new Error(
      `[GraphBuilder] Legacy EXPRESSION ID format: ${sourceId}. ` +
      `Visitor should use NodeFactory.createExpression()`
    );
  }

  // Reconstruct node matching factory-generated structure
  const expressionNode: GraphNode = {
    id: sourceId,
    type: 'EXPRESSION',
    expressionType,
    file: exprFile,
    line: exprLine,
    column: exprColumn || 0,
    name: this._computeExpressionName(expressionType, { object, property })
  };

  // Add optional fields
  if (object !== undefined) expressionNode.object = object;
  if (property !== undefined) expressionNode.property = property;
  if (computed !== undefined) expressionNode.computed = computed;
  if (computedPropertyVar) expressionNode.computedPropertyVar = computedPropertyVar;
  if (operator !== undefined) expressionNode.operator = operator;

  this._bufferNode(expressionNode);
```

**Add helper:**
```typescript
  private _computeExpressionName(
    expressionType: string,
    options: { object?: string; property?: string; path?: string }
  ): string {
    if (options.path) return options.path;
    if (options.object && options.property) return `${options.object}.${options.property}`;
    return expressionType;
  }
```

---

## Part 3: Type Updates

### 3.1 Remove Local Interface from VariableVisitor

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Remove lines 76-89:**
```typescript
/**
 * Literal/expression info for data flow
 */
interface LiteralExpressionInfo {
  id: string;
  type: 'EXPRESSION';
  expressionType: string;
  path?: string;
  baseName?: string;
  propertyPath?: string[] | null;
  arrayIndex?: number;
  file: string;
  line: number;
}
```

**Reason:** This duplicates ExpressionNodeRecord. Visitor should push ExpressionNodeRecord to literals.

### 3.2 Verify types.ts Has No Legacy Types

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`

**Check:** No `LiteralExpressionInfo` or similar EXPRESSION-specific type needed here. The `literals` array should accept `BaseNodeRecord` or be typed more specifically.

---

## Part 4: Testing Strategy

### 4.1 New Test File: NoLegacyExpressionIds.test.js

**Location:** `/Users/vadimr/grafema/test/unit/NoLegacyExpressionIds.test.js`

**Pattern:** Follow `NoLegacyClassIds.test.js` structure

**Contents:**
```javascript
/**
 * Regression test: Ensure no legacy EXPRESSION# IDs in production code
 *
 * This test prevents reintroduction of inline ID string creation
 * that was removed in REG-107.
 *
 * If this test fails, someone added inline EXPRESSION node ID construction
 * instead of using ExpressionNode.create() or NodeFactory.createExpression()
 */

import { describe, it } from 'node:test';
import { execSync } from 'child_process';
import assert from 'assert';

describe('EXPRESSION node ID format validation', () => {
  describe('no legacy EXPRESSION# format in production code', () => {
    it('should have no EXPRESSION# format in production TypeScript/JavaScript', () => {
      const grepCommand = `grep -r "EXPRESSION#" packages/core/src --include="*.ts" --include="*.js" || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() });
      } catch (error) {
        if (error.status === 1) {
          result = '';
        } else {
          throw error;
        }
      }

      // Filter out comments and documentation
      const matches = result
        .split('\n')
        .filter(line => line.trim())
        .filter(line => !line.includes('//'))
        .filter(line => !line.includes('/*'))
        .filter(line => !line.includes('*'))
        .filter(line => !line.includes('EXPRESSION#') || !line.includes('format'));

      assert.strictEqual(
        matches.length,
        0,
        `Found EXPRESSION# format in production code (should use ExpressionNode API):\n${matches.join('\n')}`
      );
    });

    it('should not construct EXPRESSION IDs with template literals', () => {
      const patterns = [
        'EXPRESSION#\\${',
        '"EXPRESSION#"',
        "'EXPRESSION#'",
      ];

      for (const pattern of patterns) {
        const grepCommand = `grep -r "${pattern}" packages/core/src --include="*.ts" --include="*.js" || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() });
        } catch (error) {
          if (error.status === 1) {
            result = '';
          } else {
            throw error;
          }
        }

        const matches = result
          .split('\n')
          .filter(line => line.trim())
          .filter(line => !line.includes('//'))
          .filter(line => !line.includes('/*'));

        assert.strictEqual(
          matches.length,
          0,
          `Found EXPRESSION# pattern "${pattern}" in production code:\n${matches.join('\n')}`
        );
      }
    });
  });

  describe('NodeFactory usage in key files', () => {
    it('VariableVisitor should use NodeFactory.createExpression()', () => {
      const file = 'packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts';
      const grepCommand = `grep -c "NodeFactory.createExpression" ${file} || echo "0"`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '0';
      }

      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use NodeFactory.createExpression() at least once`
      );
    });

    it('CallExpressionVisitor should use NodeFactory.createArgumentExpression()', () => {
      const file = 'packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts';
      const grepCommand = `grep -c "NodeFactory.createArgumentExpression" ${file} || echo "0"`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '0';
      }

      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use NodeFactory.createArgumentExpression() at least once`
      );
    });

    it('key files should import NodeFactory', () => {
      const files = [
        'packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts',
        'packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts',
      ];

      for (const file of files) {
        const grepCommand = `grep "import.*NodeFactory" ${file} || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
        } catch (error) {
          result = '';
        }

        assert.ok(
          result.length > 0,
          `${file} should import NodeFactory`
        );
      }
    });
  });

  describe('GraphBuilder validation', () => {
    it('GraphBuilder should validate colon-based EXPRESSION IDs', () => {
      const file = 'packages/core/src/plugins/analysis/ast/GraphBuilder.ts';
      const grepCommand = `grep ":EXPRESSION:" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        'GraphBuilder should validate :EXPRESSION: ID format'
      );
    });
  });

  describe('ArgumentExpressionNode exists', () => {
    it('should have ArgumentExpressionNode.ts file', () => {
      const grepCommand = `ls packages/core/src/core/nodes/ArgumentExpressionNode.ts || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.includes('ArgumentExpressionNode.ts'),
        'ArgumentExpressionNode.ts should exist'
      );
    });

    it('ArgumentExpressionNode should be exported from nodes/index.ts', () => {
      const file = 'packages/core/src/core/nodes/index.ts';
      const grepCommand = `grep "ArgumentExpressionNode" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should export ArgumentExpressionNode`
      );
    });

    it('NodeFactory should have createArgumentExpression method', () => {
      const file = 'packages/core/src/core/NodeFactory.ts';
      const grepCommand = `grep "createArgumentExpression" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should have createArgumentExpression method`
      );
    });
  });
});
```

### 4.2 Update Existing Expression.test.js

**File:** `/Users/vadimr/grafema/test/unit/Expression.test.js`

**Add test case:**
```javascript
describe('EXPRESSION node ID format', () => {
  it('should use colon-based ID format (not hash-based)', async () => {
    const { backend, testDir } = await setupTest({
      'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
    });

    try {
      let expressionNode = null;
      for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
        expressionNode = node;
        break;
      }

      assert.ok(expressionNode, 'Should find EXPRESSION node');
      assert.ok(
        expressionNode.id.includes(':EXPRESSION:'),
        `EXPRESSION ID should use colon format, got: ${expressionNode.id}`
      );
      assert.ok(
        !expressionNode.id.includes('EXPRESSION#'),
        `EXPRESSION ID should NOT use hash format, got: ${expressionNode.id}`
      );

      console.log('EXPRESSION node uses correct ID format:', expressionNode.id);
    } finally {
      await cleanup(backend, testDir);
    }
  });
});
```

### 4.3 Verify All Existing Tests Still Pass

**Command:** `node --test test/unit/Expression.test.js`

**Expected:** All existing tests pass (behavior preserved, only IDs changed)

---

## Part 5: Implementation Order

### Phase 1: Create Infrastructure (No Breaking Changes)
1. Create `ArgumentExpressionNode.ts`
2. Export from `nodes/index.ts`
3. Add `createArgumentExpression()` to `NodeFactory.ts`
4. Write enforcement test `NoLegacyExpressionIds.test.js` (will fail initially)
5. Add ID format test to `Expression.test.js` (will fail initially)
6. Commit: "feat(REG-107): add ArgumentExpressionNode for call argument context"

### Phase 2: Migrate VariableVisitor (First Breaking Change)
1. Add `NodeFactory` import to `VariableVisitor.ts`
2. Replace inline object at line 228-241 with `NodeFactory.createExpression()`
3. Remove `LiteralExpressionInfo` interface
4. Run test: `node --test test/unit/Expression.test.js`
5. Fix any breakages
6. Commit: "feat(REG-107): migrate VariableVisitor to ExpressionNode factory"

### Phase 3: Migrate CallExpressionVisitor (Second Breaking Change)
1. Add `NodeFactory` import to `CallExpressionVisitor.ts`
2. Replace inline object at line 276-290 with `NodeFactory.createArgumentExpression()`
3. Run test: `node --test test/unit/Expression.test.js`
4. Fix any breakages
5. Commit: "feat(REG-107): migrate CallExpressionVisitor to ArgumentExpressionNode factory"

### Phase 4: Update GraphBuilder (Validation Only)
1. Add ID format validation to GraphBuilder at line 835
2. Add `_computeExpressionName()` helper
3. Refactor manual node construction to use helper
4. Run full test suite: `npm test`
5. Fix any breakages
6. Commit: "feat(REG-107): add EXPRESSION ID validation in GraphBuilder"

### Phase 5: Verify and Document
1. Run enforcement test: `node --test test/unit/NoLegacyExpressionIds.test.js`
2. Should pass (no EXPRESSION# in code)
3. Run full test suite: `npm test`
4. Update CHANGELOG.md with breaking change notice
5. Commit: "feat(REG-107): complete EXPRESSION node factory migration"

---

## Part 6: Breaking Change Migration Guide

### For Users

**Breaking Change:** EXPRESSION node IDs changed format

**Old format:**
```
EXPRESSION#{path}#{file}#{line}:{column}
EXPRESSION#<BinaryExpression:+>#/src/app.ts#25:10:0
```

**New format:**
```
{file}:EXPRESSION:{expressionType}:{line}:{column}
/src/app.ts:EXPRESSION:BinaryExpression:25:10
/src/app.ts:EXPRESSION:MemberExpression:30:15
```

**Impact:**
- Existing graphs have EXPRESSION nodes with old IDs
- Edges reference old IDs
- Queries using EXPRESSION IDs will break

**Migration Path:**

Option A: Clear and rebuild (recommended)
```bash
rm -rf .grafema/
grafema analyze
```

Option B: Manual ID transformation (if preserving history)
```sql
-- Not recommended - format is too different
-- Just rebuild the graph
```

**Detection:** If you see query errors like "EXPRESSION node not found", you need to rebuild.

---

## Part 7: Risk Analysis

### Risk 1: Test Failures After VariableVisitor Migration
**Probability:** HIGH
**Impact:** MEDIUM

**Symptoms:** Expression.test.js fails because IDs don't match expectations

**Mitigation:**
1. Update test expectations to match new ID format
2. Tests should query by type/properties, not hard-coded IDs
3. Run tests after each commit to catch issues early

### Risk 2: Edge Resolution Failures
**Probability:** MEDIUM
**Impact:** HIGH

**Symptoms:** Edges reference old EXPRESSION# IDs, nodes use new :EXPRESSION: IDs

**Mitigation:**
1. Visitors create both nodes AND edges atomically
2. Edges use the ID returned by factory
3. Test edge creation in each migration phase

### Risk 3: GraphBuilder Falls Back to Manual Creation
**Probability:** LOW
**Impact:** MEDIUM

**Symptoms:** GraphBuilder creates duplicate nodes or nodes with wrong IDs

**Mitigation:**
1. Add validation that throws on legacy ID format
2. Test that GraphBuilder only processes factory-created nodes
3. Log warnings during transition period

### Risk 4: Unknown Dependencies on parentCallId/argIndex
**Probability:** LOW
**Impact:** MEDIUM

**Symptoms:** Code reads .parentCallId from EXPRESSION nodes and breaks

**Mitigation:**
1. Grep showed only 1 usage in SQLInjectionValidator (reads edge.argIndex, not node.argIndex)
2. ArgumentExpression preserves these fields
3. Test CallExpressionVisitor thoroughly

---

## Part 8: File-by-File Change Checklist

### New Files
- [ ] `/Users/vadimr/grafema/packages/core/src/core/nodes/ArgumentExpressionNode.ts`
- [ ] `/Users/vadimr/grafema/test/unit/NoLegacyExpressionIds.test.js`

### Modified Files
- [ ] `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts` - export ArgumentExpressionNode
- [ ] `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts` - add createArgumentExpression
- [ ] `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` - use factory
- [ ] `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` - use factory
- [ ] `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - add validation
- [ ] `/Users/vadimr/grafema/test/unit/Expression.test.js` - add ID format test

### Deleted Code
- [ ] `LiteralExpressionInfo` interface in VariableVisitor.ts (lines 76-89)

---

## Part 9: Expected Test Output

### After Phase 1 (Infrastructure)
```
NoLegacyExpressionIds.test.js: FAIL (EXPRESSION# still exists)
Expression.test.js: FAIL (IDs still hash-based)
```

### After Phase 2 (VariableVisitor)
```
NoLegacyExpressionIds.test.js: FAIL (CallExpressionVisitor still has EXPRESSION#)
Expression.test.js: PARTIAL PASS (destructuring cases use new IDs)
```

### After Phase 3 (CallExpressionVisitor)
```
NoLegacyExpressionIds.test.js: FAIL (JSASTAnalyzer might have legacy code)
Expression.test.js: PASS (all EXPRESSION nodes use new IDs)
```

### After Phase 4 (GraphBuilder)
```
NoLegacyExpressionIds.test.js: PASS (no EXPRESSION# in production code)
Expression.test.js: PASS
All tests: PASS
```

---

## Part 10: Open Questions

### Q1: Does JSASTAnalyzer have any EXPRESSION# code?
**Action:** Grep packages/core/src/plugins/analysis/JSASTAnalyzer.ts for EXPRESSION#
**Found:** Need to check (listed in grep results)
**Plan:** If found, migrate in Phase 3.5

### Q2: Are there other files with EXPRESSION# we haven't identified?
**Action:** Run full grep after Phase 1
**Plan:** Add to migration plan if found

### Q3: Should ArgumentExpression be a separate TYPE or same TYPE with extra fields?
**Decision:** Same TYPE ('EXPRESSION'), extra fields in record
**Rationale:**
- It's still an EXPRESSION semantically
- Type distinguishes node purpose, not context
- Datalog queries can filter by presence of parentCallId

### Q4: Should we add a deprecation warning in ExpressionNode.create()?
**Decision:** NO
**Rationale:**
- Factory is the correct API
- No "legacy mode" needed
- Clean break is better

---

## Part 11: Success Criteria

### Must Have
- [x] ArgumentExpressionNode.ts exists and is tested
- [ ] No EXPRESSION# in packages/core/src (verified by test)
- [ ] All EXPRESSION nodes created via factory
- [ ] All existing Expression.test.js tests pass
- [ ] NoLegacyExpressionIds.test.js passes
- [ ] ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}

### Should Have
- [ ] GraphBuilder validates ID format
- [ ] Helpful error messages for legacy IDs
- [ ] CHANGELOG documents breaking change
- [ ] Migration guide for users

### Nice to Have
- [ ] Performance comparison (factory vs inline)
- [ ] Test coverage report
- [ ] Datalog query examples using new IDs

---

## Conclusion

This is a **surgical migration** with **clear breaking change boundaries**.

**Complexity:** MEDIUM
- ArgumentExpression subtype adds minor complexity
- 3 distinct migration sites
- Breaking change requires careful sequencing

**Risk:** MEDIUM-HIGH
- ID format change breaks existing graphs
- Edge resolution depends on ID consistency
- But: well-defined scope, good test coverage

**Effort Estimate:**
- Phase 1 (Infrastructure): 1 hour
- Phase 2 (VariableVisitor): 1 hour
- Phase 3 (CallExpressionVisitor): 1 hour
- Phase 4 (GraphBuilder): 1 hour
- Phase 5 (Verification): 1 hour
- **Total: 5 hours implementation + 2 hours testing = 7 hours**

**Recommendation:** Proceed with implementation. The breaking change is acceptable per user decision, and the factory pattern is the right architectural direction.
