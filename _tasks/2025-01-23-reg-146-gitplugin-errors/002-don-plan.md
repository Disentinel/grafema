# Don Melton - Analysis and Plan

## Codebase Analysis

Reviewed:
- `packages/core/src/plugins/vcs/GitPlugin.ts` - 345 lines
- `packages/core/src/errors/GrafemaError.ts` - error hierarchy
- `packages/core/src/diagnostics/DiagnosticCollector.ts` - error collection
- `packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts` - caller

## Current State: Silent Catch Blocks

Found **10 catch blocks** in GitPlugin:

| Line | Method | Current Behavior | Decision |
|------|--------|------------------|----------|
| 59-61 | `isAvailable()` | `return false` | **KEEP** - Checking availability |
| 103-105 | `getChangedFiles()` inner | Silent, continues | **FIX** - Report error |
| 115-118 | `getChangedFiles()` outer | `console.error` + `return []` | **FIX** - Throw |
| 135-138 | `getCommittedContent()` | `return null` | **KEEP** - File may not exist in HEAD |
| 154-157 | `getFileDiff()` | `console.error` + `return empty` | **FIX** - Throw |
| 167-169 | `getCurrentBranch()` | `return 'unknown'` | **FIX** - Throw |
| 179-181 | `getLastCommitHash()` | `return null` | **FIX** - Throw |
| 191-193 | `isTracked()` | `return false` | **KEEP** - Uses --error-unmatch |
| 311-314 | `getAllTrackedFiles()` | `console.error` + `return []` | **FIX** - Throw |
| 332-334 | `getLastCommitInfo()` | `return null` | **FIX** - Throw |

## Design Decisions

### 1. Throw vs. Return Fallback

**Decision: Throw FileAccessError for unexpected failures**

Rationale:
- Methods like `isAvailable()` and `isTracked()` are *checking* state - returning false on error is correct
- Methods like `getChangedFiles()` are *retrieving* data - silent fallbacks hide real problems
- Throwing allows callers to decide: catch and continue, or propagate to DiagnosticCollector

### 2. Error Codes

Use codes already defined in FileAccessError:
- `ERR_GIT_NOT_FOUND` - Git command failed (git not installed or not a repo)
- `ERR_GIT_ACCESS_DENIED` - Permission or corruption issues

Additional context in error message distinguishes specific failures.

### 3. Caller Updates

`IncrementalAnalysisPlugin.execute()` already has try/catch at line 104.
The thrown FileAccessError will be caught and can be added to `PluginResult.errors[]`.

However, the current catch block at line 230+ returns `createErrorResult()` with generic error.
Should catch GitPlugin errors specifically and add them to errors array while continuing.

### 4. Backward Compatibility

**Breaking change**: Methods that previously returned fallbacks now throw.

Acceptable because:
- REG-78 introduced the error infrastructure specifically for this
- Silent failures are bugs, not features
- Callers should handle errors properly

## High-Level Plan

1. **Add FileAccessError import to GitPlugin**

2. **Fix 6 methods to throw on failure**:
   - getChangedFiles() - both inner and outer catch
   - getFileDiff()
   - getCurrentBranch()
   - getLastCommitHash()
   - getAllTrackedFiles()
   - getLastCommitInfo()

3. **Update IncrementalAnalysisPlugin** to handle thrown errors gracefully
   - Catch FileAccessError specifically
   - Add to errors array
   - Continue with partial results if possible

4. **Write tests** that verify:
   - Errors are thrown with correct codes
   - Errors contain helpful suggestions
   - Callers can catch and report properly

## Alignment with Vision

This change aligns with Grafema's vision:
- **Visibility**: No more hidden failures
- **AI-friendly**: Errors are structured and queryable
- **Diagnostics**: Errors flow to DiagnosticCollector for analysis

## Risks

- **Breaking change**: Callers that expected fallback values will now get exceptions
- **Mitigation**: The only caller (IncrementalAnalysisPlugin) already has try/catch

## Recommendation

**Proceed with implementation.** This is a straightforward fix with clear scope.
Mini-MLA sufficient: Don → Kent → Rob → Linus
