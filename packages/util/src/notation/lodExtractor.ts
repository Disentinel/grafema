/**
 * LOD (Level of Detail) Subgraph Extractor
 *
 * Extracts a SubgraphData from the graph backend using BFS from a root node.
 * Different depth levels control how much of the graph neighborhood is fetched.
 *
 * - LOD 0: Root + direct containment children (names only in renderer)
 * - LOD 1: Same + outgoing non-containment edges for each child, resolved targets
 * - LOD 2: Same + expand children that have their own CONTAINS children
 *
 * @module notation/lodExtractor
 */

import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';
import type { SubgraphData } from './types.js';
import { lookupEdge } from './archetypes.js';

/**
 * Minimal backend interface — matches the project pattern of loose coupling.
 */
interface GraphBackend {
  getNode(id: string): Promise<BaseNodeRecord | null>;
  getOutgoingEdges(nodeId: string, edgeTypes?: string[] | null): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string, edgeTypes?: string[] | null): Promise<EdgeRecord[]>;
}

/**
 * Containment edge types that define the nesting tree.
 */
const CONTAINMENT_TYPES = [
  'CONTAINS', 'HAS_SCOPE', 'HAS_MEMBER', 'HAS_BODY',
  'HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_INIT', 'HAS_UPDATE',
  'HAS_CALLBACK', 'HAS_CATCH', 'HAS_FINALLY',
  'DECLARES', 'DEFINES', 'MOUNTS', 'PROPERTY_KEY', 'PROPERTY_VALUE',
];

/**
 * Extract a subgraph from the backend, rooted at the given node.
 *
 * @param backend  Graph backend
 * @param rootNodeId  Semantic ID of the root node
 * @param depth  LOD level (0, 1, or 2)
 */
export async function extractSubgraph(
  backend: GraphBackend,
  rootNodeId: string,
  depth: number = 1,
): Promise<SubgraphData> {
  const nodeMap = new Map<string, BaseNodeRecord>();
  const allEdges: EdgeRecord[] = [];

  const root = await backend.getNode(rootNodeId);
  if (!root) {
    return { rootNodes: [], edges: [], nodeMap };
  }

  nodeMap.set(root.id, root);

  // Step 1: Get direct containment children
  const containmentEdges = await backend.getOutgoingEdges(rootNodeId, CONTAINMENT_TYPES);
  const childIds: string[] = [];

  for (const edge of containmentEdges) {
    allEdges.push(edge);
    childIds.push(edge.dst);
    if (!nodeMap.has(edge.dst)) {
      const child = await backend.getNode(edge.dst);
      if (child) nodeMap.set(child.id, child);
    }
  }

  // LOD 0: stop here (renderer shows names only)
  if (depth <= 0) {
    return { rootNodes: [root], edges: allEdges, nodeMap };
  }

  // Step 2: For each child (and root), get outgoing non-containment edges
  const nodesToExpand = [rootNodeId, ...childIds];
  for (const nodeId of nodesToExpand) {
    const outgoing = await backend.getOutgoingEdges(nodeId);
    for (const edge of outgoing) {
      const mapping = lookupEdge(edge.type);
      if (mapping.archetype === 'contains') continue; // already handled

      allEdges.push(edge);
      // Resolve target nodes
      if (!nodeMap.has(edge.dst)) {
        const target = await backend.getNode(edge.dst);
        if (target) nodeMap.set(target.id, target);
      }
    }
  }

  // LOD 1: stop here
  if (depth <= 1) {
    return { rootNodes: [root], edges: allEdges, nodeMap };
  }

  // Step 3 (LOD 2): Expand children that have their own containment children
  for (const childId of childIds) {
    const childContainment = await backend.getOutgoingEdges(childId, CONTAINMENT_TYPES);
    for (const edge of childContainment) {
      allEdges.push(edge);
      if (!nodeMap.has(edge.dst)) {
        const grandchild = await backend.getNode(edge.dst);
        if (grandchild) nodeMap.set(grandchild.id, grandchild);
      }
    }

    // Also get operator edges for grandchildren
    const grandchildIds = childContainment.map(e => e.dst);
    for (const gcId of grandchildIds) {
      const gcOutgoing = await backend.getOutgoingEdges(gcId);
      for (const edge of gcOutgoing) {
        const mapping = lookupEdge(edge.type);
        if (mapping.archetype === 'contains') continue;
        allEdges.push(edge);
        if (!nodeMap.has(edge.dst)) {
          const target = await backend.getNode(edge.dst);
          if (target) nodeMap.set(target.id, target);
        }
      }
    }
  }

  return { rootNodes: [root], edges: allEdges, nodeMap };
}
