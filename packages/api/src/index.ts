/**
 * @grafema/api - GraphQL API for Grafema code graph
 *
 * Provides a GraphQL endpoint for querying the code graph.
 * Supports cursor-based pagination, subscriptions for streaming,
 * and Datalog query passthrough.
 */

export { createGraphQLServer, startServer } from './server.js';
export type { GraphQLServerOptions } from './server.js';
export type { GraphQLContext } from './context.js';
