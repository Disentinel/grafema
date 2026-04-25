# Joel Spolsky Technical Plan: REG-274 (Revised Approach)

## Executive Summary

Persist constraints to SCOPE nodes + add `find_guards` MCP tool. Original BRANCH node proposal rejected as over-engineering.

## Part 1: Persist Constraints to SCOPE Nodes

### Problem Analysis

Constraints ARE collected by JSASTAnalyzer but get **lost** during serialization because `RFDBClient.addNodes()` only extracts 5 specific fields. Extra fields like `constraints`, `condition`, `scopeType`, `conditional` are silently discarded.

### Solution: Fix RFDBClient.addNodes()

**File:** `packages/rfdb/ts/client.ts`

```typescript
async addNodes(nodes: Array<Partial<WireNode> & { id: string; type?: string; node_type?: string; nodeType?: string }>): Promise<RFDBResponse> {
  const wireNodes: WireNode[] = nodes.map(n => {
    // Extract known wire format fields, rest goes to metadata
    const { id, type, node_type, nodeType, name, file, exported, metadata, ...rest } = n as Record<string, unknown>;

    // Merge explicit metadata with extra properties
    const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
    const combinedMeta = { ...existingMeta, ...rest };

    return {
      id: String(id),
      nodeType: (node_type || nodeType || type || 'UNKNOWN') as NodeType,
      name: (name as string) || '',
      file: (file as string) || '',
      exported: (exported as boolean) || false,
      metadata: JSON.stringify(combinedMeta),
    };
  });

  return this._send('addNodes', { nodes: wireNodes });
}
```

This preserves: `constraints`, `condition`, `scopeType`, `conditional`, `semanticId`, `line`

---

## Part 2: Add `find_guards` MCP Tool

### Tool Specification

**Input:**
```typescript
interface FindGuardsArgs {
  nodeId: string;  // ID of any node (CALL, VARIABLE, etc.)
}
```

**Output:** Array of guarding scopes from inner to outer
```typescript
interface GuardInfo {
  scopeId: string;
  scopeType: string;          // 'if_statement' | 'else_statement' | etc.
  condition?: string;         // Raw condition text
  constraints?: Constraint[]; // Parsed constraints
  file: string;
  line: number;
}
```

### Implementation

#### 1. Tool Definition (`packages/mcp/src/definitions.ts`)

```typescript
{
  name: 'find_guards',
  description: `Find conditional guards protecting a node.
Returns all SCOPE nodes that guard the given node, walking from inner to outer scope.
Useful for answering "what conditions must be true for this code to execute?"`,
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: 'ID of the node to find guards for',
      },
    },
    required: ['nodeId'],
  },
},
```

#### 2. Handler (`packages/mcp/src/handlers.ts`)

Walk up scope chain via CONTAINS edges, collecting conditional scopes:
1. Get target node
2. Find parent via incoming CONTAINS edge
3. If parent is conditional SCOPE, add to guards list
4. Continue until reaching top level
5. Return guards from inner to outer

---

## Test Cases

1. **CALL inside if-statement** → Returns 1 guard with condition
2. **Unguarded node** → Returns empty list
3. **Nested conditionals** → Returns guards inner-to-outer order
4. **else-statement** → Returns guard with negated constraints

---

## Implementation Order

1. Fix `RFDBClient.addNodes()` to preserve extra fields
2. Add `FindGuardsArgs` and `GuardInfo` types
3. Add `find_guards` tool definition
4. Implement `handleFindGuards` handler
5. Write tests
6. Manual testing with `grafema analyze` + MCP

---

## Critical Files

| File | Change |
|------|--------|
| `packages/rfdb/ts/client.ts` | Fix addNodes() to preserve metadata |
| `packages/mcp/src/types.ts` | Add FindGuardsArgs, GuardInfo |
| `packages/mcp/src/definitions.ts` | Add find_guards schema |
| `packages/mcp/src/handlers.ts` | Add handleFindGuards |
| `packages/mcp/src/index.ts` | Register handler |
