/**
 * Node Context — shared data logic for building node neighborhood context
 *
 * Extracts source code preview and all incoming/outgoing edges
 * for a given node, grouped by edge type.
 *
 * Used by CLI (grafema context) and MCP (get_context tool).
 * Consumers handle their own formatting; this module provides data only.
 *
 * @module queries/NodeContext
 */

import { existsSync, readFileSync } from 'fs';
import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';

// ---------------------------------------------------------------------------
// Minimal backend interface (matches project pattern — loose coupling)
// ---------------------------------------------------------------------------

interface GraphBackend {
  getNode(id: string): Promise<BaseNodeRecord | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes?: string[] | null,
  ): Promise<EdgeRecord[]>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes?: string[] | null,
  ): Promise<EdgeRecord[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Edge types that are structural/containment — shown in compact form.
 * These describe HOW code is nested, not WHAT it does.
 */
export const STRUCTURAL_EDGE_TYPES = new Set([
  'CONTAINS',
  'HAS_SCOPE',
  'DECLARES',
  'DEFINES',
  'HAS_CONDITION',
  'HAS_CASE',
  'HAS_DEFAULT',
  'HAS_CONSEQUENT',
  'HAS_ALTERNATE',
  'HAS_BODY',
  'HAS_INIT',
  'HAS_UPDATE',
  'HAS_CATCH',
  'HAS_FINALLY',
  'HAS_PARAMETER',
  'HAS_PROPERTY',
  'HAS_ELEMENT',
  'USES',
  'GOVERNS',
  'VIOLATES',
  'AFFECTS',
  'UNKNOWN',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeWithNode {
  edge: EdgeRecord;
  node: BaseNodeRecord | null;
}

export interface EdgeGroup {
  edgeType: string;
  edges: EdgeWithNode[];
}

export interface SourcePreview {
  file: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

export interface NodeContext {
  node: BaseNodeRecord;
  source: SourcePreview | null;
  outgoing: EdgeGroup[];
  incoming: EdgeGroup[];
}

export interface BuildNodeContextOptions {
  /** Lines of context before the highlighted line (default: 3) */
  contextLines?: number;
  /** Filter to only these edge types (null = show all) */
  edgeTypeFilter?: Set<string> | null;
  /**
   * DI callback for reading file content.
   * Return file content as string, or null if file can't be read.
   * Default uses fs.readFileSync.
   */
  readFileContent?: (filePath: string) => string | null;
}

// ---------------------------------------------------------------------------
// Default file reader
// ---------------------------------------------------------------------------

function defaultReadFileContent(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Build full node context: source preview + all edges with connected nodes.
 *
 * @param backend  - Graph backend for queries
 * @param node     - The node to build context for (already looked up by caller)
 * @param options  - Context options
 * @returns NodeContext with source preview and grouped edges
 */
export async function buildNodeContext(
  backend: GraphBackend,
  node: BaseNodeRecord,
  options: BuildNodeContextOptions = {},
): Promise<NodeContext> {
  const {
    contextLines = 3,
    edgeTypeFilter = null,
    readFileContent = defaultReadFileContent,
  } = options;

  // Source code preview
  let source: SourcePreview | null = null;
  if (node.file && node.line) {
    const content = readFileContent(node.file);
    if (content) {
      const allLines = content.split('\n');
      const line = node.line as number;
      const startLine = Math.max(1, line - contextLines);
      const endLine = Math.min(allLines.length, line + contextLines + 12);
      source = {
        file: node.file,
        startLine,
        endLine,
        lines: allLines.slice(startLine - 1, endLine),
      };
    }
  }

  // Outgoing edges
  const rawOutgoing = await backend.getOutgoingEdges(node.id);
  const outgoing = await groupEdges(backend, rawOutgoing, 'dst', edgeTypeFilter);

  // Incoming edges
  const rawIncoming = await backend.getIncomingEdges(node.id);
  const incoming = await groupEdges(backend, rawIncoming, 'src', edgeTypeFilter);

  return { node, source, outgoing, incoming };
}

// ---------------------------------------------------------------------------
// Edge grouping
// ---------------------------------------------------------------------------

/**
 * Group edges by type and resolve connected nodes.
 *
 * Sort order: non-structural edges first (alphabetical),
 * then structural edges (alphabetical).
 */
async function groupEdges(
  backend: GraphBackend,
  edges: EdgeRecord[],
  nodeField: 'src' | 'dst',
  edgeTypeFilter: Set<string> | null,
): Promise<EdgeGroup[]> {
  const groups = new Map<string, EdgeWithNode[]>();

  for (const edge of edges) {
    const edgeType = edge.type || 'UNKNOWN';

    // Apply edge type filter
    if (edgeTypeFilter && !edgeTypeFilter.has(edgeType)) continue;

    const connectedId = edge[nodeField];
    const connectedNode = await backend.getNode(connectedId);

    if (!groups.has(edgeType)) {
      groups.set(edgeType, []);
    }
    groups.get(edgeType)!.push({ edge, node: connectedNode });
  }

  // Sort groups: primary edges first, then structural
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      const aStructural = STRUCTURAL_EDGE_TYPES.has(a);
      const bStructural = STRUCTURAL_EDGE_TYPES.has(b);
      if (aStructural !== bStructural) return aStructural ? 1 : -1;
      return a.localeCompare(b);
    })
    .map(([edgeType, edgeList]) => ({ edgeType, edges: edgeList }));
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Get display name for a node based on its type.
 *
 * Special cases:
 * - HTTP routes: "METHOD /path"
 * - HTTP requests: "METHOD url"
 * - Socket.IO: event name
 * - Default: node.name or node.id
 */
export function getNodeDisplayName(node: BaseNodeRecord): string {
  // HTTP nodes: method + path/url
  if (node.type === 'http:route') {
    const method = node.method as string | undefined;
    const path = node.path as string | undefined;
    if (method && path) return `${method} ${path}`;
  }
  if (node.type === 'http:request') {
    const method = node.method as string | undefined;
    const url = node.url as string | undefined;
    if (method && url) return `${method} ${url}`;
  }

  // Socket.IO: event name
  if (node.type === 'socketio:emit' || node.type === 'socketio:on') {
    const event = node.event as string | undefined;
    if (event) return event;
  }

  // Default: name or ID fallback
  if (node.name && !node.name.startsWith('{')) return node.name;
  return node.id;
}

/**
 * Format edge metadata for inline display (only meaningful fields).
 *
 * Returns a string like "  [arg0]" or "" if no relevant metadata.
 */
export function formatEdgeMetadata(edge: EdgeRecord): string {
  const parts: string[] = [];
  const meta = edge.metadata || {};

  if (edge.type === 'PASSES_ARGUMENT' || edge.type === 'RECEIVES_ARGUMENT') {
    if ('argIndex' in meta) {
      parts.push(`arg${meta.argIndex}`);
    }
  }
  if (edge.type === 'FLOWS_INTO') {
    if ('mutationMethod' in meta) parts.push(`via ${meta.mutationMethod}`);
  }
  if (edge.type === 'HAS_PROPERTY') {
    if ('propertyName' in meta) parts.push(`key: ${meta.propertyName}`);
  }
  if (edge.type === 'ITERATES_OVER') {
    if ('iterates' in meta) parts.push(`${meta.iterates}`);
  }

  return parts.length > 0 ? `  [${parts.join(', ')}]` : '';
}
