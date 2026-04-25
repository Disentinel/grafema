# REG-543: Don Melton Tech Lead Plan v3 — Polymorphic Target Expansion (Bug-Fixed)

## What Changed from v2

Dijkstra's v2 review identified two bugs. This v3 plan fixes both before Rob implements.

### Bug 1 (HIGH, fixed): `findMethodInNode` on INTERFACE nodes always returned null

**Root cause (verified by reading source):**

TypeScriptVisitor.ts lines 310-319: `TSMethodSignature` members are collected into an
`InterfacePropertyInfo[]` array and stored in `InterfaceDeclarationInfo.properties`.
`TypeSystemBuilder.bufferInterfaceNodes` writes this array as JSON metadata on the INTERFACE
node (`properties` field, type `InterfacePropertyRecord[]`). **No separate FUNCTION or METHOD
graph nodes are created for interface method signatures.**

`InterfaceNode.ts` confirms the schema:
```typescript
interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  column: number;
  extends: string[];
  properties: InterfacePropertyRecord[];  // { name, type, optional, readonly }
  isExternal?: boolean;
}
```

Therefore, `getOutgoingEdges(interfaceId, ['CONTAINS'])` on an INTERFACE node returns nothing
useful for method lookup. The v2 `findMethodInNode` would always return `null` for INTERFACE
ancestors, silently skipping them.

**The fix:** `findMethodInNode` must branch on node type:
- For **CLASS** nodes: use CONTAINS edge traversal (existing approach — correct)
- For **INTERFACE** nodes: fetch the node directly, parse its `properties` JSON array, check
  if any entry has `name === methodName`. If found, return the **INTERFACE node's own ID** as
  a proxy identifier in the result set.

**Why return the INTERFACE node's own ID?**

When `MethodCallResolver` resolves a call on an interface-typed receiver, it creates a
`CALLS` edge pointing to the INTERFACE node itself (not to a non-existent FUNCTION child).
See MethodCallResolver — `buildInterfaceMethodIndex` + `resolveViaInterfaceCHA`. If Grafema's
MethodCallResolver was able to resolve the call to the interface, the CALLS edge target is
the INTERFACE node. Adding that node's ID to the expanded target set lets the BFS find those
CALLS edges via `getIncomingEdges(interfaceId, ['CALLS'])`.

If MethodCallResolver could NOT resolve the call (parameter-typed receiver, no type info),
no CALLS edge exists to the INTERFACE node either. In that case the `findByAttr` fallback
handles it (finds CALL nodes by bare method name attribute — which are unresolved calls with
no CALLS edge at all).

**Net coverage for TypeScript interface scenario:**
- Resolved calls (MethodCallResolver found the interface): covered via INTERFACE node in
  expanded set → CALLS edge lookup
- Unresolved calls (no type info): covered via `findByAttr` fallback
- Neither path involves CONTAINS traversal on INTERFACE nodes

### Bug 2 (MEDIUM, fixed): `findByAttr` was firing for every BFS node

**Root cause:** The v2 plan modified `findCallsToNode` to accept `methodName?` and passed it
from the BFS loop for every `id` visited. Transitive callers at depth 1, 2, ... maxDepth
would trigger `findByAttr({ nodeType: 'CALL', method: methodName })` on every hop —
returning the same full result set each time. The `seen` dedup set prevented double-counting
but the redundant graph queries were O(BFS_size × findByAttr_cost).

**The fix:** Track the initial target ID set before BFS starts. Only pass `methodName` to
`findCallsToNode` when the current BFS node ID is in that initial set.

```typescript
const initialTargetIds = new Set(targetIds);

// In BFS loop:
const containingCalls = await findCallsToNode(
  backend,
  id,
  initialTargetIds.has(id) ? methodName : undefined
);
```

`findByAttr` now runs exactly once per initial target ID, not once per BFS node.

---

## Full Corrected Algorithm

### New helper: `extractMethodName`

```typescript
/**
 * Extract bare method name from a possibly-qualified name.
 * "RFDBServerBackend.addNode" → "addNode"
 * "addNode" → "addNode"
 */
function extractMethodName(fullName: string): string {
  if (!fullName) return '';
  const dotIdx = fullName.lastIndexOf('.');
  return dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
}
```

### New helper: `findMethodInNode` (v3, handles both CLASS and INTERFACE)

```typescript
/**
 * Find a method/property with the given name in a CLASS or INTERFACE node.
 *
 * For CLASS nodes: traverses CONTAINS edges and checks child FUNCTION nodes by name.
 * For INTERFACE nodes: reads the node's `properties` JSON array directly (interface
 *   method signatures are NOT stored as separate graph nodes).
 *
 * Returns:
 * - For CLASS: the FUNCTION child node's ID (the actual method node in the graph)
 * - For INTERFACE: the INTERFACE node's own ID (used as proxy; MethodCallResolver
 *   creates CALLS edges pointing to the INTERFACE node when it resolves an
 *   interface-typed call)
 * - null if no match found
 *
 * NOTE: Direct callers using CLASS nodes will find CALLS edges to the FUNCTION node.
 * Direct callers using INTERFACE nodes will find CALLS edges to the INTERFACE node
 * (if resolution succeeded) or will be covered by the findByAttr fallback (if not).
 */
async function findMethodInNode(
  backend: RFDBServerBackend,
  nodeId: string,
  methodName: string
): Promise<string | null> {
  const node = await backend.getNode(nodeId);
  if (!node) return null;

  if (node.type === 'CLASS') {
    // CLASS: method nodes are FUNCTION children connected via CONTAINS edges
    const containsEdges = await backend.getOutgoingEdges(nodeId, ['CONTAINS']);
    for (const edge of containsEdges) {
      const child = await backend.getNode(edge.dst);
      if (child && child.type === 'FUNCTION' && child.name === methodName) {
        return child.id;
      }
    }
    return null;
  }

  if (node.type === 'INTERFACE') {
    // INTERFACE: method signatures are stored as JSON in the node's `properties` array.
    // No separate FUNCTION nodes exist for interface members.
    // We return the INTERFACE node's own ID as a proxy so the BFS can find
    // any CALLS edges that MethodCallResolver created pointing to this INTERFACE node.
    const properties = (node as any).properties;
    if (Array.isArray(properties)) {
      for (const prop of properties) {
        if (prop && prop.name === methodName) {
          return nodeId;  // INTERFACE node itself is the target in the graph
        }
      }
    }
    return null;
  }

  return null;
}
```

### New helper: `collectAncestors`

```typescript
/**
 * Collect all ancestor class/interface IDs by walking outgoing DERIVES_FROM and
 * IMPLEMENTS edges upward through the hierarchy.
 *
 * NOTE: EXTENDS edges (INTERFACE → INTERFACE) are not followed. This means
 * multi-level interface inheritance chains are traversed only if intermediate
 * interfaces are found via IMPLEMENTS. This is a known limitation — interface-
 * extends-interface ancestors are missed — but has no practical impact since
 * INTERFACE nodes have no FUNCTION children anyway.
 *
 * Depth-bounded to 5 hops. Visited set prevents infinite loops on malformed data.
 */
async function collectAncestors(
  backend: RFDBServerBackend,
  classId: string,
  visited = new Set<string>(),
  depth = 0
): Promise<string[]> {
  if (depth > 5 || visited.has(classId)) return [];
  visited.add(classId);
  const ancestors: string[] = [];

  const outgoing = await backend.getOutgoingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS']);
  for (const edge of outgoing) {
    ancestors.push(edge.dst);
    const more = await collectAncestors(backend, edge.dst, visited, depth + 1);
    ancestors.push(...more);
  }
  return ancestors;
}
```

### New helper: `collectDescendants`

```typescript
/**
 * Collect direct descendant class IDs via incoming DERIVES_FROM and IMPLEMENTS edges.
 *
 * Only one level down (direct implementors/subclasses). Does not recurse.
 * Grandchildren of the given node are not returned. This is intentional — for the
 * REG-543 scenario one level of siblings is sufficient.
 */
async function collectDescendants(
  backend: RFDBServerBackend,
  classId: string
): Promise<string[]> {
  const descendants: string[] = [];
  const incoming = await backend.getIncomingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS']);
  for (const edge of incoming) {
    descendants.push(edge.src);
  }
  return descendants;
}
```

### New helper: `expandTargetSet`

```typescript
/**
 * Given a concrete method node, find all related nodes in the class hierarchy
 * that represent the same conceptual method (parent interfaces, abstract methods,
 * sibling implementations).
 *
 * This enables CHA-style impact analysis: callers that type their receiver
 * as an interface or abstract class will have CALLS edges to the abstract/interface
 * node, not the concrete node. By expanding the target set to include those abstract
 * nodes, the BFS will find those callers.
 *
 * Returns a set of node IDs:
 * - For CLASS ancestors: the FUNCTION child node ID (the method node itself)
 * - For INTERFACE ancestors: the INTERFACE node ID (used as proxy — see findMethodInNode)
 * - Always includes the original targetId
 */
async function expandTargetSet(
  backend: RFDBServerBackend,
  targetId: string,
  methodName: string
): Promise<Set<string>> {
  const result = new Set<string>([targetId]);

  if (!methodName) return result;

  try {
    // 1. Find the containing class or interface
    const containsEdges = await backend.getIncomingEdges(targetId, ['CONTAINS']);
    const parentIds: string[] = [];
    for (const edge of containsEdges) {
      const parent = await backend.getNode(edge.src);
      if (parent && (parent.type === 'CLASS' || parent.type === 'INTERFACE')) {
        parentIds.push(parent.id);
      }
    }

    // 2. For each parent, walk the hierarchy
    for (const classId of parentIds) {
      const ancestors = await collectAncestors(backend, classId);
      for (const ancestorId of ancestors) {
        // Check if this ancestor has the method (handles both CLASS and INTERFACE)
        const method = await findMethodInNode(backend, ancestorId, methodName);
        if (method) result.add(method);

        // Siblings: other classes that derive from or implement this ancestor
        const siblings = await collectDescendants(backend, ancestorId);
        for (const siblingId of siblings) {
          const siblingMethod = await findMethodInNode(backend, siblingId, methodName);
          if (siblingMethod) result.add(siblingMethod);
        }
      }
    }
  } catch {
    // Non-fatal: return what we have so far
    // Consider logging at debug level in production for diagnostics
  }

  return result;
}
```

### Modified `analyzeImpact` (targetIds initialization)

Replace the `targetIds` initialization block in `analyzeImpact` (currently lines 170-176):

**Before:**
```typescript
let targetIds: string[];
if (target.type === 'CLASS') {
  const methodIds = await getClassMethods(backend, target.id);
  targetIds = [target.id, ...methodIds];
} else {
  targetIds = [target.id];
}
```

**After:**
```typescript
let targetIds: string[];
if (target.type === 'CLASS') {
  const methodIds = await getClassMethods(backend, target.id);
  targetIds = [target.id, ...methodIds];
} else {
  // Expand via class hierarchy (CHA-style): find parent interfaces/abstract classes
  // and sibling implementations that share the same method name.
  const methodName = extractMethodName(target.name);
  const expanded = await expandTargetSet(backend, target.id, methodName);
  targetIds = [...expanded];
}
```

### Modified `analyzeImpact` (BFS loop — Bug 2 fix)

Add `initialTargetIds` tracking and pass `methodName` selectively:

```typescript
// Bug 2 fix: track which IDs are in the initial expanded set.
// findByAttr fallback must only run for initial target nodes, not for every
// transitive caller discovered in the BFS.
const initialTargetIds = new Set(targetIds);
const methodName = target.type !== 'CLASS' ? extractMethodName(target.name) : undefined;

// BFS to find all callers
const queue: Array<{ id: string; depth: number; chain: string[] }> = targetIds.map(id => ({
  id,
  depth: 0,
  chain: [target.name]
}));

while (queue.length > 0) {
  const { id, depth, chain } = queue.shift()!;
  // ... (existing visited/depth checks unchanged) ...

  const containingCalls = await findCallsToNode(
    backend,
    id,
    initialTargetIds.has(id) ? methodName : undefined  // Bug 2 fix
  );

  // ... (rest of BFS loop unchanged) ...
}
```

### Modified `findCallsToNode` (with `findByAttr` fallback)

```typescript
/**
 * Find CALL nodes that reference a target via CALLS edges.
 *
 * If methodName is provided, also searches for unresolved CALL nodes that
 * have a matching `method` attribute but no CALLS edge (e.g., calls through
 * abstract-typed or parameter-typed receivers that MethodCallResolver could
 * not resolve).
 *
 * IMPORTANT: Only pass methodName for initial target IDs (depth 0 in BFS),
 * never for transitive callers. The findByAttr query scans the entire graph
 * and returns the same results regardless of which node is being queried —
 * running it for every BFS node is redundant and costly.
 *
 * Known imprecision: findByAttr matches by bare method name only, not by
 * class. `findByAttr({ nodeType: 'CALL', method: 'addNode' })` returns ALL
 * call sites for any method named 'addNode' across all classes. This is
 * intentionally conservative (sound but imprecise). Output should note when
 * results include unresolved callers.
 */
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string,
  methodName?: string
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
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
  } catch { /* ignore */ }

  // Fallback: CALL nodes with matching method attribute but no CALLS edge.
  // Only runs when methodName is provided (i.e., for initial target IDs only).
  if (methodName) {
    try {
      const callNodeIds = await backend.findByAttr({ nodeType: 'CALL', method: methodName });
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
    } catch { /* ignore */ }
  }

  return calls;
}
```

---

## What Changes in `impact.ts`

| Item | Change |
|------|--------|
| `extractMethodName` | New pure helper |
| `findMethodInNode` | New helper — branches on CLASS vs INTERFACE node type |
| `collectAncestors` | New helper — depth-bounded DFS via DERIVES_FROM + IMPLEMENTS |
| `collectDescendants` | New helper — one-level reverse lookup via incoming edges |
| `expandTargetSet` | New helper — composes the above four |
| `analyzeImpact` | For non-CLASS targets: call `expandTargetSet` + track `initialTargetIds` |
| `findCallsToNode` | Add `methodName?` param + `findByAttr` fallback (guarded by param presence) |
| BFS loop call site | Pass `methodName` only when `initialTargetIds.has(id)` |

No changes to enrichers, graph schema, edge types, or other packages.

---

## Scenario Walkthrough

### Primary scenario: JS class hierarchy (the REG-543 case)

```js
class GraphBackend {
  addNode(node) { return node; }
  // → FUNCTION node: name="addNode", type=FUNCTION; CLASS node: GraphBackend
  // → CONTAINS edge: GraphBackend.id → addNode_function.id
}
class RFDBServerBackend extends GraphBackend {
  addNode(node) { return { ...node, stored: true }; }
  // → FUNCTION node: name="addNode"; CLASS node: RFDBServerBackend
  // → DERIVES_FROM edge: RFDBServerBackend.id → GraphBackend.id
}
function service(graph) {  // graph is a parameter: type unknown
  graph.addNode({ id: '1' });
  // → CALL node: method="addNode", object="graph"
  // MethodCallResolver: cannot resolve (no INSTANCE_OF for 'graph')
  // → NO CALLS edge created
}
```

With v3:
1. `findTarget` finds `RFDBServerBackend.addNode` FUNCTION node
2. `extractMethodName("RFDBServerBackend.addNode")` → `"addNode"`
3. `expandTargetSet`:
   - Parent class: `RFDBServerBackend` (CLASS)
   - `collectAncestors(RFDBServerBackend)` → `[GraphBackend]` (via DERIVES_FROM)
   - `findMethodInNode(GraphBackend, "addNode")`: GraphBackend is CLASS, find CONTAINS
     children of type FUNCTION with name "addNode" → found, returns `GraphBackend.addNode.id`
   - `collectDescendants(GraphBackend)` → `[RFDBServerBackend, ...]` (sibling impls)
   - `findMethodInNode(RFDBServerBackend, "addNode")` → `RFDBServerBackend.addNode.id`
     (already in result — deduped by Set)
   - Result: `{ RFDBServerBackend.addNode.id, GraphBackend.addNode.id }`
4. `initialTargetIds` = both IDs
5. BFS processes `GraphBackend.addNode.id`:
   - `getIncomingEdges(id, ['CALLS'])` → empty (unresolved calls have no CALLS edge)
   - `findByAttr({ nodeType: 'CALL', method: 'addNode' })` (methodName passed — initial target)
   - Finds CALL node in `service()` (method="addNode" attribute matches)
   - `findContainingFunction(callNode.id)` → `service` FUNCTION node
   - `service` added to `directCallers`
6. BFS processes `RFDBServerBackend.addNode.id`:
   - `getIncomingEdges(id, ['CALLS'])` → empty (same situation)
   - `findByAttr` returns same CALL node → `seen` set deduplicates
7. Result: `service` appears as direct caller

### TypeScript interface scenario

```typescript
interface IStorage {
  addNode(node: any): void;
  // → stored in IStorage INTERFACE node's `properties` array:
  //   [{ name: "addNode", type: "function", optional: false, readonly: false }]
  // → NO FUNCTION node created for this signature
}
class RedisStorage implements IStorage {
  addNode(node: any) { ... }
  // → FUNCTION node: name="addNode", type=FUNCTION
  // → IMPLEMENTS edge: RedisStorage.id → IStorage.id
}
function store(storage: IStorage) {
  storage.addNode({ id: '1' });
  // → CALL node: method="addNode"
  // MethodCallResolver: may or may not resolve to IStorage node via CHA
}
```

With v3:
1. `findTarget` finds `RedisStorage.addNode` FUNCTION node (no INTERFACE child nodes to find)
2. `expandTargetSet`:
   - Parent: `RedisStorage` (CLASS)
   - `collectAncestors(RedisStorage)` → `[IStorage]` (via IMPLEMENTS)
   - `findMethodInNode(IStorage, "addNode")`: IStorage is INTERFACE
     → fetch node, check `properties` array for entry with `name === "addNode"` → found
     → returns `IStorage.id` (the INTERFACE node itself)
   - `collectDescendants(IStorage)` → `[RedisStorage, ...]` (other implementors)
   - Result: `{ RedisStorage.addNode.id, IStorage.id }`
3. BFS processes `IStorage.id`:
   - `getIncomingEdges(IStorage.id, ['CALLS'])` → finds CALLS edges IF MethodCallResolver
     resolved the interface-typed call (via CHA). If resolved: `store` found via CALLS.
   - `findByAttr({ nodeType: 'CALL', method: 'addNode' })` (initial target) → finds CALL
     node in `store()` if unresolved. Deduped if already found via CALLS.
4. `store` appears as caller via whichever path applied.

---

## Edge Cases and Limits (Updated)

| Case | Behavior |
|------|----------|
| Module-level function (no class parent) | `getIncomingEdges(targetId, ['CONTAINS'])` returns nothing with CLASS/INTERFACE parents; `expandTargetSet` returns `{ targetId }`. Correct degradation. |
| CLASS target (e.g., `impact "UserService"`) | `expandTargetSet` not called; existing `getClassMethods` path used. Unchanged. |
| INTERFACE ancestor node | `findMethodInNode` reads `properties` JSON, returns INTERFACE node ID as proxy. BFS finds CALLS edges to INTERFACE node (resolved calls) or `findByAttr` handles unresolved calls. |
| No hierarchy (isolated class) | `collectAncestors` returns `[]`; `expandTargetSet` returns `{ targetId }`. Same as before. |
| Deep inheritance (A extends B extends C) | `collectAncestors` walks up to depth 5. Covers multi-level scenarios. |
| Circular inheritance (malformed graph data) | `visited` set in `collectAncestors` prevents infinite recursion. |
| Multiple interfaces (`implements A, B, C`) | All IMPLEMENTS edges followed. All implemented interfaces checked. |
| Interface-extends-interface (`interface A extends B`) | `EXTENDS` edges not followed by `collectAncestors`. Known limitation: grandparent interfaces missed. Low impact since interface nodes have no FUNCTION children anyway. |
| Sibling impls 2+ levels below common ancestor | `collectDescendants` is one level only. Grandchildren of common ancestor not found as siblings. Acceptable for REG-543 scope. |
| `target.name` is empty | `extractMethodName` returns `""`; `expandTargetSet` early-returns `{ targetId }`. Correct. |
| `findByAttr` false positives (cross-class) | All CALL nodes with matching method name returned, regardless of class. Known imprecision — documented in code. |

---

## Tests Needed (Updated for v3)

### Test 1: JS class hierarchy — primary REG-543 fix

File: `packages/cli/test/impact-polymorphic-callers.test.ts`

Fixture:
```javascript
// src/base.js
class GraphBackend {
  addNode(node) { return node; }
}
module.exports = { GraphBackend };

// src/impl.js
const { GraphBackend } = require('./base');
class RFDBServerBackend extends GraphBackend {
  addNode(node) { return { ...node, stored: true }; }
}
module.exports = { RFDBServerBackend };

// src/service.js
function useGraph(graph) {
  graph.addNode({ id: '1', type: 'FUNCTION' });
}
module.exports = { useGraph };
```

Run `grafema analyze` then `grafema impact "addNode"`.

Assertions:
- Output does NOT show `0 direct callers`
- `useGraph` appears as a caller
- Output includes more than 0 direct callers

### Test 2: Unresolved call fallback, no hierarchy

```javascript
// src/backend.js
class GraphBackend {
  addNode(node) { /* ... */ }
}
// src/service.js
function useGraph(graph) {
  graph.addNode({ id: '1' });  // graph: any-typed, no INSTANCE_OF
}
```

Assert `useGraph` appears as caller via `findByAttr` fallback (hierarchy expansion finds no
ancestor nodes; the unresolved CALL node is found by method name attribute).

### Test 3: No false positives from unrelated hierarchies (known imprecision documented)

```javascript
class TreeBackend {
  addNode(node) { return node; }
}
class GraphBackend {
  addNode(node) { return node; }
}
function useTree(tree) {
  tree.addNode({ id: '1' });
}
```

When running `impact "addNode"` targeting `GraphBackend.addNode`:
- `useTree` WILL appear as a caller (because `findByAttr` matches by method name only).
- This is EXPECTED BEHAVIOR — the findByAttr fallback is intentionally broad.
- Document this in test comment. Do not assert that `useTree` is absent.

### Test 4: TypeScript interface scenario (via `findMethodInNode` properties lookup)

**IMPORTANT CHANGE FROM v2:** Test 4 now asserts two distinct paths:
- The INTERFACE node ID appears in the expanded target set (hierarchy expansion now works
  for INTERFACE ancestors via properties lookup)
- Callers appear via CALLS edges to the INTERFACE node (if MethodCallResolver resolved the
  call) OR via `findByAttr` fallback (if unresolved)

Fixture:
```typescript
// src/types.ts
interface IStorage {
  addNode(node: any): void;
}
// src/impl.ts
class RedisStorage implements IStorage {
  addNode(node: any) { return node; }
}
// src/service.ts
function store(storage: IStorage) {
  storage.addNode({ id: '1' });
}
```

Assertions:
- `store` appears as a caller of `addNode`
- This is covered by `findByAttr` fallback (for unresolved calls) AND/OR CALLS → INTERFACE
  node (for resolved calls via CHA)
- Test comment must note: "INTERFACE hierarchy expansion returns INTERFACE node ID as proxy;
  coverage comes from CALLS-to-interface-node OR findByAttr, not CONTAINS traversal"

### Regression

`packages/cli/test/impact-class.test.ts` — must continue passing unchanged.

---

## Implementation Steps (for Rob)

1. Read `packages/cli/src/commands/impact.ts`
2. Add `extractMethodName` (pure function, no deps)
3. Add `findMethodInNode` (async, branches on CLASS vs INTERFACE, reads `properties` array)
4. Add `collectAncestors` (async recursive, depth-bounded, visited set)
5. Add `collectDescendants` (async, one level, incoming edges)
6. Add `expandTargetSet` (async, composes the above)
7. Modify `analyzeImpact`:
   - For non-CLASS targets: call `expandTargetSet` to produce `targetIds`
   - Add `initialTargetIds = new Set(targetIds)` tracking after `targetIds` is set
   - Compute `methodName` for use in BFS (only for non-CLASS targets)
8. Modify `findCallsToNode`: add `methodName?` parameter, add `findByAttr` fallback path
9. Modify BFS call site: pass `initialTargetIds.has(id) ? methodName : undefined`
10. Write test file `packages/cli/test/impact-polymorphic-callers.test.ts`
11. `pnpm build`
12. Run new tests: `node --test packages/cli/test/impact-polymorphic-callers.test.ts`
13. Run regression: `node --test packages/cli/test/impact-class.test.ts`

---

## Summary of Scope

| Component | Change |
|-----------|--------|
| `packages/cli/src/commands/impact.ts` | Add 5 helpers + modify `analyzeImpact` + modify `findCallsToNode` |
| `packages/core/` (enrichers) | None |
| `packages/types/` | None |
| Graph schema / edge types | None |
| New test file | `packages/cli/test/impact-polymorphic-callers.test.ts` |

One production file changes. No new packages. No schema changes.

---

## Risk Assessment

**Low-medium risk.** All changes are additive and guarded:

- `expandTargetSet` is new, called only for non-CLASS targets. On any error it returns
  `{ targetId }` — identical to pre-v2 behavior.
- The `findMethodInNode` INTERFACE branch reads a field from a node already fetched in
  memory. No new graph queries; cannot cause inconsistency.
- `findByAttr` fallback is now correctly gated: runs only for initial target IDs. O(initial
  target count × findByAttr_cost) instead of O(BFS_size × findByAttr_cost).
- No changes to enrichers, graph schema, or RFDB storage.
- All new graph queries use confirmed-existing edge types: DERIVES_FROM, IMPLEMENTS, CONTAINS.
