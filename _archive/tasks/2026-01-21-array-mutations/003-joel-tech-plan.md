# Joel Spolsky - Detailed Technical Plan

## Overview

Implementing array mutation tracking for REG-113. This feature adds a new `FLOWS_INTO` edge type to track data flow when values are added to arrays via `arr.push(obj)`, `arr.unshift(obj)`, `arr.splice(i, 0, obj)`, and indexed assignment `arr[i] = obj`.

The implementation follows existing patterns in the codebase and requires changes to:
1. Edge type definitions
2. AST collection types
3. CallExpressionVisitor (for method-based mutations)
4. JSASTAnalyzer (for indexed assignment)
5. GraphBuilder (for edge creation)
6. NodeCreationValidator (to traverse FLOWS_INTO edges)

## Step 1: Write Tests (Kent Beck)

### Test File: `test/unit/ArrayMutationTracking.test.ts`

Create a new test file that validates array mutation tracking. The tests should follow the existing pattern in `test/unit/GuaranteeAPI.test.ts`.

### Test Cases:

```typescript
/**
 * Tests for Array Mutation Tracking (FLOWS_INTO edges)
 *
 * Tests:
 * - arr.push(obj) creates FLOWS_INTO edge
 * - arr.unshift(obj) creates FLOWS_INTO edge
 * - arr.splice(i, 0, obj) creates FLOWS_INTO edge
 * - arr[i] = obj creates FLOWS_INTO edge
 * - Multiple arguments: arr.push(a, b, c) creates 3 edges
 * - Spread: arr.push(...items) creates edge with metadata.isSpread
 * - Variable resolution: edge connects to correct VARIABLE node
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSASTAnalyzer } from '../../packages/core/src/plugins/analysis/JSASTAnalyzer.js';
import { createTestBackend } from '../helpers/TestRFDB.js';

describe('Array Mutation Tracking', () => {
  let backend;
  let analyzer;

  beforeEach(async () => {
    if (backend) await backend.cleanup();
    backend = createTestBackend();
    await backend.connect();
    analyzer = new JSASTAnalyzer();
  });

  after(async () => {
    if (backend) await backend.cleanup();
  });

  describe('arr.push(obj)', () => {
    it('should create FLOWS_INTO edge from pushed object to array variable', async () => {
      // Create MODULE node
      await backend.addNode({
        id: 'MODULE#test.js',
        type: 'MODULE',
        name: 'test',
        file: '/test/test.js',
        line: 1
      });

      // Analyze code: const arr = []; const obj = {}; arr.push(obj);
      // ... setup and assert FLOWS_INTO edge exists from obj variable to arr variable
    });

    it('should create multiple FLOWS_INTO edges for multiple arguments', async () => {
      // arr.push(a, b, c) should create 3 edges with metadata.argIndex
    });

    it('should handle spread: arr.push(...items) with isSpread metadata', async () => {
      // Verify edge has metadata.isSpread: true
    });
  });

  describe('arr.unshift(obj)', () => {
    it('should create FLOWS_INTO edge from unshifted object to array', async () => {
      // Similar to push test
    });
  });

  describe('arr.splice(i, 0, obj)', () => {
    it('should create FLOWS_INTO edge for inserted elements', async () => {
      // arr.splice(1, 0, newItem) - newItem flows into arr
    });
  });

  describe('arr[i] = obj (indexed assignment)', () => {
    it('should create FLOWS_INTO edge from assigned object to array', async () => {
      // arr[0] = obj creates edge
    });

    it('should handle computed index: arr[index] = obj', async () => {
      // Variable index should still create edge
    });
  });

  describe('Edge direction and metadata', () => {
    it('should create edge with direction: source -> array', async () => {
      // Verify edge.src is the pushed value, edge.dst is the array
    });

    it('should include argIndex in metadata for push/unshift', async () => {
      // metadata.argIndex should be present
    });

    it('should include mutationMethod in metadata', async () => {
      // metadata.mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed'
    });
  });
});
```

## Step 2: Add FLOWS_INTO Edge Type

### File: `packages/types/src/edges.ts`

### Changes:

Add `FLOWS_INTO` to the `EDGE_TYPE` constant after line 39 (in the "Variables/Data flow" section):

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
FLOWS_INTO: 'FLOWS_INTO',  // ADD THIS LINE - data flow into containers (arrays, collections)
```

Add a new interface after `DataFlowEdge` (around line 111):

```typescript
/**
 * Edge representing data flowing INTO a container (array, collection)
 * Source: the value being added
 * Destination: the container receiving the value
 */
export interface FlowsIntoEdge extends EdgeRecord {
  type: 'FLOWS_INTO';
  metadata?: {
    mutationMethod?: 'push' | 'unshift' | 'splice' | 'indexed';
    argIndex?: number;
    isSpread?: boolean;
  };
}
```

Update the `DataFlowEdge` type union to include `FLOWS_INTO`:

```typescript
export interface DataFlowEdge extends EdgeRecord {
  type: 'ASSIGNED_FROM' | 'READS_FROM' | 'WRITES_TO' | 'PASSES_ARGUMENT' | 'DERIVES_FROM' | 'FLOWS_INTO';
  dataType?: string;
}
```

## Step 3: Add ArrayMutationInfo Type

### File: `packages/core/src/plugins/analysis/ast/types.ts`

### Changes:

Add new interface after `ArrayElementInfo` (around line 343):

```typescript
// === ARRAY MUTATION INFO ===
/**
 * Tracks array mutation calls (push, unshift, splice) and indexed assignments
 * Used to create FLOWS_INTO edges in GraphBuilder
 */
export interface ArrayMutationInfo {
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for lookup)
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
  valueName?: string;          // For VARIABLE type
  valueNodeId?: string;        // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL
  literalValue?: unknown;      // For LITERAL type
  callLine?: number;           // For CALL type
  callColumn?: number;
}
```

Add to `ASTCollections` interface (around line 416):

```typescript
// Array mutation tracking for FLOWS_INTO edges
arrayMutations?: ArrayMutationInfo[];
```

## Step 4: Detect Array Mutations in CallExpressionVisitor

### File: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

### Changes:

#### 4.1 Add ArrayMutationInfo import and types

At the top of the file, after the existing interface imports (around line 78), add:

```typescript
/**
 * Array mutation info for FLOWS_INTO edges
 */
interface ArrayMutationInfo {
  arrayName: string;
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  arguments: ArrayMutationArgument[];
}

interface ArrayMutationArgument {
  argIndex: number;
  isSpread?: boolean;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;
  valueNodeId?: string;
  literalValue?: unknown;
  callLine?: number;
  callColumn?: number;
}
```

#### 4.2 Add array mutation detection in getHandlers()

In the `getHandlers()` method, after the existing method call handling (around line 908), add array mutation detection:

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

Add new method after `extractArrayElements` (around line 767):

```typescript
/**
 * Detect array mutation calls (push, unshift, splice) and collect mutation info
 */
detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule
): void {
  // Initialize collection if not exists
  if (!this.collections.arrayMutations) {
    this.collections.arrayMutations = [];
  }
  const arrayMutations = this.collections.arrayMutations as ArrayMutationInfo[];

  const mutationArgs: ArrayMutationArgument[] = [];

  // For splice, only arguments from index 2 onwards are insertions
  // splice(start, deleteCount, item1, item2, ...)
  const startArgIndex = method === 'splice' ? 2 : 0;

  callNode.arguments.forEach((arg, index) => {
    // Skip start and deleteCount for splice
    if (method === 'splice' && index < 2) return;

    const argInfo: ArrayMutationArgument = {
      argIndex: method === 'splice' ? index - 2 : index,
      isSpread: arg.type === 'SpreadElement'
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
    } else {
      argInfo.valueType = 'EXPRESSION';
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

## Step 5: Handle Indexed Assignment in JSASTAnalyzer

### File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### Changes:

In the `analyzeFunctionBody` method, add handling for indexed array assignment. After the existing `AssignmentExpression` handling (which is currently only at module level around line 845), add detection within function bodies.

#### 5.1 Add to funcPath.traverse() handlers (around line 1155)

Add after `UpdateExpression` handler (around line 1500):

```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Get array name
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      // Initialize collection if not exists
      if (!collections.arrayMutations) {
        (collections as Collections).arrayMutations = [];
      }
      const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

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

#### 5.2 Add ArrayMutationInfo import

At the top of JSASTAnalyzer.ts (around line 80), add to the imports from types.js:

```typescript
import type {
  // ... existing imports ...
  ArrayMutationInfo,
  ArrayMutationArgument,
} from './ast/types.js';
```

#### 5.3 Add arrayMutations to Collections interface (around line 120)

```typescript
arrayMutations: ArrayMutationInfo[];
```

#### 5.4 Initialize arrayMutations in analyzeModule (around line 758)

```typescript
const arrayMutations: ArrayMutationInfo[] = [];
```

#### 5.5 Pass arrayMutations to GraphBuilder (around line 1033)

Add to the object passed to `this.graphBuilder.build()`:

```typescript
const result = await this.graphBuilder.build(module, graph, projectPath, {
  // ... existing fields ...
  arrayMutations,  // ADD THIS
});
```

## Step 6: Create FLOWS_INTO Edges in GraphBuilder

### File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Changes:

#### 6.1 Add ArrayMutationInfo import (around line 36)

```typescript
import type {
  // ... existing imports ...
  ArrayMutationInfo,
} from './types.js';
```

#### 6.2 Add arrayMutations to build() destructuring (around line 120)

```typescript
const {
  // ... existing fields ...
  arrayMutations = [],
} = data;
```

#### 6.3 Add bufferArrayMutationEdges call (around line 236, before flush)

```typescript
// 28. Buffer FLOWS_INTO edges for array mutations
this.bufferArrayMutationEdges(arrayMutations, variableDeclarations);
```

#### 6.4 Add bufferArrayMutationEdges method (around line 1378, after bufferArrayElementEdges)

```typescript
/**
 * Buffer FLOWS_INTO edges for array mutations (push, unshift, splice, indexed assignment)
 *
 * Edge direction: source value -> array (value FLOWS_INTO array)
 */
private bufferArrayMutationEdges(
  arrayMutations: ArrayMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  for (const mutation of arrayMutations) {
    const { arrayName, mutationMethod, file, line, column, arguments: mutationArgs } = mutation;

    // Find the array variable node
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
        // Find variable declaration
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
      // Note: CALL and EXPRESSION types need different handling - they create
      // their own nodes that should be linked. For MVP, we focus on VARIABLE.

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

## Step 7: Update NodeCreationValidator

### File: `packages/core/src/plugins/validation/NodeCreationValidator.ts`

### Changes:

The NodeCreationValidator needs to traverse `FLOWS_INTO` edges when tracing object origins. This allows it to detect objects that flow into arrays and then are passed to `addNodes()`.

#### 7.1 Update isFromNodeFactory method (around line 391)

Add `FLOWS_INTO` to the edge types being traced:

```typescript
private isFromNodeFactory(
  nodeId: string,
  edgesByDst: Map<string, EdgeRecord[]>,
  nodesById: Map<string, BaseNodeRecord>,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);

  // Find incoming ASSIGNED_FROM and FLOWS_INTO edges
  const incomingEdges = edgesByDst.get(nodeId)?.filter(e =>
    e.type === 'ASSIGNED_FROM' || e.type === 'FLOWS_INTO'  // UPDATED
  ) || [];

  // ... rest of method unchanged
}
```

#### 7.2 Update traceVariableSource method (around line 434)

Add `FLOWS_INTO` edge traversal:

```typescript
private traceVariableSource(
  nodeId: string,
  edgesBySrc: Map<string, EdgeRecord[]>,
  nodesById: Map<string, BaseNodeRecord>,
  visited: Set<string> = new Set()
): BaseNodeRecord | null {
  if (visited.has(nodeId)) return null;
  visited.add(nodeId);

  // Find outgoing ASSIGNED_FROM and incoming FLOWS_INTO edges
  const outgoingEdges = edgesBySrc.get(nodeId)?.filter(e =>
    e.type === 'ASSIGNED_FROM' || e.type === 'FLOWS_INTO'  // UPDATED
  ) || [];

  // ... rest of method unchanged
}
```

## Verification

After implementation, verify with:

1. **Run unit tests:**
   ```bash
   node --test test/unit/ArrayMutationTracking.test.ts
   ```

2. **Run full test suite:**
   ```bash
   npm test
   ```

3. **Manual verification with sample code:**
   Create a test file with:
   ```javascript
   const arr = [];
   const obj = { name: 'test' };
   arr.push(obj);
   arr[1] = { name: 'test2' };
   ```
   Run `grafema analyze` and query for FLOWS_INTO edges.

4. **Verify NodeCreationValidator can trace through arrays:**
   Run the validator on GraphBuilder code itself to ensure it properly traces objects that flow through arrays into `addNodes()` calls.

## Implementation Order

1. Kent Beck: Write tests first (Step 1)
2. Rob Pike: Add edge type (Step 2)
3. Rob Pike: Add types (Step 3)
4. Rob Pike: Implement CallExpressionVisitor detection (Step 4)
5. Rob Pike: Implement JSASTAnalyzer indexed assignment (Step 5)
6. Rob Pike: Implement GraphBuilder edge creation (Step 6)
7. Rob Pike: Update NodeCreationValidator (Step 7)
8. Run tests and verify

## Notes for Implementation

1. **Edge direction matters:** The edge should go FROM the value being added TO the array. This matches the semantic "value FLOWS_INTO array" and allows tracing what enters an array.

2. **Variable resolution:** We resolve variable names to their VARIABLE nodes using the file as context. This is the same pattern used in `bufferArrayElementEdges`.

3. **Spread handling:** When `...items` is spread into push, we create a single edge from `items` to the array with `metadata.isSpread: true`. We don't try to resolve what's inside `items`.

4. **Method call node creation:** The method call `arr.push(obj)` still creates a CALL node as before. The FLOWS_INTO edge is additional data flow tracking.

5. **Splice complexity:** For `arr.splice(i, deleteCount, item1, item2)`, only `item1` and `item2` (arguments from index 2 onwards) are insertions. Arguments 0 and 1 are the index and delete count.

6. **Out of scope:** Tracking removed elements from `splice` (the return value) is out of scope per Don's plan.
