# Don Melton - Tech Lead Analysis: REG-158 E2E Happy Path Test

## Executive Summary

This task asks for an E2E test covering the "happy path" workflow of Grafema: init -> analyze -> query. This is **the right thing to do**. Currently, the CLI tests only verify help output and error cases - they never test the actual workflow a user would follow.

## Existing Test Infrastructure Analysis

### Current State of `packages/cli/test/cli.test.ts`

The existing test file has solid infrastructure:

1. **`runCli()` helper** - Spawns CLI as subprocess, captures stdout/stderr/exit code
   - Uses `NO_COLOR=1` environment for clean output
   - Runs from a configurable `testProjectDir`
   - Well-designed, reusable

2. **Fixture setup** - Creates temp test project in `before()`, cleans in `after()`
   - Creates `index.js` with a `hello()` function - exactly what we need for the query test
   - Uses `packages/cli/test/fixtures/test-project/` as working directory

3. **Test coverage gaps**:
   - `init` command: **NOT TESTED AT ALL**
   - `analyze`: Only tests `--help` output
   - `query`: Only tests `--help` and "no database" error
   - No test runs the actual happy path

### What the Commands Do

**`init`** (packages/cli/src/commands/init.ts):
- Requires `package.json` to exist
- Creates `.grafema/` directory
- Creates `.grafema/config.yaml`
- Detects project structure (TS/JS, monorepo, src/lib)

**`analyze`** (packages/cli/src/commands/analyze.ts):
- Creates `.grafema/graph.rfdb` database
- Runs full plugin pipeline
- Returns exit 0 on success
- Outputs node/edge counts

**`query`** (packages/cli/src/commands/query.ts):
- Requires `.grafema/graph.rfdb` to exist
- Pattern: `"function hello"` or `"hello"`
- Outputs matching nodes with file/line info

## Key Architectural Decisions

### 1. New File vs Extend Existing?

**Decision: Extend existing `cli.test.ts`**

Rationale:
- Test infrastructure (`runCli()`, fixture setup) already exists
- The existing fixture already has a `hello()` function
- Creating a separate file would duplicate setup/teardown
- E2E tests belong with other CLI tests

### 2. Fixture Requirements

The current fixture is almost sufficient but needs one addition:
- **Has**: `index.js` with `function hello()`
- **Missing**: `package.json` (required by `init` command)

The `before()` hook already creates `index.js`. We just need to add `package.json` creation.

### 3. Test Isolation Concern

**Problem**: The existing tests run in the same `testProjectDir`. If we add E2E tests that create `.grafema/`, it could affect other tests.

**Solution**: The `before()` hook already wipes `fixturesDir` clean at start. The E2E test should run AFTER error tests (which expect no database). Test order in node:test is lexical within a `describe()`, so we can control this with naming.

Or better: create a separate `describe('E2E workflow')` block that runs independently and manages its own cleanup between phases.

## High-Level Plan

### Phase 1: Setup Enhancement
Add `package.json` creation to the fixture setup (required by `init`)

### Phase 2: E2E Test Block
Create new `describe('E2E workflow')` with sequential test phases:

```
1. Test: grafema init
   - Run `grafema init`
   - Verify exit code 0
   - Verify `.grafema/config.yaml` exists

2. Test: grafema analyze
   - Run `grafema analyze`
   - Verify exit code 0
   - Verify `.grafema/graph.rfdb` directory exists
   - Verify output contains node/edge counts

3. Test: grafema query
   - Run `grafema query "function hello"`
   - Verify exit code 0
   - Verify output contains "hello"
   - Verify output contains file reference (index.js)
```

### Phase 3: Cleanup
Existing `after()` hook already handles cleanup.

## Verification Criteria

The test must verify:
1. **init**: `existsSync('.grafema/config.yaml')` returns true
2. **analyze**: `existsSync('.grafema/graph.rfdb')` returns true AND output matches `/Nodes: \d+/`
3. **query**: output contains function name and file location

## Risks and Considerations

### 1. Test Execution Time
The analyze command runs the full plugin pipeline. This could be slow (2-5 seconds). Acceptable for E2E test, but we should:
- Keep the fixture minimal (one file)
- Use `--quiet` flag to reduce output noise if needed

### 2. Config.yaml vs Config.json Discrepancy
I noticed `init` creates `config.yaml` but `analyze` reads `config.json`. This is a **bug** or intentional override system. For the E2E test, this doesn't matter because analyze uses DEFAULT_PLUGINS when no config.json exists. But this should be flagged.

**Action**: Create Linear issue for config file format inconsistency (yaml vs json).

### 3. Test Order Dependency
The E2E tests must run in order (init before analyze before query). Using `describe()` with sequential `it()` blocks achieves this in node:test.

## Alignment with Project Vision

This test directly supports the project vision:
- **Dogfooding**: Tests the exact workflow users follow
- **Quality gate**: Ensures the happy path always works
- **Regression prevention**: Future refactors won't silently break core workflow

The test is minimal, focused, and tests the RIGHT thing - not implementation details, but user-facing behavior.

## Next Steps for Joel

1. Modify `before()` hook to create `package.json` in test fixture
2. Add `describe('E2E workflow')` with three sequential tests
3. Each test should use `runCli()` and verify both exit code and output/filesystem state
4. Ensure tests are independent enough to provide useful failure diagnostics
5. Keep fixture minimal - one JS file with one function

## Open Question

Should we also test the `--clear` flag on analyze? It's part of a typical workflow when re-analyzing. Decision: NO for this task. Keep scope minimal. REG-158 is specifically about happy path, not edge cases.
