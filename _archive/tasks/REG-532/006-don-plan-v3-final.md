# REG-532 Implementation Plan v3 (FINAL)

**Date:** 2026-02-20
**Status:** Corrected after Dijkstra re-verification

## Problem
~2800 ERR_NO_LEAF_NODE warnings: CALL (2498) and CONSTRUCTOR_CALL (296) nodes have no outgoing DERIVES_FROM edges.

## Root Causes (Two bugs)

1. **DataFlowValidator type mismatch** — line 216 checks `'METHOD_CALL' || 'CALL_SITE'` but ALL call nodes have `type: 'CALL'`. The fallback for zero-arg calls NEVER fires → 2498 false errors.
2. **No DERIVES_FROM from CALL/CONSTRUCTOR_CALL to arguments** — data flow tracing dead-ends at call nodes.
3. **Constructor arguments never extracted** — `NewExpressionHandler` doesn't call `ArgumentExtractor.extract()` → ~296 CONSTRUCTOR_CALL nodes have zero outgoing edges.

## Changes

### Change 1: Fix DataFlowValidator type mismatch

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

Line 216 — change:
```typescript
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE')
```
to:
```typescript
if (startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL')
```

Also clean up `leafTypes` set (line 67-78): remove `'METHOD_CALL'` and `'CALL_SITE'` entries — no nodes have these types. Replace with `'CALL'` and `'CONSTRUCTOR_CALL'`.

**Effect:** Zero-arg calls (Math.random, Date.now) pass validation as leaf nodes. ~2498 CALL errors → near-zero.

### Change 2: Add DERIVES_FROM alongside PASSES_ARGUMENT in CallFlowBuilder

**File:** `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`

In `bufferArgumentEdges()`, after line 195 where PASSES_ARGUMENT is buffered:

```typescript
// After: this.ctx.bufferEdge(edgeData);  // PASSES_ARGUMENT

// Add: DERIVES_FROM edge (call result depends on argument data)
this.ctx.bufferEdge({
  type: 'DERIVES_FROM',
  src: callId,
  dst: targetNodeId,
  metadata: { sourceType: 'argument', argIndex }
});
```

**Architecture note:** This is buffering phase (analysis), not querying. We have `targetNodeId` available locally — no need to query PASSES_ARGUMENT edges afterward. Dijkstra's concern about query-based approach is addressed: we buffer directly.

**Effect:** CALL nodes with arguments get DERIVES_FROM edges. Data flow: `result → CALL → DERIVES_FROM → arguments → sources → LITERAL`.

### Change 3: Extract constructor arguments in NewExpressionHandler

**File:** `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`

After creating CONSTRUCTOR_CALL node (line 43-52), add argument extraction:

```typescript
// Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
if (newNode.arguments.length > 0) {
  ArgumentExtractor.extract(
    newNode.arguments, constructorCallId, ctx.module,
    ctx.callArguments, ctx.literals, ctx.literalCounterRef,
    this.collections, ctx.scopeTracker
  );
}
```

Use `constructorCallId` (not the CALL node ID) because `VARIABLE → ASSIGNED_FROM → CONSTRUCTOR_CALL` — the data flow trace reaches CONSTRUCTOR_CALL, so DERIVES_FROM must come from that node.

**CallFlowBuilder compatibility:** `bufferArgumentEdges()` looks up `callId` in callSites/methodCalls (line 84-85) only for callback detection. CONSTRUCTOR_CALL IDs won't match → callback features don't fire → correct (constructors don't invoke callbacks, except Promise which has separate handling).

**Effect:** ~296 CONSTRUCTOR_CALL nodes get PASSES_ARGUMENT + DERIVES_FROM to their arguments.

## Files Modified

| File | Change | Commit |
|------|--------|--------|
| `packages/core/src/plugins/validation/DataFlowValidator.ts` | Fix type check + leafTypes | 1 |
| `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts` | Add DERIVES_FROM buffer | 2 |
| `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts` | Extract constructor args | 2 |
| Tests | New/updated test files | 1, 2 |

## Out of Scope

- **Advanced argument types** (template literals, await/yield, conditional) — these fall through ArgumentExtractor without `targetId`. Follow-up issue.
- **DERIVES_FROM to callee FUNCTION** — not needed. Zero-arg calls pass as leaf nodes (Change 1). Calls with args get DERIVES_FROM to args (Change 2). Function resolution is a separate enrichment concern.

## Success Criteria

1. ERR_NO_LEAF_NODE count drops from ~2800 to near-zero
2. CALL nodes with arguments have outgoing DERIVES_FROM edges
3. CONSTRUCTOR_CALL nodes have PASSES_ARGUMENT + DERIVES_FROM to their arguments
4. All existing tests pass
