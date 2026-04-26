# Rob Implementation — REG-378

## Changes
- Added helpers in `analyze.ts`:
  - `fetchNodeEdgeCounts` (uses `nodeCount`/`edgeCount` only).
  - `exitWithCode` wrapper for explicit CLI exit.
- Progress polling now uses `fetchNodeEdgeCounts` and `statsInterval.unref()`.
- Final summary uses `fetchNodeEdgeCounts` (no `getStats`).
- Cleanup moved to `finally`: interval cleared, backend closed, `exitWithCode(exitCode)` always called.

## Files Touched
- `/Users/vadim/grafema-worker-1/packages/cli/src/commands/analyze.ts`
