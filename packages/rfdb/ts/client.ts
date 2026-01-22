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
  DatalogResult,
  NodeType,
  EdgeType,
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

      this.socket.on('error', (err: Error) => {
        if (!this.connected) {
          reject(err);
        } else {
          this.emit('error', err);
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
        this.emit('error', new Error(`Failed to decode response: ${(err as Error).message}`));
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
   * Send a request and wait for response
   */
  private async _send(cmd: RFDBCommand, payload: Record<string, unknown> = {}): Promise<RFDBResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to RFDB server');
    }

    const request = { cmd, ...payload };
    const msgBytes = encode(request);

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });

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
   */
  async addNodes(nodes: Array<Partial<WireNode> & { id: string; type?: string; node_type?: string; nodeType?: string }>): Promise<RFDBResponse> {
    const wireNodes: WireNode[] = nodes.map(n => ({
      id: String(n.id),
      nodeType: (n.node_type || n.nodeType || n.type || 'UNKNOWN') as NodeType,
      name: n.name || '',
      file: n.file || '',
      exported: n.exported || false,
      metadata: typeof n.metadata === 'string' ? n.metadata : JSON.stringify(n.metadata || {}),
    }));

    return this._send('addNodes', { nodes: wireNodes });
  }

  /**
   * Add edges to the graph
   */
  async addEdges(
    edges: Array<Partial<WireEdge> & { src: string; dst: string; type?: string; edge_type?: string; edgeType?: string }>,
    skipValidation: boolean = false
  ): Promise<RFDBResponse> {
    const wireEdges: WireEdge[] = edges.map(e => ({
      src: String(e.src),
      dst: String(e.dst),
      edgeType: (e.edge_type || e.edgeType || e.type || 'UNKNOWN') as EdgeType,
      metadata: typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata || {}),
    }));

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
   */
  async getOutgoingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<WireEdge[]> {
    const response = await this._send('getOutgoingEdges', {
      id: String(id),
      edgeTypes
    });
    return (response as { edges?: WireEdge[] }).edges || [];
  }

  /**
   * Get incoming edges to a node
   */
  async getIncomingEdges(id: string, edgeTypes: EdgeType[] | null = null): Promise<WireEdge[]> {
    const response = await this._send('getIncomingEdges', {
      id: String(id),
      edgeTypes
    });
    return (response as { edges?: WireEdge[] }).edges || [];
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
   */
  async getAllEdges(): Promise<WireEdge[]> {
    const response = await this._send('getAllEdges');
    return (response as { edges?: WireEdge[] }).edges || [];
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
