/**
 * Blast Radius Engine — pure BFS computation for blast radius analysis.
 *
 * Computes which nodes depend on a given root node via incoming edges,
 * grouping results into direct (1-hop) and indirect (2+ hop) dependents.
 * Also discovers guarantees at risk via GOVERNS edges on MODULE nodes.
 *
 * No VSCode dependencies — pure Node.js module for testability.
 * Mirrors the separation pattern from traceEngine.ts.
 */

import type { BaseRFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';

/**
 * Edge types followed when traversing dependencies backward.
 * CALLS: function A calls function B (incoming to B = callers of B)
 * IMPORTS_FROM: module A imports from module B (incoming to B = importers)
 * DEPENDS_ON: generic dependency edge
 * USES: A uses B (variable, value consumers)
 *
 * EXTENDS/IMPLEMENTS are intentionally deferred — they are narrower
 * and can be added to this list in a future iteration.
 */
export const DEPENDENCY_EDGE_TYPES = ['CALLS', 'IMPORTS_FROM', 'DEPENDS_ON', 'USES'] as const;

/** Global cap on total BFS nodes to prevent runaway traversal */
export const MAX_BLAST_NODES = 150;

/** Default maximum BFS depth (same as CALLERS panel) */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * A dependent node discovered during BFS traversal.
 */
export interface BlastNode {
  id: string;
  name: string;
  file?: string;
  line?: number;
  nodeType: string;
  /** Names of intermediate nodes in the dependency chain (empty for direct) */
  viaPath: string[];
}

/**
 * A guarantee node that governs the root node's file.
 */
export interface GuaranteeInfo {
  id: string;
  name: string;
  file?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Complete result of blast radius BFS computation.
 */
export interface BlastRadiusResult {
  rootId: string;
  rootName: string;
  /** Nodes reachable in exactly 1 hop (direct dependents) */
  directDependents: BlastNode[];
  /** Nodes reachable in 2+ hops (indirect dependents) */
  indirectDependents: BlastNode[];
  /** Guarantee nodes governing the root's file */
  guaranteesAtRisk: GuaranteeInfo[];
  /** Total dependent count (direct + indirect) */
  totalCount: number;
  /** Number of unique files across all dependents */
  fileCount: number;
  /** Weighted impact score */
  impactScore: number;
  /** Classified impact level */
  impactLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Compute the weighted impact score and classify the level.
 *
 * Formula: direct x 3 + indirect x 1 + guarantees x 10
 * LOW: 0-10, MEDIUM: 11-30, HIGH: 31+
 */
export function computeImpactScore(
  directCount: number,
  indirectCount: number,
  guaranteeCount: number
): { score: number; level: 'LOW' | 'MEDIUM' | 'HIGH' } {
  const score = directCount * 3 + indirectCount * 1 + guaranteeCount * 10;
  let level: 'LOW' | 'MEDIUM' | 'HIGH';
  if (score <= 10) {
    level = 'LOW';
  } else if (score <= 30) {
    level = 'MEDIUM';
  } else {
    level = 'HIGH';
  }
  return { score, level };
}

/**
 * Parse metadata JSON safely, returning empty object on failure.
 */
function safeParseMetadata(metadataStr: string): Record<string, unknown> {
  try {
    return JSON.parse(metadataStr) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Convert a WireNode to a BlastNode with the given viaPath.
 */
function toBlastNode(node: WireNode, viaPath: string[]): BlastNode {
  const metadata = safeParseMetadata(node.metadata);
  return {
    id: node.id,
    name: node.name,
    file: node.file || undefined,
    line: typeof metadata.line === 'number' ? metadata.line : undefined,
    nodeType: node.nodeType,
    viaPath,
  };
}

/**
 * Compute blast radius for a given root node via client-side BFS.
 *
 * Algorithm:
 * - BFS over incoming edges of DEPENDENCY_EDGE_TYPES
 * - Depth 0 = processing root's edges -> discovered nodes are direct (hop 1)
 * - Depth 1+ = indirect (hop 2+) with viaPath tracking
 * - Visited set prevents cycles (root is visited from start)
 * - Global cap at MAX_BLAST_NODES total discovered nodes
 * - Each RFDB call is wrapped in try/catch (errors treated as "no edges")
 *
 * @param client - RFDB client instance
 * @param rootNodeId - ID of the node to analyze
 * @param maxDepth - Maximum BFS depth (default: DEFAULT_MAX_DEPTH)
 * @returns BlastRadiusResult with all computed data
 */
export async function computeBlastRadius(
  client: BaseRFDBClient,
  rootNodeId: string,
  maxDepth: number = DEFAULT_MAX_DEPTH
): Promise<BlastRadiusResult> {
  // Fetch root node for name and file info
  let rootNode: WireNode | null = null;
  try {
    rootNode = await client.getNode(rootNodeId);
  } catch {
    // Treat as missing
  }

  const rootName = rootNode?.name ?? rootNodeId;

  const directDependents: BlastNode[] = [];
  const indirectDependents: BlastNode[] = [];

  const visited = new Set<string>();
  visited.add(rootNodeId);

  // BFS queue: [nodeId, depth, viaPath]
  const queue: Array<[string, number, string[]]> = [[rootNodeId, 0, []]];
  let totalDiscovered = 0;

  while (queue.length > 0) {
    const [nodeId, depth, viaPath] = queue.shift()!;

    // Guard: do not fetch edges for nodes at maxDepth (Dijkstra fix B1)
    if (depth >= maxDepth) {
      continue;
    }

    // Cap total discovered nodes
    if (totalDiscovered >= MAX_BLAST_NODES) {
      break;
    }

    let edges: Array<{ src: string; dst: string; edgeType: string }> = [];
    try {
      edges = await client.getIncomingEdges(nodeId, [...DEPENDENCY_EDGE_TYPES]);
    } catch {
      // Treat errors as "no edges" for this node
      continue;
    }

    for (const edge of edges) {
      if (totalDiscovered >= MAX_BLAST_NODES) {
        break;
      }

      const peerId = edge.src;

      // Cycle detection
      if (visited.has(peerId)) {
        continue;
      }
      visited.add(peerId);

      let peerNode: WireNode | null = null;
      try {
        peerNode = await client.getNode(peerId);
      } catch {
        // Skip nodes we cannot resolve
        continue;
      }

      // Null-check: skip unresolvable nodes silently
      if (!peerNode) {
        continue;
      }

      totalDiscovered++;

      if (depth === 0) {
        // Processing root's edges -> these are direct dependents (hop 1)
        directDependents.push(toBlastNode(peerNode, []));
        queue.push([peerId, depth + 1, [peerNode.name]]);
      } else {
        // Processing deeper levels -> indirect dependents (hop 2+)
        indirectDependents.push(toBlastNode(peerNode, viaPath));
        queue.push([peerId, depth + 1, [...viaPath, peerNode.name]]);
      }
    }
  }

  // Discover guarantees at risk
  const guaranteesAtRisk = await discoverGuarantees(client, rootNode);

  // Count unique files across all dependents
  const fileSet = new Set<string>();
  for (const dep of directDependents) {
    if (dep.file) fileSet.add(dep.file);
  }
  for (const dep of indirectDependents) {
    if (dep.file) fileSet.add(dep.file);
  }
  const fileCount = fileSet.size;

  // Compute impact score
  const { score, level } = computeImpactScore(
    directDependents.length,
    indirectDependents.length,
    guaranteesAtRisk.length
  );

  return {
    rootId: rootNodeId,
    rootName,
    directDependents,
    indirectDependents,
    guaranteesAtRisk,
    totalCount: directDependents.length + indirectDependents.length,
    fileCount,
    impactScore: score,
    impactLevel: level,
  };
}

/**
 * Discover guarantee nodes that govern the root node's file.
 *
 * Uses GOVERNS-edge-first approach (handles both GUARANTEE and
 * guarantee:* node types):
 * 1. Get root node's file
 * 2. Query MODULE nodes and filter by file
 * 3. For each MODULE: getIncomingEdges(moduleId, ['GOVERNS'])
 * 4. For each GOVERNS edge: getNode(edge.src) to get the guarantee node
 *
 * @param client - RFDB client instance
 * @param rootNode - The root WireNode (may be null)
 * @returns Array of GuaranteeInfo for guarantees governing root's file
 */
async function discoverGuarantees(
  client: BaseRFDBClient,
  rootNode: WireNode | null
): Promise<GuaranteeInfo[]> {
  if (!rootNode?.file) {
    return [];
  }

  const rootFile = rootNode.file;
  const guarantees: GuaranteeInfo[] = [];
  const seenIds = new Set<string>();

  try {
    // Find MODULE nodes for the root's file
    const moduleNodes: WireNode[] = [];
    for await (const node of client.queryNodes({ nodeType: 'MODULE' })) {
      if (node.file === rootFile) {
        moduleNodes.push(node);
      }
    }

    // For each MODULE node, find GOVERNS edges pointing to it
    for (const moduleNode of moduleNodes) {
      let governsEdges: Array<{ src: string; dst: string; edgeType: string }> = [];
      try {
        governsEdges = await client.getIncomingEdges(moduleNode.id, ['GOVERNS']);
      } catch {
        continue;
      }

      for (const edge of governsEdges) {
        if (seenIds.has(edge.src)) {
          continue;
        }
        seenIds.add(edge.src);

        let guaranteeNode: WireNode | null = null;
        try {
          guaranteeNode = await client.getNode(edge.src);
        } catch {
          continue;
        }

        if (!guaranteeNode) {
          continue;
        }

        const meta = safeParseMetadata(guaranteeNode.metadata);
        guarantees.push({
          id: guaranteeNode.id,
          name: guaranteeNode.name,
          file: guaranteeNode.file || undefined,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        });
      }
    }
  } catch {
    // Return whatever we found so far
  }

  return guarantees;
}
