/**
 * Shared public types for the RFDB server backend.
 *
 * Extracted from RFDBServerBackend.ts (REG-490) so the connection, data, and
 * query layers can share these declarations without a circular dependency.
 * RFDBServerBackend.ts re-exports every symbol here, so existing deep imports
 * (`@grafema/util` / `.../backends/RFDBServerBackend`) keep working unchanged.
 */

import type { NodeType } from '@grafema/types';
import type { GraphStats } from '../../core/GraphBackend.js';

/**
 * Options for RFDBServerBackend
 */
export interface RFDBServerBackendOptions {
  socketPath?: string;
  dbPath?: string;
  /**
   * If true, automatically start the server if not running.
   * If false, require explicit `grafema server start`.
   * Default: true (for backwards compatibility)
   */
  autoStart?: boolean;
  /**
   * If true, suppress all console output (for clean CLI progress).
   * Default: false
   */
  silent?: boolean;
  /**
   * Name identifying this client in server logs (e.g. 'cli', 'mcp', 'core').
   * Default: 'core'
   */
  clientName?: string;
}

/**
 * Input node format (flexible)
 */
export interface InputNode {
  id: string;
  type?: string;
  nodeType?: string;
  node_type?: string;
  name?: string;
  file?: string;
  exported?: boolean;
  [key: string]: unknown;
}

/**
 * Input edge format (flexible)
 */
export interface InputEdge {
  src: string;
  dst: string;
  type?: string;
  edgeType?: string;
  edge_type?: string;
  [key: string]: unknown;
}

/**
 * Query for finding nodes
 */
export interface NodeQuery {
  nodeType?: NodeType;
  type?: NodeType;
  name?: string;
  file?: string;
  substringMatch?: boolean;
}

/**
 * Backend statistics
 */
export interface BackendStats extends GraphStats {
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
}
