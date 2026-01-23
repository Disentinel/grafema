# Don Melton's High-Level Plan: REG-147 - Update JSModuleIndexer to use GrafemaError

**Date:** January 23, 2026

## 1. Architecture Analysis

After reviewing the codebase, the error handling infrastructure from REG-78 is **fully in place** and ready for use:

### Available Infrastructure

| Component | Location | Status |
|-----------|----------|--------|
| `LanguageError` class | `/packages/core/src/errors/GrafemaError.ts:118-126` | Ready |
| `ERR_PARSE_FAILURE` code | Documented in GrafemaError | Available |
| `PluginResult.errors[]` | `/packages/types/src/plugins.ts:58` | Accepts `Error[]` |
| `DiagnosticCollector` | `/packages/core/src/diagnostics/DiagnosticCollector.ts` | Integrated |
| `DiagnosticReporter` | `/packages/core/src/diagnostics/DiagnosticReporter.ts` | Ready |
| Orchestrator integration | `/packages/core/src/Orchestrator.ts:518-526` | Already calls `addFromPluginResult()` |

## 2. Current Problem in JSModuleIndexer

**Location:** `/packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Problem 1 - Silent Error Caching (lines 138-144):**
```typescript
} catch (e) {
  if (filePath.endsWith('.json')) {
    this.cache.set(filePath, []);
    return [];
  }
  this.cache.set(filePath, new Error((e as Error).message));  // Error cached but never reported!
  return new Error((e as Error).message);
}
```

**Problem 2 - Silent Logging Only (lines 277-282):**
```typescript
if (deps instanceof Error) {
  if (!deps.message.includes('ENOENT')) {
    console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);  // Just logged, never reported!
  }
  continue;  // Silently skipped
}
```

**Result:** Users have no visibility into why files were skipped. DiagnosticCollector receives empty `errors[]` array.

## 3. Proposed Solution

The fix aligns perfectly with the existing architecture. Key insight: **errors need to accumulate during `execute()` and be returned in `PluginResult.errors[]`**.

### Changes Required

**A. Add Error Collection in JSModuleIndexer.execute():**

1. Create an `errors: Error[]` array at the start of `execute()`
2. When `processFile()` returns an Error, create a `LanguageError` and add to the array
3. Return errors in `createSuccessResult()` via a new helper or custom return

**B. Create LanguageError for Parse Failures:**

```typescript
const error = new LanguageError(
  `Failed to parse ${relativePath}: ${deps.message}`,
  'ERR_PARSE_FAILURE',
  {
    filePath: currentFile,
    phase: 'INDEXING',
    plugin: 'JSModuleIndexer',
  },
  'Check file syntax or ensure the file is a supported JavaScript/TypeScript file'
);
errors.push(error);
```

**C. Handle ENOENT vs Parse Errors Differently:**

- `ENOENT` (file not found) - This could be `FileAccessError` (different from parse failures)
- Syntax errors - These should be `LanguageError` with `ERR_PARSE_FAILURE`

## 4. Acceptance Criteria Verification

| Criteria | Implementation |
|----------|---------------|
| "Parse failures logged as LanguageError" | Create `LanguageError` in catch block |
| "Errors appear in DiagnosticCollector" | Return in `PluginResult.errors[]` - Orchestrator already handles this |
| "Summary shows X files skipped" | DiagnosticReporter.summary() already counts warnings |

**Important:** The third criterion ("X files skipped due to parse errors") requires verification. The current `DiagnosticReporter.summary()` outputs `Fatal: X, Errors: Y, Warnings: Z` format. Since `LanguageError` has `severity: 'warning'`, parse failures will appear as "Warnings: X".

If a specific "X files skipped due to parse errors" message is required, that would need enhancement to `DiagnosticReporter` to group by error code - but this is a separate concern (likely out of scope for this issue).

## 5. Design Decision: Is This the RIGHT Approach?

**YES.** This approach is correct because:

1. **Follows established patterns** - REG-78 designed exactly this flow
2. **Zero new abstractions** - Uses existing infrastructure
3. **Minimal changes** - Only JSModuleIndexer needs modification
4. **AI-first visibility** - Errors flow to diagnostics.log for agent consumption
5. **No breaking changes** - Existing behavior preserved, just enhanced

## 6. Concerns and Mitigations

**Concern 1: Error accumulation memory**
- **Risk:** Large codebases with many parse errors could accumulate many errors
- **Mitigation:** LanguageError is lightweight (~200 bytes each), thousands are acceptable
- **Alternative:** Add a MAX_ERRORS limit (but defer unless proven necessary)

**Concern 2: Distinguishing ENOENT from parse errors**
- **Decision:** ENOENT (file not found during resolution) is different from parse failure
- **Implementation:** Only create LanguageError for actual parse failures, not ENOENT
- ENOENT could be `FileAccessError` but may also indicate expected missing files (npm packages resolved to paths that don't exist) - keep as silent for now

**Concern 3: Existing tests**
- Check for existing JSModuleIndexer tests that might assume empty errors array
- Tests should be updated to verify error reporting

## 7. Files to Modify

| File | Change |
|------|--------|
| `/packages/core/src/plugins/indexing/JSModuleIndexer.ts` | Add LanguageError creation and return in errors[] |

## 8. Files to Reference (Patterns)

| File | Pattern |
|------|---------|
| `/packages/core/src/errors/GrafemaError.ts` | LanguageError class definition |
| `/test/unit/errors/GrafemaError.test.ts` | How to create LanguageError |
| `/test/unit/diagnostics/DiagnosticCollector.test.ts` | How errors flow through system |

## 9. Recommendation

**APPROVED for implementation.** This is a straightforward integration task using established infrastructure. The approach is RIGHT - it uses the error handling system as designed.

**Next Step:** Joel should create detailed tech spec with exact code changes and test specifications.

---

### Critical Files for Implementation

- `/Users/vadimr/grafema/packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Core file to modify
- `/Users/vadimr/grafema/packages/core/src/errors/GrafemaError.ts` - LanguageError class
- `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts` - Reference for error flow
- `/Users/vadimr/grafema/test/unit/errors/GrafemaError.test.ts` - Pattern for tests
- `/Users/vadimr/grafema/packages/types/src/plugins.ts` - PluginResult interface
