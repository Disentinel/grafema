# Kent Beck - Test Report: REG-100

## Changes Made

### 1. Fixed failing test (lines 361-365)

The original test incorrectly expected `line=0` to throw an error:

```javascript
// BEFORE (wrong)
it('should throw when line is missing', () => {
  assert.throws(() => {
    NodeFactory.createImport('React', '/file.js', 0, 0, 'react');
  }, /line is required/);
});
```

Fixed by passing `undefined` instead of `0` and renaming the test:

```javascript
// AFTER (correct)
it('should throw when line is undefined', () => {
  assert.throws(() => {
    NodeFactory.createImport('React', '/file.js', undefined, 0, 'react');
  }, /line is required/);
});
```

**Rationale:** `line=0` is a valid value representing the first line of a file (0-indexed). The validation should only throw when line is `undefined` or `null`, not when it's 0.

### 2. Added positive test for line=0 (Linus requirement)

Added a new test that explicitly verifies `line=0` is accepted:

```javascript
it('should accept line=0 as valid (unlike undefined)', () => {
  const node = NodeFactory.createImport(
    'React',
    '/file.js',
    0,
    0,
    'react',
    { imported: 'default' }
  );

  assert.strictEqual(node.line, 0);
  assert.strictEqual(node.type, 'IMPORT');
  assert.strictEqual(node.id, '/file.js:IMPORT:react:React');
});
```

**Intent:** This test communicates that `line=0` is a legitimate value and should be distinguished from `undefined`. The test name makes this distinction explicit.

## Test Results

```
TAP version 13
# Subtest: NodeFactory.createImport
    # Subtest: Basic import node creation
        ok 1 - should create default import with semantic ID
        ok 2 - should create named import with semantic ID
        ok 3 - should create namespace import with semantic ID
        1..3
    ok 1 - Basic import node creation
    # Subtest: Auto-detection of importType
        ok 1 - should auto-detect default import from imported field
        ok 2 - should auto-detect namespace import from imported field
        ok 3 - should auto-detect named import from imported field
        ok 4 - should allow explicit importType override
        1..4
    ok 2 - Auto-detection of importType
    # Subtest: Semantic ID stability
        ok 1 - should create stable IDs (same binding, different lines)
        ok 2 - should create different IDs for different sources
        ok 3 - should create different IDs for different local bindings
        ok 4 - should create different IDs for different files
        1..4
    ok 3 - Semantic ID stability
    # Subtest: ImportBinding (value/type/typeof)
        ok 1 - should create value import node
        ok 2 - should create type import node
        ok 3 - should create typeof import node
        ok 4 - should default to value binding when not specified
        1..4
    ok 4 - ImportBinding (value/type/typeof)
    # Subtest: Default values for optional fields
        ok 1 - should use defaults when options is empty
        ok 2 - should default imported and local to name
        ok 3 - should handle column = 0 (JSASTAnalyzer limitation)
        1..3
    ok 5 - Default values for optional fields
    # Subtest: Validation of required fields
        ok 1 - should throw when name is missing
        ok 2 - should throw when file is missing
        ok 3 - should throw when line is undefined
        ok 4 - should accept line=0 as valid (unlike undefined)
        ok 5 - should throw when source is missing
        1..5
    ok 6 - Validation of required fields
    # Subtest: NodeFactory validation
        ok 1 - should pass validation for valid import node
        ok 2 - should pass validation for named import
        ok 3 - should pass validation for namespace import
        ok 4 - should pass validation for type import
        1..4
    ok 7 - NodeFactory validation
    # Subtest: Edge cases and special characters
        ok 1 - should handle relative path imports
        ok 2 - should handle parent directory imports
        ok 3 - should handle scoped package imports
        ok 4 - should handle imports with special characters in names
        ok 5 - should handle aliased imports
        1..5
    ok 8 - Edge cases and special characters
    # Subtest: ID format verification
        ok 1 - should follow semantic ID pattern: file:IMPORT:source:local
        ok 2 - should NOT include line number in ID
        1..2
    ok 9 - ID format verification
    # Subtest: Multiple imports from same source
        ok 1 - should create unique IDs for multiple named imports
        1..1
    ok 10 - Multiple imports from same source
    1..10
ok 1 - NodeFactory.createImport
1..1
# tests 35
# suites 11
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 463.076672
```

## Status: PASS

All 35 tests pass. The test suite now correctly:
1. Validates that `undefined` line throws an error
2. Validates that `line=0` is accepted as a valid value

## File Changed

`/Users/vadimr/grafema/test/unit/NodeFactoryImport.test.js`
