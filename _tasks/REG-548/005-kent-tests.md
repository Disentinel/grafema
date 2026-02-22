# Kent Beck - Test Report for REG-548

## Test File

`test/unit/ExpressionNodeColumn.test.js`

## What It Tests

Verifies that EXPRESSION nodes store the correct **column number** (from `node.loc.start.column`, 0-based) instead of the **absolute byte offset** (`node.start`) in the `column` field and in the node ID.

## Test Design

**Fixture strategy:** A JavaScript file with 5 padding lines of long string assignments (~230 bytes total) followed by 7 expression declarations. Every expression sits at column 10 (`const X = ` is 10 characters), but the byte offsets are 317-437.

This gap is the key: with the bug, `column` reports byte offsets (317, 337, 354, etc.); after the fix, `column` reports 10 for all.

**Assertions:** All use `assert.strictEqual(node.column, 10)` -- exact match, not range checks. A weak assertion like `column < 200` would pass on early-file expressions even with the bug.

## Expression Types Covered (8 tests)

| # | Expression Type | Example | Expected Column |
|---|----------------|---------|----------------|
| 1 | MemberExpression | `obj.prop` | 10 |
| 2 | BinaryExpression | `x + y` | 10 |
| 3 | LogicalExpression | `x && y` | 10 |
| 4 | ConditionalExpression | `x ? y : flag` | 10 |
| 5 | UnaryExpression | `!flag` | 10 |
| 6 | TemplateLiteral | `` `${x} hello` `` | 10 |
| 7 | OptionalMemberExpression | `obj?.prop` | 10 |
| 8 | Column in node ID | All nodes | ID column matches `node.column`, both < 100 |

## Verification Results

### With buggy code (`initExpression.start ?? 0`):

```
# tests 8
# pass 0
# fail 8
```

Actual values observed: 317, 337, 354, 372, 396, 413, 437 -- all byte offsets.

### With fix (`getColumn(initExpression)`):

```
# tests 8
# pass 8
# fail 0
```

All columns correctly report 10.

## Notes

- Matches existing test style from `Expression.test.js` (setupTest, createTestDatabase, queryNodes, cleanup pattern)
- Tests run against `dist/` -- `pnpm build` required before execution
- Test 8 (Column in node ID) provides a cross-check: the column embedded in the node ID string must match `node.column` and be < 100
