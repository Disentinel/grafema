# Joel Spolsky - Technical Plan: REG-392

## Summary

Extend `bufferArrayMutationEdges` to create FLOWS_INTO edges for non-variable values in indexed array assignments. Two files need changes: JSASTAnalyzer (create value nodes) and GraphBuilder (create edges from those nodes).

## Changes

### Change 1: JSASTAnalyzer.detectIndexedArrayAssignment — Create Value Nodes

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines 5277-5342
**What:** After determining `valueType`, create the actual nodes and set `valueNodeId` on `argInfo`.

**Signature change:** Add `collections` parameter (type `VisitorCollections`) — available at both call sites (line 1652 via `allCollections`, line 3787 via `collections`).

**For LITERAL:** Create a LITERAL node, push to `collections.literals`, set `argInfo.valueNodeId`.
```typescript
if (argInfo.valueType === 'LITERAL') {
  const literalCounterRef = collections.literalCounterRef as CounterRef;
  const literals = collections.literals as LiteralInfo[];
  const literalId = `LITERAL#indexed#${module.file}#${line}:${column}:${literalCounterRef.value++}`;
  literals.push({
    id: literalId, type: 'LITERAL', value: argInfo.literalValue,
    valueType: typeof argInfo.literalValue, file: module.file,
    line, column, parentCallId: undefined, argIndex: 0
  });
  argInfo.valueNodeId = literalId;
}
```

**For OBJECT_LITERAL:** Create via `ObjectLiteralNode.create()`, push to `collections.objectLiterals`, extract properties, set `valueNodeId`.

**For ARRAY_LITERAL:** Create via `ArrayLiteralNode.create()`, push to `collections.arrayLiterals`, extract elements, set `valueNodeId`.

**For CALL:** Already has `callLine`/`callColumn` — no change needed. GraphBuilder will look up by coordinates.

**Complexity:** O(1) for LITERAL/CALL, O(p) for OBJECT_LITERAL (p = properties), O(e) for ARRAY_LITERAL (e = elements). All bounded by AST node size.

### Change 2: GraphBuilder.bufferArrayMutationEdges — Handle Non-Variable Types

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`, lines 2054-2081
**What:** Replace the comment on lines 2079-2080 with actual edge creation for non-VARIABLE types.

After the existing `if (arg.valueType === 'VARIABLE' ...)` block, add:

```typescript
else if (arg.valueNodeId) {
  // LITERAL, OBJECT_LITERAL, ARRAY_LITERAL — use direct node ID
  const edgeData: GraphEdge = {
    type: 'FLOWS_INTO', src: arg.valueNodeId, dst: targetNodeId,
    mutationMethod, argIndex: arg.argIndex
  };
  if (arg.isSpread) edgeData.isSpread = true;
  if (nestedProperty) edgeData.nestedProperty = nestedProperty;
  this._bufferEdge(edgeData);
}
else if (arg.valueType === 'CALL' && arg.callLine !== undefined && arg.callColumn !== undefined) {
  // CALL — find call site by coordinates
  const callSite = callSites.find(cs =>
    cs.line === arg.callLine && cs.column === arg.callColumn && cs.file === file
  );
  if (callSite) {
    const edgeData: GraphEdge = {
      type: 'FLOWS_INTO', src: callSite.id, dst: targetNodeId,
      mutationMethod, argIndex: arg.argIndex
    };
    if (nestedProperty) edgeData.nestedProperty = nestedProperty;
    this._bufferEdge(edgeData);
  }
}
```

**Note:** `callSites` is already available in `buildEdges()` (the caller). Need to pass it to `bufferArrayMutationEdges`. Check current signature and add parameter.

### Change 3: Pass callSites to bufferArrayMutationEdges

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Line 2019: Add `callSites: CallSiteInfo[]` parameter
- Line 365: Pass `callSites` argument at call site

### Change 4: Unskip Tests

**File:** `test/unit/IndexedArrayAssignmentRefactoring.test.js`, line 53
- Change `describe.skip(...)` to `describe(...)`

### Change 5: Update Call Sites in JSASTAnalyzer

At line 1652 (module-level call):
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, allCollections);
```

At line 3787 (function-level call):
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, collections);
```

## Complexity Analysis

- **Iteration complexity:** O(1) per mutation — no new graph iterations
- **Node creation:** Same as existing `extractArguments` pattern — creates nodes inline during AST traversal
- **Edge creation:** O(1) per non-variable value (direct ID lookup or coordinate match)
- **Call site lookup (CALL type):** O(c) where c = call sites in file. Could be optimized with index later if needed, but matches existing pattern in `bufferAssignmentEdges`.

## Design Decision: No Shared Helper

Don's plan suggested extracting a shared helper between `extractArguments` and `detectIndexedArrayAssignment`. I recommend **against** this because:

1. `extractArguments` handles function call arguments (multiple args, spread, nested calls) — significantly more complex
2. `detectIndexedArrayAssignment` handles a single value — much simpler
3. Extracting a helper would require touching CallExpressionVisitor (risk of regression)
4. The duplication is minimal (~15 lines per type) and the contexts are different enough

Simple inline creation in `detectIndexedArrayAssignment` is the right choice here.

## Implementation Order

1. Add `collections` parameter to `detectIndexedArrayAssignment`
2. Create value nodes for LITERAL/OBJECT_LITERAL/ARRAY_LITERAL
3. Pass `callSites` to `bufferArrayMutationEdges`
4. Handle non-VARIABLE types in `bufferArrayMutationEdges`
5. Unskip tests
6. Run tests, fix if needed

## Risk Assessment

- **Low risk:** Changes are additive — existing VARIABLE handling unchanged
- **Low risk:** Tests already exist — clear pass/fail criteria
- **Medium risk:** OBJECT_LITERAL/ARRAY_LITERAL node creation may need collection initialization guards (lazy init pattern from CallExpressionVisitor)
