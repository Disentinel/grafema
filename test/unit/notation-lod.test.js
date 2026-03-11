/**
 * Tests for notation/lodExtractor — subgraph extraction at different LOD levels
 *
 * Uses a mock backend with a known graph structure.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { extractSubgraph } from '../../packages/util/dist/notation/index.js';

// Mock graph backend
function createMockBackend(nodes, edges) {
  const nodeMap = new Map();
  for (const n of nodes) nodeMap.set(n.id, n);

  return {
    async getNode(id) {
      return nodeMap.get(id) ?? null;
    },
    async getOutgoingEdges(nodeId, edgeTypes) {
      return edges.filter(e => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
    async getIncomingEdges(nodeId, edgeTypes) {
      return edges.filter(e => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
  };
}

// Test graph:
//   MODULE:auth.ts
//   ├── CONTAINS → FUNCTION:login
//   │   ├── CALLS → FUNCTION:validate (external)
//   │   ├── READS_FROM → VARIABLE:config
//   │   └── CONTAINS → VARIABLE:token (grandchild)
//   ├── CONTAINS → FUNCTION:logout
//   │   └── CALLS → FUNCTION:cleanup
//   └── IMPORTS → EXTERNAL:bcrypt

const NODES = [
  { id: 'auth.ts', type: 'MODULE', name: 'auth.ts' },
  { id: 'login', type: 'FUNCTION', name: 'login' },
  { id: 'logout', type: 'FUNCTION', name: 'logout' },
  { id: 'validate', type: 'FUNCTION', name: 'validate' },
  { id: 'config', type: 'VARIABLE', name: 'config' },
  { id: 'token', type: 'VARIABLE', name: 'token' },
  { id: 'cleanup', type: 'FUNCTION', name: 'cleanup' },
  { id: 'bcrypt', type: 'EXTERNAL', name: 'bcrypt' },
];

const EDGES = [
  // Module structure
  { src: 'auth.ts', dst: 'login', type: 'CONTAINS' },
  { src: 'auth.ts', dst: 'logout', type: 'CONTAINS' },
  { src: 'auth.ts', dst: 'bcrypt', type: 'IMPORTS' },

  // login's edges
  { src: 'login', dst: 'validate', type: 'CALLS' },
  { src: 'login', dst: 'config', type: 'READS_FROM' },
  { src: 'login', dst: 'token', type: 'CONTAINS' },

  // logout's edges
  { src: 'logout', dst: 'cleanup', type: 'CALLS' },
];

describe('extractSubgraph', () => {
  it('LOD 0: should return root + containment children, no operator edges', async () => {
    const backend = createMockBackend(NODES, EDGES);
    const subgraph = await extractSubgraph(backend, 'auth.ts', 0);

    assert.strictEqual(subgraph.rootNodes.length, 1);
    assert.strictEqual(subgraph.rootNodes[0].id, 'auth.ts');

    // Should have containment edges but NOT operator edges
    const containmentEdges = subgraph.edges.filter(e => e.type === 'CONTAINS');
    const importEdges = subgraph.edges.filter(e => e.type === 'IMPORTS');

    assert.strictEqual(containmentEdges.length, 2, 'Should have 2 CONTAINS edges');
    assert.strictEqual(importEdges.length, 0, 'Should NOT have IMPORTS edge at LOD 0');

    // NodeMap should have root + children
    assert.ok(subgraph.nodeMap.has('auth.ts'));
    assert.ok(subgraph.nodeMap.has('login'));
    assert.ok(subgraph.nodeMap.has('logout'));
  });

  it('LOD 1: should include operator edges and resolve targets', async () => {
    const backend = createMockBackend(NODES, EDGES);
    const subgraph = await extractSubgraph(backend, 'auth.ts', 1);

    // Should have containment + operator edges
    const importEdges = subgraph.edges.filter(e => e.type === 'IMPORTS');
    const callEdges = subgraph.edges.filter(e => e.type === 'CALLS');
    const readsEdges = subgraph.edges.filter(e => e.type === 'READS_FROM');

    assert.strictEqual(importEdges.length, 1, 'Should have IMPORTS edge');
    assert.strictEqual(callEdges.length, 2, 'Should have 2 CALLS edges (login+logout)');
    assert.strictEqual(readsEdges.length, 1, 'Should have READS_FROM edge');

    // Target nodes should be resolved
    assert.ok(subgraph.nodeMap.has('validate'), 'Should resolve validate target');
    assert.ok(subgraph.nodeMap.has('config'), 'Should resolve config target');
    assert.ok(subgraph.nodeMap.has('bcrypt'), 'Should resolve bcrypt target');
    assert.ok(subgraph.nodeMap.has('cleanup'), 'Should resolve cleanup target');
  });

  it('LOD 2: should expand grandchildren', async () => {
    const backend = createMockBackend(NODES, EDGES);
    const subgraph = await extractSubgraph(backend, 'auth.ts', 2);

    // login has a CONTAINS → token (grandchild)
    const loginContains = subgraph.edges.filter(
      e => e.src === 'login' && e.type === 'CONTAINS',
    );
    assert.strictEqual(loginContains.length, 1, 'Should have login→token CONTAINS edge');
    assert.ok(subgraph.nodeMap.has('token'), 'Should resolve grandchild token');
  });

  it('should return empty subgraph for non-existent node', async () => {
    const backend = createMockBackend(NODES, EDGES);
    const subgraph = await extractSubgraph(backend, 'does-not-exist', 1);

    assert.strictEqual(subgraph.rootNodes.length, 0);
    assert.strictEqual(subgraph.edges.length, 0);
    assert.strictEqual(subgraph.nodeMap.size, 0);
  });

  it('should handle leaf node with no edges', async () => {
    const backend = createMockBackend(
      [{ id: 'lonely', type: 'FUNCTION', name: 'lonely' }],
      [],
    );
    const subgraph = await extractSubgraph(backend, 'lonely', 1);

    assert.strictEqual(subgraph.rootNodes.length, 1);
    assert.strictEqual(subgraph.rootNodes[0].name, 'lonely');
    assert.strictEqual(subgraph.edges.length, 0);
  });

  it('LOD 1 should not fetch grandchildren containment', async () => {
    const backend = createMockBackend(NODES, EDGES);
    const subgraph = await extractSubgraph(backend, 'auth.ts', 1);

    // login→token CONTAINS should NOT be in LOD 1 (only LOD 2)
    const loginContains = subgraph.edges.filter(
      e => e.src === 'login' && e.dst === 'token' && e.type === 'CONTAINS',
    );
    assert.strictEqual(loginContains.length, 0, 'LOD 1 should not fetch grandchild containment');
  });
});
