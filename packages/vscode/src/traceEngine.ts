/**
 * Trace Engine — BFS logic for backward and forward value trace.
 *
 * Shared between HoverProvider (depth=3) and ValueTraceProvider (depth=5).
 * Uses client-side BFS over RFDB edges, matching the pattern from
 * MCP handleTraceAlias.
 */

import type * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { BaseRFDBClient } from '@grafema/rfdb-client';
import { parseNodeMetadata } from './types';
import type { TraceNode, TraceOutput, TraceGap, SourceKind } from './types';

/** Edge types followed when tracing value backward (finding origins) */
const BACKWARD_EDGE_TYPES = ['ASSIGNED_FROM', 'DERIVES_FROM'] as const;

/** Edge types followed when tracing value forward (finding consumers) */
const FORWARD_EDGE_TYPES = ['ASSIGNED_FROM', 'DERIVES_FROM', 'PASSES_ARGUMENT'] as const;

/**
 * Maximum edges to follow per node.
 * Nodes with more edges get a 'hasMoreChildren' flag.
 */
export const MAX_BRANCHING_FACTOR = 5;

/**
 * Trace value origins backward from a starting node.
 *
 * Algorithm: recursive DFS with visited set for cycle prevention.
 * Follows ASSIGNED_FROM and DERIVES_FROM outgoing edges (edge.dst = origin).
 *
 * Edge direction convention (verified from MCP handleTraceAlias):
 *   A --ASSIGNED_FROM--> B means A gets its value from B.
 *   getOutgoingEdges(A, ['ASSIGNED_FROM']) -> edge.dst = B (the origin).
 *
 * @param client - RFDB client
 * @param startNodeId - ID of the node to trace backward from
 * @param maxDepth - Maximum depth to traverse (3 for hover, 5 for panel)
 * @param token - Optional cancellation token
 * @returns TraceOutput with nodes and truncated flag
 */
export async function traceBackward(
  client: BaseRFDBClient,
  startNodeId: string,
  maxDepth: number,
  token?: vscode.CancellationToken
): Promise<TraceOutput> {
  const visited = new Set<string>();
  visited.add(startNodeId);

  async function traverse(nodeId: string, depth: number): Promise<{ nodes: TraceNode[]; truncated: boolean }> {
    if (depth >= maxDepth) return { nodes: [], truncated: false };
    if (token?.isCancellationRequested) return { nodes: [], truncated: false };

    const edges = await client.getOutgoingEdges(nodeId, [...BACKWARD_EDGE_TYPES]);
    if (token?.isCancellationRequested) return { nodes: [], truncated: false };

    const result: TraceNode[] = [];
    const edgesToProcess = edges.slice(0, MAX_BRANCHING_FACTOR);
    const hasMore = edges.length > MAX_BRANCHING_FACTOR;

    for (const edge of edgesToProcess) {
      const originId = edge.dst;

      if (visited.has(originId)) {
        // Cycle: emit as leaf node, do not recurse
        const cycleNode = await client.getNode(originId);
        if (!cycleNode) continue;
        result.push({
          node: cycleNode,
          metadata: parseNodeMetadata(cycleNode),
          edgeType: edge.edgeType,
          depth,
          sourceKind: undefined,
          children: [],
        });
        continue;
      }

      visited.add(originId);
      if (token?.isCancellationRequested) return { nodes: result, truncated: hasMore };

      const originNode = await client.getNode(originId);
      if (!originNode) continue;

      const childResult = await traverse(originId, depth + 1);
      const isLeaf = childResult.nodes.length === 0;

      result.push({
        node: originNode,
        metadata: parseNodeMetadata(originNode),
        edgeType: edge.edgeType,
        depth,
        sourceKind: isLeaf ? classifySource(originNode) : undefined,
        children: childResult.nodes,
        hasMoreChildren: childResult.truncated || undefined,
      });
    }

    return { nodes: result, truncated: hasMore };
  }

  const topResult = await traverse(startNodeId, 0);
  return { nodes: topResult.nodes, truncated: topResult.truncated };
}

/**
 * Trace value destinations forward from a starting node.
 *
 * Follows nodes that have an ASSIGNED_FROM/DERIVES_FROM/PASSES_ARGUMENT
 * edge pointing back to our node. Those are the downstream consumers.
 *
 * Forward trace: getIncomingEdges(nodeId, FORWARD_EDGE_TYPES) -> edge.src = consumer.
 *
 * @param client - RFDB client
 * @param startNodeId - ID of the node to trace forward from
 * @param maxDepth - Maximum depth to traverse
 * @param token - Optional cancellation token
 * @returns TraceOutput with nodes and truncated flag
 */
export async function traceForward(
  client: BaseRFDBClient,
  startNodeId: string,
  maxDepth: number,
  token?: vscode.CancellationToken
): Promise<TraceOutput> {
  const visited = new Set<string>();
  visited.add(startNodeId);

  async function traverse(nodeId: string, depth: number): Promise<{ nodes: TraceNode[]; truncated: boolean }> {
    if (depth >= maxDepth) return { nodes: [], truncated: false };
    if (token?.isCancellationRequested) return { nodes: [], truncated: false };

    const edges = await client.getIncomingEdges(nodeId, [...FORWARD_EDGE_TYPES]);
    if (token?.isCancellationRequested) return { nodes: [], truncated: false };

    const result: TraceNode[] = [];
    const edgesToProcess = edges.slice(0, MAX_BRANCHING_FACTOR);
    const hasMore = edges.length > MAX_BRANCHING_FACTOR;

    for (const edge of edgesToProcess) {
      const consumerId = edge.src;

      if (visited.has(consumerId)) continue;
      visited.add(consumerId);
      if (token?.isCancellationRequested) return { nodes: result, truncated: hasMore };

      const consumerNode = await client.getNode(consumerId);
      if (!consumerNode) continue;

      const childResult = await traverse(consumerId, depth + 1);

      result.push({
        node: consumerNode,
        metadata: parseNodeMetadata(consumerNode),
        edgeType: edge.edgeType,
        depth,
        sourceKind: undefined,
        children: childResult.nodes,
        hasMoreChildren: childResult.truncated || undefined,
      });
    }

    return { nodes: result, truncated: hasMore };
  }

  const topResult = await traverse(startNodeId, 0);
  return { nodes: topResult.nodes, truncated: topResult.truncated };
}

/**
 * Classify a leaf node in the backward trace.
 *
 * Priority order: user-input > external > config > literal > unknown
 *
 * @param node - The leaf WireNode to classify
 * @returns SourceKind value
 */
export function classifySource(node: WireNode): SourceKind {
  const nodeType = node.nodeType;

  // Priority 1: user-input
  if (nodeType === 'http:request') return 'user-input';
  if (nodeType === 'socketio:on') return 'user-input';
  if (nodeType === 'event:listener') return 'user-input';
  if (nodeType === 'PARAMETER') {
    const name = (node.name ?? '').toLowerCase();
    if (['req', 'request', 'ctx', 'context', 'body', 'params', 'query', 'headers'].includes(name)) {
      return 'user-input';
    }
  }

  // Priority 2: external
  if (nodeType === 'EXTERNAL' || nodeType === 'EXTERNAL_MODULE') return 'external';
  if (nodeType.startsWith('db:') || nodeType.startsWith('net:') ||
      nodeType.startsWith('os:') || nodeType.startsWith('fs:')) {
    return 'external';
  }

  // Priority 3: config
  if (nodeType === 'CONSTANT') return 'config';
  const filePath = node.file ?? '';
  if (filePath.includes('config') || filePath.includes('settings') || filePath.includes('.env')) {
    return 'config';
  }

  // Priority 4: literal
  if (nodeType === 'LITERAL') return 'literal';

  // Priority 5: unknown
  return 'unknown';
}

/**
 * Detect connectivity gaps in a trace result.
 *
 * Gap Heuristic 1 (no-origins): A leaf node in the backward trace
 * with sourceKind='unknown' and nodeType in {VARIABLE, PARAMETER, EXPRESSION}
 * indicates the analyzer missed an assignment edge.
 *
 * Intentional leaves (LITERAL, CONSTANT, http:request, etc.) have known
 * source kinds and are not flagged as gaps.
 *
 * @param backward - Backward trace result from traceBackward()
 * @returns Array of TraceGap items
 */
export function detectGaps(backward: TraceNode[]): TraceGap[] {
  const gaps: TraceGap[] = [];

  function scanTree(nodes: TraceNode[]): void {
    for (const tn of nodes) {
      if (tn.children.length === 0 && tn.sourceKind === 'unknown') {
        const nodeType = tn.node.nodeType;
        if (nodeType === 'VARIABLE' || nodeType === 'PARAMETER' || nodeType === 'EXPRESSION') {
          gaps.push({
            nodeId: tn.node.id,
            nodeName: tn.node.name ?? tn.node.id,
            description: `"${tn.node.name}" has no traced origins`,
            heuristic: 'no-origins',
          });
        }
      }
      scanTree(tn.children);
    }
  }

  scanTree(backward);
  return gaps;
}

/**
 * Compute coverage ratio for a backward trace.
 *
 * A leaf is "traced" if it has a known sourceKind (not 'unknown').
 * Intentional leaves (LITERAL, CONSTANT, http:request, etc.) count as traced.
 * Unknown leaves (VARIABLE, PARAMETER, EXPRESSION with no origins) are untraced.
 *
 * @param backward - Backward trace result from traceBackward()
 * @returns { traced, total } counts of leaf paths
 */
export function computeCoverage(backward: TraceNode[]): { traced: number; total: number } {
  let traced = 0;
  let total = 0;

  function countLeaves(nodes: TraceNode[]): void {
    for (const tn of nodes) {
      if (tn.children.length === 0) {
        total++;
        if (tn.sourceKind && tn.sourceKind !== 'unknown') {
          traced++;
        }
      }
      countLeaves(tn.children);
    }
  }

  countLeaves(backward);
  return { traced, total };
}
