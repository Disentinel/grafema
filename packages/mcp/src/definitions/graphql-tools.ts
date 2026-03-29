/**
 * GraphQL Tool — execute GraphQL queries on the code graph
 */

import type { ToolDefinition } from './types.js';

export const GRAPHQL_TOOLS: ToolDefinition[] = [
  {
    name: 'query_graphql',
    description: `Execute a GraphQL query on the code graph.

GraphQL provides typed, nested queries with pagination — complementary to Datalog.
Use GraphQL when you need nested data in one query (node + edges + neighbors).
Use Datalog (query_graph) for pattern matching and logical rules.

SCHEMA HIGHLIGHTS:
- node(id: ID!): Node — get a single node
- nodes(filter: {type, name, file, exported}, first, after): NodeConnection — paginated search
- bfs/dfs(startIds, maxDepth, edgeTypes): [ID!]! — graph traversal
- reachability(from, to, edgeTypes, maxDepth): Boolean — path existence
- datalog(query, limit, offset): DatalogResult — Datalog passthrough
- findCalls(target, className): [CallInfo!]! — call graph
- traceDataFlow(source, file, direction, maxDepth): [[String!]!]! — data flow
- stats: GraphStats — node/edge counts

Node fields: id, name, type, file, line, column, exported, metadata,
  outgoingEdges(types), incomingEdges(types), children, parent

EXAMPLE:
  query {
    nodes(filter: {type: "FUNCTION", file: "src/api"}, first: 5) {
      edges {
        node {
          name, file, line
          outgoingEdges(types: ["CALLS"]) {
            edges { node { dst { name, file } } }
          }
        }
      }
      totalCount
    }
  }

Use get_documentation(topic="graphql-schema") for the full schema.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'GraphQL query string',
        },
        variables: {
          type: 'object',
          description: 'Optional variables for the query (JSON object)',
        },
        operationName: {
          type: 'string',
          description: 'Optional operation name (when query contains multiple operations)',
        },
      },
      required: ['query'],
    },
  },
];
