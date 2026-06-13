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
export type { GrafemaConfig } from '@grafema/util';
export type { MCPConfig } from './config.js';

// === TOOL ARGUMENTS ===
export interface QueryGraphArgs {
  query: string;
  language?: 'datalog' | 'cypher';
  limit?: number;
  offset?: number;
  format?: 'table' | 'json' | 'tree';
  explain?: boolean;
  /** When true, returns only the count of matching results instead of the full result list */
  count?: boolean;
}

export interface ExplainFactArgs {
  /** The derived predicate (e.g. "depends"). */
  predicate: string;
  /** The fact's ground key tuple as wire-string terms (node ids as decimal, else string). */
  key: string[];
  /** Optional Datalog program (derive engine); empty/omitted ⇒ the bundled depends.dl. */
  source?: string;
}

export interface SimDatalogArgs {
  /** The derived predicate whose NEW facts to predict (e.g. "depends"). */
  predicate: string;
  /** Hypothetical nodes: { id (decimal string), nodeType, name?, file? }. May be new ids. */
  nodes?: Array<{ id: string; nodeType: string; name?: string; file?: string }>;
  /** Hypothetical edges: { src, dst, edgeType }; endpoints existing OR hypothetical ids. */
  edges?: Array<{ src: string; dst: string; edgeType: string }>;
  /** Optional Datalog program (derive engine); empty/omitted ⇒ the bundled depends.dl. */
  source?: string;
}

export interface ExplainGapArgs {
  /** The derived predicate of the MISSING fact (e.g. "depends"). */
  predicate: string;
  /** The missing fact's ground key tuple as wire-string terms (node ids as decimal). */
  key: string[];
  /** Optional Datalog program (derive engine); empty/omitted ⇒ the bundled depends.dl. */
  source?: string;
}

export interface FindCallsArgs {
  name: string;
  limit?: number;
  offset?: number;
  include_indirect?: boolean;
  className?: string;
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
  detail?: 'summary' | 'normal' | 'full';
}

export interface TraceCallChainArgs {
  source: string;
  file?: string;
  direction?: string;
  max_depth?: number;
}

export interface TraceEffectsArgs {
  node: string;
  file?: string;
  max_depth?: number;
}

export interface GetShapeArgs {
  target: string;
  file?: string;
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

export interface FindSharedBehaviorsArgs {
  /** Minimum cluster size to include. Default 2. */
  minClusterSize?: number;
  /** Maximum number of clusters to return. Default 100. */
  limit?: number;
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
  name?: string;  // Optional - some nodes (BRANCH, CASE, LOOP) don't have names
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
export type { CallInfo, CallerInfo, FindCallsOptions } from '@grafema/util';

/**
 * Datalog query result binding
 */
export interface DatalogBinding {
  name: string;
  value: string;
}

/**
 * Call result structure for filtering
 */
export interface CallResult {
  id: string;
  name?: string;
  object?: string;
  file?: string;
  line?: number;
  resolved: boolean;
  target: { type: string; name: string; file?: string; line?: number } | null;
}

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

// === NODE CONTEXT (REG-406) ===

export interface GetContextArgs {
  semanticId: string;
  contextLines?: number;
  edgeType?: string;
}

// === FILE OVERVIEW (REG-412) ===

export interface GetFileOverviewArgs {
  file: string;
  include_edges?: boolean;
}

// === PROJECT STRUCTURE (REG-173) ===

export interface ReadProjectStructureArgs {
  path?: string;
  depth?: number;
  include_files?: boolean;
}

// === WRITE CONFIG (REG-173) ===

export interface WriteConfigArgs {
  services?: Array<{
    name: string;
    path: string;
    entryPoint?: string;
  }>;
  plugins?: {
    indexing?: string[];
    analysis?: string[];
    enrichment?: string[];
    validation?: string[];
  };
  include?: string[];
  exclude?: string[];
  workspace?: {
    roots?: string[];
  };
}

// === Graph traversal tools (REG-521) ===

export interface GetNodeArgs {
  semanticId: string;
}

export interface GetNeighborsArgs {
  semanticId: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  edgeTypes?: string[];
}

export interface TraverseGraphArgs {
  startNodeIds: string[];
  edgeTypes: string[];
  maxDepth?: number;
  direction?: 'outgoing' | 'incoming';
}

// === KNOWLEDGE ARGS (REG-626) ===

export interface AddKnowledgeArgs {
  type: string;
  content: string;
  slug?: string;
  subtype?: string;
  scope?: string;
  relates_to?: string[];
  projections?: string[];
  status?: string;
  confidence?: string;
  effective_from?: string;
  applies_to?: string[];
  task_id?: string;
}

export interface QueryKnowledgeArgs {
  type?: string;
  projection?: string;
  relates_to?: string;
  text?: string;
  include_dangling_only?: boolean;
}

export interface QueryDecisionsArgs {
  module?: string;
  status?: string;
}

export interface SupersedeFactArgs {
  old_id: string;
  new_content: string;
  new_slug?: string;
}

// === ENOX ARGS (knowledge graph) ===

export interface EnoxRememberArgs {
  subject: string;
  fact: string;
  domain?: string;
  confidence?: number;
  relation?: string;
}

export interface EnoxRecallArgs {
  query: string;
  depth?: number;
}

export interface EnoxSemanticSearchArgs {
  query: string;
  top_k?: number;
  domain?: string;
  include_edges?: boolean;
}

export interface EnoxExploreArgs {
  entity: string;
}

export interface EnoxAddAssertionArgs {
  from: string;
  relation: string;
  to: string;
  context?: string;
  confidence?: number;
  domain?: string;
}

export interface EnoxUpdateAssertionArgs {
  fact_id: string;
  context?: string;
  confidence?: number;
}

export interface EnoxDeleteAssertionArgs {
  fact_id: string;
}

export interface EnoxQueryGraphArgs {
  type?: string;
  domain?: string;
  name?: string;
  limit?: number;
}

export interface EnoxTraverseArgs {
  start: string;
  direction?: string;
  edge_types?: string[];
  max_depth?: number;
}

export interface EnoxRecentActivityArgs {
  since?: string;
  limit?: number;
}

export interface EnoxUpdateNodeArgs {
  node_id: string;
  name?: string;
  domain?: string;
  description?: string;
}

export interface EnoxSaveDocumentArgs {
  title: string;
  content: string;
  doc_type?: string;
  relates_to?: string[];
}

// === DESCRIBE ARGS (DSL notation) ===

export interface DescribeArgs {
  target: string;
  depth?: number;
  perspective?: string;
}

// === GIT QUERY ARGS (REG-628) ===

export interface GitChurnArgs {
  limit?: number;
  since?: string;
}

export interface GitCoChangeArgs {
  file: string;
  min_support?: number;
}

export interface GitOwnershipArgs {
  file: string;
}

export interface GitArchaeologyArgs {
  file: string;
}

// === GRAPHQL ARGS (REG-666) ===

export interface GraphQLQueryArgs {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface QueryRegistryArgs {
  package?: string;
  symbol?: string;
}
