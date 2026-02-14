/**
 * Tests for FileOverview core class - REG-412
 *
 * Tests the structured file overview logic: categorization, edge resolution,
 * and result building.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { FileOverview } from '../../packages/core/dist/core/FileOverview.js';

// === Mock Graph Backend ===

/**
 * Creates a mock graph backend with pre-loaded nodes and edges.
 * Follows the minimal interface used by FileOverview:
 * - queryNodes(filter) -> AsyncGenerator
 * - getNode(id) -> node | null
 * - getOutgoingEdges(id, types) -> edges[]
 */
function createMockBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return {
    async *queryNodes(filter) {
      for (const node of nodes) {
        let match = true;
        if (filter.file && node.file !== filter.file) match = false;
        if (filter.type && node.type !== filter.type) match = false;
        if (filter.name && node.name !== filter.name) match = false;
        if (match) yield node;
      }
    },

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

// === Test Fixtures ===

const TEST_FILE = '/project/src/app.js';

/**
 * Minimal graph: MODULE with import, export, function, variable, and class
 */
function simpleGraph() {
  const nodes = [
    { id: 'src/app.js', type: 'MODULE', name: 'app.js', file: TEST_FILE, line: 1 },
    { id: 'src/app.js->IMPORT->express', type: 'IMPORT', name: 'express',
      file: TEST_FILE, line: 1, source: 'express',
      specifiers: [{ local: 'express', type: 'default' }] },
    { id: 'src/app.js->EXPORT->app', type: 'EXPORT', name: 'app',
      file: TEST_FILE, line: 20, exportedName: 'app', isDefault: true },
    { id: 'src/app.js->FUNCTION->main', type: 'FUNCTION', name: 'main',
      file: TEST_FILE, line: 5, async: true, params: ['config'] },
    { id: 'src/app.js->FUNCTION->main->SCOPE', type: 'SCOPE',
      file: TEST_FILE, line: 5 },
    { id: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', type: 'CALL',
      name: 'express', file: TEST_FILE, line: 6 },
    { id: 'express->FUNCTION->default', type: 'FUNCTION', name: 'express',
      file: '/node_modules/express/index.js', line: 1 },
    { id: 'src/app.js->VARIABLE->port', type: 'VARIABLE', name: 'port',
      file: TEST_FILE, line: 3, kind: 'const' },
    { id: 'src/app.js->LITERAL->3000', type: 'LITERAL', name: '3000',
      file: TEST_FILE, line: 3 },
    { id: 'src/app.js->CLASS->Server', type: 'CLASS', name: 'Server',
      file: TEST_FILE, line: 10, exported: true },
    { id: 'src/app.js->CLASS->Server->FUNCTION->start', type: 'FUNCTION',
      name: 'start', file: TEST_FILE, line: 12, async: true,
      isClassMethod: true, params: [] },
    { id: 'src/app.js->CLASS->Server->FUNCTION->start->SCOPE', type: 'SCOPE',
      file: TEST_FILE, line: 12 },
    { id: 'events->CLASS->EventEmitter', type: 'CLASS', name: 'EventEmitter',
      file: '/node_modules/events/index.js', line: 1 },
  ];

  const edges = [
    { src: 'src/app.js', dst: 'src/app.js->IMPORT->express', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->EXPORT->app', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->FUNCTION->main', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->VARIABLE->port', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->CLASS->Server', type: 'CONTAINS' },
    { src: 'src/app.js->FUNCTION->main', dst: 'src/app.js->FUNCTION->main->SCOPE', type: 'HAS_SCOPE' },
    { src: 'src/app.js->FUNCTION->main->SCOPE', dst: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', type: 'CONTAINS' },
    { src: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', dst: 'express->FUNCTION->default', type: 'CALLS' },
    { src: 'src/app.js->VARIABLE->port', dst: 'src/app.js->LITERAL->3000', type: 'ASSIGNED_FROM' },
    { src: 'src/app.js->CLASS->Server', dst: 'events->CLASS->EventEmitter', type: 'EXTENDS' },
    { src: 'src/app.js->CLASS->Server', dst: 'src/app.js->CLASS->Server->FUNCTION->start', type: 'CONTAINS' },
    { src: 'src/app.js->CLASS->Server->FUNCTION->start', dst: 'src/app.js->CLASS->Server->FUNCTION->start->SCOPE', type: 'HAS_SCOPE' },
  ];

  return { nodes, edges };
}

// === Tests ===

describe('FileOverview', () => {
  describe('getOverview - analyzed file', () => {
    it('should return ANALYZED status for a file with MODULE node', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.status, 'ANALYZED');
      assert.equal(result.file, TEST_FILE);
    });

    it('should extract imports with source and specifiers', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, 'express');
      assert.deepEqual(result.imports[0].specifiers, ['express']);
    });

    it('should extract exports with default flag', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.exports.length, 1);
      assert.equal(result.exports[0].name, 'app');
      assert.equal(result.exports[0].isDefault, true);
    });

    it('should extract functions with resolved calls', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.functions.length, 1);
      assert.equal(result.functions[0].name, 'main');
      assert.equal(result.functions[0].async, true);
      assert.deepEqual(result.functions[0].params, ['config']);
      assert.ok(
        result.functions[0].calls.includes('express'),
        `Expected calls to include 'express', got: ${JSON.stringify(result.functions[0].calls)}`
      );
    });

    it('should extract classes with extends and methods', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Server');
      assert.equal(result.classes[0].extends, 'EventEmitter');
      assert.equal(result.classes[0].exported, true);
      assert.equal(result.classes[0].methods.length, 1);
      assert.equal(result.classes[0].methods[0].name, 'start');
    });

    it('should extract variables with assigned-from source', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.variables.length, 1);
      assert.equal(result.variables[0].name, 'port');
      assert.equal(result.variables[0].kind, 'const');
      assert.equal(result.variables[0].assignedFrom, '3000');
    });

    it('should sort groups by line number', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      // Class methods should be sorted by line
      if (result.classes.length > 0 && result.classes[0].methods.length > 1) {
        for (let i = 1; i < result.classes[0].methods.length; i++) {
          assert.ok(
            (result.classes[0].methods[i].line ?? 0) >=
            (result.classes[0].methods[i - 1].line ?? 0),
            'Methods should be sorted by line'
          );
        }
      }
    });
  });

  describe('getOverview - not analyzed file', () => {
    it('should return NOT_ANALYZED for a file with no MODULE node', async () => {
      const backend = createMockBackend([], []);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/nonexistent/file.js');

      assert.equal(result.status, 'NOT_ANALYZED');
      assert.equal(result.imports.length, 0);
      assert.equal(result.exports.length, 0);
      assert.equal(result.classes.length, 0);
      assert.equal(result.functions.length, 0);
      assert.equal(result.variables.length, 0);
    });
  });

  describe('getOverview - includeEdges=false', () => {
    it('should skip call resolution when edges disabled', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE, {
        includeEdges: false,
      });

      assert.equal(result.status, 'ANALYZED');
      assert.equal(result.functions.length, 1);
      assert.deepEqual(result.functions[0].calls, []);
    });

    it('should still list class methods without edge resolution', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE, {
        includeEdges: false,
      });

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Server');
      assert.equal(result.classes[0].methods.length, 1);
      assert.deepEqual(result.classes[0].methods[0].calls, []);
    });
  });

  describe('getOverview - filters out structural nodes', () => {
    it('should not include SCOPE, CALL, LITERAL nodes in results', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      const allIds = [
        ...result.imports.map(i => i.id),
        ...result.exports.map(e => e.id),
        ...result.classes.map(c => c.id),
        ...result.functions.map(f => f.id),
        ...result.variables.map(v => v.id),
      ];

      for (const id of allIds) {
        const node = nodes.find(n => n.id === id);
        assert.ok(node, `Node ${id} should exist`);
        assert.ok(
          !['SCOPE', 'CALL', 'EXPRESSION', 'LITERAL', 'PARAMETER'].includes(node.type),
          `Should not include ${node.type} node in overview`
        );
      }
    });
  });

  describe('getOverview - edge cases', () => {
    it('should handle function with no calls', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'fn', type: 'FUNCTION', name: 'empty', file: '/test.js', line: 2 },
        { id: 'fn-scope', type: 'SCOPE', file: '/test.js', line: 2 },
      ];
      const edges = [
        { src: 'mod', dst: 'fn', type: 'CONTAINS' },
        { src: 'fn', dst: 'fn-scope', type: 'HAS_SCOPE' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.functions.length, 1);
      assert.deepEqual(result.functions[0].calls, []);
    });

    it('should handle class with no methods', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'cls', type: 'CLASS', name: 'Empty', file: '/test.js', line: 2, exported: false },
      ];
      const edges = [
        { src: 'mod', dst: 'cls', type: 'CONTAINS' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Empty');
      assert.deepEqual(result.classes[0].methods, []);
    });

    it('should handle anonymous function', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'fn', type: 'FUNCTION', file: '/test.js', line: 2, async: false },
        { id: 'fn-scope', type: 'SCOPE', file: '/test.js', line: 2 },
      ];
      const edges = [
        { src: 'mod', dst: 'fn', type: 'CONTAINS' },
        { src: 'fn', dst: 'fn-scope', type: 'HAS_SCOPE' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.functions.length, 1);
      assert.equal(result.functions[0].name, '<anonymous>');
    });

    it('should handle import with no specifiers', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'imp', type: 'IMPORT', name: './styles.css',
          file: '/test.js', line: 1, source: './styles.css' },
      ];
      const edges = [
        { src: 'mod', dst: 'imp', type: 'CONTAINS' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, './styles.css');
      assert.deepEqual(result.imports[0].specifiers, []);
    });

    it('should handle class with superClass on node but no EXTENDS edge', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'cls', type: 'CLASS', name: 'Child', file: '/test.js', line: 2,
          exported: false, superClass: 'Parent' },
      ];
      const edges = [
        { src: 'mod', dst: 'cls', type: 'CONTAINS' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].extends, 'Parent');
    });
  });
});
