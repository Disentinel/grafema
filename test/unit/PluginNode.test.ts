/**
 * PluginNode tests - REG-386
 *
 * Tests for grafema:plugin node creation, validation, and factory methods.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory, PluginNode } from '@grafema/core';

describe('PluginNode', () => {
  describe('PluginNode.create', () => {
    it('should create a plugin node with required fields', () => {
      const node = PluginNode.create('HTTPConnectionEnricher', 'ENRICHMENT');
      assert.strictEqual(node.id, 'grafema:plugin#HTTPConnectionEnricher');
      assert.strictEqual(node.type, 'grafema:plugin');
      assert.strictEqual(node.name, 'HTTPConnectionEnricher');
      assert.strictEqual(node.phase, 'ENRICHMENT');
      assert.strictEqual(node.priority, 0);
      assert.strictEqual(node.builtin, true);
      assert.deepStrictEqual(node.createsNodes, []);
      assert.deepStrictEqual(node.createsEdges, []);
      assert.deepStrictEqual(node.dependencies, []);
    });

    it('should create a plugin node with all options', () => {
      const node = PluginNode.create('FetchAnalyzer', 'ANALYSIS', {
        priority: 75,
        file: 'packages/core/src/plugins/analysis/FetchAnalyzer.ts',
        builtin: true,
        createsNodes: ['http:request', 'EXTERNAL'],
        createsEdges: ['CONTAINS', 'MAKES_REQUEST', 'CALLS_API'],
        dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      });
      assert.strictEqual(node.id, 'grafema:plugin#FetchAnalyzer');
      assert.strictEqual(node.phase, 'ANALYSIS');
      assert.strictEqual(node.priority, 75);
      assert.strictEqual(node.file, 'packages/core/src/plugins/analysis/FetchAnalyzer.ts');
      assert.deepStrictEqual(node.createsNodes, ['http:request', 'EXTERNAL']);
      assert.deepStrictEqual(node.createsEdges, ['CONTAINS', 'MAKES_REQUEST', 'CALLS_API']);
      assert.deepStrictEqual(node.dependencies, ['JSModuleIndexer', 'JSASTAnalyzer']);
    });

    it('should store creates info in metadata for Datalog queries', () => {
      const node = PluginNode.create('FetchAnalyzer', 'ANALYSIS', {
        createsNodes: ['http:request'],
        createsEdges: ['MAKES_REQUEST'],
      });
      assert.deepStrictEqual(node.metadata?.creates, {
        nodes: ['http:request'],
        edges: ['MAKES_REQUEST'],
      });
    });

    it('should throw on missing name', () => {
      assert.throws(
        () => PluginNode.create('', 'ANALYSIS'),
        /name is required/
      );
    });

    it('should throw on missing phase', () => {
      assert.throws(
        () => PluginNode.create('Test', ''),
        /phase is required/
      );
    });

    it('should throw on invalid phase', () => {
      assert.throws(
        () => PluginNode.create('Test', 'INVALID'),
        /invalid phase/
      );
    });

    it('should accept all valid phases', () => {
      for (const phase of ['DISCOVERY', 'INDEXING', 'ANALYSIS', 'ENRICHMENT', 'VALIDATION']) {
        const node = PluginNode.create(`Test_${phase}`, phase);
        assert.strictEqual(node.phase, phase);
      }
    });

    it('should mark custom plugins as non-builtin', () => {
      const node = PluginNode.create('CustomAnalyzer', 'ANALYSIS', {
        builtin: false,
        file: '/project/.grafema/plugins/CustomAnalyzer.js',
      });
      assert.strictEqual(node.builtin, false);
      assert.strictEqual(node.file, '/project/.grafema/plugins/CustomAnalyzer.js');
    });
  });

  describe('PluginNode.validate', () => {
    it('should pass for a valid node', () => {
      const node = PluginNode.create('Test', 'ANALYSIS');
      const errors = PluginNode.validate(node);
      assert.deepStrictEqual(errors, []);
    });

    it('should fail for wrong type', () => {
      const errors = PluginNode.validate({ id: 'x', type: 'FUNCTION', name: 'x' } as any);
      assert.ok(errors.some(e => e.includes('grafema:plugin')));
    });

    it('should fail for missing name', () => {
      const errors = PluginNode.validate({ id: 'x', type: 'grafema:plugin', name: '', phase: 'ANALYSIS' } as any);
      assert.ok(errors.some(e => e.includes('name')));
    });
  });

  describe('PluginNode.parseId', () => {
    it('should parse valid ID', () => {
      const parsed = PluginNode.parseId('grafema:plugin#HTTPConnectionEnricher');
      assert.deepStrictEqual(parsed, { name: 'HTTPConnectionEnricher' });
    });

    it('should return null for invalid ID', () => {
      assert.strictEqual(PluginNode.parseId('issue:security#abc'), null);
      assert.strictEqual(PluginNode.parseId(''), null);
      assert.strictEqual(PluginNode.parseId('grafema:plugin'), null);
    });
  });

  describe('PluginNode.generateId', () => {
    it('should generate correct ID format', () => {
      assert.strictEqual(PluginNode.generateId('Foo'), 'grafema:plugin#Foo');
    });
  });

  describe('PluginNode.isPluginType', () => {
    it('should return true for grafema:plugin', () => {
      assert.strictEqual(PluginNode.isPluginType('grafema:plugin'), true);
    });

    it('should return false for other types', () => {
      assert.strictEqual(PluginNode.isPluginType('FUNCTION'), false);
      assert.strictEqual(PluginNode.isPluginType('issue:security'), false);
    });
  });

  describe('NodeFactory.createPlugin', () => {
    it('should create a branded plugin node', () => {
      const node = NodeFactory.createPlugin('TestPlugin', 'ANALYSIS');
      assert.strictEqual(node.type, 'grafema:plugin');
      assert.strictEqual(node.name, 'TestPlugin');
    });

    it('should pass options through', () => {
      const node = NodeFactory.createPlugin('TestPlugin', 'ENRICHMENT', {
        priority: 50,
        createsEdges: ['INTERACTS_WITH'],
        dependencies: ['FetchAnalyzer'],
      });
      assert.strictEqual(node.priority, 50);
      assert.deepStrictEqual(node.createsEdges, ['INTERACTS_WITH']);
      assert.deepStrictEqual(node.dependencies, ['FetchAnalyzer']);
    });
  });
});
