# REG-492: Plan — Link CALL Nodes to IMPORT Nodes for External Library Calls

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-19

---

## Phase 1: Exploration Findings

### 1. FunctionCallResolver — What It Does

**File:** `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

FunctionCallResolver is an ENRICHMENT phase plugin with `dependencies: ['ImportExportLinker']`. It:

1. Indexes all IMPORT nodes (relative only — `./` or `../` source)
2. Indexes all FUNCTION nodes by file
3. Indexes all EXPORT nodes by file
4. For each unresolved CALL node (no `object` field, no existing CALLS edge):
   - Looks up `${file}:${calledName}` in the import index
   - Follows `IMPORTS_FROM` edge from IMPORT to EXPORT
   - Resolves re-export chains (including to external modules)
   - Creates `CALLS` edge to FUNCTION or EXTERNAL_MODULE

**Critical observation:** FunctionCallResolver explicitly skips non-relative imports at step 1 (`isRelative` check line 84). This means CALL nodes matching direct external imports (like `import { Router } from 'express'`) are left unresolved and handed off to ExternalCallResolver.

### 2. ExternalCallResolver — The Direct Predecessor

**File:** `packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

`dependencies: ['FunctionCallResolver']`. It:

1. Indexes all IMPORT nodes (non-relative only — external packages)
2. For each unresolved CALL node (no `object`, no CALLS edge):
   - Skips JS builtins
   - Skips dynamic calls
   - Finds matching IMPORT by `${file}:${calledName}`
   - Creates or reuses `EXTERNAL_MODULE` node
   - Creates `CALLS` edge to EXTERNAL_MODULE with `metadata.exportedName`

**Key finding:** ExternalCallResolver already handles direct external import CALL nodes. It creates `CALL -> CALLS -> EXTERNAL_MODULE`. The problem is it creates NO edge to the IMPORT node itself. The link is CALL → EXTERNAL_MODULE (the package), not CALL → IMPORT (the specific binding).

### 3. IMPORT Node Structure

**File:** `packages/core/src/core/nodes/ImportNode.ts`

Semantic ID format: `${file}:IMPORT:${source}:${name}`

Example: `/project/app.js:IMPORT:express:Router`

Fields:
- `id`: `${file}:IMPORT:${source}:${localName}`
- `type`: `'IMPORT'`
- `name`: local binding name (what's used in code)
- `file`: absolute path
- `source`: module specifier (`'express'`, `'./utils'`)
- `importType`: `'default'` | `'named'` | `'namespace'`
- `importBinding`: `'value'` | `'type'` | `'typeof'`
- `imported`: original name in source module (e.g., `'default'`, `'Router'`, `'*'`)
- `local`: local binding name (same as `name`)
- `isDynamic?`, `isResolvable?`, `dynamicPath?`, `sideEffect?`

### 4. CALL Node Structure

CALL nodes are created by `CallExpressionVisitor` and handlers in `analyzeFunctionBody`. Key fields:
- `id`: content-hash-based ID
- `type`: `'CALL'`
- `name`: callee name (e.g., `'Router'`, `'express.Router'`, `'map'`)
- `file`: absolute path where call occurs
- `object?`: present for method calls (e.g., `'express'` in `express.Router()`)
- `method?`: method name for method calls (e.g., `'Router'` in `express.Router()`)
- `isNew?`: true for `new Constructor()` calls
- `isAwaited?`: true if `await`ed
- `parentScopeId`: scope containing the call

### 5. HANDLED_BY — Existing Usage Pattern

`HANDLED_BY` is a well-established edge type in the graph, used by:
- `ExpressHandlerLinker`: `http:route -> HANDLED_BY -> FUNCTION`
- `ModuleRuntimeBuilder`: `event:listener -> HANDLED_BY -> FUNCTION`
- `ExpressRouteAnalyzer`: `MIDDLEWARE -> HANDLED_BY -> FUNCTION`

The edge type is registered in `typeValidation.ts` and assigned numeric ID 17 in `GraphBackend.ts`.

**Semantics:** `HANDLED_BY` means "this node's behavior is implemented by the target." For routes, it points to the handler function. For our use case: CALL is handled by the imported binding — which is semantically correct. `Router()` is handled by the `Router` IMPORT binding.

### 6. Enrichment Pipeline Order

Dependencies determine execution order (not explicit priority numbers — those mentioned in comments are stale). The chain for call resolution:

```
ImportExportLinker
  -> FunctionCallResolver (depends on ImportExportLinker)
    -> ExternalCallResolver (depends on FunctionCallResolver)
      -> CallbackCallResolver (depends on FunctionCallResolver)
      -> RejectionPropagationEnricher (depends on FunctionCallResolver)
      -> CallResolverValidator (depends on FunctionCallResolver, ExternalCallResolver)
```

A new enricher for CALL → IMPORT edges needs to run AFTER `ExternalCallResolver` so it doesn't interfere with the CALLS edge resolution, OR it runs in parallel (same dependency tier) if we're careful.

### 7. The Core Problem Re-Stated

The real problem is: enrichment plugins like ExpressRouteAnalyzer that want to find "all calls to express-imported functions" cannot do a simple graph query. They must fall back to AST pattern matching. The fix is: for every CALL node matched to an external IMPORT, create a direct CALL → HANDLED_BY → IMPORT edge.

**What ExternalCallResolver gives us today:**
```
CALL[Router] -> CALLS -> EXTERNAL_MODULE[express]
```

**What we need to add:**
```
CALL[Router] -> HANDLED_BY -> IMPORT[/app.js:IMPORT:express:Router]
```

This is complementary, not conflicting.

---

## Phase 2: The Plan

### Decision: Extend ExternalCallResolver vs New Enricher?

**Answer: Extend ExternalCallResolver.**

Reasons:
1. ExternalCallResolver already does the exact same loop: iterate CALL nodes, find matching IMPORT, act on it. Adding HANDLED_BY edges is a trivial extension of steps 4.3–4.6.
2. The matching logic is identical — same `${file}:${calledName}` import index lookup.
3. Avoids a second full scan of all CALL nodes and IMPORT nodes.
4. No new dependency chain needed.
5. Single logical change: "when we find an external call that matches an import, also create HANDLED_BY edge to that import."

The only reason to create a new enricher would be if we needed HANDLED_BY edges WITHOUT CALLS edges. We don't — the use case is always "find calls to library X," which works best when both edges exist.

**What to change in ExternalCallResolver:**

In step 4.6 (currently creates CALLS edge to EXTERNAL_MODULE), also create a `HANDLED_BY` edge from the CALL node to the IMPORT node. The IMPORT node ID is predictable: `${file}:IMPORT:${source}:${localName}`.

The IMPORT node already exists at this point (built in step 1 as `importIndex`). We have `imp.id` directly from the index entry.

### Matching Logic

ExternalCallResolver uses `importIndex` keyed by `${file}:${local}`. This correctly handles:

| Import Pattern | IMPORT.name | IMPORT.local | CALL.name | Match? |
|---------------|-------------|--------------|-----------|--------|
| `import express from 'express'` | `express` | `express` | `express` | YES — but this is a method call `express()` not typical |
| `import { Router } from 'express'` | `Router` | `Router` | `Router` | YES |
| `import { Router as R } from 'express'` | `R` | `R` | `R` | YES — CALL uses local name |
| `import * as express from 'express'` | `express` | `express` | — | NO (namespace calls are method calls, not direct calls) |
| `import express from 'express'; express()` | `express` | `express` | `express` | YES |

### Edge Cases to Address

#### 1. Default imports (`import express from 'express'`)

When called directly: `express()` — CALL.name = `'express'`, IMPORT.local = `'express'`. The import index already has this keyed as `${file}:express`. Match works. ExternalCallResolver already handles this via `exportedName = imp.imported || calledName` (imp.imported = `'default'`).

HANDLED_BY edge to IMPORT node is correct and useful: it identifies the specific default import binding.

#### 2. Named imports (`import { Router } from 'express'`)

CALL.name = `'Router'`. IMPORT.local = `'Router'`. Direct match. This is the 758-case scenario from the problem statement. Standard case, fully covered.

#### 3. Namespace imports (`import * as express from 'express'`)

`express.Router()` creates a CALL with `name: 'express.Router'` and `object: 'express'`. The `object` field is present, so ExternalCallResolver (and our extension) skips it at the method-call guard. These are method calls — MethodCallResolver handles them.

We do NOT create HANDLED_BY edges for namespace method calls. This is correct — the semantics differ. The correct edge for `express.Router()` would be `CALL -> CALLS -> EXTERNAL_MODULE[express]` (which MethodCallResolver or a future enricher would create), not HANDLED_BY to the namespace IMPORT.

#### 4. Re-exports

`import { map } from './utils'` where `utils.js` re-exports from `lodash` — this is a RELATIVE import. ExternalCallResolver skips it (only handles non-relative). FunctionCallResolver handles it, creating `CALLS -> EXTERNAL_MODULE`. No HANDLED_BY edge to IMPORT for re-exports via FunctionCallResolver. This is acceptable — the IMPORT in this case points to an internal module, and HANDLED_BY to IMPORT only makes sense for direct external imports where the IMPORT node IS the library binding.

If we want HANDLED_BY for re-exports too, that would be a separate, larger change. Out of scope for REG-492.

#### 5. Destructured imports used as method calls (`Router()` from `import { Router } from 'express'`)

This is the standard named import case. CALL.name = `'Router'`, no `object` field. IMPORT.local = `'Router'`. Direct match. This IS the main use case.

#### 6. Member expression calls (`express.Router()`)

`object: 'express'`, skipped by ExternalCallResolver. Out of scope. MethodCallResolver handles CALLS edges here; HANDLED_BY is not appropriate from CALL to IMPORT for method calls.

#### 7. Aliased imports (`import { Router as R } from 'express'`)

CALL.name = `'R'` (local alias). IMPORT.local = `'R'`, IMPORT.imported = `'Router'`. Import index key is `${file}:R`. Match works. HANDLED_BY edge to IMPORT[`${file}:IMPORT:express:R`] is correct — the IMPORT node already carries `imported: 'Router'` for downstream consumers to know the original name.

#### 8. Dynamic imports

ExternalCallResolver already skips `callNode.isDynamic`. We inherit this guard.

#### 9. Duplicate HANDLED_BY edges

We must guard against creating a HANDLED_BY edge if one already exists (same as the CALLS edge guard). The simplest approach: check existing HANDLED_BY edges before creating, OR use the same "already resolved" gate from step 2 (`existingEdges` check on CALLS). Since HANDLED_BY and CALLS are created in the same step, if CALLS already exists the node was resolved in a previous run — skip both.

#### 10. Type-only imports (`import type { Foo } from 'bar'`)

IMPORT.importBinding = `'type'`. In runtime code, no CALL node would have the same name in a call context (TypeScript type imports don't generate runtime calls). However, we should NOT create HANDLED_BY edges for `importBinding: 'type'` since there's no runtime relationship. We should add this guard.

### What NOT to Touch

- **FunctionCallResolver** — handles relative imports → FUNCTION/EXTERNAL_MODULE chains. No change needed. The HANDLED_BY extension only applies to direct external imports (ExternalCallResolver's domain).
- **Existing CALL → CALLS → FUNCTION edges** — not affected. ExternalCallResolver only processes CALL nodes that don't already have CALLS edges.
- **Existing CALL → CALLS → EXTERNAL_MODULE edges** — ExternalCallResolver continues to create these. We add HANDLED_BY in the same step, not instead of.
- **MethodCallResolver** — handles method calls (have `object` field). Not affected.
- **ImportExportLinker** — creates IMPORTS_FROM edges. Not affected.

### Implementation Location

**File:** `packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

**Changes:**
1. In `execute()`: after step 4.6 (CALLS edge to EXTERNAL_MODULE), add step 4.7: create `HANDLED_BY` edge from `callNode.id` to `imp.id`.
2. Add guard: skip if `imp.importBinding === 'type'`.
3. Update `metadata.creates.edges` to include `'HANDLED_BY'`.
4. Update `metadata.produces` to include `'HANDLED_BY'`.
5. Update counters/stats to track `handledByEdgesCreated`.

The change is approximately 10-15 lines of additional code.

### Updated Metadata Declaration

```typescript
get metadata(): PluginMetadata {
  return {
    name: 'ExternalCallResolver',
    phase: 'ENRICHMENT',
    creates: {
      nodes: ['EXTERNAL_MODULE'],
      edges: ['CALLS', 'HANDLED_BY']   // ADD HANDLED_BY
    },
    dependencies: ['FunctionCallResolver'],
    consumes: ['CALLS'],
    produces: ['CALLS', 'HANDLED_BY']  // ADD HANDLED_BY
  };
}
```

---

## Test Plan

### Unit Tests

**File:** `test/unit/ExternalCallResolver.test.js` (extend existing)

Tests to add:

1. **Named import → HANDLED_BY edge created**
   - `import { Router } from 'express'; Router()`
   - Assert: `CALL[Router] -> HANDLED_BY -> IMPORT[file:IMPORT:express:Router]`
   - Assert: CALLS edge to EXTERNAL_MODULE still created

2. **Default import → HANDLED_BY edge created**
   - `import express from 'express'; express()`
   - Assert: `CALL[express] -> HANDLED_BY -> IMPORT[file:IMPORT:express:express]`

3. **Aliased import → HANDLED_BY edge to local-name IMPORT**
   - `import { Router as R } from 'express'; R()`
   - Assert: `CALL[R] -> HANDLED_BY -> IMPORT[file:IMPORT:express:R]`
   - IMPORT.imported = `'Router'` (original name preserved in node)

4. **Type-only import → NO HANDLED_BY edge**
   - `import type { Foo } from 'bar'; Foo()`
   - Assert: no HANDLED_BY edge (importBinding = 'type')

5. **Method call (namespace import) → NO HANDLED_BY edge**
   - `import * as express from 'express'; express.Router()`
   - Assert: no HANDLED_BY edge (has `object` field, skipped)

6. **Existing CALLS edge → no HANDLED_BY duplicate**
   - Pre-seed a CALLS edge on the CALL node
   - Run resolver
   - Assert: no new HANDLED_BY edge created (node already resolved)

7. **Multiple files → correct file isolation**
   - Same import name in two files (`Router` in `a.js` and `b.js`)
   - Assert: HANDLED_BY edges point to correct per-file IMPORT nodes

8. **Regression: CALLS edge still created**
   - Ensure existing behavior preserved: CALLS to EXTERNAL_MODULE still works

### Integration Test (cross-service fixture)

The fixture at `test/fixtures/09-cross-service/` may be a good place to add or verify the new edges. Alternatively, add a new small fixture with an Express-like import pattern.

### Datalog Query Test

After implementation, verify that the graph can answer:
```datalog
?call HANDLED_BY ?import, ?import[source] = "express"
```

This is the core use case: enrichment plugins querying "find all calls to express imports."

---

## Summary

| Decision | Choice | Reason |
|---------|--------|--------|
| New enricher vs extend existing | Extend ExternalCallResolver | Same loop, same data, no new scan |
| Edge type | HANDLED_BY | Established type, correct semantics, registered in typeValidation |
| Scope | Direct external imports only | Re-exports via relative IMPORT chains are out of scope |
| Method calls (namespace) | Excluded | Have `object` field, different semantics |
| Type imports | Excluded | Guard on importBinding === 'type' |
| Both CALLS and HANDLED_BY | Yes, both created | CALLS = coarse (to package), HANDLED_BY = fine (to specific binding) |
| LOC change | ~15 lines | Small, contained, low risk |

### Risk Assessment

- **Performance:** One additional `addEdge()` call per resolved external call. Negligible — same order as existing CALLS creation.
- **Correctness:** ExternalCallResolver already correctly identifies the imp node. We're just adding one more edge from the existing `callNode.id` to the existing `imp.id`. No new index lookups needed.
- **Backwards compatibility:** Additive change only. No existing edges removed or modified.
- **Existing tests:** All existing ExternalCallResolver tests continue to pass — we only ADD new assertions for HANDLED_BY.

---

## References

- [Call Graphs: Bread and Butter of Program Analysis](https://www.guardsquare.com/blog/call-graphs-the-bread-and-butter-of-program-analysis)
- [Semantic Code Graph — an information model](https://arxiv.org/html/2310.02128v2)
- [Codebase Knowledge Graph with Neo4j](https://neo4j.com/developer-blog/codebase-knowledge-graph/)
