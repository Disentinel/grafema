# Kevlin Review: grafema get command (REG-179)

**Reviewer:** Kevlin Henney
**Date:** 2025-01-24
**File:** `/Users/vadimr/grafema/packages/cli/src/commands/get.ts`

## Summary

The implementation is **solid and well-structured**. Code is readable, follows existing patterns, and handles errors appropriately. A few minor opportunities for improvement around consistency and clarity.

## Strengths

1. **Excellent separation of concerns**: `outputJSON`, `outputText`, `displayEdges` are cleanly separated
2. **Consistent with existing patterns**: Matches structure of `query.ts` and `trace.ts` (error handling, backend lifecycle, option parsing)
3. **Clear naming**: Function names communicate intent well (`getNodeName`, `getMetadataFields`, `displayEdges`)
4. **Good error messages**: Follows REG-157 format, provides helpful suggestions
5. **Edge grouping logic is clear**: Groups by type, applies limit, shows "and X more" message
6. **Appropriate abstraction level**: Helper functions have single, focused responsibilities

## Issues and Suggestions

### 1. Type inconsistency: `edge.edgeType || edge.type`

**Location:** Lines 98, 106, 193, 218

```typescript
// Appears in 4 places
edgeType: edge.edgeType || edge.type || 'UNKNOWN'
```

**Issue:** This pattern reveals a type system mismatch. Either `Edge` interface is incomplete or backend returns inconsistent shapes.

**Suggested fix:**
```typescript
// Option A: Normalize at the boundary
function getEdgeType(edge: Edge): string {
  return edge.edgeType || edge.type || 'UNKNOWN';
}

// Then use consistently:
const edgeType = getEdgeType(edge);
```

**Or** fix the `Edge` interface to match backend reality:
```typescript
interface Edge {
  src: string;
  dst: string;
  edgeType?: string;  // Optional, fallback to 'type'
  type?: string;      // Legacy field
}
```

### 2. Silent error swallowing

**Location:** Lines 242-244

```typescript
} catch {
  // Ignore errors
}
```

**Issue:** Comment says "ignore" but doesn't explain WHY it's safe to ignore. This pattern appears in `query.ts` and `trace.ts` too, so it's a systemic issue.

**Suggested improvement:**
```typescript
} catch (err) {
  // Node may have been deleted or is inaccessible. Return empty name.
}
```

**Or** if node lookup failure is truly expected:
```typescript
} catch {
  // Expected: node may not exist (dangling edge reference)
}
```

**Rationale:** Future maintainers need to know if this is "expected flow" or "defensive coding against unknown issues."

### 3. Magic number: `20` edge limit

**Location:** Lines 204, 209

```typescript
const limitApplied = totalCount > 20;
const limit = 20;
```

**Issue:** No explanation for why 20. Is this UX-driven (fits on screen)? Performance? Arbitrary?

**Suggested improvement:**
```typescript
// Text mode: limit edges to fit typical terminal height
const EDGE_DISPLAY_LIMIT = 20;
const limitApplied = totalCount > EDGE_DISPLAY_LIMIT;
const limit = EDGE_DISPLAY_LIMIT;
```

### 4. `any` type usage

**Locations:** Lines 91, 115, 116, 117, 140, 146, 147, 148, 218, 240

```typescript
const result = {
  node: {
    id: node.id,
    type: (node as any).type || (node as any).nodeType || 'UNKNOWN',
    name: (node as any).name || '',
```

**Issue:** Heavy use of `any` suggests backend returns untyped nodes. This is acceptable given Grafema's untyped-codebase focus, but worth noting.

**Not a bug, but opportunity:** If backend node shape is predictable, create a `BackendNode` interface:
```typescript
interface BackendNode {
  id: string;
  type?: string;
  nodeType?: string;
  name?: string;
  file?: string;
  line?: number;
  [key: string]: unknown;  // For metadata
}
```

Then:
```typescript
function toNodeInfo(node: BackendNode): NodeInfo {
  return {
    id: node.id,
    type: node.type || node.nodeType || 'UNKNOWN',
    name: node.name || '',
    file: node.file || '',
    line: node.line,
  };
}
```

This is **not urgent** — current code works. But would reduce duplication.

### 5. Inconsistent formatting: edge display

**Location:** Line 218

```typescript
const label = edge.targetName ? `${edge.edgeType}#${edge.targetName}` : edge.targetId;
```

**Issue:** Uses `edge.edgeType` but should probably be consistent with target type:
```typescript
// Current output:
CALLS#authenticate  // edgeType + targetName

// But user might expect:
FUNCTION#authenticate  // targetType + targetName
```

**Question:** Is this intentional? If so, add comment:
```typescript
// Format: EDGE_TYPE#targetName (not TARGET_TYPE#name)
const label = edge.targetName ? `${edge.edgeType}#${edge.targetName}` : edge.targetId;
```

## Comparison with `query.ts` and `trace.ts`

**Consistency:** Excellent. Same patterns:
- `exitWithError` usage
- Backend lifecycle (connect → try/finally → close)
- Option handling
- Silent error catching (same issue exists there too)

**Structure:** Matches sibling commands well. Easy to navigate.

## Verdict

**APPROVE with minor suggestions.**

The code is production-ready. Issues listed are refinements, not blockers. If team wants to address them:
1. Extract `getEdgeType()` helper (1-liner, immediate)
2. Add comment explaining silent catch (1-liner, immediate)
3. Name the magic number `20` (1-liner, immediate)
4. `BackendNode` interface (longer refactor, can defer)

If these aren't addressed now, they won't cause problems. But they would improve clarity.

---

**Next steps:**
- If approved as-is: proceed to Linus review
- If refinements desired: quick pass to address items 1-3 (5 minutes total)
