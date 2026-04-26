# Joel Spolsky: REG-36 Technical Specification

## Overview

This document expands Don Melton's high-level plan into a detailed technical specification for implementing a GraphQL API layer on top of Grafema's existing infrastructure. The GraphQL API will serve as the primary public interface for external clients (AI agents, web tools, IDE extensions) to query the code graph.

**Key Technical Decisions:**
1. **graphql-yoga over Apollo Server** - Lighter weight, better ESM support, excellent TypeScript integration, and built-in subscriptions support for future use
2. **DataLoader for N+1 prevention** - Standard batching pattern that integrates well with our async backend
3. **Separate package** - New `packages/api` package keeps concerns isolated and allows independent versioning
4. **Delegate to existing handlers** - Reuse MCP handlers where possible, avoiding code duplication
5. **Cursor-based pagination as default** - Stable, efficient, GraphQL standard; with streaming for UI

## Pagination & Streaming Strategy

### Decision Matrix

| Approach | Use Case | Complexity | Stability | Performance |
|----------|----------|------------|-----------|-------------|
| **Cursor-based** | Default for all collections | Medium | High (stable under mutations) | O(1) seek |
| **LIMIT/OFFSET** | Simple debugging, small datasets | Low | Low (shifts under mutations) | O(n) skip |
| **Streaming (SSE)** | UI visualization, large traversals | High | High | Memory-efficient |

### Default: Cursor-based Pagination

All collection queries use cursor-based pagination following [Relay Connection spec](https://relay.dev/graphql/connections.htm):

```graphql
type NodeConnection {
  edges: [NodeEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type NodeEdge {
  node: Node!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Query {
  nodes(
    filter: NodeFilter
    first: Int          # Forward pagination
    after: String       # Cursor
    last: Int           # Backward pagination (optional)
    before: String      # Cursor
  ): NodeConnection!
}
```

**Cursor encoding**: Base64-encoded node ID or composite key (e.g., `base64("id:fn:auth.ts:login:42")`).

**Why cursor-based:**
- Stable results even when graph mutates during pagination
- O(1) seek performance in RFDB (direct node lookup by ID)
- Industry standard for GraphQL APIs
- Natural fit for graph data (node IDs are natural cursors)

### Streaming for UI (Subscriptions + SSE)

For GUI visualization and large traversals, support streaming via GraphQL Subscriptions:

```graphql
type Subscription {
  """Stream nodes matching filter as they're found"""
  nodesStream(filter: NodeFilter, batchSize: Int): NodeBatch!

  """Stream BFS traversal results level by level"""
  bfsStream(startIds: [ID!]!, maxDepth: Int!, edgeTypes: [EdgeType!]!): TraversalBatch!

  """Stream analysis progress"""
  analysisProgress(service: String): AnalysisEvent!
}

type NodeBatch {
  nodes: [Node!]!
  progress: Float!      # 0.0 - 1.0
  done: Boolean!
}

type TraversalBatch {
  depth: Int!
  nodeIds: [ID!]!
  done: Boolean!
}

type AnalysisEvent {
  phase: String!
  message: String!
  progress: Float!
  servicesCompleted: Int!
  servicesTotal: Int!
}
```

**Implementation**: graphql-yoga has built-in SSE support for subscriptions. For WebSocket, add `graphql-ws` package.

### Fallback: LIMIT/OFFSET (Debug Mode)

For debugging and CLI usage, support simple offset pagination:

```graphql
type Query {
  # Debug/CLI mode - not recommended for production
  nodesSimple(
    filter: NodeFilter
    limit: Int = 50      # max 250
    offset: Int = 0
  ): [Node!]!
}
```

**Warning in docs**: LIMIT/OFFSET is O(n) and unstable under concurrent mutations. Use cursor-based for production.

### RFDB Backend Requirements

Current RFDB protocol needs extension for efficient cursor-based pagination:

1. **`GetNodesAfter(cursor, limit, filter)`** - Fetch nodes after cursor
2. **`GetNodesBefore(cursor, limit, filter)`** - Fetch nodes before cursor (for backward pagination)
3. **`CountNodes(filter)`** - Total count for `totalCount` field

If not immediately available, implement client-side:
- Use `getAllNodes()` with in-memory cursor tracking
- Cache total counts per filter
- Document as "Phase 2 optimization" for RFDB protocol

## Package Structure

```
packages/api/
├── package.json              # Dependencies: graphql, graphql-yoga, dataloader
├── tsconfig.json
├── src/
│   ├── index.ts              # Main entry point, exports server
│   ├── server.ts             # GraphQL server setup with yoga
│   ├── schema/
│   │   ├── index.ts          # Combined schema
│   │   ├── types.graphql     # Type definitions in SDL
│   │   ├── queries.graphql   # Query definitions
│   │   ├── mutations.graphql # Mutation definitions
│   │   └── enums.graphql     # Enum definitions
│   ├── resolvers/
│   │   ├── index.ts          # Resolver map
│   │   ├── node.ts           # Node resolvers
│   │   ├── edge.ts           # Edge resolvers
│   │   ├── query.ts          # Query resolvers
│   │   ├── mutation.ts       # Mutation resolvers
│   │   └── scalars.ts        # Custom scalar resolvers (JSON, BigInt)
│   ├── dataloaders/
│   │   ├── index.ts          # DataLoader factory
│   │   ├── nodeLoader.ts     # Batch node loading
│   │   └── edgeLoader.ts     # Batch edge loading
│   ├── context.ts            # GraphQL context type with backend, loaders
│   ├── complexity.ts         # Query complexity analyzer
│   └── utils.ts              # Shared utilities
└── test/
    ├── schema.test.ts        # Schema validation tests
    ├── resolvers.test.ts     # Resolver unit tests
    └── integration.test.ts   # End-to-end query tests
```

**Dependencies (package.json):**
```json
{
  "name": "@grafema/api",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@grafema/core": "workspace:*",
    "@grafema/types": "workspace:*",
    "graphql": "^16.8.0",
    "graphql-yoga": "^5.1.0",
    "dataloader": "^2.2.2",
    "graphql-scalars": "^1.22.0"
  },
  "devDependencies": {
    "@types/node": "^25.0.8",
    "typescript": "^5.9.3"
  }
}
```

## Phase 1: Schema Design (2-3 days)

### 1.1 Type Definitions

**File: `src/schema/types.graphql`**

```graphql
"""
A node in the code graph representing a code entity.
"""
type Node {
  """Unique identifier for the node (e.g., "fn:src/api.ts:login:42")"""
  id: ID!

  """Node type (e.g., FUNCTION, CLASS, MODULE, http:route)"""
  type: NodeType!

  """Human-readable name"""
  name: String!

  """Source file path (relative to project root)"""
  file: String

  """Line number in source file (1-indexed)"""
  line: Int

  """Column number in source file (1-indexed)"""
  column: Int

  """Whether this entity is exported from its module"""
  exported: Boolean

  """Arbitrary metadata as JSON object"""
  metadata: JSON

  # Relationship fields

  """
  Outgoing edges from this node.
  Optional filter by edge types.
  """
  outgoingEdges(types: [EdgeType!], limit: Int, offset: Int): EdgeConnection!

  """
  Incoming edges to this node.
  Optional filter by edge types.
  """
  incomingEdges(types: [EdgeType!], limit: Int, offset: Int): EdgeConnection!

  """
  Child nodes (via CONTAINS edges).
  For hierarchical traversal: SERVICE -> MODULE -> FUNCTION -> SCOPE
  """
  children(limit: Int, offset: Int): NodeConnection!

  """
  Parent node (via incoming CONTAINS edge).
  Returns null for root nodes (SERVICE, PROJECT).
  """
  parent: Node
}

"""
An edge in the code graph representing a relationship between nodes.
"""
type Edge {
  """Source node"""
  src: Node!

  """Destination node"""
  dst: Node!

  """Edge type (e.g., CALLS, CONTAINS, IMPORTS)"""
  type: EdgeType!

  """Ordering index for ordered relationships"""
  index: Int

  """Arbitrary metadata as JSON object"""
  metadata: JSON
}

"""
Connection type for paginated node results (Relay spec).
"""
type NodeConnection {
  """Edges containing nodes and cursors"""
  edges: [NodeEdge!]!

  """Pagination info"""
  pageInfo: PageInfo!

  """Total count of matching nodes"""
  totalCount: Int!
}

"""
Edge wrapper for cursor-based pagination.
"""
type NodeEdge {
  """The node"""
  node: Node!

  """Cursor for this node (use with after/before args)"""
  cursor: String!
}

"""
Connection type for paginated graph edge results.
"""
type GraphEdgeConnection {
  """Edges containing graph edges and cursors"""
  edges: [GraphEdgeEdge!]!

  """Pagination info"""
  pageInfo: PageInfo!

  """Total count of matching edges"""
  totalCount: Int!
}

"""
Edge wrapper for graph edges.
"""
type GraphEdgeEdge {
  """The graph edge"""
  node: Edge!

  """Cursor for this edge"""
  cursor: String!
}

"""
Pagination info (Relay spec).
"""
type PageInfo {
  """Has more items after endCursor"""
  hasNextPage: Boolean!

  """Has more items before startCursor"""
  hasPreviousPage: Boolean!

  """Cursor of first item in current page"""
  startCursor: String

  """Cursor of last item in current page"""
  endCursor: String
}

"""
Result of a Datalog query.
"""
type DatalogResult {
  """Whether the query executed successfully"""
  success: Boolean!

  """Number of results"""
  count: Int!

  """Query results with variable bindings"""
  results: [DatalogBinding!]!

  """Error message if query failed"""
  error: String
}

"""
Variable bindings from a Datalog query result.
"""
type DatalogBinding {
  """Map of variable names to values"""
  bindings: JSON!

  """Enriched node data if X binding is a node ID"""
  node: Node
}

"""
Function details including call graph information.
"""
type FunctionDetails {
  """The function node"""
  function: Node!

  """Functions/methods this function calls"""
  calls: [CallInfo!]!

  """Functions that call this function"""
  calledBy: [CallerInfo!]!
}

"""
Information about a call made by a function.
"""
type CallInfo {
  """The CALL node"""
  call: Node!

  """Name of the called function/method"""
  name: String!

  """Object name for method calls (e.g., "console" in console.log)"""
  object: String

  """Whether the target was resolved"""
  resolved: Boolean!

  """Target function if resolved"""
  target: Node

  """Call type: CALL or METHOD_CALL"""
  callType: String!

  """Depth in transitive call chain (0 = direct)"""
  depth: Int!
}

"""
Information about a function that calls another function.
"""
type CallerInfo {
  """The calling function"""
  function: Node!

  """File containing the caller"""
  file: String!

  """Line number of the call"""
  line: Int!
}

"""
Guard (conditional scope) protecting a node.
"""
type GuardInfo {
  """The SCOPE node ID"""
  scopeId: ID!

  """Type of conditional (if_statement, else_statement, etc.)"""
  scopeType: String!

  """Raw condition text"""
  condition: String

  """Parsed constraints as JSON"""
  constraints: JSON

  """Source file"""
  file: String!

  """Line number"""
  line: Int!
}

"""
Guarantee definition.
"""
type Guarantee {
  """Unique identifier"""
  id: ID!

  """Human-readable name"""
  name: String!

  """Datalog rule or contract condition"""
  rule: String

  """Severity level"""
  severity: String

  """Guarantee type for contract-based"""
  type: String

  """Priority level"""
  priority: String

  """Lifecycle status"""
  status: String

  """Description"""
  description: String
}

"""
Result of checking guarantees.
"""
type GuaranteeCheckResult {
  """Total guarantees checked"""
  total: Int!

  """Number that passed"""
  passed: Int!

  """Number that failed"""
  failed: Int!

  """Individual results"""
  results: [GuaranteeResult!]!
}

"""
Result of checking a single guarantee.
"""
type GuaranteeResult {
  """Guarantee ID"""
  guaranteeId: ID!

  """Whether the guarantee passed"""
  passed: Boolean!

  """Number of violations (for Datalog guarantees)"""
  violationCount: Int

  """Sample violations"""
  violations: [Violation!]
}

"""
A violation of a guarantee.
"""
type Violation {
  """Node that violated the guarantee"""
  node: Node

  """File containing the violation"""
  file: String

  """Line number"""
  line: Int
}

"""
Graph statistics.
"""
type GraphStats {
  """Total node count"""
  nodeCount: Int!

  """Total edge count"""
  edgeCount: Int!

  """Nodes grouped by type"""
  nodesByType: JSON!

  """Edges grouped by type"""
  edgesByType: JSON!
}

"""
Analysis status.
"""
type AnalysisStatus {
  """Whether analysis is currently running"""
  running: Boolean!

  """Current phase"""
  phase: String

  """Status message"""
  message: String

  """Number of services discovered"""
  servicesDiscovered: Int!

  """Number of services analyzed"""
  servicesAnalyzed: Int!

  """Error message if analysis failed"""
  error: String
}

"""
Result of analyze mutation.
"""
type AnalysisResult {
  """Whether analysis succeeded"""
  success: Boolean!

  """Status after analysis"""
  status: AnalysisStatus!
}
```

**File: `src/schema/enums.graphql`**

```graphql
"""
Node types in the code graph.
"""
enum NodeType {
  # Core code entities
  FUNCTION
  CLASS
  METHOD
  VARIABLE
  PARAMETER
  CONSTANT
  LITERAL
  EXPRESSION

  # Module system
  MODULE
  IMPORT
  EXPORT

  # Call graph
  CALL

  # Project structure
  PROJECT
  SERVICE
  FILE
  SCOPE

  # Branching
  BRANCH
  CASE

  # Control flow
  LOOP
  TRY_BLOCK
  CATCH_BLOCK
  FINALLY_BLOCK

  # External
  EXTERNAL
  EXTERNAL_MODULE

  # Side effects
  SIDE_EFFECT

  # HTTP (namespaced types represented as strings)
  # Use string filter for: http:route, http:request, express:middleware, etc.
}

"""
Edge types in the code graph.
"""
enum EdgeType {
  # Structure
  CONTAINS
  DEPENDS_ON
  HAS_SCOPE

  # Branching
  HAS_CONDITION
  HAS_CASE
  HAS_DEFAULT
  HAS_CONSEQUENT
  HAS_ALTERNATE

  # Loop edges
  HAS_BODY
  ITERATES_OVER
  HAS_INIT
  HAS_UPDATE

  # Try/catch
  HAS_CATCH
  HAS_FINALLY

  # Calls
  CALLS
  HAS_CALLBACK
  PASSES_ARGUMENT
  RECEIVES_ARGUMENT
  RETURNS
  YIELDS
  DELEGATES_TO

  # Inheritance
  EXTENDS
  IMPLEMENTS
  INSTANCE_OF

  # Imports/Exports
  IMPORTS
  EXPORTS
  IMPORTS_FROM
  EXPORTS_TO

  # Data flow
  DEFINES
  USES
  DECLARES
  MODIFIES
  CAPTURES
  ASSIGNED_FROM
  READS_FROM
  WRITES_TO
  DERIVES_FROM
  FLOWS_INTO

  # Object structure
  HAS_PROPERTY
  HAS_ELEMENT

  # HTTP/Routing
  ROUTES_TO
  HANDLED_BY
  MAKES_REQUEST
  MOUNTS
  EXPOSES
  RESPONDS_WITH

  # Events
  LISTENS_TO
  EMITS_EVENT
  JOINS_ROOM

  # External
  CALLS_API
  INTERACTS_WITH
  HTTP_RECEIVES

  # Guarantees
  GOVERNS
  VIOLATES
  AFFECTS

  # Errors
  THROWS

  # Unknown
  UNKNOWN
}

"""
Direction for graph traversal.
"""
enum TraversalDirection {
  FORWARD
  BACKWARD
  BOTH
}

"""
Severity levels for guarantees.
"""
enum Severity {
  ERROR
  WARNING
  INFO
}

"""
Priority levels for contract guarantees.
"""
enum Priority {
  CRITICAL
  IMPORTANT
  OBSERVED
  TRACKED
}
```

### 1.2 Query Definitions

**File: `src/schema/queries.graphql`**

```graphql
type Query {
  # === Node Lookups ===

  """
  Get a single node by ID.
  Returns null if not found.
  """
  node(id: ID!): Node

  """
  Find nodes matching filter criteria.
  All filters are ANDed together.
  """
  nodes(
    """Filter by node type"""
    type: String

    """Filter by name (exact match)"""
    name: String

    """Filter by file path (partial match)"""
    file: String

    """Filter by exported status"""
    exported: Boolean

    """Maximum results to return (default: 50, max: 250)"""
    limit: Int

    """Number of results to skip"""
    offset: Int
  ): NodeConnection!

  # === Graph Traversal ===

  """
  BFS traversal from starting nodes.
  Returns all node IDs reachable within maxDepth.

  Complexity: O(V + E) where V = reachable nodes, E = traversed edges
  """
  bfs(
    """Starting node IDs"""
    startIds: [ID!]!

    """Maximum traversal depth"""
    maxDepth: Int!

    """Edge types to traverse (empty = all)"""
    edgeTypes: [EdgeType!]!
  ): [ID!]!

  """
  DFS traversal from starting nodes.
  Returns all node IDs reachable within maxDepth.

  Complexity: O(V + E) where V = reachable nodes, E = traversed edges
  """
  dfs(
    """Starting node IDs"""
    startIds: [ID!]!

    """Maximum traversal depth"""
    maxDepth: Int!

    """Edge types to traverse (empty = all)"""
    edgeTypes: [EdgeType!]
  ): [ID!]!

  """
  Check if a path exists between two nodes.
  Uses BFS internally with early termination.

  Complexity: O(V + E) worst case, often much faster with early termination
  """
  reachability(
    """Source node ID"""
    from: ID!

    """Target node ID"""
    to: ID!

    """Edge types to traverse (null = all)"""
    edgeTypes: [EdgeType!]

    """Maximum depth to search (default: 10)"""
    maxDepth: Int
  ): Boolean!

  # === Datalog Queries ===

  """
  Execute a Datalog query on the code graph.

  The query must define a violation/1 predicate.

  Available predicates:
  - node(Id, Type) - match nodes by type
  - edge(Src, Dst, Type) - match edges
  - attr(Id, Name, Value) - match node attributes

  Example: violation(X) :- node(X, "FUNCTION"), attr(X, "async", true).
  """
  datalog(
    """Datalog query defining violation/1"""
    query: String!

    """Maximum results (default: 50)"""
    limit: Int

    """Results to skip"""
    offset: Int
  ): DatalogResult!

  # === High-Level Queries (from MCP) ===

  """
  Find all calls to a function/method.
  Reuses find_calls MCP handler logic.
  """
  findCalls(
    """Function or method name"""
    target: String!

    """Optional class name for method calls"""
    className: String

    """Maximum results"""
    limit: Int

    """Results to skip"""
    offset: Int
  ): [CallInfo!]!

  """
  Get comprehensive function details.
  Reuses get_function_details MCP handler logic.
  """
  getFunctionDetails(
    """Function name"""
    name: String!

    """File path for disambiguation"""
    file: String

    """Follow transitive call chains"""
    transitive: Boolean
  ): FunctionDetails

  """
  Find guards (conditional scopes) protecting a node.
  """
  findGuards(
    """Node ID to find guards for"""
    nodeId: ID!
  ): [GuardInfo!]!

  """
  Trace variable alias chain to original source.
  """
  traceAlias(
    """Variable name"""
    variableName: String!

    """File where variable is defined"""
    file: String!

    """Maximum trace depth (default: 20)"""
    maxDepth: Int
  ): [Node!]!

  """
  Trace data flow from/to a node.
  """
  traceDataFlow(
    """Source node ID or variable name"""
    source: String!

    """File path"""
    file: String

    """Direction of trace"""
    direction: TraversalDirection

    """Maximum depth (default: 10)"""
    maxDepth: Int
  ): [[String!]!]!

  # === Guarantees ===

  """
  List all defined guarantees.
  """
  guarantees: [Guarantee!]!

  """
  Get a specific guarantee by ID.
  """
  guarantee(id: ID!): Guarantee

  # === Statistics ===

  """
  Get graph statistics.
  """
  stats: GraphStats!

  """
  Get current analysis status.
  """
  analysisStatus: AnalysisStatus!
}
```

### 1.3 Mutation Definitions

**File: `src/schema/mutations.graphql`**

```graphql
type Mutation {
  # === Analysis ===

  """
  Run project analysis.
  Blocks until complete (with timeout).
  """
  analyzeProject(
    """Optional: analyze only this service"""
    service: String

    """Force re-analysis even if already analyzed"""
    force: Boolean
  ): AnalysisResult!

  # === Guarantees ===

  """
  Create a new guarantee.

  For Datalog-based: provide name + rule
  For contract-based: provide name + type + priority
  """
  createGuarantee(input: CreateGuaranteeInput!): Guarantee!

  """
  Delete a guarantee by name.
  """
  deleteGuarantee(name: String!): Boolean!

  """
  Check all guarantees or specific ones.
  """
  checkGuarantees(
    """Specific guarantee names to check (null = all)"""
    names: [String!]
  ): GuaranteeCheckResult!

  """
  Check a single ad-hoc invariant without persisting.
  """
  checkInvariant(
    """Datalog rule"""
    rule: String!

    """Description for error messages"""
    description: String
  ): GuaranteeResult!
}

input CreateGuaranteeInput {
  """Unique name"""
  name: String!

  # Datalog-based fields
  """Datalog rule defining violation/1"""
  rule: String

  """Severity: error, warning, info"""
  severity: Severity

  # Contract-based fields
  """Type: guarantee:queue, guarantee:api, guarantee:permission"""
  type: String

  """Priority: critical, important, observed, tracked"""
  priority: Priority

  """Description"""
  description: String

  """Owner (team or person)"""
  owner: String

  """Node IDs this guarantee governs"""
  governs: [String!]
}
```

## Phase 2: Server Implementation (3-4 days)

### 2.1 Server Setup

**File: `src/server.ts`**

```typescript
/**
 * GraphQL API Server using graphql-yoga
 *
 * Provides a GraphQL endpoint on top of Grafema's graph database.
 * Delegates to existing MCP handlers for complex queries.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createYoga, createSchema, YogaServerInstance } from 'graphql-yoga';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { resolvers } from './resolvers/index.js';
import { createContext, GraphQLContext } from './context.js';
import { complexityPlugin } from './complexity.js';
import type { RFDBServerBackend } from '@grafema/core';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load schema files
const typeDefs = [
  readFileSync(join(__dirname, 'schema/types.graphql'), 'utf-8'),
  readFileSync(join(__dirname, 'schema/enums.graphql'), 'utf-8'),
  readFileSync(join(__dirname, 'schema/queries.graphql'), 'utf-8'),
  readFileSync(join(__dirname, 'schema/mutations.graphql'), 'utf-8'),
].join('\n');

export interface GraphQLServerOptions {
  /** Graph backend (RFDBServerBackend) */
  backend: RFDBServerBackend;
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Hostname to bind to (default: localhost) */
  hostname?: string;
  /** Maximum query depth (default: 10) */
  maxDepth?: number;
  /** Maximum query complexity cost (default: 1000) */
  maxComplexity?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

export function createGraphQLServer(options: GraphQLServerOptions): YogaServerInstance<
  { req: IncomingMessage; res: ServerResponse },
  GraphQLContext
> {
  const { backend, maxDepth = 10, maxComplexity = 1000, timeout = 30000 } = options;

  const schema = createSchema({
    typeDefs,
    resolvers,
  });

  const yoga = createYoga({
    schema,
    context: ({ req }) => createContext(backend, req),
    graphiql: {
      title: 'Grafema GraphQL API',
      defaultQuery: `# Welcome to Grafema GraphQL API
#
# Example queries:
#
# Get all functions:
# query { nodes(type: "FUNCTION", limit: 10) { nodes { id name file line } } }
#
# Find function calls:
# query { findCalls(target: "login") { name resolved target { name file } } }
#
# Execute Datalog:
# query { datalog(query: "violation(X) :- node(X, \\"FUNCTION\\").") { count results { node { name } } } }

query Stats {
  stats {
    nodeCount
    edgeCount
    nodesByType
  }
}
`,
    },
    plugins: [
      // Query complexity limiting
      complexityPlugin({ maxDepth, maxComplexity }),
    ],
    // Timeout handling
    fetchAPI: {
      // Custom timeout wrapper handled in context
    },
  });

  return yoga;
}

/**
 * Start a standalone GraphQL server.
 *
 * @param options Server options
 * @returns HTTP server instance
 */
export function startServer(options: GraphQLServerOptions): ReturnType<typeof createServer> {
  const { port = 4000, hostname = 'localhost' } = options;

  const yoga = createGraphQLServer(options);

  const server = createServer((req, res) => {
    yoga(req, res);
  });

  server.listen(port, hostname, () => {
    console.log(`Grafema GraphQL API running at http://${hostname}:${port}/graphql`);
    console.log(`GraphiQL IDE available at http://${hostname}:${port}/graphql`);
  });

  return server;
}

export { createContext, type GraphQLContext } from './context.js';
```

### 2.2 Resolvers

**File: `src/resolvers/index.ts`**

```typescript
/**
 * GraphQL Resolver Map
 *
 * Combines all resolvers and adds custom scalar handlers.
 */

import { JSONResolver } from 'graphql-scalars';
import { nodeResolvers } from './node.js';
import { edgeResolvers } from './edge.js';
import { queryResolvers } from './query.js';
import { mutationResolvers } from './mutation.js';

export const resolvers = {
  // Custom scalars
  JSON: JSONResolver,

  // Type resolvers
  Node: nodeResolvers,
  Edge: edgeResolvers,

  // Root resolvers
  Query: queryResolvers,
  Mutation: mutationResolvers,
};
```

**File: `src/resolvers/node.ts`**

Key resolver with complexity analysis:

```typescript
/**
 * Node Type Resolvers
 *
 * Resolves relationship fields on Node type.
 */

import type { GraphQLContext } from '../context.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

interface NodeParent extends NodeRecord {
  // Node data from backend
}

export const nodeResolvers = {
  /**
   * Resolve outgoing edges.
   *
   * Complexity: O(k) where k = number of outgoing edges from this node
   * Uses DataLoader for batching when multiple nodes request edges.
   */
  async outgoingEdges(
    parent: NodeParent,
    args: { types?: string[]; limit?: number; offset?: number },
    context: GraphQLContext
  ) {
    const { types, limit = 50, offset = 0 } = args;
    const edges = await context.backend.getOutgoingEdges(parent.id, types || null);

    const paginatedEdges = edges.slice(offset, offset + limit);

    return {
      edges: paginatedEdges,
      totalCount: edges.length,
      hasMore: offset + limit < edges.length,
      nextCursor: offset + limit < edges.length ? String(offset + limit) : null,
    };
  },

  /**
   * Resolve incoming edges.
   *
   * Complexity: O(k) where k = number of incoming edges to this node
   */
  async incomingEdges(
    parent: NodeParent,
    args: { types?: string[]; limit?: number; offset?: number },
    context: GraphQLContext
  ) {
    const { types, limit = 50, offset = 0 } = args;
    const edges = await context.backend.getIncomingEdges(parent.id, types || null);

    const paginatedEdges = edges.slice(offset, offset + limit);

    return {
      edges: paginatedEdges,
      totalCount: edges.length,
      hasMore: offset + limit < edges.length,
      nextCursor: offset + limit < edges.length ? String(offset + limit) : null,
    };
  },

  /**
   * Resolve child nodes (via CONTAINS edges).
   *
   * Complexity: O(c) where c = number of children
   */
  async children(
    parent: NodeParent,
    args: { limit?: number; offset?: number },
    context: GraphQLContext
  ) {
    const { limit = 50, offset = 0 } = args;
    const edges = await context.backend.getOutgoingEdges(parent.id, ['CONTAINS']);

    // Use DataLoader to batch child node lookups
    const childIds = edges.slice(offset, offset + limit).map(e => e.dst);
    const children = await context.loaders.node.loadMany(childIds);

    // Filter out errors and nulls
    const validChildren = children.filter(
      (c): c is NodeRecord => c != null && !(c instanceof Error)
    );

    return {
      nodes: validChildren,
      totalCount: edges.length,
      hasMore: offset + limit < edges.length,
      nextCursor: offset + limit < edges.length ? String(offset + limit) : null,
    };
  },

  /**
   * Resolve parent node (via incoming CONTAINS edge).
   *
   * Complexity: O(1) - single lookup
   */
  async parent(parent: NodeParent, _args: unknown, context: GraphQLContext) {
    const edges = await context.backend.getIncomingEdges(parent.id, ['CONTAINS']);
    if (edges.length === 0) return null;

    return context.loaders.node.load(edges[0].src);
  },

  /**
   * Resolve metadata field.
   * Parses JSON string if needed.
   */
  metadata(parent: NodeParent) {
    if (!parent.metadata) return null;
    if (typeof parent.metadata === 'string') {
      try {
        return JSON.parse(parent.metadata);
      } catch {
        return null;
      }
    }
    return parent.metadata;
  },
};
```

**File: `src/resolvers/query.ts`**

Key query resolver:

```typescript
/**
 * Query Resolvers
 *
 * Implements all Query type fields.
 */

import type { GraphQLContext } from '../context.js';

export const queryResolvers = {
  /**
   * Get node by ID.
   *
   * Complexity: O(1)
   */
  async node(_: unknown, args: { id: string }, context: GraphQLContext) {
    return context.loaders.node.load(args.id);
  },

  /**
   * Find nodes matching criteria.
   *
   * Complexity: O(n) where n = nodes matching type filter
   * This is acceptable because:
   * - We filter by type first (uses RFDB's type index)
   * - Results are paginated
   */
  async nodes(
    _: unknown,
    args: { type?: string; name?: string; file?: string; exported?: boolean; limit?: number; offset?: number },
    context: GraphQLContext
  ) {
    const { type, name, file, exported, limit = 50, offset = 0 } = args;
    const normalizedLimit = Math.min(limit, 250);

    const filter: Record<string, unknown> = {};
    if (type) filter.type = type;
    if (name) filter.name = name;
    if (file) filter.file = file;
    if (exported !== undefined) filter.exported = exported;

    const nodes = await context.backend.getAllNodes(filter);
    const paginatedNodes = nodes.slice(offset, offset + normalizedLimit);

    return {
      nodes: paginatedNodes,
      totalCount: nodes.length,
      hasMore: offset + normalizedLimit < nodes.length,
      nextCursor: offset + normalizedLimit < nodes.length ? String(offset + normalizedLimit) : null,
    };
  },

  /**
   * BFS traversal.
   *
   * Complexity: O(V + E) for reachable subgraph
   * Bounded by maxDepth parameter.
   */
  async bfs(
    _: unknown,
    args: { startIds: string[]; maxDepth: number; edgeTypes: string[] },
    context: GraphQLContext
  ) {
    const { startIds, maxDepth, edgeTypes } = args;
    return context.backend.bfs(startIds, maxDepth, edgeTypes);
  },

  /**
   * DFS traversal.
   *
   * Complexity: O(V + E) for reachable subgraph
   */
  async dfs(
    _: unknown,
    args: { startIds: string[]; maxDepth: number; edgeTypes?: string[] },
    context: GraphQLContext
  ) {
    const { startIds, maxDepth, edgeTypes = [] } = args;
    return context.backend.dfs(startIds, maxDepth, edgeTypes);
  },

  /**
   * Reachability check.
   *
   * Complexity: O(V + E) worst case, often O(d) with early termination
   */
  async reachability(
    _: unknown,
    args: { from: string; to: string; edgeTypes?: string[]; maxDepth?: number },
    context: GraphQLContext
  ) {
    const { from, to, edgeTypes, maxDepth = 10 } = args;
    const reachable = await context.backend.reachability(
      [from],
      maxDepth,
      edgeTypes || [],
      false // forward direction
    );
    return reachable.includes(to);
  },

  /**
   * Execute Datalog query.
   *
   * Complexity: Depends on query, bounded by RFDB's timeout
   */
  async datalog(
    _: unknown,
    args: { query: string; limit?: number; offset?: number },
    context: GraphQLContext
  ) {
    const { query, limit = 50, offset = 0 } = args;

    try {
      const results = await context.backend.checkGuarantee(query);
      const total = results.length;
      const paginatedResults = results.slice(offset, offset + limit);

      // Enrich with node data
      const enrichedResults = await Promise.all(
        paginatedResults.map(async (r) => {
          const nodeId = r.bindings.find(b => b.name === 'X')?.value;
          const node = nodeId ? await context.loaders.node.load(nodeId) : null;
          return {
            bindings: Object.fromEntries(r.bindings.map(b => [b.name, b.value])),
            node,
          };
        })
      );

      return {
        success: true,
        count: total,
        results: enrichedResults,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        count: 0,
        results: [],
        error: (error as Error).message,
      };
    }
  },

  /**
   * Get graph statistics.
   *
   * Complexity: O(1) - cached in backend
   */
  async stats(_: unknown, _args: unknown, context: GraphQLContext) {
    return context.backend.getStats();
  },

  // ... other query resolvers delegating to MCP handlers
};
```

### 2.3 DataLoader Configuration

**File: `src/dataloaders/nodeLoader.ts`**

```typescript
/**
 * Node DataLoader
 *
 * Batches multiple getNode() calls into efficient bulk lookups.
 * Critical for preventing N+1 queries in GraphQL.
 */

import DataLoader from 'dataloader';
import type { NodeRecord } from '@grafema/types';
import type { RFDBServerBackend } from '@grafema/core';

/**
 * Create a DataLoader for batching node lookups.
 *
 * The loader batches all node ID requests made within a single tick
 * and resolves them with a single backend call where possible.
 *
 * Since RFDBServerBackend doesn't have a native batch getNodes(),
 * we parallelize individual calls. This still helps because:
 * 1. Reduces round-trips by parallelizing
 * 2. Caches results within the request
 *
 * Complexity: O(n) where n = unique node IDs requested
 */
export function createNodeLoader(backend: RFDBServerBackend): DataLoader<string, NodeRecord | null> {
  return new DataLoader<string, NodeRecord | null>(
    async (ids: readonly string[]) => {
      // Parallelize individual lookups
      // In future, could optimize with batch protocol command
      const results = await Promise.all(
        ids.map(id => backend.getNode(id))
      );
      return results;
    },
    {
      // Cache results within this request
      cache: true,
      // Use identity function for cache key
      cacheKeyFn: (id) => id,
      // Max batch size to prevent overwhelming backend
      maxBatchSize: 100,
    }
  );
}
```

**File: `src/dataloaders/index.ts`**

```typescript
/**
 * DataLoader Factory
 *
 * Creates all DataLoaders for a request context.
 */

import type { RFDBServerBackend } from '@grafema/core';
import { createNodeLoader } from './nodeLoader.js';

export interface DataLoaders {
  node: ReturnType<typeof createNodeLoader>;
}

/**
 * Create all DataLoaders for a request.
 * DataLoaders are per-request to prevent cross-request caching issues.
 */
export function createDataLoaders(backend: RFDBServerBackend): DataLoaders {
  return {
    node: createNodeLoader(backend),
  };
}
```

**File: `src/context.ts`**

```typescript
/**
 * GraphQL Context
 *
 * Request-scoped context containing backend and loaders.
 */

import type { IncomingMessage } from 'http';
import type { RFDBServerBackend } from '@grafema/core';
import { createDataLoaders, DataLoaders } from './dataloaders/index.js';

export interface GraphQLContext {
  /** Graph backend */
  backend: RFDBServerBackend;
  /** DataLoaders for batching */
  loaders: DataLoaders;
  /** Request start time for timeout tracking */
  startTime: number;
}

/**
 * Create context for a GraphQL request.
 * Creates fresh DataLoaders to ensure no cross-request caching.
 */
export function createContext(
  backend: RFDBServerBackend,
  _req: IncomingMessage
): GraphQLContext {
  return {
    backend,
    loaders: createDataLoaders(backend),
    startTime: Date.now(),
  };
}
```

### 2.4 Query Complexity Analyzer

**File: `src/complexity.ts`**

```typescript
/**
 * Query Complexity Plugin
 *
 * Prevents abusive queries by:
 * 1. Limiting query depth (nesting level)
 * 2. Calculating and limiting total cost
 */

import type { Plugin } from 'graphql-yoga';
import {
  GraphQLError,
  getOperationAST,
  TypeInfo,
  visit,
  visitWithTypeInfo
} from 'graphql';

interface ComplexityOptions {
  maxDepth: number;
  maxComplexity: number;
}

/**
 * Cost multipliers for different field types.
 * Based on actual backend operation costs.
 */
const FIELD_COSTS: Record<string, number> = {
  // Simple lookups: O(1)
  node: 1,
  parent: 1,
  metadata: 0,

  // Collection queries: O(n) where n bounded by limit
  nodes: 5,
  children: 3,
  outgoingEdges: 3,
  incomingEdges: 3,

  // Traversals: O(V+E) but bounded by maxDepth
  bfs: 10,
  dfs: 10,
  reachability: 8,

  // Complex queries
  datalog: 20,
  findCalls: 10,
  getFunctionDetails: 15,
  traceAlias: 10,
  traceDataFlow: 15,

  // Stats: O(1) cached
  stats: 1,
  analysisStatus: 1,
};

export function complexityPlugin(options: ComplexityOptions): Plugin {
  return {
    onValidate({ context, addError }) {
      const { maxDepth, maxComplexity } = options;
      const document = context.document;
      const schema = context.schema;

      if (!schema) return;

      const typeInfo = new TypeInfo(schema);
      let depth = 0;
      let maxReachedDepth = 0;
      let complexity = 0;

      visit(
        document,
        visitWithTypeInfo(typeInfo, {
          Field: {
            enter(node) {
              depth++;
              maxReachedDepth = Math.max(maxReachedDepth, depth);

              // Add field cost
              const fieldName = node.name.value;
              const cost = FIELD_COSTS[fieldName] ?? 1;

              // Multiply by limit argument if present
              const limitArg = node.arguments?.find(a => a.name.value === 'limit');
              const limitValue = limitArg?.value?.kind === 'IntValue'
                ? parseInt(limitArg.value.value, 10)
                : 50; // default

              // Collection fields scale with limit
              if (['nodes', 'children', 'outgoingEdges', 'incomingEdges'].includes(fieldName)) {
                complexity += cost * Math.min(limitValue, 50) / 10;
              } else {
                complexity += cost;
              }
            },
            leave() {
              depth--;
            },
          },
        })
      );

      if (maxReachedDepth > maxDepth) {
        addError(
          new GraphQLError(
            `Query depth ${maxReachedDepth} exceeds maximum allowed depth of ${maxDepth}`,
            { extensions: { code: 'QUERY_TOO_DEEP' } }
          )
        );
      }

      if (complexity > maxComplexity) {
        addError(
          new GraphQLError(
            `Query complexity ${complexity.toFixed(1)} exceeds maximum allowed complexity of ${maxComplexity}`,
            { extensions: { code: 'QUERY_TOO_COMPLEX' } }
          )
        );
      }
    },
  };
}
```

## Phase 3: CLI Integration (1-2 days)

**File: `packages/cli/src/commands/server.ts` (additions)**

Add GraphQL subcommand to existing server command:

```typescript
// Add to existing serverCommand

// grafema server graphql (new subcommand)
serverCommand
  .command('graphql')
  .description('Start GraphQL API server')
  .option('-p, --project <path>', 'Project path', '.')
  .option('--port <number>', 'Port to listen on', '4000')
  .option('--host <string>', 'Hostname to bind to', 'localhost')
  .action(async (options: { project: string; port: string; host: string }) => {
    const projectPath = resolve(options.project);
    const { socketPath } = getProjectPaths(projectPath);

    // Check if RFDB server is running
    const status = await isServerRunning(socketPath);
    if (!status.running) {
      exitWithError('RFDB server not running', [
        'Start the server first: grafema server start',
        'Or run: grafema analyze (starts server automatically)'
      ]);
    }

    // Create backend connection
    const { RFDBServerBackend } = await import('@grafema/core');
    const backend = new RFDBServerBackend({ socketPath });
    await backend.connect();

    // Start GraphQL server
    const { startServer } = await import('@grafema/api');
    const port = parseInt(options.port, 10);

    console.log('Starting Grafema GraphQL API...');
    startServer({
      backend,
      port,
      hostname: options.host,
    });

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down GraphQL server...');
      await backend.close();
      process.exit(0);
    });
  });
```

**New CLI command: `grafema query --graphql`**

Add GraphQL query mode to existing query command:

```typescript
// In packages/cli/src/commands/query.ts

queryCommand
  .option('--graphql', 'Execute as GraphQL query')
  .option('--graphql-url <url>', 'GraphQL endpoint URL', 'http://localhost:4000/graphql')
  .action(async (queryArg: string, options) => {
    if (options.graphql) {
      // Execute GraphQL query
      const response = await fetch(options.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryArg }),
      });

      const result = await response.json();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Pretty print result
        if (result.errors) {
          console.error('GraphQL Errors:');
          for (const err of result.errors) {
            console.error(`  - ${err.message}`);
          }
        }
        if (result.data) {
          console.log(JSON.stringify(result.data, null, 2));
        }
      }
      return;
    }

    // Existing query handling...
  });
```

## Phase 4: Documentation (2 days)

### 4.1 Schema Documentation

All GraphQL types should have descriptions in the SDL (already included above).

### 4.2 API Documentation

Create `_readme/graphql-api.md`:

```markdown
# Grafema GraphQL API

## Overview

The GraphQL API provides programmatic access to Grafema's code graph. It's designed for:
- AI agents that need structured queries
- IDE extensions
- CI/CD integrations
- Custom tooling

## Getting Started

1. Start the RFDB server: `grafema server start`
2. Run analysis: `grafema analyze`
3. Start GraphQL server: `grafema server graphql`
4. Open GraphiQL: http://localhost:4000/graphql

## Example Queries

### Get all functions in a file
\`\`\`graphql
query FunctionsInFile {
  nodes(type: "FUNCTION", file: "src/api.ts") {
    nodes {
      id
      name
      line
      exported
    }
  }
}
\`\`\`

### Trace function calls
\`\`\`graphql
query FunctionCalls {
  getFunctionDetails(name: "login", transitive: true) {
    function { name file }
    calls {
      name
      resolved
      target { name file }
      depth
    }
  }
}
\`\`\`

### Execute Datalog query
\`\`\`graphql
query FindUnresolvedCalls {
  datalog(query: "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\").") {
    count
    results {
      node { name file line }
    }
  }
}
\`\`\`

## Query Limits

- Maximum depth: 10 levels
- Maximum complexity: 1000 points
- Default page size: 50 items
- Maximum page size: 250 items
- Request timeout: 30 seconds
```

### 4.3 MCP Bridge Tool (Optional Enhancement)

Add `graphql_query` tool to MCP:

```typescript
// In packages/mcp/src/definitions.ts
{
  name: 'graphql_query',
  description: `Execute a GraphQL query against the Grafema API.

Useful when you need more control over the query structure than
individual tools provide. Supports all GraphQL features including
fragments and variables.

The GraphQL server must be running (grafema server graphql).`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'GraphQL query string',
      },
      variables: {
        type: 'object',
        description: 'Query variables',
      },
      endpoint: {
        type: 'string',
        description: 'GraphQL endpoint (default: http://localhost:4000/graphql)',
      },
    },
    required: ['query'],
  },
}
```

## Test Plan

### Unit Tests

**Schema Validation (`test/schema.test.ts`):**
- Schema parses without errors
- All types have descriptions
- All required fields are non-nullable
- Enum values match `@grafema/types` constants

**Resolver Tests (`test/resolvers.test.ts`):**
- `node()` returns correct node or null
- `nodes()` respects filters and pagination
- `bfs()` and `dfs()` return correct traversal results
- `datalog()` handles valid/invalid queries
- Node relationship resolvers (children, parent, edges) work correctly
- DataLoader batches requests correctly

**Complexity Tests (`test/complexity.test.ts`):**
- Queries within limits execute successfully
- Deep queries are rejected with helpful error
- Complex queries are rejected with cost breakdown

### Integration Tests (`test/integration.test.ts`)

- Full server startup/shutdown cycle
- End-to-end query execution
- Error handling for invalid queries
- Pagination works across queries
- Context cleanup between requests

### Test Fixtures

Create test backend with known graph:
```typescript
// test/fixtures/testGraph.ts
export async function createTestGraph(backend: RFDBServerBackend) {
  await backend.addNodes([
    { id: 'fn1', type: 'FUNCTION', name: 'login', file: 'auth.ts', line: 10 },
    { id: 'fn2', type: 'FUNCTION', name: 'hash', file: 'crypto.ts', line: 5 },
    { id: 'call1', type: 'CALL', name: 'hash', file: 'auth.ts', line: 15 },
  ]);
  await backend.addEdges([
    { src: 'fn1', dst: 'call1', type: 'CONTAINS' },
    { src: 'call1', dst: 'fn2', type: 'CALLS' },
  ]);
}
```

## Implementation Order

### Day 1-2: Schema Design
1. Create `packages/api/` package structure
2. Write all `.graphql` schema files
3. Set up TypeScript config and dependencies
4. Write schema validation tests

### Day 3-4: Core Server
1. Implement `server.ts` with graphql-yoga
2. Implement `context.ts` and DataLoader factories
3. Implement basic resolvers (node, nodes, stats)
4. Write resolver unit tests

### Day 5-6: Full Resolvers
1. Implement Node relationship resolvers
2. Implement Edge resolvers
3. Implement traversal resolvers (bfs, dfs, reachability)
4. Implement Datalog resolver
5. Implement high-level query resolvers (findCalls, getFunctionDetails)

### Day 7: Complexity & Mutations
1. Implement complexity analyzer plugin
2. Implement mutation resolvers
3. Write complexity tests

### Day 8: CLI Integration
1. Add `grafema server graphql` command
2. Add `grafema query --graphql` option
3. Write CLI tests

### Day 9-10: Documentation & Polish
1. Write API documentation
2. Review and improve GraphiQL defaults
3. Integration tests
4. Performance testing with large graphs

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Query complexity abuse | Medium | High | Complexity analyzer with configurable limits |
| N+1 queries | High | Medium | DataLoader batching |
| Schema evolution | Medium | Medium | Versioning strategy, deprecation notices |
| Backend disconnection | Low | High | Connection retry logic, clear error messages |

## Critical Files for Implementation

- `packages/mcp/src/handlers.ts` - Contains MCP handler logic to reuse for GraphQL resolvers
- `packages/core/src/storage/backends/RFDBServerBackend.ts` - Backend interface that GraphQL resolvers will call
- `packages/types/src/nodes.ts` - Node type definitions for schema alignment
- `packages/cli/src/commands/server.ts` - CLI server command to extend with GraphQL
