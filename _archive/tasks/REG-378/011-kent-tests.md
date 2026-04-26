# Kent Tests — REG-378

## Tests Added (TDD)
- `/Users/vadim/grafema-worker-1/packages/cli/test/analyze-utils.test.ts`
  - `fetchNodeEdgeCounts` uses only `nodeCount`/`edgeCount` and never `getStats`.
  - `exitWithCode` delegates to provided exit function.

## Status
- Tests written first, before implementation changes.
- Not executed here (Node.js not available in environment).

## Suggested Command
- `pnpm --filter @grafema/cli test`
