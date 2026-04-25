# REG-322: Implementation Report

## Problem

ExpressRouteAnalyzer created HANDLED_BY edge from http:route to the WRONG anonymous function. Instead of the handler function, it found an anonymous function nested inside the handler.

Example:
```typescript
router.post('/:id/accept', async (req, res) => {  // line 5 - handler
  const invitation = await new Promise((resolve, reject) => {  // line 6 - nested
    // ...
  });
});
```

HANDLED_BY was pointing to the nested Promise callback (line 6) instead of the handler (line 5).

## Root Cause

The `NodeQuery` interface in `RFDBServerBackend.ts` doesn't support `line` field. When ExpressRouteAnalyzer queried `{ type: 'FUNCTION', file: '...', line: handlerLine }`, the `line` parameter was silently ignored. The query returned ALL FUNCTION nodes in the file, and `break` took the first one (which was not necessarily the correct handler).

## Solution

**Approach:** Post-filter by line AND column.

1. Added `handlerColumn` to `EndpointNode` interface
2. Capture handler's column when creating endpoint
3. Query all FUNCTION nodes in file (without relying on broken `line` filter)
4. Filter manually by checking `fn.line === handlerLine && fn.column === handlerColumn`

## Changes

### `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`

1. Import `getColumn` from location utils
2. Add `handlerColumn: number` to `EndpointNode` interface
3. Capture handler column when creating endpoint object
4. Update HANDLED_BY edge creation to filter by both line AND column

## Tests Added

New test file: `test/unit/plugins/analysis/ExpressRouteAnalyzer-HANDLED_BY.test.ts`

Test cases:
1. Handler with nested Promise callback → HANDLED_BY points to handler
2. Multiple nested functions (map, then callbacks) → HANDLED_BY points to outermost handler
3. Handler on same line as route method → works correctly

All tests pass.

## Follow-up

Created REG-323: Replace line/column matching with semantic ID lookup (proper architectural solution for v0.2).
