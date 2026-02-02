# Kent Beck - Test Report for REG-273

## Test Strategy

Following TDD principles, I've written comprehensive tests for side-effect imports that will fail initially. These tests document the expected behavior and will guide Rob's implementation.

## Test Coverage

Added 8 test cases to `/Users/vadimr/grafema-worker-7/test/unit/GraphBuilderImport.test.js` in a new describe block: **"Side-effect-only imports (REG-273)"**

### Test Case 1: Basic Side-Effect Import Node Creation
**Intent:** Verify that `import './polyfill.js'` creates an IMPORT node in the graph.

**What it tests:**
- IMPORT node is created (not lost like the bug)
- `sideEffect: true` flag is set
- `imported: '*'` (no specific export)
- `local: './polyfill.js'` (source becomes local since no binding)

**Why this test matters:** This is the core bug fix - side-effect imports are currently completely ignored.

### Test Case 2: Regular Imports Have sideEffect: false
**Intent:** Verify backward compatibility - regular imports get `sideEffect: false`.

**What it tests:**
- Named imports like `import { foo } from './lib'` have `sideEffect: false`

**Why this test matters:** Ensures the new field doesn't break existing functionality.

### Test Case 3: Graph Structure - MODULE -> CONTAINS -> IMPORT
**Intent:** Verify graph edges are created correctly for side-effect imports.

**What it tests:**
- MODULE node contains IMPORT node via CONTAINS edge
- Graph structure is consistent with regular imports

**Why this test matters:** Side-effect imports must be part of the graph structure, not orphaned nodes.

### Test Case 4: External Side-Effect Imports
**Intent:** Verify external packages like `import 'core-js/stable'` work correctly.

**What it tests:**
- EXTERNAL_MODULE node is created for external package
- IMPORT node is created with `sideEffect: true`
- Both relative and external side-effect imports work

**Why this test matters:** Real-world polyfills are usually from npm packages.

### Test Case 5: Multiple Side-Effect Imports
**Intent:** Verify multiple side-effect imports in same file create separate nodes.

**What it tests:**
- Three side-effect imports create three separate IMPORT nodes
- Each has unique semantic ID
- Sources are correctly preserved

**Why this test matters:** Files often have multiple polyfills/CSS imports.

### Test Case 6: Semantic ID Format
**Intent:** Verify semantic ID follows `{file}:IMPORT:{source}:{source}` format.

**What it tests:**
- ID contains `:IMPORT:`
- ID contains source twice (redundant but consistent with pattern)
- `name` field is source (since no local binding)

**Why this test matters:** Semantic IDs must be stable across code changes.

### Test Case 7: Scoped Package Side-Effect Imports
**Intent:** Verify scoped packages like `@babel/polyfill` work correctly.

**What it tests:**
- Scoped package imports (with `@`) are handled
- `sideEffect: true` is set
- Source preserved correctly

**Why this test matters:** Many polyfills use scoped packages.

### Test Case 8: Mixed Regular and Side-Effect Imports
**Intent:** Verify both types of imports coexist in same file.

**What it tests:**
- File with both regular and side-effect imports
- Both types are created correctly
- Counts and sources are accurate

**Why this test matters:** Real files mix import types.

## Test Design Principles

### Intent Communication
Each test has clear assertions with descriptive messages. The test name tells you what should happen, the assertions verify it happened correctly.

### No Mocks in Production Paths
These are integration tests using real GraphBuilder, real AST parsing, real graph backend. We test the actual behavior, not mocked behavior.

### Test Pattern Consistency
I followed the existing patterns in `GraphBuilderImport.test.js`:
- Use `setupTest()` helper
- Create temporary test directories
- Check nodes with `getAllNodes()`
- Verify fields with strict equality
- Use descriptive assertion messages

### TDD: Tests First
These tests will FAIL initially because:
1. `ImportNode.sideEffect` field doesn't exist yet
2. `GraphBuilder.bufferImportNodes()` doesn't handle empty specifiers
3. Side-effect imports are currently lost (the bug)

Rob will implement the fix, and these tests will turn green.

## What's Being Tested

**File:** `/Users/vadimr/grafema-worker-7/test/unit/GraphBuilderImport.test.js`

**Lines added:** 419-596 (177 lines)

**Test suite:** "Side-effect-only imports (REG-273)"

**Dependencies:**
- Existing test infrastructure (TestRFDB, createTestOrchestrator)
- Existing setupTest helper
- Real RFDB backend
- Real AST parsing via JSASTAnalyzer

## Expected Failures (Before Implementation)

When run now, these tests should fail with:
- `sideEffectImport` is `undefined` (node not created at all)
- Or if nodes somehow exist, `sideEffect` field is `undefined`
- Graph structure assertions fail (no CONTAINS edges)

These failures will guide Rob's implementation.

## Next Steps for Rob

1. Add `sideEffect?: boolean` to `ImportNode.ts` OPTIONAL fields
2. In `GraphBuilder.bufferImportNodes()`, add check for `specifiers.length === 0`
3. Create IMPORT node with source as name, `sideEffect: true`
4. Ensure CONTAINS edge and EXTERNAL_MODULE logic work same as regular imports
5. Run tests - they should turn green

## Implementation Guidance

The tests show Rob exactly what fields to set:
```javascript
// From test expectations:
{
  sideEffect: true,
  imported: '*',
  local: './polyfill.js',  // or whatever the source is
  name: './polyfill.js',   // source becomes name
  source: './polyfill.js'
}
```

This is exactly what Don specified in his plan.

## Test Quality

**Strengths:**
- Clear intent in each test
- Tests document expected behavior
- Integration tests verify real behavior
- Follows existing patterns
- Good coverage of edge cases

**Coverage:**
- ✅ Basic side-effect import
- ✅ Regular imports backward compatibility
- ✅ Graph structure (edges)
- ✅ External packages
- ✅ Multiple imports
- ✅ Semantic ID format
- ✅ Scoped packages
- ✅ Mixed import types

**What's NOT tested (out of scope):**
- Dead code analysis behavior (future work)
- TypeScript type-only side-effect imports (rare)
- Dynamic imports (different feature)

## Conclusion

Tests are written following TDD principles. They will fail now and guide Rob's implementation. Once Rob fixes the bug and adds the `sideEffect` field, all tests should pass.

These tests permanently document that side-effect imports:
1. Must create IMPORT nodes (not be lost)
2. Must have `sideEffect: true` flag
3. Must follow semantic ID pattern
4. Must be part of graph structure

If someone breaks this in the future, tests will catch it immediately.
