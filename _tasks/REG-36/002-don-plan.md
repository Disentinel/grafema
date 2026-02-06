# Don Melton: REG-36 Analysis

## Research Summary

Based on web search findings on API technologies for graph databases in 2025:

### GraphQL vs REST vs gRPC Comparison

| Aspect | GraphQL | REST | gRPC |
|--------|---------|------|------|
| **Latency** | ~180ms for complex queries | ~250ms average | ~25ms (fastest) |
| **Throughput** | ~15K complex queries/sec | ~20K simple requests/sec | ~50K requests/sec |
| **Browser Support** | Native | Native | Requires proxy (gRPC-web) |
| **Graph Query Fit** | Excellent - mirrors graph structure | Poor - requires multiple roundtrips | Good for internal services |
| **Client Control** | Client specifies exactly what data it needs | Server defines response structure | Contract-driven |
| **Learning Curve** | Moderate | Low | High |

### Key Insights from Research

1. **GraphQL naturally mirrors graph data structures** - Its query structure allows for multi-hop nesting and relationship traversal that closely resembles how we think about graph data.

2. **2025 Best Practice: Hybrid Stacks** - Modern systems use REST for simple CRUD, GraphQL for frontend flexibility, and gRPC for internal high-performance paths.

3. **N+1 Problem Solution** - GraphQL's batching via DataLoader is standard practice for efficient graph traversal.

4. **Security Considerations** - Query cost analysis, depth limiting, and rate limiting are essential for GraphQL APIs to prevent abuse.

## Current Architecture Analysis

### Existing Query Infrastructure

Grafema already has a robust internal query system:

1. **RFDB Server (Rust)** - Unix socket-based protocol with MessagePack serialization
   - Supports Datalog queries via `CheckGuarantee` and `DatalogQuery` commands
   - BFS/DFS traversal operations
   - Node/edge CRUD operations
   - Multi-database support with ephemeral databases

2. **MCP Integration** - 17+ tools exposing graph functionality:
   - `query_graph` - Datalog queries
   - `find_nodes`, `find_calls` - Pattern matching
   - `trace_alias`, `trace_dataflow` - Data flow analysis
   - `get_function_details` - Comprehensive function analysis
   - `check_guarantees` - Invariant verification

3. **CLI Query Command** - Structured queries:
   - `grafema query "function login"` (pattern-based search)
   - `grafema query --raw 'type(X, "FUNCTION")'` (Datalog)
   - Scope-aware search: `"response in fetchData"`

4. **Existing GraphAPI (packages/core/src/api/GraphAPI.ts)** - Basic REST-like HTTP server:
   - `/api/services` - List services
   - `/api/node/:id` - Get node by ID
   - `/api/node/:id/children` - Get children via CONTAINS edges
   - `/api/node/:id/edges` - Get outgoing edges

### Query Language: Datalog

The current query language is Datalog, implemented in Rust (`packages/rfdb-server/src/datalog/`):
- `violation(X) :- node(X, "FUNCTION"), attr(X, "name", "eval").`
- Supports negation, path queries, attribute matching
- Well-integrated with RFDB's graph engine

## Recommendation

**Primary: GraphQL API built on existing infrastructure**

### Rationale

1. **Natural Fit for Graph Data** - GraphQL's type system and query structure map perfectly to Grafema's node/edge model. Clients can query exactly the relationships they need without over-fetching.

2. **AI-First Design** - GraphQL's self-documenting schema (introspection) is ideal for AI agents. LLMs can explore available queries programmatically and construct precise queries.

3. **Existing Foundation** - We already have:
   - Type definitions in `@grafema/types`
   - Query handlers in MCP package
   - Basic HTTP server in GraphAPI.ts
   - Datalog engine for complex queries

4. **No Conflict with Internal Protocol** - GraphQL would be the public API layer; RFDB's MessagePack protocol remains the high-performance internal path.

### NOT Recommended

- **Pure REST** - Would require dozens of endpoints to express graph relationships; poor fit for variable-depth traversals
- **gRPC** - Overkill for this use case; poor browser support; Grafema's target users are AI agents and web tools, not microservices

## High-Level Plan

### Phase 1: Schema Design (2-3 days)

Define GraphQL schema that exposes Grafema's graph model:

```graphql
type Node {
  id: ID!
  type: NodeType!
  name: String
  file: String
  line: Int
  metadata: JSON

  # Relationships
  outgoingEdges(types: [EdgeType!]): [Edge!]!
  incomingEdges(types: [EdgeType!]): [Edge!]!
  children: [Node!]!  # via CONTAINS
  parent: Node        # via incoming CONTAINS
}

type Edge {
  src: Node!
  dst: Node!
  type: EdgeType!
  metadata: JSON
}

type Query {
  # Basic lookups
  node(id: ID!): Node
  nodes(filter: NodeFilter, limit: Int, offset: Int): [Node!]!

  # Traversal
  bfs(startIds: [ID!]!, maxDepth: Int!, edgeTypes: [EdgeType!]!): [ID!]!
  reachability(from: ID!, to: ID!, edgeTypes: [EdgeType!]): Boolean!

  # Datalog passthrough
  datalog(query: String!): DatalogResult!

  # High-level queries (from MCP)
  findCalls(target: String!, className: String): [CallSite!]!
  findGuards(nodeId: ID!): [Guard!]!
  getFunctionDetails(name: String!, file: String): FunctionDetails
}

type Mutation {
  # Guarantees
  createGuarantee(input: GuaranteeInput!): Guarantee!
  checkGuarantees(names: [String!]): GuaranteeCheckResult!

  # Analysis
  analyzeProject(service: String, force: Boolean): AnalysisResult!
}
```

### Phase 2: Server Implementation (3-4 days)

1. **New Package: `packages/api`**
   - GraphQL server using Apollo Server or graphql-yoga
   - Resolvers delegate to existing `@grafema/core` functions
   - Connects to RFDB via existing `RFDBServerBackend`

2. **DataLoader Integration**
   - Batch node lookups to prevent N+1 queries
   - Edge fetching optimization

3. **Query Complexity Analysis**
   - Limit query depth (prevent `node { children { children { ... } } }` abuse)
   - Cost calculation based on traversal width/depth

### Phase 3: CLI Integration (1-2 days)

1. **`grafema server` Command Enhancement**
   - Add `--graphql` flag to enable GraphQL endpoint
   - Default port: 4000 (distinct from existing GraphAPI on 3000)

2. **`grafema query --graphql` Mode**
   - Execute GraphQL queries from CLI
   - Output as JSON or formatted

### Phase 4: Documentation & AI Integration (2 days)

1. **Schema Documentation**
   - Every type and field documented for LLM agents
   - Examples in descriptions

2. **MCP Bridge Tool**
   - New `graphql_query` MCP tool that proxies to GraphQL server
   - Enables AI agents to use GraphQL without direct HTTP

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                        │
│  (AI Agents, Web Tools, IDE Extensions, CI/CD Integrations)  │
└─────────────────────────┬───────────────────────────────────┘
                          │ GraphQL (HTTP/WS)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   packages/api (NEW)                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │   GraphQL   │  │  DataLoader  │  │ Query Complexity  │   │
│  │   Server    │  │  (batching)  │  │    Analyzer       │   │
│  └──────┬──────┘  └──────────────┘  └───────────────────┘   │
└─────────┼───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                     @grafema/core                            │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ GraphBackend │  │ Orchestrator │  │ GuaranteeManager│    │
│  └──────┬───────┘  └──────────────┘  └─────────────────┘    │
└─────────┼───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│              RFDBServerBackend (Unix Socket)                 │
└─────────────────────────┬───────────────────────────────────┘
                          │ MessagePack
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    rfdb-server (Rust)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ GraphEngine  │  │   Datalog    │  │   Persistence   │    │
│  └──────────────┘  └──────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Risks and Concerns

### 1. Query Complexity (HIGH)

**Risk:** Unbounded GraphQL queries can cause performance issues on large graphs.

**Mitigation:**
- Query depth limiting (max 10 levels)
- Query cost analysis before execution
- Timeout enforcement (10s default, configurable)
- Pagination required for collections

### 2. Datalog vs GraphQL Impedance (MEDIUM)

**Risk:** GraphQL's type system may not map perfectly to Datalog's flexibility.

**Mitigation:**
- Keep `datalog()` query as passthrough for advanced users
- GraphQL schema covers 80% use cases; Datalog for the remaining 20%
- Document when to use which

### 3. Subscription Complexity (LOW for MVP)

**Risk:** Real-time subscriptions (for analysis progress) add significant complexity.

**Mitigation:**
- MVP: No subscriptions; use polling for analysis status
- Future: WebSocket subscriptions for progress events

### 4. Authentication/Authorization (DEFERRED)

**Risk:** Public API needs access control.

**Mitigation:**
- Phase 1: Local-only (bind to localhost)
- Future: API key authentication, optional OAuth

### 5. Schema Evolution (MEDIUM)

**Risk:** Breaking changes to GraphQL schema affect clients.

**Mitigation:**
- Semantic versioning for schema
- Deprecation warnings before removal
- Schema changelog in docs

## Alignment with Project Vision

This proposal directly supports Grafema's core thesis: **"AI should query the graph, not read code."**

- GraphQL's introspection lets AI agents discover available queries programmatically
- Self-documenting schema reduces the need for separate documentation
- Flexible queries let AI agents request exactly what they need
- Standard protocol enables integration with any tool that speaks HTTP/GraphQL

The API becomes the primary interface for external tools to understand codebases through Grafema's graph - exactly what the vision calls for.

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Schema Design | 2-3 days | None |
| Server Implementation | 3-4 days | Schema Design |
| CLI Integration | 1-2 days | Server Implementation |
| Documentation | 2 days | Parallel with Phase 3 |
| **Total** | **8-11 days** | |

## Critical Files for Implementation

- `packages/core/src/api/GraphAPI.ts` - Existing REST API to potentially extend or replace
- `packages/mcp/src/handlers.ts` - Query handlers to reuse as GraphQL resolvers
- `packages/core/src/core/GraphBackend.ts` - Abstract backend interface for data access
- `packages/rfdb-server/src/datalog/types.rs` - Datalog type system for query passthrough design
- `packages/types/src/index.ts` - Type definitions for schema alignment
