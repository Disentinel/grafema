# REG-543: Dijkstra Verification of Don Melton Plan v2

**Reviewer:** Edsger Dijkstra
**Plan version:** v2 (004-don-plan-v2.md)
**Date:** 2026-02-21

---

## Summary

The v2 plan is substantially better than v1. It abandons the flat name-matching kostyl and
introduces a proper CHA-inspired hierarchy traversal. The core logic is sound. However,
there is one **critical structural bug** in the INTERFACE handling path, one **logic error**
in the BFS flow, and several correctness concerns that must be resolved before implementation.

**Verdict: REJECT — fix 2 bugs, then re-verify.**

---

## Verification Checklist

### 1. `expandTargetSet` Input Universe

**Case: FUNCTION at module-level (no class parent)**

`getIncomingEdges(targetId, ['CONTAINS'])` will return zero results (module-level functions
have no CONTAINS parent with type CLASS or INTERFACE). The `parentClasses` array is empty.
The loop body never executes. `expandTargetSet` returns `{ targetId }`.

Result: graceful degradation. Correct.

**Case: METHOD inside a class (the primary case)**

`getIncomingEdges(targetId, ['CONTAINS'])` returns the CLASS node.
`parentClasses = [classId]`. Ancestor traversal proceeds as designed.

Result: correct.

**Case: CLASS itself (user ran `impact "SomeClass"` and got the CLASS node as target)**

This case is handled before `expandTargetSet` is ever called: `analyzeImpact` branches on
`target.type === 'CLASS'` and uses `getClassMethods` instead. `expandTargetSet` is only
called from the `else` branch.

Result: not a concern. Correct.

**Case: INTERFACE method (TypeScript interface)**

This is a critical structural issue. Here is the actual schema:

- TypeScriptVisitor extracts TSMethodSignature members and stores them as entries inside
  the INTERFACE node's `properties` JSON array field (see TypeScriptVisitor.ts lines 310-319).
- **No separate FUNCTION/METHOD nodes are created for interface methods.**
- `findMethodInNode` queries `getOutgoingEdges(classId, ['CONTAINS'])` and checks for
  child nodes of type `FUNCTION` or `METHOD`. INTERFACE nodes have no such children.

Therefore: if the user runs `impact "addNode"` and the resolved target is an INTERFACE
method entry (which can only happen if a FUNCTION node exists in the graph for it),
`findMethodInNode` will find nothing when applied to INTERFACE nodes — it will always
return `null`.

But wait: can INTERFACE nodes even appear in `parentClasses` from step 1?

Looking at `expandTargetSet` step 1: it walks incoming CONTAINS from the method to find
parents of type CLASS or INTERFACE. Since interface method signatures are stored as JSON
properties — NOT as separate FUNCTION nodes — the initial `findTarget` in `impact.ts` will
never return an INTERFACE method as the `target` (there is no FUNCTION node to find). This
means:
- The target is always a FUNCTION node that lives inside a CLASS (or at module level).
- An INTERFACE node CAN appear as an ancestor (via IMPLEMENTS from the class).
- When `findMethodInNode` is called on an INTERFACE ancestor, it will look for CONTAINS
  children of type FUNCTION/METHOD. None exist. It returns null.
- The INTERFACE method is never added to the expanded set.

**Consequence:** The TypeScript interface scenario (Test 4 in the plan) will NOT produce
callers via the hierarchy expansion path. The `findByAttr` fallback may still help if the
call is unresolved (CALL node with `method = "addNode"` attribute). But this is accidental
coverage, not the designed one.

This is a **design gap between the plan's stated scope and the actual graph schema.** The
plan claims "When target is an interface method... `expandTargetSet` finds CONTAINS children
of INTERFACE node" — but INTERFACE nodes have no such children.

Severity: HIGH for Test 4 (TypeScript interface). Severity: LOW for the primary JS case
(Test 1), because JS classes generate actual FUNCTION nodes.

**Case: Anonymous function (no class, no name)**

`extractMethodName` on an empty name returns `""`. `expandTargetSet` early-returns
`{ targetId }` due to the `if (!methodName) return result;` guard.

Result: correct.

---

### 2. `collectAncestors` Traversal

**Multiple interfaces (class implements A, B, C)**

`getOutgoingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS'])` returns ALL outgoing edges of
both types. All implementing interfaces are in the result. Each is recursed into.

Result: correct — all implemented interfaces are followed.

**Interface-extends-interface (TypeScript `interface A extends B, C`)**

TypeSystemBuilder creates `EXTENDS` edges (not `DERIVES_FROM` or `IMPLEMENTS`) for
interface-interface inheritance. `collectAncestors` only follows `DERIVES_FROM` and
`IMPLEMENTS`. It does NOT follow `EXTENDS`.

**This is a bug.** If the target class implements `A`, and `A extends B`, then
`collectAncestors` finds `A` (via IMPLEMENTS) but stops there. It does not follow
`A -[EXTENDS]-> B`. The `B` interface's method node (were it to exist) would not be
found.

Since interface method nodes do not exist in the graph (see bug #1 above), this bug has
no practical effect for the interface scenario. However, if EXTENDS is used between CLASS
nodes in some edge cases, the traversal would be incomplete. Document this gap.

Severity: LOW for current graph schema (since INTERFACE methods are not FUNCTION nodes
anyway). Would become HIGH if interface methods were ever reified as nodes.

**DERIVES_FROM missing (pure JS, no superclass)**

`getOutgoingEdges` returns empty. The loop does not execute. Returns `[]`.

Result: graceful. Correct.

**Depth limit 5**

5 hops covers: class -> parent -> grandparent -> great-grandparent -> great-great-grandparent
-> great-great-great-grandparent. Real-world JS/TS inheritance chains rarely exceed 3-4
levels. This is sufficient.

**Cycles in DERIVES_FROM/IMPLEMENTS**

TypeScript's type checker prohibits circular inheritance (`class A extends B` + `class B
extends A` is a compile error). However, Grafema analyzes graph data and graph data can
be malformed. The `visited` set in `collectAncestors` prevents infinite recursion.

Result: protected by visited set. Correct.

**Warning:** The visited set is passed by reference through recursive calls. This is
correct and intentional — it prevents revisiting the same node across different branches
of the traversal. This is the expected behavior for a DFS with global memoization.

---

### 3. `collectDescendants` — The Inverse Direction

**Do incoming DERIVES_FROM/IMPLEMENTS edges actually exist in the graph?**

Yes. RFDB supports reverse edge lookup via `getIncomingEdges`. The edges exist as
bidirectional lookups in RFDB's storage engine.

Edge direction is:
- `SubClass -[DERIVES_FROM]-> SuperClass`
- `ConcreteClass -[IMPLEMENTS]-> Interface`

So to find all classes that derive from `GraphBackend`:
`getIncomingEdges(graphBackendId, ['DERIVES_FROM'])` returns all subclasses.

This is exactly what `collectDescendants` does. Confirmed correct.

**Who creates the reverse direction?**

RFDB stores edges by both src and dst, enabling O(1) reverse lookup via `getIncomingEdges`.
There is no O(n) scan. This was confirmed by reading `GraphBackend.ts` — `getIncomingEdges`
is a first-class abstract method, not a filter over all edges.

**One level down only**

`collectDescendants` does NOT recurse. If `GraphBackend` has two levels of subclasses
(e.g., `RFDBServerBackend extends AbstractBackend extends GraphBackend`), then
`collectDescendants(GraphBackend)` returns `AbstractBackend` but NOT `RFDBServerBackend`.

The plan calls `collectDescendants` for each ancestor. So the full traversal is:

```
expandTargetSet starting from RFDBServerBackend.addNode:
  1. Parent class: RFDBServerBackend
  2. Ancestors of RFDBServerBackend:
       - GraphBackend (via DERIVES_FROM)
       - SomeInterface (via IMPLEMENTS, if any)
  3. For GraphBackend:
       - findMethodInNode(GraphBackend) → GraphBackend.addNode added
       - collectDescendants(GraphBackend) → [RFDBServerBackend, AnotherConcreteClass]
         For RFDBServerBackend: findMethodInNode → already in result (same as original target)
         For AnotherConcreteClass: findMethodInNode → adds AnotherConcreteClass.addNode
```

This means the plan DOES find sibling implementations at depth 1 from each ancestor.
But it does NOT find siblings at depth 2+ (grandchildren of the common ancestor).

For the REG-543 primary scenario this is sufficient. Document the depth limitation.

---

### 4. `findMethodInNode` Correctness

**CONTAINS edge existence: CLASS -> FUNCTION nodes**

Confirmed via TypeSystemBuilder.ts lines 86-93:
```typescript
for (const methodId of methods) {
  this.ctx.bufferEdge({ type: 'CONTAINS', src: id, dst: methodId });
}
```
These edges are always created for class methods. Correct.

**Name semantics of CONTAINS children**

ClassVisitor (ClassMethod handler, line 340-341):
```typescript
const methodName = methodNode.key.type === 'Identifier'
  ? methodNode.key.name
  : ...
```
The FUNCTION node's `name` field is the BARE method name (e.g., `"addNode"`, not
`"RFDBServerBackend.addNode"`). The plan's `findMethodInNode` checks `child.name === methodName`
where `methodName` comes from `extractMethodName(target.name)` which strips the class prefix.

This matches. Correct.

**However:** The existing `getClassMethods` function in impact.ts (line 265) filters for
`node.type === 'FUNCTION'` only. `findMethodInNode` in the plan checks for `FUNCTION` or
`METHOD`. In practice, ClassVisitor always creates nodes of type `FUNCTION` (not `METHOD`),
so the `METHOD` check in `findMethodInNode` is dead code. This is not a bug, just unnecessary.

**Inherited methods (not overridden in subclass)**

If `ConcreteClass extends AbstractBase` and `ConcreteClass` does NOT override `addNode`,
then `AbstractBase.addNode` FUNCTION node exists, but there is no `ConcreteClass.addNode`
node in the graph. `findMethodInNode(ConcreteClass)` returns null, which is correct —
the only callable version is `AbstractBase.addNode`.

The hierarchy traversal will still find `AbstractBase.addNode` via the ancestor walk.
The missing override is not a problem.

---

### 5. BFS Flow: Critical Logic Bug

**The BFS starts from all `targetIds` at `depth = 0`.**

Looking at the current `analyzeImpact` code (lines 179-183):
```typescript
const queue: Array<{ id: string; depth: number; chain: string[] }> = targetIds.map(id => ({
  id,
  depth: 0,
  chain: [target.name]
}));
```

And the classification (lines 216-219):
```typescript
if (depth === 0) {
  directCallers.push(caller);
} else {
  transitiveCallers.push(caller);
}
```

With the v2 expansion, if `GraphBackend.addNode` is added to targetIds, and a caller
calls it at depth 0, that caller appears as a "direct caller" — which is semantically
correct for the user's query. No problem there.

**But there IS a bug in the visited set interaction with expanded targets:**

The BFS starts with all expanded IDs queued at depth 0. Each ID, when dequeued, is added
to `visited`. But the method node IDs themselves (the targets) are added to `visited` as
they are processed. This prevents them from being visited again if they appear as callers
of each other (which they shouldn't), so this is fine.

The actual bug: the plan modifies `findCallsToNode` to add a `methodName?` parameter and
pass it from the BFS loop. But looking at the BFS loop in `analyzeImpact`:

```typescript
const containingCalls = await findCallsToNode(backend, id);
```

The BFS iterates over ALL `targetIds` AND all callers found transitively. For transitive
callers (depth > 0), the `id` is a function/method that CALLS the target. When we invoke
`findCallsToNode(backend, id, methodName)` on these transitive callers, the `findByAttr`
fallback will search for ANY unresolved CALL node with `method = "addNode"` — even for
transitive callers at depth 2, 3, etc. This means the fallback runs redundantly on EVERY
node in the BFS, not just the initial targets.

**Severity: MEDIUM.** The fallback uses a `seen` dedup set, so it will not create
duplicate entries. But the performance cost is O(BFS_depth × findByAttr_cost). The
`findByAttr` call should only execute for the initial target nodes (depth 0), not for
all transitively discovered callers.

The fix: pass `methodName` to `findCallsToNode` only when the `id` being queried is in
the initial `targetIds` set. Otherwise pass `undefined`.

---

### 6. Safety-Net `findByAttr` Fallback

**What scenario still needs the fallback after hierarchy expansion?**

The hierarchy expansion finds method nodes and their CALLS edges. CALLS edges are only
created when `MethodCallResolver` successfully resolves the receiver type. If the call
`graph.addNode()` uses a variable `graph` whose type cannot be resolved (no INSTANCE_OF
edge, parameter without type annotation, function argument), no CALLS edge is created.
The CALL node exists in the graph but has no CALLS edge to any method.

The hierarchy expansion traverses class hierarchy to find more method nodes, but if the
CALL node has no CALLS edge to ANY of them, hierarchy expansion cannot help. The fallback
`findByAttr({ nodeType: 'CALL', method: methodName })` finds CALL nodes by the bare method
name attribute stored on the CALL node — this is what the REG-543 primary scenario
(parameter-typed `graph`) actually requires.

So both mechanisms are genuinely complementary. This is correct reasoning.

**Can the fallback double-count results?**

`findCallsToNode` maintains a `seen` set and checks it before adding to `calls`. A node
found via CALLS edge AND via findByAttr will only be added once.

Result: no double-counting. Correct.

**Cross-class false positives from `findByAttr`**

`findByAttr({ nodeType: 'CALL', method: 'addNode' })` returns ALL CALL nodes in the
entire graph with `method = "addNode"` — regardless of which class they target. This
includes `TreeBackend.addNode` calls, `LinkedList.addNode` calls, etc.

The plan acknowledges this in Test 3 ("known broad behavior, acceptable"). This is a
known precision trade-off. For a tool named "impact analysis" this is conservative (sound)
but imprecise. It should be documented in the output (e.g., "N additional unresolved
callers found by method name — may include unrelated classes").

---

## Completeness Tables

### Edge Type Usage in Plan vs Graph Reality

| Edge Type    | Who Creates It                        | Direction             | Used in Plan          | Correct? |
|-------------|---------------------------------------|-----------------------|-----------------------|----------|
| DERIVES_FROM | TypeSystemBuilder.bufferClassDeclarationNodes | SubClass → SuperClass | collectAncestors (outgoing) | YES |
| IMPLEMENTS   | TypeSystemBuilder.bufferImplementsEdges | ConcreteClass → Interface | collectAncestors (outgoing) | YES |
| CONTAINS     | TypeSystemBuilder.bufferClassDeclarationNodes | CLASS → FUNCTION | findMethodInNode (outgoing) | YES |
| CONTAINS     | TypeSystemBuilder.bufferInterfaceNodes | MODULE → INTERFACE | Step 1 (incoming to target) | YES |
| EXTENDS      | TypeSystemBuilder.bufferInterfaceNodes | INTERFACE → INTERFACE | **NOT in collectAncestors** | **BUG** |

### findMethodInNode Input Scenarios

| Node Type | Has CONTAINS → FUNCTION children? | findMethodInNode result |
|-----------|-----------------------------------|------------------------|
| CLASS (with methods) | YES | Returns FUNCTION node if name matches |
| CLASS (no such method) | CONTAINS children of other names | Returns null |
| INTERFACE | NO — methods are stored in `properties` JSON array, no child nodes | Always returns null |
| MODULE | Has CONTAINS → FUNCTION, but type check filters to FUNCTION/METHOD only | Would work if MODULE passed, but MODULE never appears as ancestor in this traversal |

### Scenario Coverage

| Scenario | Works via Hierarchy? | Works via findByAttr? | Net Result |
|----------|---------------------|----------------------|------------|
| JS: class extends class, concrete typed var | YES (DERIVES_FROM found) | N/A (call resolved) | Covered |
| JS: class extends class, parameter/abstract-typed var | Hierarchy finds ancestor node; no CALLS edge to it | YES (CALL node has method attr) | Covered via fallback |
| TS: class implements interface, interface-typed var | NO (findMethodInNode on INTERFACE returns null) | YES (CALL node has method attr) | Covered via fallback only (by accident, not design) |
| TS: interface extends interface, multi-level | NO (EXTENDS not traversed) | YES if unresolved | Fallback only |
| Anonymous function, no class | expandTargetSet skips (methodName="") | findByAttr not called | NOT covered |
| Class with no callers | Hierarchy runs, finds no callers | findByAttr finds no matches | Correct: 0 results |

---

## Bugs Requiring Fix Before Implementation

### Bug 1 (HIGH): `findMethodInNode` will always return null for INTERFACE nodes

The plan states that `expandTargetSet` can find method nodes in INTERFACE ancestors.
This is incorrect. Interface methods are stored as JSON in the `properties` field of the
INTERFACE node — they are NOT separate FUNCTION/METHOD nodes in the graph. Therefore
`findMethodInNode` cannot find them via CONTAINS traversal.

**Fix options:**
- (A) Add a parallel lookup path: for INTERFACE nodes, parse the `properties` JSON and
  check if any property's `name` matches `methodName`. If found, return the INTERFACE
  node's own ID as a proxy (callers of interface-typed calls would have CALLS edges to...
  nothing, since there is no node). This is a dead end unless MethodCallResolver already
  creates CALLS edges to INTERFACE nodes.
- (B) Accept that INTERFACE scenario coverage comes entirely from `findByAttr` fallback.
  Document this as a known limitation. Test 4 passes because of the fallback, not the
  hierarchy expansion.
- (C) Future work: reify interface method signatures as FUNCTION nodes in the graph (out
  of scope for this PR).

Recommended: Option B. Keep the plan honest — the fallback handles TS interface scenarios.
Do not mislead tests into thinking hierarchy expansion covers INTERFACE nodes when it doesn't.

### Bug 2 (MEDIUM): `findByAttr` fallback fires for all BFS nodes, not just initial targets

In the proposed `findCallsToNode` modification, the `methodName` parameter is passed for
every `id` in the BFS — including transitive callers at depth 1, 2, ... maxDepth. This
causes `findByAttr({ nodeType: 'CALL', method: methodName })` to execute once per BFS
node, redundantly returning the same CALL nodes every time (with dedup preventing double-
counting, but wasting graph queries).

**Fix:** Only pass `methodName` to `findCallsToNode` when processing the initial target
IDs. For transitive callers, pass `undefined`.

```typescript
// Suggested: track which IDs are initial targets
const initialTargetIds = new Set(targetIds);

// In BFS:
const containingCalls = await findCallsToNode(
  backend,
  id,
  initialTargetIds.has(id) ? methodName : undefined
);
```

---

## Minor Observations

- `extractMethodName` correctly strips class prefix: `"RFDBServerBackend.addNode"` →
  `"addNode"`. Bare names like `"addNode"` are also handled (dotIdx = -1 → returns full
  string). Correct.

- `collectAncestors` passes `visited` by reference through recursion — this is correct
  for DFS global visit tracking.

- The `catch {}` silencing in `expandTargetSet` is appropriate for graceful degradation,
  but means errors are invisible. Consider at minimum logging at debug level so production
  issues can be diagnosed.

- The plan mentions `collectDescendants` is "one level down only." This means sibling
  classes 2+ levels below a common ancestor are missed. For the REG-543 scenario this is
  acceptable. The comment in code should state this limitation explicitly.

- `getClassMethods` (used for CLASS targets) checks only `node.type === 'FUNCTION'`.
  `findMethodInNode` checks `FUNCTION` or `METHOD`. This inconsistency is harmless but
  cosmetically ugly. Unify to `FUNCTION` if METHOD nodes don't exist in practice.

---

## Final Verdict

**REJECT** — two bugs must be fixed before Rob implements:

1. **Bug 1:** Document that `findMethodInNode` on INTERFACE nodes returns null (the
   interface scenario is covered by `findByAttr` fallback only, not hierarchy expansion).
   Update Test 4's assertions to reflect this — it passes via fallback, not expansion.
   Remove the claim from the Edge Cases table that "expandTargetSet finds CONTAINS children
   of INTERFACE node" — this is factually incorrect.

2. **Bug 2:** Restrict `findByAttr` fallback to initial target IDs only. Pass
   `methodName` to `findCallsToNode` only when `id` is in the initial expanded set, not
   for transitive BFS nodes.

The core algorithm (hierarchy expansion for JS class inheritance via DERIVES_FROM) is
correct and will work for the primary REG-543 scenario. The two bugs are localized and
fixable with < 10 LOC changes. The overall plan is approvable after those fixes are
reflected in Don's updated plan or implementation notes.
