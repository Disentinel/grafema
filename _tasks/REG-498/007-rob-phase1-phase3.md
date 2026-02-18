## Rob Pike -- Phase 1 & Phase 3 Implementation Report

### Phase 1: DataFlowValidator Fix

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

All three bugs fixed:

**Bug 1 -- DERIVES_FROM ignored:** The assignment check now queries for both `ASSIGNED_FROM` and `DERIVES_FROM` edges via `graph.getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM'])`. Same fix applied inside `findPathToLeaf()`. For-of/for-in loop variables no longer trigger false `ERR_MISSING_ASSIGNMENT`.

**Bug 2 -- O(n*m) performance:** Removed `getAllNodes()` and `getAllEdges()` bulk loads. Variables are now collected via `queryNodes({ nodeType: 'VARIABLE' })` and `queryNodes({ nodeType: 'CONSTANT' })` using the `for await + push` pattern (matches `Plugin.getModules()` convention). All edge lookups replaced with per-node `getOutgoingEdges()`/`getIncomingEdges()`.

**Bug 3 -- Wrong type filter:** Removed the `VARIABLE_DECLARATION` filter. The `queryNodes({ nodeType: 'VARIABLE' })` call returns the correct node type.

**findPathToLeaf() rewrite:**
- Signature changed from `(startNode, allNodes, allEdges, leafTypes, visited, chain)` to `(startNode, graph, leafTypes, visited, chain)`.
- Method is now async (returns `Promise<PathResult>`).
- All `allEdges.find()` replaced with `graph.getOutgoingEdges()` / `graph.getIncomingEdges()`.
- All `allNodes.find()` replaced with `graph.getNode()`.
- Cycle guard (`visited: Set<string>`) preserved.
- Recursive async calls are safe -- the visited set prevents infinite recursion.

**Removed:**
- Local `EdgeRecord` interface (no longer needed).
- `getAllEdges` guard block.
- Stale comments.

Net result: ~255 lines down to ~173 lines. Simpler, correct, efficient.

### Phase 3: Type Enforcement

**File:** `packages/types/src/plugins.ts`

Removed from the `GraphBackend` interface (the one plugins receive as `context.graph`):
- `getAllNodes(filter?: NodeFilter): Promise<NodeRecord[]>` -- plugins must use `queryNodes` instead
- `getAllEdges?(): Promise<EdgeRecord[]>` -- plugins must use `getOutgoingEdges`/`getIncomingEdges` instead

The comment about GUI/export use was also removed since it only applied to `getAllEdges`.

Both methods remain on:
- `packages/core/src/core/GraphBackend.ts` (abstract class, internal backend contract)
- `packages/core/src/storage/backends/RFDBServerBackend.ts` (concrete implementation)

No other plugins in `packages/core/src/plugins/` reference `getAllNodes` or `getAllEdges` -- confirmed by grep. Build passes clean.

### Verification

| Check | Result |
|-------|--------|
| `pnpm build` | PASS (zero TypeScript errors) |
| `DataFlowValidator.test.js` | 14/14 tests pass |
| `ShadowingDetector.test.js` | 8/8 tests pass |
| No plugins reference `getAllNodes`/`getAllEdges` | Confirmed by grep |
