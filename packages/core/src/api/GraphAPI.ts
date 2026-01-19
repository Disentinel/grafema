/**
 * Clean Graph API for visualization
 * Reads everything directly from RFDB (no caches)
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';

// Node type constants
const NODE_TYPES = {
  SERVICE: 2,
  FUNCTION: 3,
  CLASS: 4,
  MODULE: 8,
} as const;

// Edge type constants
const EDGE_TYPES = {
  CONTAINS: 1,
  DEPENDS_ON: 2,
  CALLS: 3,
  IMPORTS: 8,
} as const;

/**
 * Native node from engine
 */
interface NativeNode {
  id: bigint;
  kind: number;
  exported: boolean;
  version: number;
  name_offset?: number;
}

/**
 * Native edge from engine
 */
interface NativeEdge {
  src: bigint;
  dst: bigint;
  etype: number;
  version: number;
}

/**
 * Engine interface
 */
interface GraphEngine {
  findByType(type: number): bigint[];
  getNode(id: bigint): NativeNode | null;
  nodeExists(id: bigint): boolean;
  getOutgoingEdges(id: bigint, types: number[] | null): NativeEdge[];
}

/**
 * Backend interface
 */
interface GraphBackend {
  engine: GraphEngine;
  _bigIntToId(id: bigint): string;
  _idToBigInt(id: string): bigint;
  _numberToNodeType(kind: number): string;
  _numberToEdgeType(etype: number): string;
}

/**
 * Formatted node for API response
 */
interface FormattedNode {
  id: string;
  type: string;
  name: string;
  exported: boolean;
  version: number;
}

/**
 * Formatted edge for API response
 */
interface FormattedEdge {
  src: string;
  dst: string;
  type: string;
  version: number;
}

export class GraphAPI {
  private backend: GraphBackend;
  private port: number;
  private server: Server | null;

  constructor(backend: GraphBackend, port: number = 3000) {
    this.backend = backend;
    this.port = port;
    this.server = null;
  }

  /**
   * Start API server
   */
  start(): this {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(this.port, () => {
      console.log(`\n🚀 Graph API Server started`);
      console.log(`📊 http://localhost:${this.port}`);
      console.log(`\nEndpoints:`);
      console.log(`  GET /api/services - List all services`);
      console.log(`  GET /api/node/:id - Get node by ID`);
      console.log(`  GET /api/node/:id/children - Get node children (via CONTAINS edges)`);
      console.log(`  GET /api/node/:id/edges - Get all edges from node`);
      console.log(`\nPress Ctrl+C to stop\n`);
    });

    return this;
  }

  /**
   * Stop server
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      console.log('Graph API Server stopped');
    }
  }

  /**
   * Handle HTTP request
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = parseUrl(req.url || '', true);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
      // GET /api/services
      if (pathname === '/api/services') {
        await this.handleGetServices(req, res);
        return;
      }

      // GET /api/node/:id
      const nodeMatch = pathname?.match(/^\/api\/node\/([^\/]+)$/);
      if (nodeMatch) {
        await this.handleGetNode(req, res, decodeURIComponent(nodeMatch[1]));
        return;
      }

      // GET /api/node/:id/children
      const childrenMatch = pathname?.match(/^\/api\/node\/([^\/]+)\/children$/);
      if (childrenMatch) {
        await this.handleGetChildren(req, res, decodeURIComponent(childrenMatch[1]));
        return;
      }

      // GET /api/node/:id/edges
      const edgesMatch = pathname?.match(/^\/api\/node\/([^\/]+)\/edges$/);
      if (edgesMatch) {
        await this.handleGetEdges(req, res, decodeURIComponent(edgesMatch[1]));
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (error) {
      console.error('API error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  }

  /**
   * GET /api/services
   * Returns all SERVICE nodes
   */
  async handleGetServices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Find all SERVICE nodes from RFDB
    const serviceIds = this.backend.engine.findByType(NODE_TYPES.SERVICE);

    const services = serviceIds.map(id => {
      const node = this.backend.engine.getNode(id);
      if (!node) return null;

      return {
        id: this.backend._bigIntToId(node.id),
        type: 'SERVICE',
        name: this.getNodeName(node),
        exported: node.exported,
        version: node.version,
      };
    }).filter(Boolean) as FormattedNode[];

    res.writeHead(200);
    res.end(JSON.stringify(services));
  }

  /**
   * GET /api/node/:id
   * Returns single node by ID
   */
  async handleGetNode(req: IncomingMessage, res: ServerResponse, nodeId: string): Promise<void> {
    const node = this.backend.engine.getNode(this.backend._idToBigInt(nodeId));

    if (!node) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Node not found' }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({
      id: this.backend._bigIntToId(node.id),
      type: this.backend._numberToNodeType(node.kind),
      name: this.getNodeName(node),
      exported: node.exported,
      version: node.version,
    }));
  }

  /**
   * GET /api/node/:id/children
   * Returns children via CONTAINS edges
   */
  async handleGetChildren(req: IncomingMessage, res: ServerResponse, nodeId: string): Promise<void> {
    const nodeIdBigInt = this.backend._idToBigInt(nodeId);

    // Check node exists
    if (!this.backend.engine.nodeExists(nodeIdBigInt)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Node not found' }));
      return;
    }

    // Get outgoing CONTAINS edges
    const edges = this.backend.engine.getOutgoingEdges(nodeIdBigInt, [EDGE_TYPES.CONTAINS]);

    const children = edges.map(edge => {
      const childNode = this.backend.engine.getNode(edge.dst);
      if (!childNode) return null;

      return {
        id: this.backend._bigIntToId(childNode.id),
        type: this.backend._numberToNodeType(childNode.kind),
        name: this.getNodeName(childNode),
        exported: childNode.exported,
        version: childNode.version,
      };
    }).filter(Boolean) as FormattedNode[];

    res.writeHead(200);
    res.end(JSON.stringify({
      nodeId,
      childCount: children.length,
      children
    }));
  }

  /**
   * GET /api/node/:id/edges
   * Returns all outgoing edges from node
   */
  async handleGetEdges(req: IncomingMessage, res: ServerResponse, nodeId: string): Promise<void> {
    const nodeIdBigInt = this.backend._idToBigInt(nodeId);

    // Check node exists
    if (!this.backend.engine.nodeExists(nodeIdBigInt)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Node not found' }));
      return;
    }

    // Get all outgoing edges
    const edges = this.backend.engine.getOutgoingEdges(nodeIdBigInt, null);

    const formattedEdges: FormattedEdge[] = edges.map(edge => ({
      src: this.backend._bigIntToId(edge.src),
      dst: this.backend._bigIntToId(edge.dst),
      type: this.backend._numberToEdgeType(edge.etype),
      version: edge.version,
    }));

    res.writeHead(200);
    res.end(JSON.stringify({
      nodeId,
      edgeCount: formattedEdges.length,
      edges: formattedEdges
    }));
  }

  /**
   * Get node name from name_offset (TODO: implement string table lookup)
   */
  private getNodeName(node: NativeNode): string {
    // TODO: Lookup in string table
    // For now return placeholder
    return `Node_${node.id.toString().substring(0, 8)}`;
  }
}
