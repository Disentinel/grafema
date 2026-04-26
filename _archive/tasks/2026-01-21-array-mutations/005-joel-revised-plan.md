# Joel Spolsky - Revised Technical Plan (v2)

## Changes from v1

This revision addresses the three blocking issues identified by Linus:

1. **Type duplication FIXED** - `ArrayMutationInfo` defined ONLY in `types.ts`, imported everywhere
2. **NodeCreationValidator traversal FIXED** - Correct logic for tracing INCOMING `FLOWS_INTO` edges
3. **Tests FIXED** - Complete, compilable, failing tests written before implementation

---

## Step 1: Write Tests (Kent Beck)

### Test File: `test/unit/ArrayMutationTracking.test.js`

Following existing test patterns from `ParameterDataFlow.test.js` and `DataFlowTracking.test.js`.

```javascript
/**
 * Tests for Array Mutation Tracking (FLOWS_INTO edges)
 *
 * When code does arr.push(obj), arr.unshift(obj), arr.splice(i,0,obj),
 * or arr[i] = obj, we need to create a FLOWS_INTO edge from the value
 * to the array. This allows tracing what data flows into arrays.
 *
 * Edge direction: value FLOWS_INTO array (src=value, dst=array)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-array-mutation-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-array-mutation-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Array Mutation Tracking', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('arr.push(obj)', () => {
    it('should create FLOWS_INTO edge from pushed variable to array', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = { name: 'test' };
arr.push(obj);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the array variable 'arr'
      const arrVar = allNodes.find(n =>
        n.name === 'arr' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(arrVar, 'Variable "arr" not found');

      // Find the object variable 'obj'
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      // Find FLOWS_INTO edge from obj to arr
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === objVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "obj" (${objVar.id}) to "arr" (${arrVar.id}). ` +
        `Found edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // Verify metadata
      assert.strictEqual(flowsInto.metadata?.mutationMethod, 'push');
      assert.strictEqual(flowsInto.metadata?.argIndex, 0);
    });

    it('should create multiple FLOWS_INTO edges for multiple arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const a = 1;
const b = 2;
const c = 3;
arr.push(a, b, c);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === arrVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      // Check argIndex values
      const argIndices = flowsIntoEdges.map(e => e.metadata?.argIndex).sort();
      assert.deepStrictEqual(argIndices, [0, 1, 2], 'Should have argIndex 0, 1, 2');
    });

    it('should handle spread: arr.push(...items) with isSpread metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const items = [1, 2, 3];
arr.push(...items);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      const itemsVar = allNodes.find(n => n.name === 'items');
      assert.ok(itemsVar, 'Variable "items" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === itemsVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "items" to "arr"');
      assert.strictEqual(flowsInto.metadata?.isSpread, true, 'Should have isSpread: true');
    });
  });

  describe('arr.unshift(obj)', () => {
    it('should create FLOWS_INTO edge from unshifted object to array', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const first = { id: 0 };
arr.unshift(first);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const firstVar = allNodes.find(n => n.name === 'first');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(firstVar, 'Variable "first" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === firstVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "first" to "arr"');
      assert.strictEqual(flowsInto.metadata?.mutationMethod, 'unshift');
    });
  });

  describe('arr.splice(i, 0, obj)', () => {
    it('should create FLOWS_INTO edge for inserted elements only', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const newItem = { inserted: true };
arr.splice(1, 0, newItem);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const newItemVar = allNodes.find(n => n.name === 'newItem');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(newItemVar, 'Variable "newItem" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === newItemVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "newItem" to "arr"');
      assert.strictEqual(flowsInto.metadata?.mutationMethod, 'splice');
      // argIndex should be 0 (first insertion argument, not counting start/deleteCount)
      assert.strictEqual(flowsInto.metadata?.argIndex, 0);
    });

    it('should NOT create FLOWS_INTO for splice start and deleteCount arguments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const start = 1;
const deleteCount = 0;
const newItem = 'x';
arr.splice(start, deleteCount, newItem);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const startVar = allNodes.find(n => n.name === 'start');
      const deleteCountVar = allNodes.find(n => n.name === 'deleteCount');

      // start and deleteCount should NOT have FLOWS_INTO edges to arr
      const startFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === startVar?.id && e.dst === arrVar?.id
      );
      const deleteCountFlows = allEdges.find(e =>
        e.type === 'FLOWS_INTO' && e.src === deleteCountVar?.id && e.dst === arrVar?.id
      );

      assert.ok(!startFlows, 'start should NOT flow into arr');
      assert.ok(!deleteCountFlows, 'deleteCount should NOT flow into arr');
    });
  });

  describe('arr[i] = obj (indexed assignment)', () => {
    it('should create FLOWS_INTO edge from assigned object to array', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = { value: 42 };
arr[0] = obj;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const objVar = allNodes.find(n => n.name === 'obj');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(objVar, 'Variable "obj" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === objVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "obj" to "arr"');
      assert.strictEqual(flowsInto.metadata?.mutationMethod, 'indexed');
    });

    it('should handle computed index: arr[index] = obj', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [];
const index = 5;
const value = 'test';
arr[index] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      const valueVar = allNodes.find(n => n.name === 'value');

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === arrVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge even with computed index');
    });
  });

  describe('Edge direction verification', () => {
    it('should create edge with correct direction: source -> array (src=value, dst=array)', async () => {
      await setupTest(backend, {
        'index.js': `
const container = [];
const item = 'data';
container.push(item);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container');
      const itemVar = allNodes.find(n => n.name === 'item');

      const flowsInto = allEdges.find(e => e.type === 'FLOWS_INTO');

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge');
      assert.strictEqual(flowsInto.src, itemVar.id, 'Edge src should be the item (value)');
      assert.strictEqual(flowsInto.dst, containerVar.id, 'Edge dst should be the container (array)');
    });
  });

  describe('Integration with NodeCreationValidator', () => {
    it('should allow tracing objects through arrays to addNodes', async () => {
      // This test verifies that NodeCreationValidator can trace:
      // addNodes(arr) <- arr <- FLOWS_INTO <- obj
      await setupTest(backend, {
        'index.js': `
const nodes = [];
const moduleNode = { id: 'test', type: 'MODULE', name: 'test', file: '/test.js' };
nodes.push(moduleNode);
// Later: graph.addNodes(nodes);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const nodesVar = allNodes.find(n => n.name === 'nodes');
      const moduleNodeVar = allNodes.find(n => n.name === 'moduleNode');

      assert.ok(nodesVar, 'Variable "nodes" not found');
      assert.ok(moduleNodeVar, 'Variable "moduleNode" not found');

      // Verify FLOWS_INTO edge exists
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === moduleNodeVar.id &&
        e.dst === nodesVar.id
      );

      assert.ok(
        flowsInto,
        'FLOWS_INTO edge needed for NodeCreationValidator to trace objects through arrays'
      );
    });
  });
});
```

### Test Fixture: `test/fixtures/array-mutation/package.json`

```json
{
  "name": "array-mutation-fixture",
  "type": "module"
}
```

### Test Fixture: `test/fixtures/array-mutation/index.js`

```javascript
// Basic array mutations for integration testing
const items = [];
const first = { id: 1 };
const second = { id: 2 };

items.push(first);
items.unshift(second);
items[2] = { id: 3 };

export { items };
```

---

## Step 2: Add FLOWS_INTO Edge Type

### File: `packages/types/src/edges.ts`

### Changes:

Add `FLOWS_INTO` to the `EDGE_TYPE` constant in the "Variables/Data flow" section:

```typescript
// Variables/Data flow
DEFINES: 'DEFINES',
USES: 'USES',
DECLARES: 'DECLARES',
MODIFIES: 'MODIFIES',
CAPTURES: 'CAPTURES',
ASSIGNED_FROM: 'ASSIGNED_FROM',
READS_FROM: 'READS_FROM',
WRITES_TO: 'WRITES_TO',
DERIVES_FROM: 'DERIVES_FROM',
FLOWS_INTO: 'FLOWS_INTO',  // ADD THIS LINE
```

Add a new interface after `DataFlowEdge`:

```typescript
/**
 * Edge representing data flowing INTO a container (array, collection)
 * Source: the value being added
 * Destination: the container receiving the value
 *
 * Example: arr.push(obj) creates edge obj --FLOWS_INTO--> arr
 */
export interface FlowsIntoEdge extends EdgeRecord {
  type: 'FLOWS_INTO';
  metadata?: {
    mutationMethod?: 'push' | 'unshift' | 'splice' | 'indexed';
    argIndex?: number;
    isSpread?: boolean;
    line?: number;
    column?: number;
  };
}
```

Update the `DataFlowEdge` type union:

```typescript
export interface DataFlowEdge extends EdgeRecord {
  type: 'ASSIGNED_FROM' | 'READS_FROM' | 'WRITES_TO' | 'PASSES_ARGUMENT' | 'DERIVES_FROM' | 'FLOWS_INTO';
  dataType?: string;
}
```

---

## Step 3: Add ArrayMutationInfo Type (SINGLE LOCATION)

### File: `packages/core/src/plugins/analysis/ast/types.ts`

**CRITICAL: This is the ONLY place where ArrayMutationInfo is defined.**

### Changes:

Add after `ArrayElementInfo` (around line 343):

```typescript
// === ARRAY MUTATION INFO ===
/**
 * Tracks array mutation calls (push, unshift, splice) and indexed assignments
 * Used to create FLOWS_INTO edges in GraphBuilder
 *
 * IMPORTANT: This type is defined ONLY here. Import from this file everywhere.
 */
export interface ArrayMutationInfo {
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  arguments: ArrayMutationArgument[];  // What's being added to the array
}

export interface ArrayMutationArgument {
  argIndex: number;
  isSpread?: boolean;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;          // For VARIABLE type - name of the variable
  valueNodeId?: string;        // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - node ID
  literalValue?: unknown;      // For LITERAL type
  callLine?: number;           // For CALL type
  callColumn?: number;
}
```

Add to `ASTCollections` interface:

```typescript
// Array mutation tracking for FLOWS_INTO edges
arrayMutations?: ArrayMutationInfo[];
```

---

## Step 4: Detect Array Mutations in CallExpressionVisitor

### File: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

### Changes:

#### 4.1 Import ArrayMutationInfo from types.ts (NOT defined locally)

At the top of the file, add to imports:

```typescript
import type {
  // ... existing imports ...
  ArrayMutationInfo,
  ArrayMutationArgument,
} from '../types.js';
```

**DO NOT define ArrayMutationInfo locally. Import it.**

#### 4.2 Add array mutation detection in getHandlers()

In the `getHandlers()` method, after the existing method call handling, add array mutation detection:

```typescript
// Check for array mutation methods
const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
if (ARRAY_MUTATION_METHODS.includes(methodName)) {
  this.detectArrayMutation(
    callNode,
    objectName,
    methodName as 'push' | 'unshift' | 'splice',
    module
  );
}
```

#### 4.3 Add detectArrayMutation method

Add new method:

```typescript
/**
 * Detect array mutation calls (push, unshift, splice) and collect mutation info
 * for later FLOWS_INTO edge creation in GraphBuilder
 */
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule
): void {
  // Initialize collection if not exists
  if (!this.collections.arrayMutations) {
    this.collections.arrayMutations = [];
  }
  const arrayMutations = this.collections.arrayMutations;

  const mutationArgs: ArrayMutationArgument[] = [];

  // For splice, only arguments from index 2 onwards are insertions
  // splice(start, deleteCount, item1, item2, ...)
  callNode.arguments.forEach((arg, index) => {
    // Skip start and deleteCount for splice
    if (method === 'splice' && index < 2) return;

    const argInfo: ArrayMutationArgument = {
      argIndex: method === 'splice' ? index - 2 : index,
      isSpread: arg.type === 'SpreadElement',
      valueType: 'EXPRESSION'  // Default
    };

    let actualArg = arg;
    if (arg.type === 'SpreadElement') {
      actualArg = arg.argument;
    }

    // Determine value type
    const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
    if (literalValue !== null) {
      argInfo.valueType = 'LITERAL';
      argInfo.literalValue = literalValue;
    } else if (actualArg.type === 'Identifier') {
      argInfo.valueType = 'VARIABLE';
      argInfo.valueName = actualArg.name;
    } else if (actualArg.type === 'ObjectExpression') {
      argInfo.valueType = 'OBJECT_LITERAL';
    } else if (actualArg.type === 'ArrayExpression') {
      argInfo.valueType = 'ARRAY_LITERAL';
    } else if (actualArg.type === 'CallExpression') {
      argInfo.valueType = 'CALL';
      argInfo.callLine = actualArg.loc?.start.line;
      argInfo.callColumn = actualArg.loc?.start.column;
    }

    mutationArgs.push(argInfo);
  });

  // Only record if there are actual insertions
  if (mutationArgs.length > 0) {
    arrayMutations.push({
      arrayName,
      mutationMethod: method,
      file: module.file,
      line: callNode.loc!.start.line,
      column: callNode.loc!.start.column,
      arguments: mutationArgs
    });
  }
}
```

---

## Step 5: Handle Indexed Assignment in JSASTAnalyzer

### File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### Changes:

#### 5.1 Import types

Add to the imports from types.js:

```typescript
import type {
  // ... existing imports ...
  ArrayMutationInfo,
  ArrayMutationArgument,
} from './ast/types.js';
```

#### 5.2 Add indexed assignment detection

In the function body traversal (inside `analyzeFunctionBody`), add an `AssignmentExpression` handler to detect `arr[i] = value`:

```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Get array name (only simple identifiers for now)
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      // Initialize collection if not exists
      if (!collections.arrayMutations) {
        collections.arrayMutations = [];
      }
      const arrayMutations = collections.arrayMutations;

      const argInfo: ArrayMutationArgument = {
        argIndex: 0,
        isSpread: false,
        valueType: 'EXPRESSION'
      };

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(value);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (value.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = value.name;
      } else if (value.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (value.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (value.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = value.loc?.start.line;
        argInfo.callColumn = value.loc?.start.column;
      }

      arrayMutations.push({
        arrayName,
        mutationMethod: 'indexed',
        file: module.file,
        line: assignNode.loc!.start.line,
        column: assignNode.loc!.start.column,
        arguments: [argInfo]
      });
    }
  }
}
```

#### 5.3 Pass arrayMutations to GraphBuilder

Add `arrayMutations` to the object passed to `this.graphBuilder.build()`.

---

## Step 6: Create FLOWS_INTO Edges in GraphBuilder

### File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Changes:

#### 6.1 Import ArrayMutationInfo

```typescript
import type {
  // ... existing imports ...
  ArrayMutationInfo,
} from './types.js';
```

#### 6.2 Add arrayMutations to build() destructuring

```typescript
const {
  // ... existing fields ...
  arrayMutations = [],
} = data;
```

#### 6.3 Add bufferArrayMutationEdges call (before flush)

```typescript
// Buffer FLOWS_INTO edges for array mutations
this.bufferArrayMutationEdges(arrayMutations, variableDeclarations);
```

#### 6.4 Add bufferArrayMutationEdges method

```typescript
/**
 * Buffer FLOWS_INTO edges for array mutations (push, unshift, splice, indexed assignment)
 *
 * Edge direction: source value -> array (value FLOWS_INTO array)
 * This allows tracing what data enters an array.
 */
private bufferArrayMutationEdges(
  arrayMutations: ArrayMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  for (const mutation of arrayMutations) {
    const { arrayName, mutationMethod, file, line, column, arguments: mutationArgs } = mutation;

    // Find the array variable node
    // NOTE: This is file-scoped, not scope-aware. Known limitation for MVP.
    const arrayVar = variableDeclarations.find(v =>
      v.name === arrayName && v.file === file
    );

    if (!arrayVar) {
      // Array variable not found - might be external or dynamically created
      continue;
    }

    // Create FLOWS_INTO edge for each argument
    for (const arg of mutationArgs) {
      let sourceNodeId: string | null = null;

      // Resolve source node based on value type
      if (arg.valueType === 'VARIABLE' && arg.valueName) {
        // Find variable declaration in same file
        const sourceVar = variableDeclarations.find(v =>
          v.name === arg.valueName && v.file === file
        );
        if (sourceVar) {
          sourceNodeId = sourceVar.id;
        }
      } else if (arg.valueNodeId) {
        // Direct node reference (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL)
        sourceNodeId = arg.valueNodeId;
      }
      // Note: CALL and EXPRESSION types are not yet fully supported.
      // For MVP, we focus on VARIABLE which covers the main use case.

      if (sourceNodeId) {
        this._bufferEdge({
          type: 'FLOWS_INTO',
          src: sourceNodeId,
          dst: arrayVar.id,
          metadata: {
            mutationMethod,
            argIndex: arg.argIndex,
            ...(arg.isSpread && { isSpread: true }),
            line,
            column
          }
        });
      }
    }
  }
}
```

---

## Step 7: Update NodeCreationValidator (FIXED TRAVERSAL LOGIC)

### File: `packages/core/src/plugins/validation/NodeCreationValidator.ts`

### Problem Analysis

The NodeCreationValidator needs to trace object origins to verify they come from NodeFactory. Currently it traces `ASSIGNED_FROM` edges. With `FLOWS_INTO`, we need to also check what flows INTO an array variable.

**Edge directions:**
- `ASSIGNED_FROM`: `variable --ASSIGNED_FROM--> source` (variable points to its source)
- `FLOWS_INTO`: `value --FLOWS_INTO--> array` (value points to array it enters)

**To trace what's in an array:**
We need INCOMING `FLOWS_INTO` edges TO the array variable.
```
arr <- FLOWS_INTO <- obj  (obj was pushed into arr)
```

So we use `edgesByDst.get(arrayId)` and filter for `FLOWS_INTO`.

### Changes:

#### 7.1 Update validateAddNodesCall to check FLOWS_INTO

When the argument to `addNodes()` is a variable, we need to:
1. Trace its source (via `ASSIGNED_FROM`) to see if it's an array
2. Check what flows INTO that array (via `FLOWS_INTO` incoming edges)

Add a new method and update `validateAddNodesCall`:

```typescript
/**
 * Validate addNodes([...]) call
 * Also checks for objects that flow into arrays via FLOWS_INTO edges
 */
private async validateAddNodesCall(
  callNode: CallNode,
  edgesBySrc: Map<string, EdgeRecord[]>,
  edgesByDst: Map<string, EdgeRecord[]>,
  nodesById: Map<string, BaseNodeRecord>
): Promise<NodeCreationIssue[]> {
  const issues: NodeCreationIssue[] = [];

  // Find PASSES_ARGUMENT edge (arg 0 - the array)
  const passedArgs = edgesBySrc.get(callNode.id)?.filter(e =>
    e.type === 'PASSES_ARGUMENT'
  ) || [];

  for (const argEdge of passedArgs) {
    const argNode = nodesById.get(argEdge.dst);
    if (!argNode) continue;

    // ... existing ARRAY_LITERAL handling ...

    // Check if it's a variable containing an array
    if (argNode.type === 'VARIABLE' || argNode.type === 'VARIABLE_DECLARATION') {
      // Check what flows INTO this variable (array mutations)
      const incomingFlows = this.getArrayContents(argNode.id, edgesByDst, nodesById);

      for (const sourceNode of incomingFlows) {
        if (sourceNode.type === 'OBJECT_LITERAL') {
          const isFromFactory = this.isFromNodeFactory(sourceNode.id, edgesByDst, nodesById);
          if (!isFromFactory) {
            issues.push({
              type: 'INLINE_ARRAY_ELEMENT',
              severity: 'ERROR',
              message: `Object pushed into array "${argNode.name}" is not from NodeFactory, passed to addNodes() at ${callNode.file}:${callNode.line}`,
              callSiteId: callNode.id,
              objectId: sourceNode.id,
              file: callNode.file,
              line: callNode.line as number | undefined,
              suggestion: 'Use NodeFactory.createX() to create nodes before pushing to array'
            });
          }
        }

        // Also trace if the pushed value is a variable
        if (sourceNode.type === 'VARIABLE' || sourceNode.type === 'VARIABLE_DECLARATION') {
          const source = this.traceVariableSource(sourceNode.id, edgesBySrc, nodesById);
          if (source && source.type === 'OBJECT_LITERAL') {
            const isFromFactory = this.isFromNodeFactory(source.id, edgesByDst, nodesById);
            if (!isFromFactory) {
              issues.push({
                type: 'INLINE_ARRAY_ELEMENT',
                severity: 'ERROR',
                message: `Variable "${sourceNode.name}" pushed into array "${argNode.name}" is not from NodeFactory, passed to addNodes() at ${callNode.file}:${callNode.line}`,
                callSiteId: callNode.id,
                objectId: source.id,
                file: callNode.file,
                line: callNode.line as number | undefined,
                suggestion: 'Use NodeFactory.createX() to create the node'
              });
            }
          }
        }
      }

      // Also check static array contents (HAS_ELEMENT)
      const source = this.traceVariableSource(argNode.id, edgesBySrc, nodesById);
      if (source && source.type === 'ARRAY_LITERAL') {
        // ... existing HAS_ELEMENT handling ...
      }
    }
  }

  return issues;
}

/**
 * Get all nodes that flow INTO an array variable via FLOWS_INTO edges
 * These are objects/values that were pushed, unshifted, or assigned to the array
 */
private getArrayContents(
  arrayNodeId: string,
  edgesByDst: Map<string, EdgeRecord[]>,
  nodesById: Map<string, BaseNodeRecord>
): BaseNodeRecord[] {
  const contents: BaseNodeRecord[] = [];

  // Find INCOMING FLOWS_INTO edges to this array
  // Edge direction: value --FLOWS_INTO--> array
  // So we look for edges where dst === arrayNodeId
  const incomingFlows = edgesByDst.get(arrayNodeId)?.filter(e =>
    e.type === 'FLOWS_INTO'
  ) || [];

  for (const edge of incomingFlows) {
    const sourceNode = nodesById.get(edge.src);
    if (sourceNode) {
      contents.push(sourceNode);
    }
  }

  return contents;
}
```

#### 7.2 Update isFromNodeFactory to also traverse FLOWS_INTO (for completeness)

If an object flows into an array, and that array is then assigned to another variable, we may need to trace through. However, for the MVP, the key fix is in `getArrayContents`.

The existing `isFromNodeFactory` traces `ASSIGNED_FROM` and that's still correct for its purpose (checking if an object was assigned from a NodeFactory call).

---

## Verification

After implementation, verify with:

1. **Run unit tests:**
   ```bash
   node --test test/unit/ArrayMutationTracking.test.js
   ```

2. **Run full test suite:**
   ```bash
   npm test
   ```

3. **Verify NodeCreationValidator can trace through arrays:**
   ```bash
   # Analyze GraphBuilder itself
   npx grafema analyze packages/core/src/plugins/analysis/ast/GraphBuilder.ts
   # The validator should be able to trace objects through arrays
   ```

---

## Implementation Order

1. Kent Beck: Write tests first (Step 1) - tests must compile and fail
2. Rob Pike: Add edge type (Step 2)
3. Rob Pike: Add types in types.ts ONLY (Step 3)
4. Rob Pike: Implement CallExpressionVisitor detection (Step 4) - import types, don't define
5. Rob Pike: Implement JSASTAnalyzer indexed assignment (Step 5)
6. Rob Pike: Implement GraphBuilder edge creation (Step 6)
7. Rob Pike: Update NodeCreationValidator with correct traversal (Step 7)
8. Run tests and verify

---

## Known Limitations (Documented)

1. **Variable resolution is file-scoped, not scope-aware.** If you have:
   ```javascript
   function foo() {
     const arr = [];  // Inner arr
     arr.push(obj);
   }
   const arr = [];  // Outer arr - might get the edge instead
   ```
   The lookup `variableDeclarations.find(v => v.name === arrayName && v.file === file)` may match the wrong variable. This is acceptable for MVP.

2. **CALL and EXPRESSION value types are not yet fully supported.** When you do `arr.push(someFunction())`, we don't create an edge from the call result. MVP focuses on variables.

3. **Spread handling creates single edge.** `arr.push(...items)` creates one edge from `items` to `arr` with `isSpread: true`. We don't try to resolve what's inside `items`.
