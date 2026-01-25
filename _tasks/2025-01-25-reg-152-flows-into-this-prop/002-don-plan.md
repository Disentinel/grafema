# REG-152: FLOWS_INTO Edges for `this.prop = value` - Technical Analysis

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-25

## Executive Summary

This is the MISSING PIECE from REG-134. We created PARAMETER nodes for class methods, but they're useless without FLOWS_INTO edges. This feature completes the data flow picture for class-based code.

**Recommended approach:** Option 3 - Use CLASS node as target with property metadata on the edge.

This is the RIGHT solution because it:
1. Requires minimal architectural changes
2. Maintains consistency with existing object mutation patterns
3. Enables meaningful queries immediately
4. Aligns with Grafema's vision: "AI should query the graph, not read code"

---

## 1. Current State Analysis

### 1.1 The Problem

In `GraphBuilder.bufferObjectMutationEdges()` (lines 1341-1393), there's explicit logic that skips `this` mutations:

```typescript
// Skip 'this' - it's not a variable node, but we still create edges FROM source values
let objectNodeId: string | null = null;
if (objectName !== 'this') {
  const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
  const objectParam = !objectVar ? parameters.find(p => p.name === objectName && p.file === file) : null;
  objectNodeId = objectVar?.id ?? objectParam?.id ?? null;
  if (!objectNodeId) continue;  // SKIP edge creation entirely
}
```

When `objectName === 'this'`, the code:
1. Sets `objectNodeId` to `null`
2. Later checks `if (objectNodeId)` before creating edges
3. Result: **No edge is created**

### 1.2 What We Have After REG-134

```javascript
class Config {
  constructor(handler) {
    this.handler = handler;
  }
}
```

Graph nodes created:
- `CLASS:Config` - the class declaration
- `FUNCTION:constructor` - the constructor method (with CONTAINS edge from CLASS)
- `PARAMETER:handler` - the handler parameter (with HAS_PARAMETER edge from FUNCTION)

Missing:
- `FLOWS_INTO` edge from `handler` parameter to... what?

### 1.3 Existing Object Mutation Edge Structure

For `obj.prop = value`, we create:

```
value -[FLOWS_INTO {mutationType: 'property', propertyName: 'prop'}]-> obj
```

Edge metadata:
- `mutationType`: 'property' | 'computed' | 'assign'
- `propertyName`: string (or '<computed>' for `obj[key] = value`)
- `computedPropertyVar`: optional string (for enrichment phase)

---

## 2. Solution Options Analysis

### Option 1: Create PROPERTY Nodes

**Concept:** Create explicit `PROPERTY` nodes for class instance properties.

```
PARAMETER:handler -[FLOWS_INTO {mutationType: 'property'}]-> PROPERTY:this.handler
CLASS:Config -[HAS_PROPERTY]-> PROPERTY:this.handler
```

**Pros:**
- Most semantically accurate representation
- Properties become first-class citizens in the graph
- Can attach metadata to properties (type annotations, decorators)
- Enables queries like "what properties does this class have?"

**Cons:**
- Requires new node type (PROPERTY)
- Requires detecting class property access patterns
- Complex: must track property declarations, assignments, and usages
- JavaScript classes don't have explicit property declarations (until class fields)
- Discovery problem: `this.handler = handler` declares AND assigns
- Large architectural change across multiple components:
  - New node type in `packages/types/src/nodes.ts`
  - New visitor or ClassVisitor enhancement
  - Updates to GraphBuilder
  - Test infrastructure updates

**Alignment with Vision:**
PROPERTY nodes would be the "ideal" solution in a typed language. But Grafema targets untyped legacy codebases where properties are dynamically added. Creating PROPERTY nodes for every `this.x = y` pattern would:
- Require tracking all property assignments (difficult in dynamic code)
- Create many nodes for dynamically added properties
- Miss properties added via `Object.assign(this, options)`

**Verdict:** Over-engineered for current needs. File as future enhancement (REG-XXX) for TypeScript class fields.

---

### Option 2: Change FLOWS_INTO Semantics (Property-Level Targets)

**Concept:** Allow FLOWS_INTO edges to have a "virtual" target - store property path instead of requiring a destination node.

```
PARAMETER:handler -[FLOWS_INTO {
  targetType: 'this_property',
  propertyName: 'handler',
  className: 'Config'
}]-> (no node, metadata only)
```

**Pros:**
- No new node types needed
- Explicit metadata about what property received the value

**Cons:**
- **Breaks FLOWS_INTO semantics** - edges require src AND dst nodes
- Graph integrity violation - dangling edges
- Query complexity - can't traverse to destination
- Every query would need special handling for `this` property edges
- Backend validation would fail (edges need valid dst)
- Inconsistent with all other edge types

**Alignment with Vision:**
This fundamentally breaks the graph model. Grafema's power comes from traversable edges. An edge without a destination is not an edge.

**Verdict:** Rejected. Violates graph fundamentals.

---

### Option 3: Use CLASS Node as Target (RECOMMENDED)

**Concept:** Use the containing CLASS node as the FLOWS_INTO destination, with property metadata on the edge.

```
PARAMETER:handler -[FLOWS_INTO {
  mutationType: 'this_property',
  propertyName: 'handler'
}]-> CLASS:Config
```

**Pros:**
- Minimal changes - reuses existing CLASS nodes
- Maintains edge integrity - valid src and dst
- Enables meaningful queries:
  ```cypher
  // "What parameters flow into this class?"
  MATCH (p:PARAMETER)-[:FLOWS_INTO]->(c:CLASS)
  RETURN p.name, c.name

  // "What properties does this class receive from constructor?"
  MATCH (p:PARAMETER)-[f:FLOWS_INTO {mutationType: 'this_property'}]->(c:CLASS {name: 'Config'})
  RETURN f.propertyName, p.name
  ```
- Consistent with existing object mutation pattern (value -> container)
- Simple implementation - just need to resolve CLASS node instead of skipping

**Cons:**
- Semantically imprecise - CLASS node isn't exactly "this"
- Multiple properties flow to same CLASS node (but differentiated by edge metadata)
- Can't easily query "all values assigned to this.handler" without filtering edges

**Alignment with Vision:**
This is the pragmatic solution that enables AI to query data flow without reading code. The query `MATCH (p:PARAMETER)-[:FLOWS_INTO]->(c:CLASS)` tells the AI "these parameters become instance state" which is exactly what we need.

**Verdict:** RECOMMENDED. Minimum viable solution that delivers value.

---

### Option 3b: Use METHOD/FUNCTION Node as Target (Alternative)

**Concept:** Use the method/constructor node as target instead of CLASS.

```
PARAMETER:handler -[FLOWS_INTO {
  mutationType: 'this_property',
  propertyName: 'handler'
}]-> FUNCTION:constructor
```

**Pros:**
- Even more localized - edge stays within function scope
- Can easily query "what does this method mutate on this?"

**Cons:**
- Semantically wrong - the value flows to the instance, not the method
- Confusing graph structure - method receiving data from its own parameter?
- Harder queries for "what state does this class have?"

**Verdict:** Rejected. Semantically incorrect.

---

## 3. Recommended Approach: Option 3

### 3.1 Core Changes

**GraphBuilder.bufferObjectMutationEdges() modification:**

Instead of:
```typescript
if (objectName !== 'this') {
  // ... find variable/parameter
  if (!objectNodeId) continue;
}
// ... edge creation only if objectNodeId exists
```

Change to:
```typescript
if (objectName !== 'this') {
  // ... existing logic for variables/parameters
} else {
  // Find containing CLASS node for 'this' mutations
  objectNodeId = this.findContainingClass(mutation, classDeclarations);
}
if (!objectNodeId) continue;
// ... edge creation with appropriate mutationType
```

**New helper or inline logic:**

```typescript
// Find the CLASS node that contains the method where 'this.prop = value' occurs
private findContainingClass(
  mutation: ObjectMutationInfo,
  classDeclarations: ClassDeclarationInfo[]
): string | null {
  // Option A: mutation carries enclosingClassName from AST analysis
  // Option B: lookup by file + method scope from mutation.scopeId
}
```

### 3.2 Data Flow Changes

**JSASTAnalyzer/ObjectMutationCollector changes:**

Need to capture `enclosingClassName` when collecting `this.prop = value` mutations:
- When inside a class method/constructor, record the class name
- Pass this through ObjectMutationInfo

**New/modified field in ObjectMutationInfo:**

```typescript
interface ObjectMutationInfo {
  // ... existing fields
  objectName: string;           // 'this' for instance properties
  propertyName: string;
  enclosingClassName?: string;  // NEW: Set when objectName === 'this'
  enclosingMethodId?: string;   // NEW: For scope tracking
}
```

### 3.3 Edge Metadata

For `this.prop = value` patterns:

```typescript
{
  type: 'FLOWS_INTO',
  src: sourceNodeId,          // PARAMETER or VARIABLE
  dst: classNodeId,           // CLASS node
  mutationType: 'this_property',  // NEW value (distinct from 'property', 'computed', 'assign')
  propertyName: 'handler'
}
```

The new `mutationType: 'this_property'` distinguishes from regular object property mutations.

### 3.4 Test Changes

Unskip and update tests in `ObjectMutationTracking.test.js`:

**Test 1: Constructor pattern**
```javascript
it('should track this.prop = value in constructor with objectName "this"', async () => {
  // ... setup code unchanged ...

  // Find the CLASS node instead of looking for 'this' variable
  const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
  assert.ok(classNode, 'CLASS "Config" not found');

  // Find FLOWS_INTO edge from handler PARAMETER to CLASS
  const flowsInto = allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.src === handlerParam.id &&
    e.dst === classNode.id &&
    e.mutationType === 'this_property' &&
    e.propertyName === 'handler'
  );
  assert.ok(flowsInto, 'Expected FLOWS_INTO edge from handler to Config class');
});
```

**Test 2: Method pattern**
```javascript
it('should track this.prop = value in class methods', async () => {
  // ... similar structure, verify FLOWS_INTO from method param to CLASS
});
```

---

## 4. Implementation Steps (High-Level)

### Phase 1: Data Collection Enhancement
1. Add `enclosingClassName` field to `ObjectMutationInfo` type
2. Update `JSASTAnalyzer` to capture class context when processing `this.prop` assignments
3. Ensure class method analysis passes class name to mutation collector

### Phase 2: Edge Creation
1. Modify `GraphBuilder.bufferObjectMutationEdges()`:
   - Add branch for `objectName === 'this'`
   - Resolve CLASS node ID from `enclosingClassName`
   - Create FLOWS_INTO edge with `mutationType: 'this_property'`
2. Add `'this_property'` to mutation type documentation

### Phase 3: Testing
1. Unskip the two tests in `ObjectMutationTracking.test.js`
2. Update test assertions to expect CLASS node as destination
3. Add edge case tests:
   - Nested class declarations
   - Arrow functions in methods (no `this` binding)
   - Static method mutations (should NOT create edges - `this` refers to class constructor)

### Phase 4: Validation
1. Run full test suite
2. Test on real-world codebase with class patterns
3. Verify queries work as expected

---

## 5. Risks and Considerations

### 5.1 Static Methods

```javascript
class Counter {
  static count = 0;
  static increment(value) {
    this.count = value;  // 'this' refers to class constructor, not instance
  }
}
```

**Decision:** For now, skip static method `this` mutations. They mutate class-level state, not instance state. Document as limitation. Future enhancement can add `mutationType: 'static_property'`.

### 5.2 Arrow Functions in Methods

```javascript
class Service {
  process() {
    const handler = (x) => {
      this.data = x;  // 'this' from lexical scope
    };
  }
}
```

**Decision:** Track these. The arrow function captures `this` from enclosing method. The value still flows into the class instance.

### 5.3 Inherited Classes

```javascript
class Child extends Parent {
  constructor(value) {
    super();
    this.value = value;  // Sets property on Child instance
  }
}
```

**Decision:** Create edge to Child CLASS node. The property belongs to the instance being created (Child), not Parent.

### 5.4 Multiple Classes in Same File

```javascript
class A {
  constructor(x) { this.x = x; }
}
class B {
  constructor(y) { this.y = y; }
}
```

**Decision:** Must correctly associate mutations with their containing class. The AST analysis phase must track which class scope we're in.

### 5.5 Query Pattern Documentation

Document the new query patterns for users/AI:

```cypher
// Find all data that flows into class instances
MATCH (value)-[:FLOWS_INTO {mutationType: 'this_property'}]->(class:CLASS)
RETURN class.name, value

// Find what properties a class receives
MATCH ()-[f:FLOWS_INTO {mutationType: 'this_property'}]->(class:CLASS {name: 'Config'})
RETURN DISTINCT f.propertyName

// Trace parameter to instance property
MATCH (p:PARAMETER)-[:FLOWS_INTO {propertyName: 'handler'}]->(c:CLASS)
WHERE p.name = 'handler'
RETURN p, c
```

---

## 6. Architectural Alignment Check

### Does this align with Grafema's vision?

**"AI should query the graph, not read code"**

Before this change:
```cypher
MATCH (p:PARAMETER {name: 'handler'})-[:FLOWS_INTO]->(target)
RETURN target
// Returns: NOTHING
```

AI must read code to understand that `handler` flows into `this.handler`.

After this change:
```cypher
MATCH (p:PARAMETER {name: 'handler'})-[:FLOWS_INTO]->(target)
RETURN target
// Returns: CLASS:Config with edge metadata {propertyName: 'handler'}
```

AI can query to understand data flow without reading code.

**"Target environment: Massive legacy codebases"**

Class-based patterns are extremely common in legacy JavaScript:
- ES6 classes
- Prototype-based "classes" (not addressed here, future work)
- Framework code (React components, Angular services)

This feature enables analysis of real-world class patterns.

---

## 7. Summary

| Aspect | Decision |
|--------|----------|
| Solution | Option 3: CLASS node as target |
| New node types | None |
| New edge types | None (reuses FLOWS_INTO) |
| New metadata | `mutationType: 'this_property'` |
| Data collection changes | Add `enclosingClassName` to ObjectMutationInfo |
| GraphBuilder changes | Handle `objectName === 'this'` branch |
| Test changes | Unskip 2 tests, update assertions |
| Out of scope | Static methods, prototype mutations |

---

## 8. Questions for Joel

1. **AST scope tracking:** How do we currently track which class we're inside during method analysis? Need to verify we can access class name when collecting `this.prop` mutations.

2. **Semantic ID resolution:** What's the best way to compute CLASS node ID from class name? Direct lookup, or should ObjectMutationInfo carry the full class ID?

3. **Arrow function edge cases:** Should we add specific tests for arrow functions inside methods that reference `this`?

---

## 9. Conclusion

**This is the right solution.**

It's not the most semantically pure (PROPERTY nodes would be), but it's:
- Pragmatic - delivers value with minimal changes
- Consistent - follows existing patterns
- Queryable - enables the AI use case
- Incremental - doesn't close doors on future enhancements

REG-152 completes what REG-134 started. Let's finish the job.
