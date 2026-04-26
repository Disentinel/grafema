# Kent Beck — Test Report for REG-562

## Files Modified

### Updated: `test/unit/ArrowFunctionArgDedup.test.js`
- **Test 4 ("Class field arrow (REG-562)")**: Changed assertion from `allFunctions.length === 2` (documenting the bug) to `allFunctions.length === 1` (post-fix behavior). Updated test name and comments to reflect that the deduplication fix has been applied.

### Created: `test/unit/ClassFieldArrowDedup.test.js`
New dedicated test file with 8 test cases covering class field arrow deduplication.

## Test Cases

| # | Test | Assertion | Status |
|---|------|-----------|--------|
| 1 | Basic class field arrow `field = x => x` | 1 FUNCTION node named `field` | PASS |
| 2 | Multi-param arrow `handler = (e, ctx) => ...` | 1 FUNCTION node named `handler` | PASS |
| 3 | Multiple fields `f1 = x => x; f2 = y => y` | 2 FUNCTION nodes (one each) | PASS |
| 4 | Static field `static field = x => x` | 1 FUNCTION node | PASS |
| 5 | Private field `#privateField = x => x` | 1 FUNCTION node named `#privateField` | PASS |
| 6 | Nested arrow in field body | 2 FUNCTION nodes (outer + inner) | PASS |
| 7 | Field alongside method | 2 FUNCTION nodes (method + field), no extra | PASS |
| 8 | Class expression `const A = class { field = x => x }` | 1 FUNCTION node | PASS |

## Patterns Matched from Existing Tests

- **Helper pattern**: `setupTest(backend, files)` with temp directory, `package.json`, `createTestOrchestrator` -- identical to `ClassVisitorClassNode.test.js` and `ArrowFunctionArgDedup.test.js`
- **DB lifecycle**: `createTestDatabase()` in `beforeEach`, `cleanup()` in `after`, `cleanupAllTestDatabases` in top-level `after`
- **Assertion pattern**: Filter `allNodes` by `type === 'FUNCTION'`, assert count and naming
- **Naming convention**: `ClassFieldArrowDedup` follows existing `ArrowFunctionArgDedup` pattern

## Current Test Results

All 8 new tests and the updated ArrowFunctionArgDedup test **PASS**. The fix (guard in `FunctionVisitor.ArrowFunctionExpression` at line 298-300 that skips `ClassProperty`/`ClassPrivateProperty` parent arrows) is already applied on this branch.

## Edge Cases Discovered

1. **Private fields**: ClassVisitor uses `#` prefix in FUNCTION name (`#privateField`), confirmed from source code at `ClassVisitor.ts` line 484: `const displayName = '#${privateName}'`.
2. **Nested arrows inside field body**: The outer arrow is handled by ClassVisitor, the inner arrow by `analyzeFunctionBody` -> `NestedFunctionHandler`. No duplication risk because the inner arrow has a function parent (the outer arrow) and is skipped by FunctionVisitor's existing `getFunctionParent()` guard.
3. **Class expressions**: ClassVisitor has a separate `ClassExpression` handler that mirrors the `ClassDeclaration` logic including `ClassProperty` traversal, so the fix covers both.
4. **Static fields**: No special handling needed -- `ClassProperty` with `static: true` is still `ClassProperty` type, so the parent type check catches it.
