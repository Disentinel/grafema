# Don Melton's Analysis: REG-208 Impact Analysis for Classes

## Problem Root Cause

The issue is a **query gap**, not a data model gap. The graph correctly models:
- `CLASS --CONTAINS--> FUNCTION` (methods)
- `CALL --CALLS--> FUNCTION` (method calls)
- `VARIABLE --INSTANCE_OF--> CLASS` (instantiation tracking)

The `impact` command's `analyzeImpact()` function only looks for incoming `CALLS` edges directly to the target node. When the target is a CLASS:
- Nobody creates `CALLS` edges pointing at CLASS nodes
- Method calls have `CALLS` edges pointing to the METHOD/FUNCTION contained within the class

## Current Flow (Broken for Classes)
```
analyzeImpact(CLASS)
  -> findCallsToNode(CLASS)  // finds incoming CALLS edges
  -> returns [] because no CALLS edges point to CLASS
```

## Correct Flow
```
analyzeImpact(CLASS)
  -> if target is CLASS:
       -> get CONTAINS edges to find all methods
       -> for each method: findCallsToNode(method)
       -> aggregate all callers
       -> also: get INSTANCE_OF edges (new expressions)
  -> return aggregated result with breakdown
```

## High-Level Plan

### Phase 1: Extend `analyzeImpact` for CLASS targets

Location: `packages/cli/src/commands/impact.ts`

1. After finding target node, check if `target.type === 'CLASS'`
2. If CLASS:
   - Get outgoing CONTAINS edges to find methods
   - For each method, run the existing `findCallsToNode()` logic
   - Track callers per method for the breakdown
   - Also query INSTANCE_OF edges for instantiation tracking
3. Aggregate results into extended `ImpactResult`

### Phase 2: Update output format

1. Modify `displayImpact()` to show breakdown by usage type when target is CLASS
2. JSON output should include breakdown structure:
   ```json
   {
     "target": { "type": "CLASS", "name": "UserModel" },
     "methodCallers": {
       "findById": [/* callers */],
       "create": [/* callers */]
     },
     "instantiations": [/* via new/INSTANCE_OF */],
     "totalUsages": 5
   }
   ```

### Phase 3: Tests

1. Add test for class impact showing method callers
2. Add test for class impact with instantiation tracking
3. Verify transitive impact still works (caller of method's caller)

## Why This is the RIGHT Fix

1. **No data model changes** - The graph already has all the information
2. **Query-level fix** - Aligns with "AI queries the graph" vision
3. **Minimal scope** - Only touches `impact.ts`, single command
4. **Backward compatible** - FUNCTION impact analysis unchanged

## What NOT to Do

- Do NOT add new edge types (e.g., CLASS_CALLER)
- Do NOT change how MethodCallResolver works
- Do NOT create duplicate edges in the graph
- The data is correct, the query is incomplete

## Critical Files for Implementation

1. `packages/cli/src/commands/impact.ts` - Main implementation
2. `packages/core/src/storage/backends/RFDBServerBackend.ts` - API for `getOutgoingEdges`
3. `packages/types/src/edges.ts` - Edge type reference (CONTAINS, CALLS, INSTANCE_OF)

## Complexity Assessment

- **Single Agent (Rob)** task - clear requirements, single file change, well-understood pattern
- No architectural decisions needed
- This is a query enhancement, not a structural change
