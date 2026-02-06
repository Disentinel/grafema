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
