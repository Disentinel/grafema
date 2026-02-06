/**
 * GraphQL API Server using graphql-yoga
 *
 * Provides a GraphQL endpoint on top of Grafema's graph database.
 * Supports cursor-based pagination and query complexity limiting.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { createYoga, createSchema } from 'graphql-yoga';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvers } from './resolvers/index.js';
import { createContext } from './context.js';
import type { RFDBServerBackend } from '@grafema/core';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load schema files
function loadTypeDefs(): string {
  const schemaDir = join(__dirname, 'schema');
  const files = [
    'scalars.graphql',
    'enums.graphql',
    'types.graphql',
    'queries.graphql',
    'mutations.graphql',
    'subscriptions.graphql',
  ];

  return files
    .map((file) => {
      try {
        return readFileSync(join(schemaDir, file), 'utf-8');
      } catch {
        // File might not exist in dist yet, try src
        const srcPath = join(__dirname, '..', 'src', 'schema', file);
        return readFileSync(srcPath, 'utf-8');
      }
    })
    .join('\n');
}

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

export function createGraphQLServer(options: GraphQLServerOptions) {
  const { backend } = options;

  const typeDefs = loadTypeDefs();

  const schema = createSchema({
    typeDefs,
    resolvers,
  });

  const yoga = createYoga({
    schema,
    context: ({ request }) => {
      // Create a minimal request object for context
      const req = {
        headers: Object.fromEntries(request.headers.entries()),
      } as IncomingMessage;
      return createContext(backend, req);
    },
    graphiql: {
      title: 'Grafema GraphQL API',
      defaultQuery: `# Welcome to Grafema GraphQL API
#
# Example queries:
#
# Get all functions:
# query { nodes(filter: {type: "FUNCTION"}, first: 10) {
#   edges { node { id name file line } }
#   pageInfo { hasNextPage endCursor }
#   totalCount
# }}
#
# Find a specific node:
# query { node(id: "your-node-id") { id name type file } }
#
# Execute Datalog:
# query { datalog(query: "violation(X) :- node(X, \\"FUNCTION\\").") {
#   count
#   results { node { name } }
# }}

query Stats {
  stats {
    nodeCount
    edgeCount
    nodesByType
  }
}
`,
    },
    // Subscriptions enabled for streaming
    // (graphql-yoga uses SSE by default)
  });

  return yoga;
}

/**
 * Start a standalone GraphQL server.
 *
 * @param options Server options
 * @returns HTTP server instance
 */
export function startServer(
  options: GraphQLServerOptions
): ReturnType<typeof createServer> {
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
