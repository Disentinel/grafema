# Joel Tech Plan — REG-378 (Revision)

## Objective
Guarantee `grafema analyze` exits even if lingering handles exist, while reducing heavy stats polling.

## Implementation Steps (Tests First)
1. **Add helper in `analyze.ts`**
   - `fetchNodeEdgeCounts(backend)` uses `Promise.all([backend.nodeCount(), backend.edgeCount()])`.
   - Export helper for tests.

2. **Update progress polling**
   - Replace `backend.getStats()` in interval with `fetchNodeEdgeCounts()`.
   - `renderer.setStats(nodeCount, edgeCount)`.
   - `statsInterval.unref?.()` after creation.

3. **Update final summary**
   - Replace `backend.getStats()` after analysis with `fetchNodeEdgeCounts()`.

4. **Force exit after clean shutdown**
   - After `await backend.close()` (and any diagnostics writing), call `process.exit(exitCode)` **always** (both success and failure).
   - Keep existing `process.exit(exitCode)` for non-zero; change to unconditional to cover success too.

5. **Cleanup robustness**
   - Move interval cleanup into `finally` to ensure it is always cleared before exit.

## Tests
- Unit test for `fetchNodeEdgeCounts` (fake backend throws on `getStats`).
- CLI test verifying `process.exit` called on success:
  - Option A: spawn child process for `cli analyze` and assert process ends (requires Node + RFDB setup).
  - Option B: unit-test `analyze` handler with `process.exit` mocked (preferred).

## Complexity Analysis
- Stats polling now O(1) per tick vs O(N) per-type counts.
- `process.exit` is constant time.

## Expected Behavior
- `grafema analyze` always terminates, even if timers/sockets remain.
- Progress still shows node/edge counts.

## Rollback Plan
- Remove unconditional `process.exit` if it causes unexpected behavior; keep lighter stats polling.
