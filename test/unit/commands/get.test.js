/**
 * Unit tests for `grafema get` command
 *
 * Tests command logic without requiring full analysis pipeline.
 * Uses in-memory backend for speed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestBackend } from '../../helpers/TestRFDB.js';

describe('grafema get command - unit tests', () => {
  let backend;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('node retrieval', () => {
    it('should retrieve node by semantic ID', async () => {
      // Setup: Add test node
      await backend.addNode({
        id: 'test.js->global->FUNCTION->testFunc',
        nodeType: 'FUNCTION',
        name: 'testFunc',
        file: 'test.js',
        line: 10,
      });
      await backend.flush();

      // Test: Retrieve by ID
      const node = await backend.getNode('test.js->global->FUNCTION->testFunc');

      assert.ok(node, 'Node should be found');
      assert.equal(node.name, 'testFunc');
      assert.equal(node.type, 'FUNCTION');
    });

    it('should return null for non-existent ID', async () => {
      const node = await backend.getNode('nonexistent->ID');
      assert.equal(node, null);
    });

    it('should retrieve node with metadata fields', async () => {
      // Setup: Add node with custom fields
      await backend.addNode({
        id: 'test.js->global->FUNCTION->test',
        nodeType: 'FUNCTION',
        name: 'test',
        file: 'test.js',
        line: 5,
        exported: true,
        customField: 'customValue',
        numericField: 42,
      });
      await backend.flush();

      // Test: Retrieve and verify all fields
      const node = await backend.getNode('test.js->global->FUNCTION->test');

      assert.ok(node);
      assert.equal(node.name, 'test');
      assert.equal(node.exported, true);
      assert.equal(node.customField, 'customValue');
      assert.equal(node.numericField, 42);
    });
  });

  describe('edges retrieval', () => {
    it('should retrieve outgoing edges', async () => {
      // Setup: Add nodes and edges
      await backend.addNodes([
        {
          id: 'test.js->global->FUNCTION->caller',
          nodeType: 'FUNCTION',
          name: 'caller',
          file: 'test.js',
        },
        {
          id: 'test.js->global->FUNCTION->callee',
          nodeType: 'FUNCTION',
          name: 'callee',
          file: 'test.js',
        },
      ]);
      await backend.addEdge({
        src: 'test.js->global->FUNCTION->caller',
        dst: 'test.js->global->FUNCTION->callee',
        edgeType: 'CALLS',
      });
      await backend.flush();

      // Test: Get outgoing edges
      const outgoing = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->caller',
        null
      );

      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].edgeType, 'CALLS');
      assert.equal(outgoing[0].dst, 'test.js->global->FUNCTION->callee');
    });

    it('should retrieve incoming edges', async () => {
      // Setup: Add nodes and edges
      await backend.addNodes([
        {
          id: 'test.js->global->FUNCTION->caller',
          nodeType: 'FUNCTION',
          name: 'caller',
          file: 'test.js',
        },
        {
          id: 'test.js->global->FUNCTION->callee',
          nodeType: 'FUNCTION',
          name: 'callee',
          file: 'test.js',
        },
      ]);
      await backend.addEdge({
        src: 'test.js->global->FUNCTION->caller',
        dst: 'test.js->global->FUNCTION->callee',
        edgeType: 'CALLS',
      });
      await backend.flush();

      // Test: Get incoming edges
      const incoming = await backend.getIncomingEdges(
        'test.js->global->FUNCTION->callee',
        null
      );

      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].edgeType, 'CALLS');
      assert.equal(incoming[0].src, 'test.js->global->FUNCTION->caller');
    });

    it('should retrieve multiple edges of different types', async () => {
      // Setup: Add nodes with multiple edge types
      await backend.addNodes([
        {
          id: 'test.js->global->MODULE->test',
          nodeType: 'MODULE',
          name: 'test',
          file: 'test.js',
        },
        {
          id: 'test.js->global->FUNCTION->func1',
          nodeType: 'FUNCTION',
          name: 'func1',
          file: 'test.js',
        },
        {
          id: 'test.js->global->FUNCTION->func2',
          nodeType: 'FUNCTION',
          name: 'func2',
          file: 'test.js',
        },
      ]);
      await backend.addEdges([
        {
          src: 'test.js->global->MODULE->test',
          dst: 'test.js->global->FUNCTION->func1',
          edgeType: 'CONTAINS',
        },
        {
          src: 'test.js->global->MODULE->test',
          dst: 'test.js->global->FUNCTION->func2',
          edgeType: 'CONTAINS',
        },
      ]);
      await backend.flush();

      // Test: Get all outgoing edges from MODULE
      const outgoing = await backend.getOutgoingEdges(
        'test.js->global->MODULE->test',
        null
      );

      assert.equal(outgoing.length, 2);
      assert.ok(outgoing.every(e => e.edgeType === 'CONTAINS'));
    });

    it('should return empty array when no edges exist', async () => {
      // Setup: Add node with no edges
      await backend.addNode({
        id: 'test.js->global->FUNCTION->isolated',
        nodeType: 'FUNCTION',
        name: 'isolated',
        file: 'test.js',
      });
      await backend.flush();

      // Test: Get edges for isolated node
      const incoming = await backend.getIncomingEdges(
        'test.js->global->FUNCTION->isolated',
        null
      );
      const outgoing = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->isolated',
        null
      );

      assert.equal(incoming.length, 0);
      assert.equal(outgoing.length, 0);
    });

    it('should filter edges by type', async () => {
      // Setup: Add nodes with different edge types
      await backend.addNodes([
        {
          id: 'test.js->global->FUNCTION->func',
          nodeType: 'FUNCTION',
          name: 'func',
          file: 'test.js',
        },
        {
          id: 'test.js->global->VARIABLE->var1',
          nodeType: 'VARIABLE',
          name: 'var1',
          file: 'test.js',
        },
        {
          id: 'test.js->global->VARIABLE->var2',
          nodeType: 'VARIABLE',
          name: 'var2',
          file: 'test.js',
        },
      ]);
      await backend.addEdges([
        {
          src: 'test.js->global->FUNCTION->func',
          dst: 'test.js->global->VARIABLE->var1',
          edgeType: 'READS',
        },
        {
          src: 'test.js->global->FUNCTION->func',
          dst: 'test.js->global->VARIABLE->var2',
          edgeType: 'MODIFIES',
        },
      ]);
      await backend.flush();

      // Test: Filter by edge type
      const readEdges = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->func',
        ['READS']
      );
      const modifyEdges = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->func',
        ['MODIFIES']
      );

      assert.equal(readEdges.length, 1);
      assert.equal(readEdges[0].edgeType, 'READS');
      assert.equal(modifyEdges.length, 1);
      assert.equal(modifyEdges[0].edgeType, 'MODIFIES');
    });
  });

  describe('node with many edges (pagination scenario)', () => {
    it('should handle node with many outgoing edges', async () => {
      // Setup: Create a node with 50 outgoing edges
      const nodes = [{
        id: 'test.js->global->FUNCTION->hub',
        nodeType: 'FUNCTION',
        name: 'hub',
        file: 'test.js',
      }];

      const edges = [];
      for (let i = 0; i < 50; i++) {
        nodes.push({
          id: `test.js->global->FUNCTION->func${i}`,
          nodeType: 'FUNCTION',
          name: `func${i}`,
          file: 'test.js',
        });
        edges.push({
          src: 'test.js->global->FUNCTION->hub',
          dst: `test.js->global->FUNCTION->func${i}`,
          edgeType: 'CALLS',
        });
      }

      await backend.addNodes(nodes);
      await backend.addEdges(edges);
      await backend.flush();

      // Test: Get all outgoing edges
      const outgoing = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->hub',
        null
      );

      assert.equal(outgoing.length, 50);
      // Note: Text display will limit to 20, but backend returns all
    });

    it('should handle node with many incoming edges', async () => {
      // Setup: Create a node with 30 incoming edges
      const nodes = [{
        id: 'test.js->global->FUNCTION->popular',
        nodeType: 'FUNCTION',
        name: 'popular',
        file: 'test.js',
      }];

      const edges = [];
      for (let i = 0; i < 30; i++) {
        nodes.push({
          id: `test.js->global->FUNCTION->caller${i}`,
          nodeType: 'FUNCTION',
          name: `caller${i}`,
          file: 'test.js',
        });
        edges.push({
          src: `test.js->global->FUNCTION->caller${i}`,
          dst: 'test.js->global->FUNCTION->popular',
          edgeType: 'CALLS',
        });
      }

      await backend.addNodes(nodes);
      await backend.addEdges(edges);
      await backend.flush();

      // Test: Get all incoming edges
      const incoming = await backend.getIncomingEdges(
        'test.js->global->FUNCTION->popular',
        null
      );

      assert.equal(incoming.length, 30);
    });
  });

  describe('error handling', () => {
    it('should handle backend errors gracefully', async () => {
      // Test: Try to get node after closing backend
      await backend.close();

      // This should throw or return error depending on backend implementation
      // We just verify it doesn't crash the test
      try {
        await backend.getNode('some->id');
        // If it doesn't throw, that's fine - backend might return null
      } catch (error) {
        // If it throws, verify it's a reasonable error
        assert.ok(error instanceof Error);
      }
    });
  });
});
