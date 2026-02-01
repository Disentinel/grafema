/**
 * MCP Server Types
 */

import type { WriteStream } from 'fs';

// === ANALYSIS STATUS ===
export interface AnalysisTimings {
  discovery: number | null;
  indexing: number | null;
  analysis: number | null;
  enrichment: number | null;
  validation: number | null;
  total: number | null;
}

export interface AnalysisStatus {
  running: boolean;
  phase: string | null;
  message: string | null;
  servicesDiscovered: number;
  servicesAnalyzed: number;
  startTime: number | null;
  endTime: number | null;
  error: string | null;
  timings: AnalysisTimings;
}

// === PAGINATION ===
export interface PaginationParams {
  limit: number;
  offset: number;
  returned: number;
  total?: number;
  hasMore: boolean;
}

// === CONFIG ===
export type { GrafemaConfig } from '@grafema/core';
export type { MCPConfig } from './config.js';

// === TOOL ARGUMENTS ===
export interface QueryGraphArgs {
  query: string;
  limit?: number;
  offset?: number;
  format?: 'table' | 'json' | 'tree';
}

export interface FindCallsArgs {
  target: string;
  limit?: number;
  offset?: number;
  include_indirect?: boolean;
}

export interface TraceAliasArgs {
  variableName: string;
  file?: string;
  max_depth?: number;
}

export interface TraceDataFlowArgs {
  source: string;
  file?: string;
  direction?: 'forward' | 'backward' | 'both';
  max_depth?: number;
  limit?: number;
}

export interface CheckInvariantArgs {
  rule: string;
  name?: string;
}

export interface GetSchemaArgs {
  type?: 'nodes' | 'edges' | 'all';
}

export interface GetValueSetArgs {
  node_id: string;
  property?: string;
}

export interface FindNodesArgs {
  type?: string;
  name?: string;
  file?: string;
  limit?: number;
  offset?: number;
}

export interface AnalyzeProjectArgs {
  service?: string;
  force?: boolean;
  index_only?: boolean;
}

export interface GetCoverageArgs {
  path?: string;
  depth?: number;
}

export interface GetDocumentationArgs {
  topic?: string;
}

// === GUARANTEE ARGS ===

// Priority levels for contract-based guarantees
export type GuaranteePriority = 'critical' | 'important' | 'observed' | 'tracked';

// Lifecycle status for contract-based guarantees
export type GuaranteeStatus = 'discovered' | 'reviewed' | 'active' | 'changing' | 'deprecated';

export interface CreateGuaranteeArgs {
  name: string;
  // Datalog-based guarantee fields (optional for contract-based)
  rule?: string;
  description?: string;
  severity?: 'error' | 'warning' | 'info';
  // Contract-based guarantee fields
  type?: 'guarantee:queue' | 'guarantee:api' | 'guarantee:permission';
  priority?: GuaranteePriority;
  status?: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  governs?: string[]; // Node IDs that this guarantee governs
}

export interface CheckGuaranteesArgs {
  names?: string[];
}

export interface DeleteGuaranteeArgs {
  name: string;
}

export interface ExportGuaranteesArgs {
  format?: 'json' | 'yaml';
}

export interface ImportGuaranteesArgs {
  guarantees: Array<{
    name: string;
    rule: string;
    description?: string;
    severity?: string;
  }>;
  merge?: boolean;
}

export interface GuaranteeDriftArgs {
  baseline?: string;
}

export interface CheckGuaranteeFeasibilityArgs {
  rule: string;
}

// === TOOL RESULT ===
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// === BACKEND INTERFACE (minimal) ===
export interface GraphBackend {
  nodeCount(): Promise<number>;
  edgeCount(): Promise<number>;
  countNodesByType(types?: string[] | null): Promise<Record<string, number>>;
  countEdgesByType(types?: string[] | null): Promise<Record<string, number>>;
  getNode(id: string): Promise<GraphNode | null>;
  findByType(type: string): Promise<string[]>;
  findByAttr(query: Record<string, unknown>): Promise<string[]>;
  getOutgoingEdges(id: string, types?: string[] | null): Promise<GraphEdge[]>;
  getIncomingEdges(id: string, types?: string[] | null): Promise<GraphEdge[]>;
  queryNodes(filter: Record<string, unknown>): AsyncIterable<GraphNode>;
  getAllNodes(filter?: Record<string, unknown>): Promise<GraphNode[]>;
  runDatalogQuery?(query: string): Promise<unknown[]>;
  close?(): Promise<void>;
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: string;
  edgeType?: string;
  [key: string]: unknown;
}

// === GLOBAL STATE ===
export interface MCPState {
  projectPath: string;
  backend: GraphBackend | null;
  isAnalyzed: boolean;
  analysisStatus: AnalysisStatus;
  logStream: WriteStream | null;
  backgroundPid: number | null;
}

// === FILE CLASSIFICATION ===
export interface FileClassification {
  category: 'source' | 'config' | 'test' | 'doc' | 'asset' | 'generated' | 'other';
  language?: string;
  framework?: string;
}

export interface ExtensionGroup {
  [ext: string]: string[];
}

export interface AnalyzerSuggestion {
  name: string;
  reason: string;
  priority: number;
}

// === BUG REPORTING ===
export interface ReportIssueArgs {
  title: string;
  description: string;
  context?: string;
  labels?: string[];
}

// === FIND GUARDS (REG-274) ===

/**
 * Arguments for find_guards tool
 */
export interface FindGuardsArgs {
  nodeId: string;  // ID of any node (CALL, VARIABLE, etc.)
}

// === GET FUNCTION DETAILS (REG-254) ===

/**
 * Arguments for get_function_details tool
 */
export interface GetFunctionDetailsArgs {
  /** Function name to look up */
  name: string;
  /** Optional: file path to disambiguate if multiple functions have same name */
  file?: string;
  /** Follow call chains recursively (A -> B -> C) */
  transitive?: boolean;
}

// Re-export types from core for convenience
export type { CallInfo, CallerInfo, FindCallsOptions } from '@grafema/core';

/**
 * Information about a conditional guard (SCOPE node)
 */
export interface GuardInfo {
  scopeId: string;
  scopeType: string;          // 'if_statement' | 'else_statement' | etc.
  condition?: string;         // Raw condition text
  constraints?: unknown[];    // Parsed constraints
  file: string;
  line: number;
}
