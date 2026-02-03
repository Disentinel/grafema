# Kent Beck Test Report: REG-330 Strict Mode

## Summary

I have written comprehensive TDD-style tests for the Strict Mode feature. The tests are designed to communicate intent clearly and will fail until implementation is complete.

## Test Files Created

### 1. `test/unit/errors/StrictModeError.test.ts`

Tests for the `StrictModeError` class itself:

| Test Category | Tests | Purpose |
|---------------|-------|---------|
| Basic construction | 6 tests | Verify class structure: extends GrafemaError, sets code/message/context correctly, severity=fatal |
| Error codes | 5 tests | Each error code (STRICT_UNRESOLVED_METHOD, STRICT_UNRESOLVED_CALL, etc.) is testable |
| toJSON() | 3 tests | JSON serialization works correctly for diagnostics |
| PluginResult compatibility | 2 tests | Works with Error[] type in PluginResult.errors |
| Stack trace | 1 test | Proper stack capture |
| Real enricher scenarios | 3 tests | Actionable error messages for real use cases |

**Total: 20 tests**

### 2. `test/unit/StrictMode.test.js`

Integration tests for strict mode behavior across enrichers:

| Test Category | Tests | Purpose |
|---------------|-------|---------|
| MethodCallResolver | 8 tests | Normal vs strict mode, external methods excluded, actionable messages |
| FunctionCallResolver | 3 tests | Broken re-exports, external imports excluded |
| ArgumentParameterLinker | 2 tests | Unresolved calls with arguments |
| AliasTracker | 2 tests | Depth exceeded handling |
| Error collection | 2 tests | Multiple errors collected (not fail-fast) |
| Mixed resolved/unresolved | 1 test | Only unresolved produces errors |
| Default behavior | 1 test | strictMode undefined = false |

**Total: 19 tests**

## Key Test Scenarios Covered

### From Joel's Spec

1. **Unresolved method call in strict mode produces fatal error** - COVERED
2. **Same scenario in non-strict mode produces warning only** - COVERED
3. **External methods (console.log, Math.random) NOT flagged** - COVERED
4. **Multiple errors collected, all reported** - COVERED

### From Linus's Review

1. **Error messages are actionable** - COVERED (tests verify file, line, suggestion present)
2. **External method list is complete** - COVERED (console, Math, JSON, Promise tested)
3. **Exit code semantics** - Not directly testable at unit level; CLI integration test needed

## Test Pattern

Tests follow existing codebase patterns:
- Same `setupBackend()` helper pattern as MethodCallResolver.test.js
- Same import style from @grafema/core
- Same assertion patterns with `assert.strictEqual`
- TypeScript for error class tests (matching GrafemaError.test.ts pattern)
- JavaScript for enricher integration tests (matching existing enricher tests)

## Current Test Status

```
StrictModeError.test.ts: FAILS (StrictModeError not exported from @grafema/core)
StrictMode.test.js: FAILS (StrictModeError not exported from @grafema/core)
```

This is expected! TDD means tests fail first, then implementation makes them pass.

## What the Tests Communicate

Reading these tests, a developer should understand:

1. **What StrictModeError is**: A fatal error for unresolved references in strict mode
2. **When it's thrown**: Only when `strictMode: true` AND reference cannot be resolved
3. **What's NOT an error**: External methods, already-resolved calls, strictMode=false
4. **How errors are collected**: All at once, not fail-fast
5. **Error message quality**: Must include file, line, plugin name, and actionable suggestion

## Notes for Rob

When implementing, ensure:

1. `StrictModeError` class is added to `packages/core/src/errors/GrafemaError.ts`
2. `StrictModeError` is exported from `packages/core/src/index.ts`
3. Each enricher checks `context.strictMode` flag
4. Errors are pushed to `errors` array and returned in `PluginResult`
5. External method detection uses existing `isExternalMethod()` in MethodCallResolver

## Verification Command

After implementation, run:

```bash
node --import tsx --test test/unit/errors/StrictModeError.test.ts
node --test test/unit/StrictMode.test.js
```

All 39 tests should pass.

---

*Written by Kent Beck, Test Engineer*
*2026-02-03*
