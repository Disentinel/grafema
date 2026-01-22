# REG-114: Object Property Mutation Tracking - Technical Implementation Plan

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2025-01-22
**Based on:** Don Melton's Technical Analysis (002-don-plan.md)

---

## Executive Summary

This document expands Don's high-level plan into a detailed implementation specification. We follow the established array mutation pattern (REG-113) to create `FLOWS_INTO` edges for object property mutations.

---

## 1. Answers to Don's Questions

### Q1: Should `Object.assign` detection be a method in `CallExpressionVisitor` or a separate visitor?

**Answer: Method in `CallExpressionVisitor`**

Rationale:
- `Object.assign()` is a CallExpression with a MemberExpression callee (`Object.assign`)
- This perfectly fits `CallExpressionVisitor`'s existing responsibility
- Following the array mutation pattern where `arr.push()` is detected in the same visitor
- No need for a separate visitor - it would just duplicate the CallExpression handling infrastructure

Implementation: Add `detectObjectAssign()` method in `CallExpressionVisitor`, analogous to `detectArrayMutation()`.

### Q2: For spread operators, should we enhance existing `extractObjectProperties` or create separate detection?

**Answer: Enhance existing `extractObjectProperties`**

Rationale:
- `extractObjectProperties` already handles SpreadElement (line 494-511 in CallExpressionVisitor.ts)
- It already sets `valueType: 'SPREAD'` and `propertyName: '<spread>'`
- What's missing: collecting this into `ObjectMutationInfo` for edge creation
- The spread data is already extracted; we just need to convert it to mutations

Implementation:
1. Keep `extractObjectProperties` unchanged (it extracts to `ObjectPropertyInfo`)
2. In GraphBuilder, process `ObjectPropertyInfo` entries with `valueType: 'SPREAD'` to create `FLOWS_INTO` edges

This approach is simpler than creating a parallel detection path.

### Q3: Should we track assignment to `this.prop = value` in constructors/methods?

**Answer: Yes, but with limitations**

Rationale:
- `this.prop = value` is semantically identical to `obj.prop = value`
- Important for tracking DI, configuration in class-based code
- Already partially handled: `ThisExpression` is recognized in method call detection

Limitations:
- Track as mutations on a pseudo-object named `this`
- Graph queries need to understand `this` refers to the instance
- Cross-method tracking (constructor sets, method reads) requires additional analysis

Implementation:
- Include `ThisExpression` in object property mutation detection
- Object name will be `this`
- Document that `this` mutations only track within the same method scope

---

## 2. Type Definitions

### 2.1 New Type: `ObjectMutationInfo`

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

Add after `ArrayMutationArgument` (around line 400):

```typescript
// === OBJECT MUTATION INFO ===
/**
 * Tracks object property mutations for FLOWS_INTO edge creation in GraphBuilder.
 * Handles: obj.prop = value, obj['prop'] = value, Object.assign(), spread in object literals.
 *
 * IMPORTANT: This type is defined ONLY here. Import from this file everywhere.
 */
export interface ObjectMutationInfo {
  id?: string;                   // Semantic ID for the mutation (optional for backward compatibility)
  objectName: string;            // Name of the object being mutated ('config', 'this', etc.)
  objectLine?: number;           // Line where object is referenced (for scope resolution)
  propertyName: string;          // Property name or '<computed>' for obj[x] or '<spread>' for spread
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}

export interface ObjectMutationValue {
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;            // For VARIABLE type - name of the variable
  valueNodeId?: string;          // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - node ID
  literalValue?: unknown;        // For LITERAL type
  callLine?: number;             // For CALL type
  callColumn?: number;
  isSpread?: boolean;            // For Object.assign with spread: Object.assign(target, ...sources)
  argIndex?: number;             // For Object.assign - which source argument (0, 1, 2, ...)
}
```

### 2.2 Update `ASTCollections` Interface

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

Add to `ASTCollections` interface (around line 476):

```typescript
// Object mutation tracking for FLOWS_INTO edges
objectMutations?: ObjectMutationInfo[];
```

### 2.3 Update `Collections` Interface in JSASTAnalyzer

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Add to `Collections` interface (around line 130):

```typescript
// Object mutation tracking for FLOWS_INTO edges
objectMutations: ObjectMutationInfo[];
```

---

## 3. Detection Implementation

### 3.1 Module-Level Property Assignment Detection

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** In `AssignmentExpression` traverse handler (around line 932)

Add detection for `obj.prop = value` and `obj['prop'] = value`:

```typescript
// Check for object property mutation at module level: obj.prop = value
this.detectObjectPropertyAssignment(assignNode, module, objectMutations);
```

**New method to add (after `detectIndexedArrayAssignment`, around line 2180):**

```typescript
/**
 * Detect object property assignment: obj.prop = value, obj['prop'] = value
 * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 *
 * @param assignNode - The assignment expression node
 * @param module - Current module being analyzed
 * @param objectMutations - Collection to push mutation info into
 * @param scopeTracker - Optional scope tracker for semantic IDs
 */
private detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
  // Check for property assignment: obj.prop = value or obj['prop'] = value
  if (assignNode.left.type !== 'MemberExpression') return;

  const memberExpr = assignNode.left;

  // Skip indexed array assignment (already handled)
  // Array indexed: arr[0], arr[i] - numeric or variable index
  // Object property: obj.prop, obj['prop'] - string keys
  // Heuristic: if computed and key is numeric literal, treat as array
  if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
    return; // Let array mutation handler deal with this
  }

  // Get object name
  let objectName: string;
  if (memberExpr.object.type === 'Identifier') {
    objectName = memberExpr.object.name;
  } else if (memberExpr.object.type === 'ThisExpression') {
    objectName = 'this';
  } else {
    // Complex expressions like obj.nested.prop = value
    // For now, skip these (documented limitation)
    return;
  }

  // Get property name
  let propertyName: string;
  let mutationType: 'property' | 'computed';

  if (!memberExpr.computed) {
    // obj.prop
    if (memberExpr.property.type === 'Identifier') {
      propertyName = memberExpr.property.name;
      mutationType = 'property';
    } else {
      return; // Unexpected property type
    }
  } else {
    // obj['prop'] or obj[key]
    if (memberExpr.property.type === 'StringLiteral') {
      propertyName = memberExpr.property.value;
      mutationType = 'property'; // String literal is effectively a property name
    } else {
      propertyName = '<computed>';
      mutationType = 'computed';
    }
  }

  // Extract value info
  const value = assignNode.right;
  const valueInfo = this.extractMutationValue(value, module);

  // Use defensive loc checks
  const line = assignNode.loc?.start.line ?? 0;
  const column = assignNode.loc?.start.column ?? 0;

  // Generate semantic ID if scopeTracker available
  let mutationId: string | undefined;
  if (scopeTracker) {
    const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}`);
    mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
  }

  objectMutations.push({
    id: mutationId,
    objectName,
    propertyName,
    mutationType,
    file: module.file,
    line,
    column,
    value: valueInfo
  });
}

/**
 * Extract value information from an expression for mutation tracking
 */
private extractMutationValue(value: t.Expression, module: VisitorModule): ObjectMutationValue {
  const valueInfo: ObjectMutationValue = {
    valueType: 'EXPRESSION'  // Default
  };

  const literalValue = ExpressionEvaluator.extractLiteralValue(value);
  if (literalValue !== null) {
    valueInfo.valueType = 'LITERAL';
    valueInfo.literalValue = literalValue;
  } else if (value.type === 'Identifier') {
    valueInfo.valueType = 'VARIABLE';
    valueInfo.valueName = value.name;
  } else if (value.type === 'ObjectExpression') {
    valueInfo.valueType = 'OBJECT_LITERAL';
  } else if (value.type === 'ArrayExpression') {
    valueInfo.valueType = 'ARRAY_LITERAL';
  } else if (value.type === 'CallExpression') {
    valueInfo.valueType = 'CALL';
    valueInfo.callLine = value.loc?.start.line;
    valueInfo.callColumn = value.loc?.start.column;
  }

  return valueInfo;
}
```

### 3.2 Function-Level Property Assignment Detection

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** In `analyzeFunctionBody` method, in the `AssignmentExpression` handler (around line 1282)

Update the existing handler to also detect object property mutations:

```typescript
AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
  const assignNode = assignPath.node;

  // Initialize collections if not exists
  if (!collections.arrayMutations) {
    collections.arrayMutations = [];
  }
  if (!collections.objectMutations) {
    collections.objectMutations = [];
  }
  const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];
  const objectMutations = collections.objectMutations as ObjectMutationInfo[];

  // Check for indexed array assignment: arr[i] = value
  this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);

  // Check for object property assignment: obj.prop = value
  this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
},
```

### 3.3 Object.assign() Detection

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** In the method call handling section (after array mutation detection, around line 1066)

Add detection for `Object.assign()`:

```typescript
// Check for Object.assign(target, source1, source2, ...)
if (objectName === 'Object' && methodName === 'assign') {
  this.detectObjectAssign(callNode, module);
}
```

**New method to add (after `detectArrayMutation`, around line 888):**

```typescript
/**
 * Detect Object.assign(target, source1, source2, ...) calls
 * Creates ObjectMutationInfo entries for each source -> target flow
 *
 * Object.assign(target, source1, source2, ...)
 * - source1, source2, etc. all FLOW_INTO target
 * - We track each source as a separate mutation
 */
private detectObjectAssign(
  callNode: CallExpression,
  module: VisitorModule
): void {
  // Need at least 2 arguments: target and at least one source
  if (callNode.arguments.length < 2) return;

  // Initialize collection if not exists
  if (!this.collections.objectMutations) {
    this.collections.objectMutations = [];
  }
  const objectMutations = this.collections.objectMutations as ObjectMutationInfo[];

  // First argument is target
  const targetArg = callNode.arguments[0];
  let targetName: string;

  if (targetArg.type === 'Identifier') {
    targetName = targetArg.name;
  } else if (targetArg.type === 'ObjectExpression') {
    // Object.assign({}, source) - anonymous target
    targetName = '<anonymous>';
  } else {
    return; // Complex target, skip for now
  }

  const line = callNode.loc?.start.line ?? 0;
  const column = callNode.loc?.start.column ?? 0;

  // Process each source argument (arguments 1, 2, 3, ...)
  for (let i = 1; i < callNode.arguments.length; i++) {
    let arg = callNode.arguments[i];
    let isSpread = false;

    // Handle spread: Object.assign(target, ...sources)
    if (arg.type === 'SpreadElement') {
      isSpread = true;
      arg = arg.argument;
    }

    const valueInfo: ObjectMutationValue = {
      valueType: 'EXPRESSION',
      argIndex: i - 1,  // Source index (0-based)
      isSpread
    };

    const literalValue = ExpressionEvaluator.extractLiteralValue(arg);
    if (literalValue !== null) {
      valueInfo.valueType = 'LITERAL';
      valueInfo.literalValue = literalValue;
    } else if (arg.type === 'Identifier') {
      valueInfo.valueType = 'VARIABLE';
      valueInfo.valueName = (arg as Identifier).name;
    } else if (arg.type === 'ObjectExpression') {
      valueInfo.valueType = 'OBJECT_LITERAL';
    } else if (arg.type === 'ArrayExpression') {
      valueInfo.valueType = 'ARRAY_LITERAL';
    } else if (arg.type === 'CallExpression') {
      valueInfo.valueType = 'CALL';
      valueInfo.callLine = arg.loc?.start.line;
      valueInfo.callColumn = arg.loc?.start.column;
    }

    // Generate semantic ID if scopeTracker available
    let mutationId: string | undefined;
    if (this.scopeTracker) {
      const discriminator = this.scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, this.scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName: targetName,
      propertyName: '<assign>',  // Special marker for Object.assign
      mutationType: 'assign',
      file: module.file,
      line,
      column,
      value: valueInfo
    });
  }
}
```

### 3.4 Object.assign() in Function Bodies

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** In `analyzeFunctionBody`, in the `CallExpression` handler (around line 1940)

Add after the array mutation detection:

```typescript
// Check for Object.assign(target, source1, source2, ...)
if (objectName === 'Object' && methodName === 'assign') {
  this.detectObjectAssignInFunction(
    callNode,
    module,
    collections.objectMutations as ObjectMutationInfo[] ?? [],
    scopeTracker
  );
}
```

**New method to add:**

```typescript
/**
 * Detect Object.assign() calls inside functions
 * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 */
private detectObjectAssignInFunction(
  callNode: t.CallExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
  // Need at least 2 arguments: target and at least one source
  if (callNode.arguments.length < 2) return;

  // First argument is target
  const targetArg = callNode.arguments[0];
  let targetName: string;

  if (targetArg.type === 'Identifier') {
    targetName = targetArg.name;
  } else if (targetArg.type === 'ObjectExpression') {
    targetName = '<anonymous>';
  } else {
    return;
  }

  const line = callNode.loc?.start.line ?? 0;
  const column = callNode.loc?.start.column ?? 0;

  for (let i = 1; i < callNode.arguments.length; i++) {
    let arg = callNode.arguments[i];
    let isSpread = false;

    if (arg.type === 'SpreadElement') {
      isSpread = true;
      arg = arg.argument;
    }

    const valueInfo: ObjectMutationValue = {
      valueType: 'EXPRESSION',
      argIndex: i - 1,
      isSpread
    };

    const literalValue = ExpressionEvaluator.extractLiteralValue(arg);
    if (literalValue !== null) {
      valueInfo.valueType = 'LITERAL';
      valueInfo.literalValue = literalValue;
    } else if (arg.type === 'Identifier') {
      valueInfo.valueType = 'VARIABLE';
      valueInfo.valueName = (arg as t.Identifier).name;
    } else if (arg.type === 'ObjectExpression') {
      valueInfo.valueType = 'OBJECT_LITERAL';
    } else if (arg.type === 'ArrayExpression') {
      valueInfo.valueType = 'ARRAY_LITERAL';
    } else if (arg.type === 'CallExpression') {
      valueInfo.valueType = 'CALL';
      valueInfo.callLine = arg.loc?.start.line;
      valueInfo.callColumn = arg.loc?.start.column;
    }

    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName: targetName,
      propertyName: '<assign>',
      mutationType: 'assign',
      file: module.file,
      line,
      column,
      value: valueInfo
    });
  }
}
```

---

## 4. Edge Creation in GraphBuilder

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 4.1 Update `build()` method

**Location:** In the `build()` method, update the destructuring (around line 122) and add new buffer call.

Add to destructuring:
```typescript
// Object mutation tracking for FLOWS_INTO edges
objectMutations = [],
```

Add new buffer call (after `bufferArrayMutationEdges`, around line 236):
```typescript
// 29. Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign, spread)
this.bufferObjectMutationEdges(objectMutations, variableDeclarations);
```

### 4.2 New Method: `bufferObjectMutationEdges`

Add after `bufferArrayMutationEdges` (around line 1282):

```typescript
/**
 * Buffer FLOWS_INTO edges for object property mutations
 * Creates edges from assigned values to the object variable
 *
 * obj.prop = value  ->  value FLOWS_INTO obj (via prop)
 * Object.assign(target, source)  ->  source FLOWS_INTO target (via <assign>)
 */
private bufferObjectMutationEdges(
  objectMutations: ObjectMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  for (const mutation of objectMutations) {
    const { objectName, propertyName, mutationType, value, file } = mutation;

    // Skip anonymous targets (Object.assign({}, source))
    if (objectName === '<anonymous>') continue;

    // Find the object variable in the same file
    const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
    if (!objectVar) continue;

    // Only create edges for VARIABLE values (resolvable sources)
    if (value.valueType === 'VARIABLE' && value.valueName) {
      const sourceVar = variableDeclarations.find(v => v.name === value.valueName && v.file === file);
      if (sourceVar) {
        const edgeData: GraphEdge = {
          type: 'FLOWS_INTO',
          src: sourceVar.id,
          dst: objectVar.id,
          metadata: {
            mutationType,
            propertyName
          }
        };

        // Add argIndex for Object.assign
        if (mutationType === 'assign' && value.argIndex !== undefined) {
          edgeData.metadata = { ...edgeData.metadata, argIndex: value.argIndex };
        }

        // Add isSpread flag
        if (value.isSpread) {
          edgeData.metadata = { ...edgeData.metadata, isSpread: true };
        }

        this._bufferEdge(edgeData);
      }
    }
    // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - we could create edges from LITERAL nodes
    // but for now we just track variable -> object flows (matching array mutation behavior)
  }
}
```

### 4.3 Update Type Import

At the top of `GraphBuilder.ts`, update the import to include `ObjectMutationInfo`:

```typescript
import type {
  // ... existing imports ...
  ObjectMutationInfo,
} from './types.js';
```

---

## 5. Wire Up Collections

### 5.1 In `analyzeModule()`

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Around line 781, after `arrayMutations` initialization:

```typescript
// Object mutation tracking for FLOWS_INTO edges
const objectMutations: ObjectMutationInfo[] = [];
```

**Location:** In `allCollections` object (around line 844):

```typescript
// Object mutation tracking
objectMutations,
```

**Location:** In the `graphBuilder.build()` call (around line 1089):

```typescript
// Object mutation tracking
objectMutations,
```

---

## 6. Test Specifications

### 6.1 Test File Location

Create new test file: `/test/unit/ObjectMutationTracking.test.js`

### 6.2 Test Cases

```javascript
/**
 * Tests for Object Property Mutation Tracking (FLOWS_INTO edges)
 *
 * When code does obj.prop = value, obj['prop'] = value, or Object.assign(target, source),
 * we need to create a FLOWS_INTO edge from the value to the object.
 * This allows tracing what data flows into object configurations.
 *
 * Edge direction: value FLOWS_INTO object (src=value, dst=object)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
// ... standard imports ...

describe('Object Mutation Tracking', () => {
  // Setup/teardown as in ArrayMutationTracking.test.js

  describe('obj.prop = value', () => {
    it('should create FLOWS_INTO edge from assigned variable to object', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const handler = () => {};
config.handler = handler;
        `
      });

      // Find config and handler variables
      // Verify FLOWS_INTO edge from handler to config
      // Verify metadata: mutationType: 'property', propertyName: 'handler'
    });

    it('should handle multiple property assignments to same object', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const a = 1;
const b = 2;
obj.a = a;
obj.b = b;
        `
      });

      // Verify 2 FLOWS_INTO edges, both pointing to obj
      // Verify different propertyName metadata
    });

    it('should track this.prop = value in class methods', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  constructor() {
    this.value = null;
  }
  setHandler(h) {
    this.handler = h;
  }
}
const cfg = new Config();
const myHandler = () => {};
cfg.setHandler(myHandler);
        `
      });

      // Verify FLOWS_INTO edge exists with objectName: 'this'
    });
  });

  describe("obj['prop'] = value (computed property)", () => {
    it('should create FLOWS_INTO edge for string literal key', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const handler = () => {};
config['handler'] = handler;
        `
      });

      // Verify FLOWS_INTO edge
      // propertyName should be 'handler', not '<computed>'
    });

    it('should track computed key with <computed> property name', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const key = 'handler';
const value = () => {};
config[key] = value;
        `
      });

      // Verify FLOWS_INTO edge
      // propertyName should be '<computed>'
      // mutationType should be 'computed'
    });
  });

  describe('Object.assign(target, source)', () => {
    it('should create FLOWS_INTO edge from source to target', async () => {
      await setupTest(backend, {
        'index.js': `
const defaults = { a: 1 };
const overrides = { b: 2 };
const merged = {};
Object.assign(merged, defaults);
        `
      });

      // Verify FLOWS_INTO edge from defaults to merged
      // mutationType: 'assign', propertyName: '<assign>'
    });

    it('should create multiple edges for multiple sources', async () => {
      await setupTest(backend, {
        'index.js': `
const target = {};
const source1 = { a: 1 };
const source2 = { b: 2 };
const source3 = { c: 3 };
Object.assign(target, source1, source2, source3);
        `
      });

      // Verify 3 FLOWS_INTO edges, all pointing to target
      // Each with different argIndex: 0, 1, 2
    });

    it('should handle spread in Object.assign', async () => {
      await setupTest(backend, {
        'index.js': `
const target = {};
const sources = [{ a: 1 }, { b: 2 }];
Object.assign(target, ...sources);
        `
      });

      // Verify FLOWS_INTO edge with isSpread: true
    });
  });

  describe('Edge metadata verification', () => {
    it('should include mutationType in edge metadata', async () => {
      // Test 'property', 'computed', 'assign' types
    });

    it('should include propertyName in edge metadata', async () => {
      // Test actual property names and special markers
    });
  });

  describe('Function-level mutations', () => {
    it('should detect property assignments inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function configureApp(config) {
  const handler = () => {};
  config.handler = handler;
}
        `
      });

      // Verify FLOWS_INTO edge created for mutation inside function
    });

    it('should detect Object.assign inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function merge(target, source) {
  Object.assign(target, source);
}
        `
      });

      // Verify FLOWS_INTO edge created
    });
  });

  describe('Integration with existing data flow', () => {
    it('should allow tracing objects through property assignment to usage', async () => {
      // Real-world scenario: DI container
      await setupTest(backend, {
        'index.js': `
const container = {};
const service = { process: () => {} };
container.userService = service;
// Later: container.userService.process()
        `
      });

      // Verify we can trace: service -> container (via userService)
    });
  });
});
```

---

## 7. Implementation Order

### Phase 1: Types (Kent leads)
1. Add `ObjectMutationInfo` and `ObjectMutationValue` types to `types.ts`
2. Update `ASTCollections` interface
3. Update `Collections` interface in `JSASTAnalyzer.ts`

### Phase 2: Detection (Rob implements)
1. Add `detectObjectPropertyAssignment()` method in `JSASTAnalyzer.ts`
2. Add `extractMutationValue()` helper method in `JSASTAnalyzer.ts`
3. Wire up module-level detection in `AssignmentExpression` handler
4. Wire up function-level detection in `analyzeFunctionBody`
5. Add `detectObjectAssign()` method in `CallExpressionVisitor.ts`
6. Add `detectObjectAssignInFunction()` method in `JSASTAnalyzer.ts`
7. Wire up `Object.assign` detection in both module and function levels

### Phase 3: Edge Creation (Rob implements)
1. Add `bufferObjectMutationEdges()` method in `GraphBuilder.ts`
2. Update `build()` method to call the new buffer method
3. Update imports

### Phase 4: Integration (Rob implements)
1. Initialize `objectMutations` collection in `analyzeModule()`
2. Add to `allCollections` object
3. Pass to `graphBuilder.build()`

### Phase 5: Tests (Kent writes, before each phase)
1. Write test cases before implementation
2. Run tests to verify red -> green progression

---

## 8. Acceptance Criteria

1. `obj.prop = variable` creates `FLOWS_INTO` edge from variable to obj
2. `obj['prop'] = variable` creates `FLOWS_INTO` edge with string key
3. `obj[key] = variable` creates `FLOWS_INTO` edge with `<computed>` property
4. `Object.assign(target, source)` creates `FLOWS_INTO` edge from source to target
5. Multiple `Object.assign` arguments create multiple edges with correct `argIndex`
6. `this.prop = value` in methods creates edge with object name `this`
7. All mutations detected both at module level and inside functions
8. Edge metadata includes `mutationType` and `propertyName`
9. All existing tests pass
10. New tests cover all scenarios

---

## 9. Out of Scope (Document for Future Work)

- Spread in object literals: `{ ...obj }` (existing `ObjectPropertyInfo` handles this)
- Chained property access: `obj.nested.prop = value`
- Object.defineProperty() calls
- Prototype chain modifications
- Method calls that mutate properties: `obj.setProperty(name, value)`

These should be created as separate Linear issues after REG-114 is complete.
