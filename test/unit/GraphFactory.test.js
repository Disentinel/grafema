/**
 * GraphFactory Unit Tests (REG-541)
 *
 * TDD tests for GraphFactory — a plugin-facing write proxy that wraps
 * a GraphBackend with non-restricted method names (store, link, etc.)
 * and delegates read operations transparently.
 *
 * Uses a hand-rolled stub backend (no jest/sinon) matching the project's
 * test patterns. The stub records calls for verification.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// GraphFactory does not exist yet — this import will fail until implementation.
// That is the TDD contract: tests first, implementation follows.
import { GraphFactory, NodeFactory } from '@grafema/core';

// ============================================================================
// Stub Backend
// ============================================================================

/**
 * Hand-rolled stub that implements the GraphBackend interface surface
 * needed by GraphFactory. Records all calls for test assertions.
 *
 * Follows the same pattern used in this codebase: plain objects with
 * method stubs, no external mocking libraries.
 */
function createStubBackend() {
  const calls = {
    addNode: [],
    addNodes: [],
    addEdge: [],
    addEdges: [],
    getNode: [],
    queryNodes: [],
    getOutgoingEdges: [],
    getIncomingEdges: [],
  };

  const storedNodes = new Map();

  return {
    calls,
    storedNodes,

    async addNode(node) {
      calls.addNode.push(node);
      storedNodes.set(node.id, node);
    },

    async addNodes(nodes) {
      calls.addNodes.push(nodes);
      for (const node of nodes) {
        storedNodes.set(node.id, node);
      }
    },

    async addEdge(edge) {
      calls.addEdge.push(edge);
    },

    async addEdges(edges, skipValidation) {
      calls.addEdges.push({ edges, skipValidation });
    },

    async getNode(id) {
      calls.getNode.push(id);
      return storedNodes.get(id) || null;
    },

    async *queryNodes(filter) {
      calls.queryNodes.push(filter);
      for (const node of storedNodes.values()) {
        if (!filter.type || node.type === filter.type) {
          yield node;
        }
      }
    },

    async getOutgoingEdges(nodeId, edgeTypes) {
      calls.getOutgoingEdges.push({ nodeId, edgeTypes });
      return [];
    },

    async getIncomingEdges(nodeId, edgeTypes) {
      calls.getIncomingEdges.push({ nodeId, edgeTypes });
      return [];
    },
  };
}


describe('GraphFactory', () => {
  let backend;
  let graphFactory;

  beforeEach(() => {
    backend = createStubBackend();
    graphFactory = new GraphFactory(backend);
  });


  // ==========================================================================
  // rawGraph getter
  // ==========================================================================

  describe('rawGraph', () => {

    it('should expose the underlying GraphBackend', () => {
      const raw = graphFactory.rawGraph;

      assert.strictEqual(raw, backend, 'rawGraph should return the backend passed to constructor');
    });

    it('should allow direct addNode via rawGraph', async () => {
      const node = NodeFactory.createFunction('handler', '/src/app.js', 10, 0);

      await graphFactory.rawGraph.addNode(node);

      assert.strictEqual(backend.calls.addNode.length, 1);
      assert.strictEqual(backend.calls.addNode[0].id, node.id);
      assert.strictEqual(backend.calls.addNode[0].type, 'FUNCTION');
    });

  });


  // ==========================================================================
  // rawGraph — edge operations
  // ==========================================================================

  describe('rawGraph edge operations', () => {

    it('should allow direct addEdge via rawGraph', async () => {
      await graphFactory.rawGraph.addEdge({ type: 'CALLS', src: 'fn:main:10', dst: 'fn:greet:20' });

      assert.strictEqual(backend.calls.addEdge.length, 1);
      const stored = backend.calls.addEdge[0];
      assert.strictEqual(stored.type, 'CALLS');
      assert.strictEqual(stored.src, 'fn:main:10');
      assert.strictEqual(stored.dst, 'fn:greet:20');
    });

  });


  // ==========================================================================
  // rawGraph — batch edge operations
  // ==========================================================================

  describe('rawGraph batch edge operations', () => {

    it('should allow direct addEdges via rawGraph', async () => {
      const edges = [
        { type: 'CALLS', src: 'fn:a:1', dst: 'fn:b:2' },
        { type: 'CALLS', src: 'fn:b:2', dst: 'fn:c:3' },
      ];

      await graphFactory.rawGraph.addEdges(edges);

      assert.strictEqual(backend.calls.addEdges.length, 1);
      assert.strictEqual(backend.calls.addEdges[0].edges.length, 2);
    });

  });


  // (updateNode removed — use factory.update() instead, tested below)


  // ==========================================================================
  // Read method delegation
  // ==========================================================================

  describe('read methods', () => {

    it('getNode() should delegate to backend', async () => {
      // Pre-populate a node through store
      const node = NodeFactory.createFunction('foo', '/src/app.js', 1, 0);
      await graphFactory.store(node);

      const result = await graphFactory.getNode(node.id);

      assert.strictEqual(backend.calls.getNode.length, 1);
      assert.strictEqual(backend.calls.getNode[0], node.id);
      assert.ok(result, 'getNode should return the stored node');
      assert.strictEqual(result.id, node.id);
    });

    it('queryNodes() should delegate to backend', async () => {
      // Pre-populate nodes
      const fn1 = NodeFactory.createFunction('a', '/src/a.js', 1, 0);
      const fn2 = NodeFactory.createFunction('b', '/src/b.js', 2, 0);
      await graphFactory.store(fn1);
      await graphFactory.store(fn2);

      const results = [];
      for await (const node of graphFactory.queryNodes({ type: 'FUNCTION' })) {
        results.push(node);
      }

      assert.strictEqual(backend.calls.queryNodes.length, 1);
      assert.strictEqual(results.length, 2);
    });

  });


  // ==========================================================================
  // Debug mode
  // ==========================================================================

  describe('debug mode', () => {

    it('should not throw when debug=true', () => {
      // Constructing with debug=true should work
      const debugFactory = new GraphFactory(backend, { debug: true });
      assert.ok(debugFactory, 'GraphFactory with debug mode should be constructable');
    });

    it('should call link correctly in debug mode', async () => {
      const debugFactory = new GraphFactory(backend, { debug: true });

      await debugFactory.link({ type: 'CALLS', src: 'fn:a:1', dst: 'fn:b:2' });

      assert.strictEqual(backend.calls.addEdge.length, 1);
      assert.strictEqual(backend.calls.addEdge[0].type, 'CALLS');
    });

  });


  // ==========================================================================
  // Plugin-facing write API: store()
  // ==========================================================================

  describe('store()', () => {

    it('should call backend.addNode() with the branded node', async () => {
      const node = NodeFactory.createFunction('handler', '/src/app.js', 10, 0);

      await graphFactory.store(node);

      assert.strictEqual(backend.calls.addNode.length, 1);
      assert.strictEqual(backend.calls.addNode[0].id, node.id);
      assert.strictEqual(backend.calls.addNode[0].type, 'FUNCTION');
    });

  });


  // ==========================================================================
  // Plugin-facing write API: link()
  // ==========================================================================

  describe('link()', () => {

    it('should call backend.addEdge() with the edge', async () => {
      await graphFactory.link({ type: 'CALLS', src: 'fn:a:1', dst: 'fn:b:2' });

      assert.strictEqual(backend.calls.addEdge.length, 1);
      const stored = backend.calls.addEdge[0];
      assert.strictEqual(stored.type, 'CALLS');
      assert.strictEqual(stored.src, 'fn:a:1');
      assert.strictEqual(stored.dst, 'fn:b:2');
    });

  });


  // ==========================================================================
  // Plugin-facing write API: storeMany()
  // ==========================================================================

  describe('storeMany()', () => {

    it('should call backend.addNodes() with node array', async () => {
      const nodes = [
        NodeFactory.createFunction('a', '/src/a.js', 1, 0),
        NodeFactory.createFunction('b', '/src/b.js', 2, 0),
      ];

      await graphFactory.storeMany(nodes);

      assert.strictEqual(backend.calls.addNodes.length, 1);
      assert.strictEqual(backend.calls.addNodes[0].length, 2);
      assert.strictEqual(backend.calls.addNodes[0][0].id, nodes[0].id);
      assert.strictEqual(backend.calls.addNodes[0][1].id, nodes[1].id);
    });

  });


  // ==========================================================================
  // Plugin-facing write API: linkMany()
  // ==========================================================================

  describe('linkMany()', () => {

    it('should call backend.addEdges() with edge array', async () => {
      const edges = [
        { type: 'CALLS', src: 'fn:a:1', dst: 'fn:b:2' },
        { type: 'CALLS', src: 'fn:b:2', dst: 'fn:c:3' },
      ];

      await graphFactory.linkMany(edges);

      assert.strictEqual(backend.calls.addEdges.length, 1);
      assert.strictEqual(backend.calls.addEdges[0].edges.length, 2);
    });

    it('should forward skipValidation=true to backend', async () => {
      const edges = [
        { type: 'REJECTS', src: 'fn:handler:10', dst: 'CLASS:Error' },
      ];

      await graphFactory.linkMany(edges, true);

      assert.strictEqual(backend.calls.addEdges.length, 1);
      assert.strictEqual(backend.calls.addEdges[0].skipValidation, true);
    });

  });


  // ==========================================================================
  // Plugin-facing write API: update()
  // ==========================================================================

  describe('update()', () => {

    it('should re-brand the node and call backend.addNode()', async () => {
      const plainNode = {
        id: 'http:route#GET:/api/users',
        type: 'http:route',
        name: '/api/users',
        file: '/src/routes.js',
        customerFacing: true,
      };

      await graphFactory.update(plainNode);

      assert.strictEqual(backend.calls.addNode.length, 1);
      const stored = backend.calls.addNode[0];
      assert.strictEqual(stored.id, plainNode.id);
      assert.strictEqual(stored.type, 'http:route');
      assert.strictEqual(stored.customerFacing, true);
    });

  });


  // ==========================================================================
  // GraphFactory.createShim()
  // ==========================================================================

  describe('GraphFactory.createShim()', () => {

    it('should return a shim with store/link/storeMany/linkMany/update methods', () => {
      const shim = GraphFactory.createShim(backend);

      assert.strictEqual(typeof shim.store, 'function');
      assert.strictEqual(typeof shim.link, 'function');
      assert.strictEqual(typeof shim.storeMany, 'function');
      assert.strictEqual(typeof shim.linkMany, 'function');
      assert.strictEqual(typeof shim.update, 'function');
    });

    it('store() should delegate to backend.addNode()', async () => {
      const shim = GraphFactory.createShim(backend);
      const node = NodeFactory.createFunction('shimFn', '/src/shim.js', 5, 0);

      await shim.store(node);

      assert.strictEqual(backend.calls.addNode.length, 1);
      assert.strictEqual(backend.calls.addNode[0].id, node.id);
    });

    it('link() should delegate to backend.addEdge()', async () => {
      const shim = GraphFactory.createShim(backend);

      await shim.link({ type: 'CALLS', src: 'fn:x:1', dst: 'fn:y:2' });

      assert.strictEqual(backend.calls.addEdge.length, 1);
      assert.strictEqual(backend.calls.addEdge[0].type, 'CALLS');
      assert.strictEqual(backend.calls.addEdge[0].src, 'fn:x:1');
    });

    it('storeMany() should delegate to backend.addNodes()', async () => {
      const shim = GraphFactory.createShim(backend);
      const nodes = [
        NodeFactory.createFunction('a', '/src/a.js', 1, 0),
        NodeFactory.createFunction('b', '/src/b.js', 2, 0),
      ];

      await shim.storeMany(nodes);

      assert.strictEqual(backend.calls.addNodes.length, 1);
      assert.strictEqual(backend.calls.addNodes[0].length, 2);
    });

    it('linkMany() should delegate to backend.addEdges()', async () => {
      const shim = GraphFactory.createShim(backend);
      const edges = [
        { type: 'CALLS', src: 'fn:a:1', dst: 'fn:b:2' },
      ];

      await shim.linkMany(edges);

      assert.strictEqual(backend.calls.addEdges.length, 1);
      assert.strictEqual(backend.calls.addEdges[0].edges.length, 1);
    });

    it('linkMany() should forward skipValidation to backend', async () => {
      const shim = GraphFactory.createShim(backend);
      const edges = [
        { type: 'REJECTS', src: 'fn:a:1', dst: 'CLASS:Error' },
      ];

      await shim.linkMany(edges, true);

      assert.strictEqual(backend.calls.addEdges.length, 1);
      assert.strictEqual(backend.calls.addEdges[0].skipValidation, true);
    });

    it('update() should re-brand and delegate to backend.addNode()', async () => {
      const shim = GraphFactory.createShim(backend);
      const plainNode = {
        id: 'FUNCTION#shimUpdate',
        type: 'FUNCTION',
        name: 'shimUpdate',
        file: '/src/shim.js',
      };

      await shim.update(plainNode);

      assert.strictEqual(backend.calls.addNode.length, 1);
      const stored = backend.calls.addNode[0];
      assert.strictEqual(stored.id, 'FUNCTION#shimUpdate');
      assert.strictEqual(stored.type, 'FUNCTION');
    });

  });

});
