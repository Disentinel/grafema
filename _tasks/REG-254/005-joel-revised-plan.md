# REG-254: Joel Spolsky - Revised Technical Implementation Plan

## Overview

**Goal:** Enable AI agents to answer "what functions does X call?"

**Scope:** Comprehensive - Add MCP tool + fix CLI bug + extract shared utilities

**Key Changes from Original Plan:**
1. Remove "alternative structure" code (FUNCTION -> CONTAINS doesn't exist)
2. Add METHOD_CALL support (both MCP and CLI)
3. Extract shared utilities to `packages/core/src/queries/`
4. Add `transitive: boolean` parameter for call chain traversal
5. Document graph architecture

---

## Architecture: Where Shared Utilities Go

### Decision: `packages/core/src/queries/`

**Why `packages/core`:**
- MCP already depends on core (`@grafema/core`)
- CLI already depends on core
- Core is the natural home for graph traversal utilities
- No new package needed, no circular dependencies

**New Directory Structure:**

```
packages/core/src/queries/
├── index.ts              # Public exports
├── types.ts              # Shared types for query results
├── findCallsInFunction.ts    # Extract CALL/METHOD_CALL nodes from function scope
├── findContainingFunction.ts # Walk up containment tree to find parent function
└── README.md             # Architecture documentation (graph structure)
```

---

## Phase 1: Shared Types

**File:** `packages/core/src/queries/types.ts`

```typescript
/**
 * Information about a function/method call found in code
 */
export interface CallInfo {
  /** Node ID of the call site */
  id: string;
  /** Called function/method name */
  name: string;
  /** Node type: 'CALL' or 'METHOD_CALL' */
  type: 'CALL' | 'METHOD_CALL';
  /** Object name for method calls (e.g., 'response' for response.json()) */
  object?: string;
  /** Whether the call target was resolved (has CALLS edge) */
  resolved: boolean;
  /** Target function info if resolved */
  target?: {
    id: string;
    name: string;
    file?: string;
    line?: number;
  };
  /** File where call occurs */
  file?: string;
  /** Line number of call */
  line?: number;
  /** Depth in transitive call chain (0 = direct call) */
  depth?: number;
}

/**
 * Information about a function that calls another function
 */
export interface CallerInfo {
  /** Caller function ID */
  id: string;
  /** Caller function name */
  name: string;
  /** Caller function type (FUNCTION, CLASS, MODULE) */
  type: string;
  /** File containing the caller */
  file?: string;
  /** Line of the call site */
  line?: number;
}

/**
 * Options for finding calls in a function
 */
export interface FindCallsOptions {
  /** Maximum depth for scope traversal (default: 10) */
  maxDepth?: number;
  /** Follow transitive calls (default: false) */
  transitive?: boolean;
  /** Maximum depth for transitive traversal (default: 5) */
  transitiveDepth?: number;
}
```

---

## Phase 2: Shared Utility - findCallsInFunction

**File:** `packages/core/src/queries/findCallsInFunction.ts`

```typescript
import type { CallInfo, FindCallsOptions } from './types.js';

/**
 * Graph backend interface (minimal surface)
 */
interface GraphBackend {
  getNode(id: string): Promise<{ id: string; type: string; name: string; file?: string; line?: number; object?: string } | null>;
  getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/**
 * Find all CALL and METHOD_CALL nodes inside a function.
 *
 * Graph structure:
 * ```
 * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
 *                         SCOPE -[CONTAINS]-> METHOD_CALL
 *                         SCOPE -[CONTAINS]-> SCOPE (nested blocks)
 * ```
 *
 * Algorithm:
 * 1. Get function's scope via HAS_SCOPE edge
 * 2. BFS through CONTAINS edges, collecting CALL and METHOD_CALL nodes
 * 3. Stop at nested FUNCTION/CLASS boundaries (don't enter inner functions)
 * 4. For each call, check CALLS edge to determine if resolved
 * 5. If transitive=true, recursively follow resolved CALLS edges
 *
 * Performance: O(S + C) where S = scopes, C = calls
 * For functions with 100 calls, expect ~200 DB operations.
 *
 * @param backend - Graph backend for queries
 * @param functionId - ID of the FUNCTION node
 * @param options - Options for traversal
 * @returns Array of CallInfo objects
 */
export async function findCallsInFunction(
  backend: GraphBackend,
  functionId: string,
  options: FindCallsOptions = {}
): Promise<CallInfo[]> {
  const {
    maxDepth = 10,
    transitive = false,
    transitiveDepth = 5
  } = options;

  const calls: CallInfo[] = [];
  const visited = new Set<string>();
  const seenTargets = new Set<string>(); // For deduplication in transitive mode

  // Step 1: Get function's scope via HAS_SCOPE
  const hasScopeEdges = await backend.getOutgoingEdges(functionId, ['HAS_SCOPE']);

  // BFS queue: { nodeId, currentDepth }
  const queue: Array<{ id: string; depth: number }> = [];

  for (const edge of hasScopeEdges) {
    queue.push({ id: edge.dst, depth: 0 });
  }

  // Step 2: BFS through scopes
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const containsEdges = await backend.getOutgoingEdges(id, ['CONTAINS']);

    for (const edge of containsEdges) {
      const child = await backend.getNode(edge.dst);
      if (!child) continue;

      // Collect CALL and METHOD_CALL nodes
      if (child.type === 'CALL' || child.type === 'METHOD_CALL') {
        const callInfo = await buildCallInfo(backend, child, 0);
        calls.push(callInfo);

        // Transitive: follow resolved calls
        if (transitive && callInfo.resolved && callInfo.target) {
          await collectTransitiveCalls(
            backend,
            callInfo.target.id,
            1, // Starting at depth 1
            transitiveDepth,
            calls,
            seenTargets
          );
        }
      }

      // Continue into nested scopes, but NOT into nested functions/classes
      if (child.type === 'SCOPE') {
        queue.push({ id: child.id, depth: depth + 1 });
      }
      // Skip FUNCTION, CLASS - they have their own scope hierarchy
    }
  }

  return calls;
}

/**
 * Build CallInfo from a call node
 */
async function buildCallInfo(
  backend: GraphBackend,
  callNode: { id: string; type: string; name: string; file?: string; line?: number; object?: string },
  depth: number
): Promise<CallInfo> {
  // Check for CALLS edge (resolved target)
  const callsEdges = await backend.getOutgoingEdges(callNode.id, ['CALLS']);
  const isResolved = callsEdges.length > 0;

  let target = undefined;
  if (isResolved) {
    const targetNode = await backend.getNode(callsEdges[0].dst);
    if (targetNode) {
      target = {
        id: targetNode.id,
        name: targetNode.name,
        file: targetNode.file,
        line: targetNode.line,
      };
    }
  }

  return {
    id: callNode.id,
    name: callNode.name,
    type: callNode.type as 'CALL' | 'METHOD_CALL',
    object: callNode.object,
    resolved: isResolved,
    target,
    file: callNode.file,
    line: callNode.line,
    depth,
  };
}

/**
 * Recursively collect transitive calls
 *
 * Infinite loop prevention:
 * - Track seen function IDs in seenTargets
 * - Stop when we've seen a function before (handles recursion)
 * - Stop at transitiveDepth limit
 */
async function collectTransitiveCalls(
  backend: GraphBackend,
  functionId: string,
  currentDepth: number,
  maxTransitiveDepth: number,
  calls: CallInfo[],
  seenTargets: Set<string>
): Promise<void> {
  // Prevent infinite loops and limit depth
  if (seenTargets.has(functionId) || currentDepth > maxTransitiveDepth) {
    return;
  }
  seenTargets.add(functionId);

  // Find calls in this function
  const innerCalls = await findCallsInFunction(backend, functionId, {
    maxDepth: 10,
    transitive: false, // Don't recurse from inner calls
  });

  for (const call of innerCalls) {
    // Add with updated depth
    calls.push({ ...call, depth: currentDepth });

    // Continue transitively if resolved
    if (call.resolved && call.target) {
      await collectTransitiveCalls(
        backend,
        call.target.id,
        currentDepth + 1,
        maxTransitiveDepth,
        calls,
        seenTargets
      );
    }
  }
}
```

---

## Phase 3: Shared Utility - findContainingFunction

**File:** `packages/core/src/queries/findContainingFunction.ts`

```typescript
import type { CallerInfo } from './types.js';

/**
 * Graph backend interface (minimal surface)
 */
interface GraphBackend {
  getNode(id: string): Promise<{ id: string; type: string; name: string; file?: string; line?: number } | null>;
  getIncomingEdges(nodeId: string, edgeTypes: string[] | null): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/**
 * Find the FUNCTION, CLASS, or MODULE that contains a node.
 *
 * Graph structure (backward traversal):
 * ```
 * CALL <- CONTAINS <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * ```
 *
 * Algorithm:
 * 1. BFS up the containment tree via CONTAINS edges
 * 2. Also follow HAS_SCOPE edges (connects FUNCTION to its body SCOPE)
 * 3. Stop when we find FUNCTION, CLASS, or MODULE
 *
 * @param backend - Graph backend for queries
 * @param nodeId - ID of the node to find container for
 * @param maxDepth - Maximum traversal depth (default: 15)
 * @returns CallerInfo or null if no container found
 */
export async function findContainingFunction(
  backend: GraphBackend,
  nodeId: string,
  maxDepth: number = 15
): Promise<CallerInfo | null> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    // Get incoming edges: CONTAINS and HAS_SCOPE
    const edges = await backend.getIncomingEdges(id, ['CONTAINS', 'HAS_SCOPE']);

    for (const edge of edges) {
      const parentNode = await backend.getNode(edge.src);
      if (!parentNode || visited.has(parentNode.id)) continue;

      // Found container!
      if (parentNode.type === 'FUNCTION' || parentNode.type === 'CLASS' || parentNode.type === 'MODULE') {
        return {
          id: parentNode.id,
          name: parentNode.name || '<anonymous>',
          type: parentNode.type,
          file: parentNode.file,
          line: parentNode.line,
        };
      }

      // Continue searching
      queue.push({ id: parentNode.id, depth: depth + 1 });
    }
  }

  return null;
}
```

---

## Phase 4: Public Exports

**File:** `packages/core/src/queries/index.ts`

```typescript
/**
 * Graph Query Utilities
 *
 * Shared utilities for querying the code graph.
 * Used by MCP, CLI, and other tools.
 */

export { findCallsInFunction } from './findCallsInFunction.js';
export { findContainingFunction } from './findContainingFunction.js';
export type { CallInfo, CallerInfo, FindCallsOptions } from './types.js';
```

**Update:** `packages/core/src/index.ts` (add export)

```typescript
// ... existing exports ...
export * from './queries/index.js';
```

---

## Phase 5: MCP Handler Implementation

**File:** `packages/mcp/src/handlers.ts`

Add new handler using shared utilities:

```typescript
import { findCallsInFunction, findContainingFunction } from '@grafema/core';
import type { CallInfo, CallerInfo } from '@grafema/core';

// Types for this handler
interface GetFunctionDetailsArgs {
  name: string;
  file?: string;
  transitive?: boolean;
}

interface FunctionDetailsResult {
  id: string;
  name: string;
  file?: string;
  line?: number;
  async?: boolean;
  calls: CallInfo[];
  calledBy: CallerInfo[];
}

/**
 * Get comprehensive function details including calls made and callers.
 *
 * Graph structure:
 * ```
 * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL/METHOD_CALL
 *                         SCOPE -[CONTAINS]-> SCOPE (nested blocks)
 * CALL -[CALLS]-> FUNCTION (target)
 * ```
 *
 * This is the core tool for understanding function behavior.
 * Use transitive=true to follow call chains (A -> B -> C).
 */
export async function handleGetFunctionDetails(
  args: GetFunctionDetailsArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { name, file, transitive = false } = args;

  // Step 1: Find the function
  const candidates: GraphNode[] = [];
  for await (const node of db.queryNodes({ type: 'FUNCTION' })) {
    if (node.name !== name) continue;
    if (file && !node.file?.includes(file)) continue;
    candidates.push(node);
  }

  if (candidates.length === 0) {
    return errorResult(
      `Function "${name}" not found.` +
      (file ? ` (searched in files matching "${file}")` : '')
    );
  }

  if (candidates.length > 1 && !file) {
    const locations = candidates.map(f => `${f.file}:${f.line}`).join(', ');
    return errorResult(
      `Multiple functions named "${name}" found: ${locations}. ` +
      `Use the "file" parameter to disambiguate.`
    );
  }

  const targetFunction = candidates[0];

  // Step 2: Find calls using shared utility
  const calls = await findCallsInFunction(db, targetFunction.id, {
    transitive,
    transitiveDepth: 5,
  });

  // Step 3: Find callers
  const calledBy: CallerInfo[] = [];
  const incomingCalls = await db.getIncomingEdges(targetFunction.id, ['CALLS']);
  const seenCallers = new Set<string>();

  for (const edge of incomingCalls) {
    const caller = await findContainingFunction(db, edge.src);
    if (caller && !seenCallers.has(caller.id)) {
      seenCallers.add(caller.id);
      calledBy.push(caller);
    }
  }

  // Step 4: Build result
  const result: FunctionDetailsResult = {
    id: targetFunction.id,
    name: targetFunction.name,
    file: targetFunction.file,
    line: targetFunction.line as number | undefined,
    async: targetFunction.async as boolean | undefined,
    calls,
    calledBy,
  };

  // Format output
  const summary = [
    `Function: ${result.name}`,
    `File: ${result.file || 'unknown'}:${result.line || '?'}`,
    `Async: ${result.async || false}`,
    `Transitive: ${transitive}`,
    '',
    `Calls (${calls.length}):`,
    ...formatCalls(calls),
    '',
    `Called by (${calledBy.length}):`,
    ...calledBy.map(c => `  - ${c.name} (${c.file}:${c.line})`),
  ].join('\n');

  return textResult(
    summary + '\n\n' +
    JSON.stringify(serializeBigInt(result), null, 2)
  );
}

/**
 * Format calls for display, grouped by depth if transitive
 */
function formatCalls(calls: CallInfo[]): string[] {
  const directCalls = calls.filter(c => (c.depth || 0) === 0);
  const transitiveCalls = calls.filter(c => (c.depth || 0) > 0);

  const lines: string[] = [];

  // Direct calls
  for (const c of directCalls) {
    const target = c.resolved
      ? ` -> ${c.target?.name} (${c.target?.file}:${c.target?.line})`
      : ' (unresolved)';
    const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
    lines.push(`  - ${prefix}${c.name}()${target}`);
  }

  // Transitive calls (grouped by depth)
  if (transitiveCalls.length > 0) {
    lines.push('');
    lines.push('  Transitive calls:');

    const byDepth = new Map<number, CallInfo[]>();
    for (const c of transitiveCalls) {
      const depth = c.depth || 1;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(c);
    }

    for (const [depth, depthCalls] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
      for (const c of depthCalls) {
        const indent = '  '.repeat(depth + 1);
        const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
        const target = c.resolved ? ` -> ${c.target?.name}` : '';
        lines.push(`${indent}[depth=${depth}] ${prefix}${c.name}()${target}`);
      }
    }
  }

  return lines;
}
```

---

## Phase 6: Fix CLI Bug

**File:** `packages/cli/src/commands/query.ts`

Replace the existing `findCallsInFunction` with import from core:

```typescript
// At top of file, add import:
import { findCallsInFunction as findCallsInFunctionCore, findContainingFunction } from '@grafema/core';
import type { CallInfo } from '@grafema/core';

// ... existing code ...

/**
 * Get functions that this node calls
 *
 * Uses shared utility from @grafema/core
 */
async function getCallees(
  backend: RFDBServerBackend,
  nodeId: string,
  limit: number
): Promise<NodeInfo[]> {
  const callees: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    // Use shared utility (now includes METHOD_CALL)
    const calls = await findCallsInFunctionCore(backend, nodeId);

    for (const call of calls) {
      if (callees.length >= limit) break;

      // Only include resolved calls with targets
      if (call.resolved && call.target && !seen.has(call.target.id)) {
        seen.add(call.target.id);
        callees.push({
          id: call.target.id,
          type: 'FUNCTION', // Could be improved with actual type
          name: call.target.name || '<anonymous>',
          file: call.target.file || '',
          line: call.target.line,
        });
      }
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.error('[query] Error in getCallees:', error);
    }
  }

  return callees;
}

// Remove the old findCallsInFunction implementation (lines 565-613)
// It's now replaced by the import from @grafema/core
```

---

## Phase 7: Add Tool Definition

**File:** `packages/mcp/src/definitions.ts`

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

For calls array:
- resolved=true means target function was found
- resolved=false means unknown target (external/dynamic)
- type='CALL' for function calls like foo()
- type='METHOD_CALL' for method calls like obj.method()
- depth field shows transitive level (0=direct, 1+=indirect)

Use transitive=true to follow call chains (A calls B calls C).
Max transitive depth is 5 to prevent explosion.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Function name to look up',
      },
      file: {
        type: 'string',
        description: 'Optional: file path to disambiguate (partial match)',
      },
      transitive: {
        type: 'boolean',
        description: 'Follow call chains recursively (default: false)',
        default: false,
      },
    },
    required: ['name'],
  },
},
```

---

## Phase 8: Add Types to MCP

**File:** `packages/mcp/src/types.ts`

```typescript
// === GET FUNCTION DETAILS ===

/**
 * Arguments for get_function_details tool
 */
export interface GetFunctionDetailsArgs {
  /** Function name to look up */
  name: string;
  /** Optional: file path to disambiguate if multiple functions have same name */
  file?: string;
  /** Follow call chains recursively (A -> B -> C) */
  transitive?: boolean;
}

// Re-export types from core for convenience
export type { CallInfo, CallerInfo, FindCallsOptions } from '@grafema/core';
```

---

## Phase 9: Register Handler in Server

**File:** `packages/mcp/src/server.ts`

```typescript
// Add import
import { handleGetFunctionDetails } from './handlers.js';
import type { GetFunctionDetailsArgs } from './types.js';

// Add case in callTool switch
case 'get_function_details':
  return await handleGetFunctionDetails(args as GetFunctionDetailsArgs);
```

---

## Phase 10: Tests

**File:** `packages/core/test/unit/queries/findCallsInFunction.test.ts`

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findCallsInFunction } from '../../../src/queries/findCallsInFunction.js';

describe('findCallsInFunction', () => {
  describe('direct calls', () => {
    it('should find CALL nodes in function scope');
    it('should find METHOD_CALL nodes in function scope');
    it('should not enter nested functions');
    it('should handle nested scopes (if blocks, loops)');
    it('should return empty array for function with no calls');
  });

  describe('resolution status', () => {
    it('should mark calls with CALLS edge as resolved=true');
    it('should mark calls without CALLS edge as resolved=false');
  });

  describe('transitive mode', () => {
    it('should follow resolved CALLS edges when transitive=true');
    it('should add depth field for transitive calls');
    it('should stop at transitiveDepth limit');
    it('should handle recursive functions (A calls A)');
    it('should handle cycles (A calls B calls A)');
  });
});
```

**File:** `packages/mcp/test/get_function_details.test.ts`

```typescript
describe('get_function_details Tool', () => {
  describe('basic functionality', () => {
    it('should return function details with calls');
    it('should return function details with calledBy');
    it('should handle function not found');
    it('should disambiguate with file parameter');
  });

  describe('call types', () => {
    it('should include both CALL and METHOD_CALL nodes');
    it('should show object name for METHOD_CALL');
  });

  describe('transitive mode', () => {
    it('should return direct calls only when transitive=false');
    it('should follow call chains when transitive=true');
    it('should include depth in transitive results');
  });
});
```

---

## Implementation Order

| Step | Description | Dependencies | Estimated Time |
|------|-------------|--------------|----------------|
| 1 | Create `packages/core/src/queries/` directory | None | 5 min |
| 2 | Add types.ts | None | 10 min |
| 3 | Implement findCallsInFunction.ts | Step 2 | 30 min |
| 4 | Implement findContainingFunction.ts | Step 2 | 15 min |
| 5 | Add index.ts exports | Steps 3, 4 | 5 min |
| 6 | Update packages/core/src/index.ts | Step 5 | 2 min |
| 7 | Write unit tests for core utilities | Steps 3, 4 | 30 min |
| 8 | Add MCP types | Step 6 | 5 min |
| 9 | Add MCP tool definition | None | 5 min |
| 10 | Implement MCP handler | Steps 6, 8, 9 | 20 min |
| 11 | Register handler in server | Step 10 | 2 min |
| 12 | Fix CLI to use shared utilities | Step 6 | 15 min |
| 13 | Write MCP integration tests | Step 10 | 20 min |
| 14 | Manual testing | All | 15 min |

**Total Estimated Time:** ~3 hours

---

## Key Design Decisions

### 1. Transitive Traversal: How to Avoid Infinite Loops

**Strategy:** Track visited function IDs in `seenTargets` Set.

- When we start traversing a function's calls, add its ID to seenTargets
- Before following a resolved CALLS edge, check if target is in seenTargets
- If yes, skip (we've already processed this function)
- This handles both direct recursion (A -> A) and cycles (A -> B -> A)

**Max Depth:** Default transitiveDepth = 5 to prevent explosion.

### 2. Transitive Depth Field

Each call in transitive mode has a `depth` field:
- `depth: 0` - direct call from the queried function
- `depth: 1` - call made by a function that the queried function calls
- `depth: 2` - and so on...

This allows AI agents to understand the call chain hierarchy.

### 3. Why Core, Not Separate Package

Options considered:
1. `packages/graph-queries` - new package
2. `packages/core/src/queries/` - new directory in core
3. `packages/shared/` - new shared utilities package

**Decision: Option 2** because:
- No new package.json, build config, or npm publishing
- Core is already the dependency for both MCP and CLI
- Queries are inherently about the graph, which core owns
- Future queries (find_unused_exports, etc.) will go here too

### 4. Interface Design for Graph Backend

The shared utilities accept a minimal interface:

```typescript
interface GraphBackend {
  getNode(id: string): Promise<...>;
  getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<...>;
  getIncomingEdges(nodeId: string, edgeTypes: string[] | null): Promise<...>;
}
```

This is intentionally narrow to:
- Make testing easy (simple mocks)
- Avoid coupling to RFDBServerBackend implementation details
- Allow future backend implementations

---

## Graph Architecture Comment

**File:** `packages/core/src/queries/README.md`

```markdown
# Graph Query Utilities

## Graph Structure

### Function Containment

```
FUNCTION -[HAS_SCOPE]-> SCOPE (function_body)
                        SCOPE -[CONTAINS]-> SCOPE (nested blocks: if, for, etc.)
                        SCOPE -[CONTAINS]-> CALL (function call)
                        SCOPE -[CONTAINS]-> METHOD_CALL (method call)
                        SCOPE -[CONTAINS]-> VARIABLE
```

**Key Points:**
- FUNCTION nodes do NOT have CONTAINS edges directly
- FUNCTION has exactly one HAS_SCOPE edge to its body SCOPE
- All content (calls, variables, nested scopes) is inside SCOPEs
- Nested functions have their own HAS_SCOPE -> SCOPE hierarchy

### Call Resolution

```
CALL/METHOD_CALL -[CALLS]-> FUNCTION (target)
```

- CALLS edge exists only if target function was resolved
- Resolved = we found the function definition in the graph
- Unresolved = external function, dynamic call, or import issue

### Backward Traversal (finding container)

To find the function containing a CALL:

```
CALL <- CONTAINS <- SCOPE <- CONTAINS <- SCOPE <- HAS_SCOPE <- FUNCTION
```

Walk up via both CONTAINS and HAS_SCOPE edges.
```

---

## Success Criteria

1. `get_function_details` tool appears in MCP tool list
2. Returns calls with both CALL and METHOD_CALL types
3. Returns calledBy with caller function info
4. Transitive mode follows call chains
5. Transitive mode handles cycles without infinite loop
6. CLI `grafema query` uses shared utilities
7. CLI correctly shows METHOD_CALL calls
8. All new tests pass

---

## Risks and Mitigations

### Risk 1: Transitive Explosion
**Issue:** Large codebases may have deep call chains
**Mitigation:** Default transitiveDepth = 5, configurable

### Risk 2: Performance in Transitive Mode
**Issue:** Many DB operations for deep chains
**Mitigation:** Track seenTargets to avoid re-processing, document performance characteristics

### Risk 3: Breaking CLI Changes
**Issue:** Changing CLI's findCallsInFunction implementation
**Mitigation:** Keep same return format (NodeInfo[]), only change implementation

---

## Approval Checklist

- [ ] Don Melton: Architecture aligns with project vision
- [ ] Linus Torvalds: No hacks, proper solution

---

*Joel Spolsky, Implementation Planner*
*REG-254: Variable tracing stops at function call boundaries*
*Revised based on Linus review and user decisions*
