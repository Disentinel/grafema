# REG-110 Implementation Report

## Summary

Successfully migrated OBJECT_LITERAL and ARRAY_LITERAL node creation to use factory methods (`ObjectLiteralNode.create()` and `ArrayLiteralNode.create()`).

## Files Changed

### 1. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Added imports for `ObjectLiteralInfo` and `ArrayLiteralInfo` from `./types.js`
- Added destructuring for `objectLiterals` and `arrayLiterals` in `build()` method
- Added `bufferObjectLiteralNodes()` method to buffer OBJECT_LITERAL nodes
- Added `bufferArrayLiteralNodes()` method to buffer ARRAY_LITERAL nodes
- Called both methods before FLUSH section (steps 27 and 28)

### 2. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Added `objectLiterals` and `arrayLiterals` to the data passed to `graphBuilder.build()`
- Used `allCollections.objectLiterals || objectLiterals` to handle cases where visitors create new arrays

### 3. `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
- Added imports for `ObjectLiteralNode` and `ArrayLiteralNode`

#### Top-level argument literals (Commit 2):
- Reordered check logic: ObjectExpression and ArrayExpression are now checked BEFORE `extractLiteralValue()` to prevent objects/arrays from being captured as LITERAL nodes
- Replaced inline object literal creation with `ObjectLiteralNode.create()`
- Replaced inline array literal creation with `ArrayLiteralNode.create()`

#### Nested literals (Commit 3 - BREAKING CHANGE):
- In `extractObjectProperties()`: migrated nested object and array literals to use factories
- In `extractArrayElements()`: migrated nested object and array literals to use factories
- Same reordering: check ObjectExpression/ArrayExpression BEFORE extractLiteralValue()
- **Breaking change**: Nested literals now use `obj`/`arr` suffix instead of property names or `elem{N}` indices

## ID Format Changes

### Before Migration:
- Top-level object arg: `OBJECT_LITERAL#arg0#/file.js#10:5:0`
- Nested object in property: `OBJECT_LITERAL#config#/file.js#12:8:1`
- Nested object in array: `OBJECT_LITERAL#elem0#/file.js#15:4:2`

### After Migration:
- Top-level object arg: `OBJECT_LITERAL#arg0#/file.js#10:5:0` (unchanged)
- Nested object in property: `OBJECT_LITERAL#obj#/file.js#12:8:1` (BREAKING)
- Nested object in array: `OBJECT_LITERAL#obj#/file.js#15:4:2` (BREAKING)

Same pattern applies to ARRAY_LITERAL with `arr` suffix for nested arrays.

## Test Results

All 28 tests in `test/unit/ObjectArrayLiteralMigration.test.js` pass:
- 7 ObjectLiteralNode factory behavior tests
- 7 ArrayLiteralNode factory behavior tests
- 3 GraphBuilder OBJECT_LITERAL integration tests
- 3 GraphBuilder ARRAY_LITERAL integration tests
- 4 Nested literals ID format tests (breaking change validation)
- 4 NodeFactory validation tests

## Verification Commands

```bash
npm run build                                          # TypeScript compiles successfully
node --test test/unit/ObjectArrayLiteralMigration.test.js  # All 28 tests pass
```

## Additional Notes

1. The `extractLiteralValue()` function in `ExpressionEvaluator.ts` handles both ObjectExpression and ArrayExpression, returning their literal values. This was causing objects/arrays to be captured as LITERAL nodes instead of OBJECT_LITERAL/ARRAY_LITERAL nodes. The fix was to check for ObjectExpression/ArrayExpression types BEFORE calling extractLiteralValue().

2. There was a reference issue where JSASTAnalyzer was passing the local `objectLiterals` variable to GraphBuilder, but visitors could create new arrays and assign them to `allCollections.objectLiterals`. Fixed by using `allCollections.objectLiterals || objectLiterals`.

3. Type casting (`as unknown as ObjectLiteralInfo`) is used because the factory returns `ObjectLiteralNodeRecord` which extends `BaseNodeRecord` with optional `line`, while `ObjectLiteralInfo` has required `line`. The factory guarantees line is always set.
