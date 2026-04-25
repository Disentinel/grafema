# Joel Spolsky's Technical Plan: REG-262 - Method Calls Don't Create Usage Edges

## Executive Summary

The fix requires creating `USES` edges from METHOD_CALL nodes to the receiver variable nodes. The `MethodCallInfo` interface already has an `object` field that contains the receiver name. We need to:
1. Create USES edges in `GraphBuilder.bufferMethodCalls()`
2. Update `DataFlowValidator.findPathToLeaf()` to recognize incoming USES edges as proof of usage

No interface changes needed - we already have the data.

---

## Step 1: Write Tests First (TDD)

**File to create:** `/test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts`

Test cases to implement:

1. **Basic method call creates USES edge**
   ```javascript
   const date = new Date();
   date.toLocaleDateString();  // Should create METHOD_CALL --USES--> date
   ```
   - Verify USES edge exists from METHOD_CALL to VARIABLE/CONSTANT node
   - Verify edge direction: src=METHOD_CALL.id, dst=variable.id

2. **`this.method()` does NOT create USES edge**
   ```javascript
   class Foo {
     bar() { this.baz(); }  // 'this' is not a variable - no USES edge
   }
   ```

3. **Chained calls: only first receiver gets USES edge**
   ```javascript
   const arr = [1,2,3];
   arr.map(x => x*2).filter(x => x>2);  // Only arr gets USES edge from first call
   ```

4. **Multiple method calls on same object**
   ```javascript
   const str = "hello";
   str.toUpperCase();
   str.toLowerCase();
   // Both METHOD_CALLs should have USES edges to str
   ```

5. **DataFlowValidator should NOT report false positive**
   ```javascript
   const date = new Date(dateString);
   return date.toLocaleDateString('ru-RU');
   // date should pass validation - it's used by method call
   ```

6. **Nested member access receiver**
   ```javascript
   const obj = { nested: { method: () => {} } };
   obj.nested.method();  // Edge should be to 'obj', not 'obj.nested'
   ```

**Test pattern to follow:** `/test/unit/plugins/analysis/ast/object-property-edges.test.ts`

---

## Step 2: Implement USES Edge Creation in GraphBuilder

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Method:** `bufferMethodCalls()` (lines 390-404)

**Change:** Add USES edge creation. Pass variableDeclarations and parameters to the method:

```typescript
private bufferMethodCalls(methodCalls: MethodCallInfo[], variableDeclarations: VariableDeclarationInfo[], parameters: ParameterInfo[]): void {
  for (const methodCall of methodCalls) {
    const { parentScopeId, ...methodData } = methodCall;

    // Buffer METHOD_CALL node
    this._bufferNode(methodData as GraphNode);

    // SCOPE -> CONTAINS -> METHOD_CALL
    this._bufferEdge({
      type: 'CONTAINS',
      src: parentScopeId as string,
      dst: methodData.id
    });

    // REG-262: Create USES edge from METHOD_CALL to receiver variable
    // Skip 'this' - it's not a variable node
    if (methodCall.object && methodCall.object !== 'this') {
      // Handle nested member expressions: obj.nested.method() -> use base 'obj'
      const receiverName = methodCall.object.includes('.')
        ? methodCall.object.split('.')[0]
        : methodCall.object;

      // Find receiver variable in current file
      const receiverVar = variableDeclarations.find(v =>
        v.name === receiverName && v.file === methodCall.file
      );

      if (receiverVar) {
        this._bufferEdge({
          type: 'USES',
          src: methodData.id,
          dst: receiverVar.id
        });
      } else {
        // Check parameters (function arguments)
        const receiverParam = parameters.find(p =>
          p.name === receiverName && p.file === methodCall.file
        );

        if (receiverParam) {
          this._bufferEdge({
            type: 'USES',
            src: methodData.id,
            dst: receiverParam.id
          });
        }
      }
    }
  }
}
```

**Also update the call site in `build()` method (line 207):**

```typescript
// 9. Buffer METHOD_CALL nodes, CONTAINS edges, and USES edges (REG-262)
this.bufferMethodCalls(methodCalls, variableDeclarations, parameters);
```

---

## Step 3: Update DataFlowValidator to Recognize USES Edges

**File:** `/packages/core/src/plugins/validation/DataFlowValidator.ts`

**Method:** `findPathToLeaf()` (lines 200-242)

**Add check for incoming USES edges (insert after adding to chain, before looking for ASSIGNED_FROM):**

```typescript
// REG-262: Check if variable is used by a method call (incoming USES edge)
// If something USES this variable, the variable is not dead
const usedByCall = allEdges.find(e =>
  e.type === 'USES' && e.dst === startNode.id
);
if (usedByCall) {
  const callNode = allNodes.find(n => n.id === usedByCall.src);
  const callName = callNode?.name || usedByCall.src;
  return { found: true, chain: [...chain, `(used by ${callName})`] };
}
```

---

## Step 4: CallExpressionVisitor (No Changes Needed)

The `CallExpressionVisitor` handles method calls at module level. It already populates the `object` field, so the GraphBuilder change will automatically handle these too.

---

## Implementation Order

1. **Kent Beck writes tests first** (Step 1)
   - Create test file with all 6 test cases
   - All tests should FAIL initially

2. **Rob Pike implements GraphBuilder change** (Step 2)
   - Add signature change to `bufferMethodCalls()`
   - Add USES edge creation logic
   - Update call site in `build()` method
   - Run tests - 5/6 should pass

3. **Rob Pike implements DataFlowValidator change** (Step 3)
   - Add USES edge check in `findPathToLeaf()`
   - Run tests - all 6 should pass

4. **Run full test suite**
   - `npm test` to verify no regressions

---

## Edge Cases Handled

| Case | Expected Behavior |
|------|------------------|
| `this.method()` | No USES edge (this is not a variable) |
| `obj.method()` | USES edge: METHOD_CALL -> obj |
| `obj.a.method()` | USES edge to base `obj` only |
| `param.method()` | USES edge to PARAMETER node |
| `import.method()` | No USES edge (import is not a variable) |
| Computed `obj[x]()` | USES edge to `obj` |

---

## Risks and Mitigations

1. **Performance impact**: Creating additional edges for every method call increases graph size
   - Mitigation: These edges are essential for correctness. The overhead is minimal (1 edge per method call)

2. **Edge direction confusion**: USES edge goes METHOD_CALL -> VARIABLE
   - Mitigation: This matches the semantic meaning "this call USES this variable"
   - Consistent with PASSES_ARGUMENT (CALL -> argument)

3. **Missing receiver resolution**: If variable lookup fails, no edge is created
   - Mitigation: This is acceptable - we only create edges we can resolve

---

## Critical Files

1. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 390-404, 207)
2. `/packages/core/src/plugins/validation/DataFlowValidator.ts` (lines 200-242)
3. `/packages/core/src/plugins/analysis/ast/types.ts` (line 101) - Reference only
4. `/test/unit/plugins/analysis/ast/object-property-edges.test.ts` - Pattern to follow
