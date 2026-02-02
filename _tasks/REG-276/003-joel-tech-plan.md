# Joel Spolsky - Technical Implementation Plan for REG-276

## Overview

This document expands Don's high-level plan into specific code changes for implementing RETURNS edges for complex expressions.

## Goal

When a function returns a complex expression (BinaryExpression, ConditionalExpression, MemberExpression, etc.), create:
1. An EXPRESSION node representing the return value
2. DERIVES_FROM edges connecting the EXPRESSION to its source variables/parameters
3. A RETURNS edge connecting the EXPRESSION to the function

## Current State Analysis

### ReturnStatementInfo (types.ts, lines 489-508)

Current interface has fields for basic return types but lacks EXPRESSION-specific metadata:

```typescript
export interface ReturnStatementInfo {
  parentFunctionId: string;
  file: string;
  line: number;
  column: number;
  returnValueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION' | 'NONE';
  returnValueName?: string;
  returnValueId?: string;
  returnValueLine?: number;
  returnValueColumn?: number;
  returnValueCallName?: string;
  expressionType?: string;  // Already exists!
  isImplicitReturn?: boolean;
}
```

### JSASTAnalyzer ReturnStatement Handler (lines 2653-2760)

Current handler detects EXPRESSION type but only stores `expressionType`, `returnValueLine`, and `returnValueColumn`. It doesn't extract source variable names.

### GraphBuilder.bufferReturnEdges (lines 1738-1831)

Current implementation skips EXPRESSION type entirely:

```typescript
case 'EXPRESSION': {
  // For expressions, we skip complex expressions for now
  // This matches how ASSIGNED_FROM handles expressions
  break;
}
```

### Reference: bufferAssignmentEdges EXPRESSION handling (lines 1088-1271)

Shows the pattern we should follow:
1. Uses `NodeFactory.createExpressionFromMetadata()` to create EXPRESSION node
2. Creates ASSIGNED_FROM edge from variable to expression
3. Creates DERIVES_FROM edges based on expression type:
   - MemberExpression: DERIVES_FROM to objectSourceName variable
   - BinaryExpression/LogicalExpression: DERIVES_FROM to leftSourceName and rightSourceName
   - ConditionalExpression: DERIVES_FROM to consequentSourceName and alternateSourceName
   - TemplateLiteral: DERIVES_FROM to each expressionSourceName

---

## Part 1: Extend ReturnStatementInfo

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** After line 507 (before `isImplicitReturn`)

### Fields to Add

```typescript
export interface ReturnStatementInfo {
  // ... existing fields ...

  // For EXPRESSION type - source variable extraction
  // (mirrors VariableAssignmentInfo pattern)

  // For BinaryExpression/LogicalExpression
  operator?: string;
  leftSourceName?: string;
  rightSourceName?: string;

  // For ConditionalExpression
  consequentSourceName?: string;
  alternateSourceName?: string;

  // For MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  objectSourceName?: string;

  // For TemplateLiteral
  expressionSourceNames?: string[];

  // For UnaryExpression
  unaryArgSourceName?: string;

  isImplicitReturn?: boolean;
}
```

### Rationale

These fields match `VariableAssignmentInfo` exactly, enabling code reuse in GraphBuilder. The naming convention follows the established pattern.

---

## Part 2: Update JSASTAnalyzer ReturnStatement Handler

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Lines 2729-2757 (within the ReturnStatement handler)

### Current Code (lines 2729-2757)

```typescript
// Complex expressions (BinaryExpression, ConditionalExpression, etc.)
else if (t.isBinaryExpression(arg) || t.isConditionalExpression(arg) ||
         t.isLogicalExpression(arg) || t.isUnaryExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = arg.type;
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);
}
/ MemberExpression (property access): return obj.prop
else if (t.isMemberExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'MemberExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);
}
// ... etc
```

### New Code

Replace lines 2729-2757 with:

```typescript
// BinaryExpression: return a + b
else if (t.isBinaryExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'BinaryExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);
  returnInfo.operator = arg.operator;

  // Generate stable ID for the EXPRESSION node
  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'BinaryExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  // Extract left operand source
  if (t.isIdentifier(arg.left)) {
    returnInfo.leftSourceName = arg.left.name;
  }
  // Extract right operand source
  if (t.isIdentifier(arg.right)) {
    returnInfo.rightSourceName = arg.right.name;
  }
}
// LogicalExpression: return a && b, return a || b
else if (t.isLogicalExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'LogicalExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);
  returnInfo.operator = arg.operator;

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'LogicalExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  if (t.isIdentifier(arg.left)) {
    returnInfo.leftSourceName = arg.left.name;
  }
  if (t.isIdentifier(arg.right)) {
    returnInfo.rightSourceName = arg.right.name;
  }
}
// ConditionalExpression: return condition ? a : b
else if (t.isConditionalExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'ConditionalExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'ConditionalExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  // Extract consequent (then branch) source
  if (t.isIdentifier(arg.consequent)) {
    returnInfo.consequentSourceName = arg.consequent.name;
  }
  // Extract alternate (else branch) source
  if (t.isIdentifier(arg.alternate)) {
    returnInfo.alternateSourceName = arg.alternate.name;
  }
}
// UnaryExpression: return !x, return -x
else if (t.isUnaryExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'UnaryExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);
  returnInfo.operator = arg.operator;

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'UnaryExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  if (t.isIdentifier(arg.argument)) {
    returnInfo.unaryArgSourceName = arg.argument.name;
  }
}
/ MemberExpression: return obj.prop
else if (t.isMemberExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'MemberExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'MemberExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  // Extract object.property info
  if (t.isIdentifier(arg.object)) {
    returnInfo.object = arg.object.name;
    returnInfo.objectSourceName = arg.object.name;
  }
  if (t.isIdentifier(arg.property)) {
    returnInfo.property = arg.property.name;
  }
  returnInfo.computed = arg.computed;
}
// TemplateLiteral: return `${a} ${b}`
else if (t.isTemplateLiteral(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'TemplateLiteral';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'TemplateLiteral',
    module.file,
    getLine(arg),
    getColumn(arg)
  );

  // Extract all embedded expression identifiers
  const sourceNames: string[] = [];
  for (const expr of arg.expressions) {
    if (t.isIdentifier(expr)) {
      sourceNames.push(expr.name);
    }
  }
  if (sourceNames.length > 0) {
    returnInfo.expressionSourceNames = sourceNames;
  }
}
/ NewExpression: return new Foo()
else if (t.isNewExpression(arg)) {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = 'NewExpression';
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    'NewExpression',
    module.file,
    getLine(arg),
    getColumn(arg)
  );
}
// Fallback for other expression types
else {
  returnInfo.returnValueType = 'EXPRESSION';
  returnInfo.expressionType = arg.type;
  returnInfo.returnValueLine = getLine(arg);
  returnInfo.returnValueColumn = getColumn(arg);

  returnInfo.returnValueId = NodeFactory.generateExpressionId(
    arg.type,
    module.file,
    getLine(arg),
    getColumn(arg)
  );
}
```

### Note on Arrow Function Implicit Returns

The same logic must be applied in TWO additional locations:
1. Lines 2603-2607 (implicit return at function definition level)
2. Lines 2950-2955 (nested arrow function implicit returns)

For these locations, add the same source extraction logic when `returnInfo.returnValueType === 'EXPRESSION'`.

---

## Part 3: Update GraphBuilder.bufferReturnEdges

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location:** Lines 1816-1820 (the `case 'EXPRESSION'` block)

### Current Code

```typescript
case 'EXPRESSION': {
  // For expressions, we skip complex expressions for now
  // This matches how ASSIGNED_FROM handles expressions
  break;
}
```

### New Code

Replace with implementation that mirrors `bufferAssignmentEdges`:

```typescript
case 'EXPRESSION': {
  const {
    expressionType,
    returnValueId,
    returnValueLine,
    returnValueColumn,
    operator,
    object,
    property,
    computed,
    objectSourceName,
    leftSourceName,
    rightSourceName,
    consequentSourceName,
    alternateSourceName,
    expressionSourceNames,
    unaryArgSourceName
  } = ret;

  // Skip if no expression ID was generated
  if (!returnValueId) {
    break;
  }

  // Create EXPRESSION node using NodeFactory
  const expressionNode = NodeFactory.createExpressionFromMetadata(
    expressionType || 'Unknown',
    file,
    returnValueLine || ret.line,
    returnValueColumn || ret.column,
    {
      id: returnValueId,
      object,
      property,
      computed,
      operator
    }
  );

  this._bufferNode(expressionNode);
  sourceNodeId = returnValueId;

  // Buffer DERIVES_FROM edges based on expression type

  // MemberExpression: derives from the object
  if (expressionType === 'MemberExpression' && objectSourceName) {
    const objectVar = variableDeclarations.find(v =>
      v.name === objectSourceName && v.file === file
    );
    if (objectVar) {
      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: returnValueId,
        dst: objectVar.id
      });
    } else {
      // Check parameters
      const objectParam = parameters.find(p =>
        p.name === objectSourceName && p.file === file
      );
      if (objectParam) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: objectParam.id
        });
      }
    }
  }

  // BinaryExpression / LogicalExpression: derives from left and right operands
  if ((expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression')) {
    if (leftSourceName) {
      const leftVar = variableDeclarations.find(v =>
        v.name === leftSourceName && v.file === file
      );
      if (leftVar) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: leftVar.id
        });
      } else {
        const leftParam = parameters.find(p =>
          p.name === leftSourceName && p.file === file
        );
        if (leftParam) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: returnValueId,
            dst: leftParam.id
          });
        }
      }
    }
    if (rightSourceName) {
      const rightVar = variableDeclarations.find(v =>
        v.name === rightSourceName && v.file === file
      );
      if (rightVar) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: rightVar.id
        });
      } else {
        const rightParam = parameters.find(p =>
          p.name === rightSourceName && p.file === file
        );
        if (rightParam) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: returnValueId,
            dst: rightParam.id
          });
        }
      }
    }
  }

  // ConditionalExpression: derives from consequent and alternate
  if (expressionType === 'ConditionalExpression') {
    if (consequentSourceName) {
      const consequentVar = variableDeclarations.find(v =>
        v.name === consequentSourceName && v.file === file
      );
      if (consequentVar) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: consequentVar.id
        });
      } else {
        const consequentParam = parameters.find(p =>
          p.name === consequentSourceName && p.file === file
        );
        if (consequentParam) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: returnValueId,
            dst: consequentParam.id
          });
        }
      }
    }
    if (alternateSourceName) {
      const alternateVar = variableDeclarations.find(v =>
        v.name === alternateSourceName && v.file === file
      );
      if (alternateVar) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: alternateVar.id
        });
      } else {
        const alternateParam = parameters.find(p =>
          p.name === alternateSourceName && p.file === file
        );
        if (alternateParam) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: returnValueId,
            dst: alternateParam.id
          });
        }
      }
    }
  }

  // UnaryExpression: derives from the argument
  if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
    const argVar = variableDeclarations.find(v =>
      v.name === unaryArgSourceName && v.file === file
    );
    if (argVar) {
      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: returnValueId,
        dst: argVar.id
      });
    } else {
      const argParam = parameters.find(p =>
        p.name === unaryArgSourceName && p.file === file
      );
      if (argParam) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: argParam.id
        });
      }
    }
  }

  // TemplateLiteral: derives from all embedded expressions
  if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
    for (const sourceName of expressionSourceNames) {
      const sourceVar = variableDeclarations.find(v =>
        v.name === sourceName && v.file === file
      );
      if (sourceVar) {
        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: returnValueId,
          dst: sourceVar.id
        });
      } else {
        const sourceParam = parameters.find(p =>
          p.name === sourceName && p.file === file
        );
        if (sourceParam) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: returnValueId,
            dst: sourceParam.id
          });
        }
      }
    }
  }

  break;
}
```

---

## Part 4: Test Updates

**File:** `test/unit/ReturnStatementEdges.test.js`

### Tests to Update (change from "documented gap" to expect edges)

1. **Line 494** - `should NOT create RETURNS edge for arrow function with expression body (documented gap)`
   - Change to: `should create RETURNS edge for arrow function with BinaryExpression body`
   - Assert: RETURNS edge exists, source is EXPRESSION node with type BinaryExpression
   - Assert: DERIVES_FROM edge from EXPRESSION to parameter `x`

2. **Line 318** - `should NOT create RETURNS edge for chained method call (documented gap)`
   - Keep as documented gap (chained calls are out of scope)

### New Test Cases to Add

```javascript
describe('Return expressions (REG-276)', () => {
  it('should create RETURNS edge for BinaryExpression return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function add(a, b) {
  return a + b;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'add' && n.type === 'FUNCTION');
    assert.ok(func, 'Function "add" should exist');

    // RETURNS edge should exist
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    // Source should be an EXPRESSION node
    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.ok(source, 'Source node should exist');
    assert.strictEqual(source.type, 'EXPRESSION', `Expected EXPRESSION, got ${source.type}`);
    assert.strictEqual(source.expressionType, 'BinaryExpression', 'Should be BinaryExpression');

    // DERIVES_FROM edges to parameters a and b
    const derivesFromEdges = allEdges.filter(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    assert.strictEqual(derivesFromEdges.length, 2, 'Should have 2 DERIVES_FROM edges');

    const paramA = allNodes.find(n => n.name === 'a' && n.type === 'PARAMETER');
    const paramB = allNodes.find(n => n.name === 'b' && n.type === 'PARAMETER');
    assert.ok(paramA && paramB, 'Parameters a and b should exist');

    const targetIds = derivesFromEdges.map(e => e.dst);
    assert.ok(targetIds.includes(paramA.id), 'Should derive from parameter a');
    assert.ok(targetIds.includes(paramB.id), 'Should derive from parameter b');
  });

  it('should create RETURNS edge for ConditionalExpression return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function pick(condition, x, y) {
  return condition ? x : y;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'pick' && n.type === 'FUNCTION');
    assert.ok(func, 'Function "pick" should exist');

    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.type, 'EXPRESSION');
    assert.strictEqual(source.expressionType, 'ConditionalExpression');

    // Should derive from x and y (consequent and alternate)
    const derivesFromEdges = allEdges.filter(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    assert.strictEqual(derivesFromEdges.length, 2, 'Should derive from x and y');
  });

  it('should create RETURNS edge for MemberExpression return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function getProp(obj) {
  return obj.name;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'getProp' && n.type === 'FUNCTION');
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.type, 'EXPRESSION');
    assert.strictEqual(source.expressionType, 'MemberExpression');

    // Should derive from obj parameter
    const derivesFromEdge = allEdges.find(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    assert.ok(derivesFromEdge, 'Should have DERIVES_FROM edge');

    const objParam = allNodes.find(n => n.name === 'obj' && n.type === 'PARAMETER');
    assert.strictEqual(derivesFromEdge.dst, objParam.id, 'Should derive from obj');
  });

  it('should create RETURNS edge for LogicalExpression return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function getDefault(value, fallback) {
  return value || fallback;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'getDefault' && n.type === 'FUNCTION');
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.expressionType, 'LogicalExpression');
  });

  it('should create RETURNS edge for UnaryExpression return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function negate(flag) {
  return !flag;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'negate' && n.type === 'FUNCTION');
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.expressionType, 'UnaryExpression');

    // Should derive from flag parameter
    const derivesFromEdge = allEdges.find(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    const flagParam = allNodes.find(n => n.name === 'flag' && n.type === 'PARAMETER');
    assert.strictEqual(derivesFromEdge.dst, flagParam.id);
  });

  it('should create RETURNS edge for arrow function implicit BinaryExpression', async () => {
    const projectPath = await setupTest({
      'index.js': `
const double = x => x * 2;
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'double' && n.type === 'FUNCTION');
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist for implicit expression return');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.type, 'EXPRESSION');
    assert.strictEqual(source.expressionType, 'BinaryExpression');

    // Should derive from x parameter
    const derivesFromEdge = allEdges.find(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    const xParam = allNodes.find(n => n.name === 'x' && n.type === 'PARAMETER');
    assert.strictEqual(derivesFromEdge.dst, xParam.id);
  });

  it('should create RETURNS edge for TemplateLiteral return', async () => {
    const projectPath = await setupTest({
      'index.js': `
function greet(name, title) {
  return \`Hello, \${title} \${name}!\`;
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'greet' && n.type === 'FUNCTION');
    const returnsEdge = allEdges.find(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.ok(returnsEdge, 'RETURNS edge should exist');

    const source = allNodes.find(n => n.id === returnsEdge.src);
    assert.strictEqual(source.expressionType, 'TemplateLiteral');

    // Should derive from both title and name
    const derivesFromEdges = allEdges.filter(e =>
      e.type === 'DERIVES_FROM' && e.src === source.id
    );
    assert.strictEqual(derivesFromEdges.length, 2);
  });

  it('should handle mixed expression types in return paths', async () => {
    const projectPath = await setupTest({
      'index.js': `
function mixedReturns(a, b, flag) {
  if (flag) {
    return a + b;  // BinaryExpression
  }
  return a;  // Simple variable
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const func = allNodes.find(n => n.name === 'mixedReturns' && n.type === 'FUNCTION');
    const returnsEdges = allEdges.filter(e =>
      e.type === 'RETURNS' && e.dst === func.id
    );
    assert.strictEqual(returnsEdges.length, 2, 'Should have 2 RETURNS edges');

    // One from EXPRESSION, one from PARAMETER
    const sources = returnsEdges.map(e => allNodes.find(n => n.id === e.src));
    const types = sources.map(s => s.type);
    assert.ok(types.includes('EXPRESSION'), 'Should have EXPRESSION source');
    assert.ok(types.includes('PARAMETER'), 'Should have PARAMETER source');
  });
});
```

---

## Implementation Order

1. **Types first** - Add new fields to ReturnStatementInfo
2. **Build system** - Ensure types compile (`npm run build`)
3. **Tests first (TDD)** - Add new test cases, verify they fail
4. **JSASTAnalyzer** - Update ReturnStatement handler
5. **GraphBuilder** - Implement EXPRESSION case in bufferReturnEdges
6. **Run tests** - Verify all pass
7. **Update existing tests** - Change "documented gap" tests to expect edges

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add ~10 new optional fields to ReturnStatementInfo |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Expand expression handling in ReturnStatement visitor (~80 lines), plus 2 implicit return locations |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Replace ~5-line skip with ~120-line implementation |
| `test/unit/ReturnStatementEdges.test.js` | Add ~200 lines of new tests, update 1 existing test |

---

## Risk Mitigation

1. **ID collision** - Using `NodeFactory.generateExpressionId()` ensures consistent ID format
2. **Missing imports** - Verify `NodeFactory` is imported in JSASTAnalyzer
3. **Type safety** - All new fields are optional, maintaining backward compatibility
4. **Performance** - No additional AST traversal; extraction happens during existing visit

---

## Acceptance Criteria

1. `return a + b` creates RETURNS edge from EXPRESSION to FUNCTION
2. EXPRESSION has DERIVES_FROM edges to source variables/parameters
3. All expression types listed in Don's plan are supported
4. Existing tests continue to pass
5. No regressions in other return statement handling
