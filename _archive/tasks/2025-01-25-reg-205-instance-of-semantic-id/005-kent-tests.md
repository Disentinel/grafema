# Kent Beck - Test Report: REG-205 INSTANCE_OF Semantic ID

## Summary

Created regression test that proves the bug exists. The test FAILS as expected, demonstrating that GraphBuilder uses legacy `:CLASS:` format instead of semantic ID format for INSTANCE_OF edges.

## Test Added

**File**: `/Users/vadimr/grafema-worker-6/test/unit/InstanceOfSemanticId.test.js`

**Test Structure**:
1. `semantic ID format verification` - Validates correct semantic ID format for CLASS nodes
2. `GraphBuilder source code verification` - Verifies GraphBuilder code patterns (FAILS proving bug)
3. `INSTANCE_OF edge dst format` - Documents expected behavior after fix

## Test Output (Proving Bug Exists)

```
TAP version 13
# INSTANCE_OF edge dst format comparison:
#   Current (buggy): src/index.js:CLASS:ExternalService:0
#   Expected (fix):  src/index.js->global->CLASS->ExternalService
#   CLASS node ID:   src/index.js->global->CLASS->ExternalService

# Subtest: REG-205: INSTANCE_OF semantic ID format
    # Subtest: semantic ID format verification
        ok 1 - should understand the correct semantic ID format for CLASS
        ok 2 - should show legacy format is different from semantic format
    ok 1 - semantic ID format verification

    # Subtest: GraphBuilder source code verification
        not ok 1 - should NOT have legacy :CLASS: format in GraphBuilder (REG-205 fix)
          ---
          error: |-
            GraphBuilder should NOT have legacy :CLASS: format.
            Found 2 occurrences:
            438:        const superClassId = `${file}:CLASS:${superClass}:0`;
            467:        classId = `${module.file}:CLASS:${className}:0`;
            Should use computeSemanticId('CLASS', ...) instead.

        not ok 2 - should use computeSemanticId for CLASS edge destinations (REG-205 fix)
          ---
          error: |-
            GraphBuilder should import computeSemanticId from SemanticId.js
            Current imports containing 'computeSemanticId': (none)

    not ok 2 - GraphBuilder source code verification

    # Subtest: INSTANCE_OF edge dst format (expected to FAIL)
        ok 1 - should verify INSTANCE_OF creates edges with semantic ID format
    ok 3 - INSTANCE_OF edge dst format

# tests 5
# pass 3
# fail 2
```

## What the Tests Verify

### 1. Semantic ID Format Verification (PASSING)
- Confirms CLASS nodes use semantic ID format: `{file}->global->CLASS->{name}`
- Confirms legacy format is different from semantic format
- Verifies `ClassNode.createWithContext()` and `computeSemanticId()` produce identical IDs

### 2. GraphBuilder Source Code Verification (FAILING - proves bug)
- **Test 1**: Looks for `:CLASS:` in GraphBuilder.ts code
  - Found 2 occurrences (lines 438 and 467)
  - Line 467 is the INSTANCE_OF bug (main focus of REG-205)
  - Line 438 is DERIVES_FROM edge (same bug, different edge type)

- **Test 2**: Checks if `computeSemanticId` is imported
  - Currently NOT imported
  - After fix, it should be imported from SemanticId.js

### 3. Format Comparison (PASSING - documentation)
- Documents current buggy format: `src/index.js:CLASS:ExternalService:0`
- Documents expected fix format: `src/index.js->global->CLASS->ExternalService`
- Confirms expected format matches CLASS node ID format

## Bug Location Confirmed

**File**: `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Lines with legacy format**:
- Line 438: `const superClassId = \`${file}:CLASS:${superClass}:0\`;` (DERIVES_FROM)
- Line 467: `classId = \`${module.file}:CLASS:${className}:0\`;` (INSTANCE_OF - main bug)

## Fix Requirements

To make tests PASS:
1. Import `computeSemanticId` from `../../core/SemanticId.js`
2. Replace line 467 with:
   ```typescript
   const globalContext = { file: module.file, scopePath: [] };
   classId = computeSemanticId('CLASS', className, globalContext);
   ```
3. Replace line 438 with similar fix for DERIVES_FROM edges

## Notes

- Test uses source code pattern matching (grep) instead of integration testing
- This approach doesn't require RFDB server infrastructure
- Test follows existing pattern from `NoLegacyClassIds.test.js`
- After fix, all tests should PASS

## Integration Test Added

Also added tests to existing integration test file:
**File**: `/Users/vadimr/grafema-worker-6/test/unit/GraphBuilderClassEdges.test.js`

Added new test block `INSTANCE_OF semantic IDs` with two tests:
1. `should create INSTANCE_OF edge with semantic ID for external class`
2. `should match actual CLASS node ID when class is defined`

These integration tests require RFDB server and will provide additional verification once infrastructure is available.

## Run Command

```bash
node --test test/unit/InstanceOfSemanticId.test.js
```

Expected output after fix: all 5 tests should PASS.
