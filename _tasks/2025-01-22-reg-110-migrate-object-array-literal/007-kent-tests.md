# Kent Beck: Test Report for REG-110

## Test File Location

`/Users/vadimr/grafema/test/unit/ObjectArrayLiteralMigration.test.js`

## Test Summary

Wrote 28 tests across 6 test suites covering:

### 1. ObjectLiteralNode Factory Behavior (7 tests) - ALL PASS

Tests verify that `NodeFactory.createObjectLiteral()` (which delegates to `ObjectLiteralNode.create()`):

- Generates ID with `arg{N}` suffix when `argIndex` is provided
- Generates ID with `obj` suffix when `argIndex` is NOT provided
- Includes counter in ID for uniqueness
- Sets all required fields correctly (type, name, file, line, column, parentCallId, argIndex)
- Works without optional parentCallId
- Creates consistent IDs for same parameters

**ID format examples:**
- With argIndex: `OBJECT_LITERAL#arg0#/project/src/api.js#10:5:0`
- Without argIndex: `OBJECT_LITERAL#obj#/project/src/data.js#15:8:5`

### 2. ArrayLiteralNode Factory Behavior (7 tests) - ALL PASS

Same pattern as ObjectLiteralNode:

- Generates ID with `arg{N}` suffix when `argIndex` is provided
- Generates ID with `arr` suffix when `argIndex` is NOT provided
- Includes counter in ID for uniqueness
- Sets all required fields correctly
- Works without optional parentCallId
- Creates consistent IDs for same parameters

**ID format examples:**
- With argIndex: `ARRAY_LITERAL#arg0#/project/src/api.js#10:5:0`
- Without argIndex: `ARRAY_LITERAL#arr#/project/src/data.js#15:8:5`

### 3. GraphBuilder Integration - OBJECT_LITERAL (3 tests) - ALL FAIL

Tests verify that after analysis, OBJECT_LITERAL nodes appear in the graph:

- `should create OBJECT_LITERAL node for object arg in function call` - **FAIL**
- `should create OBJECT_LITERAL node with correct ID format (arg suffix)` - **FAIL**
- `should handle multiple object literals in same call` - **FAIL**

**Failure reason:** GraphBuilder does NOT buffer OBJECT_LITERAL nodes to the graph yet. This is the product gap that needs fixing.

### 4. GraphBuilder Integration - ARRAY_LITERAL (3 tests) - ALL FAIL

Tests verify that after analysis, ARRAY_LITERAL nodes appear in the graph:

- `should create ARRAY_LITERAL node for array arg in function call` - **FAIL**
- `should create ARRAY_LITERAL node with correct ID format (arg suffix)` - **FAIL**
- `should handle mixed object and array literals` - **FAIL**

**Failure reason:** Same as above - GraphBuilder does NOT buffer ARRAY_LITERAL nodes.

### 5. Nested Literals ID Format - Breaking Change (4 tests) - ALL FAIL

Tests document the expected behavior AFTER migration:

- `should use obj suffix for nested object in object property (not property name)` - **FAIL**
- `should use arr suffix for nested array in object property (not property name)` - **FAIL**
- `should use obj suffix for nested object in array element (not elem{N})` - **FAIL**
- `should use arr suffix for nested array in array element (not elem{N})` - **FAIL**

**Failure reason:** No nodes in graph to verify. After migration, nested literals will use `obj`/`arr` suffixes instead of property names or `elem{N}`.

### 6. NodeFactory Validation (4 tests) - ALL PASS

- `should pass validation for ObjectLiteralNode` - **PASS**
- `should pass validation for ArrayLiteralNode` - **PASS**
- `should fail validation for missing file in ObjectLiteralNode` - **PASS**
- `should fail validation for missing file in ArrayLiteralNode` - **PASS**

## Test Results Summary

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| ObjectLiteralNode factory | 7 | 0 | 7 |
| ArrayLiteralNode factory | 7 | 0 | 7 |
| GraphBuilder - OBJECT_LITERAL | 0 | 3 | 3 |
| GraphBuilder - ARRAY_LITERAL | 0 | 3 | 3 |
| Nested literals (breaking) | 0 | 4 | 4 |
| NodeFactory validation | 4 | 0 | 4 |
| **TOTAL** | **18** | **10** | **28** |

## What Passes Before Migration

All **factory behavior** and **validation** tests pass (18 tests). The factories are correctly implemented and work as expected.

## What Fails Before Migration (Expected)

All **integration** tests fail (10 tests) because:

1. **GraphBuilder doesn't buffer literals** - object/array literals collected by CallExpressionVisitor are never written to the graph
2. **No nodes to verify** - integration tests can't find OBJECT_LITERAL or ARRAY_LITERAL nodes in the graph

## What Migration Must Achieve

1. **Add GraphBuilder integration**: Implement `bufferObjectLiteralNodes()` and `bufferArrayLiteralNodes()` methods
2. **Migrate CallExpressionVisitor**: Replace inline object creation with `ObjectLiteralNode.create()` and `ArrayLiteralNode.create()`
3. **Accept breaking change**: Nested literal IDs will change from `#{propertyName}#` or `#elem{N}#` to `#obj#` or `#arr#`

After migration, all 28 tests should pass.

## Command to Run Tests

```bash
node --test test/unit/ObjectArrayLiteralMigration.test.js
```
