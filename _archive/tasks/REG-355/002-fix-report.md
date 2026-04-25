# REG-355: Fix Report

## Root Cause

The original issue reported was that TypeScript errors in CLI (missing `ExpressHandlerLinker` export, unknown `silent` option) blocked typecheck. However, investigation revealed:

1. **`ExpressHandlerLinker`** - IS correctly exported from `@grafema/core` (line 217 of index.ts)
2. **`silent` option** - IS correctly defined in `RFDBServerBackendOptions` (line 53 of RFDBServerBackend.ts)

The **actual root cause** was a merge conflict artifact in `GraphBuilder.ts` that caused TypeScript compilation to fail:

- **Duplicate import**: `UpdateExpressionInfo` was imported twice (lines 44 and 52)
- **Duplicate destructuring**: `updateExpressions = []` appeared twice (lines 153 and 157)
- **Duplicate function call**: `bufferUpdateExpressionEdges()` was called twice (lines 370 and 376)
- **Duplicate function definition**: `bufferUpdateExpressionEdges()` was defined twice (lines 2372 and 2715)

This caused core package build to fail, which caused CLI to fail with "Cannot find module '@grafema/core'".

## Fix Applied

Removed the duplicate code in `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`:

1. Removed duplicate `UpdateExpressionInfo` import (kept one at line 44)
2. Removed duplicate `updateExpressions = []` destructuring (kept one at line 152)
3. Removed older function call with 3 parameters (kept newer call with 4 parameters at line 370)
4. Removed older function implementation (3 parameters, REG-288 only) and kept newer implementation (4 parameters, REG-288 + REG-312)

## Verification

- `pnpm typecheck` passes for `@grafema/cli` and `@grafema/core`
- `pnpm build` completes successfully for both packages
- `GraphBuilder` can be loaded and instantiated without errors
- `ExpressHandlerLinker` is correctly exported and usable
- `RFDBServerBackend` accepts `silent` option

## Files Changed

- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - removed merge conflict artifacts
