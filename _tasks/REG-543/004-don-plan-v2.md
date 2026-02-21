# REG-543: Don Melton Tech Lead Plan v2 — Polymorphic Target Expansion

## Why v1 Was Rejected

The v1 plan proposed a flat `findByAttr({ nodeType: 'CALL', method: methodName })` fallback.
The user rejected this as a "костыль" (workaround). The problem: it bypasses the graph's
semantic structure entirely and treats all calls to any method named `addNode` as equivalent —
regardless of which class hierarchy they belong to.

The correct approach: **expand the target set via semantic edges**, then find callers of every
node in the expanded set. This is what a proper impact analysis tool does.

---

## Problem Restatement

When the user runs `grafema impact "addNode"`, the target node found is the concrete method
`RFDBServerBackend.addNode` (type FUNCTION, stored by ClassVisitor with bare name `"addNode"`).

The graph already has the knowledge we need:
- `RFDBServerBackend` -[IMPLEMENTS]-> `GraphBackend` (an INTERFACE or abstract CLASS node)
- `GraphBackend` has a method/property named `addNode`
- All 28 call sites use `graph.addNode()` where `graph` is typed as `GraphBackend`
- `MethodCallResolver` sees `object = "graph"`, cannot resolve to concrete class → no CALLS edge

The fix: before doing caller BFS, expand the target set to include the abstract/interface
version of the same method. Then find CALLS edges to ALL nodes in the expanded set.

---

## Semantic Edges That Exist

From reading the codebase (confirmed in source):

### Inheritance edges on CLASS nodes
- `CLASS -[DERIVES_FROM]-> CLASS` — created by `TypeSystemBuilder.bufferClassDeclarationNodes`
  when a class has a `superClass`. This is the primary inheritance edge.
- `CLASS -[IMPLEMENTS]-> INTERFACE` — created by `TypeSystemBuilder.bufferImplementsEdges`
  when a class declares `implements SomeInterface`. Can point to an external reference node.
- `CLASS -[EXTENDS]-> CLASS/INTERFACE` — only for TypeScript classes/interfaces explicitly
  extending another type (TypeSystemBuilder). Also used for INTERFACE-INTERFACE extension.

### Interface nodes
- `INTERFACE` nodes are created by `TypeSystemBuilder.bufferInterfaceNodes` from TypeScript
  `interface` declarations. They store method/property names in their `properties` field
  (array of `{ name, type, optional, readonly }`).
- `INTERFACE -[EXTENDS]-> INTERFACE` — interface inheritance chain.

### What does NOT exist
- No `OVERRIDES` edge (method-level override tracking is not in the graph)
- No `METHOD` nodes for interface members (only `FUNCTION`/`METHOD` nodes for class bodies)
- No direct edge from an abstract class method to concrete implementations

### The resolution gap
In the specific REG-543 scenario (JS codebase, `GraphBackend` is likely an abstract class, not
a TypeScript interface), there may be NO INTERFACE node. The abstract class may be stored as a
CLASS node with `DERIVES_FROM` edges pointing up, not down to implementors.

**Crucial distinction:**
- `IMPLEMENTS` edge direction: `ConcreteClass -[IMPLEMENTS]-> Interface` (class → interface)
- `DERIVES_FROM` edge direction: `SubClass -[DERIVES_FROM]-> SuperClass` (child → parent)

To find all nodes related to the target method:
1. Walk UP via `DERIVES_FROM` / `IMPLEMENTS` to find abstract parent class or interface
2. Walk DOWN via incoming `DERIVES_FROM` / incoming `IMPLEMENTS` to find sibling implementations

---

## Prior Art: Class Hierarchy Analysis (CHA)

Academic context (for reasoning clarity):

**CHA** (Class Hierarchy Analysis): For a call `receiver.m()` where `receiver` has declared
type `T`, add a call edge to `T.m()` AND to every subclass/implementor of `T` that defines or
inherits `m()`. This is sound but imprecise.

**For impact analysis (inverse CHA)**: Given a target method `C.m()`, find all callers of
`C.m()`, `Parent.m()`, `Interface.m()`, and every sibling implementation `Sibling.m()` where
`Sibling` is a subtype of a common ancestor. Call sites on abstract/interface types would
resolve via CHA to any concrete implementation.

Grafema already implements forward CHA in `MethodCallResolver` (REG-485): `buildInterfaceMethodIndex`
+ `buildInterfaceImplementationIndex` + `resolveViaInterfaceCHA`. The v2 plan applies the
**inverse**: starting from a concrete target, walk the hierarchy to find what abstract nodes
a caller might be using, then find callers of those abstract nodes too.

Sources consulted: [Call Graph Construction Algorithms Explained](https://ben-holland.com/call-graph-construction-algorithms-explained/), [CMU Lecture Notes on OO Call Graph Construction](https://www.cs.cmu.edu/~aldrich/courses/17-355-17sp/notes/notes09-callgraph.pdf)

---

## Revised Design

### Step 1: Target Set Expansion (new logic in `impact.ts`)

Starting from the initial target node (e.g., `RFDBServerBackend.addNode`):

```
expandTargetSet(backend, targetId, targetMethodName):
  result = { targetId }

  1. Find the CLASS node containing targetId
     - Walk incoming CONTAINS edges from targetId → get parent CLASS
     - call it targetClass

  2. Walk UP the hierarchy (find abstract parents):
     - Follow targetClass -[DERIVES_FROM]-> parentClass (one or more hops)
     - Follow targetClass -[IMPLEMENTS]-> interface
     - For each ancestor found, look for a method node with same bare name
       (search via CONTAINS edges: ancestor -[CONTAINS]-> child where child.name == targetMethodName)
     - If found, add that child's id to result set

  3. Walk DOWN the hierarchy (find sibling implementations):
     - For each ancestor found in step 2, find incoming DERIVES_FROM edges
       (other classes that derive from the same abstract parent)
     - For each sibling class, look for a method with same bare name
     - If found, add to result set
     - Also: find incoming IMPLEMENTS edges to the interface
       (other classes that implement the same interface)

  4. Return result set (all related method nodes across the hierarchy)
```

### Step 2: BFS Uses Expanded Target Set (existing logic, extended)

In `analyzeImpact`, instead of:
```typescript
targetIds = [target.id];
```

Do:
```typescript
const expandedIds = await expandTargetSet(backend, target.id, extractMethodName(target.name));
targetIds = [...expandedIds];
```

The rest of BFS is unchanged: `findCallsToNode` already queries `getIncomingEdges(id, ['CALLS'])`.
Once we have the abstract interface method node in `targetIds`, any resolved `CALLS` edges to it
(from calls on the abstract-typed variable) will be found.

### ALSO: Keep the `findByAttr` fallback (renamed and scoped)

The `findByAttr({ nodeType: 'CALL', method: methodName })` approach from v1 is still valid
as an additional unresolved-call finder, but ONLY after the hierarchy expansion. The two
mechanisms are complementary, not alternatives:

1. Hierarchy expansion → finds CALLS edges to interface/abstract method nodes (resolved calls)
2. `findByAttr` fallback → finds CALL nodes with no CALLS edge at all (unresolved calls)

Both add to the same deduped set.

---

## What Changes in `impact.ts`

### New helper: `expandTargetSet`

```typescript
/**
 * Given a concrete method node, find all related nodes in the class hierarchy
 * that represent the same conceptual method (parent interfaces, abstract methods,
 * sibling implementations).
 *
 * This enables CHA-style impact analysis: callers that type their receiver
 * as an interface or abstract class will have CALLS edges to the abstract
 * node, not the concrete node.
 */
async function expandTargetSet(
  backend: RFDBServerBackend,
  targetId: string,
  methodName: string
): Promise<Set<string>> {
  const result = new Set<string>([targetId]);

  if (!methodName) return result;

  try {
    // 1. Find the containing class
    const containsEdges = await backend.getIncomingEdges(targetId, ['CONTAINS']);
    const parentClasses: string[] = [];
    for (const edge of containsEdges) {
      const parent = await backend.getNode(edge.src);
      if (parent && (parent.type === 'CLASS' || parent.type === 'INTERFACE')) {
        parentClasses.push(parent.id);
      }
    }

    // 2. For each parent class, walk hierarchy ancestors and siblings
    for (const classId of parentClasses) {
      const ancestors = await collectAncestors(backend, classId);
      for (const ancestorId of ancestors) {
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
    // Non-fatal: return what we have
  }

  return result;
}

/**
 * Collect all ancestor class/interface IDs via DERIVES_FROM and IMPLEMENTS edges.
 * Max depth 5 to handle deep hierarchies without infinite loops.
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

/**
 * Collect direct descendant class IDs via incoming DERIVES_FROM and IMPLEMENTS edges.
 * Only one level down (direct implementors/subclasses of a given node).
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

/**
 * Find a method node with the given name among children of a class/interface node.
 * Returns the method node ID if found, null otherwise.
 */
async function findMethodInNode(
  backend: RFDBServerBackend,
  classId: string,
  methodName: string
): Promise<string | null> {
  const containsEdges = await backend.getOutgoingEdges(classId, ['CONTAINS']);
  for (const edge of containsEdges) {
    const child = await backend.getNode(edge.dst);
    if (child && (child.type === 'FUNCTION' || child.type === 'METHOD')
        && child.name === methodName) {
      return child.id;
    }
  }
  return null;
}
```

### Modified `analyzeImpact`

Replace the `targetIds` initialization section (lines 171-176 in current `impact.ts`):

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
  // Expand via class hierarchy (CHA-style)
  const methodName = extractMethodName(target.name);
  const expanded = await expandTargetSet(backend, target.id, methodName);
  targetIds = [...expanded];
}
```

### Modified `findCallsToNode` (also includes v1's fallback)

The function should also include the `findByAttr` unresolved-call fallback from v1, now as
a secondary path after the CALLS-edge path:

```typescript
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string,
  methodName?: string   // bare method name for unresolved-call fallback
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    const edges = await backend.getIncomingEdges(targetId, ['CALLS']);
    for (const edge of edges) {
      const callNode = await backend.getNode(edge.src);
      if (callNode && !seen.has(callNode.id)) {
        seen.add(callNode.id);
        calls.push({ id: callNode.id, type: callNode.type || 'CALL',
          name: callNode.name || '', file: callNode.file || '', line: callNode.line });
      }
    }
  } catch { /* ignore */ }

  // Fallback: CALL nodes with matching method attribute but no CALLS edge
  // (unresolved calls via abstract/interface-typed receiver)
  if (methodName) {
    try {
      const callNodeIds = await backend.findByAttr({ nodeType: 'CALL', method: methodName });
      for (const id of callNodeIds) {
        if (!seen.has(id)) {
          seen.add(id);
          const callNode = await backend.getNode(id);
          if (callNode) {
            calls.push({ id: callNode.id, type: callNode.type || 'CALL',
              name: callNode.name || '', file: callNode.file || '', line: callNode.line });
          }
        }
      }
    } catch { /* ignore */ }
  }

  return calls;
}
```

And in the BFS loop, pass `methodName`:
```typescript
const methodName = extractMethodName(target.name);
// ...
const containingCalls = await findCallsToNode(backend, id, methodName);
```

### New helper: `extractMethodName`

```typescript
function extractMethodName(fullName: string): string {
  if (!fullName) return '';
  const dotIdx = fullName.lastIndexOf('.');
  return dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
}
```

---

## What Changes in Enrichers

### No new enrichment edges are needed for the v2 core fix.

The edges we need already exist:
- `DERIVES_FROM` (CLASS → superclass) — created by TypeSystemBuilder
- `IMPLEMENTS` (CLASS → INTERFACE) — created by TypeSystemBuilder
- `CONTAINS` (CLASS → METHOD/FUNCTION) — created by TypeSystemBuilder + ClassVisitor
- `EXTENDS` (INTERFACE → INTERFACE) — created by TypeSystemBuilder

The limitation is that in JS codebases (non-TypeScript), there are typically no INTERFACE nodes.
Abstract classes are regular CLASS nodes with no special marker. For a JS codebase:
- `class GraphBackend {}` → CLASS node
- `class RFDBServerBackend extends GraphBackend {}` → CLASS node with DERIVES_FROM → GraphBackend

In this case, the hierarchy expansion WILL work for JS code via the DERIVES_FROM chain:
- Target: `RFDBServerBackend.addNode` (FUNCTION node)
- Parent class: `RFDBServerBackend` (CLASS)
- Ancestor: `GraphBackend` (CLASS via DERIVES_FROM)
- `GraphBackend.addNode` (FUNCTION node) — found via CONTAINS
- Callers of `GraphBackend.addNode` via CALLS edge — these ARE resolved in some cases

### Possible future enrichment (not needed for this fix, note for later)

If `MethodCallResolver` resolved calls to abstract class methods when only the abstract class
is in scope, the hierarchy expansion would find even more callers. This is a separate issue
(improving MethodCallResolver for abstract class contexts, not in scope here).

---

## Scenario Walkthrough: The REG-543 Case

Assuming JS codebase:
```js
class GraphBackend {
  addNode(node) { ... }  // → FUNCTION node: "addNode", parent: GraphBackend CLASS
}
class RFDBServerBackend extends GraphBackend {
  addNode(node) { ... }  // → FUNCTION node: "addNode", parent: RFDBServerBackend CLASS
}
// RFDBServerBackend -[DERIVES_FROM]-> GraphBackend (class hierarchy edge)

function service(graph) {  // graph is typed as GraphBackend (abstract)
  graph.addNode(x);  // → CALL node: method="addNode", object="graph"
                     // MethodCallResolver: cannot resolve (graph is a param, no INSTANCE_OF)
                     // Result: NO CALLS edge
}
```

**With v2 fix:**

1. `findTarget` finds `RFDBServerBackend.addNode` FUNCTION node (or `GraphBackend.addNode`)
2. `expandTargetSet("RFDBServerBackend.addNode")`:
   - Parent class: `RFDBServerBackend`
   - Ancestor: `GraphBackend` (via DERIVES_FROM)
   - `findMethodInNode(GraphBackend, "addNode")` → finds `GraphBackend.addNode` FUNCTION node
   - Siblings of GraphBackend: any other class with DERIVES_FROM → GraphBackend
   - Target set: `{ RFDBServerBackend.addNode, GraphBackend.addNode }`
3. BFS iterates over both IDs
4. For `GraphBackend.addNode`: `getIncomingEdges(id, ['CALLS'])` — may find calls if resolver
   resolved to the abstract class
5. For `RFDBServerBackend.addNode`: same (the original behavior)
6. `findByAttr({ nodeType: 'CALL', method: 'addNode' })` — finds the unresolved CALL node
   in `service()` → `findContainingFunction` → `service` appears as a caller

**Result: 28 callers found** (or however many call sites exist with `method = "addNode"`).

---

## Edge Cases and Limits

| Case | Behavior |
|------|----------|
| Target is an interface method (INTERFACE node, not CLASS) | expandTargetSet finds CONTAINS children of INTERFACE node; then finds all implementing classes via incoming IMPLEMENTS and their methods |
| No hierarchy edges (isolated class) | expandTargetSet returns `{ targetId }` — behaves same as before |
| Deep inheritance chain (A extends B extends C extends D) | collectAncestors walks up to depth 5; catches multi-level scenarios |
| Circular inheritance (malformed code) | visited set prevents infinite loop |
| Multiple inheritance (implements multiple interfaces) | all IMPLEMENTS edges followed |
| getIncomingEdges throws | caught silently, returns what's collected so far |
| target.name is "" | extractMethodName returns "", expandTargetSet early-returns `{ targetId }` |

---

## Tests Needed

### Test 1: Hierarchy expansion (new scenario — the primary REG-543 fix)

File: `/Users/vadimr/grafema-worker-2/packages/cli/test/impact-polymorphic-callers.test.ts`

Scenario:
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

Steps: `grafema analyze` then `grafema impact "addNode"`.

Assertions:
- Output does NOT show `0 direct callers`
- Output includes `useGraph` as a caller
- `expandTargetSet` found both `GraphBackend.addNode` and `RFDBServerBackend.addNode`
  (verifiable if we expose a debug/json output showing expanded target count)

### Test 2: Unresolved call fallback (carries over from v1 plan, covers different scenario)

Scenario: class with no hierarchy, plain unresolved call.

```javascript
// src/backend.js
class GraphBackend {
  addNode(node) { /* ... */ }
}
// src/service.js
function useGraph(graph) {
  graph.addNode({ id: '1' });  // graph is any-typed, no INSTANCE_OF
}
```

Assert `useGraph` appears as caller via `findByAttr` fallback (no hierarchy needed).

### Test 3: No false positives for unrelated classes

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
- `useTree` WILL appear (known broad behavior, same as v1 — acceptable)
- Document this in test comment as expected behavior

### Test 4: TypeScript interface scenario

```typescript
// src/types.ts
interface IStorage {
  addNode(node: any): void;
}
// src/impl.ts
class RedisStorage implements IStorage {
  addNode(node: any) { ... }
}
// src/service.ts
function store(storage: IStorage) {
  storage.addNode({ id: '1' });
}
```

Assert `store` appears as caller of `addNode` in either implementation.

### Existing tests

`packages/cli/test/impact-class.test.ts` — must continue passing (regression check).

---

## Implementation Steps (for Rob/Dijkstra)

1. Read `packages/cli/src/commands/impact.ts`
2. Add `extractMethodName` helper (pure function, no deps)
3. Add `findMethodInNode` helper (async, uses `backend.getOutgoingEdges` + `backend.getNode`)
4. Add `collectAncestors` helper (async recursive, depth-bounded, visited set)
5. Add `collectDescendants` helper (async, one level, uses `backend.getIncomingEdges`)
6. Add `expandTargetSet` helper (async, composes the above)
7. Modify `analyzeImpact`: for non-CLASS targets, call `expandTargetSet` to produce `targetIds`
8. Modify `findCallsToNode`: add `methodName?` parameter, add `findByAttr` fallback path
9. Modify BFS call site: pass `methodName` to `findCallsToNode`
10. Write test file `packages/cli/test/impact-polymorphic-callers.test.ts` (scenarios 1 and 2 above)
11. `pnpm build`
12. Run tests: `node --test packages/cli/test/impact-polymorphic-callers.test.ts`
13. Run regression: `node --test packages/cli/test/impact-class.test.ts`

---

## Risk Assessment

**Medium-low risk.** Changes are additive:
- `expandTargetSet` is a new function called only for non-CLASS targets. If it fails, it
  returns `{ targetId }` (same as before).
- The `findByAttr` fallback from v1 is additive (catches-silently on error).
- No changes to enrichers, graph schema, or core.
- All new graph queries use existing edge types that are confirmed to exist.
- The only behavioral change: non-CLASS targets now query more nodes in the BFS. This may
  produce more results (desired) and slightly more latency (acceptable — graph traversal is
  bounded by hierarchy depth + sibling count).

**One runtime concern:** In a codebase with a very wide class hierarchy (e.g., 100 classes
implementing one interface), `collectDescendants` could return many siblings. The
`findMethodInNode` call per sibling adds N graph queries. In practice, this is bounded by
the hierarchy width and method existence check is O(degree of CONTAINS edges). For typical
production codebases, this is acceptable. If it becomes a performance issue, the sibling
traversal can be capped.

---

## Summary of Scope

| Component | Change |
|-----------|--------|
| `packages/cli/src/commands/impact.ts` | Add 5 new helpers + modify `analyzeImpact` + modify `findCallsToNode` |
| `packages/core/` (enrichers) | None |
| `packages/types/` | None |
| Graph schema / edge types | None |
| New test file | `packages/cli/test/impact-polymorphic-callers.test.ts` |

**One file changes in production code.** No new packages. No schema changes.
