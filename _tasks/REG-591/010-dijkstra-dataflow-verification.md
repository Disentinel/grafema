## Dijkstra — Data Flow Verification

**Author:** Edsger Dijkstra, Plan Verifier
**Date:** 2026-03-01
**Verifying:** 008-dataflow-investigation.md (and the delta in 009-don-dataflow-update.md)

---

**Verdict:** APPROVE WITH CONDITIONS

The core data flow approach is sound and the main algorithm will work. However, the investigation
contains one factually incorrect claim about `AssignmentExpression` semantics that the implementation
must not follow. This is documented below under Claim 3 and in the edge case table.

---

## Claim 1: `const app = express()` produces ASSIGNED_FROM edge

**VERIFIED**

**Evidence — EDGE_MAP (`packages/core-v2/src/edge-map.ts`, line 103):**

```typescript
'VariableDeclarator.init': { edgeType: 'ASSIGNED_FROM' },
```

**Evidence — walk engine (`packages/core-v2/src/walk.ts`, lines 295-301):**

```typescript
// Structural edge from parent graph node to first result node
if (result.nodes.length > 0) {
  allEdges.push({
    src: parentNodeId,     // ← the VARIABLE node created by visitVariableDeclarator
    dst: result.nodes[0].id, // ← the CALL node created by visitCallExpression
    type: edgeType,        // ← 'ASSIGNED_FROM' from EDGE_MAP
  });
}
```

When the walk engine visits the `init` child of a `VariableDeclarator`, `parentNodeId` is the
VARIABLE node (the graph node produced by `visitVariableDeclarator`). The `result.nodes[0].id` is
the CALL node produced by `visitCallExpression`. The EDGE_MAP entry overrides the default CONTAINS
edge type to ASSIGNED_FROM.

**Direction confirmed:** `VARIABLE('app') --ASSIGNED_FROM--> CALL('express')` (src=VARIABLE,
dst=CALL). This is exactly what the investigation claims, and the algorithm's edgesBySrc lookup
on the VARIABLE's ID to find ASSIGNED_FROM edges is correct.

---

## Claim 2: `const router = express.Router()` produces CALL with name 'express.Router'

**VERIFIED**

**Evidence — `packages/core-v2/src/visitors/expressions.ts`, lines 55-67:**

```typescript
} else if ((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression')
  && call.callee.property.type === 'Identifier') {
  const member = call.callee as MemberExpression;
  const isOptional = (member as unknown as { optional?: boolean }).optional;
  const obj = member.object.type === 'Identifier'
    ? member.object.name      // ← 'express'
    : ...
  const dot = isOptional ? '?.' : '.';
  calleeName = `${obj}${dot}${(member.property as Identifier).name}`;
  //           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //           = 'express' + '.' + 'Router' = 'express.Router'
```

The CALL node gets `name: calleeName` (line 110): `name: 'express.Router'`.

Additionally, the metadata block (lines 117-119) confirms:

```typescript
...((call.callee.type === 'MemberExpression' ...) && call.callee.property.type === 'Identifier'
  ? { method: call.callee.property.name,   // 'Router'
      object: call.callee.object.type === 'Identifier' ? call.callee.object.name : ...
      // 'express'
     }
  : {}),
```

So `CALL('express.Router').metadata.object === 'express'` and
`CALL('express.Router').metadata.method === 'Router'` — both confirmed.

---

## Claim 3: Stage 2 resolves CALLS_ON edges before plugins run

**VERIFIED — with qualification on the exact timing**

**Evidence — `packages/core-v2/src/walk.ts`, lines 473-552:**

```typescript
// ─── Stage 2: File-scope resolution ────────────────────────────────────────
const resolvedEdges: GraphEdge[] = [];
// ... scope_lookup deferred refs resolved here ...

return {
  file,
  moduleId,
  nodes: allNodes,
  edges: [...allEdgesSoFar, ...loopElementEdges],  // ← includes resolvedEdges
  unresolvedRefs,
  scopeTree: ctx._rootScope,
};
```

`allEdgesSoFar` at line 542 is:
```typescript
const allEdgesSoFar = [...allEdges, ...resolvedEdges, ...ctx._declareEdges];
```

Stage 2 scope resolution runs synchronously inside `walkFile` before the function returns. Domain
plugins are called via the new `domainPlugins` parameter passed to `walkFile` (from 006 spec, Commit
3). From the plan's signature:
```typescript
walkFile(code, file, registry, domainPlugins = [], strict = true)
```

Plugins receive the FileResult after it is assembled. Since FileResult.edges already includes
`resolvedEdges` (Stage 2 output), all `scope_lookup`-resolved CALLS_ON edges — specifically
`CALL('app.get') --CALLS_ON--> VARIABLE('app')` — are present in FileResult.edges by the time
any domain plugin's `analyzeFile` method is invoked.

**Qualification:** CALLS_ON edges that pointed to cross-file identifiers (e.g., `express` itself
imported from the npm module) are NOT resolved in Stage 2 — they remain in `unresolvedRefs` and go
to Stage 3. But the plan's algorithm does not depend on those cross-file CALLS_ON edges. It depends
on:

1. `VARIABLE --ASSIGNED_FROM--> CALL('express')` — emitted immediately by the walk engine as a
   structural edge (not deferred). Always present in FileResult.edges.
2. Same-file CALLS_ON: `CALL('app.get') --CALLS_ON--> VARIABLE('app')` — resolved in Stage 2 via
   `scope_lookup`. Present in FileResult.edges by the time plugins run.

Both are confirmed. The algorithm in `_findExpressVarNames` does NOT use CALLS_ON edges at all —
it uses only ASSIGNED_FROM edges on VARIABLE nodes, which are always present (structural or Stage 2
scope_lookup).

---

## Edge case table

| Pattern | What actually happens | Handled? |
|---|---|---|
| `const app = express()` | `VARIABLE('app') --ASSIGNED_FROM--> CALL('express')`. Structural edge emitted immediately by walk engine via EDGE_MAP. | YES |
| `const app = require('express')()` | callee is CallExpression → `calleeName = '<computed>'`. VARIABLE('app') --ASSIGNED_FROM--> CALL('<computed>'). Phase 1 does not match `'express'`. | NO — known limitation, documented in 009 EC-6 |
| `let app; app = express()` | **INVESTIGATION IS WRONG HERE.** `visitAssignmentExpression` creates an EXPRESSION node (type: 'EXPRESSION', name: '='). The EDGE_MAP `'AssignmentExpression.right': { edgeType: 'ASSIGNED_FROM' }` emits `EXPRESSION --ASSIGNED_FROM--> CALL('express')`, NOT `VARIABLE('app') --ASSIGNED_FROM--> CALL('express')`. The VARIABLE('app') receives a `WRITES_TO` edge from the EXPRESSION node via deferred `scope_lookup`. The algorithm (Phase 1) looks for ASSIGNED_FROM edges FROM a VARIABLE node — it will NOT find this case. | NO — see critical note below |
| `const app = createApp()` | VARIABLE('app') --ASSIGNED_FROM--> CALL('createApp'). `CALL.name === 'createApp'`, not `'express'`. | NO — correct, out of scope |
| `const { Router } = require('express'); const r = Router()` | `visitVariableDeclarator` returns `EMPTY_RESULT` for destructuring (line 49: `if (decl.id.type !== 'Identifier') return EMPTY_RESULT`). No VARIABLE node for `Router`. CALL('Router') created, but no ASSIGNED_FROM edge from any VARIABLE to it. | NO — known limitation, documented in 008 |
| `const app = express(); const app2 = app` | `decl.init.type === 'Identifier'` → deferred scope_lookup for `'app'` with edgeType `'ASSIGNED_FROM'`. Stage 2 resolves to `VARIABLE('app2') --ASSIGNED_FROM--> VARIABLE('app')`. Phase 2 BFS in `_findExpressVarNames` handles this. | YES (Phase 2 alias chain) |
| `module.exports = express()` | MemberExpression assignment, not VariableDeclarator. No VARIABLE node for `module.exports`. ASSIGNED_FROM (from EDGE_MAP on `AssignmentExpression.right`) goes to the EXPRESSION node, not a VARIABLE. | NO — known limitation, documented in 008 |
| `export default express()` | No VariableDeclarator involved. The export visitor creates an EXPORT node. No VARIABLE --ASSIGNED_FROM--> CALL chain. | NO — documented in 009 EC-2 |

---

## Gaps found

### Gap 1 (CRITICAL): Investigation incorrectly describes `let app; app = express()`

Section 3 of 008-dataflow-investigation.md states:

> `AssignmentExpression.right` maps to `ASSIGNED_FROM` in EDGE_MAP. The `app = express()`
> assignment creates: `VARIABLE('app') --ASSIGNED_FROM--> CALL('express')`

**This is factually wrong.** Reading `visitAssignmentExpression` in `expressions.ts` (lines 582-620):

```typescript
const nodeId = ctx.nodeId('EXPRESSION', `assign`, line);
const result: VisitResult = {
  nodes: [{ id: nodeId, type: 'EXPRESSION', name: assign.operator, ... }],
  // ...
};
// Deferred: lhs writes to a variable
if (assign.left.type === 'Identifier') {
  result.deferred.push({ kind: 'scope_lookup', name: assign.left.name,
    fromNodeId: nodeId, edgeType: 'WRITES_TO', ... });
}
```

The `AssignmentExpression` visitor creates an EXPRESSION node. The EDGE_MAP entry
`'AssignmentExpression.right': { edgeType: 'ASSIGNED_FROM' }` causes the walk engine to emit:

```
EXPRESSION('=') --ASSIGNED_FROM--> CALL('express')
```

NOT:

```
VARIABLE('app') --ASSIGNED_FROM--> CALL('express')
```

The VARIABLE('app') gets a `WRITES_TO` edge FROM the EXPRESSION node (resolved in Stage 2 via
`scope_lookup`), not an ASSIGNED_FROM edge TO the CALL. The `_findExpressVarNames` algorithm scans
VARIABLE nodes for ASSIGNED_FROM edges and will find nothing for `let app; app = express()`.

**This pattern is therefore NOT handled** — the investigation's claim of "IS captured by the
algorithm" (section 3, point 3) is incorrect.

**Required action for implementor:** In `_findExpressVarNames`, document the correct limitation:

```typescript
// NOTE: Only VariableDeclarator init assignments are detected (const/let x = express()).
// Separate assignment expressions (let x; x = express()) are NOT detected because
// AssignmentExpression creates an EXPRESSION node, not a VARIABLE→ASSIGNED_FROM→CALL edge.
// This is an accepted limitation of the ASSIGNED_FROM traversal.
```

No code change needed for the algorithm — just correct the comment in the method body.

### Gap 2 (Minor): Alias chain Phase 2 uses `srcNode.name` not `srcNode.id` for lookup

In `_findExpressVarNames` Phase 2 (from 009-don-dataflow-update.md, lines 119-128):

```typescript
const srcNode = nodeById.get(assignEdge.dst);
if (!srcNode || srcNode.type !== 'VARIABLE') continue;
const srcKind = result.get(srcNode.name);
```

This looks up `srcNode.name` in `result`. If two VARIABLE nodes have the same name (shadowing in
different scopes), `result.get(srcNode.name)` may match the wrong node. Example:

```javascript
function outer() {
  const app = express();           // VARIABLE('app') in outer scope
  function inner() {
    const app = {};                // VARIABLE('app') in inner scope — shadows
    const server = app;            // ASSIGNED_FROM→ inner 'app', but result.get('app') = 'app-kind'
    server.get('/users', h);       // FALSE POSITIVE
  }
}
```

The Phase 2 code looks up `result.get(srcNode.name)` which is `'app'`, matching the outer
scope's Express assignment. The result: `server` incorrectly added to `expressVarNames`.

**Severity:** Low in practice (Express apps rarely shadow the app variable inside nested scopes
while also defining routes). However, the investigation's description of alias chain handling does
not mention this case. The Phase 2 algorithm should use node IDs, not names, for classification.

**Required action:** Phase 2 should maintain a `Map<string, 'app' | 'router'>` keyed on **node
ID**, not name. Both phases should key on node ID. The final map from name → kind can be derived at
the end:

```typescript
// Better: key on node ID throughout, derive name→kind only at end
const resultById = new Map<string, 'app' | 'router'>();
// ... phase 1: resultById.set(node.id, kind)
// ... phase 2: resultById.set(node.id, srcKind)
// Final: convert to name map
const result = new Map<string, 'app' | 'router'>();
for (const node of nodes) {
  const kind = resultById.get(node.id);
  if (kind) result.set(node.name, kind);
}
```

This eliminates the shadowing false positive.

### Gap 3 (Confirmed, accepted): `require('express')()` inline not detected

Already documented in 008 (section 4) and 009 (EC-6). No action needed. Verified that
`calleeName = '<computed>'` for outer call when callee is a CallExpression. The pattern
`const express = require('express'); const app = express()` (two-step) IS detected correctly.

### Gap 4 (Confirmed, accepted): Destructuring `const { Router } = require('express')` not detected

Already documented in 008 (section 2) and is a known core-v2 limitation (visitVariableDeclarator
returns EMPTY_RESULT for non-Identifier destructuring patterns at line 49 of declarations.ts).
No action needed for this issue.

---

## Summary

The data flow approach is correct for the primary cases (`const app = express()` and
`const router = express.Router()`). The three-phase structure (single-hop detection + alias BFS +
early return) is logically sound.

**One claim in 008 is factually wrong** (Gap 1): `let app; app = express()` does NOT produce
`VARIABLE --ASSIGNED_FROM--> CALL('express')`. The investigation claimed this pattern IS handled —
it is NOT. The implementor must document this limitation in code comments and must NOT attempt to
implement the described behavior (which would require searching for EXPRESSION nodes' WRITES_TO
targets, which is a different traversal path entirely).

**Gap 2** (ID-vs-name keying in alias BFS) is a correctness issue for shadowed variables. It is
recommended to fix before implementation but is not blocking for typical Express codebases.

**Conditions for APPROVE:**
1. Implementor adds accurate comment in `_findExpressVarNames` stating that `let app; app = expr()`
   is NOT detected (correcting the misinformation in 008 section 3).
2. Either: (a) adopt the ID-keyed Phase 2 approach to eliminate the shadowing false positive (Gap 2),
   or (b) document the limitation explicitly in code comments.

Both are documentation/comment-level changes. The core algorithm logic in 009-don-dataflow-update.md
is approved as written, subject to these conditions.
