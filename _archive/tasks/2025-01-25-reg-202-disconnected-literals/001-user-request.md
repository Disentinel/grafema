# User Request

Fix REG-202: Disconnected literal nodes missing PASSES_ARGUMENT edges (172 nodes)

## Problem

172 literal nodes (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL) are created but never linked to the graph. They're invisible to all queries starting from root nodes.

```javascript
foo(42, "hello", {x: 1});
// Creates 3 literal nodes, but NO PASSES_ARGUMENT edges
```

## Impact

* **Soundness violation:** Graph claims to be complete but 1.8% of nodes are unreachable
* Any analysis using BFS/DFS from SERVICE/MODULE misses these 172 nodes
* Cannot answer "what literals are passed to function X?"

## Root Cause

`GraphBuilder.bufferLiterals()` creates nodes but doesn't create edges:

```typescript
private bufferLiterals(literals: LiteralInfo[]): void {
  for (const literal of literals) {
    const { parentCallId, argIndex, ...literalData } = literal;
    this._bufferNode(literalData as GraphNode);
    // BUG: No edge creation! Should create:
    // parentCallId -> PASSES_ARGUMENT -> literal.id
  }
}
```

## Solution

Add edge creation in `bufferLiterals()`, `bufferObjectLiteralNodes()`, `bufferArrayLiteralNodes()`:

```typescript
// After creating node
this._bufferEdge({
  type: 'PASSES_ARGUMENT',
  src: parentCallId,
  dst: literal.id,
  metadata: { argIndex }
});
```

## Acceptance Criteria

- [ ] All LITERAL nodes have incoming PASSES_ARGUMENT edge
- [ ] All OBJECT_LITERAL nodes have incoming edge
- [ ] All ARRAY_LITERAL nodes have incoming edge
- [ ] GraphConnectivityValidator reports 0 disconnected nodes
- [ ] Tests pass
