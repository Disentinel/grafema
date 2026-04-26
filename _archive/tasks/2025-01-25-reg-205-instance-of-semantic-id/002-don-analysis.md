# Don Melton - Technical Analysis: REG-205

## Executive Summary

INSTANCE_OF edges are broken because `GraphBuilder.bufferClassNodes()` hardcodes a **legacy ID format** for external classes, while the actual CLASS nodes created by `ClassVisitor` use **semantic IDs**. The edge points to a non-existent node.

## Root Cause Location

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Function:** `bufferClassNodes()` (lines 458-479)
**Exact problem:** Line 467

```typescript
// Line 467 - THE BUG
classId = `${module.file}:CLASS:${className}:0`;
```

This generates a legacy format ID like `/path/file.js:CLASS:SocketService:0`

But CLASS nodes are created in `ClassVisitor` using `ClassNode.createWithContext()` which generates semantic IDs:
```typescript
// ClassVisitor.ts line 177-182
const classRecord = ClassNode.createWithContext(
  className,
  scopeTracker.getContext(),
  { line: classLine, column: classColumn },
  { superClass: superClassName || undefined }
);
```

Semantic ID format: `socketService.ts->global->CLASS->SocketService`

## Why The Mismatch Exists

Historical context:
1. CLASS nodes were originally created using `ClassNode.create()` which used legacy `{file}:CLASS:{name}:{line}` format
2. ClassNode was migrated to semantic IDs with `createWithContext()` (see task `2025-01-22-nodefactory-classnode`)
3. GraphBuilder's `bufferClassNodes()` was **not updated** to use the new ID format
4. The code uses `line: 0` (unknown location) for external classes, which was a reasonable workaround for legacy IDs but doesn't translate to semantic IDs

## Code Flow Analysis

When analyzing `const service = new SocketService()`:

1. **VariableVisitor** (line 197) pushes to `classInstantiations`:
   ```typescript
   { variableId: varId, variableName: 'service', className: 'SocketService', ... }
   ```

2. **GraphBuilder.bufferClassNodes()** processes instantiations:
   - Checks if className exists in local `classDeclarations` (line 461)
   - If not found (imported class), generates ID manually (line 467):
     ```typescript
     classId = `${module.file}:CLASS:${className}:0`;  // BUG
     ```

3. Creates INSTANCE_OF edge pointing to non-existent node ID

## High-Level Fix Approach

### Option A: Use ClassNode Factory (Recommended)

Replace manual ID string with `ClassNode.createWithContext()` for consistency:

```typescript
// Instead of: classId = `${module.file}:CLASS:${className}:0`;
// Use the factory with proper scope context
const globalContext: ScopeContext = { file: module.file, scopePath: [] };
classId = ClassNode.createWithContext(
  className,
  globalContext,
  { line: 0 },  // Still unknown location
  { isInstantiationRef: true }
).id;
```

This ensures ID format consistency regardless of where the class is defined.

### Option B: Direct Semantic ID Computation

Use `computeSemanticId()` directly:
```typescript
import { computeSemanticId } from '../../core/SemanticId.js';
// ...
const globalContext = { file: module.file, scopePath: [] };
classId = computeSemanticId('CLASS', className, globalContext);
```

**Rationale for Option A:** ClassNode factory is the canonical way to create CLASS-related IDs. It enforces consistency and handles edge cases.

## Additional Considerations

### 1. InstanceOfResolver Still Needed

The `InstanceOfResolver` enrichment plugin handles cross-file resolution (when class is in a different file). It will still be needed because:
- During analysis, we don't know which file contains the actual class definition
- InstanceOfResolver runs after all files are analyzed and can resolve imports

However, InstanceOfResolver also has ID format assumptions that may need review.

### 2. Same-File Class Lookup Works

The `declarationMap` lookup (line 453) works correctly because it uses `decl.id` from the actual ClassNodeRecord, which has the semantic ID.

### 3. Test Coverage

Need to add/update tests in:
- `test/unit/GraphBuilderClassEdges.test.js`
- Verify INSTANCE_OF edge destination matches CLASS node ID

## Risks

1. **Low risk:** Fix is isolated to one method in GraphBuilder
2. **Medium risk:** InstanceOfResolver may have similar legacy ID assumptions - needs review
3. **Low risk:** No migration needed since this is a bug fix, not a format change

## Acceptance Criteria Verification

After fix:
- [ ] INSTANCE_OF edges use semantic ID format - **requires code change**
- [ ] Edge destination matches actual CLASS node ID - **requires code change**
- [ ] Query "instances of class X" works - **test after fix**
- [ ] Tests pass - **test after fix**

## Recommendation

This is a clear bug from incomplete migration to semantic IDs. Fix should:
1. Update `GraphBuilder.bufferClassNodes()` to use `computeSemanticId()` or `ClassNode.createWithContext()`
2. Review `InstanceOfResolver` for similar issues
3. Add regression test

Estimated effort: 30-60 minutes including tests.
