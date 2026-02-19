/**
 * Graph traversal handlers: get_node, get_neighbors, traverse_graph
 * REG-521: Add raw graph traversal primitives to MCP
 */

import { ensureAnalyzed } from '../analysis.js';
import { textResult, errorResult } from '../utils.js';
import type { ToolResult, GetNodeArgs, GetNeighborsArgs, TraverseGraphArgs } from '../types.js';
import type { EdgeType, EdgeRecord } from '@grafema/types';

const MAX_TRAVERSAL_RESULTS = 10_000;
const MAX_DEPTH = 20;

/**
 * Minimal backend interface for graph-handler logic functions.
 * Allows testing with mock backends without importing full GraphBackend.
 */
interface GraphBackendLike {
  getNode(id: string): Promise<Record<string, unknown> | null>;
  getOutgoingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;
}

// === Shared helpers ===

async function groupEdgesByType(
  edges: EdgeRecord[],
  db: GraphBackendLike,
  getNodeId: (edge: EdgeRecord) => string,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const grouped: Record<string, Array<Record<string, unknown>>> = {};

  for (const edge of edges) {
    const type = edge.type as string;
    if (!grouped[type]) grouped[type] = [];
    const nodeId = getNodeId(edge);
    const node = await db.getNode(nodeId);
    grouped[type].push({
      id: nodeId,
      ...(node ? { type: node.type, name: node.name, file: node.file, line: node.line } : { type: 'UNKNOWN' }),
      ...(edge.metadata ? { edgeMetadata: edge.metadata } : {}),
    });
  }

  return grouped;
}

// === Logic functions (testable, accept backend directly) ===

export async function getNodeLogic(db: GraphBackendLike, args: GetNodeArgs): Promise<ToolResult> {
  const { semanticId } = args;

  if (!semanticId || semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }

  const node = await db.getNode(semanticId);

  if (!node) {
    return errorResult(`Node not found: "${semanticId}". Use find_nodes to search by type, name, or file.`);
  }

  return textResult(JSON.stringify(node, null, 2));
}

export async function getNeighborsLogic(db: GraphBackendLike, args: GetNeighborsArgs): Promise<ToolResult> {
  const { semanticId, direction = 'both', edgeTypes } = args;

  if (!semanticId || semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }

  if (edgeTypes !== undefined && edgeTypes.length === 0) {
    return errorResult('edgeTypes must not be an empty array. Omit edgeTypes to get all edge types.');
  }

  const node = await db.getNode(semanticId);

  if (!node) {
    return errorResult(`Node not found: "${semanticId}". Use find_nodes to search by type, name, or file.`);
  }

  const edgeFilter = (edgeTypes as EdgeType[] | undefined) ?? null;
  const result: Record<string, unknown> = {};

  if (direction === 'outgoing' || direction === 'both') {
    const edges = await db.getOutgoingEdges(semanticId, edgeFilter);
    result.outgoing = await groupEdgesByType(edges, db, (e) => e.dst);
  }

  if (direction === 'incoming' || direction === 'both') {
    const edges = await db.getIncomingEdges(semanticId, edgeFilter);
    result.incoming = await groupEdgesByType(edges, db, (e) => e.src);
  }

  return textResult(JSON.stringify(result, null, 2));
}

export async function traverseGraphLogic(db: GraphBackendLike, args: TraverseGraphArgs): Promise<ToolResult> {
  const { startNodeIds, edgeTypes, maxDepth = 5, direction = 'outgoing' } = args;

  // Validate inputs
  if (!startNodeIds || startNodeIds.length === 0) {
    return errorResult('startNodeIds must not be empty');
  }
  if (!edgeTypes || edgeTypes.length === 0) {
    return errorResult('edgeTypes must not be empty. Use get_schema(type="edges") to see available types.');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    return errorResult('maxDepth must be a non-negative integer');
  }
  if (maxDepth > MAX_DEPTH) {
    return errorResult(`maxDepth must be <= ${MAX_DEPTH} to prevent performance issues`);
  }

  // Deduplicate start nodes
  const uniqueStartIds = [...new Set(startNodeIds)];

  // Verify start nodes exist
  for (const id of uniqueStartIds) {
    const node = await db.getNode(id);
    if (!node) {
      return errorResult(`Start node not found: "${id}". Use find_nodes to search by type, name, or file.`);
    }
  }

  const edgeFilter = edgeTypes as EdgeType[];

  // Manual BFS (works for both directions, provides depth info)
  const visited = new Set<string>(uniqueStartIds);
  const queue: Array<{ id: string; depth: number }> = uniqueStartIds.map(id => ({ id, depth: 0 }));
  const results: Array<{ id: string; depth: number }> = uniqueStartIds.map(id => ({ id, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const edges: EdgeRecord[] = direction === 'outgoing'
      ? await db.getOutgoingEdges(current.id, edgeFilter)
      : await db.getIncomingEdges(current.id, edgeFilter);

    for (const edge of edges) {
      const neighborId = direction === 'outgoing' ? edge.dst : edge.src;
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        const nextDepth = current.depth + 1;
        queue.push({ id: neighborId, depth: nextDepth });
        results.push({ id: neighborId, depth: nextDepth });

        if (results.length >= MAX_TRAVERSAL_RESULTS) {
          const nodes = await enrichResults(db, results);
          return textResult(JSON.stringify({
            count: nodes.length,
            truncated: true,
            message: `Traversal hit limit of ${MAX_TRAVERSAL_RESULTS} nodes. Use more specific edge types or lower maxDepth.`,
            nodes,
          }, null, 2));
        }
      }
    }
  }

  const nodes = await enrichResults(db, results);
  return textResult(JSON.stringify({
    count: nodes.length,
    truncated: false,
    nodes,
  }, null, 2));
}

async function enrichResults(
  db: GraphBackendLike,
  results: Array<{ id: string; depth: number }>
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    results.map(async ({ id, depth }) => {
      const node = await db.getNode(id);
      return {
        id,
        depth,
        ...(node ? { type: node.type, name: node.name, file: node.file, line: node.line } : { type: 'UNKNOWN' }),
      };
    })
  );
}

// === Public handlers (call ensureAnalyzed, used by MCP routing) ===

export async function handleGetNode(args: GetNodeArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  return getNodeLogic(db as unknown as GraphBackendLike, args);
}

export async function handleGetNeighbors(args: GetNeighborsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  return getNeighborsLogic(db as unknown as GraphBackendLike, args);
}

export async function handleTraverseGraph(args: TraverseGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  return traverseGraphLogic(db as unknown as GraphBackendLike, args);
}
