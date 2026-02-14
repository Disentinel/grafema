# REG-396: Unify type classification order

## Problem

`detectIndexedArrayAssignment` (JSASTAnalyzer) checks `extractLiteralValue` before `ObjectExpression`/`ArrayExpression`, so `arr[0] = {name: 'test'}` creates a LITERAL node. Meanwhile `detectArrayMutation` (CallExpressionVisitor, fixed in REG-392) checks `ObjectExpression`/`ArrayExpression` first, so `arr.push({name: 'test'})` creates an OBJECT_LITERAL node.

## Solution

Align `detectIndexedArrayAssignment` to check `ObjectExpression`/`ArrayExpression` BEFORE `extractLiteralValue`, matching the order in `detectArrayMutation` and `extractArguments`.
