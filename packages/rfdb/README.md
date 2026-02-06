# @grafema/rfdb-client

> TypeScript client for RFDB (Rega Flow Database)

*Named after the author's wife Regina (Rega for short). The Hebrew word רגע (rega, "moment") conveniently fits the concept — a flow of discrete moments captured in the graph.*

**Warning: This package is in early alpha stage and is not recommended for production use.**

## Installation

```bash
npm install @grafema/rfdb-client
```

## Overview

High-performance TypeScript client for RFDB (Rega Flow Database) — a graph database optimized for code analysis. Communicates with RFDB server via Unix socket using MessagePack protocol.

## Features

- Socket-based client for out-of-process communication
- MessagePack binary protocol for efficiency
- Full graph operations: nodes, edges, queries
- Datalog query support

## Quick Start

```typescript
import { RFDBClient } from '@grafema/rfdb-client';

const client = new RFDBClient('/tmp/rfdb.sock');
await client.connect();

// Add nodes
await client.addNode({
  id: 'func-1',
  nodeType: 'FUNCTION',
  name: 'getUserById',
  file: 'src/api/users.ts'
});

// Query nodes
const functions = await client.findByType('FUNCTION');

// Execute Datalog query
const results = await client.queryDatalog('node(X, "FUNCTION"), attr(X, "name", "getUserById")');

await client.close();
```

## API

### Connection

- `connect()` - Connect to RFDB server
- `close()` - Close connection

### Nodes

- `addNode(node)` - Add a single node
- `addNodes(nodes)` - Batch add nodes
- `getNode(id)` - Get node by ID
- `findByType(type)` - Find nodes by type
- `queryNodes(query)` - Query nodes with filters

### Edges

- `addEdge(edge)` - Add a single edge
- `addEdges(edges)` - Batch add edges
- `getOutgoingEdges(nodeId, types?)` - Get outgoing edges
- `getIncomingEdges(nodeId, types?)` - Get incoming edges

### Queries

- `queryDatalog(query)` - Execute Datalog query

## License

Apache-2.0
