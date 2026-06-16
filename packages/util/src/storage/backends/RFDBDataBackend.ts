/**
 * RFDBDataBackend — node/edge data operations for RFDBServerBackend.
 *
 * Extracted from RFDBServerBackend.ts (REG-490). Layer 2 of the backend:
 * RFDBConnectionBase → RFDBDataBackend → RFDBServerBackend. Holds node/edge
 * CRUD, graph traversal, and batch operations. Heavy wire-conversion/parse
 * logic lives in rfdbCodec.ts; methods here stay thin delegations over the
 * shared `this.client`.
 */

import type { BatchHandle } from '@grafema/rfdb-client';
import type {
  WireNode, WireEdge, AttrQuery as RFDBAttrQuery, CommitDelta,
  BaseNodeRecord, EdgeRecord, AnyBrandedNode, EdgeType,
} from '@grafema/types';

import type { AttrQuery, GraphExport } from '../../core/GraphBackend.js';
import { RFDBConnectionBase } from './RFDBConnectionBase.js';
import type { InputNode, InputEdge, NodeQuery } from './rfdbTypes.js';
import {
  validateInputNodes, toWireNodes, toWireNode,
  validateInputEdges, toWireEdges, toWireEdge, edgeTypeOf,
  parseWireNode, parseWireEdge,
} from './rfdbCodec.js';

export class RFDBDataBackend extends RFDBConnectionBase {
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

    validateInputNodes(nodes);

    const useV3 = this.protocolVersion >= 3;
    await this.client.addNodes(toWireNodes(nodes, useV3));
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

    if (!skipValidation) {
      validateInputEdges(edges);
    }

    // Track edge types
    for (const e of edges) {
      const t = edgeTypeOf(e);
      if (t) this.edgeTypes.add(t);
    }

    const useV3 = this.protocolVersion >= 3;
    await this.client.addEdges(toWireEdges(edges, useV3), skipValidation);
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
   * Parse a node from wire format to JS format (see rfdbCodec.parseWireNode).
   */
  private _parseNode(wireNode: WireNode): AnyBrandedNode {
    return parseWireNode(wireNode);
  }

  /**
   * Parse an edge from wire format to EdgeRecord (see rfdbCodec.parseWireEdge).
   */
  private _parseEdge(wireEdge: WireEdge): EdgeRecord {
    return parseWireEdge(wireEdge, this.protocolVersion);
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
    if (query.substringMatch) serverQuery.substringMatch = query.substringMatch;

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
  // Batch Operations (RFD-16: CommitBatch protocol)
  // ===========================================================================

  /**
   * Begin a batch operation. While batching, addNodes/addEdges buffer locally.
   * Call commitBatch() to send all buffered data atomically.
   */
  beginBatch(): void {
    if (!this.client) throw new Error('Not connected to RFDB server');
    this.client.beginBatch();
  }

  /**
   * Commit the current batch to the server atomically.
   * Returns a CommitDelta describing what changed.
   *
   * @param tags - Optional tags for the commit
   * @param deferIndex - When true, server writes data but skips index rebuild.
   */
  async commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[], changedFiles?: string[]): Promise<CommitDelta> {
    if (!this.client) throw new Error('Not connected to RFDB server');
    return this.client.commitBatch(tags, deferIndex, protectedTypes, changedFiles);
  }

  /**
   * Synchronously batch a node. Must be inside beginBatch/commitBatch.
   * Bypasses async wrapper for direct batch insertion.
   */
  batchNode(node: InputNode): void {
    if (!this.client) throw new Error('Not connected');
    const useV3 = this.protocolVersion >= 3;
    const wire = toWireNode(node, useV3);
    this.client.batchNode(wire as unknown as Parameters<typeof this.client.batchNode>[0]);
  }

  /**
   * Synchronously batch an edge. Must be inside beginBatch/commitBatch.
   */
  batchEdge(edge: InputEdge): void {
    if (!this.client) throw new Error('Not connected');
    const t = edgeTypeOf(edge);
    if (t) this.edgeTypes.add(t);
    const useV3 = this.protocolVersion >= 3;
    const wire = toWireEdge(edge, useV3, true);
    this.client.batchEdge(wire as unknown as Parameters<typeof this.client.batchEdge>[0]);
  }

  /**
   * Abort the current batch, discarding all buffered data.
   */
  abortBatch(): void {
    if (!this.client) throw new Error('Not connected to RFDB server');
    this.client.abortBatch();
  }

  /**
   * Rebuild all secondary indexes after deferred-index commits (REG-487).
   * Call this once after a series of commitBatch(tags, true) calls.
   */
  async rebuildIndexes(): Promise<void> {
    if (!this.client) throw new Error('Not connected to RFDB server');
    await this.client.rebuildIndexes();
  }

  /**
   * Create an isolated batch handle for concurrent-safe batching (REG-487).
   * Each handle has its own buffers — safe for parallel workers.
   */
  createBatch(): BatchHandle {
    if (!this.client) throw new Error('Not connected to RFDB server');
    return this.client.createBatch();
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
}
