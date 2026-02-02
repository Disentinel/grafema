# Plan Revision: Addressing Linus's Review

## Issue 1: PARAMETER Nodes - ACCEPTED

**Fix:** Add PARAMETER node indexing to `buildVariablesByScopeIndex()`.

PARAMETER nodes have `parentFunctionId`, not `parentScopeId`. We need to:
1. Find the FUNCTION's SCOPE via parentFunctionId
2. Map PARAMETER to that SCOPE

```typescript
// Also index PARAMETER nodes via their function's scope
for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
  const param = node as ParameterNode;
  if (!param.parentFunctionId) continue;

  // Find the function's scope
  // FUNCTION -[HAS_SCOPE]-> SCOPE
  const scopeEdges = await graph.getOutgoingEdges(param.parentFunctionId, ['HAS_SCOPE']);
  if (scopeEdges.length === 0) continue;

  const scopeId = scopeEdges[0].dst;
  const params = index.get(scopeId) || [];
  params.push(param);
  index.set(scopeId, params);
}
```

## Issue 2: Depth=1 Metadata Inconsistency - DEFERRED

**Decision:** Accept inconsistency for now. Document as known limitation.

**Rationale:**
- Modifying JSASTAnalyzer would be a larger change
- Enricher adding depth=1 to existing edges risks duplicates
- Focus on delivering the requested feature (transitive captures)

**Future work:** Create follow-up issue REG-XXX to add depth metadata to all CAPTURES edges.

For now, queries can use:
- `CAPTURES edge with metadata.depth > 1` → transitive captures
- `CAPTURES edge without metadata.depth` → immediate captures (depth=1)

## Issue 3: Control Flow Scopes - CLARIFIED

**Decision:** Depth counts ALL scopes in the chain.

```javascript
function outer() {      // scope-outer
  const x = 1;
  if (condition) {      // scope-if (depth=1 from inner)
    return function inner() {   // scope-inner
      return function deepest() {  // scope-deepest
        return x;       // x at depth=3: deepest -> inner -> if -> outer
      }
    }
  }
}
```

This matches JavaScript semantics - the scope chain includes all enclosing lexical scopes.

**Note:** The filter `scopeType='closure'` is only for finding CLOSURES to process (source of CAPTURES edges). The depth walk includes ALL scopes.

## Issue 4: Priority Comment - FIXED

```typescript
priority: 40, // Lower number = runs later. Runs after ImportExportLinker (90)
```

## Updated Test: PARAMETER Capture

```javascript
it('should capture PARAMETER nodes from ancestor scopes', async () => {
  const { backend } = await setupBackend();

  try {
    const enricher = new ClosureCaptureEnricher();

    await backend.addNodes([
      // Function with parameter
      { id: 'func-outer', type: 'FUNCTION', name: 'outer', file: 'test.js', line: 1 },
      { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
      { id: 'param-x', type: 'PARAMETER', name: 'x', file: 'test.js', line: 1, parentFunctionId: 'func-outer' },
      // Nested closures
      { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
      { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' }
    ]);

    // Link function to scope
    await backend.addEdge({ src: 'func-outer', dst: 'scope-outer', type: 'HAS_SCOPE' });
    await backend.flush();

    const result = await enricher.execute({ graph: backend });

    // deepest should capture param-x at depth=2
    const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
    assert.ok(deepestEdges.some(e => e.dst === 'param-x'), 'Should capture PARAMETER nodes');
  } finally {
    await backend.close();
  }
});
```

## Summary of Changes

| Issue | Resolution |
|-------|------------|
| PARAMETER nodes | Add to index via parentFunctionId → HAS_SCOPE |
| Depth=1 metadata | Defer - document as limitation |
| Control flow scopes | Count ALL scopes (correct behavior) |
| Priority comment | Fix the comment |

**Status:** READY FOR IMPLEMENTATION
