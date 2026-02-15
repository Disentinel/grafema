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
  | 'checkGuarantee'
  // Protocol v2 - Multi-Database Commands
  | 'hello'
  | 'createDatabase'
  | 'openDatabase'
  | 'closeDatabase'
  | 'dropDatabase'
  | 'listDatabases'
  | 'currentDatabase'
  // Schema declaration
  | 'declareFields'
  // Snapshot operations
  | 'diffSnapshots'
  | 'tagSnapshot'
  | 'findSnapshot'
  | 'listSnapshots'
  // Batch operations
  | 'commitBatch';

// === WIRE FORMAT ===
// Nodes as sent over the wire
export interface WireNode {
  id: string;
  nodeType: NodeType;
  name: string;
  file: string;
  exported: boolean;
  metadata: string; // JSON string
  semanticId?: string; // Protocol v3: human-readable semantic ID
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
  requestId?: string;
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
  requestId?: string;
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

// === STREAMING RESPONSE TYPES ===

/**
 * A chunk of nodes in a streaming QueryNodes response.
 *
 * Sent by the server when the result set exceeds the streaming threshold
 * and the client negotiated protocol version >= 3.
 * Multiple NodesChunk messages share the same requestId. The client
 * accumulates chunks until `done === true`.
 *
 * Discrimination: if a response has a `done` field, it is a streaming chunk.
 * If it does not, it is a legacy single-shot `Nodes { nodes }` response.
 */
export interface NodesChunkResponse extends RFDBResponse {
  nodes: WireNode[];
  /** true = last chunk for this requestId; false = more chunks coming */
  done: boolean;
  /** 0-based chunk index for ordering verification */
  chunkIndex: number;
}

// === BATCH OPERATIONS ===

export interface CommitDelta {
  changedFiles: string[];
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  changedNodeTypes: string[];
  changedEdgeTypes: string[];
}

export interface CommitBatchRequest extends RFDBRequest {
  cmd: 'commitBatch';
  changedFiles: string[];
  nodes: WireNode[];
  edges: WireEdge[];
  tags?: string[];
}

export interface CommitBatchResponse extends RFDBResponse {
  ok: boolean;
  delta: CommitDelta;
}

// === PROTOCOL V2 - MULTI-DATABASE RESPONSES ===

export interface HelloResponse extends RFDBResponse {
  ok: boolean;
  protocolVersion: number;
  serverVersion: string;
  features: string[];
}

export interface CreateDatabaseResponse extends RFDBResponse {
  ok: boolean;
  databaseId: string;
}

export interface OpenDatabaseResponse extends RFDBResponse {
  ok: boolean;
  databaseId: string;
  mode: string;
  nodeCount: number;
  edgeCount: number;
}

export interface DatabaseInfo {
  name: string;
  ephemeral: boolean;
  nodeCount: number;
  edgeCount: number;
  connectionCount: number;
}

export interface ListDatabasesResponse extends RFDBResponse {
  databases: DatabaseInfo[];
}

export interface CurrentDatabaseResponse extends RFDBResponse {
  database: string | null;
  mode: string | null;
}

// === ATTR QUERY ===
export interface AttrQuery {
  nodeType?: string;
  type?: string;
  kind?: string;
  name?: string;
  file?: string;
  exported?: boolean;
  /** @deprecated Node-level version filter is legacy. In v2, use snapshot/tag APIs for history. */
  version?: string;
  /** Extra fields are matched against node metadata JSON (e.g. object, method, async) */
  [key: string]: string | boolean | number | undefined;
}

// === FIELD DECLARATION ===
/** Declaration of a metadata field for server-side indexing. */
export interface FieldDeclaration {
  /** Field name as it appears in metadata JSON (e.g. "object", "method", "async") */
  name: string;
  /** Field type hint for storage optimization */
  fieldType?: 'string' | 'bool' | 'int' | 'id';
  /** Restrict indexing to specific node types. If omitted, indexes all node types. */
  nodeTypes?: NodeType[];
}

// === DATALOG TYPES ===
export interface DatalogBinding {
  [key: string]: string;
}

export interface DatalogResult {
  bindings: DatalogBinding;
}

// === SNAPSHOT TYPES ===

/**
 * Reference to a snapshot — either by version number or by tag key/value pair.
 *
 * When used as a number, refers to the snapshot at that version.
 * When used as an object, resolves the snapshot tagged with the given key/value.
 */
export type SnapshotRef = number | { tag: string; value: string };

/**
 * Aggregate statistics for a snapshot (mirrors Rust ManifestStats).
 *
 * Wire format: camelCase (Rust snake_case fields mapped via serde rename).
 */
export interface SnapshotStats {
  totalNodes: number;
  totalEdges: number;
  nodeSegmentCount: number;
  edgeSegmentCount: number;
}

/**
 * Segment descriptor — describes a single data segment in a snapshot.
 *
 * Simplified view of Rust SegmentDescriptor. Exposes fields relevant to
 * client-side diff analysis. Internal fields (segmentType, shardId) omitted.
 *
 * Wire format: camelCase. HashSet<String> serializes as string[].
 */
export interface SegmentInfo {
  segmentId: number;
  recordCount: number;
  byteSize: number;
  nodeTypes: string[];
  filePaths: string[];
  edgeTypes: string[];
}

/**
 * Diff between two snapshots (from -> to).
 *
 * Shows which segments were added/removed and stats for both versions.
 * Mirrors Rust SnapshotDiff (storage_v2/manifest.rs).
 */
export interface SnapshotDiff {
  fromVersion: number;
  toVersion: number;
  addedNodeSegments: SegmentInfo[];
  removedNodeSegments: SegmentInfo[];
  addedEdgeSegments: SegmentInfo[];
  removedEdgeSegments: SegmentInfo[];
  statsFrom: SnapshotStats;
  statsTo: SnapshotStats;
}

/**
 * Lightweight snapshot information for list operations.
 *
 * Mirrors Rust SnapshotInfo (storage_v2/manifest.rs).
 * createdAt is Unix epoch seconds (u64 in Rust).
 */
export interface SnapshotInfo {
  version: number;
  createdAt: number;
  tags: Record<string, string>;
  stats: SnapshotStats;
}

// Snapshot response types

export interface DiffSnapshotsResponse extends RFDBResponse {
  diff: SnapshotDiff;
}

export interface FindSnapshotResponse extends RFDBResponse {
  version: number | null;
}

export interface ListSnapshotsResponse extends RFDBResponse {
  snapshots: SnapshotInfo[];
}

// === CLIENT INTERFACE ===
export interface IRFDBClient {
  readonly socketPath: string;
  readonly connected: boolean;
  readonly supportsStreaming: boolean;

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
  declareFields(fields: FieldDeclaration[]): Promise<number>;

  // Read operations
  getNode(id: string): Promise<WireNode | null>;
  nodeExists(id: string): Promise<boolean>;
  findByType(nodeType: NodeType): Promise<string[]>;
  findByAttr(query: Record<string, unknown>): Promise<string[]>;
  queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown>;
  queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown>;
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

  // Batch operations
  beginBatch(): void;
  commitBatch(tags?: string[]): Promise<CommitDelta>;
  abortBatch(): void;
  isBatching(): boolean;
  findDependentFiles(changedFiles: string[]): Promise<string[]>;

  // Protocol v2 - Multi-Database
  hello(protocolVersion?: number): Promise<HelloResponse>;
  createDatabase(name: string, ephemeral?: boolean): Promise<CreateDatabaseResponse>;
  openDatabase(name: string, mode?: 'rw' | 'ro'): Promise<OpenDatabaseResponse>;
  closeDatabase(): Promise<RFDBResponse>;
  dropDatabase(name: string): Promise<RFDBResponse>;
  listDatabases(): Promise<ListDatabasesResponse>;
  currentDatabase(): Promise<CurrentDatabaseResponse>;

  // Snapshot operations
  diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff>;
  tagSnapshot(version: number, tags: Record<string, string>): Promise<void>;
  findSnapshot(tagKey: string, tagValue: string): Promise<number | null>;
  listSnapshots(filterTag?: string): Promise<SnapshotInfo[]>;
}
