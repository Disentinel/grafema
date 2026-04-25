# REG-203: Trace Duplicates - Root Cause Analysis

**Don Melton - Tech Lead**
Date: 2025-01-25

## Problem Statement

`grafema trace` shows duplicate entries in output:

```
Data sources (where value comes from):
  <- authHeader (VARIABLE)
  <- authHeader (VARIABLE)   ← duplicate
  <- authHeader (VARIABLE)   ← another duplicate
```

Expected: Each source should appear only once.

## Root Cause

The bug is in the graph traversal logic in `traceBackward()` and `traceForward()` functions.

**Location:** `/Users/vadimr/grafema-worker-8/packages/cli/src/commands/trace.ts`

### The Bug

```typescript
async function traceBackward(...) {
  const trace: TraceStep[] = [];
  const visited = new Set<string>();  // Tracks visited NODES

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const edges = await backend.getOutgoingEdges(id, ['ASSIGNED_FROM', 'DERIVES_FROM']);

    for (const edge of edges) {  // ← BUG: processes all edges
      const targetNode = await backend.getNode(edge.dst);
      if (!targetNode) continue;

      trace.push({  // ← ALWAYS pushes, even if dst already in trace
        node: nodeInfo,
        edgeType: edge.edgeType || edge.type,
        depth: depth + 1,
      });

      // Only queue if not visited (prevents infinite loops)
      if (!leafTypes.includes(nodeInfo.type)) {
        queue.push({ id: targetNode.id, depth: depth + 1 });
      }
    }
  }
}
```

### What's Happening

1. **Scenario:** Variable A has 3 ASSIGNED_FROM edges pointing to Variable B
2. **Current behavior:**
   - `visited` set tracks which nodes we've **processed** (prevents infinite loops)
   - When processing A, we iterate through ALL 3 edges
   - Each edge adds an entry to `trace` array
   - Result: Variable B appears 3 times in output
   - We only queue B once (because `visited.has(B)` becomes true after first edge)

3. **Why it happens:**
   - `visited` set prevents re-**processing** nodes (good for preventing cycles)
   - But it doesn't prevent adding the same destination multiple times to `trace`
   - Each edge is processed independently

### Is This a Graph Problem or Display Problem?

**Analysis:**

1. **Can the graph have duplicate edges?**
   - RFDB storage layer doesn't explicitly deduplicate edges
   - GraphBuilder could theoretically create multiple edges with same src→dst→type
   - This could be intentional (e.g., tracking multiple assignment paths)

2. **Should trace show all edges or unique destinations?**
   - From user perspective: "Data sources (where value comes from)" should list unique sources
   - Multiple edges to the same node = implementation detail, not user insight
   - Trace is about "what flows where", not "how many edge records exist"

**Conclusion:** This is a **display layer issue**. The trace should deduplicate by destination node ID.

## The Right Fix

**Where to fix:** In the traversal functions (`traceBackward` and `traceForward`)

**How:**
1. Track which destination nodes we've already added to trace
2. Skip adding a trace entry if we've already seen that destination node at that depth
3. Keep the first occurrence (preserves depth and edge type from first path found)

**Why this approach:**
- Fixes root cause (don't add same node multiple times)
- Minimal change (single Set tracking)
- Preserves existing behavior (depth grouping, edge types, etc.)
- No changes to display layer needed

**Why NOT fix in `displayTrace()`:**
- Deduplication in display would hide the problem but not fix it
- Trace array would still contain duplicates (waste of memory)
- Other consumers of trace data (JSON output, future features) would get duplicates

## Minimal Change Plan

**File:** `/Users/vadimr/grafema-worker-8/packages/cli/src/commands/trace.ts`

**Functions to fix:**
- `traceBackward()` (lines 184-233)
- `traceForward()` (lines 238-286)

**Change:**
```typescript
// Add at start of function
const seenNodes = new Set<string>();  // Track nodes already in trace

// Before trace.push():
if (seenNodes.has(targetNode.id)) continue;  // Skip if already seen
seenNodes.add(targetNode.id);

trace.push({...});  // Existing code
```

**Testing:**
- Create test with node A → B via 3 edges
- Verify trace has only 1 entry for B
- Verify both forward and backward trace work correctly
- Verify existing tests still pass

## Impact Analysis

**Files affected:** 1 file (`trace.ts`)
**Functions affected:** 2 functions
**Lines changed:** ~4 lines added
**Risk level:** Low (localized fix, clear logic)

**Backward compatibility:**
- Output format unchanged
- Behavior change: fewer duplicate entries (improvement, not breaking change)
- No API changes

## Questions to Validate

1. **Can edges legitimately duplicate?**
   - Need to verify if GraphBuilder can create multiple identical edges
   - If yes, is this intentional or also a bug?

2. **Should we preserve edge type in output?**
   - Current code shows edge type per entry
   - With deduplication, which edge type to show? (answer: first found)

3. **JSON output mode?**
   - Currently unimplemented (TODO on line 118)
   - Should plan for structured output in deduplication logic

## Recommendation

Proceed with minimal fix in traversal functions. This is the right place to deduplicate because:

1. **Single responsibility:** Traversal should collect unique paths, not all edges
2. **User intent:** "Show me data sources" = unique sources, not edge count
3. **Efficiency:** Don't waste memory storing duplicates
4. **Future-proof:** Fixes for all consumers (CLI, JSON, future features)

**Next step:** Joel should create detailed implementation plan with test cases.
