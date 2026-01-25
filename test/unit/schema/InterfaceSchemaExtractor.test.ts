/**
 * InterfaceSchemaExtractor Tests
 *
 * Tests for interface schema extraction from graph.
 * Uses MockBackend that implements the queryNodes interface.
 *
 * TDD: These tests are written first. Implementation will make them pass.
 *
 * Based on specification:
 * - _tasks/REG-222/003-joel-tech-plan.md (original spec)
 * - _tasks/REG-222/005-joel-fixes.md (working test code)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
// Will fail to import until implementation exists (TDD)
import { InterfaceSchemaExtractor, type InterfaceSchema } from '@grafema/core';

// ============================================================================
// MockBackend - Implements queryNodes interface for testing
// ============================================================================

interface MockInterfaceNode {
  id: string;
  type: 'INTERFACE';
  name: string;
  file: string;
  line: number;
  column: number;
  extends: string[];
  properties: Array<{
    name: string;
    type?: string;
    optional?: boolean;
    readonly?: boolean;
  }>;
  typeParameters?: string[];
}

class MockBackend {
  private nodes: Map<string, MockInterfaceNode> = new Map();

  addInterface(node: MockInterfaceNode): void {
    this.nodes.set(node.id, node);
  }

  async *queryNodes(filter: { nodeType: string }): AsyncGenerator<MockInterfaceNode> {
    for (const node of this.nodes.values()) {
      if (node.type === filter.nodeType) {
        yield node;
      }
    }
  }

  // Required interface methods (no-op for tests)
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
}

// ============================================================================
// Tests
// ============================================================================

describe('InterfaceSchemaExtractor', () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  describe('extract()', () => {
    it('should extract simple interface with flat properties', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'host', type: 'string', optional: false, readonly: false },
          { name: 'port', type: 'number', optional: false, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Config');

      assert.ok(schema, 'Schema should be returned');
      assert.strictEqual(schema.name, 'Config');
      assert.strictEqual(schema.$schema, 'grafema-interface-v1');
      assert.strictEqual(schema.properties.host.type, 'string');
      assert.strictEqual(schema.properties.host.required, true);
      assert.strictEqual(schema.properties.port.type, 'number');
      assert.strictEqual(schema.properties.port.required, true);
    });

    it('should extract interface with optional properties', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Options:10',
        type: 'INTERFACE',
        name: 'Options',
        file: '/src/types.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: [
          { name: 'debug', type: 'boolean', optional: true, readonly: false },
          { name: 'timeout', type: 'number', optional: true, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Options');

      assert.ok(schema);
      assert.strictEqual(schema.properties.debug.required, false);
      assert.strictEqual(schema.properties.timeout.required, false);
    });

    it('should extract interface with readonly properties', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Immutable:15',
        type: 'INTERFACE',
        name: 'Immutable',
        file: '/src/types.ts',
        line: 15,
        column: 1,
        extends: [],
        properties: [
          { name: 'id', type: 'string', optional: false, readonly: true },
          { name: 'createdAt', type: 'Date', optional: false, readonly: true }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Immutable');

      assert.ok(schema);
      assert.strictEqual(schema.properties.id.readonly, true);
      assert.strictEqual(schema.properties.createdAt.readonly, true);
    });

    it('should extract interface with extends', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Extended:20',
        type: 'INTERFACE',
        name: 'Extended',
        file: '/src/types.ts',
        line: 20,
        column: 1,
        extends: ['Base', 'Mixin'],
        properties: [
          { name: 'extra', type: 'string', optional: false, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Extended');

      assert.ok(schema);
      assert.deepStrictEqual(schema.extends, ['Base', 'Mixin']);
    });

    it('should extract interface with method signatures (Phase 1: type=function)', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Service:25',
        type: 'INTERFACE',
        name: 'Service',
        file: '/src/types.ts',
        line: 25,
        column: 1,
        extends: [],
        properties: [
          { name: 'getData', type: 'function', optional: false, readonly: false },
          { name: 'setData', type: 'function', optional: false, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Service');

      assert.ok(schema);
      // Phase 1: methods are stored as 'function' type
      assert.strictEqual(schema.properties.getData.type, 'function');
      assert.strictEqual(schema.properties.setData.type, 'function');
    });

    it('should extract interface with type parameters', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Response:30',
        type: 'INTERFACE',
        name: 'Response',
        file: '/src/types.ts',
        line: 30,
        column: 1,
        extends: [],
        properties: [
          { name: 'data', type: 'T', optional: false, readonly: false },
          { name: 'error', type: 'E', optional: true, readonly: false }
        ],
        typeParameters: ['T', 'E extends Error']
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Response');

      assert.ok(schema);
      assert.deepStrictEqual(schema.typeParameters, ['T', 'E extends Error']);
    });

    it('should return null for non-existent interface', async () => {
      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('NonExistent');

      assert.strictEqual(schema, null);
    });

    it('should throw error for ambiguous name (multiple files)', async () => {
      backend.addInterface({
        id: '/src/a.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/a.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: []
      });
      backend.addInterface({
        id: '/src/b.ts:INTERFACE:Config:10',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/b.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: []
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);

      await assert.rejects(
        () => extractor.extract('Config'),
        /Multiple interfaces named "Config" found/
      );
    });

    it('should resolve ambiguity with file option', async () => {
      backend.addInterface({
        id: '/src/a.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/a.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [{ name: 'fromA', type: 'string', optional: false, readonly: false }]
      });
      backend.addInterface({
        id: '/src/b.ts:INTERFACE:Config:10',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/b.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: [{ name: 'fromB', type: 'number', optional: false, readonly: false }]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Config', { file: '/src/a.ts' });

      assert.ok(schema);
      assert.strictEqual(schema.source.file, '/src/a.ts');
      assert.ok('fromA' in schema.properties);
    });

    it('should resolve ambiguity with partial file path', async () => {
      backend.addInterface({
        id: '/src/a.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/a.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: []
      });
      backend.addInterface({
        id: '/src/b.ts:INTERFACE:Config:10',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/b.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: []
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Config', { file: 'b.ts' });

      assert.ok(schema);
      assert.strictEqual(schema.source.file, '/src/b.ts');
    });

    it('should produce deterministic checksum regardless of property order', async () => {
      // Add interface with properties in order: b, a
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'b', type: 'string', optional: false, readonly: false },
          { name: 'a', type: 'number', optional: false, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema1 = await extractor.extract('Config');

      // Clear and add same interface with properties in order: a, b
      backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'a', type: 'number', optional: false, readonly: false },
          { name: 'b', type: 'string', optional: false, readonly: false }
        ]
      });

      const extractor2 = new InterfaceSchemaExtractor(backend as any);
      const schema2 = await extractor2.extract('Config');

      assert.ok(schema1);
      assert.ok(schema2);
      assert.strictEqual(schema1.checksum, schema2.checksum, 'Checksum should be deterministic');
    });

    it('should include source location in schema', async () => {
      backend.addInterface({
        id: '/src/models/user.ts:INTERFACE:User:42',
        type: 'INTERFACE',
        name: 'User',
        file: '/src/models/user.ts',
        line: 42,
        column: 3,
        extends: [],
        properties: []
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('User');

      assert.ok(schema);
      assert.strictEqual(schema.source.file, '/src/models/user.ts');
      assert.strictEqual(schema.source.line, 42);
      assert.strictEqual(schema.source.column, 3);
    });

    it('should sort properties alphabetically in output', async () => {
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'zebra', type: 'string', optional: false, readonly: false },
          { name: 'alpha', type: 'string', optional: false, readonly: false },
          { name: 'middle', type: 'string', optional: false, readonly: false }
        ]
      });

      const extractor = new InterfaceSchemaExtractor(backend as any);
      const schema = await extractor.extract('Config');

      assert.ok(schema);
      const propNames = Object.keys(schema.properties);
      assert.deepStrictEqual(propNames, ['alpha', 'middle', 'zebra']);
    });
  });
});
