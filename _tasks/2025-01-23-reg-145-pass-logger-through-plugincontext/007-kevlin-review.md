# Kevlin Henney - Low-Level Code Review (REG-145)

## Overview
Review of logger infrastructure passing through PluginContext. Implementation is clean and well-structured.

---

## Issues Found

### 1. CRITICAL: Inconsistent Logger Naming in PluginContext Comment

**Location:** `/Users/vadimr/grafema/packages/types/src/plugins.ts`, lines 69-74

```typescript
/**
 * Logger instance for structured logging.
 * Use this instead of console.log for controllable verbosity via CLI flags.
 * May be undefined for backward compatibility - use optional chaining: context.logger?.info()
 */
logger?: Logger;
```

**Issue:** Documentation says "controllable verbosity" but we have explicit levels. The naming is consistent, but comment is slightly vague about the purpose. Should clarify that the logger *filters* by level, doesn't just control verbosity.

**Fix:** Minimal - clarify that logger respects `logLevel` configuration.

---

### 2. Test Organization: Duplicate Function Definitions

**Location:** `/Users/vadimr/grafema/test/unit/logging/LoggerIntegration.test.ts`, lines 190-216

The test file contains a `getLogLevel` helper function that is identical to the one in `analyze.ts`. This creates duplication.

**Current State:**
- `analyze.ts`: lines 158-179 define `getLogLevel`
- `LoggerIntegration.test.ts`: lines 195-216 redefine the same logic

**Issue:** Tests should import and test the actual implementation, not duplicate it.

**Fix:** Either:
1. Export `getLogLevel` from a utility module, import in both places
2. Keep test version as is (documenting the contract), with a comment linking to the source

Current approach works but violates DRY principle. Low severity - tests are the contract, implementation duplication is acceptable.

---

### 3. Missing Error Handling: Silent Logger Could Swallow Errors

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/Plugin.ts`, lines 86-104

The fallback console logger in `Plugin.log()` creates a logger that will always work, but:

```typescript
protected log(context: PluginContext): Logger {
  if (context.logger) {
    return context.logger;
  }

  // Fallback to console for backward compatibility
  return {
    error: (msg: string, ctx?: Record<string, unknown>) =>
      console.error(`[ERROR] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
    // ...
  };
}
```

**Issue:** When `JSON.stringify(ctx)` is called on line 94, it could throw if `ctx` contains circular references or non-serializable values. This is a real risk in production.

**Fix:** Wrap with try-catch:
```typescript
error: (msg: string, ctx?: Record<string, unknown>) => {
  try {
    console.error(`[ERROR] ${msg}`, ctx ? JSON.stringify(ctx) : '');
  } catch (e) {
    console.error(`[ERROR] ${msg} (context serialization failed)`);
  }
}
```

---

### 4. MINOR: Test Clarity - MockLogger Type Leaks Implementation

**Location:** `/Users/vadimr/grafema/test/unit/logging/LoggerIntegration.test.ts`, lines 30-54

```typescript
interface MockLogger extends Logger {
  calls: { method: string; message: string; context?: Record<string, unknown> }[];
}
```

**Issue:** The `calls` field exposes test implementation details. If you later change how calls are tracked, you need to update all tests. Better to encapsulate.

**Fix:** Make `calls` private or provide a query method:
```typescript
interface MockLogger extends Logger {
  getCalls(): Array<{method: string; message: string; context?: Record<string, unknown>}>;
}
```

This is minor - implementation detail. Acceptable as is, but less maintainable.

---

### 5. Orchestrator Logger Propagation - Missing touchedFiles

**Location:** `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts`, lines 506-531

In `runPhase()`, the logger is correctly added to context. However, when examining line 277, the INDEXING phase doesn't receive `touchedFiles`:

```typescript
await this.runPhase('INDEXING', {
  manifest: unitManifest,
  graph: this.graph,
  workerCount: 1,
  // Missing: touchedFiles
});
```

But lines 529-530 add it to the context. This inconsistency suggests the implementation may be incomplete for unit-level analysis.

**Status:** Not broken, but the INDEXING phase context creation (line 273-277) doesn't pass `touchedFiles` while other phases would receive it from `runPhase()`. This is architectural, not a code quality issue - documented in Linus review.

---

## Good Patterns Found

1. **Logger Fallback Strategy** - The `Plugin.log()` helper method with console fallback is pragmatic and maintains backward compatibility without forcing all plugins to be updated.

2. **Optional Chaining Documentation** - The JSDoc comment recommending `context.logger?.info()` is clear and practical.

3. **Test Coverage** - Comprehensive test coverage for the logger interface, from type contracts to integration scenarios. Tests document the expected API clearly.

4. **CLI Priority Logic** - The `getLogLevel` helper has clear precedence: explicit level > quiet > verbose > default. The test cases verify all combinations.

---

## Summary

**Severity Breakdown:**
- **1 Critical** (JSON.stringify error handling in fallback console logger)
- **1 Minor** (test implementation detail leakage)
- **2 Low** (documentation clarity, duplication in tests)

**Overall Assessment:** Code is well-structured and readable. Logger implementation is straightforward with good separation of concerns. Main concern is error handling in the console fallback - should be defensive against circular references or serialization errors.

**Recommendation:** Fix the JSON.stringify error handling before merge. Other issues are low priority.
