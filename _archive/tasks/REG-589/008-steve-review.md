# Steve Review — REG-589: ArgumentParameterLinker

**Verdict: APPROVE with two required fixes before merge**

---

## Vision Alignment

This ships. ARG_BINDING is exactly the kind of edge that makes the graph superior to reading source. Without it, an AI agent answering "what value does parameter `config` receive in this call?" must read the call site, count arguments manually, then read the function signature. With ARG_BINDING, the answer is a single graph traversal:

```
PARAMETER → ARG_BINDING{argIndex, callId} → argument_node
```

That is the vision made concrete. The agent queries the graph, not the code. For the target environment — untyped legacy JS with thousands of call sites — this is genuinely valuable. No type system gives you this. Grafema does.

The ISSUE nodes for extra arguments and unresolved calls are the right call. They make problems queryable rather than silently missing. That is a strategic win for AI-first tooling.

---

## Architecture Fit

The implementation slots correctly into Phase 3 of `resolve.ts`. It follows the same index-first pattern as the existing resolvers: build maps from edges, then iterate over the subset of interest. It does not introduce a new subsystem; it extends the existing pipeline at the natural extension point.

The `metadata` field on `DeferredRef` is a minimal, correct extension. It threads positional data through the pipeline without coupling stages. The walk engine change in `walk.ts` (lines 382-388) is clean: argIndex and paramIndex are attached to edges precisely where they are created, as a natural side effect of the array iteration that already existed.

The `ClassPrivateMethod.params` addition to `edge-map.ts` is a gap-fix that should have been there from the start. No complaint.

---

## Complexity

The main loop in `linkArgumentsToParameters` is O(E) for index construction (three single-pass loops over all edges) and O(C * A * P) for the matching phase, where C is resolved calls, A is args per call, and P is params per function. In practice C, A, P are all small constants. This is correct and will not be a performance problem.

**One real bug:** Line 771 constructs `allNodeIds` as a `Set<string>` but then never uses it. Line 775 performs `allNodes.find(n => n.id === callId && n.type === 'CALL')` — a full O(N) linear scan over all nodes for every unresolved call. `ProjectIndex.getNode` exists and is O(1). This must be fixed before merge. The fix is:

```ts
// Replace:
const allNodeIds = new Set(allNodes.map(n => n.id));
// ...
const callNode = allNodes.find(n => n.id === callId && n.type === 'CALL');

// With:
const callNode = index.getNode(callId);
if (!callNode || callNode.type !== 'CALL') continue;
```

The dead `allNodeIds` variable also needs to be removed. It will fail ESLint on commit anyway.

---

## Destructured Parameter Handling

The synthetic `{...}` and `[...]` PARAMETER nodes in `misc.ts` are the right approach. They preserve the RECEIVES_ARGUMENT edge structure so the linker can function without special-casing destructured params. The `metadata: { destructured: true }` flag allows downstream queries to distinguish them. This is consistent with the "enricher adds data, Datalog queries it" principle.

**One concern requiring a fix:** In `visitClassMethod` and `visitClassPrivateMethod` in `classes.ts`, non-destructured params emit RECEIVES_ARGUMENT edges directly from the visitor. However, these visitors do not handle `AssignmentPattern` params (params with defaults like `function f(x = 5)`). If the param is an AssignmentPattern, the visitor skips it silently — the loop only handles `param.type === 'Identifier'`. This means `paramIndex` metadata will be wrong for any method where a non-terminal parameter has a default. The `declarations.ts` visitor for `FunctionDeclaration` should be checked for the same pattern.

This is a correctness gap on the thing we are shipping. It needs to be addressed. Either handle AssignmentPattern in those loops (extracting the name from `ap.left`) or document it clearly as a known limitation in the code.

---

## What Is Good

- The edge name ARG_BINDING is unambiguous. Good.
- `callId` in the metadata on every ARG_BINDING edge is critical — it lets you distinguish "which call" when the same parameter is called from multiple sites. This was the right design call.
- The `isSpread` handling (spread args link to rest param then stop) is correct behavior. Not punting on it.
- Rest parameter matching is correct: args at index >= restParamIndex fold into the rest param.
- ISSUE nodes use deterministic IDs (`ISSUE#extra-argument:${callId}:${argIndex}`) so re-analysis is idempotent.

---

## What Must Be Fixed Before Merge

1. **Remove dead `allNodeIds` Set, replace `allNodes.find` with `index.getNode`** at line 771-775 in `resolve.ts`. This is a correctness issue as well as a performance issue. The `index` parameter is already available.

2. **Handle AssignmentPattern params in `visitClassMethod` and `visitClassPrivateMethod`** — or add a failing test that documents the gap. Shipping a known wrong paramIndex silently is worse than either fixing it or explicitly marking it TODO in tests.

---

## Summary

The feature is architecturally sound and vision-aligned. The two issues above are not architectural — they are implementation defects in an otherwise clean design. Fix them, re-run tests, then this ships.

The graph gets meaningfully better. Ship it.
