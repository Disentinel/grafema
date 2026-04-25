# REG-543: Dijkstra Verification of Don Melton Plan v3

**Reviewer:** Edsger Dijkstra
**Plan version:** v3 (006-don-plan-v3.md)
**Date:** 2026-02-21

---

## Summary

v3 fixes Bug 2 correctly. Bug 1 is partially fixed — the INTERFACE `properties` lookup
is implemented correctly, but the claim that CALLS edges point to the INTERFACE node itself
is **factually wrong**. I read the MethodCallResolver source to verify. This invalidates the
TypeScript interface scenario walkthrough (Test 4 path via INTERFACE node). However, the
actual coverage for that scenario is still intact via `findByAttr` fallback — the same
coverage my v2 recommended under "Option B". The net outcome for REG-543 (JS class
hierarchy) is unaffected and correct.

**Verdict: CONDITIONAL APPROVE** — Rob may implement. One documentation/comment correction
is required during implementation (not a plan revision). The JS primary scenario (Test 1,
Test 2) is fully correct. The TypeScript interface path in the plan's walkthrough is
wrong about mechanism but the test assertion is still achievable because the fallback
covers it anyway.

---

## Bug 1 Fix Verification

### The Plan's Claim

Don's v3 plan states (lines 40-45):

> When `MethodCallResolver` resolves a call on an interface-typed receiver, it creates a
> `CALLS` edge pointing to the INTERFACE node itself (not to a non-existent FUNCTION child).
> See MethodCallResolver — `buildInterfaceMethodIndex` + `resolveViaInterfaceCHA`. If
> Grafema's MethodCallResolver was able to resolve the call to the interface, the CALLS edge
> target is the INTERFACE node.

### What the Source Actually Does

I read `MethodCallResolution.ts` in full. Here is the actual `resolveViaInterfaceCHA`:

```typescript
export async function resolveViaInterfaceCHA(
  methodName: string,
  classMethodIndex: Map<string, ClassEntry>,
  methodToInterfaces: Map<string, Set<string>>,
  interfaceImpls: Map<string, Set<string>>,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  const candidateInterfaces = methodToInterfaces.get(methodName);
  if (!candidateInterfaces || candidateInterfaces.size === 0) return null;

  for (const interfaceName of candidateInterfaces) {
    const implementingClasses = interfaceImpls.get(interfaceName);
    if (!implementingClasses) continue;

    for (const className of implementingClasses) {
      const classEntry = classMethodIndex.get(className);
      if (!classEntry) continue;

      if (classEntry.methods.has(methodName)) {
        return classEntry.methods.get(methodName)!;  // ← FUNCTION node of implementing class
      }
      // ...
    }
  }
  return null;
}
```

**The CALLS edge target is `classEntry.methods.get(methodName)` — the FUNCTION node of
the implementing class, not the INTERFACE node.**

The algorithm:
1. Look up method name in `methodToInterfaces` → finds which interfaces declare this method
2. Look up those interfaces in `interfaceImpls` → finds which classes implement them
3. Look up the implementing class in `classMethodIndex` → finds the FUNCTION node
4. Returns the FUNCTION node from the implementing class

The result is: `CALL → [CALLS] → RedisStorage.addNode_FUNCTION_node` — not to `IStorage`.

### Consequence for `findMethodInNode` INTERFACE Path

The plan's `findMethodInNode` for INTERFACE nodes returns the INTERFACE node's own ID.
The plan then relies on `getIncomingEdges(IStorage.id, ['CALLS'])` finding a CALLS edge.

**This will find nothing.** MethodCallResolver never creates CALLS edges pointing to
INTERFACE nodes. The INTERFACE node's ID will produce zero results from the CALLS edge
lookup.

### Does This Break REG-543?

**No.** The TypeScript interface scenario is still covered by the `findByAttr` fallback:

- The CALL node (unresolved or resolved-to-concrete-impl) has `method = "addNode"` attribute
- `findByAttr({ nodeType: 'CALL', method: 'addNode' })` finds it
- `store` appears as a caller

What is broken: the plan's stated mechanism for Test 4 (CALLS to INTERFACE node) does not
exist. Coverage comes from the `findByAttr` fallback, just as my v2 recommended ("Option B").

The `findMethodInNode` INTERFACE branch is not harmful — it returns the INTERFACE node ID,
which gets added to `initialTargetIds`, which causes `findByAttr` to fire (because
`initialTargetIds.has(id)` is true for it), which finds the CALL node by method name.
So the INTERFACE node ID in the expanded set contributes indirectly: it triggers the
`findByAttr` call, which is what actually finds the caller.

This is an accidental correctness — the INTERFACE node ID being in the initial set happens
to cause `findByAttr` to run for it, and `findByAttr` succeeds. The reasoning in the plan
is wrong but the behavior is acceptable.

### Required Correction During Implementation

Rob must correct the JSDoc comment on `findMethodInNode` before shipping. The current
plan says:

> "MethodCallResolver creates CALLS edges pointing to the INTERFACE node when it resolves
> an interface-typed call"

This is false. The correct comment must say:

> "INTERFACE node ID is added to initialTargetIds so that the findByAttr fallback fires
> for it. Coverage for TypeScript interface callers comes from findByAttr (which matches
> by method name), not from CALLS edges to the INTERFACE node (no such edges exist)."

This is a documentation correction only, not a code change.

---

## Bug 2 Fix Verification

### The Fix

```typescript
const initialTargetIds = new Set(targetIds);

// In BFS loop:
const containingCalls = await findCallsToNode(
  backend,
  id,
  initialTargetIds.has(id) ? methodName : undefined
);
```

### Analysis

**Is `initialTargetIds` populated before BFS starts?**
Yes. The code constructs `initialTargetIds = new Set(targetIds)` after `expandTargetSet`
returns and before the BFS queue is initialized. Correct ordering.

**Can a transitive caller also be in `initialTargetIds`?**
Only if the caller's function node ID happens to be the same as a target method node ID.
This cannot happen in practice: target IDs are method FUNCTION nodes (e.g.,
`RFDBServerBackend.addNode`). Transitive caller IDs are the functions that call those
methods (e.g., `service`, `controller`). They are distinct node IDs. No false
`findByAttr` calls from transitive callers.

**Correctness of the guard:**
`findByAttr` now runs exactly once per initial target node (those in the expanded set),
not once per BFS node. For the primary JS scenario with 2 initial targets
(`RFDBServerBackend.addNode`, `GraphBackend.addNode`), `findByAttr` runs exactly twice,
both returning the same CALL node, with the `seen` set deduplicating. Cost is O(2 ×
findByAttr_cost) regardless of BFS depth. Bug 2 is fully fixed.

---

## New Correctness Checks

### When INTERFACE node ID is added to the target set — can it cause false positives?

The expanded set contains the INTERFACE node ID (e.g., `IStorage.id`). In the BFS:
1. `getIncomingEdges(IStorage.id, ['CALLS'])` — returns nothing (no CALLS edges to INTERFACE
   nodes exist as shown above). Zero false positives from this path.
2. `findByAttr({ nodeType: 'CALL', method: 'addNode' })` — returns ALL unresolved CALL nodes
   with `method = "addNode"`. This is the same broad result that the plan already documents
   as "known imprecision" in Test 3. No additional false positives introduced by the
   INTERFACE node being in the initial set specifically.

The INTERFACE node in the initial set does not make things worse than what the plan
already accepts. Correct.

### Is `collectDescendants` still only one level deep?

Yes, confirmed. The v3 plan explicitly states this and the code does not recurse:

```typescript
async function collectDescendants(backend, classId): Promise<string[]> {
  const descendants: string[] = [];
  const incoming = await backend.getIncomingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS']);
  for (const edge of incoming) {
    descendants.push(edge.src);
  }
  return descendants;
}
```

**For the hierarchy: InterfaceA → AbstractBase → ConcreteImpl**

Assume user runs `impact "addNode"` targeting `ConcreteImpl.addNode`.

`expandTargetSet` starts from `ConcreteImpl.addNode`:
- Parent: `ConcreteImpl` (CLASS)
- `collectAncestors(ConcreteImpl)` walks upward recursively:
  - Finds `AbstractBase` (via DERIVES_FROM) — depth 1
  - Finds `InterfaceA` (via IMPLEMENTS from AbstractBase) — depth 2
  - Returns `[AbstractBase, InterfaceA]`
- For `AbstractBase`:
  - `findMethodInNode(AbstractBase, "addNode")` → finds `AbstractBase.addNode` FUNCTION
  - `collectDescendants(AbstractBase)` → `[ConcreteImpl]` (one level: direct implementors)
    - `findMethodInNode(ConcreteImpl, "addNode")` → already in result, deduped
- For `InterfaceA`:
  - `findMethodInNode(InterfaceA, "addNode")` → reads `properties`, returns `InterfaceA.id`
  - `collectDescendants(InterfaceA)` → `[AbstractBase]` (one level: classes with IMPLEMENTS
    to InterfaceA)
    - `findMethodInNode(AbstractBase, "addNode")` → already in result, deduped

Final expanded set: `{ ConcreteImpl.addNode.id, AbstractBase.addNode.id, InterfaceA.id }`

**Callers are found at ALL levels:**
- Callers that call `ConcreteImpl.addNode` directly (CALLS edge) → found via BFS on `ConcreteImpl.addNode.id`
- Callers that call `AbstractBase.addNode` directly (CALLS edge) → found via BFS on `AbstractBase.addNode.id`
- Callers with interface-typed receiver (no CALLS edge, or CALLS to concrete impl) → found via `findByAttr`

The one-level `collectDescendants` is not a completeness problem here because `collectAncestors`
is multi-level and covers the full ancestor chain. `collectDescendants` is called per ancestor,
effectively covering siblings at each level.

**What is genuinely missed:** siblings 2+ levels below a common ancestor that is NOT an
ancestor of the starting class. Example: if `ConcreteImpl2 extends AbstractBase` exists but
is not an ancestor of `ConcreteImpl`, then:
- `collectDescendants(AbstractBase)` returns `[ConcreteImpl, ConcreteImpl2]`
- `findMethodInNode(ConcreteImpl2, "addNode")` adds `ConcreteImpl2.addNode.id`
- So it IS found. The "one level" is per ancestor, meaning all direct implementors of
  any ancestor are included.

**What is genuinely missed:** grandchildren of a common ancestor that do NOT directly
derive from that ancestor (they derive from an intermediate class which itself derives
from the ancestor). This is the case documented as "sibling impls 2+ levels below common
ancestor." Acceptable for REG-543 scope. The ancestor traversal itself is multi-level,
so the intermediate class would appear as an ancestor too, and its direct children found.

In summary: the algorithm finds callers correctly for the multi-level case above. The
depth limit is on lateral sibling expansion, not on ancestor traversal itself.

---

## Completeness Table — Coverage by Scenario (v3)

| Scenario | Expanded IDs | CALLS edge path | findByAttr path | Net Result |
|----------|-------------|-----------------|-----------------|------------|
| JS: `concrete.addNode()`, receiver typed as concrete class | concrete.addNode | YES (resolver creates edge) | N/A | Covered |
| JS: `graph.addNode()`, parameter `graph`, no type info | concrete.addNode + ancestor.addNode | NO (unresolved) | YES (CALL node has method attr) | Covered via findByAttr |
| JS: class inherits, `abstract.addNode()` direct call | ancestor.addNode in expanded set | YES (CALLS to ancestor.addNode) | possibly deduped | Covered |
| TS: `storage.addNode()`, typed as `IStorage`, resolver fires | RedisStorage.addNode (via CHA) | YES (CALLS to concrete FUNCTION, not interface) | deduped | Covered via CALLS to concrete |
| TS: `storage.addNode()`, typed as `IStorage`, resolver fails | IStorage.id in expanded set | NO (no CALLS to INTERFACE node) | YES (method name matches) | Covered via findByAttr |
| Anonymous function, no class, no method name | `{ targetId }` | YES if CALLS edge exists | NO (methodName is "") | Covered if CALLS exists; unresolved calls missed (pre-existing) |
| Module-level function | `{ targetId }` | YES if CALLS edge exists | YES (methodName present) | Covered |
| CLASS target | getClassMethods path | YES | NO | Covered (existing path, unchanged) |

---

## Minor Observations

### `findMethodInNode` checking `FUNCTION` or `METHOD` for CLASS nodes

Don's v3 retains this. My v2 flagged it as dead code (ClassVisitor always creates FUNCTION
nodes, not METHOD). Not a bug. Rob should unify to just `FUNCTION` during implementation
to match `getClassMethods` for consistency, but this is a minor stylistic concern.

### `catch {}` in `expandTargetSet`

Silences all graph errors. Appropriate for graceful degradation. The plan's comment
"Consider logging at debug level" should be acted on by Rob — not critical but useful
for production diagnostics.

### `collectAncestors` EXTENDS edge gap

My v2 noted that `interface A extends B` (EXTENDS edge) is not traversed by `collectAncestors`.
v3 documents this as "known limitation." Confirmed: `buildInterfaceMethodIndex` in
MethodCallIndexers.ts DOES traverse EXTENDS edges (lines 109-121) for the resolver's
interface method index — but `collectAncestors` in impact.ts does not. This means the
impact analysis expansion is shallower than the resolver's own view. This is acceptable
for REG-543 scope, and `findByAttr` covers the unresolved cases anyway.

### `findByAttr` with `{ nodeType: 'CALL', method: methodName }`

Verified valid. `AttrQuery` in `packages/types/src/rfdb.ts` includes `nodeType?: string`.
`base-client.ts` sends the full query object to RFDB server as-is. The `method` field is
declared as a registered attribute on CALL nodes in `JSASTAnalyzer.ts` line 283. The query
will work as intended.

---

## Final Verdict

**CONDITIONAL APPROVE.**

**For Rob during implementation:**

1. Correct the JSDoc on `findMethodInNode` for the INTERFACE branch. Remove the claim
   that CALLS edges point to INTERFACE nodes (they never do). State that the INTERFACE
   node ID being in `initialTargetIds` causes `findByAttr` to fire, which is what actually
   finds interface-typed callers.

2. Optionally unify `findMethodInNode`'s CLASS branch to check only `FUNCTION` (not
   `FUNCTION | METHOD`) to match `getClassMethods` semantics.

3. Add debug-level logging in the `catch {}` block of `expandTargetSet` as the plan
   suggests.

4. Test 4's assertion ("store appears as caller") is achievable and correct. But the
   test comment must describe the actual mechanism: `findByAttr` fallback (not CALLS
   to INTERFACE node).

The primary REG-543 fix (JS class hierarchy, parameter-typed receivers) is correct,
complete, and ready to implement. All bugs from my v2 rejection are resolved or acceptably
contained.
