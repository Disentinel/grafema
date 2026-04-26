# REG-158: Add E2E test for happy path workflow

## Context

From Linear issue REG-158. Current CLI tests:
- Uses `spawn()` to run CLI as subprocess
- Helper `runCli()` exists
- Fixtures in `test/fixtures/test-project/`
- Tests: help screens, error cases
- **Missing:** No test for `init → analyze → query` workflow

## Requirements

### Test steps
1. Create temp test project with simple JS file
2. Run `grafema init` → verify success
3. Run `grafema analyze` → verify database created
4. Run `grafema query "function hello"` → verify finds the function
5. Verify output contains expected node info
6. Clean up temp files

### Assertions
- **init:** exit code 0, `.grafema/config.yaml` created
- **analyze:** exit code 0, `graph.rfdb` created, shows stats
- **query:** exit code 0, finds function, shows file/line info

### Fixture
- Simple JS with 1-2 functions
- Must have `package.json` (init checks for this)
- Use isolated temp directory per test run

### Database handling
- Use `--clear` flag in analyze
- Remove temp dir after test (even on failure)
- Timeout: 60s (analyze can be slow)

## Decision

Since this is a well-defined task with clear requirements and existing test patterns:
- Use Single Agent (Rob) approach
- Extend existing `packages/cli/test/cli.test.ts` file
- Reuse existing `runCli()` helper pattern
