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
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

import type { WireNode, WireEdge } from '@grafema/types';
import type { NodeType, EdgeType } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';
import type { AttrQuery, GraphStats, GraphExport } from '../../core/GraphBackend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Options for RFDBServerBackend
 */
export interface RFDBServerBackendOptions {
  socketPath?: string;
  dbPath?: string;
}

/**
 * Edge as returned from the backend
 */
export interface BackendEdge {
  src: string;
  dst: string;
  type: string;
  edgeType: string;
  [key: string]: unknown;
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
  private client: RFDBClient | null;
  private serverProcess: ChildProcess | null;
  connected: boolean;  // Public for compatibility
  private edgeTypes: Set<string>;
  private _cachedNodeCounts: Record<string, number> | undefined;
  private _cachedEdgeCounts: Record<string, number> | undefined;

  constructor(options: RFDBServerBackendOptions = {}) {
    this.dbPath = options.dbPath;
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
   * Connect to RFDB server, starting it if necessary
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Try to connect first
    this.client = new RFDBClient(this.socketPath);

    try {
      await this.client.connect();
      // Verify server is responsive
      await this.client.ping();
      this.connected = true;
      console.log(`[RFDBServerBackend] Connected to existing RFDB server at ${this.socketPath}`);
      return;
    } catch {
      // Server not running, need to start it
      console.log(`[RFDBServerBackend] RFDB server not running, starting...`);
    }

    // Start the server
    await this._startServer();

    // Connect again
    this.client = new RFDBClient(this.socketPath);
    await this.client.connect();
    await this.client.ping();
    this.connected = true;
    console.log(`[RFDBServerBackend] Connected to RFDB server at ${this.socketPath}`);
  }

  /**
   * Alias for connect()
   */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Find RFDB server binary in order of preference:
   * 1. @grafema/rfdb npm package
   * 2. rust-engine/target/release (monorepo development)
   * 3. rust-engine/target/debug
   */
  private _findServerBinary(): string | null {
    // 1. Check @grafema/rfdb npm package
    try {
      const rfdbPkg = require.resolve('@grafema/rfdb');
      const rfdbDir = dirname(rfdbPkg);
      const platform = process.platform;
      const arch = process.arch;

      let platformDir: string;
      if (platform === 'darwin') {
        platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
      } else if (platform === 'linux') {
        platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
      } else {
        platformDir = `${platform}-${arch}`;
      }

      const npmBinary = join(rfdbDir, 'prebuilt', platformDir, 'rfdb-server');
      if (existsSync(npmBinary)) {
        console.log(`[RFDBServerBackend] Found binary in @grafema/rfdb: ${npmBinary}`);
        return npmBinary;
      }
    } catch {
      // @grafema/rfdb not installed
    }

    // 2. Check rust-engine in monorepo
    const projectRoot = join(__dirname, '../../../../..');
    const releaseBinary = join(projectRoot, 'rust-engine/target/release/rfdb-server');
    if (existsSync(releaseBinary)) {
      console.log(`[RFDBServerBackend] Found release binary: ${releaseBinary}`);
      return releaseBinary;
    }

    // 3. Check debug build
    const debugBinary = join(projectRoot, 'rust-engine/target/debug/rfdb-server');
    if (existsSync(debugBinary)) {
      console.log(`[RFDBServerBackend] Found debug binary: ${debugBinary}`);
      return debugBinary;
    }

    return null;
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

    console.log(`[RFDBServerBackend] Starting: ${binaryPath} ${this.dbPath} --socket ${this.socketPath}`);

    this.serverProcess = spawn(binaryPath, [this.dbPath, '--socket', this.socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // Allow server to outlive this process
    });

    // Don't let server process prevent parent from exiting
    this.serverProcess.unref();

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes('FLUSH') && !msg.includes('WRITER')) {
        console.log(`[rfdb-server] ${msg}`);
      }
    });

    this.serverProcess.on('error', (err: Error) => {
      console.error(`[RFDBServerBackend] Server process error:`, err);
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

    console.log(`[RFDBServerBackend] Server started on ${this.socketPath}`);
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

    const wireNodes: WireNode[] = nodes.map(n => {
      // Extract metadata from node
      const { id, type, nodeType, node_type, name, file, exported, ...rest } = n;

      return {
        id: String(id),
        nodeType: (nodeType || node_type || type || 'UNKNOWN') as NodeType,
        name: name || '',
        file: file || '',
        exported: exported || false,
        metadata: JSON.stringify({ originalId: String(id), ...rest }),
      };
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

    const wireEdges: WireEdge[] = edges.map(e => {
      const { src, dst, type, edgeType, edge_type, etype, metadata, ...rest } = e;

      // Flatten metadata: spread both edge-level properties and nested metadata
      const flatMetadata = {
        _origSrc: String(src),
        _origDst: String(dst),
        ...rest,
        ...(typeof metadata === 'object' && metadata !== null ? metadata : {})
      };

      return {
        src: String(src),
        dst: String(dst),
        edgeType: (edgeType || edge_type || etype || type || 'UNKNOWN') as EdgeType,
        // Store flattened metadata for retrieval
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

    const humanId = (metadata.originalId as string) || wireNode.id;

    return {
      id: humanId,
      type: wireNode.nodeType,
      name: wireNode.name,
      file: wireNode.file,
      exported: wireNode.exported,
      ...metadata,
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
    for await (const wireNode of this.client.queryNodes(serverQuery)) {
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
  async getAllEdges(): Promise<BackendEdge[]> {
    return this.getAllEdgesAsync();
  }

  /**
   * Get all edges (async version)
   */
  async getAllEdgesAsync(): Promise<BackendEdge[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getAllEdges();
    return edges.map(e => {
      const meta = JSON.parse(e.metadata || '{}');
      // Use original string IDs if stored, otherwise use numeric IDs
      const { _origSrc, _origDst, ...rest } = meta;
      return {
        src: _origSrc || e.src,
        dst: _origDst || e.dst,
        type: e.edgeType,
        edgeType: e.edgeType,
        ...rest,
      };
    });
  }

  /**
   * Get outgoing edges from a node
   */
  async getOutgoingEdges(nodeId: string, edgeTypes: EdgeType[] | null = null): Promise<BackendEdge[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getOutgoingEdges(nodeId, edgeTypes || undefined);
    return edges.map(e => {
      const meta = JSON.parse(e.metadata || '{}');
      const { _origSrc, _origDst, ...rest } = meta;
      return {
        src: _origSrc || e.src,
        dst: _origDst || e.dst,
        type: e.edgeType,
        edgeType: e.edgeType,
        ...rest,
      };
    });
  }

  /**
   * Get incoming edges to a node
   */
  async getIncomingEdges(nodeId: string, edgeTypes: EdgeType[] | null = null): Promise<BackendEdge[]> {
    if (!this.client) throw new Error('Not connected');
    const edges = await this.client.getIncomingEdges(nodeId, edgeTypes || undefined);
    return edges.map(e => {
      const meta = JSON.parse(e.metadata || '{}');
      const { _origSrc, _origDst, ...rest } = meta;
      return {
        src: _origSrc || e.src,
        dst: _origDst || e.dst,
        type: e.edgeType,
        edgeType: e.edgeType,
        ...rest,
      };
    });
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
