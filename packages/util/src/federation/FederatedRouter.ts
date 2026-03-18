/**
 * FederatedRouter — orchestrates cross-shard graph queries.
 *
 * Two query patterns:
 * 1. Traversal with frontier: trace_dataflow, trace_alias
 *    - Start in local shard, follow edges until boundary
 *    - Frontier edges grouped by target shard, batch-resolved via SUBGRAPH
 *    - Repeat until no more frontier or depth exhausted
 *
 * 2. Scatter-gather: find_calls, find_nodes
 *    - Broadcast query to all shards, merge results
 *
 * Key properties:
 * - Global visited set across all hops (cycle prevention / INV-3)
 * - Cost budget: max connections, max total nodes (fan-out protection / INV-6)
 * - Frontier grouping: N edges to same shard → 1 SUBGRAPH call (not N)
 */

import type { WireNode, WireEdge } from '@grafema/types';
import type { ShardDiscovery, ShardRegistration } from './ShardDiscovery.js';
import type { ManifestResolver } from '../manifest/index.js';
import type { ResolveResult } from '../manifest/resolver.js';

// ── Types ──────────────────────────────────────────────────────

export interface FrontierEdge {
  /** Source node semantic ID (in the source shard) */
  src: string;
  /** Target node ID (hash — target doesn't exist in source shard) */
  dst: string;
  /** Edge type */
  edgeType: string;
  /** Edge metadata (JSON string, may contain "source" for IMPORTS_FROM) */
  metadata?: string;
  /** Absolute file path of the target (extracted from semantic ID) */
  targetFile?: string;
  /** How this edge was resolved: "graph" | "manifest" | "unresolved" */
  resolvedVia?: 'graph' | 'manifest' | 'unresolved';
}

export interface SubgraphResponse {
  ok: boolean;
  nodes: WireNode[];
  edges: WireEdge[];
  frontier: FrontierEdge[];
}

export interface FederatedTraceHop {
  /** Which shard this hop came from */
  shard: ShardRegistration | null;
  /** Nodes discovered in this hop */
  nodes: WireNode[];
  /** Edges discovered in this hop */
  edges: WireEdge[];
  /** Unresolved frontier (shard not found or unavailable) */
  unresolvedFrontier: FrontierEdge[];
}

/** Node resolved from manifest (no full graph, just export surface) */
export interface ManifestResolvedNode {
  /** Package name (e.g., "@grafema/util") */
  packageName: string;
  /** Symbol name */
  symbolName: string;
  /** Export kind: FUNCTION, CLASS, etc. */
  kind: string;
  /** Known effects */
  effects: string[];
  /** Semantic ID from manifest (if available) */
  semanticId?: string;
}

export interface FederatedTraceResult {
  /** All nodes from all hops, merged */
  nodes: WireNode[];
  /** All edges from all hops, merged */
  edges: WireEdge[];
  /** Individual hops for debugging/visualization */
  hops: FederatedTraceHop[];
  /** Nodes resolved via manifest (partial info, no subgraph) */
  manifestNodes: ManifestResolvedNode[];
  /** Unresolved frontier across all hops */
  unresolvedFrontier: FrontierEdge[];
  /** Whether the traversal was cut short by cost budget */
  truncated: boolean;
}

export interface FederatedRouterOptions {
  /** Max total nodes across all hops (default: 10000) */
  maxNodes?: number;
  /** Max shard connections per round (default: 10) */
  maxShardsPerRound?: number;
  /** Max traversal rounds (default: 5) */
  maxRounds?: number;
}

/** Function that sends a SUBGRAPH command to an rfdb-server via its socket */
type SubgraphSender = (
  socket: string,
  entries: string[],
  direction: string,
  edgeTypes: string[],
  maxDepth: number,
) => Promise<SubgraphResponse>;

// ── Router ─────────────────────────────────────────────────────

export class FederatedRouter {
  private discovery: ShardDiscovery;
  private sendSubgraph: SubgraphSender;
  private manifestResolver: ManifestResolver | null;
  private options: Required<FederatedRouterOptions>;

  constructor(
    discovery: ShardDiscovery,
    sendSubgraph: SubgraphSender,
    options: FederatedRouterOptions = {},
    manifestResolver?: ManifestResolver,
  ) {
    this.discovery = discovery;
    this.sendSubgraph = sendSubgraph;
    this.manifestResolver = manifestResolver ?? null;
    this.options = {
      maxNodes: options.maxNodes ?? 10_000,
      maxShardsPerRound: options.maxShardsPerRound ?? 10,
      maxRounds: options.maxRounds ?? 5,
    };
  }

  /**
   * Federated traversal: start from entry points, hop across shards via frontier.
   *
   * 1. Send SUBGRAPH to the shard owning the first entry point
   * 2. Collect frontier, group by target shard
   * 3. Send SUBGRAPH to each target shard (parallel)
   * 4. Repeat until no more frontier or budget exhausted
   */
  async trace(
    entries: string[],
    direction: 'forward' | 'backward' | 'both',
    edgeTypes: string[],
    maxDepth: number,
  ): Promise<FederatedTraceResult> {
    const allNodes: WireNode[] = [];
    const allEdges: WireEdge[] = [];
    const allHops: FederatedTraceHop[] = [];
    const manifestNodes: ManifestResolvedNode[] = [];
    const globalVisited = new Set<string>(); // INV-3: global across all hops
    let unresolvedFrontier: FrontierEdge[] = [];
    let truncated = false;

    // Initial frontier: the entry points themselves, grouped by shard
    let currentFrontier: Array<{ shard: ShardRegistration; entries: string[] }> = [];

    // Group entry points by shard
    const entryGroups = this.groupByShard(
      entries.map(e => ({ src: '', dst: e, edgeType: '' })),
    );
    for (const [, group] of entryGroups) {
      currentFrontier.push({
        shard: group.shard,
        entries: group.edges.map(e => e.dst),
      });
    }

    let remainingDepth = maxDepth;

    for (let round = 0; round < this.options.maxRounds; round++) {
      if (currentFrontier.length === 0 || remainingDepth <= 0) break;

      // Cost check: limit shards per round
      const roundShards = currentFrontier.slice(0, this.options.maxShardsPerRound);
      if (roundShards.length < currentFrontier.length) {
        truncated = true;
      }

      // Query all shards in parallel
      const hopResults = await Promise.all(
        roundShards.map(async ({ shard, entries: entryIds }) => {
          // Filter out already-visited entries
          const newEntries = entryIds.filter(e => !globalVisited.has(e));
          if (newEntries.length === 0) {
            return null;
          }

          try {
            const result = await this.sendSubgraph(
              shard.socket,
              newEntries,
              direction,
              edgeTypes,
              remainingDepth,
            );

            // Mark visited
            for (const node of result.nodes) {
              const nodeId = node.semanticId || node.id;
              globalVisited.add(nodeId);
            }

            return { shard, result };
          } catch {
            // Shard unavailable — all its entries become unresolved
            return {
              shard,
              result: {
                ok: false,
                nodes: [],
                edges: [],
                frontier: newEntries.map(e => ({
                  src: '',
                  dst: e,
                  edgeType: 'UNRESOLVED',
                })),
              } as SubgraphResponse,
            };
          }
        }),
      );

      // Collect results
      const nextFrontierEdges: FrontierEdge[] = [];

      for (const hopResult of hopResults) {
        if (!hopResult) continue;

        const { shard, result } = hopResult;
        const hop: FederatedTraceHop = {
          shard,
          nodes: result.nodes,
          edges: result.edges,
          unresolvedFrontier: [],
        };

        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);

        // Check cost budget
        if (allNodes.length >= this.options.maxNodes) {
          truncated = true;
          allHops.push(hop);
          break;
        }

        // Process frontier
        for (const edge of result.frontier) {
          if (globalVisited.has(edge.dst)) continue; // Already visited
          nextFrontierEdges.push(edge);
        }

        allHops.push(hop);
      }

      if (truncated) break;

      // Group next frontier by target shard
      const nextGroups = this.groupByShard(nextFrontierEdges);
      currentFrontier = [];
      const newUnresolved: FrontierEdge[] = [];

      for (const [, group] of nextGroups) {
        if (group.shard) {
          currentFrontier.push({
            shard: group.shard,
            entries: group.edges.map(e => e.dst),
          });
        } else {
          // No shard found — try manifest fallback
          for (const edge of group.edges) {
            const resolved = this.tryManifestFallback(edge);
            if (resolved) {
              manifestNodes.push(resolved);
              edge.resolvedVia = 'manifest';
            } else {
              edge.resolvedVia = 'unresolved';
              newUnresolved.push(edge);
            }
          }
        }
      }

      unresolvedFrontier = newUnresolved;
      remainingDepth = Math.max(0, remainingDepth - 1);
    }

    return {
      nodes: allNodes,
      edges: allEdges,
      hops: allHops,
      manifestNodes,
      unresolvedFrontier,
      truncated,
    };
  }

  /**
   * Scatter-gather: broadcast a query to all known shards, merge results.
   * Used for find_nodes, find_calls when no file filter is specified.
   */
  async scatterGather<T>(
    queryFn: (socket: string) => Promise<T[]>,
  ): Promise<{ results: T[]; queriedShards: number }> {
    const shards = this.discovery.all();
    const allResults: T[] = [];

    const responses = await Promise.all(
      shards.map(async (shard) => {
        try {
          return await queryFn(shard.socket);
        } catch {
          return [];
        }
      }),
    );

    for (const results of responses) {
      allResults.push(...results);
    }

    return { results: allResults, queriedShards: shards.length };
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Try to resolve a frontier edge via ManifestResolver.
   * Works for IMPORTS_FROM edges that carry "source" in metadata.
   * Returns ManifestResolvedNode if found, null otherwise.
   */
  private tryManifestFallback(edge: FrontierEdge): ManifestResolvedNode | null {
    if (!this.manifestResolver) return null;
    if (edge.edgeType !== 'IMPORTS_FROM') return null;

    // Extract package source and symbol from edge metadata
    const meta = parseEdgeMetadata(edge.metadata);
    if (!meta.source) return null;

    // Try to find the symbol in the manifest
    // Symbol name might be in metadata or extractable from src semantic ID
    const symbolName = meta.specifier || meta.localName || extractSymbolFromId(edge.src);
    if (!symbolName) {
      // No specific symbol — check if package exists in manifests at all
      if (this.manifestResolver.has(meta.source)) {
        return {
          packageName: meta.source,
          symbolName: '*',
          kind: 'VARIABLE',
          effects: ['UNKNOWN'],
        };
      }
      return null;
    }

    const result: ResolveResult | null = this.manifestResolver.resolve(meta.source, symbolName);
    if (!result) return null;

    return {
      packageName: meta.source,
      symbolName,
      kind: result.export.kind,
      effects: result.export.effects,
      semanticId: result.export.semanticId,
    };
  }

  /**
   * Group frontier edges by target shard using ShardDiscovery.
   * Edges whose target shard can't be found go into a null group.
   */
  private groupByShard(
    edges: FrontierEdge[],
  ): Map<string, { shard: ShardRegistration; edges: FrontierEdge[] }> {
    const groups = new Map<string, { shard: ShardRegistration; edges: FrontierEdge[] }>();

    for (const edge of edges) {
      // Try to extract file path from the target ID (dst)
      // Semantic IDs contain file path as first segment: "path/to/file.ts->FUNCTION->name"
      const filePath = extractFilePath(edge.dst);

      const shard = filePath ? this.discovery.resolve(filePath) : null;
      const key = shard ? shard.root : '__unresolved__';

      if (!groups.has(key)) {
        groups.set(key, { shard: shard!, edges: [] });
      }
      groups.get(key)!.edges.push(edge);
    }

    return groups;
  }
}

/** Parse JSON edge metadata, returning an object with known fields. */
function parseEdgeMetadata(metadata?: string): Record<string, string> {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

/** Extract symbol name from the last segment of a semantic ID. */
function extractSymbolFromId(semanticId: string): string | null {
  if (!semanticId) return null;
  // "file.ts->FUNCTION->myFunc" → "myFunc"
  const parts = semanticId.split('->');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/**
 * Extract absolute file path from a semantic ID or grafema URI.
 * Handles both formats:
 * - Arrow format: "path/to/file.ts->FUNCTION->name"
 * - URI format: "grafema://path/to/file.ts#FUNCTION%3Aname"
 */
function extractFilePath(semanticId: string): string | null {
  if (!semanticId) return null;

  // URI format: grafema://path/to/file.ts#fragment
  if (semanticId.startsWith('grafema://')) {
    const hashIdx = semanticId.indexOf('#');
    return hashIdx > 0
      ? semanticId.slice('grafema://'.length, hashIdx)
      : semanticId.slice('grafema://'.length);
  }

  // Arrow format: path/to/file.ts->FUNCTION->name
  const arrowIdx = semanticId.indexOf('->');
  if (arrowIdx > 0) {
    return semanticId.slice(0, arrowIdx);
  }

  // Might be just a file path or hash — return as-is if it looks like a path
  if (semanticId.includes('/') && !semanticId.includes(' ')) {
    return semanticId;
  }

  return null;
}
