/**
 * Plugin Types - types for analysis plugins
 */

import type { NodeType, NodeRecord } from './nodes.js';
import type { EdgeType, EdgeRecord } from './edges.js';
import type { AnyBrandedNode } from './branded.js';
import type { FieldDeclaration, CommitDelta } from './rfdb.js';
import type { ResourceRegistry } from './resources.js';
import type { RoutingRule } from './routing.js';
import type { InfrastructureConfig } from './infrastructure.js';

// === LOG LEVEL ===
/**
 * Log level for controlling verbosity.
 * Levels are ordered by verbosity: silent < errors < warnings < info < debug
 */
export type LogLevel = 'silent' | 'errors' | 'warnings' | 'info' | 'debug';

// === LOGGER INTERFACE ===
/**
 * Logger interface for structured logging.
 * Plugins should use context.logger instead of console.log for controllable output.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

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
  creates?: {
    nodes?: NodeType[];
    edges?: EdgeType[];
  };
  dependencies?: string[];
  /** Metadata fields this plugin writes. Used for RFDB server-side indexing. */
  fields?: FieldDeclaration[];
  /**
   * Package names this analyzer covers (for coverage tracking).
   * Only used by package-specific analyzers.
   * Examples: ['sqlite3'], ['@prisma/client'], ['lodash']
   */
  covers?: string[];
  /** Edge types this plugin reads from the graph (RFD-2). Used for automatic dependency inference. */
  consumes?: EdgeType[];
  /** Edge types this plugin creates/modifies (RFD-2). Used for automatic dependency inference. */
  produces?: EdgeType[];
  /** Plugin manages its own beginBatch/commitBatch calls (e.g., per-module commits). PhaseRunner skips batch wrapping. */
  managesBatch?: boolean;
}

// === ISSUE SPEC ===
/**
 * Specification for creating an issue node via reportIssue().
 * Used by validation plugins to persist detected problems in the graph.
 */
export interface IssueSpec {
  /** Issue category (e.g., 'security', 'performance', 'style', 'smell') */
  category: string;
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable description of the issue */
  message: string;
  /** File where the issue was detected */
  file: string;
  /** Line number */
  line: number;
  /** Column number (optional, defaults to 0) */
  column?: number;
  /** ID of the node that this issue affects (creates AFFECTS edge) */
  targetNodeId?: string;
  /** Additional context data for the issue */
  context?: Record<string, unknown>;
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
  /**
   * Logger instance for structured logging.
   * Use this instead of console.log for controllable verbosity via CLI flags.
   */
  logger?: Logger;
  /**
   * Report an issue to persist in the graph (VALIDATION phase only).
   * Creates an issue:* node and optionally an AFFECTS edge to targetNodeId.
   * @returns The ID of the created issue node
   */
  reportIssue?(issue: IssueSpec): Promise<string>;
  /**
   * Strict mode flag. When true, enrichers should report unresolved
   * references as fatal errors instead of silently continuing.
   * Default: false (graceful degradation).
   */
  strictMode?: boolean;

  /**
   * Root prefix for multi-root workspace support (REG-76).
   * When indexing a workspace with multiple roots, this is the root's
   * basename (e.g., "backend", "frontend"). Used to prefix file paths
   * in semantic IDs to prevent collisions.
   *
   * Example:
   * - Single root (undefined): "src/utils.js->global->FUNCTION->foo"
   * - Multi root ("backend"): "backend/src/utils.js->global->FUNCTION->foo"
   */
  rootPrefix?: string;

  /**
   * Resource registry for shared data between plugins (REG-256).
   * Plugins can read/write typed Resources through this registry.
   * Available in all phases. Created by Orchestrator at run start.
   */
  resources?: ResourceRegistry;

  /**
   * When true, commitBatch should defer index rebuilding (REG-487).
   * Used during initial/full analysis for O(1) per-commit cost.
   * Caller must send rebuildIndexes() after all deferred commits complete.
   */
  deferIndexing?: boolean;
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
  /**
   * Log level for controlling verbosity.
   * Defaults to 'info'. Use 'silent' to suppress all output, 'debug' for verbose.
   */
  logLevel?: LogLevel;
  /**
   * Optional explicit service definitions to bypass auto-discovery.
   * If provided and non-empty, discovery plugins are skipped.
   * Services are resolved relative to projectPath.
   */
  services?: ServiceDefinition[];

  /**
   * Glob patterns for files to include during indexing.
   * If specified, only files matching at least one pattern are processed.
   * Patterns are matched against relative paths from project root.
   * Uses minimatch syntax (e.g., "src/**.ts", "lib/**.js").
   *
   * Default: undefined (process all files reachable from entrypoint)
   */
  include?: string[];

  /**
   * Glob patterns for files to exclude during indexing.
   * Files matching any pattern are skipped (not processed, imports not followed).
   * Patterns are matched against relative paths from project root.
   * Uses minimatch syntax.
   *
   * Default: undefined (no exclusions beyond npm packages)
   *
   * Note: node_modules is already excluded by default in JSModuleIndexer.
   */
  exclude?: string[];

  /**
   * Routing rules from config for cross-service URL mapping (REG-256).
   * Passed through to plugins via PluginContext.config.
   */
  routing?: RoutingRule[];

  /** Infrastructure analysis configuration (USG Phase 1) */
  infrastructure?: InfrastructureConfig;
}

/**
 * Explicit service definition for configuration.
 * Allows users to manually specify services when auto-discovery doesn't work.
 *
 * @example
 * ```yaml
 * services:
 *   - name: "backend"
 *     path: "apps/backend"
 *     entryPoint: "src/index.ts"
 * ```
 */
export interface ServiceDefinition {
  /** Unique service identifier (used for graph node ID) */
  name: string;

  /** Service directory path relative to project root */
  path: string;

  /**
   * Optional entry point file path relative to service path.
   * If omitted, auto-detected via resolveSourceEntrypoint() or package.json.main
   */
  entryPoint?: string;

  /**
   * Mark this service as customer-facing (REG-256).
   * Routes in customer-facing services are expected to have frontend consumers.
   * Unconnected routes in customer-facing services raise issue:connectivity warnings.
   * Default: false (no issues for unconnected routes).
   */
  customerFacing?: boolean;
}

// === GRAPH BACKEND INTERFACE ===
export interface InputEdge {
  src: string;
  dst: string;
  type: string;
  [key: string]: unknown;
}

// Minimal interface for graph operations
export interface GraphBackend {
  addNode(node: AnyBrandedNode): Promise<void> | void;
  addEdge(edge: InputEdge): Promise<void> | void;
  addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;
  addEdges(edges: InputEdge[]): Promise<void> | void;

  getNode(id: string): Promise<NodeRecord | null>;
  queryNodes(filter: NodeFilter): AsyncIterable<NodeRecord> | AsyncGenerator<NodeRecord>;

  getOutgoingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;

  nodeCount(): Promise<number>;
  edgeCount(): Promise<number>;

  // Extended query methods
  countNodesByType(types?: string[] | null): Promise<Record<string, number>>;
  countEdgesByType(types?: string[] | null): Promise<Record<string, number>>;
  findByType?(type: string): Promise<string[]>;
  findByAttr?(query: Record<string, unknown>): Promise<string[]>;
  runDatalogQuery?(query: string): Promise<unknown[]>;
  checkGuarantee?(query: string): unknown[] | Promise<unknown[]>;

  // Delete methods
  deleteNode?(id: string): Promise<void>;
  deleteEdge?(src: string, dst: string, type: string): Promise<void>;
  clear(): Promise<void>;

  // Optional persistence
  flush?(): Promise<void>;
  close?(): Promise<void>;

  // Schema declaration
  declareFields?(fields: FieldDeclaration[]): Promise<number>;

  // Batch operations (RFD-16: CommitBatch protocol)
  beginBatch?(): void;
  commitBatch?(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta>;
  abortBatch?(): void;

  // Deferred indexing (REG-487: bulk load optimization)
  rebuildIndexes?(): Promise<void>;
  createBatch?(): unknown;

  // Synchronous batch operations (REG-483: direct batch insertion)
  batchNode?(node: AnyBrandedNode): void;
  batchEdge?(edge: InputEdge): void;
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
  metadata: Record<string, unknown> = {},
  errors: Error[] = []
): PluginResult {
  return {
    success: true,
    created,
    errors,
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
