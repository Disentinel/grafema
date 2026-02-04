# REG-333: Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-04

## Summary

Implemented wrapper function unwrapping in ExpressRouteAnalyzer. The fix enables HANDLED_BY edges to correctly point to the actual handler function when route handlers are wrapped in utility functions like `asyncHandler`, `catchAsync`, etc.

## Change Location

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`
**Lines:** 220-245 (inserted 12 new lines, modified 6 existing lines)

## Implementation Details

### Before (Lines 218-240)

```typescript
const mainHandler = handlers[handlers.length - 1];
// ...
endpoints.push({
  // ...
  handlerLine: (mainHandler as Node).loc
    ? getLine(mainHandler as Node)
    : getLine(node),
  handlerColumn: (mainHandler as Node).loc
    ? getColumn(mainHandler as Node)
    : getColumn(node)
});
```

The original code used `mainHandler` directly for line/column extraction. For wrapped handlers like `asyncHandler(async (req, res) => {...})`, this would return the position of the `asyncHandler(...)` CallExpression, not the inner arrow function.

### After (Lines 220-266)

```typescript
// Unwrap wrapper functions (asyncHandler, catchAsync, etc.)
// Pattern: wrapper(async (req, res) => {...}) -> extract inner function
// Also handles nested wrappers: outer(inner(handler))
let actualHandler = mainHandler as Node;
while (actualHandler.type === 'CallExpression') {
  const callExpr = actualHandler as CallExpression;
  const firstArg = callExpr.arguments[0] as Node | undefined;
  if (!firstArg) {
    // No arguments - not a wrapper pattern
    break;
  }
  if (
    firstArg.type === 'ArrowFunctionExpression' ||
    firstArg.type === 'FunctionExpression'
  ) {
    // Found the actual handler function
    actualHandler = firstArg;
    break;
  } else if (firstArg.type === 'CallExpression') {
    // Nested wrapper: outer(inner(...)) - continue unwrapping
    actualHandler = firstArg;
  } else {
    // First arg is not a function or CallExpression - not a wrapper pattern
    break;
  }
}
// ...
endpoints.push({
  // ...
  handlerLine: actualHandler.loc
    ? getLine(actualHandler)
    : getLine(node),
  handlerColumn: actualHandler.loc
    ? getColumn(actualHandler)
    : getColumn(node)
});
```

### Algorithm

The unwrapping algorithm uses a while loop to handle:

1. **Single-level wrappers:** `asyncHandler(async (req, res) => {...})`
   - Detect CallExpression with first arg being ArrowFunctionExpression/FunctionExpression
   - Extract the inner function

2. **Nested wrappers:** `outer(inner((req, res) => {...}))`
   - When first arg is another CallExpression, continue the loop
   - Eventually reach the innermost function

3. **Non-wrapper CallExpressions:** `validate('/path')` returns validation rules
   - First arg is not a function or CallExpression
   - Break loop, keep original CallExpression position

### Complexity

- **Time:** O(k) per route where k = nesting depth (typically 1-2)
- **Space:** O(1) - no additional data structures
- **No additional iteration:** Extends existing route analysis pass

## Tests

All 10 test cases pass:

| # | Test Case | Status |
|---|-----------|--------|
| 1 | asyncHandler(async (req, res) => {...}) | PASS |
| 2 | catchAsync((req, res) => {...}) - non-async | PASS |
| 3 | wrapAsync(function handler(req, res) {...}) - FunctionExpression | PASS |
| 4 | Multiple handlers: middleware, asyncHandler(handler) | PASS |
| 5 | Nested wrappers: outer(inner(handler)) | PASS |
| 6 | Non-wrapper CallExpression (validate('/path')) | PASS |
| 7 | Direct inline handlers (regression) | PASS |
| 8 | Integration with ExpressResponseAnalyzer | PASS |
| 9 | Anonymous function expression wrapper | PASS |
| 10 | Multiline wrapper formatting | PASS |

## Build Verification

```bash
cd packages/core && pnpm build  # Successful
node --import tsx --test test/unit/plugins/analysis/ExpressRouteAnalyzer-wrapper.test.ts  # All 10 pass
```

## Design Decisions

1. **Generic pattern matching (not hardcoded names):** The fix doesn't check for specific wrapper names like `asyncHandler` or `catchAsync`. Any CallExpression with a function as its first argument is treated as a wrapper. This handles custom wrapper names used by different teams.

2. **Recursive unwrapping for nested wrappers:** Handles patterns like `compose(withAuth(async (req, res) => {...}))` by continuing to unwrap through CallExpressions until reaching the actual function.

3. **Safe fallback:** If no function is found after unwrapping, the original behavior is preserved (uses the CallExpression's position).

## Alignment with Plan

The implementation follows Don's plan exactly:
- Single point of fix in ExpressRouteAnalyzer
- Generic unwrapping (not hardcoded names)
- Handles edge cases (nested wrappers, non-wrapper CallExpressions)
- No changes needed to ExpressResponseAnalyzer

## Files Changed

- `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts` - Added wrapper unwrapping logic
