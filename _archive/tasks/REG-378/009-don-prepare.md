# Don PREPARE — REG-378

## Target Files / Methods
- `/Users/vadim/grafema-worker-1/packages/cli/src/commands/analyze.ts`
  - Method: `analyzeCommand.action` (stats polling + exit path)
  - New helpers: `fetchNodeEdgeCounts`, `exitWithCode`
- `/Users/vadim/grafema-worker-1/packages/cli/test/analyze-utils.test.ts`
  - New tests for helper behavior

## Refactor Scope
- Only local adjustments inside `analyzeCommand.action` to reduce stats cost and force exit.
- No architectural changes.
