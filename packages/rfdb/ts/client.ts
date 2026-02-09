/**
 * RFDBClient - Unix socket client for RFDB server
 *
 * Provides the same API as GraphEngine NAPI binding but communicates
 * with a separate rfdb-server process over Unix socket + MessagePack.
 */

import { createConnection, Socket } from 'net';
import { encode, decode } from '@msgpack/msgpack';
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
  NodeType,
  EdgeType,
  HelloResponse,
  CreateDatabaseResponse,
  OpenDatabaseResponse,
  ListDatabasesResponse,
  CurrentDatabaseResponse,
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
   * Handle decoded response
   */
  private _handleResponse(response: RFDBResponse): void {
    if (this.pending.size === 0) {
      this.emit('error', new Error('Received response with no pending request'));
      return;
    }

    // Get the oldest pending request (FIFO)
    const [id, { resolve, reject }] = this.pending.entries().next().value as [number, PendingRequest];
    this.pending.delete(id);

    if (response.error) {
      reject(new Error(response.error));
    } else {
      resolve(response);
    }
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

    const request = { cmd, ...payload };
    const msgBytes = encode(request);

    return new Promise((resolve, reject) => {
      const id = this.reqId++;

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
    const serverQuery: Record<string, unknown> = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;
    if (query.exported !== undefined) serverQuery.exported = query.exported;

    const response = await this._send('queryNodes', { query: serverQuery });
    const nodes = (response as { nodes?: WireNode[] }).nodes || [];

    for (const node of nodes) {
      yield node;
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
  async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    return response as HelloResponse;
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
