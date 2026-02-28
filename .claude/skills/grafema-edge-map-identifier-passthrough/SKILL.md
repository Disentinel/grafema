---
name: grafema-edge-map-identifier-passthrough
description: |
  Fix missing edges in Grafema core-v2 when edge-map entries don't fire for Identifier
  children. Use when: (1) edge-map defines an edge type for a child key (e.g.,
  ForOfStatement.right → ITERATES_OVER) but the edge never appears in the graph,
  (2) the child AST node is an Identifier in read context, (3) adding new edge types
  via edge-map that should link to variables/parameters. Root cause: visitIdentifier
  returns no graph nodes for read-context identifiers (it's a passthrough creating only
  a READS_FROM deferred ref), so the walk engine's structural edge from the edge-map
  never gets created.
author: Claude Code
version: 1.0.0
date: 2026-02-28
---

# Edge-Map Entries Don't Fire for Identifier Children

## Problem

When adding a new edge type via `edge-map.ts` (e.g., `'ForOfStatement.right': { edgeType: 'ITERATES_OVER' }`), the edge is never created when the child is a simple Identifier like `arr` in `for (const item of arr)`.

## Context / Trigger Conditions

- You added or rely on an edge-map entry for a child key
- The child AST node is an `Identifier` (variable reference in read context)
- The expected edge doesn't appear in the graph
- Instead, you see a `READS_FROM` edge from the parent to the variable

## Root Cause

The walk engine creates structural edges from edge-map only when the child visitor produces graph nodes:

```javascript
// walk.ts — structural edge creation
if (result.nodes.length > 0) {
  allEdges.push({ src: parentNodeId, dst: result.nodes[0].id, type: edgeType });
}
```

`visitIdentifier` for read-context identifiers returns `{ nodes: [], edges: [], deferred: [READS_FROM] }` — zero nodes. So the edge-map's edge type is silently lost. The deferred ref's `edgeType` is hardcoded to `'READS_FROM'` in visitIdentifier, ignoring the edge-map.

## Solution

**Pattern: Add explicit deferred refs in the parent visitor when the child is an Identifier.**

This is the same pattern used by `visitVariableDeclarator` for `ASSIGNED_FROM`:

```typescript
// In the parent visitor (e.g., visitForOfStatement):
if (fo.right.type === 'Identifier') {
  deferred.push({
    kind: 'scope_lookup',
    name: fo.right.name,
    fromNodeId: nodeId,        // parent graph node ID
    edgeType: 'ITERATES_OVER', // the edge type you actually want
    scopeId: ctx.currentScope.id,
    file: ctx.file, line, column,
  });
}
```

The edge-map entry still handles non-Identifier children (CallExpression, MemberExpression, etc.) that produce graph nodes. The explicit deferred ref handles the Identifier case.

## Verification

1. Write a test with the specific pattern (e.g., `for (const x of arr)`)
2. Check that the edge appears: `result.edges.filter(e => e.type === 'YOUR_EDGE_TYPE')`
3. Verify it resolves to the correct variable via scope lookup

## Example

Before fix — `for (const item of arr)` produces:
- LOOP → READS_FROM → VARIABLE(arr)  (wrong edge type)
- No ITERATES_OVER edge

After fix:
- LOOP → ITERATES_OVER → VARIABLE(arr)  (correct)
- LOOP → READS_FROM → VARIABLE(arr)  (also present, from visitIdentifier)

## Affected Edge-Map Entries

Any edge-map entry where the child can be a simple Identifier:
- `ForOfStatement.right` → `ITERATES_OVER`
- `ForInStatement.right` → `ITERATES_OVER`
- `VariableDeclarator.init` → `ASSIGNED_FROM` (already handled in visitVariableDeclarator)
- Any future entries where the child position commonly holds an Identifier

## Notes

- The edge-map still works for complex expressions (CallExpression, MemberExpression, literals) — those visitors DO produce graph nodes
- You'll get both the explicit deferred edge AND the READS_FROM from visitIdentifier — this is expected and correct (both edges are semantically valid)
- When adding new edge types, always test with both Identifier and non-Identifier children
