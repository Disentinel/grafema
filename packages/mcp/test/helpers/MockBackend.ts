/**
 * In-memory mock backend for MCP tests
 *
 * Allows testing handlers without real RFDB server.
 * Simulates slow analysis via configurable delays.
 *
 * Key features:
 * - In-memory node/edge storage
 * - `clearCallCount` to verify single clear in concurrency tests
 * - `analysisDelay` option for simulating slow analysis
 * - Implements minimal GraphBackend interface
 */

export interface MockBackendOptions {
  /** Delay in ms for analysis simulation */
  analysisDelay?: number;
  /** Initial node count (simulates existing analysis) */
  initialNodeCount?: number;
}

interface MockNode {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
  [key: string]: unknown;
}

export class MockBackend {
  private nodes: Map<string, MockNode> = new Map();
  private edges: MockEdge[] = [];
  public analysisDelay: number;
  public clearCalled = false;
  public clearCallCount = 0;

  constructor(options: MockBackendOptions = {}) {
    this.analysisDelay = options.analysisDelay ?? 0;
    if (options.initialNodeCount) {
      for (let i = 0; i < options.initialNodeCount; i++) {
        this.nodes.set(`node-${i}`, { id: `node-${i}`, type: 'MOCK' });
      }
    }
  }

  async connect(): Promise<void> {
    // No-op for mock
  }

  async close(): Promise<void> {
    // No-op for mock
  }

  async clear(): Promise<void> {
    this.clearCalled = true;
    this.clearCallCount++;
    this.nodes.clear();
    this.edges = [];
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return this.edges.length;
  }

  async addNode(node: MockNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<MockNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async countNodesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      counts[node.type] = (counts[node.type] || 0) + 1;
    }
    return counts;
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const edge of this.edges) {
      counts[edge.type] = (counts[edge.type] || 0) + 1;
    }
    return counts;
  }

  async *queryNodes(filter: Record<string, unknown>): AsyncGenerator<MockNode> {
    for (const node of this.nodes.values()) {
      if (this.matchesFilter(node, filter)) {
        yield node;
      }
    }
  }

  async getOutgoingEdges(id: string, types?: string[]): Promise<MockEdge[]> {
    return this.edges.filter(e =>
      e.src === id && (!types || types.includes(e.type))
    );
  }

  async getIncomingEdges(id: string, types?: string[]): Promise<MockEdge[]> {
    return this.edges.filter(e =>
      e.dst === id && (!types || types.includes(e.type))
    );
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  private matchesFilter(node: MockNode, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (node[key] !== value) return false;
    }
    return true;
  }
}
