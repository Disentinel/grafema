# REG-107: Part 2.3 GraphBuilder - REVISED APPROACH

**Date:** 2025-01-22
**Author:** Joel Spolsky (Implementation Planner)
**Based on:** Don's investigation (005-graphbuilder-investigation.md)

---

## Executive Summary

**Corrected understanding:** GraphBuilder lines 815-860 are the **PRIMARY EXPRESSION node factory**, not reconstruction code.

The code cannot be deleted. It must be migrated to use ExpressionNode factory.

---

## Why This Changes Part 2.3

### Original Plan Was Wrong

Original plan (line 389-637 in tech plan) assumed:
- GraphBuilder "reconstructs" nodes from upstream
- ID already exists from visitors
- Just validate and pass through

**Reality from Don's investigation:**
- GraphBuilder **creates** the majority of EXPRESSION nodes
- Visitors only create EXPRESSION nodes for:
  1. Destructuring (VariableVisitor)
  2. Call arguments (CallExpressionVisitor)
- Normal assignments (90%+ of cases) flow through:
  ```
  JSASTAnalyzer.trackVariableAssignment()
    → pushes to variableAssignments[]
    → GraphBuilder.bufferAssignmentEdges()
    → CREATES EXPRESSION node (line 815-860)
  ```

### Two Creation Paths

**Path A: Visitor creates node (MINORITY)**
```javascript
// VariableVisitor line 228-241
const { x } = obj;  // Destructuring
// Creates EXPRESSION node, pushes to literals[]
// GraphBuilder.bufferLiterals() processes it
```

**Path B: GraphBuilder creates node (MAJORITY)**
```javascript
// Normal assignment
const m = obj.method;
// JSASTAnalyzer creates metadata + generates ID
// Pushes to variableAssignments[] (NOT literals[])
// GraphBuilder reads metadata and CREATES the node
```

---

## Root Problem: ID Generation Confusion

### Current Architecture

**JSASTAnalyzer (line 607):**
```typescript
const expressionId = `EXPRESSION#${objectName}.${propertyName}#${module.file}#${line}:${column}`;

variableAssignments.push({
  sourceType: 'EXPRESSION',
  sourceId: expressionId,        // ← Legacy format ID
  expressionType: 'MemberExpression',
  object: objectName,
  property: propertyName,
  // ... metadata
  file: module.file,
  line: line
});
```

**GraphBuilder (line 832-857):**
```typescript
const expressionNode: GraphNode = {
  id: sourceId,                    // ← Uses the legacy ID from assignment
  type: 'EXPRESSION',
  expressionType,
  file: exprFile,
  line: exprLine,
  // ... computed fields based on expressionType
};

this._bufferNode(expressionNode);
```

### The Architecture Constraint

GraphBuilder **must** use the `sourceId` from the assignment because:
1. Other code (DERIVES_FROM edge creation, line 865+) references this ID
2. The ID was already stored in `variableAssignments`
3. Changing the ID would break edge resolution

**We cannot generate a new ID in GraphBuilder** - we must use the one from upstream.

---

## Correct Solution: Two-Stage Migration

### Stage 1: Migrate JSASTAnalyzer (ID Generation)

**Problem:** JSASTAnalyzer generates legacy `EXPRESSION#` IDs

**Solution:** Make JSASTAnalyzer use ExpressionNode factory to generate IDs

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Current code (line 607):**
```typescript
const expressionId = `EXPRESSION#${objectName}.${propertyName}#${module.file}#${line}:${initExpression.start}`;
```

**Replace with:**
```typescript
// Generate ID using ExpressionNode factory
const expressionId = ExpressionNode.generateId(
  'MemberExpression',
  module.file,
  line,
  initExpression.start  // column
);
```

**Add to ExpressionNode.ts:**
```typescript
/**
 * Generate EXPRESSION node ID without creating the full node
 *
 * Used by JSASTAnalyzer when creating assignment metadata.
 * The full node is created later by GraphBuilder.
 */
static generateId(
  expressionType: string,
  file: string,
  line: number,
  column: number
): string {
  return `${file}:EXPRESSION:${expressionType}:${line}:${column}`;
}
```

**Why this works:**
- JSASTAnalyzer only needs the ID, not the full node
- GraphBuilder will construct the full node later
- ID format is consistent (factory-based)
- No behavior change, just ID format migration

### Stage 2: Migrate GraphBuilder (Node Creation)

**Problem:** GraphBuilder manually constructs EXPRESSION nodes

**Solution:** Use ExpressionNode factory with metadata, preserve upstream ID

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Current code (line 815-857):**
```typescript
else if (sourceType === 'EXPRESSION' && sourceId) {
  const {
    expressionType,
    object,
    property,
    computed,
    computedPropertyVar,
    operator,
    // ...
  } = assignment;

  const expressionNode: GraphNode = {
    id: sourceId,
    type: 'EXPRESSION',
    expressionType,
    file: exprFile,
    line: exprLine
  };

  // Manual field population based on type
  if (expressionType === 'MemberExpression') {
    expressionNode.object = object;
    expressionNode.property = property;
    // ...
  }
  // ...

  this._bufferNode(expressionNode);
}
```

**Replace with:**
```typescript
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

  // Create EXPRESSION node using factory
  const expressionNode = ExpressionNode.createFromMetadata(
    expressionType,
    exprFile,
    exprLine,
    exprColumn || 0,
    {
      // ID from upstream (already in new format after Stage 1)
      id: sourceId,

      // Type-specific fields
      object,
      property,
      computed,
      computedPropertyVar,
      operator,

      // Source names for edge creation
      objectSourceName,
      leftSourceName,
      rightSourceName,
      consequentSourceName,
      alternateSourceName
    }
  );

  this._bufferNode(expressionNode);
}
```

**Add to ExpressionNode.ts:**
```typescript
/**
 * Create EXPRESSION node from assignment metadata
 *
 * Used by GraphBuilder when processing variableAssignments.
 * The ID is provided from upstream (generated by JSASTAnalyzer).
 *
 * @param expressionType - Type of expression
 * @param file - File path
 * @param line - Line number
 * @param column - Column position
 * @param options - Must include id; optional: expression properties
 */
static createFromMetadata(
  expressionType: string,
  file: string,
  line: number,
  column: number,
  options: ExpressionNodeOptions & { id: string }
): ExpressionNodeRecord {
  if (!options.id) {
    throw new Error('ExpressionNode.createFromMetadata: id is required');
  }

  // Validate ID format
  if (!options.id.includes(':EXPRESSION:')) {
    throw new Error(
      `ExpressionNode.createFromMetadata: Invalid ID format "${options.id}". ` +
      `Expected format: {file}:EXPRESSION:{type}:{line}:{column}`
    );
  }

  // Create base node structure
  const baseNode: ExpressionNodeRecord = {
    id: options.id,  // Use provided ID (from upstream)
    type: ExpressionNode.TYPE,
    expressionType,
    file,
    line,
    column,
    name: ExpressionNode._computeName(expressionType, options)
  };

  // Add optional fields (same logic as create())
  if (options.object !== undefined) baseNode.object = options.object;
  if (options.property !== undefined) baseNode.property = options.property;
  if (options.computed !== undefined) baseNode.computed = options.computed;
  if (options.computedPropertyVar !== undefined) {
    baseNode.computedPropertyVar = options.computedPropertyVar;
  }
  if (options.operator !== undefined) baseNode.operator = options.operator;
  if (options.path !== undefined) baseNode.path = options.path;
  if (options.baseName !== undefined) baseNode.baseName = options.baseName;
  if (options.propertyPath !== undefined) baseNode.propertyPath = options.propertyPath;
  if (options.arrayIndex !== undefined) baseNode.arrayIndex = options.arrayIndex;

  return baseNode;
}
```

---

## Migration Plan for Part 2.3

### Step 1: Update ExpressionNode.ts

**Add two new methods:**

1. `ExpressionNode.generateId()` - for JSASTAnalyzer
2. `ExpressionNode.createFromMetadata()` - for GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts`

**Location:** After the `create()` method

**Implementation:** See code blocks above

### Step 2: Migrate JSASTAnalyzer

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Add import:**
```typescript
import { ExpressionNode } from '../../core/nodes/ExpressionNode.js';
```

**Replace ID generation in 5 places:**

1. **MemberExpression** (line 607):
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'MemberExpression',
     module.file,
     line,
     initExpression.start
   );
   ```

2. **BinaryExpression** (line ~635):
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'BinaryExpression',
     module.file,
     line,
     initExpression.start
   );
   ```

3. **ConditionalExpression** (line ~653):
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'ConditionalExpression',
     module.file,
     line,
     initExpression.start
   );
   ```

4. **LogicalExpression** (line ~673):
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'LogicalExpression',
     module.file,
     line,
     initExpression.start
   );
   ```

5. **TemplateLiteral** (line ~694):
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'TemplateLiteral',
     module.file,
     line,
     initExpression.start
   );
   ```

**Also add `column` field to assignment metadata:**
```typescript
variableAssignments.push({
  variableId,
  sourceType: 'EXPRESSION',
  sourceId: expressionId,
  expressionType: 'MemberExpression',
  // ... existing fields ...
  file: module.file,
  line: line,
  column: initExpression.start  // ← ADD THIS
});
```

### Step 3: Migrate GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Add import:**
```typescript
import { ExpressionNode } from '../../../core/nodes/ExpressionNode.js';
```

**Replace lines 815-857:**
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

  // Create node from upstream metadata
  const expressionNode = ExpressionNode.createFromMetadata(
    expressionType,
    exprFile,
    exprLine,
    exprColumn || 0,
    {
      id: sourceId,  // ID from JSASTAnalyzer
      object,
      property,
      computed,
      computedPropertyVar,
      operator
    }
  );

  this._bufferNode(expressionNode);
```

**Keep the rest of the code** (ASSIGNED_FROM and DERIVES_FROM edge creation, lines 859-930)

---

## Integration with Visitor Migrations

### Execution Order

**Phase 2 needs to be split:**

**Phase 2a: Migrate JSASTAnalyzer** (NEW)
1. Add `generateId()` and `createFromMetadata()` to ExpressionNode
2. Update JSASTAnalyzer to use `generateId()`
3. Add `column` field to assignment metadata
4. Run tests - behavior should be IDENTICAL (only IDs changed)

**Phase 2b: Migrate VariableVisitor** (existing Phase 2)
1. Replace inline EXPRESSION creation with `NodeFactory.createExpression()`
2. Remove `LiteralExpressionInfo` interface

**Phase 3: Migrate CallExpressionVisitor** (unchanged)
1. Replace inline EXPRESSION creation with `NodeFactory.createArgumentExpression()`

**Phase 4: Migrate GraphBuilder** (NEW implementation)
1. Update GraphBuilder to use `createFromMetadata()`
2. Remove manual node construction logic

### Why This Order?

1. **JSASTAnalyzer first** because:
   - It generates IDs used by GraphBuilder
   - Must migrate ID format before GraphBuilder expects new format

2. **VariableVisitor second** because:
   - Independent path (literals array)
   - Doesn't affect JSASTAnalyzer → GraphBuilder flow

3. **CallExpressionVisitor third** because:
   - Also independent (literals array)
   - Uses ArgumentExpression subtype

4. **GraphBuilder last** because:
   - Depends on JSASTAnalyzer providing new format IDs
   - After this, all paths use factory

---

## Testing Strategy

### Test 1: ID Format Validation

After Phase 2a (JSASTAnalyzer), run:

```javascript
// In Expression.test.js
it('should generate colon-based IDs from JSASTAnalyzer', async () => {
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
      `ID should use colon format, got: ${expressionNode.id}`
    );
    assert.strictEqual(
      expressionNode.expressionType,
      'MemberExpression',
      'Should be MemberExpression'
    );
  } finally {
    await cleanup(backend, testDir);
  }
});
```

### Test 2: Node Structure Validation

After Phase 4 (GraphBuilder), verify:

```javascript
it('should create complete EXPRESSION nodes with all fields', async () => {
  const { backend, testDir } = await setupTest({
    'index.js': `
const obj = { x: 1, y: 2 };
const val = obj.x;
`
  });

  try {
    let expressionNode = null;
    for await (const node of backend.queryNodes({
      type: 'EXPRESSION',
      expressionType: 'MemberExpression'
    })) {
      expressionNode = node;
      break;
    }

    assert.ok(expressionNode, 'Should find MemberExpression');
    assert.strictEqual(expressionNode.object, 'obj');
    assert.strictEqual(expressionNode.property, 'x');
    assert.strictEqual(expressionNode.computed, false);
    assert.strictEqual(expressionNode.name, 'obj.x');
  } finally {
    await cleanup(backend, testDir);
  }
});
```

### Test 3: Edge Resolution

Verify DERIVES_FROM edges work after migration:

```javascript
it('should create DERIVES_FROM edges using factory-generated IDs', async () => {
  const { backend, testDir } = await setupTest({
    'index.js': `
const base = { value: 42 };
const derived = base.value;
`
  });

  try {
    const edges = [];
    for await (const edge of backend.queryEdges({ type: 'DERIVES_FROM' })) {
      edges.push(edge);
    }

    assert.ok(edges.length > 0, 'Should find DERIVES_FROM edges');

    // Verify edge src/dst use new ID format
    for (const edge of edges) {
      if (edge.src.includes('EXPRESSION')) {
        assert.ok(
          edge.src.includes(':EXPRESSION:'),
          `Edge src should use colon format: ${edge.src}`
        );
      }
      if (edge.dst.includes('EXPRESSION')) {
        assert.ok(
          edge.dst.includes(':EXPRESSION:'),
          `Edge dst should use colon format: ${edge.dst}`
        );
      }
    }
  } finally {
    await cleanup(backend, testDir);
  }
});
```

---

## Risk Analysis Update

### Risk 1: ID Mismatch Between JSASTAnalyzer and GraphBuilder

**Probability:** HIGH if not migrated together

**Mitigation:**
- Phase 2a migrates BOTH JSASTAnalyzer (ID generation) AND GraphBuilder (ID consumption)
- Add validation in `createFromMetadata()` that throws on legacy format
- Test after Phase 2a that IDs match

### Risk 2: Missing Column Data

**Probability:** MEDIUM

**Symptoms:** Column is undefined in assignment metadata

**Mitigation:**
- Add `|| 0` fallback: `exprColumn || 0`
- JSASTAnalyzer uses `initExpression.start` which always exists
- Log warning if column is missing

### Risk 3: Edge References Break

**Probability:** LOW (with correct migration order)

**Symptoms:** DERIVES_FROM edges point to non-existent nodes

**Mitigation:**
- Keep edge creation code (lines 859-930) UNCHANGED
- Only change node creation (lines 832-857)
- Test edge resolution after each phase

---

## Files Modified (Revised)

### Phase 2a: JSASTAnalyzer + GraphBuilder Foundation

**Modified:**
- `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts`
  - Add `generateId()` static method
  - Add `createFromMetadata()` static method

- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
  - Add ExpressionNode import
  - Replace 5 ID generation sites with `generateId()`
  - Add `column` field to assignment metadata

### Phase 4: GraphBuilder Migration

**Modified:**
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
  - Add ExpressionNode import
  - Replace manual node construction (lines 832-857) with `createFromMetadata()`
  - Keep edge creation logic (lines 859-930) unchanged

---

## Success Criteria Update

### Must Have
- [x] `ExpressionNode.generateId()` method exists
- [x] `ExpressionNode.createFromMetadata()` method exists
- [ ] JSASTAnalyzer uses `generateId()` for all EXPRESSION IDs
- [ ] GraphBuilder uses `createFromMetadata()` for node creation
- [ ] All tests pass (especially Expression.test.js)
- [ ] Edge resolution works (DERIVES_FROM, ASSIGNED_FROM)

### Should Have
- [ ] Validation in `createFromMetadata()` throws on legacy IDs
- [ ] Test coverage for both creation paths (visitor vs. GraphBuilder)
- [ ] NoLegacyExpressionIds.test.js includes JSASTAnalyzer checks

---

## Conclusion

**Corrected approach:**

1. JSASTAnalyzer generates IDs → must use factory
2. GraphBuilder creates nodes from metadata → must use factory with provided ID
3. Two new methods needed: `generateId()` and `createFromMetadata()`
4. Migration must preserve ID consistency between generation and consumption

**This is the RIGHT architecture:**
- Separation of concerns: ID generation vs. node creation
- Factory controls format in both cases
- GraphBuilder doesn't generate new IDs, uses upstream IDs
- Clean migration path with clear validation

**Implementation estimate:**
- ExpressionNode updates: 30 minutes
- JSASTAnalyzer migration: 1 hour (5 sites + testing)
- GraphBuilder migration: 45 minutes
- Testing and validation: 1 hour
- **Total: ~3.5 hours for Part 2.3**
