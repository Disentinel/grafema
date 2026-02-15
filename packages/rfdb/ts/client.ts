/**
 * RFDBClient - Unix socket client for RFDB server
 *
 * Provides the same API as GraphEngine NAPI binding but communicates
 * with a separate rfdb-server process over Unix socket + MessagePack.
 */

import { createConnection, Socket } from 'net';
import { encode, decode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';
import { StreamQueue } from './stream-queue.js';

import type {
  RFDBCommand,
  WireNode,
  WireEdge,
  RFDBResponse,
  IRFDBClient,
  AttrQuery,
  FieldDeclaration,
  DatalogResult,
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
  NodesChunkResponse,
} from '@grafema/types';

interface PendingRequest {
  resolve: (value: RFDBResponse) => void;
  reject: (error: Error) => void;
}

export class RFDBClient extends EventEmitter implements IRFDBClient {
  readonly socketPath: string;
  private socket: Socket | null;
  connected: boolean;
  private pending: Map<number, PendingRequest>;
  private reqId: number;
  private buffer: Buffer;

  // Batch state
  private _batching: boolean = false;
  private _batchNodes: WireNode[] = [];
  private _batchEdges: WireEdge[] = [];
  private _batchFiles: Set<string> = new Set();

  // Streaming state
  private _supportsStreaming: boolean = false;
  private _pendingStreams: Map<number, StreamQueue<WireNode>> = new Map();
  private _streamTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

  constructor(socketPath: string = '/tmp/rfdb.sock') {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this.reqId = 0;
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Whether the connected server supports streaming responses.
   * Set after calling hello(). Defaults to false.
   */
  get supportsStreaming(): boolean {
    return this._supportsStreaming;
  }

  /**
   * Connect to RFDB server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        const enhancedError = this._enhanceConnectionError(err);
        if (!this.connected) {
          reject(enhancedError);
        } else {
          this.emit('error', enhancedError);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reject all pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error('Connection closed'));
        }
        this.pending.clear();
        // Fail all pending streams
        for (const [, stream] of this._pendingStreams) {
          stream.fail(new Error('Connection closed'));
        }
        this._pendingStreams.clear();
        for (const [, timer] of this._streamTimers) {
          clearTimeout(timer);
        }
        this._streamTimers.clear();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this._handleData(chunk);
      });
    });
  }

  /**
   * Enhance connection errors with helpful messages about --auto-start
   */
  private _enhanceConnectionError(err: NodeJS.ErrnoException): Error {
    const code = err.code;

    if (code === 'EPIPE' || code === 'ECONNRESET') {
      return new Error(
        `RFDB server connection lost (${code}). The server may have crashed or been stopped.\n` +
        `Try running with --auto-start flag to automatically start the server, or manually start it with:\n` +
        `  rfdb-server start`
      );
    }

    if (code === 'ENOENT') {
      return new Error(
        `RFDB server socket not found at ${this.socketPath}.\n` +
        `The server is not running. Use --auto-start flag to automatically start it, or manually start with:\n` +
        `  rfdb-server start`
      );
    }

    if (code === 'ECONNREFUSED') {
      return new Error(
        `Cannot connect to RFDB server at ${this.socketPath} (connection refused).\n` +
        `The server may not be running. Use --auto-start flag to automatically start it, or manually start with:\n` +
        `  rfdb-server start`
      );
    }

    return err;
  }

  /**
   * Handle incoming data, parse framed messages
   */
  private _handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      // Read length prefix (4 bytes, big-endian)
      const msgLen = this.buffer.readUInt32BE(0);

      if (this.buffer.length < 4 + msgLen) {
        // Not enough data yet
        break;
      }

      // Extract message
      const msgBytes = this.buffer.subarray(4, 4 + msgLen);
      this.buffer = this.buffer.subarray(4 + msgLen);

      // Decode and dispatch
      try {
        const response = decode(msgBytes) as RFDBResponse;
        this._handleResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('error', new Error(`Failed to decode response: ${message}`));
      }
    }
  }

  /**
   * Handle decoded response — match by requestId, route streaming chunks
   * to StreamQueue or resolve single-response Promise.
   */
  private _handleResponse(response: RFDBResponse): void {
    if (this.pending.size === 0 && this._pendingStreams.size === 0) {
      this.emit('error', new Error('Received response with no pending request'));
      return;
    }

    let id: number;

    if (response.requestId) {
      const parsed = this._parseRequestId(response.requestId);
      if (parsed === null) {
        this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
        return;
      }
      id = parsed;
    } else {
      // FIFO fallback for servers that don't echo requestId
      if (this.pending.size > 0) {
        id = (this.pending.entries().next().value as [number, PendingRequest])[0];
      } else {
        this.emit('error', new Error('Received response with no pending request'));
        return;
      }
    }

    // Route to streaming handler if this requestId has a StreamQueue
    const streamQueue = this._pendingStreams.get(id);
    if (streamQueue) {
      this._handleStreamingResponse(id, response, streamQueue);
      return;
    }

    // Non-streaming response — existing behavior
    if (!this.pending.has(id)) {
      this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
      return;
    }

    const { resolve, reject } = this.pending.get(id)!;
    this.pending.delete(id);

    if (response.error) {
      reject(new Error(response.error));
    } else {
      resolve(response);
    }
  }

  /**
   * Handle a response for a streaming request.
   * Routes chunk data to StreamQueue and manages stream lifecycle.
   * Resets per-chunk timeout on each successful chunk arrival.
   */
  private _handleStreamingResponse(
    id: number,
    response: RFDBResponse,
    streamQueue: StreamQueue<WireNode>,
  ): void {
    // Error response — fail the stream
    if (response.error) {
      this._cleanupStream(id);
      streamQueue.fail(new Error(response.error));
      return;
    }

    // Streaming chunk (has `done` field)
    if ('done' in response) {
      const chunk = response as unknown as NodesChunkResponse;
      const nodes = chunk.nodes || [];
      for (const node of nodes) {
        streamQueue.push(node);
      }

      if (chunk.done) {
        this._cleanupStream(id);
        streamQueue.end();
      } else {
        // Reset per-chunk timeout
        this._resetStreamTimer(id, streamQueue);
      }
      return;
    }

    // Auto-fallback: server sent a non-streaming Nodes response
    // (server doesn't support streaming or result was below threshold)
    const nodesResponse = response as unknown as { nodes?: WireNode[] };
    const nodes = nodesResponse.nodes || [];
    for (const node of nodes) {
      streamQueue.push(node);
    }
    this._cleanupStream(id);
    streamQueue.end();
  }

  /**
   * Reset the per-chunk timeout for a streaming request.
   */
  private _resetStreamTimer(id: number, streamQueue: StreamQueue<WireNode>): void {
    const existing = this._streamTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._cleanupStream(id);
      streamQueue.fail(new Error(
        `RFDB queryNodesStream timed out after ${RFDBClient.DEFAULT_TIMEOUT_MS}ms (no chunk received)`
      ));
    }, RFDBClient.DEFAULT_TIMEOUT_MS);

    this._streamTimers.set(id, timer);
  }

  /**
   * Clean up all state for a completed/failed streaming request.
   */
  private _cleanupStream(id: number): void {
    this._pendingStreams.delete(id);
    this.pending.delete(id);
    const timer = this._streamTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._streamTimers.delete(id);
    }
  }

  private _parseRequestId(requestId: string): number | null {
    if (!requestId.startsWith('r')) return null;
    const num = parseInt(requestId.slice(1), 10);
    return Number.isNaN(num) ? null : num;
  }

  /**
   * Default timeout for operations (60 seconds)
   * Flush/compact may take time for large graphs, but should not hang indefinitely
   */
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;

  /**
   * Send a request and wait for response with timeout
   */
  private async _send(
    cmd: RFDBCommand,
    payload: Record<string, unknown> = {},
    timeoutMs: number = RFDBClient.DEFAULT_TIMEOUT_MS
  ): Promise<RFDBResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to RFDB server');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const request = { requestId: `r${id}`, cmd, ...payload };
      const msgBytes = encode(request);

      // Setup timeout
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RFDB ${cmd} timed out after ${timeoutMs}ms. Server may be unresponsive or dbPath may be invalid.`));
      }, timeoutMs);

      // Handle socket errors during this request
      const errorHandler = (err: NodeJS.ErrnoException) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this._enhanceConnectionError(err));
      };
      this.socket!.once('error', errorHandler);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          this.socket?.removeListener('error', errorHandler);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.socket?.removeListener('error', errorHandler);
          reject(error);
        }
      });

      // Write length prefix + message
      const header = Buffer.alloc(4);
      header.writeUInt32BE(msgBytes.length);

      this.socket!.write(Buffer.concat([header, Buffer.from(msgBytes)]));
    });
  }

  // ===========================================================================
  // Write Operations
  // ===========================================================================

  /**
   * Add nodes to the graph
   * Extra properties beyond id/type/name/file/exported/metadata are merged into metadata
   */
  async addNodes(nodes: Array<Partial<WireNode> & { id: string; type?: string; node_type?: string; nodeType?: string }>): Promise<RFDBResponse> {
    const wireNodes: WireNode[] = nodes.map(n => {
      // Cast to Record to allow iteration over extra properties
      const nodeRecord = n as Record<string, unknown>;

      // Extract known wire format fields, rest goes to metadata
      const { id, type, node_type, nodeType, name, file, exported, metadata, ...rest } = nodeRecord;

      // Merge explicit metadata with extra properties
      const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
      const combinedMeta = { ...existingMeta, ...rest };

      return {
        id: String(id),
        nodeType: (node_type || nodeType || type || 'UNKNOWN') as NodeType,
        name: (name as string) || '',
        file: (file as string) || '',
        exported: (exported as boolean) || false,
        metadata: JSON.stringify(combinedMeta),
      };
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
   * Add edges to the graph
   * Extra properties beyond src/dst/type are merged into metadata
   */
  async addEdges(
    edges: WireEdge[],
    skipValidation: boolean = false
  ): Promise<RFDBResponse> {
    const wireEdges: WireEdge[] = edges.map(e => {
      // Cast to unknown first then to Record to allow extra properties
      const edge = e as unknown as Record<string, unknown>;

      // Extract known fields, rest goes to metadata
      const { src, dst, type, edge_type, edgeType, metadata, ...rest } = edge;

      // Merge explicit metadata with extra properties
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

  /**
   * Delete a node
   */
  async deleteNode(id: string): Promise<RFDBResponse> {
    return this._send('deleteNode', { id: String(id) });
  }

  /**
   * Delete an edge
   */
  async deleteEdge(src: string, dst: string, edgeType: EdgeType): Promise<RFDBResponse> {
    return this._send('deleteEdge', {
      src: String(src),
      dst: String(dst),
      edgeType
    });
  }

  // ===========================================================================
  // Read Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  async getNode(id: string): Promise<WireNode | null> {
    const response = await this._send('getNode', { id: String(id) });
    return (response as { node?: WireNode }).node || null;
  }

  /**
   * Check if node exists
   */
  async nodeExists(id: string): Promise<boolean> {
    const response = await this._send('nodeExists', { id: String(id) });
    return (response as { value: boolean }).value;
  }

  /**
   * Find nodes by type
   */
  async findByType(nodeType: NodeType): Promise<string[]> {
    const response = await this._send('findByType', { nodeType });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Find nodes by attributes
   */
  async findByAttr(query: Record<string, unknown>): Promise<string[]> {
    const response = await this._send('findByAttr', { query });
    return (response as { ids?: string[] }).ids || [];
  }

  // ===========================================================================
  // Graph Traversal
  // ===========================================================================

  /**
   * Get neighbors of a node
   */
  async neighbors(id: string, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('neighbors', {
      id: String(id),
      edgeTypes
    });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Breadth-first search
   */
  async bfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('bfs', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes
    });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Depth-first search
   */
  async dfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[] = []): Promise<string[]> {
    const response = await this._send('dfs', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes
    });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Reachability query - find all nodes reachable from start nodes
   */
  async reachability(
    startIds: string[],
    maxDepth: number,
    edgeTypes: EdgeType[] = [],
    backward: boolean = false
  ): Promise<string[]> {
    const response = await this._send('reachability', {
      startIds: startIds.map(String),
      maxDepth,
      edgeTypes,
      backward
    });
    return (response as { ids?: string[] }).ids || [];
  }

  /**
   * Get outgoing edges from a node
   * Parses metadata JSON and spreads it onto the edge object for convenience
   */
  async getOutgoingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getOutgoingEdges', {
      id: String(id),
      edgeTypes
    });
    const edges = (response as { edges?: WireEdge[] }).edges || [];

    // Parse metadata and spread onto edge for convenience
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
   * Get incoming edges to a node
   * Parses metadata JSON and spreads it onto the edge object for convenience
   */
  async getIncomingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getIncomingEdges', {
      id: String(id),
      edgeTypes
    });
    const edges = (response as { edges?: WireEdge[] }).edges || [];

    // Parse metadata and spread onto edge for convenience
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

  /**
   * Get node count
   */
  async nodeCount(): Promise<number> {
    const response = await this._send('nodeCount');
    return (response as { count: number }).count;
  }

  /**
   * Get edge count
   */
  async edgeCount(): Promise<number> {
    const response = await this._send('edgeCount');
    return (response as { count: number }).count;
  }

  /**
   * Count nodes by type
   */
  async countNodesByType(types: NodeType[] | null = null): Promise<Record<string, number>> {
    const response = await this._send('countNodesByType', { types });
    return (response as { counts?: Record<string, number> }).counts || {};
  }

  /**
   * Count edges by type
   */
  async countEdgesByType(edgeTypes: EdgeType[] | null = null): Promise<Record<string, number>> {
    const response = await this._send('countEdgesByType', { edgeTypes });
    return (response as { counts?: Record<string, number> }).counts || {};
  }

  // ===========================================================================
  // Control
  // ===========================================================================

  /**
   * Flush data to disk
   */
  async flush(): Promise<RFDBResponse> {
    return this._send('flush');
  }

  /**
   * Compact the database
   */
  async compact(): Promise<RFDBResponse> {
    return this._send('compact');
  }

  /**
   * Clear the database
   */
  async clear(): Promise<RFDBResponse> {
    return this._send('clear');
  }

  // ===========================================================================
  // Bulk Read Operations
  // ===========================================================================

  /**
   * Query nodes (async generator)
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
   * Build a server query object from an AttrQuery.
   */
  private _buildServerQuery(query: AttrQuery): Record<string, unknown> {
    const serverQuery: Record<string, unknown> = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;
    if (query.exported !== undefined) serverQuery.exported = query.exported;
    return serverQuery;
  }

  /**
   * Stream nodes matching query with true streaming support.
   *
   * Behavior depends on server capabilities:
   * - Server supports streaming (protocol v3): receives chunked NodesChunk
   *   responses via StreamQueue. Nodes are yielded as they arrive.
   * - Server does NOT support streaming (fallback): delegates to queryNodes()
   *   which yields nodes one by one from bulk response.
   *
   * The generator can be aborted by breaking out of the loop or calling .return().
   */
  async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    if (!this._supportsStreaming) {
      yield* this.queryNodes(query);
      return;
    }

    if (!this.connected || !this.socket) {
      throw new Error('Not connected to RFDB server');
    }

    const serverQuery = this._buildServerQuery(query);
    const id = this.reqId++;
    const streamQueue = new StreamQueue<WireNode>();
    this._pendingStreams.set(id, streamQueue);

    // Build and send request manually (can't use _send which expects single response)
    const request = { requestId: `r${id}`, cmd: 'queryNodes', query: serverQuery };
    const msgBytes = encode(request);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(msgBytes.length);

    // Register in pending map for error routing
    this.pending.set(id, {
      resolve: () => { this._cleanupStream(id); },
      reject: (error) => {
        this._cleanupStream(id);
        streamQueue.fail(error);
      },
    });

    // Start per-chunk timeout (resets on each chunk in _handleStreamingResponse)
    this._resetStreamTimer(id, streamQueue);

    this.socket!.write(Buffer.concat([header, Buffer.from(msgBytes)]));

    try {
      for await (const node of streamQueue) {
        yield node;
      }
    } finally {
      this._cleanupStream(id);
    }
  }

  /**
   * Get all nodes matching query
   */
  async getAllNodes(query: AttrQuery = {}): Promise<WireNode[]> {
    const nodes: WireNode[] = [];
    for await (const node of this.queryNodes(query)) {
      nodes.push(node);
    }
    return nodes;
  }

  /**
   * Get all edges
   * Parses metadata JSON and spreads it onto the edge object for convenience
   */
  async getAllEdges(): Promise<(WireEdge & Record<string, unknown>)[]> {
    const response = await this._send('getAllEdges');
    const edges = (response as { edges?: WireEdge[] }).edges || [];

    // Parse metadata and spread onto edge for convenience
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

  /**
   * Check if node is an endpoint (has no outgoing edges)
   */
  async isEndpoint(id: string): Promise<boolean> {
    const response = await this._send('isEndpoint', { id: String(id) });
    return (response as { value: boolean }).value;
  }

  /**
   * Get node identifier string
   */
  async getNodeIdentifier(id: string): Promise<string | null> {
    const response = await this._send('getNodeIdentifier', { id: String(id) });
    return (response as { identifier?: string | null }).identifier || null;
  }

  /**
   * Update node version
   */
  async updateNodeVersion(id: string, version: string): Promise<RFDBResponse> {
    return this._send('updateNodeVersion', { id: String(id), version });
  }

  /**
   * Declare metadata fields for server-side indexing.
   * Call before adding nodes so the server builds indexes on flush.
   * Returns the number of declared fields.
   */
  async declareFields(fields: FieldDeclaration[]): Promise<number> {
    const response = await this._send('declareFields', { fields });
    return (response as { count?: number }).count || 0;
  }

  // ===========================================================================
  // Datalog API
  // ===========================================================================

  /**
   * Load Datalog rules
   */
  async datalogLoadRules(source: string): Promise<number> {
    const response = await this._send('datalogLoadRules', { source });
    return (response as { count: number }).count;
  }

  /**
   * Clear Datalog rules
   */
  async datalogClearRules(): Promise<RFDBResponse> {
    return this._send('datalogClearRules');
  }

  /**
   * Execute Datalog query
   */
  async datalogQuery(query: string): Promise<DatalogResult[]> {
    const response = await this._send('datalogQuery', { query });
    return (response as { results?: DatalogResult[] }).results || [];
  }

  /**
   * Check a guarantee (Datalog rule) and return violations
   */
  async checkGuarantee(ruleSource: string): Promise<DatalogResult[]> {
    const response = await this._send('checkGuarantee', { ruleSource });
    return (response as { violations?: DatalogResult[] }).violations || [];
  }

  /**
   * Execute unified Datalog — handles both direct queries and rule-based programs.
   * Auto-detects the head predicate instead of hardcoding violation(X).
   */
  async executeDatalog(source: string): Promise<DatalogResult[]> {
    const response = await this._send('executeDatalog', { source });
    return (response as { results?: DatalogResult[] }).results || [];
  }

  /**
   * Ping the server
   */
  async ping(): Promise<string | false> {
    const response = await this._send('ping') as { pong?: boolean; version?: string };
    return response.pong && response.version ? response.version : false;
  }

  // ===========================================================================
  // Protocol v2 - Multi-Database Commands
  // ===========================================================================

  /**
   * Negotiate protocol version with server
   * @param protocolVersion - Protocol version to negotiate (default: 2)
   * @returns Server capabilities including protocolVersion, serverVersion, features
   */
  async hello(protocolVersion: number = 3): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    const hello = response as HelloResponse;
    this._supportsStreaming = hello.features?.includes('streaming') ?? false;
    return hello;
  }

  /**
   * Create a new database
   * @param name - Database name (alphanumeric, _, -)
   * @param ephemeral - If true, database is in-memory and auto-cleaned on disconnect
   */
  async createDatabase(name: string, ephemeral: boolean = false): Promise<CreateDatabaseResponse> {
    const response = await this._send('createDatabase' as RFDBCommand, { name, ephemeral });
    return response as CreateDatabaseResponse;
  }

  /**
   * Open a database and set as current for this session
   * @param name - Database name
   * @param mode - 'rw' (read-write) or 'ro' (read-only)
   */
  async openDatabase(name: string, mode: 'rw' | 'ro' = 'rw'): Promise<OpenDatabaseResponse> {
    const response = await this._send('openDatabase' as RFDBCommand, { name, mode });
    return response as OpenDatabaseResponse;
  }

  /**
   * Close current database
   */
  async closeDatabase(): Promise<RFDBResponse> {
    return this._send('closeDatabase' as RFDBCommand);
  }

  /**
   * Drop (delete) a database - must not be in use
   * @param name - Database name
   */
  async dropDatabase(name: string): Promise<RFDBResponse> {
    return this._send('dropDatabase' as RFDBCommand, { name });
  }

  /**
   * List all databases
   */
  async listDatabases(): Promise<ListDatabasesResponse> {
    const response = await this._send('listDatabases' as RFDBCommand);
    return response as ListDatabasesResponse;
  }

  /**
   * Get current database for this session
   */
  async currentDatabase(): Promise<CurrentDatabaseResponse> {
    const response = await this._send('currentDatabase' as RFDBCommand);
    return response as CurrentDatabaseResponse;
  }

  // ===========================================================================
  // Snapshot Operations
  // ===========================================================================

  /**
   * Convert a SnapshotRef to wire format payload fields.
   *
   * - number -> { version: N }
   * - { tag, value } -> { tagKey, tagValue }
   */
  private _resolveSnapshotRef(ref: SnapshotRef): Record<string, unknown> {
    if (typeof ref === 'number') return { version: ref };
    return { tagKey: ref.tag, tagValue: ref.value };
  }

  /**
   * Compute diff between two snapshots.
   * @param from - Source snapshot (version number or tag reference)
   * @param to - Target snapshot (version number or tag reference)
   * @returns SnapshotDiff with added/removed segments and stats
   */
  async diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff> {
    const response = await this._send('diffSnapshots', {
      from: this._resolveSnapshotRef(from),
      to: this._resolveSnapshotRef(to),
    });
    return (response as DiffSnapshotsResponse).diff;
  }

  /**
   * Tag a snapshot with key-value metadata.
   * @param version - Snapshot version to tag
   * @param tags - Key-value pairs to apply (e.g. { "release": "v1.0" })
   */
  async tagSnapshot(version: number, tags: Record<string, string>): Promise<void> {
    await this._send('tagSnapshot', { version, tags });
  }

  /**
   * Find a snapshot by tag key/value pair.
   * @param tagKey - Tag key to search for
   * @param tagValue - Tag value to match
   * @returns Snapshot version number, or null if not found
   */
  async findSnapshot(tagKey: string, tagValue: string): Promise<number | null> {
    const response = await this._send('findSnapshot', { tagKey, tagValue });
    return (response as FindSnapshotResponse).version;
  }

  /**
   * List snapshots, optionally filtered by tag key.
   * @param filterTag - Optional tag key to filter by (only snapshots with this tag)
   * @returns Array of SnapshotInfo objects
   */
  async listSnapshots(filterTag?: string): Promise<SnapshotInfo[]> {
    const payload: Record<string, unknown> = {};
    if (filterTag !== undefined) payload.filterTag = filterTag;
    const response = await this._send('listSnapshots', payload);
    return (response as ListSnapshotsResponse).snapshots;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Begin a batch operation.
   * While batching, addNodes/addEdges buffer locally instead of sending to server.
   * Call commitBatch() to send all buffered data atomically.
   */
  beginBatch(): void {
    if (this._batching) throw new Error('Batch already in progress');
    this._batching = true;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
  }

  /**
   * Commit the current batch to the server.
   * Sends all buffered nodes/edges with the list of changed files.
   * Server atomically replaces old data for changed files with new data.
   */
  async commitBatch(tags?: string[]): Promise<CommitDelta> {
    if (!this._batching) throw new Error('No batch in progress');

    const response = await this._send('commitBatch', {
      changedFiles: [...this._batchFiles],
      nodes: this._batchNodes,
      edges: this._batchEdges,
      tags,
    });

    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();

    return (response as CommitBatchResponse).delta;
  }

  /**
   * Abort the current batch, discarding all buffered data.
   */
  abortBatch(): void {
    this._batching = false;
    this._batchNodes = [];
    this._batchEdges = [];
    this._batchFiles = new Set();
  }

  /**
   * Check if a batch is currently in progress.
   */
  isBatching(): boolean {
    return this._batching;
  }

  /**
   * Find files that depend on the given changed files.
   * Uses backward reachability to find dependent modules.
   *
   * Note: For large result sets, each reachable node requires a separate
   * getNode RPC. A future server-side optimization could return file paths
   * directly from the reachability query.
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

  /**
   * Unref the socket so it doesn't keep the process alive.
   *
   * Call this in test environments to allow process to exit
   * even if connections remain open.
   */
  unref(): void {
    if (this.socket) {
      this.socket.unref();
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  /**
   * Shutdown the server
   */
  async shutdown(): Promise<void> {
    try {
      await this._send('shutdown');
    } catch {
      // Expected - server closes connection
    }
    await this.close();
  }
}

export default RFDBClient;
