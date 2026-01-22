# REG-114: Track Object Property Mutations - Technical Analysis

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-22

## Executive Summary

This feature is architecturally sound and aligns perfectly with Grafema's vision. We have existing infrastructure for array mutations (`FLOWS_INTO` edges) that provides an excellent pattern to follow. The implementation is straightforward but requires careful attention to edge semantics.

---

## 1. Current State Analysis

### 1.1 Data Flow Tracking Architecture

Grafema tracks data flow through several edge types:

| Edge Type | Direction | Purpose |
|-----------|-----------|---------|
| `ASSIGNED_FROM` | variable -> source | Initial assignment `const x = y` |
| `DERIVES_FROM` | expression -> source | Expression depends on variable |
| `FLOWS_INTO` | value -> container | Value added to array/collection |
| `WRITES_TO` | call -> IO target | Side effect writes (console.log) |

### 1.2 Array Mutation Tracking (REG-113) - Completed Pattern

The array mutation tracking provides our blueprint. Here's how it works:

**Data Collection Phase** (`JSASTAnalyzer.ts`, `CallExpressionVisitor.ts`):
```typescript
interface ArrayMutationInfo {
  arrayName: string;
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  insertedValues: ArrayMutationArgument[];
}
```

Three detection points:
1. `CallExpressionVisitor.detectArrayMutation()` - module-level `arr.push()`
2. `JSASTAnalyzer.detectArrayMutationInFunction()` - function-level `arr.push()`
3. `JSASTAnalyzer.detectIndexedArrayAssignment()` - `arr[i] = value`

**Edge Creation Phase** (`GraphBuilder.ts`):
```typescript
bufferArrayMutationEdges(arrayMutations, variableDeclarations) {
  // Creates: value FLOWS_INTO array
  this._bufferEdge({
    type: 'FLOWS_INTO',
    src: sourceVar.id,
    dst: arrayVar.id,
    mutationMethod,
    argIndex
  });
}
```

### 1.3 Current Gap

Object property mutations are NOT tracked:
```javascript
const config = {};
config.handler = myFunc;  // No edge created!
```

The graph has no way to know that `myFunc` flows into `config`.

---

## 2. Architecture Alignment

### 2.1 Does This Align with Grafema's Vision?

**Absolutely yes.** This is critical for Grafema's core thesis: "AI should query the graph, not read code."

Without object property mutation tracking:
- AI cannot trace how data flows through configuration objects
- Pattern detection for DI, event handlers, config builders is impossible
- Cross-file data flow analysis breaks when objects are passed around

**Target environment fit:** This is especially important for legacy codebases where:
- Configuration objects are mutated dynamically
- Dependency injection containers are built imperatively
- Event handler registration uses object property assignment

### 2.2 Why FLOWS_INTO is the Right Edge Type

The existing `FLOWS_INTO` semantics are perfect:
- **Source**: The value being added (function, object, primitive)
- **Destination**: The container receiving the value (object, array)
- **Direction**: `value FLOWS_INTO container`

This maintains consistency with array mutations and enables unified querying:
```cypher
// "What data flows into this config object?"
MATCH (value)-[:FLOWS_INTO]->(config {name: 'config'})
RETURN value
```

---

## 3. High-Level Implementation Approach

### 3.1 New Data Type

Create `ObjectMutationInfo` (analogous to `ArrayMutationInfo`):

```typescript
interface ObjectMutationInfo {
  objectName: string;
  propertyName: string;          // 'handler', '<computed>' for obj[x]
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}

interface ObjectMutationValue {
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;           // For VARIABLE
  literalValue?: unknown;       // For LITERAL
  callLine?: number;            // For CALL
  callColumn?: number;
}
```

### 3.2 Detection Points

Following the array mutation pattern:

1. **Module-level property assignment** - in `AssignmentExpression` traverse
2. **Function-level property assignment** - in `analyzeFunctionBody` traverse
3. **Object.assign()** - in `CallExpressionVisitor` (special case)
4. **Spread operator** - during object literal analysis

### 3.3 Edge Creation

In `GraphBuilder.bufferObjectMutationEdges()`:
```typescript
// obj.prop = value  ->  value FLOWS_INTO obj (via prop)
this._bufferEdge({
  type: 'FLOWS_INTO',
  src: valueNodeId,
  dst: objectVar.id,
  mutationType: 'property',
  propertyName: mutation.propertyName
});
```

### 3.4 Metadata Design

The edge should include:
- `mutationType`: How the property was set ('property', 'computed', 'assign', 'spread')
- `propertyName`: The property name (or '<computed>' for `obj[x]`)

This mirrors the array mutation `mutationMethod` and `argIndex` fields.

---

## 4. Scope Definition

### 4.1 In Scope (REG-114)

1. **Direct property assignment**: `obj.prop = value`
2. **Computed property assignment**: `obj['prop'] = value`, `obj[key] = value`
3. **Object.assign()**: `Object.assign(target, source)` - source props FLOW_INTO target
4. **Spread in object literal**: `{ ...obj, prop: value }` - track in existing object literal handling

### 4.2 Out of Scope (Future Work)

- Object method calls that mutate properties (e.g., `obj.setProperty(name, value)`)
- Prototype chain modifications
- Object.defineProperty (complex, rare in legacy code)
- Proxy-based mutations

### 4.3 Limitations to Document

- **Computed property names**: When `obj[key] = value` and `key` is not a literal, we track the flow but `propertyName` is '<computed>'
- **Aliased objects**: `const ref = obj; ref.prop = value;` - tracks flow to `ref`, not original `obj`
- **Nested paths**: `obj.a.b = value` - creates flow to `obj.a`, not to `obj`

---

## 5. Edge Cases and Concerns

### 5.1 Property Assignment to Non-Objects

```javascript
const arr = [];
arr.length = 10;  // This is property assignment, not array mutation
```

Decision: Track as object property mutation. Arrays are objects.

### 5.2 Object.assign with Multiple Sources

```javascript
Object.assign(target, source1, source2, source3);
```

Each source should create a separate FLOWS_INTO edge. Use `argIndex` metadata like array mutations.

### 5.3 Spread Order Matters

```javascript
const merged = { ...defaults, ...overrides };
```

Both `defaults` and `overrides` FLOW_INTO `merged`. Order is captured by edge creation order.

### 5.4 Detecting Object Type

We don't have type information. We track ALL property assignments on identifiers:
```javascript
config.handler = fn;   // Track (config is object)
str.length = 10;       // Track (str might be object)
```

This is intentional - in untyped codebases, we over-approximate rather than under-approximate.

---

## 6. Testing Strategy

### 6.1 Unit Tests (Kent's Domain)

Mirror the `ArrayMutationTracking.test.js` structure:

1. `obj.prop = variable` - creates FLOWS_INTO edge from variable to obj
2. `obj['prop'] = variable` - same as above
3. `obj[computedKey] = variable` - tracks with '<computed>' property
4. `Object.assign(target, source)` - creates FLOWS_INTO from source to target
5. Multiple `Object.assign` arguments - creates multiple edges
6. Spread in object literals - handled by existing literal tracking
7. Function-level property assignments
8. Module-level property assignments
9. Edge metadata verification

### 6.2 Integration Tests

Test real-world patterns:
- DI container configuration
- Event handler registration objects
- Config builders

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Performance regression from additional edge traversal | Low | Medium | Uses existing batching infrastructure |
| False positives (tracking non-objects) | Medium | Low | Acceptable in untyped analysis context |
| Missed patterns (method-based mutation) | High | Medium | Document limitation, create follow-up issue |
| Breaking existing tests | Low | High | TDD approach - tests first |

---

## 8. Implementation Order

1. **Types first**: Add `ObjectMutationInfo` to `types.ts`
2. **Collection plumbing**: Add to `ASTCollections`, `Collections` interfaces
3. **Detection**:
   - Module-level in `AssignmentExpression` traverse
   - Function-level in `analyzeFunctionBody`
   - `Object.assign()` in `CallExpressionVisitor`
4. **Edge creation**: `GraphBuilder.bufferObjectMutationEdges()`
5. **Tests**: Write alongside each step

---

## 9. Decision: This is the Right Thing to Do

This feature:
- Fills a critical gap in data flow tracking
- Follows established patterns (array mutations)
- Aligns with Grafema's vision for legacy codebase analysis
- Has clear scope and well-defined limitations
- Is testable with existing infrastructure

**Recommendation**: Proceed with implementation.

---

## 10. Questions for Joel (Implementation Planner)

1. Should `Object.assign` detection be a method in `CallExpressionVisitor` or a separate visitor?
2. For spread operators, should we enhance existing `extractObjectProperties` or create separate detection?
3. Should we track assignment to `this.prop = value` in constructors/methods?
