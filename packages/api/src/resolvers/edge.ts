/**
 * Edge Type Resolvers
 *
 * Resolves fields on Edge type that require lookups.
 */

import type { EdgeRecord } from '@grafema/types';
import type { GraphQLContext } from '../context.js';

export const edgeResolvers = {
  /**
   * Resolve source node.
   */
  async src(parent: EdgeRecord, _args: unknown, context: GraphQLContext) {
    return context.loaders.node.load(parent.src);
  },

  /**
   * Resolve destination node.
   */
  async dst(parent: EdgeRecord, _args: unknown, context: GraphQLContext) {
    return context.loaders.node.load(parent.dst);
  },

  /**
   * Resolve metadata field.
   */
  metadata(parent: EdgeRecord) {
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
