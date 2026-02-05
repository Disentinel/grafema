# REG-306: Tech Debt - Extract shared expression handling in JSASTAnalyzer.ts

## Problem

Expression handling logic is duplicated in **3 locations** within JSASTAnalyzer.ts:

1. Top-level implicit arrow returns (~lines 2570-2689)
2. Nested arrow function implicit returns (~lines 3142-3254)
3. ReturnStatement handler (~lines 2776-2976)

This amounts to ~450 lines of near-identical code handling:

* `isIdentifier`, `isTemplateLiteral`, `isLiteral`
* `isCallExpression` (with Identifier callee)
* `isCallExpression` (with MemberExpression callee)
* `isBinaryExpression`, `isLogicalExpression`, `isConditionalExpression`
* `isUnaryExpression`, `isMemberExpression`
* Fallback case

## Impact

* Future changes to expression handling must be made in 3 places
* Risk of divergence if one location is updated but others are missed
* Maintenance burden is tripled

## Solution

Extract common expression handling into a private method:

```typescript
private extractReturnExpressionInfo(
  expr: t.Expression,
  module: ModuleInfo,
  literals: LiteralInfo[],
  literalCounterRef: CounterRef,
  baseLine: number,
  baseColumn: number
): Partial<ReturnStatementInfo>
```

This would reduce ~450 lines to ~150 lines + 3 call sites.

## Origin

Identified during REG-276 implementation review by Kevlin Henney. The pattern existed before REG-276 but was extended significantly.
