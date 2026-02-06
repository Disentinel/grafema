/**
 * Node Type Resolvers
 *
 * Resolves relationship fields on Node type.
 */

import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';
import type { GraphQLContext } from '../context.js';
import { paginateArray } from '../pagination.js';

export const nodeResolvers = {
  /**
   * Resolve outgoing edges with cursor-based pagination.
   *
   * Complexity: O(k) where k = number of outgoing edges from this node
   */
  async outgoingEdges(
    parent: BaseNodeRecord,
    args: { types?: string[] | null; first?: number | null; after?: string | null },
    context: GraphQLContext
  ) {
    const edges = await context.backend.getOutgoingEdges(
      parent.id,
      args.types || null
    );

    return paginateArray(
      edges,
      args.first,
      args.after,
      (e: EdgeRecord) => `${e.src}:${e.dst}:${e.type}`
    );
  },

  /**
   * Resolve incoming edges with cursor-based pagination.
   *
   * Complexity: O(k) where k = number of incoming edges to this node
   */
  async incomingEdges(
    parent: BaseNodeRecord,
    args: { types?: string[] | null; first?: number | null; after?: string | null },
    context: GraphQLContext
  ) {
    const edges = await context.backend.getIncomingEdges(
      parent.id,
      args.types || null
    );

    return paginateArray(
      edges,
      args.first,
      args.after,
      (e: EdgeRecord) => `${e.src}:${e.dst}:${e.type}`
    );
  },

  /**
   * Resolve child nodes (via CONTAINS edges) with cursor-based pagination.
   *
   * Complexity: O(c) where c = number of children
   */
  async children(
    parent: BaseNodeRecord,
    args: { first?: number | null; after?: string | null },
    context: GraphQLContext
  ) {
    const edges = await context.backend.getOutgoingEdges(parent.id, ['CONTAINS']);

    // Use DataLoader to batch child node lookups
    const childIds = edges.map((e) => e.dst);
    const children = await context.loaders.node.loadMany(childIds);

    // Filter out errors and nulls
    const validChildren = children.filter(
      (c): c is BaseNodeRecord => c != null && !(c instanceof Error)
    );

    return paginateArray(
      validChildren,
      args.first,
      args.after,
      (n: BaseNodeRecord) => n.id
    );
  },

  /**
   * Resolve parent node (via incoming CONTAINS edge).
   *
   * Complexity: O(1) - single lookup
   */
  async parent(
    parent: BaseNodeRecord,
    _args: unknown,
    context: GraphQLContext
  ) {
    const edges = await context.backend.getIncomingEdges(parent.id, ['CONTAINS']);
    if (edges.length === 0) return null;

    return context.loaders.node.load(edges[0].src);
  },

  /**
   * Resolve metadata field.
   * Parses JSON string if needed.
   */
  metadata(parent: BaseNodeRecord) {
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
