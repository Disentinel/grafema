# REG-254: Joel Spolsky - Technical Implementation Plan

## Overview

**Goal:** Enable AI agents to answer "what functions does X call?"

**Scope (User Selected):** Comprehensive - Add MCP tool + verify/fix cross-file resolution

**Estimated Implementation Time:** ~2-3 hours

---

## Investigation Tasks

### 1. Verify Cross-File Call Resolution Works

**What to verify:**
- FunctionCallResolver plugin (`packages/core/src/plugins/enrichment/FunctionCallResolver.ts`) creates CALLS edges for imported functions
- The plugin depends on ImportExportLinker (priority 90 vs 80)

**How to verify:**
1. Run analysis on `test/fixtures/08-reexports/` fixture (has cross-file imports)
2. Query the graph for CALLS edges
3. Check FunctionCallResolver test coverage in `test/unit/FunctionCallResolver.test.js`

**Current Test Coverage (from reading the test file):**
- Named imports: COVERED
- Default imports: COVERED
- Aliased imports: COVERED
- Re-export chains (single-hop, multi-hop): COVERED
- External/npm imports: COVERED (correctly skipped)
- Missing IMPORTS_FROM edge: COVERED (graceful handling)

**Finding:** FunctionCallResolver tests are comprehensive. Cross-file resolution SHOULD work for imported functions.

### 2. Identify Gap in Same-File Calls

**Analysis from Don's plan:**
- Same-file CALLS edges are created in GraphBuilder during analysis phase
- `functions.find(f => f.name === targetFunctionName)` - looks for function in same file
- This only works for same-file functions

**Potential Gap:**
- Same-file function calls should already have CALLS edges (created during analysis)
- Cross-file function calls get CALLS edges from FunctionCallResolver enrichment
- Method calls (response.json()) are different node types - need to include in query

---

## Implementation Plan

### Phase 1: Add Tests First (TDD)

**File:** `packages/mcp/test/mcp.test.ts`

Add new test section for `get_function_details` tool:

```typescript
describe('get_function_details Tool', () => {
  describe('calls outgoing (what this function calls)', () => {
    it('should return calls made by a function', async () => {
      // Setup: FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS -> CALL
      // CALL -> CALLS -> FUNCTION (target)
    });

    it('should return empty array for function with no calls', async () => {
      // Setup: FUNCTION with no calls inside
    });

    it('should include both resolved and unresolved calls', async () => {
      // Setup: Some CALL nodes with CALLS edge, some without
    });

    it('should distinguish function calls from method calls', async () => {
      // Setup: CALL nodes with/without 'object' attribute
    });
  });

  describe('calledBy incoming (who calls this function)', () => {
    it('should return callers of a function', async () => {
      // Setup: CALL -> CALLS -> FUNCTION (target)
      // Trace back to find the containing function
    });

    it('should return empty array for unused function', async () => {
      // Setup: FUNCTION with no incoming CALLS edges
    });
  });
});
```

### Phase 2: Add Type Definitions

**File:** `packages/mcp/src/types.ts`

Add new types:

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
}

/**
 * Information about a function call (outgoing or incoming)
 */
export interface FunctionCallInfo {
  /** Call site ID */
  id: string;
  /** Called function/method name */
  name: string;
  /** 'CALL' or 'METHOD_CALL' */
  type: 'CALL' | 'METHOD_CALL';
  /** Object name for method calls (e.g., 'response' for response.json()) */
  object?: string;
  /** Whether the call is resolved (has CALLS edge) */
  resolved: boolean;
  /** Target function info if resolved */
  target?: {
    id: string;
    name: string;
    file?: string;
    line?: number;
  };
  /** Location of the call */
  file?: string;
  line?: number;
}

/**
 * Information about who calls this function
 */
export interface CallerInfo {
  /** Caller function ID */
  id: string;
  /** Caller function name */
  name: string;
  /** File containing the caller */
  file?: string;
  /** Line of the call site */
  line?: number;
}

/**
 * Result of get_function_details
 */
export interface FunctionDetailsResult {
  /** Function node ID */
  id: string;
  /** Function name */
  name: string;
  /** File path */
  file?: string;
  /** Line number */
  line?: number;
  /** Is async function */
  async?: boolean;
  /** Function parameters */
  params?: string[];
  /** Return type if available */
  returnType?: string;
  /** Calls made BY this function */
  calls: FunctionCallInfo[];
  /** Functions that call THIS function */
  calledBy: CallerInfo[];
}
```

### Phase 3: Add Tool Definition

**File:** `packages/mcp/src/definitions.ts`

Add tool definition to `TOOLS` array:

```typescript
{
  name: 'get_function_details',
  description: `Get comprehensive details about a function, including what it calls and who calls it.

Returns:
- Function metadata (name, file, line, async, params)
- calls: What functions/methods this function calls (outgoing edges)
- calledBy: What functions call this one (incoming edges)

Use this to understand:
- Function behavior: "What does fetchUser() call?"
- Function usage: "Who calls validateInput()?"
- Data flow: "What functions are involved in processing this request?"

For calls array:
- resolved=true means we found the target function definition
- resolved=false means the call target is unknown (external/dynamic)
- type='CALL' for function calls like foo()
- type='METHOD_CALL' for method calls like obj.method()`,
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
    },
    required: ['name'],
  },
},
```

### Phase 4: Implement Handler

**File:** `packages/mcp/src/handlers.ts`

Add new handler function:

```typescript
// === GET FUNCTION DETAILS ===

/**
 * Get comprehensive function details including calls made and callers.
 *
 * Algorithm:
 * 1. Find FUNCTION node by name (optionally filtered by file)
 * 2. Get function's scope via HAS_SCOPE edge
 * 3. Find all CALL/METHOD_CALL nodes CONTAINED in that scope
 * 4. For each call, check if it has CALLS edge (resolved)
 * 5. Find incoming CALLS edges to get callers
 * 6. Return combined result
 */
export async function handleGetFunctionDetails(
  args: GetFunctionDetailsArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { name, file } = args;

  // Step 1: Find the function
  let targetFunction: GraphNode | null = null;
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

  targetFunction = candidates[0];

  // Step 2: Find function's scope
  const hasScopeEdges = await db.getOutgoingEdges(targetFunction.id, ['HAS_SCOPE']);

  // Step 3: Collect all calls within the function
  const calls: FunctionCallInfo[] = [];
  const visitedScopes = new Set<string>();

  // Recursively collect calls from all nested scopes
  async function collectCallsFromScope(scopeId: string) {
    if (visitedScopes.has(scopeId)) return;
    visitedScopes.add(scopeId);

    const containsEdges = await db.getOutgoingEdges(scopeId, ['CONTAINS']);

    for (const edge of containsEdges) {
      const childNode = await db.getNode(edge.dst);
      if (!childNode) continue;

      if (childNode.type === 'CALL') {
        const callsEdges = await db.getOutgoingEdges(childNode.id, ['CALLS']);
        const isResolved = callsEdges.length > 0;

        let target = null;
        if (isResolved) {
          const targetNode = await db.getNode(callsEdges[0].dst);
          if (targetNode) {
            target = {
              id: targetNode.id,
              name: targetNode.name,
              file: targetNode.file,
              line: targetNode.line as number | undefined,
            };
          }
        }

        calls.push({
          id: childNode.id,
          name: childNode.name,
          type: childNode.object ? 'METHOD_CALL' : 'CALL',
          object: childNode.object as string | undefined,
          resolved: isResolved,
          target,
          file: childNode.file,
          line: childNode.line as number | undefined,
        });
      }

      // Recurse into nested scopes (if statements, loops, etc.)
      if (childNode.type === 'SCOPE') {
        await collectCallsFromScope(childNode.id);
      }
    }
  }

  // Start from function's direct scope(s)
  for (const edge of hasScopeEdges) {
    await collectCallsFromScope(edge.dst);
  }

  // Also check CONTAINS edges directly from function (alternative structure)
  const directContains = await db.getOutgoingEdges(targetFunction.id, ['CONTAINS']);
  for (const edge of directContains) {
    const childNode = await db.getNode(edge.dst);
    if (childNode?.type === 'SCOPE') {
      await collectCallsFromScope(childNode.id);
    }
  }

  // Step 4: Find callers (incoming CALLS edges)
  const calledBy: CallerInfo[] = [];
  const incomingCalls = await db.getIncomingEdges(targetFunction.id, ['CALLS']);

  for (const edge of incomingCalls) {
    // edge.src is the CALL node, we need to find its containing function
    const callNode = await db.getNode(edge.src);
    if (!callNode) continue;

    // Find the containing function via CONTAINS edges
    // Walk up: CALL -> SCOPE -> ... -> FUNCTION
    let currentId = callNode.id;
    let callerFunction: GraphNode | null = null;
    const visited = new Set<string>();

    while (!callerFunction && !visited.has(currentId)) {
      visited.add(currentId);
      const containsEdges = await db.getIncomingEdges(currentId, ['CONTAINS', 'HAS_SCOPE']);

      if (containsEdges.length === 0) break;

      const parentId = containsEdges[0].src;
      const parentNode = await db.getNode(parentId);

      if (!parentNode) break;

      if (parentNode.type === 'FUNCTION') {
        callerFunction = parentNode;
      } else {
        currentId = parentId;
      }
    }

    calledBy.push({
      id: callerFunction?.id || callNode.id,
      name: callerFunction?.name || `(call at line ${callNode.line})`,
      file: callNode.file,
      line: callNode.line as number | undefined,
    });
  }

  // Step 5: Build result
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
    '',
    `Calls (${calls.length}):`,
    ...calls.map(c => {
      const target = c.resolved ? ` -> ${c.target?.name} (${c.target?.file}:${c.target?.line})` : ' (unresolved)';
      const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
      return `  - ${prefix}${c.name}()${target}`;
    }),
    '',
    `Called by (${calledBy.length}):`,
    ...calledBy.map(c => `  - ${c.name} (${c.file}:${c.line})`),
  ].join('\n');

  return textResult(
    summary + '\n\n' +
    JSON.stringify(serializeBigInt(result), null, 2)
  );
}
```

### Phase 5: Register Handler in Server

**File:** `packages/mcp/src/server.ts`

Add case for new tool in the `callTool` switch statement:

```typescript
case 'get_function_details':
  return await handleGetFunctionDetails(args as GetFunctionDetailsArgs);
```

Also add import:
```typescript
import { handleGetFunctionDetails } from './handlers.js';
import type { GetFunctionDetailsArgs } from './types.js';
```

---

## Implementation Order

| Step | Description | Dependencies | Estimated Time |
|------|-------------|--------------|----------------|
| 1 | Add test scaffolding (write failing tests) | None | 20 min |
| 2 | Add types to types.ts | None | 10 min |
| 3 | Add tool definition to definitions.ts | Step 2 | 10 min |
| 4 | Implement handler in handlers.ts | Steps 2, 3 | 45 min |
| 5 | Register handler in server.ts | Steps 2, 4 | 5 min |
| 6 | Run tests, fix issues | Steps 1-5 | 30 min |
| 7 | Manual integration test with real codebase | All | 20 min |

---

## Test Cases from Issue

### Test Case 1: Same-File Calls
```javascript
// File: api.js
function helper() { return 'help'; }
function main() {
  helper();  // Same-file call
}
```
**Expected:** `get_function_details(name: 'main')` returns calls containing `helper` with resolved=true

### Test Case 2: Cross-File Calls (Imported)
```javascript
// File: utils.js
export function authFetch() { ... }

// File: api.js
import { authFetch } from './utils.js';
function fetchInvitations() {
  authFetch();  // Cross-file call via import
}
```
**Expected:** `get_function_details(name: 'fetchInvitations')` returns calls containing `authFetch` with resolved=true (if FunctionCallResolver works)

### Test Case 3: Method Calls
```javascript
function fetchData() {
  const response = await fetch('/api');
  const data = await response.json();  // Method call
  return data;
}
```
**Expected:** `get_function_details(name: 'fetchData')` returns calls containing:
- `fetch()` (CALL, may be unresolved as it's a global)
- `response.json()` (METHOD_CALL, object='response')

### Test Case 4: Async/Await
```javascript
async function loadData() {
  const result = await authFetch();  // await doesn't affect detection
  return result;
}
```
**Expected:** `get_function_details(name: 'loadData')` returns `authFetch` call regardless of await

---

## Risks and Mitigations

### Risk 1: Graph Structure Variations
**Issue:** Different analyzers may create different structures (HAS_SCOPE vs CONTAINS)
**Mitigation:** Check both edge types when collecting calls

### Risk 2: Method Calls Without CALLS Edges
**Issue:** Method calls (obj.method()) may not have CALLS edges (no target resolution)
**Mitigation:** Include them in results with resolved=false

### Risk 3: Recursive Function Calls
**Issue:** Function calling itself - must not infinite loop
**Mitigation:** Track visited scopes with Set

### Risk 4: Module-Level Code
**Issue:** Calls outside any function (top-level)
**Mitigation:** Handle by finding MODULE -> CONTAINS -> CALL pattern (out of scope for V1)

---

## Success Criteria

1. `get_function_details` tool appears in MCP tool list
2. Returns correct calls for same-file function calls
3. Returns correct calls for cross-file imported function calls
4. Returns correct calledBy for functions called from other functions
5. Handles method calls (shows object name)
6. Shows resolved status for each call
7. All new tests pass

---

## Future Enhancements (Out of Scope)

1. **Indirect calls via variables:** `const fn = helper; fn();`
2. **Dynamic calls:** `obj[method]()`
3. **Module-level calls:** Top-level code outside functions
4. **Return type inference:** From AST or JSDoc
5. **Call arguments:** What values are passed to each call

---

## Approval Checklist

- [ ] Don Melton: Plan aligns with architecture?
- [ ] Linus Torvalds: This is the right solution, not a hack?

---

*Joel Spolsky, Implementation Planner*
*REG-254: Variable tracing stops at function call boundaries*
