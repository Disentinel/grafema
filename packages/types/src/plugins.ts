/**
 * Plugin Types - types for analysis plugins
 */

import type { NodeType, NodeRecord } from './nodes.js';
import type { EdgeType, EdgeRecord } from './edges.js';

// === PLUGIN PHASES ===
export const PLUGIN_PHASE = {
  DISCOVERY: 'DISCOVERY',
  INDEXING: 'INDEXING',
  ANALYSIS: 'ANALYSIS',
  ENRICHMENT: 'ENRICHMENT',
  VALIDATION: 'VALIDATION',
} as const;

export type PluginPhase = typeof PLUGIN_PHASE[keyof typeof PLUGIN_PHASE];

// === PLUGIN METADATA ===
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  priority?: number;
  creates?: {
    nodes?: NodeType[];
    edges?: EdgeType[];
  };
  dependencies?: string[];
}

// === PLUGIN CONTEXT ===
// Manifest varies by phase (UnitManifest, DiscoveryManifest, or full Manifest)
// Using unknown to allow all manifest types
export interface PluginContext {
  manifest?: unknown;
  graph: GraphBackend;
  config?: OrchestratorConfig;
  phase?: PluginPhase;
  projectPath?: string;  // Available during DISCOVERY phase
  onProgress?: (info: Record<string, unknown>) => void;
  forceAnalysis?: boolean;
  workerCount?: number;
  /**
   * Set of file paths already processed ("touched") in this analysis run.
   * Used for idempotent re-analysis: first touch clears all nodes for that file,
   * subsequent touches are no-ops. Only populated when forceAnalysis=true.
   */
  touchedFiles?: Set<string>;
}

// === PLUGIN RESULT ===
export interface PluginResult {
  success: boolean;
  created: {
    nodes: number;
    edges: number;
  };
  errors: Error[];
  warnings: string[];
  metadata?: Record<string, unknown>;
}

// === MANIFEST ===
export interface Manifest {
  services: ManifestService[];
  entrypoints: ManifestEntrypoint[];
  projectPath: string;
}

export interface ManifestService {
  id: string;
  name: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface ManifestEntrypoint {
  id: string;
  name: string;
  file: string;
  type: string;
  trigger?: string;
}

// === ORCHESTRATOR CONFIG ===
export interface OrchestratorConfig {
  projectPath: string;
  plugins?: string[];
  phases?: PluginPhase[];
  parallel?: boolean;
  maxWorkers?: number;
  verbose?: boolean;
}

// === GRAPH BACKEND INTERFACE ===
// Flexible input types for graph operations
export interface InputNode {
  id: string;
  type?: string;
  nodeType?: string;
  name?: string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

export interface InputEdge {
  src: string;
  dst: string;
  type: string;
  [key: string]: unknown;
}

// Minimal interface for graph operations
export interface GraphBackend {
  addNode(node: InputNode): Promise<void> | void;
  addEdge(edge: InputEdge): Promise<void> | void;
  addNodes(nodes: InputNode[]): Promise<void> | void;
  addEdges(edges: InputEdge[]): Promise<void> | void;

  getNode(id: string): Promise<NodeRecord | null>;
  queryNodes(filter: NodeFilter): AsyncIterable<NodeRecord> | AsyncGenerator<NodeRecord>;
  getAllNodes(filter?: NodeFilter): Promise<NodeRecord[]>;

  getOutgoingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;

  nodeCount(): Promise<number>;
  edgeCount(): Promise<number>;

  // For GUI/export - use with caution on large graphs
  getAllEdges?(): Promise<EdgeRecord[]>;

  // Extended query methods
  countNodesByType(types?: string[] | null): Promise<Record<string, number>>;
  countEdgesByType(types?: string[] | null): Promise<Record<string, number>>;
  findByType?(type: string): Promise<string[]>;
  findByAttr?(query: Record<string, unknown>): Promise<string[]>;
  runDatalogQuery?(query: string): Promise<unknown[]>;
  checkGuarantee?(query: string): unknown[] | Promise<unknown[]>;

  // Optional delete methods
  deleteNode?(id: string): Promise<void>;
  deleteEdge?(src: string, dst: string, type: string): Promise<void>;
  clear?(): Promise<void>;

  // Optional persistence
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface NodeFilter {
  type?: NodeType;
  nodeType?: NodeType;  // Alias for type (backward compatibility)
  name?: string;
  file?: string;
  [key: string]: unknown;
}

// === PLUGIN BASE CLASS TYPE ===
export interface IPlugin {
  config: Record<string, unknown>;
  metadata: PluginMetadata;
  initialize?(context: PluginContext): Promise<void>;
  execute(context: PluginContext): Promise<PluginResult>;
  cleanup?(): Promise<void>;
}

// === HELPER FUNCTIONS ===
export function createSuccessResult(
  created: { nodes: number; edges: number } = { nodes: 0, edges: 0 },
  metadata: Record<string, unknown> = {}
): PluginResult {
  return {
    success: true,
    created,
    errors: [],
    warnings: [],
    metadata,
  };
}

export function createErrorResult(
  error: Error,
  created: { nodes: number; edges: number } = { nodes: 0, edges: 0 }
): PluginResult {
  return {
    success: false,
    created,
    errors: [error],
    warnings: [],
    metadata: {},
  };
}
