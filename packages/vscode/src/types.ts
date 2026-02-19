/**
 * Types for Grafema Explore VS Code extension
 */

import type { WireNode, WireEdge } from '@grafema/types';

/**
 * Parsed node metadata for easier access
 */
export interface NodeMetadata {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  [key: string]: unknown;
}

/**
 * Represents either a node or an edge in the graph tree
 * visitedNodeIds tracks ancestors to detect cycles
 * isRoot marks the root node (should be expanded by default)
 */
export type GraphTreeItem =
  | { kind: 'node'; node: WireNode; metadata: NodeMetadata; isOnPath?: boolean; visitedNodeIds?: Set<string>; isRoot?: boolean }
  | { kind: 'edge'; edge: WireEdge & Record<string, unknown>; direction: 'outgoing' | 'incoming'; targetNode?: WireNode; isOnPath?: boolean; visitedNodeIds?: Set<string> };

/**
 * Graph statistics returned by getStats()
 */
export interface GraphStats {
  version: string;
  nodeCount: number;
  edgeCount: number;
  dbPath: string;
}

/**
 * Connection states for the RFDB client
 */
export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'no-database'; message: string }
  | { status: 'starting-server' }
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'error'; message: string };

/**
 * Parse metadata JSON string from WireNode
 */
export function parseNodeMetadata(node: WireNode): NodeMetadata {
  try {
    return JSON.parse(node.metadata) as NodeMetadata;
  } catch {
    return {};
  }
}

/**
 * Parse metadata JSON string from WireEdge
 */
export function parseEdgeMetadata(edge: WireEdge): Record<string, unknown> {
  try {
    return JSON.parse(edge.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Format node for display in tree view
 */
export function formatNodeLabel(node: WireNode): string {
  return `${node.nodeType} "${node.name}"`;
}

/**
 * Format edge for display in tree view
 * Format: "EDGE_TYPE → NODE_TYPE "name"" (horizontal arrow in text)
 * Icon (separate) shows LOD direction: ↓ outgoing, ↑ incoming
 */
export function formatEdgeLabel(
  edge: WireEdge & Record<string, unknown>,
  targetNode: WireNode | null,
  direction: 'outgoing' | 'incoming'
): string {
  const targetLabel = targetNode
    ? `${targetNode.nodeType} "${targetNode.name}"`
    : direction === 'outgoing'
      ? edge.dst
      : edge.src;
  return `${edge.edgeType} \u2192 ${targetLabel}`;
}

// === VALUE TRACE TYPES ===

/**
 * Classification of leaf nodes in backward trace.
 * Determines annotation display in hover and tree view.
 *
 * Priority order when multiple categories match:
 *   user-input > external > config > literal > unknown
 */
export type SourceKind =
  | 'user-input'  // HTTP request body/params, form data, WebSocket messages
  | 'literal'     // String/number/boolean/null literal in source
  | 'config'      // CONSTANT or file in config directory
  | 'external'    // DB result, API response, external system input
  | 'unknown';    // No classification possible

/**
 * A single node in a value trace path.
 * Children are populated by the trace engine during BFS.
 */
export interface TraceNode {
  node: WireNode;
  metadata: NodeMetadata;
  /** Edge type connecting this node to its parent in the trace */
  edgeType: string;
  /** 0 = first hop from root, 1 = second hop, etc. */
  depth: number;
  /** Only set on leaf nodes in backward trace (no further origins found) */
  sourceKind?: SourceKind;
  /** Direct children in the trace tree */
  children: TraceNode[];
  /** True if there are more children than MAX_BRANCHING_FACTOR */
  hasMoreChildren?: boolean;
}

/**
 * Return value from traceBackward / traceForward.
 * `truncated` is true when the root-level edge list exceeded MAX_BRANCHING_FACTOR.
 */
export interface TraceOutput {
  nodes: TraceNode[];
  truncated: boolean;
}

/**
 * Complete result of tracing a root node.
 */
export interface TraceResult {
  rootNode: WireNode;
  rootMetadata: NodeMetadata;
  /** Direct origins (backward trace) */
  backward: TraceNode[];
  /** Direct destinations (forward trace) */
  forward: TraceNode[];
  gaps: TraceGap[];
  /** Coverage ratio: traced / total leaf paths in backward trace */
  coverage: { traced: number; total: number };
  /** True when backward trace had more top-level edges than MAX_BRANCHING_FACTOR */
  backwardTruncated?: boolean;
  /** True when forward trace had more top-level edges than MAX_BRANCHING_FACTOR */
  forwardTruncated?: boolean;
}

/**
 * Represents a detected connectivity gap in the trace.
 */
export interface TraceGap {
  /** ID of the node with no traced origins */
  nodeId: string;
  /** Name of the node for display */
  nodeName: string;
  /** Human-readable description of the gap */
  description: string;
  /** The gap heuristic that detected this */
  heuristic: 'no-origins';
}

/**
 * Union type for all items in the VALUE TRACE TreeDataProvider.
 */
export type ValueTraceItem =
  | { kind: 'section'; label: string; icon: string; direction: 'backward' | 'forward' | 'gaps' }
  | { kind: 'trace-node'; traceNode: TraceNode; direction: 'backward' | 'forward' }
  | { kind: 'gap'; gap: TraceGap }
  | { kind: 'status'; message: string }
  | { kind: 'more'; parentNodeId: string; count: number };

// === CALLERS PANEL TYPES ===

/**
 * Union type for all items in the CALLERS TreeDataProvider.
 *
 * Kinds:
 *   - 'root'      : pinned root node label (the function being analyzed)
 *   - 'section'   : "Incoming (N callers)" or "Outgoing (N callees)" header
 *   - 'call-node' : a caller or callee function node (recursively expandable)
 *   - 'status'    : placeholder when not connected / no node pinned
 *   - 'more'      : "N+ more" leaf when capped by MAX_BRANCHING_FACTOR
 */
export type CallersItem =
  | { kind: 'root'; node: WireNode; metadata: NodeMetadata }
  | { kind: 'section'; label: string; icon: string; direction: 'incoming' | 'outgoing'; count: number }
  | { kind: 'call-node'; node: WireNode; metadata: NodeMetadata; direction: 'incoming' | 'outgoing'; depth: number; visitedIds: Set<string> }
  | { kind: 'status'; message: string }
  | { kind: 'more'; count: number };
