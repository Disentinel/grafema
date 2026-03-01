/**
 * Tests for walkFile domain plugin hook (REG-591, Commit 3)
 *
 * The walkFile function accepts an optional WalkOptions parameter with a
 * domainPlugins field. After the walk and file-scope resolution complete,
 * each plugin's analyzeFile method is called with the FileResult and
 * the parsed AST.
 *
 * Plugin results (nodes, edges, deferred refs) are merged into the final
 * FileResult. Plugins are isolated: errors in one plugin do not affect
 * others or the core walk result.
 *
 * These tests verify the plugin hook contract:
 * 1. Backward compatibility: no plugins = same behavior as before
 * 2. Plugin receives correct arguments (FileResult and AST)
 * 3. Plugin nodes are merged into the result
 * 4. Plugin edges are merged into the result
 * 5. Plugin deferred refs flow into unresolvedRefs
 * 6. Plugin errors are isolated (non-fatal)
 * 7. Plugins run in registration order
 * 8. Plugin returning null/undefined is handled gracefully
 * 9. Multiple plugins accumulate results
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile, jsRegistry } from '../../packages/core-v2/dist/index.js';

/**
 * Helper: walk code with given domain plugins.
 */
async function walkWithPlugins(code, plugins, file = 'test.ts') {
  return walkFile(code, file, jsRegistry, { domainPlugins: plugins });
}

describe('walkFile domain plugin hook (REG-591)', () => {

  describe('Backward compatibility', () => {
    it('should return valid FileResult with no plugins', async () => {
      const result = await walkFile('const x = 1;', 'test.ts', jsRegistry);
      assert.ok(Array.isArray(result.nodes), 'result.nodes is an array');
      assert.ok(Array.isArray(result.edges), 'result.edges is an array');
      assert.ok(Array.isArray(result.unresolvedRefs), 'result.unresolvedRefs is an array');
      assert.equal(result.file, 'test.ts');
    });

    it('should return valid FileResult with empty plugins array', async () => {
      const result = await walkWithPlugins('const x = 1;', []);
      assert.ok(Array.isArray(result.nodes), 'result.nodes is an array');
      assert.ok(Array.isArray(result.edges), 'result.edges is an array');
      assert.ok(Array.isArray(result.unresolvedRefs), 'result.unresolvedRefs is an array');
    });
  });

  describe('Plugin receives correct arguments', () => {
    it('should pass FileResult and AST to plugin.analyzeFile', async () => {
      let capturedFileResult = null;
      let capturedAst = null;

      const spyPlugin = {
        name: 'spy',
        analyzeFile(fileResult, ast) {
          capturedFileResult = fileResult;
          capturedAst = ast;
          return { nodes: [], edges: [] };
        },
      };

      await walkWithPlugins('const x = 1;', [spyPlugin]);

      assert.ok(capturedFileResult !== null, 'fileResult was passed to plugin');
      assert.ok(capturedAst !== null, 'AST was passed to plugin');

      // FileResult should have the expected shape
      assert.equal(capturedFileResult.file, 'test.ts', 'fileResult.file matches');
      assert.ok(Array.isArray(capturedFileResult.nodes), 'fileResult.nodes is an array');
      assert.ok(Array.isArray(capturedFileResult.edges), 'fileResult.edges is an array');
      assert.ok(Array.isArray(capturedFileResult.unresolvedRefs), 'fileResult.unresolvedRefs is an array');

      // AST should be a Babel File node
      assert.equal(capturedAst.type, 'File', 'AST is a Babel File node');
      assert.ok(capturedAst.program, 'AST has program property');
    });
  });

  describe('Plugin nodes merged into FileResult', () => {
    it('should include plugin-created nodes in the result', async () => {
      const extraNode = {
        id: 'test.ts->http:route->GET:/foo#1',
        type: 'http:route',
        name: 'GET /foo',
        file: 'test.ts',
        line: 1,
        column: 0,
      };

      const plugin = {
        name: 'node-adder',
        analyzeFile() {
          return { nodes: [extraNode], edges: [] };
        },
      };

      const result = await walkWithPlugins("app.get('/foo', handler);", [plugin]);

      const found = result.nodes.find(n => n.id === extraNode.id);
      assert.ok(found, 'Plugin node should appear in result.nodes');
      assert.equal(found.type, 'http:route');
      assert.equal(found.name, 'GET /foo');
    });
  });

  describe('Plugin edges merged into FileResult', () => {
    it('should include plugin-created edges in the result', async () => {
      const extraNode = {
        id: 'test.ts->http:route->GET:/foo#1',
        type: 'http:route',
        name: 'GET /foo',
        file: 'test.ts',
        line: 1,
        column: 0,
      };
      const extraEdge = {
        src: 'MODULE#test.ts',
        dst: extraNode.id,
        type: 'EXPOSES',
      };

      const plugin = {
        name: 'edge-adder',
        analyzeFile() {
          return { nodes: [extraNode], edges: [extraEdge] };
        },
      };

      const result = await walkWithPlugins("app.get('/foo', handler);", [plugin]);

      const found = result.edges.find(
        e => e.src === 'MODULE#test.ts' && e.dst === extraNode.id && e.type === 'EXPOSES'
      );
      assert.ok(found, 'Plugin edge should appear in result.edges');
    });
  });

  describe('Plugin deferred refs merged into unresolvedRefs', () => {
    it('should include plugin deferred refs in result.unresolvedRefs', async () => {
      const deferredRef = {
        kind: 'call_resolve',
        name: 'handler',
        fromNodeId: 'test.ts->http:route->GET:/foo#1',
        edgeType: 'DEFINES',
        file: 'test.ts',
        line: 1,
        column: 0,
      };

      const plugin = {
        name: 'deferred-adder',
        analyzeFile() {
          return { nodes: [], edges: [], deferred: [deferredRef] };
        },
      };

      const result = await walkWithPlugins('const x = 1;', [plugin]);

      const found = result.unresolvedRefs.find(
        r => r.name === 'handler' && r.kind === 'call_resolve'
      );
      assert.ok(found, 'Plugin deferred ref should appear in result.unresolvedRefs');
    });
  });

  describe('Plugin error isolation', () => {
    it('should not crash walkFile when plugin throws', async () => {
      const throwingPlugin = {
        name: 'crasher',
        analyzeFile() {
          throw new Error('plugin crash');
        },
      };

      // walkFile should not throw
      const result = await walkWithPlugins('const x = 1;', [throwingPlugin]);
      assert.ok(Array.isArray(result.nodes), 'result.nodes is still valid after plugin crash');
      assert.ok(Array.isArray(result.edges), 'result.edges is still valid after plugin crash');
    });

    it('should still run other plugins after one crashes', async () => {
      let secondPluginRan = false;

      const throwingPlugin = {
        name: 'crasher',
        analyzeFile() {
          throw new Error('plugin crash');
        },
      };

      const goodPlugin = {
        name: 'good',
        analyzeFile() {
          secondPluginRan = true;
          return { nodes: [], edges: [] };
        },
      };

      await walkWithPlugins('const x = 1;', [throwingPlugin, goodPlugin]);
      assert.ok(secondPluginRan, 'Second plugin should still run after first crashes');
    });
  });

  describe('Plugin ordering', () => {
    it('should run plugins in registration order', async () => {
      const executionOrder = [];

      const p1 = {
        name: 'first',
        analyzeFile() {
          executionOrder.push('first');
          return { nodes: [], edges: [] };
        },
      };

      const p2 = {
        name: 'second',
        analyzeFile() {
          executionOrder.push('second');
          return { nodes: [], edges: [] };
        },
      };

      const p3 = {
        name: 'third',
        analyzeFile() {
          executionOrder.push('third');
          return { nodes: [], edges: [] };
        },
      };

      await walkWithPlugins('const x = 1;', [p1, p2, p3]);
      assert.deepStrictEqual(executionOrder, ['first', 'second', 'third']);
    });
  });

  describe('Plugin returns null/undefined', () => {
    it('should handle plugin returning null gracefully', async () => {
      const badPlugin = {
        name: 'null-returner',
        analyzeFile() {
          return null;
        },
      };

      const result = await walkWithPlugins('const x = 1;', [badPlugin]);
      assert.ok(Array.isArray(result.nodes), 'result.nodes valid after null return');
    });

    it('should handle plugin returning undefined gracefully', async () => {
      const badPlugin = {
        name: 'undefined-returner',
        analyzeFile() {
          // implicit return undefined
        },
      };

      const result = await walkWithPlugins('const x = 1;', [badPlugin]);
      assert.ok(Array.isArray(result.nodes), 'result.nodes valid after undefined return');
    });
  });

  describe('Multiple plugins contribute nodes', () => {
    it('should accumulate nodes from multiple plugins', async () => {
      const nodeA = {
        id: 'test.ts->http:route->GET:/a#1',
        type: 'http:route',
        name: 'GET /a',
        file: 'test.ts',
        line: 1,
        column: 0,
      };

      const nodeB = {
        id: 'test.ts->socketio:on->connect#1',
        type: 'socketio:on',
        name: 'connect',
        file: 'test.ts',
        line: 2,
        column: 0,
      };

      const pluginA = {
        name: 'plugin-a',
        analyzeFile() {
          return { nodes: [nodeA], edges: [] };
        },
      };

      const pluginB = {
        name: 'plugin-b',
        analyzeFile() {
          return { nodes: [nodeB], edges: [] };
        },
      };

      const result = await walkWithPlugins('const x = 1;', [pluginA, pluginB]);

      assert.ok(result.nodes.find(n => n.id === nodeA.id), 'Node from plugin A should be in result');
      assert.ok(result.nodes.find(n => n.id === nodeB.id), 'Node from plugin B should be in result');
    });
  });

  describe('Plugin result validation', () => {
    it('should skip plugin result with missing nodes array', async () => {
      const badPlugin = {
        name: 'missing-nodes',
        analyzeFile() {
          return { edges: [] };
        },
      };

      // Should not throw, should gracefully skip
      const result = await walkWithPlugins('const x = 1;', [badPlugin]);
      assert.ok(Array.isArray(result.nodes), 'result.nodes valid after invalid plugin result');
    });

    it('should skip plugin result with missing edges array', async () => {
      const badPlugin = {
        name: 'missing-edges',
        analyzeFile() {
          return { nodes: [] };
        },
      };

      // Should not throw, should gracefully skip
      const result = await walkWithPlugins('const x = 1;', [badPlugin]);
      assert.ok(Array.isArray(result.edges), 'result.edges valid after invalid plugin result');
    });
  });
});
