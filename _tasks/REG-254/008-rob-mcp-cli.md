# REG-254: Rob Pike - MCP Tool and CLI Implementation Report

## Summary

Implemented the MCP `get_function_details` tool and fixed the CLI `query` command to use shared utilities from `@grafema/core`.

## Changes Made

### 1. MCP Tool Definition (`packages/mcp/src/definitions.ts`)

Added the `get_function_details` tool definition with comprehensive description for AI agents:

```typescript
{
  name: 'get_function_details',
  description: `Get comprehensive details about a function, including what it calls and who calls it.

Graph structure:
  FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL/METHOD_CALL
  CALL -[CALLS]-> FUNCTION (target)

Returns:
- Function metadata (name, file, line, async)
- calls: What functions/methods this function calls
- calledBy: What functions call this one
...`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Function name to look up' },
      file: { type: 'string', description: 'Optional: file path to disambiguate (partial match)' },
      transitive: { type: 'boolean', description: 'Follow call chains recursively (default: false)' },
    },
    required: ['name'],
  },
}
```

### 2. MCP Types (`packages/mcp/src/types.ts`)

Added `GetFunctionDetailsArgs` type and re-exported types from `@grafema/core`:

```typescript
export interface GetFunctionDetailsArgs {
  name: string;
  file?: string;
  transitive?: boolean;
}

export type { CallInfo, CallerInfo, FindCallsOptions } from '@grafema/core';
```

### 3. MCP Handler (`packages/mcp/src/handlers.ts`)

Implemented `handleGetFunctionDetails` function that:
1. Finds function by name (optionally filtered by file)
2. Uses shared `findCallsInFunction` utility from `@grafema/core`
3. Uses shared `findContainingFunction` utility to find callers
4. Formats output with human-readable summary and JSON data

Also added `formatCallsForDisplay` helper for grouping calls by depth.

### 4. Server Registration (`packages/mcp/src/server.ts`)

- Added import for `handleGetFunctionDetails`
- Added import for `GetFunctionDetailsArgs` type
- Added case in the `callTool` switch statement

### 5. CLI Fix (`packages/cli/src/commands/query.ts`)

**Bug Fixed:** The CLI's local `findCallsInFunction` was:
- Only finding CALL nodes (missing METHOD_CALL)
- Using incorrect graph traversal (direct CONTAINS from function, not HAS_SCOPE -> SCOPE -> CONTAINS)

**Solution:**
- Imported `findCallsInFunctionCore` from `@grafema/core`
- Rewrote `getCallees` function to use the shared utility
- Removed the buggy local `findCallsInFunction` implementation

Before (buggy):
```typescript
async function findCallsInFunction(backend, nodeId, maxDepth = 10) {
  // Only found CALL nodes, not METHOD_CALL
  // Used CONTAINS directly from function node (incorrect graph structure)
}
```

After (fixed):
```typescript
async function getCallees(backend, nodeId, limit) {
  // Uses findCallsInFunctionCore from @grafema/core
  // Correctly finds both CALL and METHOD_CALL
  // Uses HAS_SCOPE -> SCOPE -> CONTAINS pattern
}
```

## Test Results

All 19 tests pass:

```
TAP version 13
# Subtest: findCallsInFunction
    # Subtest: direct calls
        ok 1 - should find CALL nodes in function scope
        ok 2 - should find METHOD_CALL nodes in function scope
        ok 3 - should not enter nested functions
        ok 4 - should handle nested scopes (if blocks, loops)
        ok 5 - should return empty array for function with no calls
        ok 6 - should find both CALL and METHOD_CALL nodes
    ok 1 - direct calls
    # Subtest: resolution status
        ok 1 - should mark calls with CALLS edge as resolved=true
        ok 2 - should mark calls without CALLS edge as resolved=false
        ok 3 - should handle mix of resolved and unresolved calls
    ok 2 - resolution status
    # Subtest: transitive mode
        ok 1 - should follow resolved CALLS edges when transitive=true
        ok 2 - should add depth field for transitive calls
        ok 3 - should stop at transitiveDepth limit
        ok 4 - should handle recursive functions (A calls A)
        ok 5 - should handle cycles (A calls B calls A)
        ok 6 - should return only direct calls when transitive=false (default)
    ok 3 - transitive mode
    # Subtest: edge cases
        ok 1 - should handle function without HAS_SCOPE edge
        ok 2 - should handle non-existent function ID
        ok 3 - should handle multiple scopes
        ok 4 - should not enter nested classes
    ok 4 - edge cases
ok 1 - findCallsInFunction

# tests 19
# suites 5
# pass 19
# fail 0
```

## Build Verification

```bash
pnpm build
# Success - all packages compiled without errors
```

## Files Changed

1. `packages/mcp/src/definitions.ts` - Added tool definition
2. `packages/mcp/src/types.ts` - Added types
3. `packages/mcp/src/handlers.ts` - Added handler and formatting helper
4. `packages/mcp/src/server.ts` - Registered handler
5. `packages/cli/src/commands/query.ts` - Fixed to use shared utilities

## Architecture Notes

The implementation follows Joel's plan from Phase 5-9:

1. **Shared utilities in `@grafema/core`** - Already done in previous commits
2. **MCP handler uses shared utilities** - Uses `findCallsInFunction` and `findContainingFunction`
3. **CLI uses shared utilities** - Replaced buggy local implementation

The shared utilities enforce the correct graph structure:
```
FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL/METHOD_CALL
                        SCOPE -[CONTAINS]-> SCOPE (nested blocks)
```

---

*Rob Pike, Implementation Engineer*
*REG-254: Variable tracing stops at function call boundaries*
