/**
 * BaseRFDBClient - Abstract base class for RFDB transport clients
 *
 * Contains all graph operation methods that delegate to abstract _send().
 * Subclasses provide the transport layer (Unix socket, WebSocket, etc.)
 */

import { EventEmitter } from 'events';

import type {
  RFDBCommand,
  WireNode,
  WireEdge,
  RFDBResponse,
  IRFDBClient,
  AttrQuery,
  FieldDeclaration,
  DatalogResult,
  DatalogExplainResult,
  NodeType,
  EdgeType,
  HelloResponse,
  CreateDatabaseResponse,
  OpenDatabaseResponse,
  ListDatabasesResponse,
  CurrentDatabaseResponse,
  SnapshotRef,
  SnapshotDiff,
  SnapshotInfo,
  DiffSnapshotsResponse,
  FindSnapshotResponse,
  ListSnapshotsResponse,
  CommitDelta,
  CommitBatchResponse,
} from '@grafema/types';

/**
 * Default timeout for operations (60 seconds).
 * Flush/compact may take time for large graphs, but should not hang indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export abstract class BaseRFDBClient extends EventEmitter implements IRFDBClient {
  abstract readonly socketPath: string;
  abstract connected: boolean;

  /**
   * Whether the connected server supports streaming responses.
   * Defaults to false. Unix socket subclass may set this after hello().
   */
  get supportsStreaming(): boolean {
    return false;
  }

  // Batch state
  protected _batching: boolean = false;
  protected _batchNodes: WireNode[] = [];
  protected _batchEdges: WireEdge[] = [];
  protected _batchFiles: Set<string> = new Set();

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;

  /**
   * Send a request to RFDB server and wait for response.
   * Subclasses implement transport-specific send logic.
   */
  protected abstract _send(
    cmd: RFDBCommand,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RFDBResponse>;

  // ===========================================================================
  // Write Operations
  // ===========================================================================

  /**
   * Add nodes to the graph.
   * Extra properties beyond id/type/name/file/exported/metadata are merged into metadata.
   */
  async addNodes(nodes: Array<Partial<WireNode> & { id: string; type?: string; node_type?: string; nodeType?: string }>): Promise<RFDBResponse> {
    const wireNodes: WireNode[] = nodes.map(n => {
      const nodeRecord = n as Record<string, unknown>;
      const { id, type, node_type, nodeType, name, file, exported, metadata, semanticId, semantic_id, ...rest } = nodeRecord;
      const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
      const combinedMeta = { ...existingMeta, ...rest };

      const wire: WireNode = {
        id: String(id),
        nodeType: (node_type || nodeType || type || 'UNKNOWN') as NodeType,
        name: (name as string) || '',
        file: (file as string) || '',
        exported: (exported as boolean) || false,
        metadata: JSON.stringify(combinedMeta),
      };

      const sid = semanticId || semantic_id;
      if (sid) {
        (wire as WireNode & { semanticId: string }).semanticId = String(sid);
      }

      return wire;
    });

    if (this._batching) {
      this._batchNodes.push(...wireNodes);
      for (const node of wireNodes) {
        if (node.file) this._batchFiles.add(node.file);
      }
      return { ok: true } as RFDBResponse;
    }

    return this._send('addNodes', { nodes: wireNodes });
  }

  /**
   * Add edges to the graph.
   * Extra properties beyond src/dst/type are merged into metadata.
   */
  async addEdges(
    edges: WireEdge[],
    skipValidation: boolean = false,
  ): Promise<RFDBResponse> {
    const wireEdges: WireEdge[] = edges.map(e => {
      const edge = e as unknown as Record<string, unknown>;
      const { src, dst, type, edge_type, edgeType, metadata, ...rest } = edge;
      const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
      const combinedMeta = { ...existingMeta, ...rest };

      return {
        src: String(src),
        dst: String(dst),
        edgeType: (edge_type || edgeType || type || e.edgeType || 'UNKNOWN') as EdgeType,
        metadata: JSON.stringify(combinedMeta),
      };
    });

    if (this._batching) {
      this._batchEdges.push(...wireEdges);
      return { ok: true } as RFDBResponse;
    }

    return this._send('addEdges', { edges: wireEdges, skipValidation });
  }

  async deleteNode(id: string): Promise<RFDBResponse> {
    return this._send('deleteNode', { id: String(id) });
  }

  async deleteEdge(src: string, dst: string, edgeType: EdgeType): Promise<RFDBResponse> {
    return this._send('deleteEdge', {
      src: String(src),
      dst: String(dst),
      edgeType,
    });
  }

  // ===========================================================================
  // Read Operations
  // ===========================================================================

  async getNode(id: string): Promise<WireNode | null> {
    const response = await this._send('getNode', { id: String(id) });
    return (response as { node?: WireNode }).node || null;
  }

  async nodeExists(id: string): Promise<boolean> {
    const response = await this._send('nodeExists', { id: String(id) });
    return (response as { value: boolean }).value;
  }

  async findByType(nodeType: NodeType): Promise<string[]> {
    const response = await this._send('findByType', { nodeType });
    return (response as { ids?: string[] }).ids || [];
  }

  async findByAttr(query: Record<string, unknown>): Promise<string[]> {
    const response = await this._send('findByAttr', { query });
    return (response as { ids?: string[] }).ids || [];
  }

  // ===========================================================================
  // Graph Traversal
  // ===========================================================================

  async neighbors(id: string, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('neighbors', {
      id: String(id),
      edgeTypes,
    });
    return (response as { ids?: string[] }).ids || [];
  }

  async bfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('bfs', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes,
    });
    return (response as { ids?: string[] }).ids || [];
  }

  async dfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('dfs', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes,
    });
    return (response as { ids?: string[] }).ids || [];
  }

  async reachability(
    startIds: string[],
    maxDepth: number,
    edgeTypes: EdgeType[] = [],
    backward: boolean = false,
  ): Promise<string[]> {
    const response = await this._send('reachability', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes,
      backward,
    });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Get outgoing edges from a node.
   * Parses metadata JSON and spreads it onto the edge object for convenience.
   */
  async getOutgoingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getOutgoingEdges', {
      id: String(id),
      edgeTypes,
    });
    const edges = (response as { edges?: WireEdge[] }).edges || [];
    return edges.map(e => {
      let meta = {};
      try {
        meta = e.metadata ? JSON.parse(e.metadata) : {};
      } catch {
        // Keep empty metadata on parse error
      }
      return { ...e, type: e.edgeType, ...meta };
    });
  }

  /**
   * Get incoming edges to a node.
   * Parses metadata JSON and spreads it onto the edge object for convenience.
   */
  async getIncomingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getIncomingEdges', {
      id: String(id),
      edgeTypes,
    });
    const edges = (response as { edges?: WireEdge[] }).edges || [];
    return edges.map(e => {
      let meta = {};
      try {
        meta = e.metadata ? JSON.parse(e.metadata) : {};
      } catch {
        // Keep empty metadata on parse error
      }
      return { ...e, type: e.edgeType, ...meta };
    });
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  async nodeCount(): Promise<number> {
    const response = await this._send('nodeCount');
    return (response as { count: number }).count;
  }

  async edgeCount(): Promise<number> {
    const response = await this._send('edgeCount');
    return (response as { count: number }).count;
  }

  async countNodesByType(types: NodeType[] | null = null): Promise<Record<string, number>> {
    const response = await this._send('countNodesByType', { types });
    return (response as { counts?: Record<string, number> }).counts || {};
  }

  async countEdgesByType(edgeTypes: EdgeType[] | null = null): Promise<Record<string, number>> {
    const response = await this._send('countEdgesByType', { edgeTypes });
    return (response as { counts?: Record<string, number> }).counts || {};
  }

  // ===========================================================================
  // Control
  // ===========================================================================

  async flush(): Promise<RFDBResponse> {
    return this._send('flush');
  }

  async compact(): Promise<RFDBResponse> {
    return this._send('compact');
  }

  async clear(): Promise<RFDBResponse> {
    return this._send('clear');
  }

  // ===========================================================================
  // Bulk Read Operations
  // ===========================================================================

  /**
   * Build a server query object from an AttrQuery.
   */
  protected _buildServerQuery(query: AttrQuery): Record<string, unknown> {
    const serverQuery: Record<string, unknown> = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;
    if (query.exported !== undefined) serverQuery.exported = query.exported;
    return serverQuery;
  }

  /**
   * Query nodes (async generator).
   * Default implementation fetches all matching nodes in a single request.
   * Subclasses with streaming support can override.
   */
  async *queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    const serverQuery = this._buildServerQuery(query);
    const response = await this._send('queryNodes', { query: serverQuery });
    const nodes = (response as { nodes?: WireNode[] }).nodes || [];
    for (const node of nodes) {
      yield node;
    }
  }

  /**
   * Stream nodes matching query.
   * Default implementation delegates to queryNodes().
   * Subclasses with streaming support can override.
   */
  async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    yield* this.queryNodes(query);
  }

  /**
   * Get all nodes matching query.
   */
  async getAllNodes(query: AttrQuery = {}): Promise<WireNode[]> {
    const nodes: WireNode[] = [];
    for await (const node of this.queryNodes(query)) {
      nodes.push(node);
    }
    return nodes;
  }

  /**
   * Get all edges.
   * Parses metadata JSON and spreads it onto the edge object for convenience.
   */
  async getAllEdges(): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getAllEdges');
    const edges = (response as { edges?: WireEdge[] }).edges || [];
    return edges.map(e => {
      let meta = {};
      try {
        meta = e.metadata ? JSON.parse(e.metadata) : {};
      } catch {
        // Keep empty metadata on parse error
      }
      return { ...e, type: e.edgeType, ...meta };
    });
  }

  // ===========================================================================
  // Node Utility Methods
  // ===========================================================================

  async isEndpoint(id: string): Promise<boolean> {
    const response = await this._send('isEndpoint', { id: String(id) });
    return (response as { value: boolean }).value;
  }

  async getNodeIdentifier(id: string): Promise<string | null> {
    const response = await this._send('getNodeIdentifier', { id: String(id) });
    return (response as { identifier?: string | null }).identifier || null;
  }

  async updateNodeVersion(id: string, version: string): Promise<RFDBResponse> {
    return this._send('updateNodeVersion', { id: String(id), version });
  }

  async declareFields(fields: FieldDeclaration[]): Promise<number> {
    const response = await this._send('declareFields', { fields });
    return (response as { count?: number }).count || 0;
  }

  // ===========================================================================
  // Datalog API
  // ===========================================================================

  async datalogLoadRules(source: string): Promise<number> {
    const response = await this._send('datalogLoadRules', { source });
    return (response as { count: number }).count;
  }

  async datalogClearRules(): Promise<RFDBResponse> {
    return this._send('datalogClearRules');
  }

  protected _parseExplainResponse(response: RFDBResponse): DatalogExplainResult {
    const r = response as unknown as DatalogExplainResult & { requestId?: string };
    return {
      bindings: r.bindings || [],
      stats: r.stats,
      profile: r.profile,
      explainSteps: r.explainSteps || [],
      warnings: r.warnings || [],
    };
  }

  async datalogQuery(query: string): Promise<DatalogResult[]>;
  async datalogQuery(query: string, explain: true): Promise<DatalogExplainResult>;
  async datalogQuery(query: string, explain?: boolean): Promise<DatalogResult[] | DatalogExplainResult> {
    const payload: Record<string, unknown> = { query };
    if (explain) payload.explain = true;
    const response = await this._send('datalogQuery', payload);
    if (explain) {
      return this._parseExplainResponse(response);
    }
    return (response as { results?: DatalogResult[] }).results || [];
  }

  async checkGuarantee(ruleSource: string): Promise<DatalogResult[]>;
  async checkGuarantee(ruleSource: string, explain: true): Promise<DatalogExplainResult>;
  async checkGuarantee(ruleSource: string, explain?: boolean): Promise<DatalogResult[] | DatalogExplainResult> {
    const payload: Record<string, unknown> = { ruleSource };
    if (explain) payload.explain = true;
    const response = await this._send('checkGuarantee', payload);
    if (explain) {
      return this._parseExplainResponse(response);
    }
    return (response as { violations?: DatalogResult[] }).violations || [];
  }

  async executeDatalog(source: string): Promise<DatalogResult[]>;
  async executeDatalog(source: string, explain: true): Promise<DatalogExplainResult>;
  async executeDatalog(source: string, explain?: boolean): Promise<DatalogResult[] | DatalogExplainResult> {
    const payload: Record<string, unknown> = { source };
    if (explain) payload.explain = true;
    const response = await this._send('executeDatalog', payload);
    if (explain) {
      return this._parseExplainResponse(response);
    }
    return (response as { results?: DatalogResult[] }).results || [];
  }

  async ping(): Promise<string | false> {
    const response = await this._send('ping') as { pong?: boolean; version?: string };
    return response.pong && response.version ? response.version : false;
  }

  // ===========================================================================
  // Protocol v2 - Multi-Database Commands
  // ===========================================================================

  async hello(protocolVersion: number = 3): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    return response as HelloResponse;
  }

  async createDatabase(name: string, ephemeral: boolean = false): Promise<CreateDatabaseResponse> {
    const response = await this._send('createDatabase' as RFDBCommand, { name, ephemeral });
    return response as CreateDatabaseResponse;
  }

  async openDatabase(name: string, mode: 'rw' | 'ro' = 'rw'): Promise<OpenDatabaseResponse> {
    const response = await this._send('openDatabase' as RFDBCommand, { name, mode });
    return response as OpenDatabaseResponse;
  }

  async closeDatabase(): Promise<RFDBResponse> {
    return this._send('closeDatabase' as RFDBCommand);
  }

  async dropDatabase(name: string): Promise<RFDBResponse> {
    return this._send('dropDatabase' as RFDBCommand, { name });
  }

  async listDatabases(): Promise<ListDatabasesResponse> {
    const response = await this._send('listDatabases' as RFDBCommand);
    return response as ListDatabasesResponse;
  }

  async currentDatabase(): Promise<CurrentDatabaseResponse> {
    const response = await this._send('currentDatabase' as RFDBCommand);
    return response as CurrentDatabaseResponse;
  }

  // ===========================================================================
  // Snapshot Operations
  // ===========================================================================

  /**
   * Convert a SnapshotRef to wire format payload fields.
   */
  protected _resolveSnapshotRef(ref: SnapshotRef): Record<string, unknown> {
    if (typeof ref === 'number') return { version: ref };
    return { tagKey: ref.tag, tagValue: ref.value };
  }

  async diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff> {
    const response = await this._send('diffSnapshots', {
      from: this._resolveSnapshotRef(from),
      to: this._resolveSnapshotRef(to),
    });
    return (response as DiffSnapshotsResponse).diff;
  }

  async tagSnapshot(version: number, tags: Record<string, string>): Promise<void> {
    await this._send('tagSnapshot', { version, tags });
  }

  async findSnapshot(tagKey: string, tagValue: string): Promise<number | null> {
    const response = await this._send('findSnapshot', { tagKey, tagValue });
    return (response as FindSnapshotResponse).version;
  }

  async listSnapshots(filterTag?: string): Promise<SnapshotInfo[]> {
    const payload: Record<string, unknown> = {};
    if (filterTag !== undefined) payload.filterTag = filterTag;
    const response = await this._send('listSnapshots', payload);
    return (response as ListSnapshotsResponse).snapshots;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  beginBatch(): void {
    if (this._batching) throw new Error('Batch already in progress');
    this._batching = true;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
  }

  /**
   * Synchronously batch a single node.
   */
  batchNode(node: Partial<WireNode> & { id: string; type?: string; node_type?: string; nodeType?: string }): void {
    if (!this._batching) throw new Error('No batch in progress');
    const nodeRecord = node as Record<string, unknown>;
    const { id, type, node_type, nodeType, name, file, exported, metadata, semanticId, semantic_id, ...rest } = nodeRecord;
    const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
    const combinedMeta = { ...existingMeta, ...rest };
    const wire: WireNode = {
      id: String(id),
      nodeType: (node_type || nodeType || type || 'UNKNOWN') as NodeType,
      name: (name as string) || '',
      file: (file as string) || '',
      exported: (exported as boolean) || false,
      metadata: JSON.stringify(combinedMeta),
    };
    const sid = semanticId || semantic_id;
    if (sid) {
      (wire as WireNode & { semanticId: string }).semanticId = String(sid);
    }
    this._batchNodes.push(wire);
    if (wire.file) this._batchFiles.add(wire.file);
  }

  /**
   * Synchronously batch a single edge.
   */
  batchEdge(edge: WireEdge | Record<string, unknown>): void {
    if (!this._batching) throw new Error('No batch in progress');
    const edgeRecord = edge as Record<string, unknown>;
    const { src, dst, type, edge_type, edgeType, metadata, ...rest } = edgeRecord;
    const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
    const combinedMeta = { ...existingMeta, ...rest };
    this._batchEdges.push({
      src: String(src),
      dst: String(dst),
      edgeType: (edge_type || edgeType || type || (edge as WireEdge).edgeType || 'UNKNOWN') as EdgeType,
      metadata: JSON.stringify(combinedMeta),
    });
  }

  async commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta> {
    if (!this._batching) throw new Error('No batch in progress');

    const allNodes = this._batchNodes;
    const allEdges = this._batchEdges;
    const changedFiles = [...this._batchFiles];

    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();

    return this._sendCommitBatch(changedFiles, allNodes, allEdges, tags, deferIndex, protectedTypes);
  }

  /**
   * Internal helper: send a commitBatch with chunking for large payloads.
   * @internal
   */
  async _sendCommitBatch(
    changedFiles: string[],
    allNodes: WireNode[],
    allEdges: WireEdge[],
    tags?: string[],
    deferIndex?: boolean,
    protectedTypes?: string[],
  ): Promise<CommitDelta> {
    const CHUNK = 10_000;
    if (allNodes.length <= CHUNK && allEdges.length <= CHUNK) {
      const response = await this._send('commitBatch', {
        changedFiles, nodes: allNodes, edges: allEdges, tags,
        ...(deferIndex ? { deferIndex: true } : {}),
        ...(protectedTypes?.length ? { protectedTypes } : {}),
      });
      return (response as CommitBatchResponse).delta;
    }

    const merged: CommitDelta = {
      changedFiles,
      nodesAdded: 0, nodesRemoved: 0,
      edgesAdded: 0, edgesRemoved: 0,
      changedNodeTypes: [], changedEdgeTypes: [],
    };
    const nodeTypes = new Set<string>();
    const edgeTypes = new Set<string>();

    const maxI = Math.max(
      Math.ceil(allNodes.length / CHUNK),
      Math.ceil(allEdges.length / CHUNK),
      1,
    );

    for (let i = 0; i < maxI; i++) {
      const nodes = allNodes.slice(i * CHUNK, (i + 1) * CHUNK);
      const edges = allEdges.slice(i * CHUNK, (i + 1) * CHUNK);
      const response = await this._send('commitBatch', {
        changedFiles: i === 0 ? changedFiles : [],
        nodes, edges, tags,
        ...(deferIndex ? { deferIndex: true } : {}),
        ...(i === 0 && protectedTypes?.length ? { protectedTypes } : {}),
      });
      const d = (response as CommitBatchResponse).delta;
      merged.nodesAdded += d.nodesAdded;
      merged.nodesRemoved += d.nodesRemoved;
      merged.edgesAdded += d.edgesAdded;
      merged.edgesRemoved += d.edgesRemoved;
      for (const t of d.changedNodeTypes) nodeTypes.add(t);
      for (const t of d.changedEdgeTypes) edgeTypes.add(t);
    }

    merged.changedNodeTypes = [...nodeTypes];
    merged.changedEdgeTypes = [...edgeTypes];
    return merged;
  }

  async rebuildIndexes(): Promise<void> {
    await this._send('rebuildIndexes', {});
  }

  abortBatch(): void {
    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
  }

  isBatching(): boolean {
    return this._batching;
  }

  /**
   * Find files that depend on the given changed files.
   */
  async findDependentFiles(changedFiles: string[]): Promise<string[]> {
    const nodeIds: string[] = [];
    for (const file of changedFiles) {
      const ids = await this.findByAttr({ file });
      nodeIds.push(...ids);
    }

    if (nodeIds.length === 0) return [];

    const reachable = await this.reachability(
      nodeIds,
      2,
      ['IMPORTS_FROM', 'DEPENDS_ON', 'CALLS'] as EdgeType[],
      true,
    );

    const changedSet = new Set(changedFiles);
    const files = new Set<string>();
    for (const id of reachable) {
      const node = await this.getNode(id);
      if (node?.file && !changedSet.has(node.file)) {
        files.add(node.file);
      }
    }

    return [...files];
  }

  async shutdown(): Promise<void> {
    try {
      await this._send('shutdown');
    } catch {
      // Expected - server closes connection
    }
    await this.close();
  }
}
