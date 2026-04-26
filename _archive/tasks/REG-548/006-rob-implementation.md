# REG-548: Rob Implementation Report

## Summary

Fixed 10 locations in `JSASTAnalyzer.ts` where EXPRESSION nodes used `initExpression.start ?? 0` (absolute byte offset) as column number instead of the correct `getColumn()` utility.

## Changes Made

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

All changes follow the same pattern: `const column = <node>.start ?? 0;` replaced with `const column = getColumn(<node>);`

| # | Original Line | Expression Type | Variable |
|---|---------------|-----------------|----------|
| 1 | 808 | MemberExpression (branch 7) | `initExpression` |
| 2 | 830 | BinaryExpression (branch 8) | `initExpression` |
| 3 | 850 | ConditionalExpression (branch 9) | `initExpression` |
| 4 | 872 | LogicalExpression (branch 10) | `initExpression` |
| 5 | 895 | TemplateLiteral (branch 11) | `initExpression` |
| 6 | 924 | UnaryExpression (branch 12) | `initExpression` |
| 7 | 965 | TaggedTemplateExpression fallback (branch 13) | `initExpression` |
| 8 | 997 | OptionalCallExpression (branch 15) | `initExpression` |
| 9 | 1025 | OptionalMemberExpression (branch 16) | `initExpression` |
| 10 | 1519 | MemberExpression (destructuring rest) | `initNode` |

No import changes needed -- `getColumn` was already imported at line 53.

After the fix, zero instances of `.start ?? 0` remain in the file.

## Build Result

`pnpm build` -- clean success, no errors or warnings.

## Test Results

- **Expression.test.js**: 19 tests, 19 pass, 0 fail
- **VariableAssignmentCoverage.test.js**: 16 tests, 16 pass, 0 fail
