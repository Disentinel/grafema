# Rob Pike's Implementation Report: REG-262 - Create USES edges from METHOD_CALL to receiver variable

## Summary

Implemented USES edge creation from METHOD_CALL nodes to receiver variable nodes. This fixes false positives in DataFlowValidator where variables used only via method calls were incorrectly reported as unused.

## Changes Made

### 1. GraphBuilder.bufferMethodCalls() - `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Lines 390-443**

Modified the method signature to accept `variableDeclarations` and `parameters` arrays:

```typescript
private bufferMethodCalls(
  methodCalls: MethodCallInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void
```

Added USES edge creation logic after the CONTAINS edge:

- Skip if `methodCall.object` is 'this' or falsy (this is not a variable node)
- Extract base name from nested access (e.g., `obj.nested.method()` -> `obj`)
- Look up receiver in `variableDeclarations` first, then `parameters`
- Create USES edge: `METHOD_CALL.id` -> `receiver.id`

### 2. Call site update - Line 207

Updated the call to pass the required collections:

```typescript
// 9. Buffer METHOD_CALL nodes, CONTAINS edges, and USES edges (REG-262)
this.bufferMethodCalls(methodCalls, variableDeclarations, parameters);
```

### 3. DataFlowValidator.findPathToLeaf() - `/packages/core/src/plugins/validation/DataFlowValidator.ts`

**Lines 221-230**

Added check for incoming USES edges before looking for ASSIGNED_FROM edges:

```typescript
// REG-262: Check if variable is used by a method call (incoming USES edge)
// If something USES this variable, the variable is not dead
const usedByCall = allEdges.find(e =>
  e.type === 'USES' && e.dst === startNode.id
);
if (usedByCall) {
  const callNode = allNodes.find(n => n.id === usedByCall.src);
  const callName = callNode?.name ?? usedByCall.src;
  return { found: true, chain: [...chain, `(used by ${callName})`] };
}
```

## Test Results

All 5 tests pass:

1. **Basic method call creates USES edge** - `date.toLocaleDateString()` creates USES edge to `date`
2. **Edge direction is correct** - METHOD_CALL -> variable (not reverse)
3. **this.method() does NOT create USES edge** - `this` is not a variable node
4. **Multiple method calls on same object** - Both `str.toUpperCase()` and `str.toLowerCase()` create USES edges to `str`
5. **Parameter as receiver** - `obj.method()` inside function creates USES edge to PARAMETER `obj`
6. **Nested member access** - `obj.nested.method()` creates USES edge to base variable `obj`

## Edge Cases Handled

| Case | Behavior |
|------|----------|
| `this.method()` | No USES edge created |
| `obj.method()` | USES edge: METHOD_CALL -> obj |
| `obj.a.b.method()` | USES edge to base `obj` only |
| `param.method()` | USES edge to PARAMETER node |
| `console.log()` | No USES edge (console is not a local variable) |

## Implementation Notes

1. The implementation matches the existing pattern used in other buffer methods
2. No new node types or edge types were introduced - USES is already in the schema
3. Performance impact is minimal - one additional edge per method call with a non-this receiver
4. File path matching uses full paths consistently (same as variable declarations)
