# Joel Spolsky - Detailed Technical Plan for REG-282

## Summary

The LOOP node and HAS_BODY edge are already implemented. We need to add:
1. **HAS_INIT** edge - points to the initialization part (`let i = 0`)
2. **HAS_CONDITION** edge - points to the test condition (`i < items.length`)
3. **HAS_UPDATE** edge - points to the update expression (`i++`)

All three parts can be null/undefined in JavaScript (e.g., `for (;;) {}`).

---

## File 1: `packages/types/src/edges.ts`

Add `HAS_INIT` and `HAS_UPDATE` edge types. Note: `HAS_CONDITION` already exists for BRANCH nodes - reuse for LOOP.

---

## File 2: `packages/core/src/plugins/analysis/ast/types.ts`

Extend `LoopInfo` interface with fields for init, test, and update expressions:
- `initExpressionId`, `initExpressionType`, `initLine`, `initColumn`
- `testExpressionId`, `testExpressionType`, `testLine`, `testColumn`
- `updateExpressionId`, `updateExpressionType`, `updateLine`, `updateColumn`

---

## File 3: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

In `createLoopScopeHandler`:
- Extract init/test/update for classic `for` loops
- Also extract test for `while` and `do-while` loops
- Use `ExpressionNode.generateId()` for expression IDs

---

## File 4: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

1. In `bufferLoopEdges`: Create HAS_INIT, HAS_CONDITION, HAS_UPDATE edges
2. Add `bufferLoopExpressions` method: Buffer EXPRESSION nodes for test/update

---

## Implementation Order

1. **Kent (Tests):** Write tests first in `loop-nodes.test.ts`
2. **Rob (Implementation):**
   - Step 1: Add edge types to `edges.ts`
   - Step 2: Extend `LoopInfo` in `types.ts`
   - Step 3: Extract init/test/update in `JSASTAnalyzer`
   - Step 4: Create edges in `GraphBuilder`
   - Step 5: Buffer EXPRESSION nodes

---

## Test Cases

1. Classic for loop with init, condition, update → all three edges
2. Empty for loop `for (;;) {}` → no edges
3. While loop → HAS_CONDITION edge
4. Do-while loop → HAS_CONDITION edge
