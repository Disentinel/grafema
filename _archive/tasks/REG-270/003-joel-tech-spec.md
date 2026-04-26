# Joel Tech Spec: REG-270 - Track Generator Function Yields

**Date:** 2026-02-05
**Based on:** Don's Plan (002-don-plan.md)
**Status:** READY FOR REVIEW

## Overview

This spec provides step-by-step implementation details for tracking generator function yields and delegations with `YIELDS` and `DELEGATES_TO` edges.

**Key Principle:** Follow the existing RETURNS edge pattern exactly. The implementation is a near-copy of return statement handling with yield-specific semantics.

---

## Phase 1: Type Definitions

### Step 1.1: Add Edge Types to edges.ts

**File:** `packages/types/src/edges.ts`
**Location:** Lines 35-36 (after RETURNS)

```typescript
// Current (line 36):
  RETURNS: 'RETURNS',

// Add after RETURNS (line 37-38):
  YIELDS: 'YIELDS',
  DELEGATES_TO: 'DELEGATES_TO',
```

**Complexity:** O(1) - constant time addition to object literal.

---

### Step 1.2: Add Edge Types to Validation Set

**File:** `packages/core/src/storage/backends/typeValidation.ts`
**Location:** Line 46-49 (KNOWN_EDGE_TYPES set)

```typescript
// Current (lines 46-49):
const KNOWN_EDGE_TYPES = new Set<string>([
  // ... existing types ...
  'RETURNS', 'RECEIVES_ARGUMENT', 'READS_FROM', 'THROWS', 'REGISTERS_VIEW',
  'GOVERNS', 'VIOLATES', 'HAS_PARAMETER', 'DERIVES_FROM',
  'RESOLVES_TO',  // Promise resolve() data flow
]);

// Add YIELDS and DELEGATES_TO to the set:
const KNOWN_EDGE_TYPES = new Set<string>([
  // ... existing types ...
  'RETURNS', 'RECEIVES_ARGUMENT', 'READS_FROM', 'THROWS', 'REGISTERS_VIEW',
  'GOVERNS', 'VIOLATES', 'HAS_PARAMETER', 'DERIVES_FROM',
  'RESOLVES_TO',  // Promise resolve() data flow
  'YIELDS',       // Generator yield data flow (REG-270)
  'DELEGATES_TO', // Generator yield* delegation (REG-270)
]);
```

**Complexity:** O(1) - constant time addition to set.

---

### Step 1.3: Add YieldExpressionInfo Interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** After `ReturnStatementInfo` (around line 655)

```typescript
// === YIELD EXPRESSION INFO (REG-270) ===
/**
 * Tracks yield expressions for YIELDS and DELEGATES_TO edge creation in GraphBuilder.
 * Used to connect yielded expressions to their containing generator functions.
 *
 * Edge direction:
 * - For yield:  yieldedExpression --YIELDS--> generatorFunction
 * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
 *
 * Examples:
 * - `yield 42;` creates: LITERAL(42) --YIELDS--> FUNCTION(gen)
 * - `yield* otherGen();` creates: CALL(otherGen) --DELEGATES_TO--> FUNCTION(gen)
 */
export interface YieldExpressionInfo {
  parentFunctionId: string;          // ID of the containing generator function
  file: string;
  line: number;
  column: number;

  /** true for yield*, false for yield */
  isDelegate: boolean;

  // Yield value type determines how to resolve the source node
  // Uses same types as ReturnStatementInfo for code reuse
  yieldValueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION' | 'NONE';

  // For VARIABLE type
  yieldValueName?: string;

  // For LITERAL type - the literal node ID
  yieldValueId?: string;

  // For CALL_SITE/METHOD_CALL type - coordinates for lookup
  yieldValueLine?: number;
  yieldValueColumn?: number;
  yieldValueCallName?: string;

  // For EXPRESSION type (BinaryExpression, ConditionalExpression, etc.)
  expressionType?: string;

  // For EXPRESSION type - source variable extraction (mirrors ReturnStatementInfo)
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
}
```

**Complexity:** O(1) - type definition only, no runtime cost.

---

### Step 1.4: Add to ASTCollections Interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Location:** In `ASTCollections` interface (around line 925)

```typescript
// Current (lines 924-926):
  // Promise resolution tracking for RESOLVES_TO edges (REG-334)
  promiseResolutions?: PromiseResolutionInfo[];
  // Promise executor contexts (REG-334) - keyed by executor function's start:end position
  promiseExecutorContexts?: Map<string, PromiseExecutorContext>;

// Add after promiseExecutorContexts:
  // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
  yieldExpressions?: YieldExpressionInfo[];
```

---

## Phase 2: Collection (JSASTAnalyzer)

### Step 2.1: Initialize yieldExpressions Array

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Around line 1458 (after promiseExecutorContexts)

```typescript
// Current (lines 1457-1460):
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)
      const promiseResolutions: PromiseResolutionInfo[] = [];
      // Promise executor contexts (REG-334) - keyed by executor function's start:end position
      const promiseExecutorContexts = new Map<string, PromiseExecutorContext>();

// Add after:
      // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
      const yieldExpressions: YieldExpressionInfo[] = [];
```

---

### Step 2.2: Add yieldExpressions to allCollections

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Around line 1534 (in allCollections object)

```typescript
// Current (lines 1533-1536):
        // Promise resolution tracking (REG-334)
        promiseResolutions,
        promiseExecutorContexts,
        objectLiteralCounterRef, arrayLiteralCounterRef,

// Add yieldExpressions:
        // Promise resolution tracking (REG-334)
        promiseResolutions,
        promiseExecutorContexts,
        // Yield expression tracking (REG-270)
        yieldExpressions,
        objectLiteralCounterRef, arrayLiteralCounterRef,
```

---

### Step 2.3: Add YieldExpression Import

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Around line 99 (imports from types.ts)

```typescript
// Current (line 99):
  ReturnStatementInfo,

// Add after:
  ReturnStatementInfo,
  YieldExpressionInfo,
```

---

### Step 2.4: Add YieldExpression Visitor

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** In `analyzeFunctionBody()` visitor handlers, around line 3801 (after ReturnStatement handler)

The YieldExpression visitor follows the exact same pattern as ReturnStatement:

```typescript
      // Handle yield expressions for YIELDS/DELEGATES_TO edges (REG-270)
      YieldExpression: (yieldPath: NodePath<t.YieldExpression>) => {
        // Skip if we couldn't determine the function ID
        if (!currentFunctionId) {
          return;
        }

        // Skip if this yield is inside a nested function (not the function we're analyzing)
        // Check if there's a function ancestor BETWEEN us and funcNode
        let parent: NodePath | null = yieldPath.parentPath;
        while (parent) {
          // If we've reached funcNode, we're done checking - this yield belongs to funcNode
          if (parent.node === funcNode) {
            break;
          }
          if (t.isFunction(parent.node)) {
            // Found a function between yieldPath and funcNode - this yield is inside a nested function
            return;
          }
          parent = parent.parentPath;
        }

        const yieldNode = yieldPath.node;
        const yieldLine = getLine(yieldNode);
        const yieldColumn = getColumn(yieldNode);
        const isDelegate = yieldNode.delegate ?? false;

        // Handle bare yield; (no value) - only valid for non-delegate yield
        if (!yieldNode.argument && !isDelegate) {
          // Skip - no data flow value
          return;
        }

        // For yield* without argument (syntax error in practice, but handle gracefully)
        if (!yieldNode.argument) {
          return;
        }

        const arg = yieldNode.argument;

        // Extract expression-specific info using shared method
        // Note: We reuse extractReturnExpressionInfo since yield values have identical semantics
        const exprInfo = this.extractReturnExpressionInfo(
          arg, module, literals, literalCounterRef, yieldLine, yieldColumn, 'yield'
        );

        // Map ReturnStatementInfo fields to YieldExpressionInfo fields
        const yieldInfo: YieldExpressionInfo = {
          parentFunctionId: currentFunctionId,
          file: module.file,
          line: yieldLine,
          column: yieldColumn,
          isDelegate,
          yieldValueType: exprInfo.returnValueType ?? 'NONE',
          yieldValueName: exprInfo.returnValueName,
          yieldValueId: exprInfo.returnValueId,
          yieldValueLine: exprInfo.returnValueLine,
          yieldValueColumn: exprInfo.returnValueColumn,
          yieldValueCallName: exprInfo.returnValueCallName,
          expressionType: exprInfo.expressionType,
          operator: exprInfo.operator,
          leftSourceName: exprInfo.leftSourceName,
          rightSourceName: exprInfo.rightSourceName,
          consequentSourceName: exprInfo.consequentSourceName,
          alternateSourceName: exprInfo.alternateSourceName,
          object: exprInfo.object,
          property: exprInfo.property,
          computed: exprInfo.computed,
          objectSourceName: exprInfo.objectSourceName,
          expressionSourceNames: exprInfo.expressionSourceNames,
          unaryArgSourceName: exprInfo.unaryArgSourceName,
        };

        yieldExpressions.push(yieldInfo);
      },
```

**Implementation Notes:**
1. The visitor filters out yields in nested functions (identical to ReturnStatement pattern)
2. We reuse `extractReturnExpressionInfo()` since yield values have the same semantics as return values
3. We add a new `literalIdSuffix` value 'yield' for literal ID generation

---

### Step 2.5: Update extractReturnExpressionInfo Signature

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** Line 2976 (method signature)

```typescript
// Current:
  literalIdSuffix: 'return' | 'implicit_return' = 'return'

// Update to include 'yield':
  literalIdSuffix: 'return' | 'implicit_return' | 'yield' = 'return'
```

---

### Step 2.6: Pass yieldExpressions to analyzeFunctionBody

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** In `analyzeFunctionBody()` method, where collections are destructured

Add `yieldExpressions` to the destructured collections object (follows existing pattern for `returnStatements`):

```typescript
// In the destructuring section (around line 3530):
const yieldExpressions = (collections.yieldExpressions ?? []) as YieldExpressionInfo[];
```

---

## Phase 3: Edge Buffering (GraphBuilder)

### Step 3.1: Add yieldExpressions to GraphBuilder.build()

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location:** Around line 156 (in destructuring)

```typescript
// Current (lines 154-156):
      // Return statement tracking for RETURNS edges
      returnStatements = [],
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)

// Add yieldExpressions:
      // Return statement tracking for RETURNS edges
      returnStatements = [],
      // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
      yieldExpressions = [],
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)
```

---

### Step 3.2: Add bufferYieldEdges() Call

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location:** Around line 373 (after bufferPromiseResolutionEdges)

```typescript
// Current (lines 372-373):
    // 31. Buffer RESOLVES_TO edges for Promise data flow (REG-334)
    this.bufferPromiseResolutionEdges(promiseResolutions);

// Add after:
    // 32. Buffer YIELDS/DELEGATES_TO edges for generator yields (REG-270)
    this.bufferYieldEdges(yieldExpressions, callSites, methodCalls, variableDeclarations, parameters);
```

---

### Step 3.3: Implement bufferYieldEdges() Method

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location:** After `bufferReturnEdges()` method (around line 2598)

```typescript
  /**
   * Buffer YIELDS and DELEGATES_TO edges connecting yield expressions to their generator functions.
   *
   * Edge direction:
   * - For yield:  yieldedExpression --YIELDS--> generatorFunction
   * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
   *
   * This enables tracing data flow through generator functions:
   * - Query: "What does this generator yield?"
   * - Answer: Follow YIELDS edges from function to see all possible yielded values
   * - Query: "What generators does this delegate to?"
   * - Answer: Follow DELEGATES_TO edges from function
   *
   * REG-270: Generator yield tracking
   */
  private bufferYieldEdges(
    yieldExpressions: YieldExpressionInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const yld of yieldExpressions) {
      const { parentFunctionId, yieldValueType, file, isDelegate } = yld;

      // Skip if no value yielded (bare yield;)
      if (yieldValueType === 'NONE') {
        continue;
      }

      let sourceNodeId: string | null = null;

      switch (yieldValueType) {
        case 'LITERAL':
          // Direct reference to literal node
          sourceNodeId = yld.yieldValueId ?? null;
          break;

        case 'VARIABLE': {
          // Find variable declaration by name in same file
          const varName = yld.yieldValueName;
          if (varName) {
            const sourceVar = variableDeclarations.find(v =>
              v.name === varName && v.file === file
            );
            if (sourceVar) {
              sourceNodeId = sourceVar.id;
            } else {
              // Check parameters
              const sourceParam = parameters.find(p =>
                p.name === varName && p.file === file
              );
              if (sourceParam) {
                sourceNodeId = sourceParam.id;
              }
            }
          }
          break;
        }

        case 'CALL_SITE': {
          // Find call site by coordinates
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const callSite = callSites.find(cs =>
              cs.line === yieldValueLine &&
              cs.column === yieldValueColumn &&
              (yieldValueCallName ? cs.name === yieldValueCallName : true)
            );
            if (callSite) {
              sourceNodeId = callSite.id;
            }
          }
          break;
        }

        case 'METHOD_CALL': {
          // Find method call by coordinates and method name
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const methodCall = methodCalls.find(mc =>
              mc.line === yieldValueLine &&
              mc.column === yieldValueColumn &&
              mc.file === file &&
              (yieldValueCallName ? mc.method === yieldValueCallName : true)
            );
            if (methodCall) {
              sourceNodeId = methodCall.id;
            }
          }
          break;
        }

        case 'EXPRESSION': {
          // Create EXPRESSION node and DERIVES_FROM edges for yield expressions
          const {
            expressionType,
            yieldValueId,
            yieldValueLine,
            yieldValueColumn,
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
          } = yld;

          // Skip if no expression ID was generated
          if (!yieldValueId) {
            break;
          }

          // Create EXPRESSION node using NodeFactory
          const expressionNode = NodeFactory.createExpressionFromMetadata(
            expressionType || 'Unknown',
            file,
            yieldValueLine || yld.line,
            yieldValueColumn || yld.column,
            {
              id: yieldValueId,
              object,
              property,
              computed,
              operator
            }
          );

          this._bufferNode(expressionNode);
          sourceNodeId = yieldValueId;

          // Buffer DERIVES_FROM edges based on expression type
          // Helper function to find source variable or parameter
          const findSource = (name: string): string | null => {
            const variable = variableDeclarations.find(v =>
              v.name === name && v.file === file
            );
            if (variable) return variable.id;

            const param = parameters.find(p =>
              p.name === name && p.file === file
            );
            if (param) return param.id;

            return null;
          };

          // MemberExpression: derives from the object
          if (expressionType === 'MemberExpression' && objectSourceName) {
            const srcId = findSource(objectSourceName);
            if (srcId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // BinaryExpression / LogicalExpression: derives from left and right operands
          if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
            if (leftSourceName) {
              const srcId = findSource(leftSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (rightSourceName) {
              const srcId = findSource(rightSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // ConditionalExpression: derives from consequent and alternate
          if (expressionType === 'ConditionalExpression') {
            if (consequentSourceName) {
              const srcId = findSource(consequentSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (alternateSourceName) {
              const srcId = findSource(alternateSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // UnaryExpression: derives from the argument
          if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
            const srcId = findSource(unaryArgSourceName);
            if (srcId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // TemplateLiteral: derives from all embedded expressions
          if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
            for (const sourceName of expressionSourceNames) {
              const srcId = findSource(sourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          break;
        }
      }

      // Create YIELDS or DELEGATES_TO edge if we found a source node
      if (sourceNodeId && parentFunctionId) {
        const edgeType = isDelegate ? 'DELEGATES_TO' : 'YIELDS';
        this._bufferEdge({
          type: edgeType,
          src: sourceNodeId,
          dst: parentFunctionId
        });
      }
    }
  }
```

**Complexity Analysis:**
- Loop: O(Y) where Y = number of yield expressions in the file
- Variable lookup: O(V) where V = number of variables/parameters in file
- Total: O(Y * V) per file - same as RETURNS edges

This is acceptable because:
1. Y is typically small (generators rarely have dozens of yields)
2. V is bounded by file size
3. No full-graph iteration - only same-file lookups

---

### Step 3.4: Add YieldExpressionInfo Import to GraphBuilder

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Location:** At imports section (around line 25)

```typescript
// Add to existing imports from './types.js':
import type {
  // ... existing imports ...
  YieldExpressionInfo,
} from './types.js';
```

---

## Phase 4: Tests

### Step 4.1: Create Test File

**File:** `test/unit/YieldExpressionEdges.test.js`

```javascript
/**
 * Yield Expression Edges Tests (REG-270)
 *
 * Tests for YIELDS and DELEGATES_TO edge creation from yield expressions to containing generator functions.
 *
 * Edge direction:
 * - For yield:  yieldedExpression --YIELDS--> generatorFunction
 * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
 *
 * Test cases:
 * 1. Basic yield with literal: `yield 42;` - LITERAL --YIELDS--> FUNCTION
 * 2. Yield with variable: `yield result;` - VARIABLE --YIELDS--> FUNCTION
 * 3. Yield with function call: `yield foo();` - CALL --YIELDS--> FUNCTION
 * 4. Yield with method call: `yield obj.method();` - CALL --YIELDS--> FUNCTION
 * 5. Multiple yields: All create edges
 * 6. yield* with function call: `yield* other();` - CALL --DELEGATES_TO--> FUNCTION
 * 7. yield* with variable: `yield* gen;` - VARIABLE --DELEGATES_TO--> FUNCTION
 * 8. Async generator: `async function* gen() { yield 1; }`
 * 9. Bare yield: `yield;` - NO edge created
 * 10. Yield parameter: `yield x;` where x is parameter - PARAMETER --YIELDS--> FUNCTION
 * 11. Nested function: yields inside callbacks don't create edges for outer function
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('YIELDS/DELEGATES_TO Edges (REG-270)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-yields-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-yields-${testCounter}`, type: 'module' })
    );

    // Write test files
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    return testDir;
  }

  /**
   * Clean up test directory
   */
  function cleanupTestDir() {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      testDir = null;
    }
  }

  beforeEach(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
  });

  describe('Basic yield with literal', () => {
    it('should create YIELDS edge for numeric literal yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* numberGen() {
  yield 42;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the generator function
      const func = allNodes.find(n => n.name === 'numberGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function "numberGen" should exist');
      assert.strictEqual(func.generator, true, 'Function should be marked as generator');

      // Find YIELDS edge pointing to function
      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist for numberGen()');

      // Verify source is a LITERAL
      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
      assert.strictEqual(source.value, 42, 'Literal value should be 42');
    });

    it('should create YIELDS edge for string literal yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* stringGen() {
  yield 'hello';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'stringGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'LITERAL');
      assert.strictEqual(source.value, 'hello');
    });
  });

  describe('Yield with variable', () => {
    it('should create YIELDS edge for variable yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* varGen() {
  const result = 42;
  yield result;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'varGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type), `Expected VARIABLE/CONSTANT, got ${source.type}`);
      assert.strictEqual(source.name, 'result');
    });
  });

  describe('Yield with function call', () => {
    it('should create YIELDS edge for function call yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function getValue() { return 42; }
function* callGen() {
  yield getValue();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'callGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'CALL');
      assert.strictEqual(source.name, 'getValue');
    });
  });

  describe('yield* delegation', () => {
    it('should create DELEGATES_TO edge for yield* with function call', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* innerGen() {
  yield 1;
  yield 2;
}
function* outerGen() {
  yield* innerGen();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      assert.ok(outerFunc, 'Outer generator should exist');

      // Find DELEGATES_TO edge pointing to outerGen
      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.dst === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist for yield*');

      // Verify source is a CALL to innerGen
      const source = allNodes.find(n => n.id === delegatesEdge.src);
      assert.ok(source, 'Source node should exist');
      assert.strictEqual(source.type, 'CALL');
      assert.strictEqual(source.name, 'innerGen');
    });

    it('should create DELEGATES_TO edge for yield* with variable', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* innerGen() { yield 1; }
function* outerGen() {
  const gen = innerGen();
  yield* gen;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      assert.ok(outerFunc, 'Outer generator should exist');

      const delegatesEdge = allEdges.find(e =>
        e.type === 'DELEGATES_TO' && e.dst === outerFunc.id
      );
      assert.ok(delegatesEdge, 'DELEGATES_TO edge should exist');

      const source = allNodes.find(n => n.id === delegatesEdge.src);
      assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type));
      assert.strictEqual(source.name, 'gen');
    });
  });

  describe('Multiple yields', () => {
    it('should create YIELDS edges for all yields in generator', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* multiGen() {
  yield 1;
  yield 2;
  yield 3;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'multiGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator function should exist');

      // Find all YIELDS edges pointing to this function
      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 3, 'Should have 3 YIELDS edges');

      // Verify all sources are literals with values 1, 2, 3
      const values = yieldsEdges.map(e => {
        const src = allNodes.find(n => n.id === e.src);
        return src?.value;
      }).sort();
      assert.deepStrictEqual(values, [1, 2, 3]);
    });
  });

  describe('Async generators', () => {
    it('should create YIELDS edges for async generator', async () => {
      const projectPath = await setupTest({
        'index.js': `
async function* asyncGen() {
  yield 1;
  yield 2;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'asyncGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Async generator should exist');
      assert.strictEqual(func.async, true, 'Should be async');
      assert.strictEqual(func.generator, true, 'Should be generator');

      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 2, 'Should have 2 YIELDS edges');
    });
  });

  describe('Bare yield', () => {
    it('should NOT create edge for bare yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* bareGen() {
  yield;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'bareGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      // Should NOT have any YIELDS edges
      const yieldsEdges = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.strictEqual(yieldsEdges.length, 0, 'Should have no YIELDS edges for bare yield');
    });
  });

  describe('Yield parameter', () => {
    it('should create YIELDS edge for parameter yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* paramGen(x) {
  yield x;
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'paramGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'PARAMETER');
      assert.strictEqual(source.name, 'x');
    });
  });

  describe('Nested functions', () => {
    it('should NOT create YIELDS edge for yield in nested function', async () => {
      const projectPath = await setupTest({
        'index.js': `
function* outerGen() {
  function* innerGen() {
    yield 'inner';
  }
  yield 'outer';
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const outerFunc = allNodes.find(n => n.name === 'outerGen' && n.type === 'FUNCTION');
      const innerFunc = allNodes.find(n => n.name === 'innerGen' && n.type === 'FUNCTION');

      assert.ok(outerFunc, 'Outer generator should exist');
      assert.ok(innerFunc, 'Inner generator should exist');

      // Outer should have YIELDS edge for 'outer'
      const outerYields = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === outerFunc.id
      );
      assert.strictEqual(outerYields.length, 1, 'Outer should have 1 YIELDS edge');

      // Inner should have YIELDS edge for 'inner'
      const innerYields = allEdges.filter(e =>
        e.type === 'YIELDS' && e.dst === innerFunc.id
      );
      assert.strictEqual(innerYields.length, 1, 'Inner should have 1 YIELDS edge');

      // Verify outer yields 'outer' and inner yields 'inner'
      const outerSrc = allNodes.find(n => n.id === outerYields[0].src);
      const innerSrc = allNodes.find(n => n.id === innerYields[0].src);
      assert.strictEqual(outerSrc.value, 'outer');
      assert.strictEqual(innerSrc.value, 'inner');
    });
  });

  describe('yield with method call', () => {
    it('should create YIELDS edge for method call yield', async () => {
      const projectPath = await setupTest({
        'index.js': `
const obj = { getValue: () => 42 };
function* methodGen() {
  yield obj.getValue();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const func = allNodes.find(n => n.name === 'methodGen' && n.type === 'FUNCTION');
      assert.ok(func, 'Generator should exist');

      const yieldsEdge = allEdges.find(e =>
        e.type === 'YIELDS' && e.dst === func.id
      );
      assert.ok(yieldsEdge, 'YIELDS edge should exist');

      const source = allNodes.find(n => n.id === yieldsEdge.src);
      assert.strictEqual(source.type, 'CALL');
    });
  });
});
```

---

## Complexity Summary

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Type definitions | O(1) | Compile-time only |
| YieldExpression visitor | O(Y) | Y = yield expressions per function |
| bufferYieldEdges() | O(Y * V) | V = variables/parameters per file |
| Total per file | O(Y * V) | Same as RETURNS edges |

**Memory:** One `YieldExpressionInfo` object per yield expression - minimal overhead.

**No full-graph iteration.** All lookups are file-scoped using existing collections.

---

## Acceptance Criteria Verification

| Criteria | Implementation | Test |
|----------|----------------|------|
| YIELDS edges for yield | `bufferYieldEdges()` with `isDelegate: false` | "Basic yield with literal", "Yield with variable" |
| DELEGATES_TO edges for yield* | `bufferYieldEdges()` with `isDelegate: true` | "yield* delegation" |
| Generator functions queryable | Follow YIELDS/DELEGATES_TO edges to FUNCTION | All tests query edges |
| Async generators work | Same visitor handles both | "Async generators" |
| Multiple yields tracked | Visitor collects all yields | "Multiple yields" |
| Bare yield creates no edge | Early return for NONE type | "Bare yield" |
| Nested functions isolated | Parent function check | "Nested functions" |

---

## Estimated Effort

| Phase | Task | Time |
|-------|------|------|
| 1 | Type definitions (edges.ts, typeValidation.ts, types.ts) | 20 min |
| 2 | Collection (JSASTAnalyzer - visitor + integration) | 1.5 hours |
| 3 | Edge buffering (GraphBuilder) | 1.5 hours |
| 4 | Tests (comprehensive test file) | 2 hours |
| | **Total** | **5.5 hours** |

---

## Files Changed Summary

1. `packages/types/src/edges.ts` - Add YIELDS, DELEGATES_TO to EDGE_TYPE
2. `packages/core/src/storage/backends/typeValidation.ts` - Add to KNOWN_EDGE_TYPES
3. `packages/core/src/plugins/analysis/ast/types.ts` - Add YieldExpressionInfo, update ASTCollections
4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Add visitor, imports, collection
5. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Add bufferYieldEdges()
6. `test/unit/YieldExpressionEdges.test.js` - Comprehensive test suite

---

*Joel Spolsky, Implementation Planner*
*"Spec first, then implement. Never the other way around."*
