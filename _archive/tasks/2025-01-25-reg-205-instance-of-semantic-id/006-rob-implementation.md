# Rob Pike - Implementation Report: REG-205

## Summary

Fixed INSTANCE_OF and DERIVES_FROM edges to use semantic IDs instead of legacy `:CLASS:` format. Surgical fix with minimal changes to GraphBuilder.ts.

## Changes Made

**File**: `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Change 1: Added Import

Added import for `computeSemanticId` function:

```typescript
import { computeSemanticId } from '../../../core/SemanticId.js';
```

This follows the same import pattern used by other files in the same directory (e.g., `IdGenerator.ts`, `CallExpressionVisitor.ts`).

### Change 2: Fixed DERIVES_FROM Edge (Line 438)

**Before**:
```typescript
const superClassId = `${file}:CLASS:${superClass}:0`;
```

**After**:
```typescript
const globalContext = { file, scopePath: [] as string[] };
const superClassId = computeSemanticId('CLASS', superClass, globalContext);
```

This generates semantic IDs like `path/file.js->global->CLASS->ParentClass` instead of legacy `path/file.js:CLASS:ParentClass:0`.

### Change 3: Fixed INSTANCE_OF Edge (Line 467)

**Before**:
```typescript
classId = `${module.file}:CLASS:${className}:0`;
```

**After**:
```typescript
const globalContext = { file: module.file, scopePath: [] as string[] };
classId = computeSemanticId('CLASS', className, globalContext);
```

This generates semantic IDs like `path/file.js->global->CLASS->ClassName` instead of legacy `path/file.js:CLASS:ClassName:0`.

## Test Results

All 5 tests PASS:

```
TAP version 13
# Subtest: REG-205: INSTANCE_OF semantic ID format
    # Subtest: semantic ID format verification
        ok 1 - should understand the correct semantic ID format for CLASS
        ok 2 - should show legacy format is different from semantic format
    ok 1 - semantic ID format verification

    # Subtest: GraphBuilder source code verification
        ok 1 - should NOT have legacy :CLASS: format in GraphBuilder (REG-205 fix)
        ok 2 - should use computeSemanticId for CLASS edge destinations (REG-205 fix)
    ok 2 - GraphBuilder source code verification

    # Subtest: INSTANCE_OF edge dst format (expected to FAIL)
        ok 1 - should verify INSTANCE_OF creates edges with semantic ID format
    ok 3 - INSTANCE_OF edge dst format

# tests 5
# pass 5
# fail 0
```

## Build Status

TypeScript compilation succeeds with no errors:

```
packages/types build: Done
packages/rfdb build: Done
packages/core build: Done
packages/cli build: Done
packages/mcp build: Done
```

## Implementation Notes

1. **Minimal changes**: Only touched the import section and two specific locations identified by Kent's analysis
2. **Pattern matching**: Used same import path pattern as `IdGenerator.ts` in the same directory
3. **Type safety**: Added `as string[]` type annotation to empty array for TypeScript
4. **Comments updated**: Changed comments to reflect semantic ID approach, kept the "NO node creation" comment as instructed

## What Was NOT Changed

- No refactoring of surrounding code
- No changes to InstanceOfResolver (confirmed correct by Joel's analysis)
- No changes to existing tests
- Existing comments about dangling edges preserved
