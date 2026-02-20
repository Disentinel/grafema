# REG-521: MCP Server Audit — Tech Lead Plan

**Task:** MCP server audit: improve tool descriptions + add traversal tools
**Linear:** [REG-521](https://linear.app/reginaflow/issue/REG-521)
**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-19

---

## 1. Request Quality Gate

### Assessment: PASS

**Red flags checked:**
- ❌ One-liner without context — No, request includes specific examples, acceptance criteria
- ❌ Prescribes solution without WHY — No, clear problem statement (AI agents don't understand when/why)
- ❌ Symptom instead of root cause — No, root cause is clear: missing context in tool descriptions

**Request quality:**
- Clear goal: self-documenting MCP server for AI agents
- Concrete examples: 8 tools to improve, 3 tools to add
- Acceptance criteria: working code, tests, all existing tests pass
- Implementation hints: references to existing code (`bfs()`, `getOutgoingEdges()`)

**Proceed with implementation.**

---

## 2. Exact New Descriptions

### Part 1: Server Description

**Current** (lines 88-99 in `packages/mcp/src/server.ts`):
```typescript
const server = new Server(
  {
    name: 'grafema-mcp',
    version: '0.1.0',
  },
  ...
);
```

**Current JSDoc** (lines 1-6):
```typescript
/**
 * Grafema MCP Server
 *
 * Provides code analysis tools via Model Context Protocol.
 */
```

**NEW JSDoc:**
```typescript
/**
 * Grafema MCP Server
 *
 * Graph-driven code analysis for AI agents. Query the code graph instead of reading files.
 *
 * Use Grafema when you need to:
 * - Navigate code structure (find callers, trace data flow, understand impact)
 * - Answer "who calls this?", "where is this used?", "what does this affect?"
 * - Analyze untyped/dynamic codebases where static analysis falls short
 * - Track relationships across files without manual grep
 *
 * Core capabilities:
 * - Datalog queries for pattern matching (query_graph)
 * - Call graph navigation (find_calls, get_function_details)
 * - Data flow tracing (trace_dataflow, trace_alias)
 * - Code guarantees/invariants (create_guarantee, check_guarantees)
 * - Graph traversal primitives (get_node, get_neighbors, traverse_graph)
 *
 * Workflow:
 * 1. discover_services — identify project structure
 * 2. analyze_project — build the graph
 * 3. Use query tools to explore code relationships
 */
```

**NEW Server Config:**
```typescript
const server = new Server(
  {
    name: 'grafema-mcp',
    version: '0.1.0',
    description: 'Graph-driven code analysis. Query the code graph instead of reading files. ' +
                 'Navigate call graphs, trace data flow, verify guarantees. ' +
                 'Designed for AI agents working with untyped/dynamic codebases.',
  },
  ...
);
```

---

### Part 2: Tool Descriptions (8 Weak Tools)

#### `find_nodes` (current: line 103-130)

**CURRENT:**
```
Find nodes in the graph by type, name, or file.
```

**NEW:**
```typescript
description: `Find nodes in the graph by type, name, or file pattern.

Use this when you need to:
- Find all functions in a specific file: type=FUNCTION, file="src/api.js"
- Find a class by name: type=CLASS, name="UserService"
- List all HTTP routes: type="http:route"
- Get all modules in a directory: type=MODULE, file="services/"

Returns semantic IDs that you can pass to get_context, get_function_details, or find_guards.

Supports partial matches on name and file. Use limit/offset for pagination.

Example: Find all async functions in auth module
  type=FUNCTION, name="auth", limit=50`
```

---

#### `trace_dataflow` (current: line 151-181)

**CURRENT:**
```
Trace data flow from/to a variable or expression.
```

**NEW:**
```typescript
description: `Trace data flow paths from or to a variable/expression.

Use this when you need to:
- Forward trace: "Where does this value flow to?" (assignments, function calls, returns)
- Backward trace: "Where does this value come from?" (sources, assignments)
- Both: Full data lineage from sources to sinks

Direction options:
- forward: Follow ASSIGNED_FROM, PASSES_ARGUMENT, FLOWS_INTO edges downstream
- backward: Follow edges upstream to find data sources
- both: Trace in both directions for complete context

Use cases:
- Track tainted data: "Does user input reach database query?" (forward from input, check for db:query)
- Find data sources: "What feeds this API response?" (backward from response)
- Impact analysis: "If I change this variable, what breaks?" (forward trace)

Returns: List of nodes in the data flow chain with edge types and depth.

Tip: Start with max_depth=5, increase if needed. Large graphs may need limit.`
```

---

#### `get_stats` (current: line 247-253)

**CURRENT:**
```
Get graph statistics: node and edge counts by type.
```

**NEW:**
```typescript
description: `Get graph statistics: node and edge counts by type.

Use this to:
- Verify analysis completed: Check for FUNCTION, MODULE, CALL nodes
- Understand graph size before expensive queries
- Confirm graph is loaded: nodeCount > 0 means analysis ran
- Identify what's in the graph: See all node/edge types with counts

Returns:
- nodeCount, edgeCount: Total counts
- nodesByType: {FUNCTION: 1234, CLASS: 56, ...}
- edgesByType: {CALLS: 5678, CONTAINS: 3456, ...}

Use BEFORE querying an unfamiliar graph to understand what data is available.`
```

---

#### `discover_services` (current: line 210-216)

**CURRENT:**
```
Discover services in the project without full analysis.
```

**NEW:**
```typescript
description: `Discover services in the project without full analysis.

Use this during onboarding to understand project structure BEFORE running analyze_project.

Returns:
- Service names and paths (e.g., "backend" at "apps/backend")
- Entry points (e.g., "src/index.ts")
- No graph data yet — this is fast discovery

Workflow:
1. discover_services — see what's in the project
2. analyze_project — build graph for specific service or all
3. Query tools — explore the graph

Tip: If project has no .grafema/config.yaml, this scans for common patterns
(package.json, index.ts, etc.). Use write_config to save the configuration.`
```

---

#### `analyze_project` (current: line 218-237)

**CURRENT:**
```
Run full analysis on the project or a specific service.
```

**NEW:**
```typescript
description: `Build the code graph by analyzing project source code.

REQUIRED before using query tools. Without this, the graph is empty.

Options:
- service: Analyze only one service (faster for multi-service projects)
- force: Re-analyze even if graph exists (use after code changes)
- index_only: Fast mode — create MODULE nodes only, skip detailed analysis

Use cases:
- First time: analyze_project() — builds full graph
- After code changes: analyze_project(force=true) — rebuilds graph
- Quick check: analyze_project(index_only=true) — just modules, no call graph

Phases:
1. Discovery — find entry points
2. Indexing — create MODULE nodes
3. Analysis — parse AST, extract functions/classes
4. Enrichment — resolve calls, track data flow
5. Validation — check guarantees

Returns: Analysis summary with node/edge counts and timing.

Tip: Use get_stats after analysis to verify graph was built.`
```

---

#### `get_coverage` (current: line 375-390)

**CURRENT:**
```
Get analysis coverage for a path.
```

**NEW:**
```typescript
description: `Check which files were analyzed and which were skipped.

Use this to:
- Find gaps: "Why doesn't query find this file?" — check if it was analyzed
- Verify include/exclude patterns work correctly
- Identify files ignored by config (node_modules, tests, etc.)
- Debug empty query results: "Graph has 0 nodes for this file" → check coverage

Returns:
- Analyzed files count and list
- Skipped files count with reasons (excluded by pattern, parse error, etc.)
- Coverage percentage

Options:
- path: Check specific directory (default: project root)
- depth: How deep to report directory tree (default: 2)

Use AFTER analyze_project when queries return unexpected empty results.`
```

---

#### `list_guarantees` (current: line 338-345)

**CURRENT:**
```
List all defined guarantees.
```

**NEW:**
```typescript
description: `List all defined code guarantees (rules/contracts).

Use this to:
- See existing invariants: "What rules does this codebase enforce?"
- Understand code contracts before modifying code
- Find Datalog-based rules (e.g., "no eval", "no SQL injection")
- List contract-based guarantees (queue schemas, API contracts)

Returns for each guarantee:
- name: Unique identifier
- type: Datalog rule or contract type (guarantee:queue, guarantee:api, etc.)
- description: Human-readable explanation
- rule: Datalog source (for Datalog guarantees)
- schema: JSON schema (for contract guarantees)
- priority: critical/important/observed/tracked
- status: active/changing/deprecated

Use BEFORE check_guarantees to see what will be validated.`
```

---

#### `check_guarantees` (current: line 346-359)

**CURRENT:**
```
Check all guarantees or specific ones.
```

**NEW:**
```typescript
description: `Validate code against defined guarantees and return violations.

Use this to:
- Find violations: Run all rules, get list of breaking code
- CI integration: check_guarantees() in CI fails on violations
- Verify specific rule: check_guarantees(names=["no-eval"]) — test one guarantee
- Pre-commit validation: Catch issues before code review

How it works:
- Datalog guarantees: Runs violation/1 query, returns matching nodes
- Contract guarantees: Validates nodes against JSON schema

Returns:
- Violations array with node IDs, file, line, rule name
- Empty array = all guarantees pass

Options:
- names: Check specific guarantees (omit to check all)

Use AFTER modifying code to verify you didn't break existing rules.`
```

---

### Part 3: New Tools

#### `get_node`

```typescript
{
  name: 'get_node',
  description: `Get a single node by semantic ID with full metadata.

Use this when you have a node ID from find_nodes, query_graph, or another tool
and need the complete node record.

Returns:
- All node properties: type, name, file, line, exported, etc.
- Metadata: async, generator, params, jsdocSummary (for functions)
- Type-specific fields: className (for methods), loopType (for loops), etc.

Use cases:
- After find_nodes: get_node(id) to see full details
- After query_graph: get_node(violation) to understand what violated the rule
- Quick lookup: "What's at this ID?" without full context

Faster than get_context (no edges, no code snippets), use when you only need node data.`,
  inputSchema: {
    type: 'object',
    properties: {
      semanticId: {
        type: 'string',
        description: 'Semantic ID of the node (from find_nodes, query_graph, etc.)',
      },
    },
    required: ['semanticId'],
  },
}
```

---

#### `get_neighbors`

```typescript
{
  name: 'get_neighbors',
  description: `Get direct neighbors of a node (incoming/outgoing edges).

Returns edges grouped by type with connected node summaries.

Use this when you need:
- "What does this node connect to?" (outgoing edges)
- "What connects to this node?" (incoming edges)
- Simple graph exploration without Datalog

Direction options:
- outgoing: Edges FROM this node (what it calls, contains, depends on)
- incoming: Edges TO this node (who calls it, what contains it)
- both: All edges (default)

Edge type filter (optional):
- edgeTypes: ['CALLS', 'CONTAINS'] — only these edge types
- Omit to get all edge types

Returns for each edge:
- Edge type (CALLS, CONTAINS, ASSIGNED_FROM, etc.)
- Connected node: {id, type, name, file, line}
- Edge metadata (if any)

Grouped output:
{
  outgoing: {
    CALLS: [{dst: "fn1", node: {...}}, ...],
    CONTAINS: [...]
  },
  incoming: {
    CALLED_BY: [{src: "caller1", node: {...}}, ...]
  }
}

Use when you want a quick neighborhood view without full context (cheaper than get_context).`,
  inputSchema: {
    type: 'object',
    properties: {
      semanticId: {
        type: 'string',
        description: 'Semantic ID of the node',
      },
      direction: {
        type: 'string',
        description: 'Edge direction: outgoing, incoming, or both (default: both)',
        enum: ['outgoing', 'incoming', 'both'],
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by edge types (e.g., ["CALLS", "CONTAINS"]). Omit for all types.',
      },
    },
    required: ['semanticId'],
  },
}
```

---

#### `traverse_graph`

```typescript
{
  name: 'traverse_graph',
  description: `Traverse the graph from start nodes following specific edge types.

Use Breadth-First Search (BFS) to find all reachable nodes up to maxDepth.

Use this for:
- Impact analysis: "What's affected if I change this?" (traverse outgoing DEPENDS_ON, CALLS)
- Dependency trees: "What does this depend on?" (traverse outgoing IMPORTS, USES)
- Reverse dependencies: "What depends on me?" (traverse incoming DEPENDS_ON)
- Reachability: "Can I reach node X from node Y?" (BFS with edge filter)

Edge types:
- CALLS, CONTAINS, DEPENDS_ON, ASSIGNED_FROM, etc.
- See get_schema(type='edges') for all available types

Direction:
- outgoing: Follow edges FROM start nodes (dependencies, callees, children)
- incoming: Follow edges TO start nodes (dependents, callers, parents)

Returns:
- Array of reachable node IDs
- Each with depth: 0 = start nodes, 1 = direct neighbors, 2+ = transitive

Use cases:
- Find all transitive dependencies: traverse_graph(startNodeIds=[moduleId], edgeTypes=['IMPORTS'], maxDepth=10)
- Find all callers (direct + indirect): traverse_graph(startNodeIds=[fnId], edgeTypes=['CALLS'], direction='incoming', maxDepth=5)
- Get function subtree: traverse_graph(startNodeIds=[fnId], edgeTypes=['CONTAINS', 'HAS_SCOPE'], maxDepth=20)

Implementation:
- Uses core backend.bfs() for outgoing direction
- Uses manual BFS with getIncomingEdges() for incoming direction

Tip: Start with maxDepth=5, increase if you need deeper traversal. Large graphs can return many nodes.`,
  inputSchema: {
    type: 'object',
    properties: {
      startNodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Starting node IDs (semantic IDs)',
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Edge types to traverse (e.g., ["CALLS", "DEPENDS_ON"])',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 5, recommended max: 20)',
      },
      direction: {
        type: 'string',
        description: 'Traversal direction: outgoing or incoming (default: outgoing)',
        enum: ['outgoing', 'incoming'],
      },
    },
    required: ['startNodeIds', 'edgeTypes'],
  },
}
```

---

## 3. Implementation Plan

### Files to Modify/Create

#### A. `packages/mcp/src/server.ts`

**Lines 1-6:** Update JSDoc comment (see Part 1 above)

**Lines 88-99:** Add `description` field to server config (see Part 1 above)

**Lines 117-228:** Add new tool routing in switch statement:
```typescript
case 'get_node':
  result = await handleGetNode(asArgs<GetNodeArgs>(args));
  break;

case 'get_neighbors':
  result = await handleGetNeighbors(asArgs<GetNeighborsArgs>(args));
  break;

case 'traverse_graph':
  result = await handleTraverseGraph(asArgs<TraverseGraphArgs>(args));
  break;
```

**Lines 47-69:** Add new imports:
```typescript
import {
  // ... existing handlers
  handleGetNode,
  handleGetNeighbors,
  handleTraverseGraph,
} from './handlers/index.js';
import type {
  // ... existing types
  GetNodeArgs,
  GetNeighborsArgs,
  TraverseGraphArgs,
} from './types.js';
```

---

#### B. `packages/mcp/src/definitions.ts`

**Replace descriptions for 8 weak tools:**
- Line 103: `find_nodes` description
- Line 151: `trace_dataflow` description
- Line 247: `get_stats` description
- Line 210: `discover_services` description
- Line 218: `analyze_project` description
- Line 375: `get_coverage` description
- Line 338: `list_guarantees` description
- Line 346: `check_guarantees` description

(Use exact text from Part 2 above)

**Add 3 new tool definitions at end of TOOLS array (before closing `]`):**
- `get_node` (see Part 3 above)
- `get_neighbors` (see Part 3 above)
- `traverse_graph` (see Part 3 above)

---

#### C. `packages/mcp/src/types.ts`

**Add new arg types (after line 347):**

```typescript
// === GET NODE (REG-521) ===
export interface GetNodeArgs {
  semanticId: string;
}

// === GET NEIGHBORS (REG-521) ===
export interface GetNeighborsArgs {
  semanticId: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  edgeTypes?: string[];
}

// === TRAVERSE GRAPH (REG-521) ===
export interface TraverseGraphArgs {
  startNodeIds: string[];
  edgeTypes: string[];
  maxDepth?: number;
  direction?: 'outgoing' | 'incoming';
}
```

---

#### D. `packages/mcp/src/handlers/graph-handlers.ts` (NEW FILE)

Create new handler file for graph traversal primitives:

```typescript
/**
 * MCP Graph Traversal Handlers (REG-521)
 */

import { ensureAnalyzed } from '../analysis.js';
import { textResult, errorResult } from '../utils.js';
import type {
  ToolResult,
  GetNodeArgs,
  GetNeighborsArgs,
  TraverseGraphArgs,
} from '../types.js';
import type { EdgeType } from '@grafema/types';

// === GET NODE ===

export async function handleGetNode(args: GetNodeArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { semanticId } = args;

  const node = await db.getNode(semanticId);
  if (!node) {
    return errorResult(`Node not found: ${semanticId}`);
  }

  return textResult(JSON.stringify(node, null, 2));
}

// === GET NEIGHBORS ===

export async function handleGetNeighbors(args: GetNeighborsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { semanticId, direction = 'both', edgeTypes } = args;

  // Verify node exists
  const node = await db.getNode(semanticId);
  if (!node) {
    return errorResult(`Node not found: ${semanticId}`);
  }

  const result: {
    outgoing?: Record<string, Array<{ dst: string; node: unknown; metadata?: unknown }>>;
    incoming?: Record<string, Array<{ src: string; node: unknown; metadata?: unknown }>>;
  } = {};

  // Get outgoing edges
  if (direction === 'outgoing' || direction === 'both') {
    const outgoing = await db.getOutgoingEdges(semanticId, edgeTypes as EdgeType[] || null);
    const grouped: Record<string, Array<{ dst: string; node: unknown; metadata?: unknown }>> = {};

    for (const edge of outgoing) {
      if (!grouped[edge.type]) grouped[edge.type] = [];
      const dstNode = await db.getNode(edge.dst);
      grouped[edge.type].push({
        dst: edge.dst,
        node: dstNode ? { id: dstNode.id, type: dstNode.type, name: dstNode.name, file: dstNode.file, line: dstNode.line } : null,
        metadata: edge.metadata,
      });
    }
    result.outgoing = grouped;
  }

  // Get incoming edges
  if (direction === 'incoming' || direction === 'both') {
    const incoming = await db.getIncomingEdges(semanticId, edgeTypes as EdgeType[] || null);
    const grouped: Record<string, Array<{ src: string; node: unknown; metadata?: unknown }>> = {};

    for (const edge of incoming) {
      if (!grouped[edge.type]) grouped[edge.type] = [];
      const srcNode = await db.getNode(edge.src);
      grouped[edge.type].push({
        src: edge.src,
        node: srcNode ? { id: srcNode.id, type: srcNode.type, name: srcNode.name, file: srcNode.file, line: srcNode.line } : null,
        metadata: edge.metadata,
      });
    }
    result.incoming = grouped;
  }

  return textResult(JSON.stringify(result, null, 2));
}

// === TRAVERSE GRAPH ===

export async function handleTraverseGraph(args: TraverseGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { startNodeIds, edgeTypes, maxDepth = 5, direction = 'outgoing' } = args;

  if (maxDepth > 20) {
    return errorResult('maxDepth must be <= 20 to prevent performance issues');
  }

  if (!startNodeIds.length) {
    return errorResult('startNodeIds must not be empty');
  }

  if (!edgeTypes.length) {
    return errorResult('edgeTypes must not be empty');
  }

  // Verify all start nodes exist
  for (const id of startNodeIds) {
    const node = await db.getNode(id);
    if (!node) {
      return errorResult(`Start node not found: ${id}`);
    }
  }

  let reachableIds: string[];

  if (direction === 'outgoing') {
    // Use backend.bfs() for outgoing direction
    // Need to convert edge type strings to numbers for bfs()
    const edgeTypeNumbers = edgeTypes.map(type => {
      // Import edgeTypeToNumber from GraphBackend
      const EDGE_TYPE_TO_NUMBER: Record<string, number> = {
        'CONTAINS': 1, 'DEPENDS_ON': 2, 'CALLS': 3, 'EXTENDS': 4,
        'IMPLEMENTS': 5, 'USES': 6, 'DEFINES': 7, 'IMPORTS': 8,
        'EXPORTS': 9, 'ROUTES_TO': 10, 'DECLARES': 11, 'HAS_SCOPE': 12,
        'CAPTURES': 13, 'MODIFIES': 14, 'WRITES_TO': 15, 'INSTANCE_OF': 16,
        'HANDLED_BY': 17, 'HAS_CALLBACK': 18, 'MAKES_REQUEST': 19,
        'IMPORTS_FROM': 20, 'EXPORTS_TO': 21, 'ASSIGNED_FROM': 22,
      };
      return EDGE_TYPE_TO_NUMBER[type] || 0;
    });

    reachableIds = await db.bfs(startNodeIds, maxDepth, edgeTypeNumbers);
  } else {
    // Manual BFS for incoming direction
    const visited = new Set<string>(startNodeIds);
    const queue: Array<{ id: string; depth: number }> = startNodeIds.map(id => ({ id, depth: 0 }));
    const results: Array<{ id: string; depth: number }> = [...queue];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const incoming = await db.getIncomingEdges(id, edgeTypes as EdgeType[]);
      for (const edge of incoming) {
        if (!visited.has(edge.src)) {
          visited.add(edge.src);
          queue.push({ id: edge.src, depth: depth + 1 });
          results.push({ id: edge.src, depth: depth + 1 });
        }
      }
    }

    reachableIds = results.map(r => r.id);
  }

  // Format results with node summaries
  const nodes = await Promise.all(
    reachableIds.map(async id => {
      const node = await db.getNode(id);
      return node ? {
        id: node.id,
        type: node.type,
        name: node.name,
        file: node.file,
        line: node.line,
      } : { id, type: 'UNKNOWN' };
    })
  );

  return textResult(JSON.stringify({
    count: nodes.length,
    nodes,
  }, null, 2));
}
```

---

#### E. `packages/mcp/src/handlers/index.ts`

**Add exports for new handlers:**

```typescript
export { handleGetNode, handleGetNeighbors, handleTraverseGraph } from './graph-handlers.js';
```

---

#### F. Tests

**Create `test/unit/mcp-graph-traversal.test.js`:**

Test all 3 new tools:
- `get_node` — lookup by semantic ID
- `get_neighbors` — incoming/outgoing/both, with edge type filter
- `traverse_graph` — BFS outgoing/incoming, depth limit, edge filter

Structure:
1. Setup: create test graph with known structure
2. Test get_node: verify node lookup works
3. Test get_neighbors: verify edge grouping, direction filter
4. Test traverse_graph: verify BFS reaches expected nodes, respects depth/direction

---

## 4. Implementation Order

1. **Update server description** (`server.ts` JSDoc + config)
2. **Update tool descriptions** (`definitions.ts` — 8 weak tools)
3. **Add new tool definitions** (`definitions.ts` — 3 new tools)
4. **Add new types** (`types.ts` — 3 arg interfaces)
5. **Create graph-handlers.ts** (new handler implementations)
6. **Update handlers/index.ts** (export new handlers)
7. **Update server.ts** (import + route new handlers)
8. **Write tests** (`test/unit/mcp-graph-traversal.test.js`)
9. **Run all tests** (`pnpm build && node --test`)

---

## 5. Risk Assessment

### Low Risk

- **Description changes** — purely documentation, zero runtime impact
- **New tools** — additive, no changes to existing tools

### Medium Risk

- **Edge type number mapping** in `traverse_graph` — duplicates logic from `GraphBackend.ts` (lines 236-258). Should import `edgeTypeToNumber()` instead.
  - **Mitigation:** Extract edge type mapping to shared utility, import in both places

### Testing Strategy

- **Existing tests must pass** — acceptance criterion, no regressions allowed
- **New tests required** — `get_node`, `get_neighbors`, `traverse_graph`
- **Manual verification** — test with MCP inspector or Claude Desktop

---

## 6. Definition of Done

- [ ] Server description explains value proposition (JSDoc + config.description)
- [ ] All 8 weak tool descriptions have when/why/use cases
- [ ] 3 new tool definitions added to TOOLS array
- [ ] 3 new handler functions implemented
- [ ] 3 new arg types added to types.ts
- [ ] Handlers exported and routed in server.ts
- [ ] Test file created with coverage for new tools
- [ ] All existing tests pass (`pnpm build && node --test`)
- [ ] No TypeScript errors (`pnpm build` succeeds)

---

## 7. Notes

**Edge type mapping duplication:**
- `GraphBackend.ts` lines 236-258 define `EDGE_TYPE_TO_NUMBER`
- Should import `edgeTypeToNumber()` in `graph-handlers.ts` instead of duplicating
- **Action:** Update implementation to use shared mapping

**BFS implementation:**
- Outgoing: Use `backend.bfs()` (already implemented)
- Incoming: Manual BFS with `getIncomingEdges()` (no backend method for incoming BFS)
- Both are correct per GraphBackend interface

**Performance notes:**
- `traverse_graph` can return large result sets — enforce maxDepth=20 limit
- `get_neighbors` is cheap — no traversal, just direct edges
- `get_node` is cheapest — single node lookup

**Follow existing patterns:**
- `find_guards`, `get_function_details`, `get_context` are good reference implementations
- Use `ensureAnalyzed()` for all handlers
- Use `textResult()` for success, `errorResult()` for failures
- Serialize results as formatted JSON (readability for AI agents)
