# Kent Beck Test Report: REG-217 Phase 0

## Summary

Created three test files for Phase 0 of REG-217: Fix validator contract so validators return ValidationError in errors array.

All tests are written to **fail until implementation is complete** - this is intentional TDD.

## Test Files Created

### 1. `/test/unit/errors/ValidationError.test.ts`

**Purpose:** Test the new `ValidationError` class.

**Tests:**
- Basic construction (code, message, context)
- Default severity is 'warning'
- Optional suggestion parameter
- Configurable severity (warning, error, fatal)
- Extends GrafemaError and Error
- Correct name property
- Works with PluginResult.errors[] (Error[] compatibility)
- toJSON() returns expected structure
- Stack trace is captured
- Real validator error codes (ERR_UNRESOLVED_CALL, ERR_DISCONNECTED_NODES, ERR_MISSING_ASSIGNMENT, ERR_BROKEN_REFERENCE, ERR_NO_LEAF_NODE)

**Current Status:** FAILS (ValidationError not exported from @grafema/core)

### 2. `/test/unit/types/createSuccessResult.test.ts`

**Purpose:** Test the enhanced `createSuccessResult` with errors parameter.

**Tests:**
- Backward compatibility (no errors parameter)
- Works with only created parameter
- Works with created and metadata parameters
- Accepts errors array as third parameter
- Accepts multiple errors
- Accepts empty errors array explicitly
- Preserves metadata when errors provided
- Returns valid PluginResult type
- Validator use case: success=true with errors

**Current Status:** PARTIALLY FAILS (backward compatibility tests pass, new errors parameter tests fail)

### 3. `/test/unit/diagnostics/ValidationErrorIntegration.test.ts`

**Purpose:** Integration tests for ValidationError flowing through diagnostic pipeline.

**Tests:**
- DiagnosticCollector.addFromPluginResult() extracts ValidationError
- Preserves warning severity from ValidationError
- Preserves error severity from ValidationError
- Handles multiple ValidationErrors from one result
- hasWarnings() returns true for warning severity ValidationError
- hasErrors() returns true for error severity ValidationError
- hasErrors() returns false for warning severity ValidationError
- getByCode() filters by validation error code
- getByPlugin() filters by validator plugin name
- getByPhase() returns all validation phase diagnostics
- toDiagnosticsLog() serializes ValidationError to JSON
- Real-world scenarios for CallResolverValidator, GraphConnectivityValidator, DataFlowValidator

**Current Status:** FAILS (ValidationError not exported from @grafema/core)

## Test Run Commands

```bash
# Run ValidationError tests
node --import tsx --test test/unit/errors/ValidationError.test.ts

# Run createSuccessResult tests
node --import tsx --test test/unit/types/createSuccessResult.test.ts

# Run integration tests
node --import tsx --test test/unit/diagnostics/ValidationErrorIntegration.test.ts

# Run all Phase 0 tests
node --import tsx --test test/unit/errors/ValidationError.test.ts test/unit/types/createSuccessResult.test.ts test/unit/diagnostics/ValidationErrorIntegration.test.ts
```

## Implementation Checklist (for Rob)

Tests verify these implementation requirements:

1. **ValidationError class** (`packages/core/src/errors/GrafemaError.ts`)
   - [ ] Extends GrafemaError
   - [ ] Constructor: `(message, code, context, suggestion?, severity?)`
   - [ ] Default severity: 'warning'
   - [ ] Configurable severity: 'warning' | 'error' | 'fatal'
   - [ ] name property = 'ValidationError'

2. **Export ValidationError** (`packages/core/src/index.ts`)
   - [ ] Export ValidationError class
   - [ ] Export in same group as other error classes

3. **createSuccessResult with errors** (`packages/types/src/plugins.ts`)
   - [ ] Add third parameter: `errors: Error[] = []`
   - [ ] Pass errors to returned PluginResult.errors

## Notes

- Tests follow existing patterns from `GrafemaError.test.ts` and `DiagnosticCollector.test.ts`
- All tests use `node:test` and `node:assert`
- Tests are designed to be runnable individually or together
- Integration tests verify the complete flow: Validator -> PluginResult.errors -> DiagnosticCollector
