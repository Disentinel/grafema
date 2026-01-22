/**
 * RFDB Protocol Types - types for RFDB client-server protocol
 */

import type { NodeType } from './nodes.js';
import type { EdgeType } from './edges.js';

// === COMMANDS ===
export type RFDBCommand =
  // Write operations
  | 'addNodes'
  | 'addEdges'
  | 'deleteNode'
  | 'deleteEdge'
  | 'clear'
  | 'updateNodeVersion'
  // Read operations
  | 'getNode'
  | 'nodeExists'
  | 'findByType'
  | 'findByAttr'
  | 'queryNodes'
  | 'getAllNodes'
  | 'getAllEdges'
  | 'isEndpoint'
  | 'getNodeIdentifier'
  // Traversal
  | 'neighbors'
  | 'bfs'
  | 'dfs'
  | 'reachability'
  | 'getOutgoingEdges'
  | 'getIncomingEdges'
  // Stats
  | 'nodeCount'
  | 'edgeCount'
  | 'countNodesByType'
  | 'countEdgesByType'
  // Control
  | 'flush'
  | 'compact'
  | 'ping'
  | 'shutdown'
  // Datalog
  | 'datalogLoadRules'
  | 'datalogClearRules'
  | 'datalogQuery'
  | 'checkGuarantee';

// === WIRE FORMAT ===
// Nodes as sent over the wire
export interface WireNode {
  id: string;
  nodeType: NodeType;
  name: string;
  file: string;
  exported: boolean;
  metadata: string; // JSON string
}

// Edges as sent over the wire
export interface WireEdge {
  src: string;
  dst: string;
  edgeType: EdgeType;
  metadata: string; // JSON string
}

// === REQUEST TYPES ===
export interface RFDBRequest {
  cmd: RFDBCommand;
  [key: string]: unknown;
}

export interface AddNodesRequest extends RFDBRequest {
  cmd: 'addNodes';
  nodes: WireNode[];
}

export interface AddEdgesRequest extends RFDBRequest {
  cmd: 'addEdges';
  edges: WireEdge[];
  skipValidation?: boolean;
}

export interface DeleteNodeRequest extends RFDBRequest {
  cmd: 'deleteNode';
  id: string;
}

export interface DeleteEdgeRequest extends RFDBRequest {
  cmd: 'deleteEdge';
  src: string;
  dst: string;
  edgeType: EdgeType;
}

export interface GetNodeRequest extends RFDBRequest {
  cmd: 'getNode';
  id: string;
}

export interface NodeExistsRequest extends RFDBRequest {
  cmd: 'nodeExists';
  id: string;
}

export interface FindByTypeRequest extends RFDBRequest {
  cmd: 'findByType';
  nodeType: NodeType;
}

export interface FindByAttrRequest extends RFDBRequest {
  cmd: 'findByAttr';
  query: Record<string, unknown>;
}

export interface NeighborsRequest extends RFDBRequest {
  cmd: 'neighbors';
  id: string;
  edgeTypes?: EdgeType[];
}

export interface BfsRequest extends RFDBRequest {
  cmd: 'bfs';
  startIds: string[];
  maxDepth: number;
  edgeTypes?: EdgeType[];
}

export interface ReachabilityRequest extends RFDBRequest {
  cmd: 'reachability';
  startIds: string[];
  maxDepth: number;
  edgeTypes?: EdgeType[];
  backward: boolean;
}

export interface GetOutgoingEdgesRequest extends RFDBRequest {
  cmd: 'getOutgoingEdges';
  id: string;
  edgeTypes?: EdgeType[] | null;
}

export interface GetIncomingEdgesRequest extends RFDBRequest {
  cmd: 'getIncomingEdges';
  id: string;
  edgeTypes?: EdgeType[] | null;
}

export interface CountNodesByTypeRequest extends RFDBRequest {
  cmd: 'countNodesByType';
  types?: NodeType[] | null;
}

export interface CountEdgesByTypeRequest extends RFDBRequest {
  cmd: 'countEdgesByType';
  edgeTypes?: EdgeType[] | null;
}

// === RESPONSE TYPES ===
export interface RFDBResponse {
  error?: string;
  [key: string]: unknown;
}

export interface AddNodesResponse extends RFDBResponse {
  count?: number;
}

export interface AddEdgesResponse extends RFDBResponse {
  count?: number;
}

export interface GetNodeResponse extends RFDBResponse {
  node?: WireNode | null;
}

export interface NodeExistsResponse extends RFDBResponse {
  value: boolean;
}

export interface FindByTypeResponse extends RFDBResponse {
  ids: string[];
}

export interface FindByAttrResponse extends RFDBResponse {
  ids: string[];
}

export interface NeighborsResponse extends RFDBResponse {
  ids: string[];
}

export interface BfsResponse extends RFDBResponse {
  ids: string[];
}

export interface ReachabilityResponse extends RFDBResponse {
  ids: string[];
}

export interface GetEdgesResponse extends RFDBResponse {
  edges: WireEdge[];
}

export interface CountResponse extends RFDBResponse {
  count: number;
}

export interface CountsByTypeResponse extends RFDBResponse {
  counts: Record<string, number>;
}

export interface PingResponse extends RFDBResponse {
  pong: boolean;
  version: string;
}

// === ATTR QUERY ===
export interface AttrQuery {
  nodeType?: string;
  type?: string;
  kind?: string;
  name?: string;
  file?: string;
  exported?: boolean;
  version?: string;
}

// === DATALOG TYPES ===
export interface DatalogBinding {
  [key: string]: string;
}

export interface DatalogResult {
  bindings: DatalogBinding;
}

// === CLIENT INTERFACE ===
export interface IRFDBClient {
  readonly socketPath: string;
  readonly connected: boolean;

  // Connection
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<string | false>;
  shutdown(): Promise<void>;

  // Write operations
  addNodes(nodes: WireNode[]): Promise<AddNodesResponse>;
  addEdges(edges: WireEdge[], skipValidation?: boolean): Promise<AddEdgesResponse>;
  deleteNode(id: string): Promise<RFDBResponse>;
  deleteEdge(src: string, dst: string, edgeType: EdgeType): Promise<RFDBResponse>;
  clear(): Promise<RFDBResponse>;
  updateNodeVersion(id: string, version: string): Promise<RFDBResponse>;

  // Read operations
  getNode(id: string): Promise<WireNode | null>;
  nodeExists(id: string): Promise<boolean>;
  findByType(nodeType: NodeType): Promise<string[]>;
  findByAttr(query: Record<string, unknown>): Promise<string[]>;
  queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown>;
  getAllNodes(query?: AttrQuery): Promise<WireNode[]>;
  getAllEdges(): Promise<WireEdge[]>;
  isEndpoint(id: string): Promise<boolean>;
  getNodeIdentifier(id: string): Promise<string | null>;

  // Traversal
  neighbors(id: string, edgeTypes?: EdgeType[]): Promise<string[]>;
  bfs(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[]): Promise<string[]>;
  dfs(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[]): Promise<string[]>;
  reachability(startIds: string[], maxDepth: number, edgeTypes?: EdgeType[], backward?: boolean): Promise<string[]>;
  getOutgoingEdges(id: string, edgeTypes?: EdgeType[] | null): Promise<WireEdge[]>;
  getIncomingEdges(id: string, edgeTypes?: EdgeType[] | null): Promise<WireEdge[]>;

  // Stats
  nodeCount(): Promise<number>;
  edgeCount(): Promise<number>;
  countNodesByType(types?: NodeType[] | null): Promise<Record<string, number>>;
  countEdgesByType(edgeTypes?: EdgeType[] | null): Promise<Record<string, number>>;

  // Control
  flush(): Promise<RFDBResponse>;
  compact(): Promise<RFDBResponse>;

  // Datalog
  datalogLoadRules(source: string): Promise<number>;
  datalogClearRules(): Promise<RFDBResponse>;
  datalogQuery(query: string): Promise<DatalogResult[]>;
  checkGuarantee(ruleSource: string): Promise<DatalogResult[]>;
}
