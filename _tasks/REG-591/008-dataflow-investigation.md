# Data Flow Investigation: Express Variable Name Resolution in core-v2

**Author:** Investigation
**Date:** 2026-03-01
**Question:** Given FileResult.nodes and FileResult.edges, how to identify which variable names hold
Express app/router instances without hardcoding `metadata.object === 'app'`.

---

## Source files examined

- `packages/core-v2/src/visitors/expressions.ts` — visitCallExpression
- `packages/core-v2/src/visitors/declarations.ts` — visitVariableDeclarator
- `packages/core-v2/src/walk.ts` — walkFile, Stage 2 scope resolution
- `packages/core-v2/src/edge-map.ts` — EDGE_MAP declarative mappings
- `packages/core-v2/src/scope.ts` — ScopeNode, scopeLookup
- `packages/core-v2/src/types.ts` — FileResult, GraphNode, GraphEdge

---

## FileResult structure

```typescript
interface FileResult {
  file: string;
  moduleId: string;
  nodes: GraphNode[];   // ALL nodes: MODULE, FILE, VARIABLE, CALL, EXTERNAL, EXTERNAL_MODULE, SCOPE, ...
  edges: GraphEdge[];   // ALL edges after Stage 2 resolution: ASSIGNED_FROM, CALLS, CALLS_ON, ...
  unresolvedRefs: DeferredRef[];  // cross-file refs pushed to Stage 3
  scopeTree: ScopeNode;  // root scope (for diagnostics)
}
```

---

## Question 1: `const app = express()` — what nodes and edges?

### Nodes created

| Node ID pattern | Type | Name | Notes |
|---|---|---|---|
| `file->VARIABLE->app#L` | VARIABLE | `app` | From visitVariableDeclarator; metadata: `{ kind: 'const' }` |
| `file->CALL->express#L` | CALL | `express` | From visitCallExpression; callee is Identifier |
| (no node) | — | — | The `express` identifier in callee is resolved deferred |

### Edges created

**From EDGE_MAP** (`VariableDeclarator.init` → `ASSIGNED_FROM`):

The walk engine sees `VariableDeclarator` with child `init` = the CallExpression. EDGE_MAP entry:

```
'VariableDeclarator.init': { edgeType: 'ASSIGNED_FROM' }
```

This causes the walk engine to emit the structural edge when visiting the child:

```
VARIABLE('app') --ASSIGNED_FROM--> CALL('express')
```

**From Stage 2 scope resolution** (deferred `scope_lookup` for callee):

visitCallExpression pushes a `scope_lookup` deferred for `name: 'express'`, `edgeType: 'CALLS'`.
`express` is not in scope (it comes from an import), so this deferred ref goes to `unresolvedRefs`
(Stage 3). No CALLS edge appears in FileResult.edges for cross-module calls.

**From DECLARES** (via ctx.declare):

```
MODULE --DECLARES--> VARIABLE('app')
```

### Summary for `const app = express()`

```
VARIABLE('app') --ASSIGNED_FROM--> CALL('express')
MODULE           --DECLARES-->      VARIABLE('app')
MODULE           --CONTAINS-->      VARIABLE('app')   [structural from walk engine]
```

The `ASSIGNED_FROM` edge goes from the VARIABLE node to the CALL node.
The CALL node has `name: 'express'`.

---

## Question 2: `const router = express.Router()` — what nodes and edges?

### Nodes created

| Node ID pattern | Type | Name | Notes |
|---|---|---|---|
| `file->VARIABLE->router#L` | VARIABLE | `router` | From visitVariableDeclarator |
| `file->CALL->express.Router#L` | CALL | `express.Router` | callee is MemberExpression; object=`express`, property=`Router` |

The CALL node metadata (lines 117–120 of expressions.ts):

```typescript
metadata: {
  arguments: call.arguments.length,
  chained: false,
  method: 'Router',          // callee.property.name
  object: 'express',         // callee.object.name (Identifier)
}
```

### Edges created

**From EDGE_MAP** (`VariableDeclarator.init` → `ASSIGNED_FROM`):

```
VARIABLE('router') --ASSIGNED_FROM--> CALL('express.Router')
```

**From deferred CALLS_ON** (lines 200–225 of expressions.ts):

For `obj.method()` where obj is an Identifier, a `scope_lookup` deferred is pushed:

```typescript
result.deferred.push({
  kind: 'scope_lookup',
  name: 'express',         // the object identifier
  fromNodeId: nodeId,      // CALL('express.Router') node ID
  edgeType: 'CALLS_ON',
  ...
});
```

`express` resolves to the EXTERNAL node from the import → Stage 2 emits:

```
CALL('express.Router') --CALLS_ON--> EXTERNAL('express')  [if ESM import of 'express' is in scope]
```

If `express` is not in scope (pure Stage 3), this goes to `unresolvedRefs`.

**From DECLARES:**

```
MODULE --DECLARES--> VARIABLE('router')
```

### Summary for `const router = express.Router()`

```
VARIABLE('router') --ASSIGNED_FROM--> CALL('express.Router')
CALL('express.Router').metadata.method  === 'Router'
CALL('express.Router').metadata.object  === 'express'
MODULE              --DECLARES-->      VARIABLE('router')
```

---

## Question 3: `app.get('/path', handler)` — can we trace backward from 'app'?

The CALL node for `app.get('/path', handler)` has:

```typescript
{
  type: 'CALL',
  name: 'app.get',
  metadata: {
    method: 'get',
    object: 'app',    // literal string from the AST identifier
  }
}
```

During visitCallExpression, a `scope_lookup` deferred is pushed for `name: 'app'`, `edgeType: 'CALLS_ON'`. In Stage 2, `app` resolves to the VARIABLE('app') node in scope. So FileResult.edges contains:

```
CALL('app.get') --CALLS_ON--> VARIABLE('app')
```

**Backward trace from CALL to assignment source:**

```
CALL('app.get') --CALLS_ON--> VARIABLE('app') --ASSIGNED_FROM--> CALL('express')
```

So: start at CALL node where `metadata.method` is an HTTP verb. Follow CALLS_ON edge to a VARIABLE. Follow that VARIABLE's ASSIGNED_FROM edge to another CALL. Check if that CALL's `name === 'express'`.

---

## Question 4: `router.get('/path', handler)` — same trace for router?

The CALL node has `metadata.object === 'router'`.

Stage 2 CALLS_ON resolution gives:

```
CALL('router.get') --CALLS_ON--> VARIABLE('router') --ASSIGNED_FROM--> CALL('express.Router')
```

Check: `CALL('express.Router').name === 'express.Router'`
Or equivalently: `CALL.metadata.object === 'express' && CALL.metadata.method === 'Router'`.

---

## The algorithm: build expressVarNames from FileResult

Given `fileResult.nodes` and `fileResult.edges`, here is the exact traversal to identify all
variable names that hold Express app or router instances:

```typescript
function findExpressVarNames(fileResult: FileResult): Set<string> {
  const { nodes, edges } = fileResult;

  // Build lookup maps for O(1) access
  const nodeById = new Map<string, GraphNode>(nodes.map(n => [n.id, n]));

  // Index edges by src for fast forward traversal
  const edgesBySrc = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = edgesBySrc.get(e.src) ?? [];
    list.push(e);
    edgesBySrc.set(e.src, list);
  }

  // Find all VARIABLE nodes that are ASSIGNED_FROM an Express CALL
  const expressVarNames = new Set<string>();

  for (const node of nodes) {
    if (node.type !== 'VARIABLE') continue;

    // Find ASSIGNED_FROM edges from this VARIABLE
    const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
      .filter(e => e.type === 'ASSIGNED_FROM');

    for (const assignEdge of assignedFromEdges) {
      const sourceNode = nodeById.get(assignEdge.dst);
      if (!sourceNode || sourceNode.type !== 'CALL') continue;

      // Case 1: VARIABLE --ASSIGNED_FROM--> CALL where CALL.name === 'express'
      // This covers: const app = express()
      if (sourceNode.name === 'express') {
        expressVarNames.add(node.name);
        break;
      }

      // Case 2: VARIABLE --ASSIGNED_FROM--> CALL where CALL.name === 'express.Router'
      // This covers: const router = express.Router()
      if (
        sourceNode.name === 'express.Router' ||
        (sourceNode.metadata?.object === 'express' && sourceNode.metadata?.method === 'Router')
      ) {
        expressVarNames.add(node.name);
        break;
      }
    }
  }

  return expressVarNames;
}
```

---

## Limitations and edge cases

### 1. Alias chains: `const server = app`

If code does:
```javascript
const app = express();
const server = app;    // alias
server.get('/foo', handler);
```

`VARIABLE('server')` has `ASSIGNED_FROM` → `VARIABLE('app')` (via scope_lookup deferred, resolved in
Stage 2 to an `ALIASES` edge, not `ASSIGNED_FROM`). Actually, from declarations.ts lines 85–107:

```typescript
if (decl.init?.type === 'Identifier') {
  result.deferred.push({ kind: 'scope_lookup', name: ..., edgeType: 'ASSIGNED_FROM', ... });
  result.deferred.push({ kind: 'scope_lookup', name: ..., edgeType: 'ALIASES', ... });
}
```

Both `ASSIGNED_FROM` and `ALIASES` edges are emitted for identifier inits. So `server` will have:
- `VARIABLE('server') --ASSIGNED_FROM--> VARIABLE('app')`
- `VARIABLE('server') --ALIASES--> VARIABLE('app')`

To handle alias chains, extend the algorithm: follow ASSIGNED_FROM edges transitively when the
destination is a VARIABLE (not a CALL). This requires a BFS/DFS instead of a single hop. This is
a known limitation of the single-hop algorithm above.

### 2. Destructuring: `const { Router } = express`

Destructuring initializers go to a separate visitor path (declarations.ts line 49:
`if (decl.id.type !== 'Identifier') return EMPTY_RESULT`). Destructuring is not handled by
`visitVariableDeclarator` in core-v2 currently. The `Router` binding would not appear as a VARIABLE
node via this path. This is a known gap.

### 3. `app` assigned inside if/function body

```javascript
let app;
if (condition) { app = express(); }
```

`AssignmentExpression.right` maps to `ASSIGNED_FROM` in EDGE_MAP. The `app = express()` assignment
creates:
```
VARIABLE('app') --ASSIGNED_FROM--> CALL('express')
```

This IS captured by the algorithm because the edge type is the same `ASSIGNED_FROM`. However, if
`app` was declared with `let app` (without init), `visitVariableDeclarator` creates a VARIABLE node
with no ASSIGNED_FROM edge initially. The assignment expression adds it later. The nodes/edges in
FileResult will include both — the algorithm handles this correctly.

### 4. CommonJS: `const app = require('express')()`

```javascript
const app = require('express')();
```

This creates a CALL node with `name: '<computed>'` or `name: 'require'` depending on the chaining.
Actually: `require('express')()` — the outer call's callee is itself a CallExpression. In
visitCallExpression, this is `call.callee.type === 'CallExpression'` — not an Identifier or
MemberExpression, so `calleeName = '<computed>'`. The algorithm would NOT detect this pattern.

However, the common real-world pattern is:
```javascript
const express = require('express');
const app = express();
```

In this case, `app` is assigned from `CALL('express')` where `express` was previously assigned from
`require('express')`. The algorithm correctly detects this (CALL.name === 'express').

### 5. `express()` called inline without variable assignment

```javascript
module.exports.app = express();
```

No VARIABLE node is created for `app` here. This pattern is not captured. Routes defined on
`module.exports.app.get(...)` would have `metadata.object === 'app'` but no VARIABLE node traces
back to `express()`. This is acceptable: the Express plugin can fall back to heuristics for these
patterns.

---

## Concrete implementation recommendation

The algorithm above (single-hop ASSIGNED_FROM traversal) handles the common cases:

```
const app = express()       → detected
const router = express.Router()  → detected
const server = app          → NOT detected (alias chain, requires multi-hop)
```

For the Express plugin in core-v2, the recommended approach is:

1. Call `findExpressVarNames(fileResult)` once per file to build the set.
2. When checking if a CALL node is an Express route registration, use:
   ```typescript
   const isExpressObject = expressVarNames.has(callNode.metadata?.object as string);
   ```
   instead of `metadata.object === 'app' || metadata.object === 'router'`.

3. If alias chain support is needed, extend with a BFS on ASSIGNED_FROM/ALIASES edges:
   ```typescript
   function resolveToExpressVar(varId: string, nodeById, edgesBySrc, visited = new Set()): boolean {
     if (visited.has(varId)) return false;
     visited.add(varId);
     const edges = edgesBySrc.get(varId) ?? [];
     for (const e of edges.filter(e => e.type === 'ASSIGNED_FROM')) {
       const dst = nodeById.get(e.dst);
       if (!dst) continue;
       if (dst.type === 'CALL' && (dst.name === 'express' || dst.name === 'express.Router')) return true;
       if (dst.type === 'VARIABLE') return resolveToExpressVar(dst.id, nodeById, edgesBySrc, visited);
     }
     return false;
   }
   ```

---

## Summary table

| Pattern | VARIABLE node | ASSIGNED_FROM target | Detectable? |
|---|---|---|---|
| `const app = express()` | VARIABLE('app') | CALL('express') | Yes |
| `const router = express.Router()` | VARIABLE('router') | CALL('express.Router') | Yes |
| `const server = app` (alias) | VARIABLE('server') | VARIABLE('app') | Multi-hop BFS |
| `const express = require('express'); const app = express()` | VARIABLE('app') | CALL('express') | Yes |
| `require('express')()` inline | none | — | No |
| `module.exports.app = express()` | none (property assign) | — | No |

The ASSIGNED_FROM edge is the single correct traversal for this purpose.
It is emitted by the EDGE_MAP entry `'VariableDeclarator.init': { edgeType: 'ASSIGNED_FROM' }` and
`'AssignmentExpression.right': { edgeType: 'ASSIGNED_FROM' }` and is always present in FileResult.edges
(resolved in Stage 2 when the init is a CallExpression, emitted immediately by the walk engine's
structural edge logic when visiting VariableDeclarator.init).
