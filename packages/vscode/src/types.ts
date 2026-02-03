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
 */
export type GraphTreeItem =
  | { kind: 'node'; node: WireNode; metadata: NodeMetadata; isOnPath?: boolean }
  | { kind: 'edge'; edge: WireEdge & Record<string, unknown>; direction: 'outgoing' | 'incoming'; targetNode?: WireNode; isOnPath?: boolean };

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
 */
export function formatEdgeLabel(
  edge: WireEdge & Record<string, unknown>,
  targetNode: WireNode | null,
  direction: 'outgoing' | 'incoming'
): string {
  const arrow = direction === 'outgoing' ? '\u2192' : '\u2190';
  const targetLabel = targetNode
    ? `${targetNode.nodeType} "${targetNode.name}"`
    : direction === 'outgoing'
      ? edge.dst
      : edge.src;
  return `${arrow} ${edge.edgeType}: ${targetLabel}`;
}
