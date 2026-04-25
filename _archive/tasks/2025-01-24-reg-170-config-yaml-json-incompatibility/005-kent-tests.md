# Kent Beck: REG-170 Tests

## Tests Created

Created comprehensive test suite for ConfigLoader with **14 test groups** covering all scenarios from Joel's spec:

### 1. YAML Config Tests (6 tests)
- **Valid YAML config** - Loads and parses complete YAML config correctly
- **Partial YAML merge** - Merges partial user config with defaults
- **Invalid YAML gracefully** - Handles parse errors, returns defaults, warns user
- **YAML parse errors with details** - Includes error message in warnings
- **Extra whitespace** - Handles formatting variations
- **Inline array syntax** - Supports `[item1, item2]` format
- **Mixed comments and config** - Preserves inline and block comments

### 2. JSON Config Tests (3 tests - Deprecated)
- **Valid JSON config** - Loads JSON, warns about deprecation
- **Invalid JSON gracefully** - Handles parse errors, returns defaults
- **Partial JSON merge** - Merges partial config with defaults

### 3. YAML Precedence Tests (3 tests)
- **YAML wins when both exist** - YAML takes priority over JSON
- **No JSON warning with YAML** - Silent when YAML is present
- **Different structures** - YAML structure overrides JSON completely

### 4. No Config File Tests (3 tests)
- **Returns defaults** - No config = use defaults
- **No warnings** - Silent operation when no config
- **Missing .grafema directory** - Handles non-existent directory

### 5. Edge Cases Tests (8 tests)
- **Empty YAML file** - Returns defaults
- **Comments only** - Returns defaults
- **Empty plugin sections** - Respects empty arrays `[]`
- **Extra whitespace** - Handles formatting variations
- **Inline arrays** - Supports compact syntax
- **Mixed comments** - Comments don't break parsing
- **Null values** - Falls back to defaults for null

### 6. Logger Injection Tests (3 tests)
- **Custom logger** - Uses provided logger for warnings
- **Default console** - Falls back to console when no logger
- **Error details in warnings** - Passes error messages to logger

### 7. DEFAULT_CONFIG Structure Tests (3 tests)
- **All required phases** - Has indexing, analysis, enrichment, validation
- **Non-empty defaults** - Each phase has at least one plugin
- **Expected plugins** - Includes JSModuleIndexer, JSASTAnalyzer, etc.

**Total: 29 test cases** organized into 7 logical groups.

## Test File Location

```
/Users/vadimr/grafema/test/unit/config/ConfigLoader.test.ts
```

## Run Command

```bash
# Run ConfigLoader tests only
node --import tsx --test test/unit/config/ConfigLoader.test.ts

# Run all unit tests
npm test
```

## Expected Initial State

Tests **FAIL as expected** - no implementation exists yet:

```
SyntaxError: The requested module '@grafema/core' does not provide an export named 'DEFAULT_CONFIG'
```

This is correct TDD behavior:
1. Tests written FIRST (this step - DONE)
2. Tests FAIL initially (verified - PASS)
3. Implementation written to make tests pass (Rob's job - NEXT)
4. Tests PASS after implementation (verification step)

## Test Structure

Matches existing project patterns from `Logger.test.ts` and `DiagnosticCollector.test.ts`:

- **node:test** and **node:assert** - Standard Node.js test framework
- **Isolated fixtures** - Each test gets clean directory via beforeEach/afterEach
- **Test helpers** - `createLoggerMock()` for warning capture
- **Clear test names** - Each test communicates intent explicitly
- **Comprehensive coverage** - Success paths, error paths, edge cases

## Key Test Patterns

### 1. Fixture Isolation
```typescript
beforeEach(() => {
  // Clean slate
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(grafemaDir, { recursive: true });
});
```

### 2. Logger Mock for Warning Capture
```typescript
interface LoggerMock {
  warnings: string[];
  warn: (msg: string) => void;
}
```

This allows tests to verify:
- Deprecation warnings for JSON config
- Parse error warnings
- "Using defaults" warnings
- No warnings when YAML exists

### 3. Testing Config Merging
```typescript
it('should merge partial YAML config with defaults', () => {
  const yaml = `plugins:
  indexing:
    - CustomIndexer
`;
  writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

  const config = loadConfig(testDir);

  assert.deepStrictEqual(config.plugins.indexing, ['CustomIndexer']);
  // Other phases should use defaults
  assert.deepStrictEqual(config.plugins.analysis, DEFAULT_CONFIG.plugins.analysis);
});
```

### 4. Testing Error Handling
```typescript
it('should handle invalid YAML gracefully', () => {
  const invalidYaml = `plugins:
  indexing: [this is not: valid yaml
`;
  writeFileSync(join(grafemaDir, 'config.yaml'), invalidYaml);

  const logger = createLoggerMock();
  const config = loadConfig(testDir, logger);

  assert.deepStrictEqual(config, DEFAULT_CONFIG, 'should return defaults on parse error');
  assert.ok(logger.warnings.some(w => w.includes('Failed to parse')), 'should warn about parse error');
});
```

## Coverage Areas

### Functional Coverage
- ✅ YAML loading (valid, partial, invalid)
- ✅ JSON loading (valid, partial, invalid)
- ✅ Format precedence (YAML > JSON)
- ✅ No config (defaults)
- ✅ Parse errors (graceful degradation)
- ✅ Config merging (partial + defaults)

### Edge Case Coverage
- ✅ Empty files
- ✅ Comments-only files
- ✅ Empty arrays `[]`
- ✅ Null values
- ✅ Extra whitespace
- ✅ Inline array syntax
- ✅ Mixed comments
- ✅ Missing .grafema directory

### Error Path Coverage
- ✅ Invalid YAML syntax
- ✅ Invalid JSON syntax
- ✅ Parse errors include details
- ✅ Warnings sent to logger
- ✅ Graceful fallback to defaults

### Integration Coverage
- ✅ Logger injection (custom vs default)
- ✅ DEFAULT_CONFIG structure validation
- ✅ Expected plugins present

## Notes

### Design Decisions

1. **Test fixtures in temporary directory**
   - Location: `test-fixtures/config-loader/`
   - Cleaned before/after each test
   - Prevents test interference

2. **Logger mock instead of console spying**
   - Cleaner than mocking console.warn
   - Matches ConfigLoader's logger parameter
   - Easy to verify warnings programmatically

3. **Comprehensive edge cases**
   - Empty files, null values, whitespace variations
   - Real-world YAML formatting scenarios
   - Based on Joel's spec section 4.1

4. **DEFAULT_CONFIG validation**
   - Tests verify structure exists
   - Tests verify non-empty defaults
   - Tests verify expected plugins present
   - Ensures consistency with spec

### Test Communication Intent

Each test name answers: **"What behavior is expected?"**

Examples:
- `should load valid YAML config` → Clear success case
- `should handle invalid YAML gracefully` → Error handling
- `should prefer YAML when both exist` → Precedence rule
- `should not warn about JSON when YAML exists` → No noise

### Alignment with Joel's Spec

All test cases directly map to Section 4.1 of Joel's technical plan:

| Spec Section | Test Group |
|--------------|------------|
| 4.1.1 - YAML loading | YAML config tests |
| 4.1.2 - JSON fallback | JSON config tests |
| 4.1.3 - Precedence | YAML precedence tests |
| 4.1.4 - No config | No config file tests |
| 4.1.5 - Edge cases | Edge cases tests |
| 4.1.6 - Logger | Logger injection tests |

### What's NOT Tested Here

These are integration/E2E concerns, not unit tests:

- ❌ CLI command integration (covered by `cli.test.ts`)
- ❌ MCP server integration (covered by MCP tests)
- ❌ File system permissions (assumed working)
- ❌ `init` command output (separate test file)

### Next Steps for Rob

When Rob implements ConfigLoader, these tests will guide the implementation:

1. **Create** `packages/core/src/config/ConfigLoader.ts`
2. **Implement** `loadConfig()` function matching spec
3. **Export** `DEFAULT_CONFIG` constant
4. **Run tests** - they should pass after implementation
5. **Verify** all 29 test cases pass

If any test fails:
- Read test name to understand expected behavior
- Check Joel's spec for implementation details
- Fix implementation, not tests (unless test is wrong)

### Test Quality Checklist

- ✅ Tests written BEFORE implementation (TDD)
- ✅ Tests FAIL initially (verified)
- ✅ Test names communicate intent clearly
- ✅ Both success and failure paths tested
- ✅ Edge cases covered comprehensively
- ✅ Error messages validated
- ✅ Logger integration tested
- ✅ No mocks in production code paths (logger is interface, not mock)
- ✅ Isolated fixtures (no test interference)
- ✅ Matches existing project patterns

## Observations

1. **Joel's spec is comprehensive** - Section 4.1 had all the test cases needed
2. **YAML edge cases matter** - Empty files, null values, comments need handling
3. **Logger injection is clean** - Allows CLI/MCP to control warning output
4. **Config merging is critical** - Partial configs must merge with defaults correctly
5. **Error handling is forgiving** - Parse errors don't crash, just warn and use defaults

## Ready for Rob

All tests written, verified to fail as expected. Rob can now:

1. Read Joel's spec Section 1.1 (ConfigLoader implementation)
2. Implement ConfigLoader to pass these tests
3. Run tests to verify implementation
4. Move on to CLI/MCP integration

Tests communicate the contract clearly - no ambiguity about expected behavior.
