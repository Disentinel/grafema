# Don Melton's Analysis: REG-262 - Method calls on objects don't create usage edges

## Executive Summary

The bug is straightforward: when `obj.method()` is called, we create a METHOD_CALL node but never create an edge showing that `obj` (the receiver/callee object) is actually **used** by that call. DataFlowValidator only traces `ASSIGNED_FROM` chains and doesn't recognize that being a method call receiver constitutes "usage."

## Root Cause Analysis

**1. Where method calls are analyzed:**

The `handleCallExpression` method in `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 2568-2722) processes method calls. When it encounters `obj.method()`:

- It extracts `objectName` (line 2623): `const objectName = object.type === 'Identifier' ? object.name : 'this';`
- It creates a `MethodCallInfo` and pushes it to `methodCalls` collection (lines 2636-2648)
- But it **never** creates an edge connecting `obj` (the variable) to the METHOD_CALL node

**2. Where edges are created:**

GraphBuilder (`/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`) has `bufferMethodCalls` (lines 390-404) which:
- Creates the METHOD_CALL node
- Creates `SCOPE -> CONTAINS -> METHOD_CALL` edge
- Does **NOT** create any edge connecting the receiver object to the call

**3. What DataFlowValidator checks:**

DataFlowValidator (`/packages/core/src/plugins/validation/DataFlowValidator.ts`) traces `ASSIGNED_FROM` edges (lines 99-101, 222-224) to find paths to "leaf nodes." It considers METHOD_CALL and CALL_SITE as leaf types (line 93-94), but this doesn't help because:
- The validator follows **outgoing** `ASSIGNED_FROM` edges from the variable
- There's no edge FROM the variable TO the METHOD_CALL

## Existing Edge Type

The `USES` edge type already exists in `/packages/types/src/edges.ts` (line 32):
```typescript
USES: 'USES',
```

This is the semantically correct edge type for this use case.

## Recommended Approach

**Option A: Create `methodCall --USES--> obj` edge (Recommended)**

Direction: The METHOD_CALL uses the object.
- Semantically accurate: "this call USES this variable"
- Matches how `PASSES_ARGUMENT` works (call -> argument)
- DataFlowValidator would need to also trace incoming `USES` edges to find usage

**Option B: Create `obj --RECEIVER_OF--> methodCall` edge**

Direction: The object is the receiver of the call.
- Would need a new edge type `RECEIVER_OF`
- More explicit about the relationship
- DataFlowValidator would trace outgoing `RECEIVER_OF` edges

**Recommended: Option A** because:
1. `USES` edge type already exists
2. More general - can track other usage patterns later
3. Simpler - no new edge type needed

## Implementation Plan

**1. Collect receiver info in JSASTAnalyzer.handleCallExpression:**

When processing `obj.method()`, capture the receiver object name in a new collection (e.g., `methodCallReceivers`) or augment existing `MethodCallInfo`:

```typescript
// In MethodCallInfo interface (types.ts line 96-110)
// Add:
receiverName?: string;  // For `obj` in `obj.method()`
```

**2. Create USES edges in GraphBuilder.bufferMethodCalls:**

After creating the METHOD_CALL node, look up the receiver variable and create edge:

```typescript
// In bufferMethodCalls, after creating the node:
if (methodCall.receiverName && methodCall.receiverName !== 'this') {
  // Find the variable node for the receiver
  const receiverVar = variableDeclarations.find(v =>
    v.name === methodCall.receiverName && v.file === methodCall.file
  );
  if (receiverVar) {
    this._bufferEdge({
      type: 'USES',
      src: methodCall.id,  // METHOD_CALL uses the variable
      dst: receiverVar.id
    });
  }
}
```

**3. Update DataFlowValidator to recognize USES:**

Either:
- Add `USES` to the traversal (trace incoming USES edges)
- Or simply add METHOD_CALL to leaf types (already done, line 93) and trust that having a USES edge proves the variable is used

The simpler fix for DataFlowValidator: check for incoming `USES` edges as proof of usage:

```typescript
// In findPathToLeaf or separate check:
// If variable has incoming USES edges, it's used (not dead)
const usedByCall = allEdges.find(e =>
  e.type === 'USES' && e.dst === variable.id
);
if (usedByCall) {
  return { found: true, chain: [...chain, '(used by call)'] };
}
```

## Scope & Impact

**Files to modify:**
1. `/packages/core/src/plugins/analysis/ast/types.ts` - Add `receiverName` to `MethodCallInfo`
2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Capture receiver name
3. `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` - Capture receiver name (module-level calls)
4. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Create USES edges
5. `/packages/core/src/plugins/validation/DataFlowValidator.ts` - Recognize usage via USES edges

**Test file to create:**
`/test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts`

**Edge cases to consider:**
- `this.method()` - Should NOT create USES edge (no variable to reference)
- Chained calls: `a.b().c()` - Should create USES for `a`
- Nested member expressions: `a.b.method()` - Should create USES for `a` (the base)
- Computed property: `obj[x]()` - Should still create USES for `obj`

## Concerns

1. **Performance:** Creating additional edges for every method call will increase graph size. However, this is necessary for correctness.

2. **Bi-directional edges:** We'll have METHOD_CALL -> USES -> VARIABLE. DataFlowValidator currently traces variable -> ... but here we need to check if anything USES the variable. This requires a minor change to validation logic.

3. **Consistency:** The `PASSES_ARGUMENT` edge goes from CALL -> argument, so `USES` from CALL -> receiver is consistent.

## Critical Files for Implementation

1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 2568-2722) - Core method call handling, needs to capture receiver
2. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 390-404) - Edge creation for method calls
3. `/packages/core/src/plugins/analysis/ast/types.ts` (lines 96-110) - MethodCallInfo interface
4. `/packages/core/src/plugins/validation/DataFlowValidator.ts` (lines 97-158) - Usage validation logic
5. `/test/unit/plugins/analysis/ast/object-property-edges.test.ts` - Pattern to follow for tests
