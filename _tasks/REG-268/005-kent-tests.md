# Kent Beck - Test Report for REG-268

## Summary

Tests for dynamic import tracking have been written following TDD methodology. All 20 test cases **FAIL** as expected (red phase).

## Files Created

### Test Fixture
**Path:** `test/fixtures/dynamic-imports/`

Files:
- `dynamic-import-patterns.js` - Contains all 7 dynamic import patterns
- `module.js` - Simple module for import testing
- `side-effect.js` - Side effect module
- `index.js` - Entry point

### Test File
**Path:** `test/unit/DynamicImportTracking.test.js`

## Test Cases (20 total)

### Pattern 1: Literal path import (3 tests)
- `import('./module.js')` creates IMPORT node with isDynamic=true
- Literal path has isResolvable=true
- Source equals the literal path value

### Pattern 2: Variable assignment with await (2 tests)
- `const mod = await import('./module.js')` captures local name "mod"
- Still has isDynamic=true and isResolvable=true

### Pattern 3: Variable assignment without await (1 test)
- `const modPromise = import('./module.js')` captures local name "modPromise"

### Pattern 4: Template literal with static prefix (3 tests)
- `import(\`./config/${env}.js\`)` has isResolvable=false
- Extracts static prefix "./config/" as source
- Captures dynamicPath

### Pattern 5: Template literal without static prefix (1 test)
- `import(\`${baseDir}/loader.js\`)` uses source="<dynamic>"

### Pattern 6: Variable path (3 tests)
- `import(modulePath)` uses source="<dynamic>"
- Captures variable name in dynamicPath
- Has isResolvable=false

### Pattern 7: Side effect import (2 tests)
- `await import('./side-effect.js')` uses local="*"
- Still tracks source correctly

### Edge cases (3 tests)
- Multiple dynamic imports in same file
- Dynamic import in arrow function
- Top-level dynamic import

## Test Run Results

```
Run command: node --test test/unit/DynamicImportTracking.test.js

Result: 20 tests, 0 passed, 20 failed (as expected)
```

All tests fail because:
1. `getDynamicImports()` returns empty array (no IMPORT nodes with `isDynamic: true`)
2. The `ImportExportVisitor` does not yet handle `CallExpression` with `callee.type === 'Import'`

## What Tests Assert

The tests verify that after implementation:

1. **IMPORT nodes are created** for each `import()` call
2. **isDynamic** field is `true` for all dynamic imports
3. **isResolvable** field is `true` for string literals, `false` for templates/variables
4. **source** field contains:
   - Literal path for string literals (e.g., `./module.js`)
   - Static prefix for templates with prefix (e.g., `./config/`)
   - `<dynamic>` for templates without prefix or variables
5. **local/name** field contains:
   - Variable name when assigned (e.g., `mod`, `config`)
   - `*` when no assignment (side effect import)
6. **dynamicPath** field captures original expression for non-resolvable imports

## Notes for Rob

Tests use the standard test helper pattern (`createTestOrchestrator`, `createTestBackend`). Each test creates a temporary project with a single `index.js` file containing the code under test.

The tests check `n.local === 'mod' || n.name === 'mod'` because ImportNode stores the local binding in both fields (see `ImportNode.create()`).

## TDD Status

- [x] RED: All tests written and failing
- [ ] GREEN: Implementation pending
- [ ] REFACTOR: Post-implementation cleanup
