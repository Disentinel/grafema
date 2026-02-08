# Joel Tech Plan — REG-378

## Objective
Ensure `grafema analyze` exits promptly after analysis on large repos (ToolJet) by eliminating heavy post-analysis stats and preventing interval leaks.

## Implementation Steps (Tests First)
1. **Add test helper coverage**
   - Create a unit test in `packages/cli/test/` that calls a new helper (exported from `analyze.ts`) which fetches only `nodeCount` and `edgeCount`.
   - Use a fake backend that throws on `getStats()` to ensure it is **not** called.

2. **Introduce helper in `analyze.ts`**
   - Add `fetchNodeEdgeCounts(backend)` that calls `backend.nodeCount()` and `backend.edgeCount()` (parallel `Promise.all`).
   - This helper returns `{ nodeCount, edgeCount }` and is exported for tests.

3. **Use helper for progress polling**
   - Replace `backend.getStats()` inside the stats interval with the helper.
   - `renderer.setStats(nodeCount, edgeCount)` only.
   - `statsInterval.unref?.()` to avoid keeping the process alive if not cleared.

4. **Use helper for final summary**
   - Replace `backend.getStats()` after analysis with helper results.
   - Keep per-type counts for `overview`/`stats` (unchanged).

5. **Ensure cleanup in all paths**
   - Move interval cleanup into a `finally` block so it runs regardless of success/failure.

6. **Validation**
   - Run unit tests for CLI (once Node is available): `pnpm --filter @grafema/cli test`.
   - Manual: ToolJet fixture with `npx @grafema/cli analyze --auto-start` should exit normally.

## Complexity Analysis
- Helper calls are **O(1)** RPCs (2 calls per poll) vs previous **O(N)**-ish per-type counts repeated every 500ms. This reduces load drastically on large graphs.
- Memory footprint unchanged.

## Expected Behavior Changes
- `analyze` progress shows total nodes/edges only (no per-type counts).
- `overview` and `stats` still show detailed breakdowns.

## Rollback Plan
Revert `analyze.ts` helper usage and restore `backend.getStats()` if necessary (unlikely).
