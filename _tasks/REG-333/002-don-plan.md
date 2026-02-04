# REG-333: Don Melton's Analysis and Plan

## Summary

ExpressResponseAnalyzer fails to detect `res.json()` calls when route handlers are wrapped in utility functions like `asyncHandler` or `catchAsync`. This affects ~80% of production Express apps.

## Root Cause Analysis

After investigating the code, I've confirmed the issue:

### Current Flow

1. **ExpressRouteAnalyzer** (lines 218-240):
   - For `router.get('/path', asyncHandler(async (req, res) => {...}))`:
   - `mainHandler` = `asyncHandler(...)` CallExpression
   - `handlerLine` = line where `asyncHandler(...)` starts
   - `handlerColumn` = column where `asyncHandler(...)` starts

2. **HANDLED_BY Edge Creation** (lines 346-365):
   - Searches for FUNCTION node at `handlerLine`/`handlerColumn`
   - **Problem**: No FUNCTION node exists at that position because:
     - JSASTAnalyzer creates FUNCTION for the inner arrow function
     - The inner arrow function starts at a DIFFERENT line/column than the CallExpression
   - Result: No HANDLED_BY edge created, or edge points to wrong node

3. **ExpressResponseAnalyzer** (lines 100-114):
   - Follows HANDLED_BY edge to get handler function
   - If no edge exists or wrong node: can't find response patterns

### The Actual Problem Location

The bug is in **ExpressRouteAnalyzer**, specifically in how `handlerLine`/`handlerColumn` is extracted:

```typescript
// Line 234-238 - Current behavior (WRONG for wrapper patterns)
handlerLine: (mainHandler as Node).loc
  ? getLine(mainHandler as Node)   // Gets asyncHandler(...) line
  : getLine(node),
handlerColumn: (mainHandler as Node).loc
  ? getColumn(mainHandler as Node) // Gets asyncHandler(...) column
  : getColumn(node)
```

For `asyncHandler(async (req, res) => {...})`:
- Current: handlerLine/Column points to `asyncHandler(` position
- Needed: handlerLine/Column should point to `async (req, res) =>` position

## Decision: Fix in ExpressRouteAnalyzer

**Rationale:**
1. **Single point of fix**: ExpressRouteAnalyzer creates HANDLED_BY edges. If we fix extraction there, all downstream analyzers (ExpressResponseAnalyzer, future analyzers) benefit automatically.
2. **Semantic correctness**: The HANDLED_BY edge should point to the actual handler function, not a wrapper. The wrapper is just error handling infrastructure.
3. **Aligns with prior art**: ESLint rules commonly unwrap CallExpressions to find the inner function argument. This is a well-understood pattern in static analysis ([ESLint Custom Rules](https://eslint.org/docs/latest/extend/custom-rules), [ESLint Discussions](https://github.com/eslint/eslint/discussions/15553)).

## Approach: Generic Pattern (Not Hardcoded Names)

**Decision**: Generic unwrapping, not hardcoded `asyncHandler`/`catchAsync` names.

**Rationale:**
1. Teams use custom names: `wrapAsync`, `tryCatch`, `withErrorHandling`, etc.
2. The AST pattern is the same: CallExpression with function argument
3. False positives are low-risk: if the first argument is a function, it's almost certainly the callback

**Pattern to detect:**
```javascript
// If mainHandler is CallExpression with function as first argument, use that function
router.get('/path', someWrapper(async (req, res) => {...}))
//                   ^^^^^^^^^^^ CallExpression
//                              ^^^^^^^^^^^^^^^^^^^^^^^ ArrowFunctionExpression (use this)
```

**Generic rule:**
```typescript
if (mainHandler.type === 'CallExpression') {
  const firstArg = mainHandler.arguments[0];
  if (firstArg && (
    firstArg.type === 'ArrowFunctionExpression' ||
    firstArg.type === 'FunctionExpression'
  )) {
    // Use firstArg's location for HANDLED_BY edge
    handlerLine = getLine(firstArg);
    handlerColumn = getColumn(firstArg);
  }
}
```

## Prior Art

From web research:
- [Express-async-handler](https://www.npmjs.com/package/express-async-handler) is the standard pattern (~3M weekly downloads)
- [Express 5 removes need for asyncHandler](https://dev.to/mahmud007/goodbye-asynchandler-native-async-support-in-express-5-2o9p) - but Express 5 adoption is slow
- ESLint rules commonly detect CallExpressions and extract arguments ([ESLint utilities](https://eslint-community.github.io/eslint-utils/api/ast-utils.html))
- The pattern `CallExpression > .arguments ArrowFunctionExpression` is standard in ESQuery selectors

## Implementation Plan

### Phase 1: Add Tests (Kent Beck)

Create test file: `test/unit/plugins/analysis/ExpressRouteAnalyzer-wrapper.test.ts`

**Test cases:**
1. `asyncHandler(async (req, res) => {...})` - HANDLED_BY points to inner arrow function
2. `catchAsync((req, res) => {...})` - non-async wrapper
3. `wrapAsync(function handler(req, res) {...})` - FunctionExpression, not arrow
4. Multiple handlers: `router.get('/path', middleware, asyncHandler(handler))` - last argument is wrapper
5. Nested wrappers: `outer(inner(handler))` - should unwrap first level only
6. Non-wrapper CallExpression: `validate('/path')` returns validation result, not function - no unwrapping

### Phase 2: Fix ExpressRouteAnalyzer (Rob Pike)

**File**: `/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`

**Change location**: Lines 218-240 (where `mainHandler` is processed)

**Implementation:**

```typescript
// Lines 218-240 - Add wrapper unwrapping
const mainHandler = handlers[handlers.length - 1];

// Unwrap wrapper functions (asyncHandler, catchAsync, etc.)
let actualHandler = mainHandler as Node;
if (actualHandler.type === 'CallExpression') {
  const callExpr = actualHandler as CallExpression;
  const firstArg = callExpr.arguments[0] as Node | undefined;
  if (firstArg && (
    firstArg.type === 'ArrowFunctionExpression' ||
    firstArg.type === 'FunctionExpression'
  )) {
    actualHandler = firstArg;
  }
}

// Use actualHandler for line/column
endpoints.push({
  // ... existing fields ...
  handlerLine: actualHandler.loc ? getLine(actualHandler) : getLine(node),
  handlerColumn: actualHandler.loc ? getColumn(actualHandler) : getColumn(node)
});
```

### Phase 3: Verify ExpressResponseAnalyzer Works

No changes needed to ExpressResponseAnalyzer. Once HANDLED_BY edge points to correct FUNCTION node, `findResponseCalls()` will find `res.json()` inside the handler.

## Complexity Analysis

- **Time**: O(1) per route - just checking if argument is a function
- **No additional iteration**: Extends existing route analysis pass
- **No new infrastructure**: Uses existing AST node types

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| False positive on non-wrapper CallExpression that returns function | Low impact: we still get a valid handler. Wrapper pattern is dominant. |
| Nested wrappers `outer(inner(handler))` | Only unwrap one level. Multiple levels are rare. |
| CallExpression without function argument | Check argument type before unwrapping |

## Out of Scope

- **Deep unwrapping**: Wrappers like `compose(a, b, handler)` where handler is not first arg
- **Import tracking**: Verifying that `asyncHandler` was imported from a known package
- **Express 5 support**: Express 5 doesn't need asyncHandler, but we support both

## Success Criteria

1. Test case with `asyncHandler(async (req, res) => { res.json(...) })` creates correct RESPONDS_WITH edge
2. `grafema trace --from-route GET:/users/:id` returns response data for wrapped handlers
3. Jammers backend analysis shows response patterns for all wrapped routes

## Estimated Effort

- Tests: 1 hour
- Implementation: 30 minutes
- Review: 30 minutes
- Total: ~2 hours

This is a surgical fix with clear scope. No architectural changes needed.
