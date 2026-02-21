# REG-551: Rob Implementation Report

## Summary

Fixed CLASS nodes storing `file = "Orchestrator.ts"` (basename only) instead of `file = "packages/core/src/Orchestrator.ts"` (relative path from workspace root). Root cause: `ScopeTracker` was initialized with `basename(module.file)` in two places, and downstream builders used `basename()` to compensate for the mismatch.

## Files Changed

### 1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (line 1692)

Changed ScopeTracker initialization from `basename(module.file)` to `module.file`:

```typescript
// Before
const scopeTracker = new ScopeTracker(basename(module.file));
// After
const scopeTracker = new ScopeTracker(module.file);
```

The `basename` import is kept -- it's used elsewhere in this file.

### 2. `packages/core/src/core/ASTWorker.ts`

Three changes:

- Added `relativeFile: string` to `ParseMessage` interface
- Changed `parseModule` signature to accept `relativeFile` parameter
- Changed ScopeTracker initialization from `basename(filePath)` to `relativeFile`
- Updated message handler to pass `msg.relativeFile` to `parseModule`
- Removed unused `basename` import

### 3. `packages/core/src/core/ASTWorkerPool.ts`

Four changes:

- Added `relativeFile: string` to `ParseTask` interface
- Changed `parseModule` method signature to accept `relativeFile` parameter
- Updated `parseModules` to pass `m.file` as `relativeFile`
- Added `relativeFile: task.relativeFile` to both `postMessage` calls (`_dispatchNext` and `_workerReady`)

### 4. `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts` (line ~137)

- Removed `const moduleBasename = basename(module.file)` variable
- Changed `decl.file === moduleBasename` to `decl.file === module.file`
- Changed `globalContext` to use `module.file` instead of `moduleBasename`
- Removed unused `basename` import

### 5. `packages/core/src/plugins/analysis/ast/builders/MutationBuilder.ts` (line ~198-201)

- Removed `const fileBasename = basename(file)` variable
- Changed `c.file === fileBasename` to `c.file === file`
- Removed unused `basename` import

### 6. `packages/core/src/plugins/analysis/ast/builders/UpdateExpressionBuilder.ts` (line ~192-194)

- Removed `const fileBasename = basename(file)` variable
- Changed `c.file === fileBasename` to `c.file === file`
- Removed unused `basename` import

## Build Results

Build completed successfully. No TypeScript errors. The Rust rfdb-server build produced pre-existing warnings only (unrelated).

## Test Results

| Test | Result |
|------|--------|
| `ClassVisitorClassNode.test.js` | 21/21 pass |
| `GraphSnapshot.test.js` (regenerated) | 6/6 pass |
| Full unit test suite | **2291 tests, 0 failures** |

Snapshots were regenerated with `UPDATE_SNAPSHOTS=true` since CLASS node semantic IDs now include the relative file path instead of basename.

5 skipped and 22 todo tests are pre-existing.

## Notes

- `ASTWorker.ts` still has the pre-REG-546 pattern where `isNewExpr` is included in `shouldBeConstant` (line 351). This is out of scope for REG-551.
- Semantic IDs for CLASS nodes now change format (e.g., `Orchestrator.ts->CLASS->MyClass` becomes `packages/core/src/Orchestrator.ts->CLASS->MyClass`). This is expected and correct behavior.
