# Kent Beck - Test Report for `grafema doctor` (REG-214)

## Test File Location

```
packages/cli/test/doctor.test.ts
```

## How to Run Tests

```bash
# Run doctor tests only
node --import tsx --test packages/cli/test/doctor.test.ts

# Run all CLI tests (includes doctor)
pnpm --filter @grafema/cli test
```

## Test Coverage

### 1. `checkGrafemaInitialized` Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Fail when .grafema directory does not exist | Exit 1, mention "not found", recommend "grafema init" | Ready |
| Pass when config.yaml exists | Initialization check passes | Ready |
| Warn when config.json exists (deprecated) | Show deprecation warning | Ready |
| Fail when .grafema exists but has no config file | Exit 1, indicate missing config | Ready |

### 2. `checkServerStatus` Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Warn when socket does not exist | Mention server not running | Ready |

Note: Testing actual server connection requires running server, which is impractical for unit tests. The implementation should handle connection errors gracefully.

### 3. `checkConfigValidity` Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Fail on invalid YAML syntax | Show error about config | Ready |
| Warn on unknown plugin names | Warn about unknown plugin | Ready |
| Pass with valid config and known plugins | Config validates successfully | Ready |

### 4. `checkEntrypoints` Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Pass in auto-discovery mode with package.json | Handle auto-discovery mode | Ready |
| Warn when services have missing entrypoints | Warn about missing entrypoint | Ready |

### 5. `checkDatabaseExists` Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Fail when database file does not exist | Mention missing database | Ready |
| Warn on empty database | Warn about empty database | Ready |
| Pass when database exists with content | Database check passes | Ready |

### 6. Output Formatting Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Output valid JSON with --json flag | Parse to valid JSON object | Ready |
| Include status field in JSON output | status = healthy/warning/error | Ready |
| Include checks array in JSON output | Array with name, status, message | Ready |
| Include recommendations array in JSON output | Array of strings | Ready |
| Include versions in JSON output | cli and core versions | Ready |

### 7. Exit Code Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Exit with code 1 on critical errors | Exit 1 when no .grafema | Ready |
| Exit with code 2 on warnings only | Exit 2 when only warnings | Ready |

### 8. CLI Options Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Show doctor command in main help | --help lists doctor | Ready |
| Show doctor help with --help flag | Lists --json, --quiet, --verbose | Ready |
| Support --project option | Run doctor on specified path | Ready |
| Support --quiet option | Less output in quiet mode | Ready |

### 9. Integration Tests

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| Pass all checks on fully initialized and analyzed project | Exit 0 or 2, show passing checks | Ready |
| Return proper JSON for fully initialized project | Valid JSON with expected structure | Ready |

## Test Design Decisions

### 1. Using spawnSync with Timeout

Each CLI invocation has a 30-second timeout to prevent tests from hanging if the command gets stuck:

```typescript
function runCli(args, cwd, timeoutMs = 30000) {
  const result = spawnSync('node', [cliPath, ...args], {
    timeout: timeoutMs,
    // ...
  });
}
```

### 2. NO Mocks for Production Code Paths

Following the project principle, tests use real file system operations:
- Create temp directories with `mkdtempSync`
- Write real config files with `writeFileSync`
- Clean up in `afterEach` with `rmSync`

### 3. Flexible Assertions

Tests use flexible assertions to handle variations in output format:
```typescript
assert.ok(
  output.includes('not found') || output.includes('.grafema'),
  `Should mention .grafema directory issue. Got: ${output}`
);
```

This allows the implementation to use different wording while still communicating the same intent.

### 4. Integration Tests Run Full Workflow

Integration tests run the complete workflow (`init` -> `analyze` -> `doctor`) to verify end-to-end behavior. These have longer timeouts (60s suite timeout).

### 5. Testing Unknown Command Gracefully

When `doctor` command doesn't exist (TDD - tests first), the test will show that the command needs to be implemented. Current behavior: `spawnSync` returns `status: null` when command is not recognized.

## Notes for Implementation (Rob Pike)

1. **Command must be registered** in `packages/cli/src/cli.ts` for tests to pass

2. **Exit codes are important**:
   - 0 = all checks pass
   - 1 = critical errors (fail)
   - 2 = warnings only

3. **JSON output schema** must match:
   ```typescript
   {
     status: 'healthy' | 'warning' | 'error',
     timestamp: string,
     project: string,
     checks: Array<{ name: string, status: string, message: string, recommendation?: string, details?: object }>,
     recommendations: string[],
     versions: { cli: string, core: string, rfdb?: string }
   }
   ```

4. **Check names** should include 'init', 'config', 'server', 'database', etc. for tests to find them

5. **Recommendations** should include actionable commands like "grafema init", "grafema analyze"

## Current Test Status

Tests are written and ready. They will fail until the `doctor` command is implemented - this is expected TDD behavior.

To verify tests work correctly after implementation:
```bash
# Build first
pnpm build

# Run tests
pnpm --filter @grafema/cli test
```
