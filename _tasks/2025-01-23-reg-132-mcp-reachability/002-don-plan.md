# Don's Plan: REG-132 MCP Reachability Tool

## Task Classification

**Complexity:** Mini-MLA (clear requirements, local scope, affects few files)

**Lens:** Don → Rob → Linus

## Analysis

REG-115 already implemented the heavy lifting:
- `backend.reachability()` is fully functional at protocol layer
- RFDB client has the method in `packages/rfdb/ts/client.ts:291-304`
- Backend wrapper exists in `RFDBServerBackend.ts:601-609`

This is a thin MCP exposure layer - just wiring up existing functionality.

## Implementation Plan

### Files to Modify

1. **`packages/mcp/src/types.ts`** - Add args type
2. **`packages/mcp/src/definitions.ts`** - Add tool definition
3. **`packages/mcp/src/handlers.ts`** - Add handler
4. **`packages/mcp/src/server.ts`** - Wire up handler

### Step 1: Add Type (types.ts)

```typescript
export interface GraphReachabilityArgs {
  startIds: string[];
  maxDepth?: number;
  edgeTypes?: string[];
  backward?: boolean;
}
```

### Step 2: Add Tool Definition (definitions.ts)

Following the issue spec exactly:

```typescript
{
  name: 'graph_reachability',
  description: `Find all nodes transitively reachable from start nodes.

Use cases:
- "Does untrusted input reach SQL query?" → backward=true
- "What functions are affected if I change this?" → forward (default)
- "Trace data flow between points" → combine forward/backward

Parameters:
- startIds: Node IDs to start from
- maxDepth: Maximum traversal depth (default: 10)
- edgeTypes: Filter by edge types (e.g., CALLS, DEPENDS_ON)
- backward: Traverse incoming edges instead of outgoing`,
  inputSchema: {
    type: 'object',
    properties: {
      startIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Node IDs to start reachability search from',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 10)',
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Edge types to follow (e.g., CALLS, DEPENDS_ON)',
      },
      backward: {
        type: 'boolean',
        description: 'If true, follow incoming edges (default: false)',
      },
    },
    required: ['startIds'],
  },
}
```

### Step 3: Add Handler (handlers.ts)

```typescript
export async function handleGraphReachability(args: GraphReachabilityArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { startIds, maxDepth = 10, edgeTypes = [], backward = false } = args;

  try {
    // Validate startIds exist
    for (const id of startIds) {
      const node = await db.getNode(id);
      if (!node) {
        return errorResult(`Start node not found: ${id}`);
      }
    }

    // Call backend reachability
    const reachableIds = await (db as any).reachability(startIds, maxDepth, edgeTypes, backward);

    // Enrich with node details for AI readability
    const nodes: unknown[] = [];
    for (const id of reachableIds) {
      const node = await db.getNode(id);
      if (node) {
        nodes.push({
          id,
          type: node.type,
          name: node.name,
          file: node.file,
          line: node.line,
        });
      }
    }

    return textResult(
      `Found ${nodes.length} reachable node(s) from ${startIds.length} start node(s) ` +
      `(maxDepth=${maxDepth}, backward=${backward}):\n\n` +
      JSON.stringify(serializeBigInt(nodes), null, 2)
    );
  } catch (error) {
    return errorResult((error as Error).message);
  }
}
```

### Step 4: Wire Up (server.ts)

Add case in switch statement:
```typescript
case 'graph_reachability':
  result = await handleGraphReachability(args as any);
  break;
```

## Acceptance Criteria Check

- [x] Add `graph_reachability` tool definition to MCP
- [x] Handler calls `backend.reachability()`
- [x] Returns node details (not just IDs) for agent readability
- [x] Document tool for AI agents (in description)

## Risk Assessment

**Low risk:**
- Simple wiring of existing functionality
- Follows established patterns exactly
- No architectural changes

## Notes

- No tests exist for MCP handlers currently. This is tech debt but out of scope.
- The `db as any` cast is needed because GraphBackend interface doesn't include reachability. This matches existing patterns (e.g., checkGuarantee cast in handlers.ts:53).
