/**
 * GraphBackend - abstract base class for graph storage implementations
 *
 * This defines the full contract for graph storage backends.
 * All operations are async for compatibility with disk-based storage.
 *
 * Implementations:
 * - RFDBServerBackend (Rust-based, production)
 * - TestBackend (wrapper over RFDBServerBackend for tests)
 */

import type { NodeRecord } from '@grafema/types';
import type { EdgeRecord, EdgeType } from '@grafema/types';

// Re-export types for convenience
export type { NodeRecord as Node } from '@grafema/types';
export type { EdgeRecord as Edge, EdgeType } from '@grafema/types';

/**
 * Query filter for finding nodes by attributes
 */
export interface AttrQuery {
  kind?: number;
  version?: string;
  file_id?: string;
  file?: string;
  exported?: boolean;
  type?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Graph statistics
 */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
}

/**
 * Exported graph data
 */
export interface GraphExport {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

/**
 * Abstract GraphBackend class - base for all graph storage implementations
 */
export abstract class GraphBackend {
  /**
   * Initialize backend
   */
  abstract initialize(): Promise<void>;

  /**
   * Connect to storage (alias for initialize)
   */
  async connect(): Promise<void> {
    return this.initialize();
  }

  /**
   * Close connection and flush data to disk
   */
  abstract close(): Promise<void>;

  /**
   * Clear all data
   */
  abstract clear(): Promise<void>;

  // ========================================
  // Node Operations
  // ========================================

  /**
   * Add a single node
   */
  abstract addNode(node: NodeRecord): Promise<void>;

  /**
   * Add multiple nodes (batch operation)
   */
  abstract addNodes(nodes: NodeRecord[]): Promise<void>;

  /**
   * Get node by ID
   */
  abstract getNode(id: string): Promise<NodeRecord | null>;

  /**
   * Check if node exists
   */
  abstract nodeExists(id: string): Promise<boolean>;

  /**
   * Delete a node
   */
  abstract deleteNode(id: string): Promise<void>;

  /**
   * Find nodes by attributes
   * @returns Array of node IDs
   */
  abstract findByAttr(query: AttrQuery): Promise<string[]>;

  // ========================================
  // Edge Operations
  // ========================================

  /**
   * Add a single edge
   */
  abstract addEdge(edge: EdgeRecord): Promise<void>;

  /**
   * Add multiple edges (batch operation)
   */
  abstract addEdges(edges: EdgeRecord[]): Promise<void>;

  /**
   * Delete an edge
   */
  abstract deleteEdge(src: string, dst: string, type: string): Promise<void>;

  /**
   * Get outgoing edges from a node
   * @param nodeId - Node ID
   * @param edgeTypes - Filter by edge types (optional)
   */
  abstract getOutgoingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;

  /**
   * Get incoming edges to a node
   * @param nodeId - Node ID
   * @param edgeTypes - Filter by edge types (optional)
   */
  abstract getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;

  // ========================================
  // Graph Traversal
  // ========================================

  /**
   * BFS traversal from start nodes
   * @param startIds - Starting nodes
   * @param maxDepth - Maximum depth
   * @param edgeTypes - Edge types to traverse (as numbers)
   * @returns Array of reachable node IDs
   */
  abstract bfs(startIds: string[], maxDepth: number, edgeTypes: number[]): Promise<string[]>;

  // ========================================
  // Persistence
  // ========================================

  /**
   * Flush data to disk
   */
  abstract flush(): Promise<void>;

  /**
   * Get graph statistics
   */
  abstract getStats(): Promise<GraphStats>;

  // ========================================
  // Compatibility Methods (for tests and GUI)
  // ========================================

  /**
   * Export entire graph to memory (only for tests!)
   * WARNING: Do not use on large graphs
   */
  abstract export(): Promise<GraphExport>;

  /**
   * Find nodes by predicate (for demo-gui compatibility)
   * WARNING: May be slow on large graphs
   */
  abstract findNodes(predicate: (node: NodeRecord) => boolean): Promise<NodeRecord[]>;

  /**
   * Get all nodes (for GUI - only for first level visualization)
   * WARNING: Do not use on large graphs
   */
  abstract getAllNodes(): Promise<NodeRecord[]>;

  /**
   * Get all edges (for GUI)
   * WARNING: Do not use on large graphs
   */
  abstract getAllEdges(): Promise<EdgeRecord[]>;
}

/**
 * Node type to numeric kind mapping
 */
const NODE_TYPE_TO_KIND: Record<string, number> = {
  'PROJECT': 1,
  'SERVICE': 2,
  'FUNCTION': 3,
  'CLASS': 4,
  'METHOD': 5,
  'VARIABLE': 6,
  'PARAMETER': 7,
  'MODULE': 8,
  'ROUTE': 9,
  'ENDPOINT': 10,
  'FILE': 11,
  'EXTERNAL_MODULE': 12,
  'IMPORT': 13,
  'EXPORT': 14,
  'CALL_SITE': 15,
  'METHOD_CALL': 16,
  'SCOPE': 17,
  'VARIABLE_DECLARATION': 18,
  'CONSTANT': 19,
  'EVENT_LISTENER': 20,
  'HTTP_REQUEST': 21,
};

/**
 * Convert node type to numeric kind
 */
export function typeToKind(type: string): number {
  return NODE_TYPE_TO_KIND[type] || 0;
}

/**
 * Edge type to numeric mapping
 */
const EDGE_TYPE_TO_NUMBER: Record<string, number> = {
  'CONTAINS': 1,
  'DEPENDS_ON': 2,
  'CALLS': 3,
  'EXTENDS': 4,
  'IMPLEMENTS': 5,
  'USES': 6,
  'DEFINES': 7,
  'IMPORTS': 8,
  'EXPORTS': 9,
  'ROUTES_TO': 10,
  'DECLARES': 11,
  'HAS_SCOPE': 12,
  'CAPTURES': 13,
  'MODIFIES': 14,
  'WRITES_TO': 15,
  'INSTANCE_OF': 16,
  'HANDLED_BY': 17,
  'HAS_CALLBACK': 18,
  'MAKES_REQUEST': 19,
  'IMPORTS_FROM': 20,
  'EXPORTS_TO': 21,
};

/**
 * Convert edge type to number
 */
export function edgeTypeToNumber(type: string): number {
  return EDGE_TYPE_TO_NUMBER[type] || 0;
}
