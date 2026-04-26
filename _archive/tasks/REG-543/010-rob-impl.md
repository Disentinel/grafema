# REG-543: Rob Pike Implementation Report

**Date:** 2026-02-21
**File modified:** `packages/cli/src/commands/impact.ts`
**Build status:** PASS (zero errors)

---

## What Was Implemented

All changes from Don's v3 plan (006-don-plan-v3.md) with Dijkstra's conditional corrections (007-dijkstra-verification-v3.md) applied.

### New helpers (5 functions added)

| Function | Lines | Purpose |
|----------|-------|---------|
| `extractMethodName` | 159-163 | Pure function. Strips class prefix via `lastIndexOf('.')`. |
| `findMethodInNode` | 181-213 | Branches on CLASS (CONTAINS edge traversal) vs INTERFACE (properties array lookup). Returns FUNCTION child ID for CLASS, INTERFACE node's own ID for INTERFACE, null otherwise. |
| `collectAncestors` | 221-238 | Recursive DFS via outgoing DERIVES_FROM + IMPLEMENTS. Depth limit 5, visited set for cycle protection. |
| `collectDescendants` | 245-255 | One-level reverse lookup via incoming DERIVES_FROM + IMPLEMENTS. No recursion. |
| `expandTargetSet` | 272-312 | Composes the above four. Finds parent CLASS/INTERFACE, walks ancestors, checks siblings. try/catch returns partial result on error. |

### Modified functions (2 functions changed)

| Function | Change |
|----------|--------|
| `analyzeImpact` | Non-CLASS branch: calls `expandTargetSet` instead of `[target.id]`. Added `initialTargetIds` Set and `methodName` before BFS queue. BFS call site passes `methodName` only for initial target IDs. |
| `findCallsToNode` | Added `methodName?: string` parameter. Added `seen` Set for dedup. Added `findByAttr` fallback block (guarded by `methodName` presence). |

### Dijkstra's corrections applied

1. **JSDoc on `findMethodInNode` corrected.** The plan claimed MethodCallResolver creates CALLS edges to INTERFACE nodes. Dijkstra verified this is false -- MethodCallResolver resolves to concrete FUNCTION nodes. The JSDoc now accurately states: INTERFACE node ID is added to `initialTargetIds` so that `findByAttr` fires for it; coverage comes from `findByAttr` (method name match), not from CALLS edges to INTERFACE nodes.

2. **`findMethodInNode` CLASS branch checks `FUNCTION` only** (not `FUNCTION | METHOD`), matching `getClassMethods` semantics. ClassVisitor always creates FUNCTION nodes.

3. **Silent catch in `expandTargetSet`** replicates the pre-existing pattern in the codebase (`getClassMethods`, `findCallsToNode`).

### What was NOT changed

- No changes to enrichers, graph schema, edge types, or other packages.
- No changes to the CLASS target path (existing `getClassMethods` branch untouched).
- No new dependencies or imports.
- The `displayImpact` function is unchanged.

---

## Verification

- `pnpm build` -- PASS, zero TypeScript errors across all packages.
- The CLI package (`packages/cli`) compiled without errors.
- Pre-existing Rust warnings in `rfdb-server` are unrelated (unused imports, dead code).

---

## Variable Scoping Note

`methodName` appears twice in `analyzeImpact`:
1. Line 337: `const methodName = extractMethodName(target.name)` -- block-scoped inside the `else { }` branch, used only for `expandTargetSet` call.
2. Line 346: `const methodName = target.type !== 'CLASS' ? extractMethodName(target.name) : undefined` -- function-scoped, used in the BFS loop for the `findCallsToNode` guard.

These are in different scopes. TypeScript compiles them without error. The function-level one is what the BFS loop references.

---

## Risk Assessment

Low risk. All changes are additive and guarded:
- `expandTargetSet` only called for non-CLASS targets. On any error, returns `{ targetId }` (identical to pre-change behavior).
- `findByAttr` fallback gated by `initialTargetIds.has(id)` -- runs O(initial target count) times, not O(BFS size).
- No changes to graph writes, schema, or enrichers.
