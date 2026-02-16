# @grafema/api

> GraphQL API server for Grafema code analysis toolkit

**Warning: This package is in beta stage and the API may change between minor versions.**

## Overview

This package provides a GraphQL endpoint on top of Grafema's graph database. It enables external tools, IDE extensions, and AI agents to query the code graph through a standard, self-documenting protocol.

**Key features:**
- Cursor-based pagination (Relay Connection spec)
- DataLoader pattern for N+1 query prevention
- GraphiQL IDE for interactive exploration
- Datalog query passthrough for advanced use cases

## Prerequisites

- RFDB server must be running (`grafema server start`)
- Project must be analyzed (`grafema analyze`)

## Usage

### Via CLI

```bash
# Start GraphQL server (requires RFDB server running)
grafema server graphql --port 4000

# GraphiQL IDE available at http://localhost:4000/graphql
```

### Programmatic

```typescript
import { createGraphQLServer, startServer } from '@grafema/api';
import { RFDBServerBackend } from '@grafema/core';

// Connect to RFDB
const backend = new RFDBServerBackend({ socketPath: '/tmp/grafema.sock' });
await backend.connect();

// Start server
const server = startServer({
  backend,
  port: 4000,
  hostname: 'localhost',
});
```

## GraphQL Schema

### Queries

#### Node Lookups

```graphql
# Get single node by ID
node(id: ID!): Node

# Find nodes with filtering and pagination
nodes(filter: NodeFilter, first: Int, after: String): NodeConnection!
```

#### Graph Traversal

```graphql
# BFS/DFS traversal
bfs(startIds: [ID!]!, maxDepth: Int!, edgeTypes: [String!]!): [ID!]!
dfs(startIds: [ID!]!, maxDepth: Int!, edgeTypes: [String!]): [ID!]!

# Check if path exists between nodes
reachability(from: ID!, to: ID!, edgeTypes: [String!], maxDepth: Int): Boolean!
```

#### Datalog Queries

```graphql
# Execute Datalog query
datalog(query: String!, limit: Int, offset: Int): DatalogResult!
```

#### High-Level Queries

```graphql
findCalls(target: String!, className: String, limit: Int): [CallInfo!]!
getFunctionDetails(name: String!, file: String): FunctionDetails
findGuards(nodeId: ID!): [GuardInfo!]!
traceAlias(variableName: String!, file: String!): [Node!]!
traceDataFlow(source: String!, direction: TraversalDirection): [[String!]!]!
```

#### Statistics

```graphql
stats: GraphStats!
analysisStatus: AnalysisStatus!
```

### Mutations

```graphql
# Run analysis
analyzeProject(service: String, force: Boolean): AnalysisResult!

# Guarantee management
checkGuarantees(names: [String!]): GuaranteeCheckResult!
checkInvariant(rule: String!, description: String): GuaranteeResult!
```

## Example Queries

### Get all functions

```graphql
query {
  nodes(filter: { type: "FUNCTION" }, first: 10) {
    edges {
      node {
        id
        name
        file
        line
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

### Find async functions using Datalog

```graphql
query {
  datalog(query: """
    violation(X) :-
      node(X, "FUNCTION"),
      attr(X, "async", true).
  """) {
    count
    results {
      node {
        name
        file
      }
    }
  }
}
```

### Check reachability

```graphql
query {
  reachability(
    from: "MODULE:src/index.ts"
    to: "FUNCTION:src/utils.ts->helper"
    edgeTypes: ["CALLS", "IMPORTS"]
    maxDepth: 5
  )
}
```

### Get graph statistics

```graphql
query {
  stats {
    nodeCount
    edgeCount
    nodesByType
  }
}
```

## Pagination

All collection queries use cursor-based pagination following the Relay Connection spec:

```graphql
query {
  nodes(filter: { type: "CALL" }, first: 20, after: "Y3Vyc29yOm5vZGUtMTA=") {
    edges {
      node { id name }
      cursor
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
    totalCount
  }
}
```

**Limits:**
- Default: 50 items
- Maximum: 250 items per request

## Configuration

```typescript
interface GraphQLServerOptions {
  backend: RFDBServerBackend;  // Required: graph backend
  port?: number;               // Default: 4000
  hostname?: string;           // Default: 'localhost'
  maxDepth?: number;           // Default: 10 (query depth limit)
  maxComplexity?: number;      // Default: 1000 (query cost limit)
  timeout?: number;            // Default: 30000ms
}
```

## License

Apache-2.0
