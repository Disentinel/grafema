/**
 * Query Resolvers
 *
 * Implements all Query type fields.
 */

import type { BaseNodeRecord } from '@grafema/types';
import type { GraphQLContext } from '../context.js';
import { paginateArray } from '../pagination.js';

export interface NodeFilter {
  type?: string | null;
  name?: string | null;
  file?: string | null;
  exported?: boolean | null;
}

export const queryResolvers = {
  /**
   * Get node by ID.
   *
   * Complexity: O(1)
   */
  async node(
    _: unknown,
    args: { id: string },
    context: GraphQLContext
  ) {
    return context.loaders.node.load(args.id);
  },

  /**
   * Find nodes matching criteria with cursor-based pagination.
   *
   * Complexity: O(n) where n = nodes matching type filter
   * This is acceptable because:
   * - We filter by type first (uses RFDB's type index)
   * - Results are paginated
   */
  async nodes(
    _: unknown,
    args: {
      filter?: NodeFilter | null;
      first?: number | null;
      after?: string | null;
    },
    context: GraphQLContext
  ) {
    const filter = args.filter || {};

    // Build query for backend
    const query: Record<string, unknown> = {};
    if (filter.type) query.type = filter.type;
    if (filter.name) query.name = filter.name;
    if (filter.file) query.file = filter.file;

    // Get all matching nodes
    const nodes = await context.backend.getAllNodes(query);

    // Apply exported filter (not supported by backend query)
    let filteredNodes = nodes;
    if (filter.exported !== null && filter.exported !== undefined) {
      filteredNodes = nodes.filter((n) => n.exported === filter.exported);
    }

    return paginateArray(
      filteredNodes,
      args.first,
      args.after,
      (n: BaseNodeRecord) => n.id
    );
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
    return context.backend.bfs(args.startIds, args.maxDepth, args.edgeTypes);
  },

  /**
   * DFS traversal.
   *
   * Complexity: O(V + E) for reachable subgraph
   */
  async dfs(
    _: unknown,
    args: { startIds: string[]; maxDepth: number; edgeTypes?: string[] | null },
    context: GraphQLContext
  ) {
    return context.backend.dfs(
      args.startIds,
      args.maxDepth,
      args.edgeTypes || []
    );
  },

  /**
   * Reachability check.
   *
   * Complexity: O(V + E) worst case, often O(d) with early termination
   */
  async reachability(
    _: unknown,
    args: {
      from: string;
      to: string;
      edgeTypes?: string[] | null;
      maxDepth?: number | null;
    },
    context: GraphQLContext
  ) {
    const maxDepth = args.maxDepth ?? 10;
    const reachable = await context.backend.bfs(
      [args.from],
      maxDepth,
      args.edgeTypes || []
    );
    return reachable.includes(args.to);
  },

  /**
   * Execute Datalog query.
   *
   * Complexity: Depends on query, bounded by RFDB's timeout
   */
  async datalog(
    _: unknown,
    args: { query: string; limit?: number | null; offset?: number | null },
    context: GraphQLContext
  ) {
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;

    try {
      const results = await context.backend.checkGuarantee(args.query);
      const total = results.length;
      const paginatedResults = results.slice(offset, offset + limit);

      // Enrich with node data
      const enrichedResults = await Promise.all(
        paginatedResults.map(async (r) => {
          const bindings = r.bindings || [];
          const xBinding = bindings.find((b) => b.name === 'X');
          const nodeId = xBinding?.value;
          const node = nodeId
            ? await context.loaders.node.load(String(nodeId))
            : null;
          return {
            bindings: Object.fromEntries(
              bindings.map((b) => [b.name, b.value])
            ),
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

  /**
   * Get analysis status.
   * Placeholder - actual implementation depends on analysis state tracking.
   */
  async analysisStatus(_: unknown, _args: unknown, _context: GraphQLContext) {
    // Placeholder - would need to track analysis state
    return {
      running: false,
      phase: null,
      message: null,
      servicesDiscovered: 0,
      servicesAnalyzed: 0,
      error: null,
    };
  },

  /**
   * List all guarantees.
   * Placeholder - actual implementation depends on GuaranteeManager.
   */
  async guarantees(_: unknown, _args: unknown, _context: GraphQLContext) {
    // Placeholder - would need GuaranteeManager integration
    return [];
  },

  /**
   * Get guarantee by ID.
   * Placeholder.
   */
  async guarantee(
    _: unknown,
    _args: { id: string },
    _context: GraphQLContext
  ) {
    return null;
  },

  /**
   * Find calls to a function/method.
   * Placeholder - would reuse MCP handler logic.
   */
  async findCalls(
    _: unknown,
    _args: {
      target: string;
      className?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    _context: GraphQLContext
  ) {
    // Placeholder - would reuse MCP find_calls handler
    return [];
  },

  /**
   * Get function details.
   * Placeholder - would reuse MCP handler logic.
   */
  async getFunctionDetails(
    _: unknown,
    _args: {
      name: string;
      file?: string | null;
      transitive?: boolean | null;
    },
    _context: GraphQLContext
  ) {
    // Placeholder - would reuse MCP get_function_details handler
    return null;
  },

  /**
   * Find guards protecting a node.
   * Placeholder.
   */
  async findGuards(
    _: unknown,
    _args: { nodeId: string },
    _context: GraphQLContext
  ) {
    return [];
  },

  /**
   * Trace alias chain.
   * Placeholder.
   */
  async traceAlias(
    _: unknown,
    _args: {
      variableName: string;
      file: string;
      maxDepth?: number | null;
    },
    _context: GraphQLContext
  ) {
    return [];
  },

  /**
   * Trace data flow.
   * Placeholder.
   */
  async traceDataFlow(
    _: unknown,
    _args: {
      source: string;
      file?: string | null;
      direction?: string | null;
      maxDepth?: number | null;
    },
    _context: GraphQLContext
  ) {
    return [];
  },
};
