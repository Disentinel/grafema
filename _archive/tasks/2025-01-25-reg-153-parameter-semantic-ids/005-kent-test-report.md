# Kent Beck Test Report: REG-153 PARAMETER Semantic IDs

## Summary

Added failing tests for REG-153: PARAMETER nodes should use semantic ID format instead of legacy format.

## Test File Location

`/Users/vadimr/grafema-worker-6/test/unit/Parameter.test.js`

New test suite: `PARAMETER semantic ID format (REG-153)` (lines 250-440)

## Tests Added

### 1. `should produce semantic ID for function parameters`
- Verifies that PARAMETER nodes have semantic ID format containing `->PARAMETER->`
- Verifies that PARAMETER IDs do NOT start with legacy `PARAMETER#` prefix

### 2. `should produce semantic IDs for all PARAMETER nodes - no legacy format allowed`
- Verifies that ALL PARAMETER nodes (at least 8 from fixtures) use semantic format
- Fails if ANY parameter uses legacy `PARAMETER#` format

### 3. `should include function scope in PARAMETER semantic ID`
- Verifies that PARAMETER ID includes parent function name in scope
- Example: `name` parameter should include `greet` in its ID

### 4. `should use index suffix for disambiguation in semantic ID`
- Verifies that parameters in same function have different IDs
- Verifies that IDs end with `#index` pattern (e.g., `#0`, `#1`)

### 5. `should produce semantic IDs for class method parameters`
- Verifies that class method parameters also use semantic format
- Tests against `test/fixtures/class-parameters` fixture

### 6. `should include class name in scope for class method parameters`
- Verifies that class parameter IDs include class name
- Example: `config` parameter should include `Processor` in its ID

## How to Run

```bash
node --test --test-name-pattern="PARAMETER semantic ID format" test/unit/Parameter.test.js
```

Or run all Parameter tests:
```bash
node --test test/unit/Parameter.test.js
```

## Expected Failure Message (Before Implementation)

Tests will fail with messages like:

```
PARAMETER should have semantic ID format (containing "->PARAMETER->"). Got: PARAMETER#name#index.js#4:0
```

or:

```
Found 8 parameters with legacy PARAMETER# format:
  - name: PARAMETER#name#index.js#4:0
  - greeting: PARAMETER#greeting#index.js#4:1
  - a: PARAMETER#a#index.js#9:0
  ...
```

## Current Code Analysis

Looking at `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`:

**Current (Legacy) Format:**
```typescript
const paramId = `PARAMETER#${name}#${file}#${line}:${index}`;
```

Example: `PARAMETER#name#index.js#4:0`

**Expected (Semantic) Format:**
```typescript
const paramId = `${file}->${scope}->PARAMETER->${name}#${index}`;
```

Example: `index.js->global->greet->PARAMETER->name#0`

## Test Verification Status

- [x] Test file created and syntactically valid (`node --check` passes)
- [x] Tests follow existing patterns from `ClassMethodSemanticId.test.js`
- [x] Helper functions `hasLegacyParameterFormat()` and `isSemanticParameterId()` implemented
- [ ] Tests run (requires RFDB server binary - rust-engine submodule not available)

## Environment Note

The tests could not be executed in this environment because the RFDB server binary is not built (rust-engine submodule is not initialized). However:

1. The test file is syntactically correct
2. The test logic matches the established patterns from REG-131 (ClassMethodSemanticId tests)
3. Based on source code analysis, the tests WILL FAIL because `createParameterNodes.ts` generates legacy `PARAMETER#...` format

## Files Changed

- `/Users/vadimr/grafema-worker-6/test/unit/Parameter.test.js` - Added new test suite (lines 250-440)

## Next Steps

Rob should implement semantic ID generation for PARAMETER nodes in:
- `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

The implementation should:
1. Accept scope information (function scope path)
2. Generate IDs in format: `${file}->${scope}->PARAMETER->${name}#${index}`
3. Match patterns from FUNCTION semantic ID migration (REG-131)
