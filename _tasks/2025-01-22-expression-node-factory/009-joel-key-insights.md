# REG-107: Key Architectural Insights

**Date:** 2025-01-22
**Author:** Joel Spolsky (Implementation Planner)

---

## TL;DR

GraphBuilder is NOT reconstruction code. It's the PRIMARY EXPRESSION node factory for 90%+ of cases. The migration needs TWO new factory methods:

1. `ExpressionNode.generateId()` - for JSASTAnalyzer to generate IDs
2. `ExpressionNode.createFromMetadata()` - for GraphBuilder to create nodes with upstream IDs

---

## The Critical Mistake in Original Plan

**Original assumption:**
> GraphBuilder "reconstructs" nodes that were already created by visitors

**Reality:**
> GraphBuilder CREATES the majority of EXPRESSION nodes for the first time

**Evidence:**
- JSASTAnalyzer pushes to `variableAssignments[]`, NOT `literals[]`
- Visitors only push to `literals[]` for special cases (destructuring, call args)
- GraphBuilder reads `variableAssignments[]` and creates nodes at line 815-860

---

## Two Creation Paths (The Architecture)

### Path A: Visitor Creates Node (MINORITY - ~10%)

```javascript
// Use case: Destructuring, call arguments
const { x } = obj;  // VariableVisitor creates EXPRESSION
foo(a + b);         // CallExpressionVisitor creates EXPRESSION

// Flow:
Visitor
  → creates full node via factory
  → pushes to literals[]
  → GraphBuilder.bufferLiterals()
  → _bufferNode()
```

**Who decides to create:** Visitor (during AST traversal)
**When created:** During visitor phase
**Where stored:** literals[] array

### Path B: GraphBuilder Creates Node (MAJORITY - ~90%)

```javascript
// Use case: Normal assignments with expressions
const m = obj.method;           // MemberExpression
const sum = a + b;              // BinaryExpression
const val = flag ? x : y;       // ConditionalExpression

// Flow:
JSASTAnalyzer.trackVariableAssignment()
  → generates ID via ExpressionNode.generateId()
  → pushes metadata to variableAssignments[]
  → GraphBuilder.bufferAssignmentEdges()
  → creates node via ExpressionNode.createFromMetadata()
  → _bufferNode()
```

**Who decides to create:** JSASTAnalyzer (during assignment tracking)
**When created:** During GraphBuilder phase (deferred)
**Where stored:** variableAssignments[] array (metadata only)

---

## Why This Architecture?

### Separation of Concerns

**JSASTAnalyzer (AST Analysis):**
- Responsibility: Understand assignment semantics
- Output: Metadata about what needs to be created
- Limitation: No graph access yet

**GraphBuilder (Graph Construction):**
- Responsibility: Create nodes and edges
- Input: Collections of metadata
- Capability: Has graph context, can create nodes

**Visitors (Special Cases):**
- Responsibility: Handle complex AST patterns
- When to use: Pattern matching requires AST context (destructuring)
- Output: Fully-formed nodes

### Why Deferred Creation?

**JSASTAnalyzer can't create nodes because:**
1. It's analyzing AST structure, not building graph
2. Node creation happens in batch (GraphBuilder phase)
3. ID must be known upfront for edge references

**Solution:**
- JSASTAnalyzer generates ID using factory (`generateId()`)
- Stores ID + metadata in `variableAssignments[]`
- GraphBuilder creates node using metadata (`createFromMetadata()`)

---

## The ID Flow (Critical Understanding)

```
┌──────────────────────────────────────────────────────────┐
│ PHASE 1: AST Analysis (JSASTAnalyzer)                   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  const m = obj.method;                                   │
│       ↓                                                  │
│  trackVariableAssignment()                               │
│       ↓                                                  │
│  ExpressionNode.generateId(                              │
│    'MemberExpression',                                   │
│    '/src/app.ts',                                        │
│    42,                                                   │
│    15                                                    │
│  )                                                       │
│       ↓                                                  │
│  ID = "/src/app.ts:EXPRESSION:MemberExpression:42:15"    │
│       ↓                                                  │
│  variableAssignments.push({                              │
│    sourceId: ID,              ← Store for later         │
│    sourceType: 'EXPRESSION',                             │
│    expressionType: 'MemberExpression',                   │
│    object: 'obj',                                        │
│    property: 'method',                                   │
│    ...                                                   │
│  })                                                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ PHASE 2: Graph Construction (GraphBuilder)              │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  bufferAssignmentEdges(variableAssignments)              │
│       ↓                                                  │
│  for each assignment where sourceType === 'EXPRESSION':  │
│       ↓                                                  │
│  ExpressionNode.createFromMetadata(                      │
│    'MemberExpression',                                   │
│    '/src/app.ts',                                        │
│    42,                                                   │
│    15,                                                   │
│    {                                                     │
│      id: assignment.sourceId,  ← Use stored ID          │
│      object: 'obj',                                      │
│      property: 'method',                                 │
│      ...                                                 │
│    }                                                     │
│  )                                                       │
│       ↓                                                  │
│  Node created with ID from Phase 1                       │
│       ↓                                                  │
│  _bufferNode(expressionNode)                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Key insight:** ID is generated ONCE (Phase 1) and used consistently (Phase 2).

---

## Why Two Factory Methods?

### Why Not Just `create()`?

**Problem:** Different data availability

**Visitor (immediate creation):**
```typescript
// Has: full AST context, can compute everything
ExpressionNode.create('MemberExpression', file, line, col, {
  object: 'obj',
  property: 'method',
  computed: false,
  baseName: 'obj',
  propertyPath: ['method']
  // ... all fields available
});
// ID is auto-generated
```

**GraphBuilder (deferred creation):**
```typescript
// Has: metadata from assignment, ID from upstream
ExpressionNode.createFromMetadata('MemberExpression', file, line, col, {
  id: assignment.sourceId,  // ← MUST use this ID
  object: 'obj',
  property: 'method',
  // ... partial fields from metadata
});
// ID is provided, must match
```

### The Key Difference

| Method | Who calls | ID source | Use case |
|--------|-----------|-----------|----------|
| `create()` | Visitors | Auto-generated by factory | Immediate creation with full context |
| `createFromMetadata()` | GraphBuilder | Provided from upstream | Deferred creation with pre-generated ID |
| `generateId()` | JSASTAnalyzer | Generated, returned as string | ID needed before node creation |

---

## Why This Wasn't Obvious

### The Misleading Clues

1. **Name similarity:** "bufferAssignmentEdges" sounds like it creates edges, not nodes
2. **Code location:** Node creation buried inside edge processing loop
3. **Conditional logic:** `if (sourceType === 'EXPRESSION')` looks like special case
4. **Manual construction:** Inline object creation looks like temporary/reconstruction

### The Revealing Evidence

1. **JSASTAnalyzer never pushes to literals:**
   ```typescript
   // Line 609-621: Only pushes to variableAssignments
   variableAssignments.push({
     sourceType: 'EXPRESSION',
     sourceId: expressionId,
     // ... metadata
   });
   // NO literals.push() here!
   ```

2. **GraphBuilder calls `_bufferNode()`:**
   ```typescript
   // Line 857: This is primary node creation
   this._bufferNode(expressionNode);
   // Not reconstruction, CREATION
   ```

3. **Test coverage validates this code:**
   - Expression.test.js would fail if this code is removed
   - Tests expect EXPRESSION nodes for normal assignments
   - Only Path B creates these nodes

---

## Migration Implications

### What Changes

**Before:**
```typescript
// JSASTAnalyzer (manual ID)
const expressionId = `EXPRESSION#${path}#${file}#${line}:${col}`;

// GraphBuilder (manual construction)
const expressionNode: GraphNode = {
  id: sourceId,
  type: 'EXPRESSION',
  expressionType,
  // ... manual field population
};
```

**After:**
```typescript
// JSASTAnalyzer (factory ID)
const expressionId = ExpressionNode.generateId(
  'MemberExpression',
  module.file,
  line,
  initExpression.start
);

// GraphBuilder (factory creation)
const expressionNode = ExpressionNode.createFromMetadata(
  expressionType,
  exprFile,
  exprLine,
  exprColumn || 0,
  {
    id: sourceId,  // From upstream
    object,
    property,
    computed,
    operator
  }
);
```

### What Stays the Same

**Edge creation (lines 859-930):**
- ASSIGNED_FROM edge: variable → expression
- DERIVES_FROM edges: expression → source variables
- NO CHANGES to edge logic

**Execution order:**
```typescript
// GraphBuilder.build() (line 205-209)
this.bufferLiterals(literals);           // Step 18: Path A
this.bufferAssignmentEdges(assignments); // Step 19: Path B
// Order preserved
```

**Two-path architecture:**
- Visitors create some EXPRESSION nodes (Path A)
- GraphBuilder creates other EXPRESSION nodes (Path B)
- Both paths valid, serve different purposes

---

## Testing Strategy

### Test 1: Verify Path A (Visitor Creation)

```javascript
// Destructuring
const { x } = obj;

// Expect: VariableVisitor creates EXPRESSION
// Location: literals[] array
// ID: Generated by NodeFactory.createExpression()
```

### Test 2: Verify Path B (GraphBuilder Creation)

```javascript
// Normal assignment
const m = obj.method;

// Expect: JSASTAnalyzer generates ID
// Metadata: variableAssignments[] array
// Creation: GraphBuilder.bufferAssignmentEdges()
// ID: From ExpressionNode.generateId()
```

### Test 3: Verify ID Consistency

```javascript
// Assignment creates expression
const val = obj.x;

// Check:
// 1. EXPRESSION node exists with colon-based ID
// 2. ASSIGNED_FROM edge.dst === EXPRESSION.id
// 3. DERIVES_FROM edge.src === EXPRESSION.id
```

### Test 4: Verify Edge Resolution

```javascript
// Expression with source variables
const sum = a + b;

// Check:
// 1. EXPRESSION node for BinaryExpression
// 2. DERIVES_FROM edges: sum → a, sum → b
// 3. All IDs use colon format
```

---

## Common Pitfalls (For Implementation)

### Pitfall 1: Changing GraphBuilder ID

```typescript
// WRONG: Generate new ID in GraphBuilder
const expressionNode = ExpressionNode.create(/* ... */);
// This creates DIFFERENT ID than JSASTAnalyzer
// Edge references break!
```

**Correct:**
```typescript
// Use ID from upstream
const expressionNode = ExpressionNode.createFromMetadata(
  /* ... */,
  { id: assignment.sourceId }  // ← Pre-generated ID
);
```

### Pitfall 2: Migrating GraphBuilder Before JSASTAnalyzer

```typescript
// JSASTAnalyzer still generates:
const expressionId = `EXPRESSION#...`;  // Legacy format

// GraphBuilder validates:
if (!sourceId.includes(':EXPRESSION:')) {
  throw new Error('Invalid format');  // ← FAILS!
}
```

**Correct order:** JSASTAnalyzer first, then GraphBuilder

### Pitfall 3: Removing Edge Creation Code

```typescript
// Lines 859-930 create edges
// DO NOT REMOVE THIS CODE
// It's separate from node creation
this._bufferEdge({
  type: 'ASSIGNED_FROM',
  src: variableId,
  dst: sourceId
});
```

### Pitfall 4: Forgetting Column Field

```typescript
// JSASTAnalyzer must add column to metadata
variableAssignments.push({
  // ... existing fields ...
  line: line,
  column: initExpression.start  // ← ADD THIS
});
```

---

## Architecture Quality Assessment

### Strengths

1. **Separation of concerns:** Analysis vs. construction
2. **Flexibility:** Immediate or deferred creation
3. **Consistency:** Factory controls all ID generation
4. **Testability:** Clear boundaries, mockable

### Weaknesses

1. **Complexity:** Two paths for same node type
2. **Implicit rules:** No clear guidance on which path to use
3. **Code location:** Node creation inside edge processing
4. **Documentation:** Architecture not documented

### Post-Migration Improvements

**Add documentation:**
```typescript
/**
 * EXPRESSION node creation happens in TWO paths:
 *
 * Path A (Visitor): Immediate creation with full AST context
 *   - Destructuring: VariableVisitor
 *   - Call arguments: CallExpressionVisitor
 *   - Uses: NodeFactory.createExpression()
 *   - Storage: literals[] array
 *
 * Path B (GraphBuilder): Deferred creation from metadata
 *   - Normal assignments: JSASTAnalyzer → GraphBuilder
 *   - ID generation: ExpressionNode.generateId()
 *   - Node creation: ExpressionNode.createFromMetadata()
 *   - Storage: variableAssignments[] array
 *
 * This code implements Path B (PRIMARY EXPRESSION factory).
 */
```

---

## Conclusion

The original plan missed that GraphBuilder is a PRIMARY factory, not a fallback. This changes the migration approach:

**NOT:** "Validate that visitors created nodes correctly"
**BUT:** "Create nodes from JSASTAnalyzer metadata using factory"

**Key requirements:**
1. JSASTAnalyzer must generate IDs via factory
2. GraphBuilder must create nodes via factory
3. ID must be consistent between generation and usage
4. Edge references must use the same IDs

**This is the RIGHT architecture** - we're just making it explicit and factory-based.
