# REG-254: Don Melton Analysis - Variable tracing stops at function call boundaries

## Executive Summary

This is NOT a bug in call detection. Calls ARE being detected and stored correctly. The issue is a **missing query feature** - there's no tool or query that returns "what calls does this function make".

## Root Cause Diagnosis

### What IS Working

1. **Call detection inside functions** - `analyzeFunctionBody()` in JSASTAnalyzer.ts correctly handles `CallExpression` nodes and creates CALL_SITE/METHOD_CALL nodes with proper `parentScopeId`.

2. **CALLS edge creation** - GraphBuilder correctly creates:
   - `SCOPE -> CONTAINS -> CALL_SITE` edges
   - `CALL_SITE -> CALLS -> FUNCTION` edges (when target function is in same file)

3. **Call site storage** - Every `authFetch()` call inside `fetchInvitations` IS stored as a CALL node with:
   - Semantic ID
   - Parent scope ID linking to function body
   - Target function name for edge creation

### What's MISSING

There is NO way to query "what functions does X call". Looking at the MCP tools:

| Tool | Purpose | Returns calls FROM function? |
|------|---------|------------------------------|
| `find_calls` | Find calls TO a function | No - finds who calls X, not what X calls |
| `find_nodes` | Find nodes by type/name | No - doesn't follow edges |
| `query_graph` | Datalog queries | Possible but not obvious |
| `trace_dataflow` | Variable value tracing | No - about data, not calls |

**The "calls: []" in the user report likely comes from:**
1. A custom query/script that's looking for wrong relationship
2. Expecting FUNCTION nodes to have a `calls` property (they don't)
3. Looking at the wrong direction of edges

## Architecture Analysis

### Current Graph Structure (CORRECT)

```
MODULE
  |-- CONTAINS --> FUNCTION(fetchInvitations)
                      |-- HAS_SCOPE --> SCOPE(function_body)
                                          |-- CONTAINS --> CALL(authFetch)
                                                              |-- CALLS --> FUNCTION(authFetch) [if resolved]
```

### Missing User-Facing Capability

To answer "what does fetchInvitations call?", users need to:
1. Find FUNCTION by name
2. Find its function body SCOPE
3. Find all CALL nodes CONTAINED in that scope
4. Follow CALLS edges to get targets

This is a multi-hop query that should be a single tool call.

## High-Level Plan

### Option A: Add `get_function_details` Tool (RECOMMENDED)

Add a new MCP tool that returns comprehensive function information:

```typescript
// Input
{ name: "fetchInvitations", file?: "..." }

// Output
{
  id: "...",
  name: "fetchInvitations",
  file: "api.ts",
  line: 42,
  async: true,
  params: ["url: string"],
  returnType: "Promise<Response>",

  // NEW: What this function calls
  calls: [
    { name: "authFetch", type: "FUNCTION", resolved: true },
    { name: "response.json", type: "METHOD", resolved: false }
  ],

  // NEW: Who calls this function
  calledBy: [
    { name: "loadData", file: "loader.ts", line: 15 }
  ]
}
```

**Implementation:**
1. Query FUNCTION node by name
2. Find HAS_SCOPE edge to get body scope
3. Query CONTAINS edges from scope to get all calls
4. For each call, follow CALLS edge to get target info

### Option B: Document Existing Capability

Users CAN query this with Datalog, but it's not obvious:

```datalog
// Find all calls made BY a specific function
violation(Call) :-
  node(Func, "FUNCTION"), attr(Func, "name", "fetchInvitations"),
  edge(Func, Scope, "HAS_SCOPE"),
  edge(Scope, Call, "CONTAINS"),
  node(Call, "CALL").
```

But this is too complex for the primary use case.

### Option C: Add `calls` Field to FUNCTION Nodes

Store pre-computed call list on FUNCTION nodes during analysis.

**Pros:** Fast queries, simple access
**Cons:** Data duplication, sync issues, more storage

## Key Files That Need Changes

### For Option A (Recommended)

1. **packages/mcp/src/definitions.ts**
   - Add `get_function_details` tool definition

2. **packages/mcp/src/handlers.ts**
   - Add `handleGetFunctionDetails()` handler
   - Multi-hop query logic

3. **packages/mcp/src/types.ts**
   - Add types for function details response

### No Changes Needed In

- JSASTAnalyzer.ts - Call detection works
- GraphBuilder.ts - Edge creation works
- CallExpressionVisitor.ts - CALL node creation works

## Risks and Considerations

### Cross-File Call Resolution

Current limitation: `CALL_SITE -> CALLS -> FUNCTION` edges are only created when target function is **in the same file**.

```typescript
// GraphBuilder.ts line 500-508
const targetFunction = functions.find(f => f.name === targetFunctionName);
if (targetFunction) {
  this._bufferEdge({ type: 'CALLS', src: callData.id, dst: targetFunction.id });
}
```

For cross-file calls, there's an enrichment phase (FunctionCallResolver) that SHOULD resolve these - need to verify it's working.

### Method Calls vs Function Calls

`response.json()` in the example is a METHOD_CALL, not a regular CALL_SITE. The query needs to include both:
- CALL nodes (direct function calls)
- METHOD_CALL nodes (method calls)

### Async/Await

The issue mentions async functions. The call detection handles async correctly - `authFetch()` is detected regardless of await. However, the CALLS edge resolution might need verification for:
- Awaited calls: `await authFetch()`
- Chained calls: `await (await fetch()).json()`

## Decision Points for User

1. **Scope of Solution:**
   - Quick fix: Add `get_function_details` tool only
   - Comprehensive: Also verify/fix cross-file call resolution

2. **Priority:**
   - This is a **high-priority product gap** - directly impacts the core use case
   - AI querying the graph cannot answer basic questions about function behavior

3. **Acceptance Testing:**
   - Should include test case with:
     - Same-file calls (authFetch defined in same file)
     - Cross-file calls (authFetch imported)
     - Method calls (response.json())
     - Async/await patterns

## Conclusion

This is the RIGHT kind of issue to fix. It's not a hack or workaround - it's filling a real product gap. The graph HAS the data, we just need to expose it properly.

The fact that an AI assistant cannot answer "what does this function call?" means we're not meeting our core vision: **the graph should be the superior way to understand code**.

Recommend proceeding with Option A as primary solution, with verification of cross-file call resolution as follow-up.
