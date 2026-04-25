# Don Plan: REG-306 - Extract shared expression handling

## Analysis

I've identified three locations with nearly identical expression handling logic in JSASTAnalyzer.ts:

### Location 1: Top-level implicit arrow returns (lines 3465-3583)
- **Context**: `if (t.isArrowFunctionExpression(funcNode) && !t.isBlockStatement(funcNode.body))`
- **~120 lines** handling expression body of arrow functions being analyzed
- Uses `LITERAL#implicit_return#` prefix for literal IDs
- Sets `isImplicitReturn: true`

### Location 2: ReturnStatement handler (lines 3707-3912)
- **Context**: `ReturnStatement:` visitor inside `funcPath.traverse()`
- **~205 lines** handling explicit return statements
- Uses `LITERAL#return#` prefix for literal IDs
- Does NOT set `isImplicitReturn`
- **Extra case**: Has `NewExpression` handling (lines 3886-3897) that others lack

### Location 3: Nested arrow function implicit returns (lines 4097-4214)
- **Context**: Arrow function handler inside traverse, expression body branch
- **~117 lines** handling implicit returns from nested arrow functions
- Uses `LITERAL#implicit_return#` prefix for literal IDs
- Sets `isImplicitReturn: true`

**Total duplicated code: ~442 lines**

## Key Differences Between Locations

| Aspect | Location 1 | Location 2 | Location 3 |
|--------|------------|------------|------------|
| isImplicitReturn | true | (not set) | true |
| Literal ID prefix | `implicit_return` | `return` | `implicit_return` |
| NewExpression case | NO | YES | NO |
| funcLine/funcColumn | Available | Uses returnLine/returnColumn | Uses line/column |

## Proposed Solution

### Approach: Extract a private method

```typescript
/**
 * Extracts return expression info from an expression node.
 * Used for both explicit return statements and implicit arrow returns.
 *
 * @param expr - The expression being returned
 * @param module - Module info for file context
 * @param literals - Collection to add literal nodes to
 * @param literalCounterRef - Counter for generating unique literal IDs
 * @param baseLine - Line number for literal ID generation
 * @param baseColumn - Column number for literal ID generation
 * @param literalIdSuffix - 'return' or 'implicit_return'
 * @returns Partial ReturnStatementInfo with expression-specific fields
 */
private extractReturnExpressionInfo(
  expr: t.Expression,
  module: ModuleInfo,
  literals: LiteralInfo[],
  literalCounterRef: CounterRef,
  baseLine: number,
  baseColumn: number,
  literalIdSuffix: 'return' | 'implicit_return' = 'return'
): Partial<ReturnStatementInfo>
```

### Result Shape

The method returns a partial `ReturnStatementInfo` with expression-specific fields:
- `returnValueType`
- `returnValueName` (for identifiers)
- `returnValueId` (for literals, expressions)
- `returnValueLine`, `returnValueColumn`
- `returnValueCallName` (for calls)
- `expressionType`, `operator`, source name fields, etc.

### Caller Responsibility

Each call site still creates the base `ReturnStatementInfo` with:
- `parentFunctionId`
- `file`, `line`, `column`
- `isImplicitReturn` (where applicable)

Then spreads in the extracted expression info.

### Edge Case: NewExpression

The `ReturnStatement` handler has an extra `NewExpression` case. Options:
1. **Add to shared method** - most DRY, but adds logic to implicit return paths that don't need it
2. **Handle in caller** - keep `NewExpression` check in ReturnStatement handler only

**Recommendation**: Add to shared method. The extra type check has negligible cost and ensures consistent handling if NewExpression ever appears in implicit returns.

## Files to Modify

1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - Add new private method `extractReturnExpressionInfo`
   - Refactor 3 call sites to use it

## Test Strategy

**TDD approach - write tests first that lock current behavior**

1. Existing tests in `/test/unit/js-ast-analyzer/` should already cover these cases
2. Before refactoring, run full test suite to establish baseline
3. After refactoring, ensure all tests pass unchanged

Specific test files likely covering this:
- `js-ast-analyzer.returns.test.js` - return statement analysis
- Any tests exercising arrow functions with expression bodies

## Risk Assessment

- **Risk: LOW** - Pure extraction refactoring with no behavior change
- No new functionality, just consolidation
- Type system will catch any missing fields
- Comprehensive test coverage exists

## Implementation Steps

1. **Kent**: Run existing tests, ensure baseline passes
2. **Rob**: Extract method and refactor call sites
3. **Kevlin**: Review code quality
4. **Steve+Vadim**: Review alignment with vision

## Estimated Reduction

- **Before**: ~442 lines across 3 locations
- **After**: ~150 lines in shared method + ~30 lines at call sites
- **Net reduction**: ~260 lines (~60%)
