# REG-132: Expose reachability query as MCP tool

## Issue

REG-115 implemented `graph.reachability()` API at the protocol layer. Now expose it to AI agents via MCP.

## Proposed MCP Tool

```typescript
{
  name: "graph_reachability",
  description: "Find all nodes transitively reachable via specified edge types",
  inputSchema: {
    type: "object",
    properties: {
      startIds: { type: "array", items: { type: "string" } },
      maxDepth: { type: "number", default: 10 },
      edgeTypes: { type: "array", items: { type: "string" } },
      backward: { type: "boolean", default: false }
    },
    required: ["startIds"]
  }
}
```

## Use Cases for AI Agents

- "Does untrusted input reach SQL query?" → backward reachability
- "What functions are affected if I change this?" → forward reachability
- "Trace data flow from user input to sensitive sink" → combined queries

## Acceptance Criteria

- [ ] Add `graph_reachability` tool definition to MCP
- [ ] Handler calls `backend.reachability()`
- [ ] Returns node details (not just IDs) for agent readability
- [ ] Document tool for AI agents
