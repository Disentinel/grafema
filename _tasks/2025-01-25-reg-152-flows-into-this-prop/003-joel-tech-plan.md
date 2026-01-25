# REG-152: FLOWS_INTO Edges for `this.prop = value` - Technical Implementation Plan

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2025-01-25
**Based on:** Don Melton's plan (002-don-plan.md)

---

## Executive Summary

This document provides step-by-step implementation specifications for adding FLOWS_INTO edges when `this.prop = value` patterns are detected in class methods/constructors. The solution follows Don's recommended Option 3: use the CLASS node as the FLOWS_INTO destination, with edge metadata indicating the property name.

**Key insight from code analysis:** The `ScopeTracker` already maintains class context during traversal. When `detectObjectPropertyAssignment()` processes `this.prop = value`, we can use `scopeTracker.getContext()` to extract the enclosing class name. This is the cleanest solution requiring minimal changes.

---

## Implementation Overview

### Files to Modify

| File | Changes |
|------|---------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `enclosingClassName` field to `ObjectMutationInfo` |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Pass enclosing class name when collecting `this.prop` mutations |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Handle `objectName === 'this'` branch to resolve CLASS node |
| `test/unit/ObjectMutationTracking.test.js` | Unskip tests and update assertions |

### Dependencies Between Changes

```
1. types.ts (add field)
      |
      v
2. JSASTAnalyzer.ts (collect class context)
      |
      v
3. GraphBuilder.ts (create edges to CLASS)
      |
      v
4. Tests (validate behavior)
```

---

## Phase 1: Type Definition Changes

### File: `/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Lines 413-424 (ObjectMutationInfo interface)

**Current code:**
```typescript
export interface ObjectMutationInfo {
  id?: string;                   // Semantic ID for the mutation (optional for backward compatibility)
  objectName: string;            // Name of the object being mutated ('config', 'this', etc.)
  objectLine?: number;           // Line where object is referenced (for scope resolution)
  propertyName: string;          // Property name or '<computed>' for obj[x] or '<assign>' for Object.assign
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  computedPropertyVar?: string;  // Variable name in obj[key] = value (for computed mutation type)
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}
```

**Add new field after `objectLine`:**
```typescript
export interface ObjectMutationInfo {
  id?: string;                   // Semantic ID for the mutation (optional for backward compatibility)
  objectName: string;            // Name of the object being mutated ('config', 'this', etc.)
  objectLine?: number;           // Line where object is referenced (for scope resolution)
  enclosingClassName?: string;   // NEW: Class name when objectName === 'this' (for REG-152)
  propertyName: string;          // Property name or '<computed>' for obj[x] or '<assign>' for Object.assign
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  computedPropertyVar?: string;  // Variable name in obj[key] = value (for computed mutation type)
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}
```

**Also update GraphEdge interface (line 578-596) to add `this_property` mutation type:**

**Current:**
```typescript
// For FLOWS_INTO edges (object mutations)
mutationType?: 'property' | 'computed' | 'assign' | 'spread';
```

**Change to:**
```typescript
// For FLOWS_INTO edges (object mutations)
mutationType?: 'property' | 'computed' | 'assign' | 'spread' | 'this_property';
```

---

## Phase 2: AST Analysis Changes

### File: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** `detectObjectPropertyAssignment()` method (lines 2460-2543)

**Current behavior:** When `objectName === 'this'`, the code correctly sets `objectName = 'this'` but doesn't capture the enclosing class name.

**Strategy:** Use `scopeTracker.getContext().scopePath` to find the enclosing class. The scope path has format like `['Config', 'constructor']` when inside a class method.

**Modification at lines 2478-2488:**

**Current code:**
```typescript
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
```

**Add enclosing class extraction:**
```typescript
// Get object name
let objectName: string;
let enclosingClassName: string | undefined;

if (memberExpr.object.type === 'Identifier') {
  objectName = memberExpr.object.name;
} else if (memberExpr.object.type === 'ThisExpression') {
  objectName = 'this';
  // REG-152: Extract enclosing class name from scope context
  if (scopeTracker) {
    const scopePath = scopeTracker.getContext().scopePath;
    // Scope path format: ['ClassName', 'methodName'] or ['ClassName', 'constructor']
    // Find the CLASS scope entry (first entry that's a class name)
    // In ClassVisitor, classes are entered with scopeTracker.enterScope(className, 'CLASS')
    // We need to walk the stack to find the class context
    if (scopePath.length >= 1) {
      // The class name is the first scope entry when inside a class method
      // because ClassVisitor does enterScope(className, 'CLASS') before processing methods
      enclosingClassName = scopePath[0];
    }
  }
} else {
  // Complex expressions like obj.nested.prop = value
  // For now, skip these (documented limitation)
  return;
}
```

**Modification at lines 2533-2543 (where mutation is pushed):**

**Current code:**
```typescript
objectMutations.push({
  id: mutationId,
  objectName,
  propertyName,
  mutationType,
  computedPropertyVar,
  file: module.file,
  line,
  column,
  value: valueInfo
});
```

**Add enclosingClassName:**
```typescript
objectMutations.push({
  id: mutationId,
  objectName,
  enclosingClassName,  // NEW: Class name for 'this' mutations
  propertyName,
  mutationType,
  computedPropertyVar,
  file: module.file,
  line,
  column,
  value: valueInfo
});
```

---

## Phase 3: GraphBuilder Changes

### File: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location:** `bufferObjectMutationEdges()` method (lines 1341-1393)

**Current behavior (lines 1347-1358):**
```typescript
for (const mutation of objectMutations) {
  const { objectName, propertyName, mutationType, computedPropertyVar, value, file } = mutation;

  // Find the object variable or parameter in the same file
  // Skip 'this' - it's not a variable node, but we still create edges FROM source values
  let objectNodeId: string | null = null;
  if (objectName !== 'this') {
    const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
    const objectParam = !objectVar ? parameters.find(p => p.name === objectName && p.file === file) : null;
    objectNodeId = objectVar?.id ?? objectParam?.id ?? null;
    if (!objectNodeId) continue;
  }
```

**New implementation:**

```typescript
private bufferObjectMutationEdges(
  objectMutations: ObjectMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  functions: FunctionInfo[],
  classDeclarations: ClassDeclarationInfo[]  // NEW: Add classDeclarations parameter
): void {
  for (const mutation of objectMutations) {
    const { objectName, propertyName, mutationType, computedPropertyVar, value, file, enclosingClassName } = mutation;

    // Find the object variable or parameter in the same file
    let objectNodeId: string | null = null;
    let effectiveMutationType = mutationType;  // May change to 'this_property' for this.prop

    if (objectName !== 'this') {
      // Existing logic for regular objects
      const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
      const objectParam = !objectVar ? parameters.find(p => p.name === objectName && p.file === file) : null;
      objectNodeId = objectVar?.id ?? objectParam?.id ?? null;
      if (!objectNodeId) continue;
    } else {
      // REG-152: 'this' mutations - find the CLASS node
      if (!enclosingClassName) continue;  // Skip if no class context

      // Find the CLASS node with matching name and file
      const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === file);
      objectNodeId = classDecl?.id ?? null;

      if (!objectNodeId) continue;  // Skip if class not found

      // Use special mutation type to distinguish from regular property mutations
      effectiveMutationType = 'this_property';
    }

    // Create FLOWS_INTO edge for VARIABLE value type
    if (value.valueType === 'VARIABLE' && value.valueName) {
      // Find the source: can be variable, parameter, or function (arrow functions assigned to const)
      const sourceVar = variableDeclarations.find(v => v.name === value.valueName && v.file === file);
      const sourceParam = !sourceVar ? parameters.find(p => p.name === value.valueName && p.file === file) : null;
      const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
      const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;

      if (sourceNodeId) {
        if (objectNodeId) {
          const edgeData: GraphEdge = {
            type: 'FLOWS_INTO',
            src: sourceNodeId,
            dst: objectNodeId,
            mutationType: effectiveMutationType,  // 'this_property' for this.prop
            propertyName,
            computedPropertyVar  // For enrichment phase resolution
          };
          if (value.argIndex !== undefined) {
            edgeData.argIndex = value.argIndex;
          }
          if (value.isSpread) {
            edgeData.isSpread = true;
          }
          this._bufferEdge(edgeData);
        }
      }
    }
    // For literals, object literals, etc. - we just track variable -> object flows for now
  }
}
```

**Also update the method signature in `build()` (line 242):**

**Current:**
```typescript
// 27. Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign)
this.bufferObjectMutationEdges(objectMutations, variableDeclarations, parameters, functions);
```

**Change to:**
```typescript
// 27. Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign)
this.bufferObjectMutationEdges(objectMutations, variableDeclarations, parameters, functions, classDeclarations);
```

---

## Phase 4: Test Updates

### File: `/test/unit/ObjectMutationTracking.test.js`

**Location:** Lines 247-316 (skipped tests in `describe('this.prop = value')`)

**Test 1: Constructor pattern (lines 247-285)**

**Current (skipped):**
```javascript
it.skip('should track this.prop = value in constructor with objectName "this"', async () => {
```

**New implementation:**
```javascript
it('should track this.prop = value in constructor as FLOWS_INTO to CLASS', async () => {
  await setupTest(backend, {
    'index.js': `
class Config {
  constructor(handler) {
    this.handler = handler;
  }
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  // Find the CLASS node
  const classNode = allNodes.find(n =>
    n.type === 'CLASS' && n.name === 'Config'
  );
  assert.ok(classNode, 'CLASS "Config" not found');

  // Find the handler parameter
  const handlerParam = allNodes.find(n =>
    n.name === 'handler' && n.type === 'PARAMETER'
  );
  assert.ok(handlerParam, 'PARAMETER "handler" not found');

  // Find FLOWS_INTO edge from handler PARAMETER to CLASS
  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === handlerParam.id &&
    e.dst === classNode.id
  );

  assert.ok(
    flowsInto,
    `Expected FLOWS_INTO edge from handler to Config class. Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
  );

  // Verify metadata
  assert.strictEqual(flowsInto.mutationType, 'this_property', 'Edge should have mutationType: this_property');
  assert.strictEqual(flowsInto.propertyName, 'handler', 'Edge should have propertyName: handler');
});
```

**Test 2: Method pattern (lines 287-316)**

**Current (skipped):**
```javascript
it.skip('should track this.prop = value in class methods', async () => {
```

**New implementation:**
```javascript
it('should track this.prop = value in class methods as FLOWS_INTO to CLASS', async () => {
  await setupTest(backend, {
    'index.js': `
class Service {
  setHandler(h) {
    this.handler = h;
  }
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  // Find the CLASS node
  const classNode = allNodes.find(n =>
    n.type === 'CLASS' && n.name === 'Service'
  );
  assert.ok(classNode, 'CLASS "Service" not found');

  // Find the h parameter
  const hParam = allNodes.find(n =>
    n.name === 'h' && n.type === 'PARAMETER'
  );
  assert.ok(hParam, 'PARAMETER "h" not found');

  // Find FLOWS_INTO edge from h PARAMETER to CLASS
  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === hParam.id &&
    e.dst === classNode.id
  );

  assert.ok(flowsInto, 'Expected FLOWS_INTO edge from parameter "h" to Service class');
  assert.strictEqual(flowsInto.mutationType, 'this_property', 'Edge should have mutationType: this_property');
  assert.strictEqual(flowsInto.propertyName, 'handler', 'Edge should have propertyName: handler');
});
```

---

## Additional Test Cases to Add

Add these after the existing tests in the `this.prop = value` describe block:

```javascript
it('should handle multiple this.prop assignments in constructor', async () => {
  await setupTest(backend, {
    'index.js': `
class Config {
  constructor(a, b, c) {
    this.propA = a;
    this.propB = b;
    this.propC = c;
  }
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
  assert.ok(classNode, 'CLASS "Config" not found');

  // Find all FLOWS_INTO edges to the class
  const flowsIntoEdges = allEdges.filter(e =>
    e.type === 'FLOWS_INTO' &&
    e.dst === classNode.id &&
    e.mutationType === 'this_property'
  );

  assert.strictEqual(flowsIntoEdges.length, 3, 'Expected 3 FLOWS_INTO edges');

  const propertyNames = flowsIntoEdges.map(e => e.propertyName).sort();
  assert.deepStrictEqual(propertyNames, ['propA', 'propB', 'propC'], 'Should have all three property names');
});

it('should track local variable assignment to this.prop', async () => {
  await setupTest(backend, {
    'index.js': `
class Service {
  init() {
    const helper = () => {};
    this.helper = helper;
  }
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Service');
  assert.ok(classNode, 'CLASS "Service" not found');

  const helperVar = allNodes.find(n =>
    n.name === 'helper' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
  );
  assert.ok(helperVar, 'Variable "helper" not found');

  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === helperVar.id &&
    e.dst === classNode.id &&
    e.mutationType === 'this_property'
  );

  assert.ok(flowsInto, 'Expected FLOWS_INTO edge from helper variable to Service class');
});

it('should NOT create FLOWS_INTO edge for this.prop = literal', async () => {
  await setupTest(backend, {
    'index.js': `
class Config {
  constructor() {
    this.port = 3000;
    this.host = 'localhost';
  }
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
  assert.ok(classNode, 'CLASS "Config" not found');

  // Literals should not create FLOWS_INTO edges (matching existing behavior)
  const flowsIntoEdges = allEdges.filter(e =>
    e.type === 'FLOWS_INTO' &&
    e.dst === classNode.id &&
    e.mutationType === 'this_property'
  );

  assert.strictEqual(flowsIntoEdges.length, 0, 'Literal values should not create FLOWS_INTO edges');
});
```

---

## Edge Cases and Limitations

### 1. Static Methods (Out of Scope)

```javascript
class Counter {
  static increment(value) {
    this.count = value;  // 'this' refers to class constructor, not instance
  }
}
```

**Decision:** Skip for now. Static methods use `this` to refer to the class constructor, not an instance. This is semantically different and should be tracked as a separate enhancement. The current implementation will silently skip these (no error, just no edge created).

**Why it works:** The `enclosingClassName` will be extracted from scope context, but when GraphBuilder tries to find the CLASS node, it will match. However, the semantic meaning is different. Document this as a known limitation.

### 2. Arrow Functions in Methods

```javascript
class Service {
  process() {
    const handler = (x) => {
      this.data = x;  // 'this' from lexical scope
    };
  }
}
```

**Decision:** Track these. The arrow function captures `this` from the enclosing method. The ScopeTracker will have the correct class context because the arrow function is analyzed within the class method scope.

### 3. Nested Classes

```javascript
class Outer {
  method() {
    class Inner {
      constructor(val) {
        this.val = val;  // Should point to Inner, not Outer
      }
    }
  }
}
```

**Decision:** This should work correctly. The ScopeTracker enters `Inner` scope when processing the inner class, so `scopePath[0]` will be `Inner` (within the Inner's method context). However, need to verify this with a test.

### 4. Multiple Classes in Same File

```javascript
class A {
  constructor(x) { this.x = x; }
}
class B {
  constructor(y) { this.y = y; }
}
```

**Decision:** Works correctly. Each class is processed separately, and the ScopeTracker maintains correct context per class.

---

## Implementation Order

1. **Phase 1: types.ts** - Add `enclosingClassName` field and `this_property` mutation type
   - No dependencies
   - Minimal risk

2. **Phase 2: JSASTAnalyzer.ts** - Capture class context for `this.prop` mutations
   - Depends on Phase 1
   - Low risk (adds data, doesn't change existing behavior)

3. **Phase 3: GraphBuilder.ts** - Create FLOWS_INTO edges to CLASS nodes
   - Depends on Phase 1 and 2
   - Medium risk (changes edge creation logic)

4. **Phase 4: Tests** - Unskip and update tests
   - Depends on all previous phases
   - Validates implementation

---

## Verification Checklist

After implementation, verify:

1. [ ] `npm run build` succeeds
2. [ ] `node --test test/unit/ObjectMutationTracking.test.js` passes
3. [ ] Existing object mutation tests still pass (no regression)
4. [ ] Run on a real codebase with classes to verify edge creation

---

## Query Examples After Implementation

```cypher
// Find all parameters that flow into class instances
MATCH (p:PARAMETER)-[:FLOWS_INTO {mutationType: 'this_property'}]->(c:CLASS)
RETURN p.name, c.name

// Find what properties a specific class receives
MATCH ()-[f:FLOWS_INTO {mutationType: 'this_property'}]->(c:CLASS {name: 'Config'})
RETURN DISTINCT f.propertyName

// Trace data flow from parameter to class property
MATCH (p:PARAMETER {name: 'handler'})-[:FLOWS_INTO {propertyName: 'handler'}]->(c:CLASS)
RETURN p, c
```

---

## Summary

| Step | File | Change |
|------|------|--------|
| 1 | types.ts | Add `enclosingClassName?: string` to `ObjectMutationInfo` |
| 2 | types.ts | Add `'this_property'` to mutation type union |
| 3 | JSASTAnalyzer.ts | Extract class name from `scopeTracker` when `objectName === 'this'` |
| 4 | JSASTAnalyzer.ts | Include `enclosingClassName` in pushed mutation info |
| 5 | GraphBuilder.ts | Add `classDeclarations` parameter to `bufferObjectMutationEdges()` |
| 6 | GraphBuilder.ts | Handle `this` branch to find CLASS node by name |
| 7 | GraphBuilder.ts | Create edge with `mutationType: 'this_property'` |
| 8 | Tests | Unskip 2 tests, update assertions to expect CLASS as destination |
| 9 | Tests | Add edge case tests (multiple assignments, local vars, literals) |

**Estimated implementation time:** 2-3 hours including tests.

---

## Questions Resolved

From Don's plan:

1. **AST scope tracking:** ScopeTracker maintains class context via `enterScope(className, 'CLASS')` in ClassVisitor. We can extract this from `scopeTracker.getContext().scopePath`.

2. **Semantic ID resolution:** Direct lookup by class name and file is sufficient. The CLASS node is already created by ClassVisitor before method bodies are processed.

3. **Arrow function edge cases:** Will be handled automatically since arrow functions are analyzed within the class method scope, inheriting the correct class context.
