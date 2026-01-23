# Rob Pike's Implementation Report: REG-147

**Date:** January 23, 2026

## Summary

Implemented error reporting for parse failures in JSModuleIndexer using the established REG-78 error handling infrastructure.

## Changes Made

### File: `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**1. Added import for LanguageError (line 14):**
```typescript
import { LanguageError } from '../../errors/GrafemaError.js';
```

**2. Added error collection array in execute() (line 221):**
```typescript
// Collect parse errors to report (REG-147)
const parseErrors: Error[] = [];
```

**3. Updated error handling block (lines 281-298):**
```typescript
if (deps instanceof Error) {
  if (!deps.message.includes('ENOENT')) {
    const relativePath = relative(projectPath, currentFile) || basename(currentFile);
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
    parseErrors.push(error);
    console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);
  }
  continue;
}
```

**4. Updated return statement (lines 389-396):**
```typescript
// Return result with parse errors (REG-147)
return {
  success: true,
  created: { nodes: nodesCreated, edges: edgesCreated },
  errors: parseErrors,
  warnings: [],
  metadata: { totalModules: visited.size },
};
```

### New Test File: `test/unit/plugins/indexing/JSModuleIndexer.test.ts`

6 tests covering:
- Parse errors are collected as LanguageError
- ENOENT errors are silently skipped (not reported)
- Multiple parse errors are collected
- JSON files with syntax errors are handled specially (not reported)
- Node/edge counts are preserved when errors occur
- Error messages contain relative paths

## Test Results

```
# tests 6
# pass 6
# fail 0
```

Error handling integration tests: All 22 pass.

## Pattern Used

Following the documented pattern from REG-78 (`test/integration/error-handling.test.ts:108-132`):
- `success: true` - plugin completed execution
- `errors: [LanguageError]` - non-fatal warnings with severity='warning'

This allows DiagnosticCollector to properly categorize these as warnings (exit code 0, not failures).

## Verification

1. ✓ Parse failures logged as LanguageError
2. ✓ Errors appear in DiagnosticCollector via `addFromPluginResult()`
3. ✓ Summary shows errors as warnings (via DiagnosticReporter)
