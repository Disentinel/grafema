# Rob Fix Round 2 - REG-551

## Issues Fixed

### Issue 1: Parallel path passes absolute path as relativeFile

**Root cause:** In `JSASTAnalyzer.ts` `executeParallel`, `ModuleNode.file` (relative) was resolved to an absolute path via `resolveNodeFile()` and stored as `file` in the `ASTModuleInfo` object. But `ASTWorkerPool.parseModules` then passed `m.file` (now absolute) as the `relativeFile` parameter to `parseModule`. The ScopeTracker received an absolute path where it expected a relative one.

**Fix (3 files, 4 edits):**

1. **`packages/core/src/core/ASTWorkerPool.ts`** - Added `relativeFile: string` to the `ModuleInfo` interface (line 24). Updated `parseModules` to pass `m.relativeFile` instead of `m.file` as the 4th arg to `parseModule` (line 169).

2. **`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** - In `executeParallel`, added `relativeFile: m.file` to the module info mapping (line 530), capturing the original relative path before `resolveNodeFile()` converts `file` to absolute.

### Issue 2: Dead `basename` import

**Root cause:** `basename` from `path` was imported at line 8 but no longer used anywhere in the file (confirmed via grep - zero matches for `basename(`).

**Fix:** Removed the `import { basename } from 'path';` line entirely.

## Build & Test Results

- **Build:** Clean (pnpm build - all packages compiled successfully)
- **Tests:** 2291 tests, 0 failures, 5 skipped, 22 todo
