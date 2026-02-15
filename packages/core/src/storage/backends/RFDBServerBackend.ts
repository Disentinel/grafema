/**
 * RFDBServerBackend - Graph backend using RFDB server via Unix socket
 *
 * Replaces ReginaFlowBackend's direct NAPI binding with socket-based
 * communication to a shared RFDB server. This allows multiple processes
 * (MCP server, analysis workers) to share the same graph database.
 *
 * Socket path defaults to `{dbPath}/../rfdb.sock` (e.g., .grafema/rfdb.sock),
 * ensuring each project has its own socket and avoiding conflicts when
 * multiple MCP instances run simultaneously.
 *
 * Usage:
 *   const backend = new RFDBServerBackend({
 *     dbPath: '/project/.grafema/graph.rfdb'  // socket will be /project/.grafema/rfdb.sock
 *   });
 *   await backend.connect();
 *   await backend.addNodes([...]);
 *   await backend.flush();
 */

import { RFDBClient } from '@grafema/rfdb-client';
import { existsSync, unlinkSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { setTimeout as sleep } from 'timers/promises';

import type { WireNode, WireEdge, FieldDeclaration, AttrQuery as RFDBAttrQuery } from '@grafema/types';
import type { NodeType, EdgeType } from '@grafema/types';
import { findRfdbBinary } from '../../utils/findRfdbBinary.js';
import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';
import type { AttrQuery, GraphStats, GraphExport } from '../../core/GraphBackend.js';

/**
 * Options for RFDBServerBackend
 */
export interface RFDBServerBackendOptions {
  socketPath?: string;
  dbPath?: string;
  /**
   * If true, automatically start the server if not running.
   * If false, require explicit `grafema server start`.
   * Default: true (for backwards compatibility)
   */
  autoStart?: boolean;
  /**
   * If true, suppress all console output (for clean CLI progress).
   * Default: false
   */
  silent?: boolean;
}

/**
 * Input node format (flexible)
 */
export interface InputNode {
  id: string;
  type?: string;
  nodeType?: string;
  node_type?: string;
  name?: string;
  file?: string;
  exported?: boolean;
  [key: string]: unknown;
}

/**
 * Input edge format (flexible)
 */
export interface InputEdge {
  src: string;
  dst: string;
  type?: string;
  edgeType?: string;
  edge_type?: string;
  [key: string]: unknown;
}

/**
 * Query for finding nodes
 */
export interface NodeQuery {
  nodeType?: NodeType;
  type?: NodeType;
  name?: string;
  file?: string;
}

/**
 * Backend statistics
 */
export interface BackendStats extends GraphStats {
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
}

export class RFDBServerBackend {
  readonly socketPath: string;
  readonly dbPath: string | undefined;
  private readonly autoStart: boolean;
  private readonly silent: boolean;
  private client: RFDBClient | null;
  private serverProcess: ChildProcess | null;
  connected: boolean;  // Public for compatibility
  private protocolVersion: number = 2; // Negotiated protocol version
  private edgeTypes: Set<string>;
  private _cachedNodeCounts: Record<string, number> | undefined;
  private _cachedEdgeCounts: Record<string, number> | undefined;

  constructor(options: RFDBServerBackendOptions = {}) {
    this.dbPath = options.dbPath;
    this.autoStart = options.autoStart ?? true; // Default true for backwards compat
    this.silent = options.silent ?? false;
    // Default socket path: next to the database in .grafema folder
    // This ensures each project has its own socket, avoiding conflicts
    if (options.socketPath) {
      this.socketPath = options.socketPath;
    } else if (this.dbPath) {
      this.socketPath = join(dirname(this.dbPath), 'rfdb.sock');
    } else {
      this.socketPath = '/tmp/rfdb.sock'; // fallback, not recommended
    }
    this.client = null;
    this.serverProcess = null;
    this.connected = false;
    this.edgeTypes = new Set();
  }

  /**
   * Log message if not in silent mode.
   */
  private log(message: string): void {
    if (!this.silent) {
      console.log(message);
    }
  }

  /**
   * Log error (always shown, even in silent mode).
   */
  private logError(message: string, error?: unknown): void {
    console.error(message, error ?? '');
  }

  /**
   * Connect to RFDB server.
   * If autoStart is true (default), starts the server if not running.
   * If autoStart is false, requires explicit `grafema server start`.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Try to connect first
    this.client = new RFDBClient(this.socketPath);

    // Attach error handler to prevent unhandled 'error' events
    // This is important for stale sockets (socket file exists but server is dead)
    this.client.on('error', (err: Error) => {
      this.logError('[RFDBServerBackend] Client error:', err.message);
    });

    try {
      await this.client.connect();
      // Verify server is responsive
      await this.client.ping();
      this.connected = true;
      await this._negotiateProtocol();
      this.log(`[RFDBServerBackend] Connected to RFDB server at ${this.socketPath} (protocol v${this.protocolVersion})`);
      return;
    } catch {
      // Server not running or stale socket
      if (!this.autoStart) {
        throw new Error(
          `RFDB server not running at ${this.socketPath}\n` +
          `Start the server first: grafema server start`
        );
      }
      this.log(`[RFDBServerBackend] RFDB server not running, starting...`);
    }

    // Start the server (only if autoStart is true)
    await this._startServer();

    // Connect again with fresh client
    this.client = new RFDBClient(this.socketPath);
    this.client.on('error', (err: Error) => {
      this.logError('[RFDBServerBackend] Client error:', err.message);
    });
    await this.client.connect();
    await this.client.ping();
    this.connected = true;
    await this._negotiateProtocol();
    this.log(`[RFDBServerBackend] Connected to RFDB server at ${this.socketPath} (protocol v${this.protocolVersion})`);
  }

  /**
   * Alias for connect()
   */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Find RFDB server binary using shared utility.
   * Delegates to findRfdbBinary() for consistent search across all entry points.
   */
  private _findServerBinary(): string | null {
    const binaryPath = findRfdbBinary();
    if (binaryPath) {
      this.log(`[RFDBServerBackend] Found binary: ${binaryPath}`);
    }
    return binaryPath;
  }

  /**
   * Start RFDB server process
   */
  private async _startServer(): Promise<void> {
    if (!this.dbPath) {
      throw new Error('dbPath required to start RFDB server');
    }

    // Find server binary - check multiple locations
    const binaryPath = this._findServerBinary();
    if (!binaryPath) {
      throw new Error(
        'RFDB server binary not found.\n' +
        'Install @grafema/rfdb: npm install @grafema/rfdb\n' +
        'Or build from source: cargo build --release --bin rfdb-server'
      );
    }

    // Remove stale socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    this.log(`[RFDBServerBackend] Starting: ${binaryPath} ${this.dbPath} --socket ${this.socketPath}`);

    this.serverProcess = spawn(binaryPath, [this.dbPath, '--socket', this.socketPath], {
      stdio: ['ignore', 'ignore', 'inherit'], // stdin/stdout ignored, stderr inherited
      detached: true, // Allow server to outlive this process
    });

    // Don't let server process prevent parent from exiting
    this.serverProcess.unref();

    this.serverProcess.on('error', (err: Error) => {
      this.logError(`[RFDBServerBackend] Server process error:`, err);
    });

    // Wait for socket to appear
    let attempts = 0;
    while (!existsSync(this.socketPath) && attempts < 50) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(this.socketPath)) {
      throw new Error(`RFDB server failed to start (socket not created after ${attempts * 100}ms)`);
    }

    this.log(`[RFDBServerBackend] Server started on ${this.socketPath}`);
  }

  /**
   * Negotiate protocol version with server.
   * Requests v3 (semantic IDs), falls back to v2 if server doesn't support it.
   * Called after ping() confirmed connectivity, so failures here indicate
   * the server doesn't support hello/v3, not network issues.
   */
  private async _negotiateProtocol(): Promise<void> {
    if (!this.client) return;
    try {
      const hello = await this.client.hello(3);
      this.protocolVersion = hello.protocolVersion;
    } catch {
      // Server predates hello command or doesn't support v3 — safe v2 fallback
      this.protocolVersion = 2;
    }
  }

  /**
   * Close client connection. Server continues running to serve other clients.
   */
  async close(): Promise<void> {
    // Request server flush before disconnecting
    if (this.client) {
      try {
        await this.client.flush();
      } catch {
        // Ignore flush errors on close - best effort
      }
      await this.client.close();
      this.client = null;
    }
    this.connected = false;

    // NOTE: We intentionally do NOT kill the server process.
    // The server continues running to serve other clients (MCP, other CLI invocations).
    // This is by design for multi-client architecture.
    // Server lifecycle is managed separately (system process, or manual grafema server stop).
    this.serverProcess = null;
  }

  /**
   * Clear the database
   */
  async clear(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.clear();
  }

  /**
   * Flush data to disk
   */
  async flush(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.flush();
  }

  /**
   * Declare metadata fields for server-side indexing.
   * Persisted in metadata.json — survives database reopen.
   */
  async declareFields(fields: FieldDeclaration[]): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.declareFields(fields);
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Add a single node
   */
  async addNode(node: InputNode): Promise<void> {
    return this.addNodes([node]);
  }

  /**
   * Add multiple nodes
   */
  async addNodes(nodes: InputNode[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (!nodes.length) return;

    const useV3 = this.protocolVersion >= 3;
    const wireNodes: WireNode[] = nodes.map(n => {
      // Extract metadata from node
      const { id, type, nodeType, node_type, name, file, exported, ...rest } = n;

      const wire: WireNode = {
        id: String(id),
        nodeType: (nodeType || node_type || type || 'UNKNOWN') as NodeType,
        name: name || '',
        file: file || '',
        exported: exported || false,
        metadata: useV3
          ? JSON.stringify(rest)
          : JSON.stringify({ originalId: String(id), ...rest }),
      };
      if (useV3) {
        wire.semanticId = String(id);
      }
      return wire;
    });

    await this.client.addNodes(wireNodes);
  }

  /**
   * Add a single edge
   */
  async addEdge(edge: InputEdge): Promise<void> {
    return this.addEdges([edge]);
  }

  /**
   * Add multiple edges
   */
  async addEdges(edges: InputEdge[], skipValidation = false): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (!edges.length) return;

    // Track edge types
    for (const e of edges) {
      const edgeType = e.edgeType || e.edge_type || e.etype || e.type;
      if (typeof edgeType === 'string') this.edgeTypes.add(edgeType);
    }

    const useV3 = this.protocolVersion >= 3;
    const wireEdges: WireEdge[] = edges.map(e => {
      const { src, dst, type, edgeType, edge_type, etype, metadata, ...rest } = e;

      // Flatten metadata: spread both edge-level properties and nested metadata
      const flatMetadata = useV3
        ? { ...rest, ...(typeof metadata === 'object' && metadata !== null ? metadata : {}) }
        : { _origSrc: String(src), _origDst: String(dst), ...rest, ...(typeof metadata === 'object' && metadata !== null ? metadata : {}) };

      return {
        src: String(src),
        dst: String(dst),
        edgeType: (edgeType || edge_type || etype || type || 'UNKNOWN') as EdgeType,
        metadata: JSON.stringify(flatMetadata),
      };
    });

    await this.client.addEdges(wireEdges, skipValidation);
  }

  /**
   * Get a node by ID
   */
  async getNode(id: string): Promise<BaseNodeRecord | null> {
    if (!this.client) throw new Error('Not connected');
    const node = await this.client.getNode(String(id));
    if (!node) return null;

    return this._parseNode(node);
  }

  /**
   * Check if node exists
   */
  async nodeExists(id: string): Promise<boolean> {
    if (!this.client) throw new Error('Not connected');
    return this.client.nodeExists(id);
  }

  /**
   * Delete a node
   */
  async deleteNode(id: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.deleteNode(id);
  }

  /**
   * Find nodes by attributes
   */
  async findByAttr(query: AttrQuery): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    return this.client.findByAttr(query);
  }

  /**
   * Parse a node from wire format to JS format
   */
  private _parseNode(wireNode: WireNode): BaseNodeRecord {
    const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

    // Parse nested JSON strings
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        try {
          metadata[key] = JSON.parse(value);
        } catch {
          // Not JSON, keep as string
        }
      }
    }

    // v3: use semanticId directly; v2: fall back to originalId metadata hack
    const humanId = wireNode.semanticId || (metadata.originalId as string) || wireNode.id;

    // Exclude standard fields from metadata to prevent overwriting wireNode values
    // REG-325: Metadata spread was overwriting name with LITERAL node data
    const {
      id: _id,
      type: _type,
      name: _name,
      file: _file,
      exported: _exported,
      nodeType: _nodeType,
      originalId: _originalId,  // Already extracted above
      ...safeMetadata
    } = metadata;

    return {
      id: humanId,
      type: wireNode.nodeType,
      name: wireNode.name,
      file: wireNode.file,
      exported: wireNode.exported,
      ...safeMetadata,
    };
  }

  /**
   * Parse an edge from wire format to EdgeRecord
   */
  private _parseEdge(wireEdge: WireEdge): EdgeRecord {
    const meta: Record<string, unknown> = wireEdge.metadata ? JSON.parse(wireEdge.metadata) : {};
    // v3: server resolves src/dst to semantic IDs, use directly
    // v2: fall back to _origSrc/_origDst metadata hack
    const { _origSrc, _origDst, ...rest } = meta;
    const src = this.protocolVersion >= 3
      ? wireEdge.src
      : (_origSrc as string) || wireEdge.src;
    const dst = this.protocolVersion >= 3
      ? wireEdge.dst
      : (_origDst as string) || wireEdge.dst;
    return {
      src,
      dst,
      type: wireEdge.edgeType,
      metadata: Object.keys(rest).length > 0 ? rest : undefined,
    };
  }

  /**
   * Async generator for querying nodes
   */
  async *queryNodes(query: NodeQuery): AsyncGenerator<BaseNodeRecord, void, unknown> {
    if (!this.client) throw new Error('Not connected');

    // Build query for server
    const serverQuery: NodeQuery = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;

    // Use findByType if only nodeType specified
    if (serverQuery.nodeType && Object.keys(serverQuery).length === 1) {
      const ids = await this.client.findByType(serverQuery.nodeType);
      for (const id of ids) {
        const node = await this.getNode(id);
        if (node) yield node;
      }
      return;
    }

    // Otherwise use client's queryNodes
    for await (const wireNode of this.client.queryNodes(serverQuery as unknown as RFDBAttrQuery)) {
      yield this._parseNode(wireNode);
    }
  }

  /**
   * Get ALL nodes matching query (collects from queryNodes into array)
   */
  async getAllNodes(query: NodeQuery = {}): Promise<BaseNodeRecord[]> {
    const nodes: BaseNodeRecord[] = [];
    for await (const node of this.queryNodes(query)) {
      nodes.push(node);
    }
    return nodes;
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Delete an edge
   */
  async deleteEdge(src: string, dst: string, type: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.deleteEdge(src, dst, type as EdgeType);
  }

  /**
   * Get all edges
   */
  async getAllEdges(): Promise<EdgeRecord[]> {
    return this.getAllEdgesAsync();
  }

  /**
   * Get all edges (async version)
   */
  async getAllEdgesAsync(): Promise<EdgeRecord[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getAllEdges();
    return edges.map(e => this._parseEdge(e));
  }

  /**
   * Get outgoing edges from a node
   */
  async getOutgoingEdges(nodeId: string, edgeTypes: EdgeType[] | null = null): Promise<EdgeRecord[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getOutgoingEdges(nodeId, edgeTypes || undefined);
    return edges.map(e => this._parseEdge(e));
  }

  /**
   * Get incoming edges to a node
   */
  async getIncomingEdges(nodeId: string, edgeTypes: EdgeType[] | null = null): Promise<EdgeRecord[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getIncomingEdges(nodeId, edgeTypes || undefined);
    return edges.map(e => this._parseEdge(e));
  }

  // ===========================================================================
  // Graph Traversal
  // ===========================================================================

  /**
   * BFS traversal
   */
  async bfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[]): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    return this.client.bfs(startIds, maxDepth, edgeTypes);
  }

  /**
   * DFS traversal
   */
  async dfs(startIds: string[], maxDepth: number, edgeTypes: EdgeType[] = []): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    return this.client.dfs(startIds, maxDepth, edgeTypes);
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
    if (!this.client) throw new Error('Not connected');
    return this.client.reachability(startIds, maxDepth, edgeTypes, backward);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get node count
   */
  async nodeCount(): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.nodeCount();
  }

  /**
   * Get edge count
   */
  async edgeCount(): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.edgeCount();
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<BackendStats> {
    if (!this.client) throw new Error('Not connected');
    const nodeCount = await this.client.nodeCount();
    const edgeCount = await this.client.edgeCount();
    const nodeCounts = await this.client.countNodesByType();
    const edgeCounts = await this.client.countEdgesByType();

    return {
      nodeCount,
      edgeCount,
      nodesByType: nodeCounts,
      edgesByType: edgeCounts,
    };
  }

  /**
   * Count nodes by type (sync, returns cached value)
   */
  async countNodesByType(_types: string[] | null = null): Promise<Record<string, number>> {
    if (!this.client) throw new Error('Not connected');
    return this.client.countNodesByType();
  }

  /**
   * Count edges by type
   */
  async countEdgesByType(_edgeTypes: string[] | null = null): Promise<Record<string, number>> {
    if (!this.client) throw new Error('Not connected');
    return this.client.countEdgesByType();
  }

  /**
   * Refresh cached counts (call after analysis)
   */
  async refreshCounts(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    this._cachedNodeCounts = await this.client.countNodesByType();
    this._cachedEdgeCounts = await this.client.countEdgesByType();
  }

  // ===========================================================================
  // Datalog Queries
  // ===========================================================================

  /**
   * Check a guarantee (Datalog rule) and return violations
   */
  async checkGuarantee(ruleSource: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> {
    if (!this.client) throw new Error('Not connected');
    const violations = await this.client.checkGuarantee(ruleSource);
    // Convert bindings from {X: "value"} to [{name: "X", value: "value"}]
    return violations.map(v => ({
      bindings: Object.entries(v.bindings).map(([name, value]) => ({ name, value }))
    }));
  }

  /**
   * Load Datalog rules
   */
  async datalogLoadRules(source: string): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.datalogLoadRules(source);
  }

  /**
   * Clear Datalog rules
   */
  async datalogClearRules(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.datalogClearRules();
  }

  /**
   * Run a Datalog query
   */
  async datalogQuery(query: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> {
    if (!this.client) throw new Error('Not connected');
    const results = await this.client.datalogQuery(query);
    // Convert bindings from {X: "value"} to [{name: "X", value: "value"}]
    return results.map(r => ({
      bindings: Object.entries(r.bindings).map(([name, value]) => ({ name, value }))
    }));
  }

  /**
   * Execute unified Datalog query or program.
   * Auto-detects whether input is rules or direct query.
   */
  async executeDatalog(source: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> {
    if (!this.client) throw new Error('Not connected');
    const results = await this.client.executeDatalog(source);
    return results.map(r => ({
      bindings: Object.entries(r.bindings).map(([name, value]) => ({ name, value }))
    }));
  }

  // ===========================================================================
  // Export/Import
  // ===========================================================================

  /**
   * Export graph (for tests)
   */
  async export(): Promise<GraphExport> {
    const nodes = await this.getAllNodes();
    const edges = await this.getAllEdgesAsync();
    return {
      nodes: nodes as unknown as GraphExport['nodes'],
      edges: edges as unknown as GraphExport['edges'],
    };
  }

  /**
   * Find nodes by predicate (for compatibility)
   */
  async findNodes(predicate: (node: BaseNodeRecord) => boolean): Promise<BaseNodeRecord[]> {
    const allNodes = await this.getAllNodes();
    return allNodes.filter(predicate);
  }

  // ===========================================================================
  // Graph property (for compatibility)
  // ===========================================================================

  get graph(): this {
    return this;
  }
}

export default RFDBServerBackend;
