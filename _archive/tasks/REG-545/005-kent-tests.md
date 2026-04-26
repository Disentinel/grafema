# REG-545 Kent Beck Test Report

## Summary

Added tests for HANDLED_BY edge creation in FunctionCallResolver, covering the new scope-resolution link between CALL nodes and IMPORT nodes.

## Changes Made

### File: `test/unit/FunctionCallResolver.test.js`

#### Part 1: Updated metadata test (line 1465)

Changed expected `metadata.creates.edges` from `['CALLS']` to `['CALLS', 'HANDLED_BY']` to reflect the new edge type that FunctionCallResolver will produce.

#### Part 2: New `describe('HANDLED_BY Edges (REG-545)')` block (lines 1473-1985)

Six test cases added:

| # | Test Name | Scenario | Expected |
|---|-----------|----------|----------|
| 1 | Top-level named import call | IMPORT + EXPORT + FUNCTION + CALL (no parentScopeId) | HANDLED_BY edge: CALL -> IMPORT |
| 2 | Nested scope, not shadowed | Same fixture but CALL has parentScopeId, no local VARIABLE/CONSTANT with same name | HANDLED_BY edge created (not shadowed) |
| 3 | Shadowed by local variable | VARIABLE node with same name, same file, has parentScopeId | 0 HANDLED_BY edges |
| 4 | Type-only import (Dijkstra GAP 1) | IMPORT with `importBinding: 'type'` | 0 HANDLED_BY edges |
| 5 | Re-export chain to external (Dijkstra GAP 3) | `./utils` re-exports from `'external-lib'` | HANDLED_BY to local IMPORT in calling file |
| 6 | PARAMETER shadow (Dijkstra GAP 2) | PARAMETER node with same name uses `functionId`, not `parentScopeId` | HANDLED_BY IS created (documents known limitation) |

### Key Design Decisions

1. **Shadow fixture uses parentScopeId on VARIABLE**: The `buildShadowIndex()` queries VARIABLE and CONSTANT nodes filtered by `parentScopeId`. The test explicitly sets `parentScopeId: 'main-bar-func'` on the VARIABLE node to trigger shadow detection.

2. **Dijkstra GAP 2 documented as known limitation**: PARAMETER nodes use `functionId` (not `parentScopeId`), so the shadow index cannot detect parameter shadows. Test 6 asserts that HANDLED_BY IS created (false positive) and documents this as a known gap via comments and test name.

3. **All tests include `importBinding: 'value'`**: Matching the ExternalCallResolver HANDLED_BY test patterns, where the import binding type is explicit. This ensures type-only filtering works correctly.

4. **Style matches existing patterns**: Uses `setupBackend()`, `try/finally` with `backend.close()`, `backend.addNodes()`, `backend.addEdge()`, `backend.flush()`, `resolver.execute()`, and `backend.getOutgoingEdges()` assertions.

## Tests NOT run

Per instructions, tests were not executed. They are written to pass once the implementation (Rob's work) adds HANDLED_BY edge creation logic to FunctionCallResolver.
