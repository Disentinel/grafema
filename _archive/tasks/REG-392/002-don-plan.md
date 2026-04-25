# Don Melton - Technical Plan: REG-392

## Context

Currently `bufferArrayMutationEdges` in GraphBuilder only creates FLOWS_INTO edges for `VARIABLE` type values in indexed array assignments (`arr[0] = value`). The infrastructure exists to handle non-variable types (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL) but two pieces are missing:

1. **JSASTAnalyzer** (`detectIndexedArrayAssignment`) detects value types but doesn't create the value nodes or populate `valueNodeId`
2. **GraphBuilder** (`bufferArrayMutationEdges`) only handles VARIABLE type, skipping all others

## The Right Architecture

This is CORRECT design. Here's why:

### Pattern Consistency

**Push/unshift mutations** follow this pattern:
1. `CallExpressionVisitor.detectArrayMutation` - identifies mutation, classifies value types, does NOT create nodes
2. `CallExpressionVisitor.extractArguments` - creates LITERAL/OBJECT_LITERAL/ARRAY_LITERAL nodes, sets IDs on collection
3. `GraphBuilder.bufferArrayMutationEdges` - uses `valueNodeId` to create edges

**Indexed assignments** should match:
1. `JSASTAnalyzer.detectIndexedArrayAssignment` - identifies mutation, classifies value types, does NOT create nodes
2. **NEW:** Create value nodes inline (similar to `extractArguments`)
3. `GraphBuilder.bufferArrayMutationEdges` - handle non-VARIABLE types (already partially exists)

### Why Not in Visitors?

Indexed assignments are detected in **JSASTAnalyzer** (not a visitor), because:
- They're `AssignmentExpression` nodes, not `CallExpression`
- Assignment detection happens during function body analysis
- Creating a separate visitor would add complexity

The pattern: whoever detects the mutation creates the value nodes.

## Required Changes

### 1. JSASTAnalyzer: Create Value Nodes

In `detectIndexedArrayAssignment` (line 5277), after determining `valueType`:

```javascript
// Current code determines valueType (lines 5306-5322)
// ADD: Create value nodes for non-VARIABLE types

if (argInfo.valueType === 'LITERAL' && argInfo.literalValue !== undefined) {
  // Create LITERAL node
  const literalId = `LITERAL#indexed#${module.file}#${line}:${column}:${literalCounterRef.value++}`;
  literals.push({
    id: literalId,
    type: 'LITERAL',
    value: argInfo.literalValue,
    valueType: typeof argInfo.literalValue,
    file: module.file,
    line: line,
    column: column,
    parentCallId: undefined,  // No parent call for indexed assignments
    argIndex: 0
  });
  argInfo.valueNodeId = literalId;
}
else if (argInfo.valueType === 'OBJECT_LITERAL') {
  // Create OBJECT_LITERAL node using factory
  const objectNode = ObjectLiteralNode.create(...);
  objectLiterals.push(objectNode);
  argInfo.valueNodeId = objectNode.id;
  // Extract properties recursively
}
else if (argInfo.valueType === 'ARRAY_LITERAL') {
  // Create ARRAY_LITERAL node using factory
  const arrayNode = ArrayLiteralNode.create(...);
  arrayLiterals.push(arrayNode);
  argInfo.valueNodeId = arrayNode.id;
  // Extract elements recursively
}
// CALL already has callLine/callColumn set (line 5319-5321)
```

**Collections needed:**
- `literals` - already passed
- `literalCounterRef` - already exists
- `objectLiterals` - add parameter
- `objectLiteralCounterRef` - add parameter
- `arrayLiterals` - add parameter
- `arrayLiteralCounterRef` - add parameter
- `objectProperties` - add parameter (for nested extraction)
- `arrayElements` - add parameter (for nested extraction)

### 2. GraphBuilder: Handle Non-Variable Types

In `bufferArrayMutationEdges` (line 2054), replace lines 2079-2080:

```javascript
// Current: only handles VARIABLE
for (const arg of insertedValues) {
  if (arg.valueType === 'VARIABLE' && arg.valueName) {
    // ... existing code ...
  }
  // ADD:
  else if (arg.valueType === 'LITERAL' && arg.valueNodeId) {
    this._bufferEdge({
      type: 'FLOWS_INTO',
      src: arg.valueNodeId,
      dst: targetNodeId,
      mutationMethod,
      argIndex: arg.argIndex,
      ...(nestedProperty && { nestedProperty })
    });
  }
  else if (arg.valueType === 'OBJECT_LITERAL' && arg.valueNodeId) {
    this._bufferEdge({
      type: 'FLOWS_INTO',
      src: arg.valueNodeId,
      dst: targetNodeId,
      mutationMethod,
      argIndex: arg.argIndex,
      ...(nestedProperty && { nestedProperty })
    });
  }
  else if (arg.valueType === 'ARRAY_LITERAL' && arg.valueNodeId) {
    this._bufferEdge({
      type: 'FLOWS_INTO',
      src: arg.valueNodeId,
      dst: targetNodeId,
      mutationMethod,
      argIndex: arg.argIndex,
      ...(nestedProperty && { nestedProperty })
    });
  }
  else if (arg.valueType === 'CALL' && arg.callLine && arg.callColumn) {
    // Find call site by coordinates (match existing pattern from bufferAssignmentEdges)
    const callSite = this.findCallSiteByLocation(arg.callLine, arg.callColumn, file);
    if (callSite) {
      this._bufferEdge({
        type: 'FLOWS_INTO',
        src: callSite.id,
        dst: targetNodeId,
        mutationMethod,
        argIndex: arg.argIndex,
        ...(nestedProperty && { nestedProperty })
      });
    }
  }
}
```

## Complexity Analysis

**Before:** O(1) per mutation - single variable lookup, single edge creation
**After:** O(1) per mutation - direct node ID usage, no additional iterations

**Node creation:**
- LITERAL: O(1) - single node
- OBJECT_LITERAL: O(p) where p = number of properties (bounded, typically <10)
- ARRAY_LITERAL: O(e) where e = number of elements (bounded, typically <20)
- CALL: O(1) - coordinate lookup in existing collection

**No new graph iterations.** Reuses existing visitor pass.

## Consistency Check

This matches how `bufferAssignmentEdges` handles non-variable assignments (line 1436-1441):
```javascript
// Direct LITERAL assignment
if (sourceId && sourceType !== 'EXPRESSION') {
  this._bufferEdge({
    type: 'ASSIGNED_FROM',
    src: variableId,
    dst: sourceId  // Direct usage of sourceId
  });
}
```

And how push/unshift already work - `extractArguments` creates nodes, `bufferArrayMutationEdges` uses them.

## Risks & Mitigation

**Risk 1:** Collection parameter bloat in `detectIndexedArrayAssignment`
- **Mitigation:** Pass `VisitorCollections` object instead of individual arrays (refactor signature)
- **Alternative:** Extract helper method `createValueNode(value, argInfo, collections)` shared with `extractArguments`

**Risk 2:** Duplicate code between `extractArguments` and `detectIndexedArrayAssignment`
- **Mitigation:** Extract shared helper `createLiteralNodes(actualArg, argInfo, module, collections)` in CallExpressionVisitor
- Make it static/utility method callable from JSASTAnalyzer

**Risk 3:** Tests exist but are ALL skipped (`describe.skip`)
- **Mitigation:** Unskip tests incrementally - run after EACH change to ensure no regression
- Tests already verify the exact behavior we're implementing

## Implementation Order

1. **Extract shared helper** (refactoring)
   - Move node creation logic from `extractArguments` to `createArgumentValueNode(arg, argInfo, module, collections)`
   - Make it reusable between CallExpressionVisitor and JSASTAnalyzer
   - No behavior change - pure refactor with existing tests

2. **Update JSASTAnalyzer**
   - Add collection parameters to `detectIndexedArrayAssignment`
   - Call shared helper to create value nodes
   - Set `valueNodeId` on `argInfo`

3. **Update GraphBuilder**
   - Add non-VARIABLE cases in `bufferArrayMutationEdges`
   - Handle LITERAL/OBJECT_LITERAL/ARRAY_LITERAL/CALL

4. **Unskip and verify tests**
   - Run `IndexedArrayAssignmentRefactoring.test.js`
   - All 11 tests should pass

## Scope Boundaries

**IN SCOPE:**
- Creating value nodes for indexed assignments
- FLOWS_INTO edges for non-variable values
- Matching push/unshift behavior

**OUT OF SCOPE:**
- Nested indexed assignments (`obj.arr[0] = val`) - already tracked in REG-117 pattern
- Computed index variables (`arr[idx] = val`) - already works (NumericLiteral-only filter)
- String-keyed assignments (`arr['key'] = val`) - correctly handled as object mutations

## Acceptance Criteria

1. `arr[0] = 'literal'` creates FLOWS_INTO from LITERAL node to arr
2. `arr[0] = { x: 1 }` creates FLOWS_INTO from OBJECT_LITERAL node to arr
3. `arr[0] = [1, 2]` creates FLOWS_INTO from ARRAY_LITERAL node to arr
4. `arr[0] = foo()` creates FLOWS_INTO from CALL node to arr
5. All 11 skipped tests pass
6. No new graph iterations introduced
7. Matches push/unshift edge creation pattern

## Verdict

**This is the RIGHT approach.**

Architecture is sound - it extends existing patterns rather than inventing new ones. Complexity is O(1) per mutation. No architectural concerns.

The gap exists because indexed assignments were partially implemented - detection works, edge creation only handles VARIABLE. We're completing the implementation to match push/unshift behavior.
