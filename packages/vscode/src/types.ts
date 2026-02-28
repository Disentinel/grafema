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
  | { kind: 'edge'; edge: WireEdge & Record<string, unknown>; direction: 'outgoing' | 'incoming'; targetNode?: WireNode; isOnPath?: boolean; visitedNodeIds?: Set<string> }
  | { kind: 'bookmark-section'; count: number }
  | { kind: 'bookmark'; node: WireNode; metadata: NodeMetadata };

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

// === BLAST RADIUS PANEL TYPES ===

/**
 * Union type for all items in the BLAST RADIUS TreeDataProvider.
 *
 * Kinds:
 *   - 'root'       : root node with impact level badge
 *   - 'section'    : "Direct dependents (N)" / "Indirect dependents (N)" / "Guarantees at risk (N)"
 *   - 'dependent'  : a direct or indirect dependent node
 *   - 'guarantee'  : a guarantee node governing the root's file
 *   - 'summary'    : summary line ("N total * M files * K guarantees")
 *   - 'status'     : placeholder when not connected / no node / no dependents
 *   - 'loading'    : shown while BFS is in progress
 */
export type BlastRadiusItem =
  | { kind: 'root'; label: string; impactLevel: 'LOW' | 'MEDIUM' | 'HIGH'; file?: string; line?: number }
  | { kind: 'section'; label: string; sectionKind: 'direct' | 'indirect' | 'guarantee'; count: number }
  | { kind: 'dependent'; name: string; file?: string; line?: number; nodeType: string; viaPath: string[]; isIndirect: boolean }
  | { kind: 'guarantee'; name: string; file?: string; metadata?: Record<string, unknown> }
  | { kind: 'summary'; text: string }
  | { kind: 'status'; message: string }
  | { kind: 'loading' };

// === NODES IN FILE PANEL TYPES ===

/**
 * A single node entry in the NODES IN FILE debug panel.
 * Flat list (no children) — one item per graph node in the current file.
 */
export interface NodeInFileItem {
  id: string;
  label: string;
  description: string;
  nodeType: string;
  file?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

// === ISSUES PANEL TYPES ===

/**
 * Severity groups for the ISSUES panel sections.
 */
export type IssueSectionKind = 'violation' | 'connectivity' | 'warning';

/**
 * Union type for all items in the ISSUES TreeDataProvider.
 *
 * Kinds:
 *   - 'section' : group header with count
 *   - 'issue'   : a single ISSUE node from the graph
 *   - 'status'  : placeholder when not connected or no issues found
 */
export type IssueItem =
  | { kind: 'section'; label: string; icon: string; sectionKind: IssueSectionKind; count: number }
  | { kind: 'issue'; node: WireNode; metadata: NodeMetadata; sectionKind: IssueSectionKind }
  | { kind: 'status'; message: string };
