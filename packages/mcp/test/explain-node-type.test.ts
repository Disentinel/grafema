/**
 * Regression test for handleExplain node-type rendering.
 *
 * BUG: handleExplain in dataflow-handlers.ts built its "Outgoing"/"Incoming"
 * structure summary by reading `dst.nodeType` / `src.nodeType`. The MCP server
 * runs on RFDBServerBackend, whose getNode()/queryNodes() pass results through
 * _parseNode(), which emits the canonical `type` field and explicitly EXCLUDES
 * `nodeType` from the returned record. So `dst.nodeType` / `src.nodeType` were
 * always `undefined`, and the explain output — which is fed to a calling LLM —
 * rendered garbage like `CALLS → undefined "processData"` instead of
 * `CALLS → FUNCTION "processData"`.
 *
 * These tests are TDD — they FAIL before the fix (undefined in the output)
 * and pass after the handler reads the canonical `type` field.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';

// --- Mock backend mirroring RFDBServerBackend's parsed-node contract ---
// Parsed nodes expose `type` (NOT `nodeType`), matching _parseNode() output.

interface MockNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  [key: string]: unknown;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
}

function createExplainMockBackend() {
  const nodes = new Map<string, MockNode>();
  const edges: MockEdge[] = [];

  return {
    async getNode(id: string): Promise<MockNode | null> {
      return nodes.get(id) ?? null;
    },
    async *queryNodes(filter: Record<string, unknown>): AsyncGenerator<MockNode> {
      for (const node of nodes.values()) {
        let ok = true;
        for (const [k, v] of Object.entries(filter)) {
          if (node[k] !== v) { ok = false; break; }
        }
        if (ok) yield node;
      }
    },
    async getOutgoingEdges(id: string, types?: string[] | null): Promise<MockEdge[]> {
      return edges.filter(e => e.src === id && (!types || types.includes(e.type)));
    },
    async getIncomingEdges(id: string, types?: string[] | null): Promise<MockEdge[]> {
      return edges.filter(e => e.dst === id && (!types || types.includes(e.type)));
    },
    async getAllNodes(): Promise<MockNode[]> {
      return [...nodes.values()];
    },
    async findByType(): Promise<MockNode[]> { return []; },
    async findByAttr(): Promise<MockNode[]> { return []; },
    addNode(node: MockNode) { nodes.set(node.id, node); },
    addEdge(edge: MockEdge) { edges.push(edge); },
  };
}

let mockBackend: ReturnType<typeof createExplainMockBackend>;

// Mock BEFORE importing the handler.
mock.module('../dist/analysis.js', {
  namedExports: {
    ensureAnalyzed: async () => mockBackend,
  },
});
mock.module('../dist/state.js', {
  namedExports: {
    getProjectPath: () => '/mock/project',
  },
});

const { handleExplain } = await import('../dist/handlers/dataflow-handlers.js');

describe('handleExplain node-type rendering (RFDBServerBackend uses `type`, not `nodeType`)', () => {
  beforeEach(() => {
    mockBackend = createExplainMockBackend();

    // Target FUNCTION node (found by name via queryNodes).
    mockBackend.addNode({
      id: 'FUNCTION:app.js:handleRequest',
      type: 'FUNCTION',
      name: 'handleRequest',
      file: 'app.js',
    });
    // Callee reached via an outgoing CALLS edge.
    mockBackend.addNode({
      id: 'FUNCTION:app.js:processData',
      type: 'FUNCTION',
      name: 'processData',
      file: 'app.js',
    });
    // Caller reached via an incoming CALLS edge.
    mockBackend.addNode({
      id: 'FUNCTION:app.js:router',
      type: 'FUNCTION',
      name: 'router',
      file: 'app.js',
    });

    mockBackend.addEdge({
      src: 'FUNCTION:app.js:handleRequest',
      dst: 'FUNCTION:app.js:processData',
      type: 'CALLS',
    });
    mockBackend.addEdge({
      src: 'FUNCTION:app.js:router',
      dst: 'FUNCTION:app.js:handleRequest',
      type: 'CALLS',
    });
  });

  /**
   * WHY: The "Outgoing" section feeds the calling LLM a structural summary of
   * the function's call graph. The destination node's type MUST be the real
   * node type ("FUNCTION"), not "undefined".
   */
  it('renders the real node type for outgoing CALLS edges', async () => {
    const result = await handleExplain({ target: 'handleRequest' });

    assert.ok(!result.isError, 'Should not be an error');
    const text = result.content[0].text;
    assert.ok(
      text.includes('CALLS → FUNCTION "processData"'),
      `Outgoing edge should render the callee type. Got:\n${text}`
    );
    assert.ok(
      !text.includes('→ undefined'),
      `Outgoing summary must not contain "undefined". Got:\n${text}`
    );
  });

  /**
   * WHY: Same contract for the "Incoming" section — the source node's type
   * must render, not "undefined".
   */
  it('renders the real node type for incoming CALLS edges', async () => {
    const result = await handleExplain({ target: 'handleRequest' });

    assert.ok(!result.isError, 'Should not be an error');
    const text = result.content[0].text;
    assert.ok(
      text.includes('CALLS ← FUNCTION "router"'),
      `Incoming edge should render the caller type. Got:\n${text}`
    );
    assert.ok(
      !text.includes('← undefined'),
      `Incoming summary must not contain "undefined". Got:\n${text}`
    );
  });

  /**
   * WHY: Regression guard — the header line already worked (it had a
   * `nodeType || type` fallback), so it must keep rendering the type after
   * the fallback is simplified to the canonical `type` field.
   */
  it('renders the target node type in the header', async () => {
    const result = await handleExplain({ target: 'handleRequest' });

    assert.ok(!result.isError, 'Should not be an error');
    const text = result.content[0].text;
    assert.ok(
      text.includes('## FUNCTION "handleRequest" in app.js'),
      `Header should render the target type. Got:\n${text}`
    );
  });
});
