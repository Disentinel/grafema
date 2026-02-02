# Don Melton Analysis: REG-280

## Task Assessment

The original issue description states "WhileStatement AST node is completely ignored." This is **outdated** — REG-267 already implemented comprehensive LOOP node support for all loop types including WhileStatement.

### Current State (Post REG-267)

| Acceptance Criteria | Status | Evidence |
|---------------------|--------|----------|
| LOOP node for WhileStatement | ✅ Done | `JSASTAnalyzer.ts:3453` - `createLoopScopeHandler('while', ...)` |
| HAS_BODY edge | ✅ Done | `GraphBuilder.ts:467-476` - finds body SCOPE by parentScopeId |
| HAS_CONDITION edge | ❌ Missing | No condition extraction for loops |

### Remaining Work

Add HAS_CONDITION edge from LOOP to condition EXPRESSION for:
- `while` loops (test expression)
- `do-while` loops (test expression)
- `for` loops (test expression, optional)

### Pattern Analysis

HAS_CONDITION is already implemented for BRANCH nodes (if/switch). The pattern:

1. **JSASTAnalyzer**: Extract condition via `extractDiscriminantExpression()`
2. **Types**: Store in info object (`discriminantExpressionId`, etc.)
3. **GraphBuilder**: Create EXPRESSION node and HAS_CONDITION edge

Same pattern applies to LOOP.

### Files to Modify

1. `packages/core/src/plugins/analysis/ast/types.ts` - Add condition fields to LoopInfo
2. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Extract condition in createLoopScopeHandler
3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Create HAS_CONDITION edge + EXPRESSION node

### Complexity Assessment

- **Scope**: Mini-MLA (Don → Rob → Linus)
- **LOC**: ~30-50 lines total
- **Risk**: Low - established pattern reuse
- **Testing**: Add tests to existing loop-nodes.test.ts

### Edge Cases

1. **while(true)** - BooleanLiteral, should still create EXPRESSION
2. **while(condition)** - Identifier, simple case
3. **while(i < 10)** - BinaryExpression
4. **while(isValid())** - CallExpression, need to link to CALL_SITE
5. **for(;i < 10;)** - test is optional in for loops

### Decision

Proceed with implementation. Single Rob agent sufficient for this well-defined task.
