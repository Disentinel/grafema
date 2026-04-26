# REG-222 Phase 2 Analysis: Graph Schema Export

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-25

## Objective

Implement `grafema schema export --graph` to extract node/edge type definitions from Grafema's own codebase (dogfooding).

## Current State Analysis

### 1. Node Creation Patterns

Nodes are created through several mechanisms:

**A. GraphBuilder._bufferNode() (Primary path for AST analysis)**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts
this._bufferNode(funcData as GraphNode);
this._bufferNode({ type: 'CONSTRUCTOR_CALL', ... });
```

This is the main node creation path for JS/TS analysis. Types are:
- Functions, Classes, Methods
- Variables, Parameters, Constants, Literals
- Call sites, Method calls
- Imports, Exports
- Object/Array literals
- TypeScript: Interfaces, Types, Enums, Decorators

**B. NodeFactory.createX() methods**
```typescript
NodeFactory.createExternalStdio();
NodeFactory.createExternalModule(source);
NodeFactory.createExport(...);
NodeFactory.createInterface(...);
NodeFactory.createType(...);
NodeFactory.createService(...);
NodeFactory.createIssue(...);
```

**C. Direct graph.addNode() in specialized analyzers**
- ExpressAnalyzer: `http:route`, `express:mount`
- SocketIOAnalyzer: `socketio:emit`, `socketio:on`
- DatabaseAnalyzer: `db:query`
- RustAnalyzer: FUNCTION, CLASS, etc.
- ReactAnalyzer: components, hooks

### 2. Edge Creation Patterns

Edges are created via `_bufferEdge()` in GraphBuilder:
```typescript
this._bufferEdge({ type: 'CONTAINS', src: ..., dst: ... });
this._bufferEdge({ type: 'CALLS', src: ..., dst: ... });
```

### 3. Type Definitions Location

**Node types:** `/packages/core/src/core/nodes/NodeKind.ts`
- BASE_TYPES: FUNCTION, CLASS, METHOD, VARIABLE, etc.
- NAMESPACED_TYPES: http:route, express:router, socketio:emit, etc.

**Edge types:** `/packages/types/src/edges.ts`
- EDGE_TYPE constant with ~40 edge types

## Assessment: Can `resolveSink()` Help?

**Short answer: Not directly useful for this task.**

`resolveSink()` (from REG-230) traces values that flow to a specific function argument. The use case was:
```
resolveSink("addNode#0.type") -> ["FUNCTION", "CLASS", "VARIABLE", ...]
```

**Problem:** Most node/edge creation doesn't pass type as a literal argument:
1. Types are often inline strings in object literals: `{ type: 'FUNCTION', ... }`
2. GraphBuilder uses dynamic data from ASTCollections, not literals
3. Specialized analyzers build objects programmatically

**Conclusion:** We need a simpler, more direct approach.

## Recommended Approach: Static Extraction

Instead of tracing call sites dynamically, extract types from:

### Phase 2A: Extract from Type Definitions (Quick Win)

1. **NODE_TYPE constant** in `NodeKind.ts` - parse directly
2. **EDGE_TYPE constant** in `edges.ts` - parse directly
3. **Node factory methods** - list NodeFactory.createX methods

This gives us the "official" types without needing call site tracing.

**Output:**
```json
{
  "$schema": "grafema-graph-v1",
  "node_types": {
    "FUNCTION": { "category": "base", "source": "NodeKind.ts" },
    "http:route": { "category": "namespaced", "namespace": "http" }
  },
  "edge_types": {
    "CALLS": { "category": "calls", "source": "edges.ts" },
    "ASSIGNED_FROM": { "category": "data_flow" }
  }
}
```

### Phase 2B: Enrich with Usage Sites (Optional/Future)

If we want `created_in` locations and `valid_connections`:
1. Query the graph for all node types: `countNodesByType()`
2. Query edges: `countEdgesByType()`
3. Sample edges to find actual src/dst type combinations

This doesn't need `resolveSink()` - just standard graph queries.

## Implementation Plan

### Step 1: Add `--graph` option to schema command

```typescript
// packages/cli/src/commands/schema.ts
const graphSubcommand = new Command('export-graph')
  .description('Export graph node/edge type schema')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-f, --format <type>', 'Output format: json, yaml', 'json')
  .action(async (options) => {
    // Extract from type definitions + graph stats
  });
```

### Step 2: Create GraphSchemaExtractor

```typescript
// packages/core/src/schema/GraphSchemaExtractor.ts
export class GraphSchemaExtractor {
  constructor(private backend: GraphBackend) {}

  async extract(): Promise<GraphSchema> {
    // 1. Read NODE_TYPE, EDGE_TYPE from type definitions
    // 2. Augment with actual usage from graph
    const nodeTypeCounts = await this.backend.countNodesByType();
    const edgeTypeCounts = await this.backend.countEdgesByType();
    // ...
  }
}
```

### Step 3: Output Format

```json
{
  "$schema": "grafema-graph-v1",
  "version": "0.1.2",
  "extracted_at": "2025-01-25T12:00:00Z",
  "node_types": {
    "FUNCTION": {
      "category": "base",
      "count": 1234,
      "properties": ["name", "async", "generator", "params"]
    },
    "http:route": {
      "category": "namespaced",
      "namespace": "http",
      "count": 45
    }
  },
  "edge_types": {
    "CALLS": {
      "count": 5678,
      "connections": [
        { "from": "CALL", "to": "FUNCTION", "count": 4500 },
        { "from": "CALL", "to": "METHOD", "count": 1178 }
      ]
    }
  },
  "checksum": "abc123..."
}
```

## What We DON'T Need

1. **resolveSink()** - overkill for type extraction
2. **Call site tracing** - types are known statically
3. **Source code analysis of Grafema** - we can query the graph directly

## Technical Debt Noted

- REG-244: Consider ValueTracer utility for sharing code between trace.ts and future value resolution needs
- Current `countEdgesByType()` doesn't return connection types - may need enhancement

## Conclusion

**Phase 2 is achievable with existing infrastructure.**

The key insight: we don't need to trace "what values flow to createNode" - we already have:
1. Type definitions in code (static)
2. Actual usage in the graph (queryable via countNodesByType/countEdgesByType)

Estimated effort: 1-2 days for basic implementation.
