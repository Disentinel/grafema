# REG-254: Rob Pike - Implementation Report

## Summary

Implemented the two core query utilities for REG-254:

1. **findCallsInFunction** - Finds all CALL and METHOD_CALL nodes inside a function scope
2. **findContainingFunction** - Finds the FUNCTION, CLASS, or MODULE that contains a given node

Both utilities are now exported from `@grafema/core`.

## Implementation Details

### findCallsInFunction.ts

**Location:** `packages/core/src/queries/findCallsInFunction.ts`

**Algorithm:**
1. Get function's scope via HAS_SCOPE edge
2. BFS through CONTAINS edges, collecting CALL and METHOD_CALL nodes
3. Stop at nested FUNCTION/CLASS boundaries (don't enter inner functions)
4. For each call, check CALLS edge to determine if resolved
5. If transitive=true, recursively follow resolved CALLS edges

**Key Design Decisions:**

- Uses BFS for scope traversal to handle arbitrarily nested block scopes (if, for, while, etc.)
- Stops at FUNCTION and CLASS boundaries - these have their own scope hierarchies
- For transitive mode, adds the starting function to `seenTargets` to prevent cycles back to it
- Tracks visited function IDs in transitive mode to handle recursion (A calls A) and mutual recursion (A calls B calls A)
- Respects `transitiveDepth` limit to prevent explosion in deep call chains

**Interface:**
```typescript
async function findCallsInFunction(
  backend: GraphBackend,
  functionId: string,
  options: FindCallsOptions = {}
): Promise<CallInfo[]>
```

### findContainingFunction.ts

**Location:** `packages/core/src/queries/findContainingFunction.ts`

**Algorithm:**
1. BFS up the containment tree via CONTAINS and HAS_SCOPE edges (incoming)
2. Stop when we find FUNCTION, CLASS, or MODULE

**Key Design Decisions:**

- Uses BFS to handle arbitrarily deep nesting
- Follows both CONTAINS and HAS_SCOPE edges (both connect children to parents in the graph)
- Returns `<anonymous>` for functions with empty names
- Respects `maxDepth` limit (default 15) to prevent issues with malformed graphs
- Tracks visited nodes to handle cycles

**Interface:**
```typescript
async function findContainingFunction(
  backend: GraphBackend,
  nodeId: string,
  maxDepth: number = 15
): Promise<CallerInfo | null>
```

### Exports

Updated `packages/core/src/index.ts` to export:
- `findCallsInFunction`
- `findContainingFunction`
- Types: `CallInfo`, `CallerInfo`, `FindCallsOptions`

## Test Results

All 35 tests pass:

### findCallsInFunction (19 tests)

**direct calls:**
- should find CALL nodes in function scope
- should find METHOD_CALL nodes in function scope
- should not enter nested functions
- should handle nested scopes (if blocks, loops)
- should return empty array for function with no calls
- should find both CALL and METHOD_CALL nodes

**resolution status:**
- should mark calls with CALLS edge as resolved=true
- should mark calls without CALLS edge as resolved=false
- should handle mix of resolved and unresolved calls

**transitive mode:**
- should follow resolved CALLS edges when transitive=true
- should add depth field for transitive calls
- should stop at transitiveDepth limit
- should handle recursive functions (A calls A)
- should handle cycles (A calls B calls A)
- should return only direct calls when transitive=false (default)

**edge cases:**
- should handle function without HAS_SCOPE edge
- should handle non-existent function ID
- should handle multiple scopes
- should not enter nested classes

### findContainingFunction (16 tests)

**basic containment:**
- should find parent FUNCTION for a CALL node
- should handle multiple scope levels
- should return null when no container found
- should return null for orphaned node

**container types:**
- should find CLASS as container
- should find MODULE as container
- should prefer closest FUNCTION container

**edge cases:**
- should return null for non-existent node ID
- should handle deep nesting within maxDepth
- should return null when maxDepth exceeded
- should handle anonymous function with default name
- should handle cycles in graph without infinite loop
- should find container for METHOD_CALL node
- should find container for VARIABLE node

**complex hierarchies:**
- should find innermost function container
- should traverse through try-catch scopes

## Files Changed

1. `packages/core/src/queries/findCallsInFunction.ts` - Full implementation
2. `packages/core/src/queries/findContainingFunction.ts` - Full implementation
3. `packages/core/src/index.ts` - Added exports
4. `test/unit/queries/findCallsInFunction.test.ts` - Updated imports
5. `test/unit/queries/findContainingFunction.test.ts` - Updated imports

## Notes

- Tests were moved from `packages/core/test/unit/queries/` to `test/unit/queries/` to match project structure
- Removed duplicate test directory in packages/core
- Both utilities use a minimal GraphBackend interface for easy testing and flexibility

---

*Rob Pike, Implementation Engineer*
*REG-254: Core query utilities for function call analysis*
