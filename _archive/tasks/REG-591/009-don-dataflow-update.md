# REG-591: ExpressPlugin Dataflow Update — Delta from Original Spec

**Author:** Don Melton, Tech Lead
**Date:** 2026-03-01
**Supersedes:** Parts of 004-joel-tech-spec.md (Commit 4) that rely on `EXPRESS_OBJECTS` hardcoded set
**Based on:** 008-dataflow-investigation.md

---

## What Changed and Why

The original spec used a hardcoded set `EXPRESS_OBJECTS = new Set(['app', 'router', 'Router'])` to
decide whether a CALL node is an Express route registration. This is a heuristic: any variable named
`app` triggers route detection, regardless of whether it actually holds an Express instance.

The investigation in 008-dataflow-investigation.md confirms that FileResult contains sufficient
information to determine this from data flow: VARIABLE nodes have ASSIGNED_FROM edges that point to
the CALL that created the value. We can follow those edges to detect whether a variable was assigned
from `express()` or `express.Router()` — without guessing by name.

This document is a delta. Only what changes from the original spec is described here. Everything in
004-joel-tech-spec.md and 006-don-plan-fixes.md that is not mentioned below remains in force.

---

## Change 1: Remove `EXPRESS_OBJECTS` constant, add `_findExpressVarNames`

### What goes away

In `packages/core/src/plugins/domain/ExpressPlugin.ts`, remove:

```typescript
// Variable names that typically hold an Express app or router.
// This is a heuristic. The import check is the primary guard.
const EXPRESS_OBJECTS = new Set(['app', 'router', 'Router']);
```

This constant is no longer referenced anywhere.

### What replaces it

Add a private method `_findExpressVarNames` to the `ExpressPlugin` class. This method builds the
set of variable names dynamically by traversing the graph, instead of checking a static list of
names.

```typescript
/**
 * Scan FileResult to find all variable names that hold Express app or router instances.
 *
 * Algorithm:
 *   For each VARIABLE node in the file:
 *     Follow all ASSIGNED_FROM edges from that VARIABLE.
 *     If the edge destination is a CALL node with:
 *       name === 'express'            → variable holds an Express app
 *       name === 'express.Router'     → variable holds an Express router
 *     Then add the VARIABLE's name to the result set.
 *
 *   For alias chains (const server = app):
 *     If ASSIGNED_FROM destination is a VARIABLE that is already in the result set,
 *     add the current VARIABLE's name to the result set.
 *     Repeat until no new names are added (BFS convergence).
 *
 * @returns Map from variable name to 'app' | 'router'
 */
private _findExpressVarNames(fileResult: Readonly<FileResult>): Map<string, 'app' | 'router'> {
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

  // Phase 1: single-hop detection — VARIABLE --ASSIGNED_FROM--> CALL('express' | 'express.Router')
  const result = new Map<string, 'app' | 'router'>();

  for (const node of nodes) {
    if (node.type !== 'VARIABLE') continue;

    const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
      .filter(e => e.type === 'ASSIGNED_FROM');

    for (const assignEdge of assignedFromEdges) {
      const srcNode = nodeById.get(assignEdge.dst);
      if (!srcNode || srcNode.type !== 'CALL') continue;

      if (srcNode.name === 'express') {
        result.set(node.name, 'app');
        break;
      }

      if (
        srcNode.name === 'express.Router'
        || (srcNode.metadata?.object === 'express' && srcNode.metadata?.method === 'Router')
      ) {
        result.set(node.name, 'router');
        break;
      }
    }
  }

  // Phase 2: alias chain resolution — VARIABLE --ASSIGNED_FROM--> VARIABLE (already known)
  // Runs until convergence (no new additions). Handles: const server = app; server.get(...)
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.type !== 'VARIABLE') continue;
      if (result.has(node.name)) continue; // already classified

      const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
        .filter(e => e.type === 'ASSIGNED_FROM');

      for (const assignEdge of assignedFromEdges) {
        const srcNode = nodeById.get(assignEdge.dst);
        if (!srcNode || srcNode.type !== 'VARIABLE') continue;

        const srcKind = result.get(srcNode.name);
        if (srcKind !== undefined) {
          result.set(node.name, srcKind);
          changed = true;
          break;
        }
      }
    }
  }

  return result;
}
```

**Big-O:** Phase 1 is O(V * E_avg) where V = VARIABLE node count, E_avg = average ASSIGNED_FROM
edges per node (typically 1). Phase 2 is O(V^2) worst case (alias chain of length V), but in
practice Express files have at most a handful of variables. Total cost per file is negligible.

---

## Change 2: Update `analyzeFile` to use data flow instead of `EXPRESS_OBJECTS`

### Original guard in `analyzeFile` (spec line 783)

```typescript
if (!EXPRESS_OBJECTS.has(obj)) continue;
```

### Replacement

Call `_findExpressVarNames` once at the top of `analyzeFile`, then use the returned map instead
of the removed set.

**Updated `analyzeFile` method:**

```typescript
analyzeFile(fileResult: Readonly<FileResult>, _ast: File): DomainPluginResult {
  // Guard: only process files that depend on 'express'.
  // With the dataflow approach, we can simplify: if no variables are assigned from
  // express() or express.Router(), expressVarNames will be empty and we return early.
  const expressVarNames = this._findExpressVarNames(fileResult);
  if (expressVarNames.size === 0) {
    return { nodes: [], edges: [] };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Find the MODULE node for EXPOSES/MOUNTS edges.
  const moduleNode = fileResult.nodes.find(n => n.type === 'MODULE');

  for (const node of fileResult.nodes) {
    if (node.type !== 'CALL') continue;

    const meta = node.metadata;
    if (!meta) continue;

    const obj = meta.object as string | undefined;
    const method = meta.method as string | undefined;
    const argValues = meta.argValues as (string | null)[] | undefined;

    if (!obj || !method) continue;

    // Data-flow check: only process calls on variables we know hold Express instances.
    if (!expressVarNames.has(obj)) continue;

    if (HTTP_METHODS.has(method)) {
      // Route registration: app.get('/path', handler)
      // Require at least one argument AND argValues[0] is a string.
      if (!argValues || argValues.length < 1 || argValues[0] === null) continue;

      const path = argValues[0];
      const httpMethod = method === 'all' ? 'ALL' : method.toUpperCase();
      const routeNode = this._createHttpRouteNode(node, httpMethod, path);
      nodes.push(routeNode);

      if (moduleNode) {
        edges.push({
          src: moduleNode.id,
          dst: routeNode.id,
          type: 'EXPOSES',
        });
      }
    } else if (method === 'use') {
      // Router mounting: app.use('/prefix', router) or app.use(middleware)
      this._processMountPoint(node, argValues ?? [], moduleNode ?? null, nodes, edges);
    }
  }

  return { nodes, edges };
}
```

---

## Change 3: Remove `_importsExpress` method

The original spec (and 006-don-plan-fixes.md Gap 3 and Gap 4) added a two-pass `_importsExpress`
method as the entry guard. With the dataflow approach, this guard is no longer needed as a separate
step. The guard is now implicit: `_findExpressVarNames` returns an empty map when no variables are
assigned from `express()`, and `analyzeFile` returns early in that case.

**Remove the entire `_importsExpress` private method from `ExpressPlugin`.**

The Gap 3 JSDoc update and Gap 4 code replacement from 006-don-plan-fixes.md are superseded by this
removal. Do not implement either.

**Rationale:** The original `_importsExpress` checked for EXTERNAL_MODULE nodes with
`name === 'express'` to determine if the file uses Express. The new approach is strictly more
precise: we require that a variable was actually assigned from an express() or express.Router() call
— not just that the module was imported. A file that imports express but never assigns it to a
variable (unusual, but possible) will produce no routes, which is correct.

---

## Change 4: Updated node ID format — `mountedOn` reflects actual variable name

This is not a structural ID change, but a behavioral clarification.

In `_createHttpRouteNode`:

```typescript
metadata: {
  method,
  path,
  mountedOn: callNode.metadata?.object as string,
},
```

`callNode.metadata?.object` is the actual variable name from the AST (`'app'`, `'server'`,
`'myRouter'`, etc.). With the dataflow approach, `expressVarNames` already validated that this
name refers to an Express instance. So `mountedOn` now accurately reflects the actual variable
name used in code, not a static string from a hardcoded set.

No code change needed — this is correct behavior inherited from the existing `_createHttpRouteNode`
implementation. The clarification is: implementors should NOT normalize or replace `mountedOn` with
a canonical name like `'app'`. Keep the actual variable name from the AST.

---

## Change 5: Updated test cases

The following test changes apply to `packages/core/test/unit/express-plugin.test.js`.

### Test 1: Use `const server = express()` as additional variant (new test)

The original Test 1 used `const app = express()`. Add a new test verifying that ANY variable name
assigned from `express()` is detected — not just `app`.

**Add after Test 1:**

```javascript
test('detects GET route when app variable has non-standard name', async () => {
  const code = `
    import express from 'express';
    const server = express();
    server.get('/users', handler);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNode = result.nodes.find(n => n.type === 'http:route');
  assert.ok(routeNode, 'http:route node created for non-standard variable name');
  assert.equal(routeNode.metadata.method, 'GET');
  assert.equal(routeNode.metadata.path, '/users');
  assert.equal(routeNode.metadata.mountedOn, 'server');
});
```

### Test 3 replacement: router detection via `express.Router()` assignment

Original Test 3 relied on `router` being in `EXPRESS_OBJECTS`. It should now verify the data flow:
the route is detected because `router` was assigned from `express.Router()`, not because its name
is `'router'`.

**Replace Test 3 with:**

```javascript
test('detects route on variable assigned from express.Router()', async () => {
  const code = `
    import express from 'express';
    const myRouter = express.Router();
    myRouter.get('/items', handler);
  `;
  const result = await walkFile(code, 'src/routes.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNode = result.nodes.find(n => n.type === 'http:route');
  assert.ok(routeNode, 'http:route created for express.Router() variable');
  assert.equal(routeNode.metadata.mountedOn, 'myRouter');
});
```

### New Test: alias chain detection

```javascript
test('detects routes on aliased Express variable', async () => {
  const code = `
    import express from 'express';
    const app = express();
    const server = app;
    server.get('/ping', handler);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNode = result.nodes.find(n => n.type === 'http:route');
  assert.ok(routeNode, 'http:route created for aliased Express variable');
  assert.equal(routeNode.metadata.mountedOn, 'server');
});
```

### New Test: non-express variable with same-name guard

Verify that a variable named `app` that is NOT assigned from `express()` does NOT produce routes.

```javascript
test('skips routes on non-express variable even if named app', async () => {
  const code = `
    import express from 'express';
    const app = {};
    app.get('/users', handler);
  `;
  const result = await walkFile(code, 'src/other.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNodes = result.nodes.filter(n => n.type === 'http:route');
  assert.equal(routeNodes.length, 0, 'No route nodes for non-express object named app');
});
```

Note: this replaces the original Test 6 (non-express file guard via `_importsExpress`). The behavior
is the same — no routes created — but the mechanism is different. The early return now comes from
`expressVarNames.size === 0` rather than from `_importsExpress` returning false.

### Update Test 7 (import but no routes)

The original Test 7 (`import express from 'express'` with no routes) still passes with the new
implementation. The `import express from 'express'` statement alone does not create a VARIABLE node
assigned from `express()`, so `_findExpressVarNames` returns an empty map and the method returns
early. No change to Test 7 code is needed.

---

## Edge Cases Introduced

### EC-1: Import without assignment

```javascript
import express from 'express';
// express imported but never used to create app or router
```

`expressVarNames` is empty. Returns `{ nodes: [], edges: [] }`. Correct.

### EC-2: Re-export pattern

```javascript
import express from 'express';
export default express();
```

No VARIABLE node is created for `export default express()`. `expressVarNames` is empty. Any routes
defined via the exported value in another file are not detectable in this file. This is a known
limitation (same as the original `module.exports.app = express()` limitation documented in 008).
Acceptable: out-of-scope for this issue.

### EC-3: Multiple apps in one file

```javascript
const app1 = express();
const app2 = express();
app1.get('/a', h1);
app2.post('/b', h2);
```

Both `app1` and `app2` are added to `expressVarNames`. Both routes are detected. Correct.

### EC-4: Reassignment

```javascript
let app = express();
app = {};           // reassigned to plain object
app.get('/a', h1); // should NOT be detected
```

The `ASSIGNED_FROM` edge from the assignment expression `app = {}` is emitted by
`AssignmentExpression.right` in EDGE_MAP. However, `{}` is an ObjectExpression, not a CALL — so
it produces no CALL node to match against. But the earlier `ASSIGNED_FROM` from `app = express()`
is also in the graph. The algorithm detects `app` as an Express variable because of the first
assignment. This is a false positive for reassigned variables.

**Accepted limitation:** reassignment detection requires control flow analysis, which is out of scope
for a static ASSIGNED_FROM traversal. Document in code comment. Same class of limitation as the
original heuristic approach.

### EC-5: CommonJS pattern `const express = require('express'); const app = express();`

```javascript
const express = require('express');
const app = express();
app.get('/users', handler);
```

`VARIABLE('express')` is assigned from `CALL('require')`, not from `CALL('express')` — the
CALL name here is `'require'`. So `express` itself is NOT added to `expressVarNames`.

However, `VARIABLE('app')` is assigned from `CALL('express')` — the call name is `'express'`
because `express()` is invoked as an identifier. This IS detected by Phase 1.

Result: `expressVarNames = { 'app' → 'app' }`. Route detection works. Correct.
(Investigation 008, Question 4 note: this case is confirmed to work.)

### EC-6: `const app = require('express')()` (inline chained call)

```javascript
const app = require('express')();
```

The outer call's callee is a CallExpression. `visitCallExpression` sets `calleeName = '<computed>'`
for this case. `VARIABLE('app')` is assigned from `CALL('<computed>')`. Phase 1 does not match
`name === 'express'` or `name === 'express.Router'`. Not detected.

**Accepted limitation:** same limitation as original 008 investigation (Section 4). Document in
code comment. The workaround is to use the two-step CJS pattern (EC-5 above).

---

## Summary of Spec Delta

| Location in 004/006 | Original | Replacement |
|---|---|---|
| `EXPRESS_OBJECTS` constant | `new Set(['app', 'router', 'Router'])` | Removed |
| `analyzeFile` entry guard | `_importsExpress(fileResult)` | `_findExpressVarNames(fileResult).size === 0` |
| Object name check | `EXPRESS_OBJECTS.has(obj)` | `expressVarNames.has(obj)` |
| `_importsExpress` method | Two-pass EXTERNAL node scan (Gap 4 fix) | Removed entirely |
| New private method | — | `_findExpressVarNames(fileResult)` |
| Test 3 | Relies on `'router'` in `EXPRESS_OBJECTS` | Variable assigned from `express.Router()` |
| New tests | — | Non-standard name, alias chain, false-negative guard for `{}` |

### Commits not affected

- Commit 1 (argValues): no change.
- Commit 2 (DomainPlugin types): no change.
- Commit 3 (walkFile hook): no change.
- Commit 5 (CoreV2Analyzer wiring): no change.

### Commit 4 affected sections

- `ExpressPlugin.ts` complete file structure: replace as described above.
- Remove `EXPRESS_OBJECTS` constant.
- Remove `_importsExpress` method.
- Add `_findExpressVarNames` method.
- Update `analyzeFile` entry guard.
- Update `analyzeFile` object name check.
- Test file: add/replace tests as described above.
- Node ID format doc comment: no change (column suffix from Gap 5 in 006 still applies).
