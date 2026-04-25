# REG-543: Don Melton Tech Lead Plan

## Problem Summary

`grafema impact "addNode"` reports 0 callers even though there are 28 call sites
`graph.addNode()` in the codebase. Root cause: when `graph` is typed as `GraphBackend`
(an abstract class or interface), `MethodCallResolver` cannot resolve the receiver type
to a concrete implementation, so no `CALLS` edge is created. The CALL nodes DO exist in
the graph with `method = "addNode"` in their metadata, but `findCallsToNode` in
`impact.ts` only queries via `getIncomingEdges(targetId, ['CALLS'])`, which finds
nothing for unresolved method calls.

## Current Behavior — Code Trace

### File: `/Users/vadimr/grafema-worker-2/packages/cli/src/commands/impact.ts`

**`analyzeImpact()` (line 157-251)**
- Calls `findCallsToNode(backend, id)` for each target node ID
- `findCallsToNode` (line 281-308) **only** looks at incoming `CALLS` edges:
  ```typescript
  const edges = await backend.getIncomingEdges(targetId, ['CALLS']);
  ```
- If no `CALLS` edge exists (because `MethodCallResolver` couldn't resolve the receiver),
  zero results are returned.

### What IS in the graph

CALL nodes (type `'CALL'`) with these metadata attributes (from `MethodCallNode.ts` /
`JSASTAnalyzer.ts`):
- `method`: the method name string (e.g., `"addNode"`)
- `object`: the receiver name (e.g., `"graph"`)
- `name`: the full call expression name (e.g., `"graph.addNode"`)
- `file`, `line`, `column`: location

The `method` attribute is a declared field (JSASTAnalyzer metadata, line 283), so it is
indexed in RFDB and can be queried efficiently via `findByAttr`.

### What the graph CANNOT tell us (without inference)

There is no `CALLS` edge from the `graph.addNode` CALL node to `RFDBServerBackend.addNode`
FUNCTION/METHOD node, because the receiver type is abstract.

---

## Proposed Fix

### Strategy

In `findCallsToNode`, after querying via `CALLS` edges, also query CALL nodes by their
`method` attribute matching the target's name. This finds all call sites that call a
method with that name, regardless of whether type resolution succeeded.

This is a **supplementary** query: union of CALLS-edge callers + method-attribute callers.
Deduplication by node ID is required.

The fallback query for a FUNCTION node named `addNode` should search for CALL nodes
where `method === "addNode"`.

For a METHOD node (class method), the same applies: `method === <method name>`.

### Scope

**One file changes:** `/Users/vadimr/grafema-worker-2/packages/cli/src/commands/impact.ts`

No changes needed to:
- Core graph engine
- MethodCallResolver
- RFDB server
- Any other package

---

## Exact Logic Change

### Current `findCallsToNode` (lines 281-308)

```typescript
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  try {
    const edges = await backend.getIncomingEdges(targetId, ['CALLS']);
    for (const edge of edges) {
      const callNode = await backend.getNode(edge.src);
      if (callNode) {
        calls.push({ ... });
      }
    }
  } catch {
    // Ignore
  }
  return calls;
}
```

### Proposed `findCallsToNode` (revised)

Change the function signature to also accept the target node info (name and type), and
add a second query that uses `findByAttr` with `{ nodeType: 'CALL', method: <name> }`.

```typescript
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string,
  targetName?: string   // <-- new optional param: bare method name
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    // Path 1: CALLS edges (resolved method calls)
    const edges = await backend.getIncomingEdges(targetId, ['CALLS']);
    for (const edge of edges) {
      const callNode = await backend.getNode(edge.src);
      if (callNode && !seen.has(callNode.id)) {
        seen.add(callNode.id);
        calls.push({
          id: callNode.id,
          type: callNode.type || 'CALL',
          name: callNode.name || '',
          file: callNode.file || '',
          line: callNode.line,
        });
      }
    }
  } catch {
    // Ignore
  }

  // Path 2: CALL nodes with matching `method` attribute (unresolved method calls)
  // This covers calls via abstract/interface type variables where no CALLS edge exists.
  if (targetName) {
    try {
      const callNodeIds = await backend.findByAttr({
        nodeType: 'CALL',
        method: targetName,
      });
      for (const id of callNodeIds) {
        if (!seen.has(id)) {
          seen.add(id);
          const callNode = await backend.getNode(id);
          if (callNode) {
            calls.push({
              id: callNode.id,
              type: callNode.type || 'CALL',
              name: callNode.name || '',
              file: callNode.file || '',
              line: callNode.line,
            });
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return calls;
}
```

### Call site change in `analyzeImpact` (line 196)

Change:
```typescript
const containingCalls = await findCallsToNode(backend, id);
```

To pass the target method name. The target node name must be extracted for this purpose.
The `target.name` value (already present in `NodeInfo`) is the full name — we need the
**method name only** (last segment after `.` if any).

Extract the method name before the BFS loop:
```typescript
// Extract bare method name for method-attribute fallback query
function extractMethodName(fullName: string): string {
  const dotIdx = fullName.lastIndexOf('.');
  return dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
}
```

Then call:
```typescript
const methodName = extractMethodName(target.name);
const containingCalls = await findCallsToNode(backend, id, methodName);
```

**Note:** `methodName` is extracted from `target.name` (e.g., `"addNode"` from
`"RFDBServerBackend.addNode"` or just `"addNode"` from `"addNode"`). This means the
fallback will find ALL call sites for any method named `addNode` — which is exactly what
the issue requests. It's an intentional broadening: without type information, we cannot
distinguish `graph.addNode()` from `tree.addNode()`, and that's acceptable for an
impact analysis tool.

---

## Handling of New Behavior

### Display

The output format does not change. CALL nodes found via method attribute are fed into
`findContainingFunction` exactly like CALL nodes found via CALLS edges — they become
entries in `directCallers` or `transitiveCallers`.

The result is: previously 0 callers, now shows all functions that contain a call
expression with that method name.

### Potential Noise

The fallback is broader than CALLS edges: `method === "addNode"` matches ALL method
calls with that name, not just calls to `RFDBServerBackend.addNode`. This is correct
behavior for impact analysis on dynamically-typed code — it's the most conservative
(widest) estimate. The issue request explicitly accepts this.

If the user wants a narrower result, they should use `grafema query` with a Datalog
predicate — impact analysis is intentionally conservative.

### Note to Display

The output could optionally note that some callers were found via method-name matching
(not type-resolved), but this is NOT required by the acceptance criteria and adds UI
complexity. Leave it for a follow-up.

---

## Tests Needed

### Existing Tests

`/Users/vadimr/grafema-worker-2/packages/cli/test/impact-class.test.ts`
- Tests class impact aggregation, not the abstract-type scenario
- These tests do NOT cover the REG-543 bug (they only test with method calls that
  have `CALLS` edges via concrete class instances)

### New Test File

Create: `/Users/vadimr/grafema-worker-2/packages/cli/test/impact-abstract-callers.test.ts`

**Test scenario:** A function-typed parameter (or interface-typed variable) is used to
call a method. The analyzer creates CALL nodes with `method = "addNode"` but
`MethodCallResolver` cannot resolve them (no CALLS edge).

The test must:
1. Set up a JS project where a function receives a graph object (interface/any type)
   and calls `graph.addNode()`
2. Run `grafema analyze`
3. Run `grafema impact "addNode"` (or `grafema impact "function addNode"`)
4. Assert the function that called `graph.addNode()` appears as a caller

**Concrete test scenario:**

```javascript
// src/backend.js
class GraphBackend {
  addNode(node) { /* ... */ }
}
module.exports = { GraphBackend };

// src/service.js
function useGraph(graph) {
  graph.addNode({ id: '1', type: 'FUNCTION' });  // graph: any type, no CALLS edge created
}
module.exports = { useGraph };
```

After `grafema impact "addNode"`:
- Before fix: `0 direct callers`
- After fix: `1 direct caller` (`useGraph`)

**Test assertion:**
```typescript
assert.ok(
  !output.includes('0 direct callers'),
  'Should find caller via method attribute even without CALLS edge'
);
assert.ok(
  output.includes('useGraph'),
  'Should list useGraph as a direct caller'
);
```

### Unit-level consideration

A pure unit test for the `findCallsToNode` function change would require mocking
`backend.findByAttr`. Given the existing pattern in the codebase (CLI tests use
`spawnSync` + actual analyze), the integration-style test is preferred. There is no
precedent for mocking `RFDBServerBackend` in CLI tests.

---

## Implementation Steps (for Rob/Dijkstra)

1. **Read** `/Users/vadimr/grafema-worker-2/packages/cli/src/commands/impact.ts`
2. **Add** `extractMethodName` helper function (pure, no deps)
3. **Modify** `findCallsToNode` signature to accept `targetName?: string`
4. **Add** Path 2 inside `findCallsToNode` using `backend.findByAttr({ nodeType: 'CALL', method: targetName })`
5. **Modify** the call site in `analyzeImpact` (line 196) to pass `methodName`
6. **Write test** `packages/cli/test/impact-abstract-callers.test.ts`
7. **Build**: `pnpm build`
8. **Run tests**: `node --test packages/cli/test/impact-abstract-callers.test.ts`

---

## Risk Assessment

**Low risk.** The change is additive (fallback query only runs when `targetName` is
provided, and results are deduplicated). The existing CALLS-edge path is unchanged.
If `findByAttr` fails (backend not connected, etc.), the error is caught silently —
same pattern as the existing code. No schema changes, no core changes, no new packages.

**One subtle risk:** `findByAttr` with `method` attribute requires that the `method`
field is indexed in RFDB (declared via `JSASTAnalyzer.metadata.fields`). Confirmed at
line 283 of `JSASTAnalyzer.ts`: `{ name: 'method', fieldType: 'string', nodeTypes: ['CALL'] }`.
The index exists. The query will be efficient.
