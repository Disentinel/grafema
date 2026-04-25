# REG-551 Test Report: CLASS node file path

**Author:** Kent Beck (Test Engineer)
**Task:** Write tests that prove the REG-551 fix is correct

## Bug Summary

CLASS nodes store `file = "Service.js"` (basename only) instead of `file = "src/Service.js"` (relative path from project root). This breaks `getAllNodes({ file: relPath })` queries because the stored file field doesn't match the relative path that callers provide.

## What Was Written

### File Modified

`/Users/vadimr/grafema-worker-2/test/unit/ClassVisitorClassNode.test.js`

### Changes to Existing Code

1. **Added `dirname` import** from `path` module (line 19)
2. **Updated `setupTest` helper** to support nested file paths (e.g., `'src/Service.js'`). The helper now creates parent directories before writing each file via `mkdirSync(dirname(filePath), { recursive: true })`. This is backward-compatible -- root-level files still work identically since `dirname('index.js')` resolves to `.`.

### New Test Section: CLASS node file field (REG-551)

Four tests that directly verify the file path fix:

| Test | What It Proves |
|------|---------------|
| `should store relative path in file field, not basename, when class is in subdirectory` | Core bug test. Creates `src/Service.js`, asserts `classNode.file === 'src/Service.js'` and `classNode.file !== 'Service.js'`. |
| `should store relative path for class in deeply nested directory` | Stress test with `src/api/controllers/Controller.js`. Same assertion pattern at 3 levels deep. |
| `should store filename without path for class at project root` | Regression guard. Root-level classes must still have `classNode.file === 'index.js'`. The fix must not break what already works. |
| `should use relative path in semantic ID for subdirectory class` | Semantic ID format is `{file}->{scope}->CLASS->{name}`. Asserts the ID starts with `src/Widget.js->`, not `Widget.js->`. |

### New Test Section: MutationBuilder downstream (REG-551)

Two tests that verify the downstream MutationBuilder fix:

| Test | What It Proves |
|------|---------------|
| `should create FLOWS_INTO edge for this.prop = value when class is in subdirectory` | `MutationBuilder.bufferObjectMutationEdges()` uses `classDeclarations.find(c => c.file === ...)` to locate the CLASS node for `this.prop = value` patterns. Before the fix, it used `basename(file)` to compensate for classes storing basenames. After the fix, both sides must use relative paths. This test verifies FLOWS_INTO edge is created with correct metadata (`mutationType: 'this_property'`, `propertyName: 'handler'`). |
| `should create FLOWS_INTO edges for multiple this.prop assignments in subdirectory class` | Same scenario with 3 constructor parameters (`db`, `cache`, `logger`). Verifies all 3 FLOWS_INTO edges are created. Uses deeper nesting (`src/deep/Service.js`). |

## Why These Tests

### The core test is about distinguishable paths

The bug is invisible when files are at the project root, because `basename("index.js") === "index.js"`. The tests MUST place classes in subdirectories so that `basename("src/Service.js") = "Service.js"` differs from the relative path `"src/Service.js"`. Every new test uses this subdirectory strategy.

### MutationBuilder is the known downstream consumer

`MutationBuilder.ts` lines 198-201 contain a workaround:
```typescript
const fileBasename = basename(file);
const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === fileBasename);
```

This `basename()` call compensates for the CLASS node storing basenames. When the fix changes CLASS nodes to store relative paths, this `basename()` workaround must also be updated. The MutationBuilder tests verify end-to-end correctness of the `this.prop = value` flow after both changes.

### Regression guard for root-level classes

The fix changes how `file` is computed. Root-level classes must continue working. The "class at project root" test ensures the fix doesn't accidentally break the common case.

## Expected Test Behavior

- **Before fix:** The 4 file-path tests FAIL (classNode.file is basename). The 2 MutationBuilder tests may PASS (the `basename()` workaround still works) or FAIL (depending on fix order).
- **After fix (CLASS node only, MutationBuilder not updated):** File-path tests PASS. MutationBuilder tests FAIL (the `basename()` workaround now mismatches).
- **After both fixes:** All 6 tests PASS.

## Test Count

6 new tests added. 0 existing tests modified (only the helper and import were updated in a backward-compatible way).
