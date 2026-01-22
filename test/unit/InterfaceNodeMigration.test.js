/**
 * InterfaceNode Migration Tests (REG-103)
 *
 * TDD tests for migrating INTERFACE node creation to InterfaceNode factory.
 *
 * Verifies:
 * 1. InterfaceNode.create() generates ID with colon separator format
 * 2. TypeScriptVisitor should generate consistent ID format (will change from # to :)
 * 3. bufferInterfaceNodes should use InterfaceNode.create() instead of inline object
 * 4. EXTENDS edge IDs should match between source and destination nodes
 * 5. External interfaces should use InterfaceNode.create() with isExternal option
 *
 * Current state (before implementation):
 * - InterfaceNode.create() generates: {file}:INTERFACE:{name}:{line}
 * - TypeScriptVisitor generates: INTERFACE#{name}#{file}#{line} (legacy)
 * - bufferInterfaceNodes uses inline object literal
 *
 * Target state (after implementation):
 * - All INTERFACE nodes use InterfaceNode.create() with consistent format
 * - TypeScriptVisitor delegates ID generation to InterfaceNode.create()
 * - bufferInterfaceNodes uses InterfaceNode.create()
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Some tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { InterfaceNode, NodeFactory } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 * Note: For TypeScript features like interfaces, files must be discoverable
 * through the dependency tree. We use index.ts as entry point.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-interface-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-interface-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

// ============================================================================
// 1. InterfaceNode.create() ID format verification (Unit Tests)
// ============================================================================

describe('InterfaceNode Migration (REG-103)', () => {
  describe('InterfaceNode.create() ID format', () => {
    it('should generate ID with colon separator', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        0
      );

      // ID format: {file}:INTERFACE:{name}:{line}
      assert.strictEqual(
        node.id,
        '/project/src/types.ts:INTERFACE:IUser:5',
        'ID should use colon separators'
      );
    });

    it('should NOT use # separator in ID', () => {
      const node = InterfaceNode.create(
        'IService',
        '/project/src/services.ts',
        10,
        0
      );

      assert.ok(
        !node.id.includes('#'),
        `ID should NOT contain # separator: ${node.id}`
      );
    });

    it('should follow pattern: {file}:INTERFACE:{name}:{line}', () => {
      const node = InterfaceNode.create(
        'IRepository',
        '/src/data/repo.ts',
        25,
        0
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts.length, 4, 'ID should have 4 parts separated by :');
      assert.strictEqual(parts[0], '/src/data/repo.ts', 'First part should be file');
      assert.strictEqual(parts[1], 'INTERFACE', 'Second part should be INTERFACE');
      assert.strictEqual(parts[2], 'IRepository', 'Third part should be name');
      assert.strictEqual(parts[3], '25', 'Fourth part should be line');
    });

    it('should include line in ID (not semantic ID yet)', () => {
      // Note: InterfaceNode currently uses line-based IDs
      // Future enhancement might move to semantic IDs
      const node1 = InterfaceNode.create('IUser', '/file.ts', 10, 0);
      const node2 = InterfaceNode.create('IUser', '/file.ts', 20, 0);

      // Different lines = different IDs (line-based)
      assert.notStrictEqual(node1.id, node2.id,
        'Same interface at different lines should have different IDs');
    });

    it('should preserve all required fields', () => {
      const node = InterfaceNode.create(
        'IConfig',
        '/project/config.ts',
        15,
        5,
        {
          extends: ['IBase'],
          properties: [
            { name: 'timeout', type: 'number', optional: true }
          ]
        }
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'IConfig');
      assert.strictEqual(node.file, '/project/config.ts');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 5);
      assert.deepStrictEqual(node.extends, ['IBase']);
      assert.strictEqual(node.properties.length, 1);
      assert.strictEqual(node.properties[0].name, 'timeout');
    });

    it('should handle isExternal option for external interfaces', () => {
      const node = InterfaceNode.create(
        'ISerializable',
        '/project/src/models/User.ts',
        10,
        0,
        { isExternal: true }
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'ISerializable');
      assert.strictEqual(node.isExternal, true);
      // ID should still use colon format
      assert.ok(node.id.includes(':INTERFACE:'),
        `External interface should use colon format: ${node.id}`);
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = InterfaceNode.create('IUser', '/file.ts', 10, 0);
      const node2 = InterfaceNode.create('IUser', '/file.ts', 10, 0);

      assert.strictEqual(node1.id, node2.id,
        'Same parameters should produce same ID');
    });

    it('should create unique IDs for different interfaces', () => {
      const user = InterfaceNode.create('IUser', '/types.ts', 5, 0);
      const admin = InterfaceNode.create('IAdmin', '/types.ts', 10, 0);
      const userOtherFile = InterfaceNode.create('IUser', '/other.ts', 5, 0);

      assert.notStrictEqual(user.id, admin.id,
        'Different names should have different IDs');
      assert.notStrictEqual(user.id, userOtherFile.id,
        'Same name in different files should have different IDs');
    });
  });

  // ============================================================================
  // 2. Integration tests - INTERFACE node analysis
  // Note: These tests verify the end-to-end flow including TypeScriptVisitor
  // ============================================================================

  describe('INTERFACE node analysis integration', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should analyze TypeScript interface and use colon ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface IUser {
  id: string;
  name: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const interfaceNode = allNodes.find(n =>
        n.name === 'IUser' && n.type === 'INTERFACE'
      );

      assert.ok(interfaceNode, 'INTERFACE node "IUser" not found');

      // ID should use colon format (InterfaceNode.create pattern)
      // After migration: {file}:INTERFACE:IUser:{line}
      assert.ok(
        interfaceNode.id.includes(':INTERFACE:IUser:'),
        `ID should use colon format: ${interfaceNode.id}`
      );

      // Should NOT have legacy # format
      assert.ok(
        !interfaceNode.id.includes('INTERFACE#'),
        `ID should NOT use legacy # format: ${interfaceNode.id}`
      );
    });

    it('should analyze interface with properties correctly', async () => {
      await setupTest(backend, {
        'index.ts': `
export interface IProduct {
  id: number;
  name: string;
  price?: number;
  sku: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const interfaceNode = allNodes.find(n =>
        n.name === 'IProduct' && n.type === 'INTERFACE'
      );

      assert.ok(interfaceNode, 'INTERFACE node "IProduct" not found');

      // Verify properties are captured
      assert.ok(Array.isArray(interfaceNode.properties),
        'properties should be an array');
    });

    it('should create unique IDs for different interfaces', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IFirst {
  a: string;
}

interface ISecond {
  b: number;
}

interface IThird {
  c: boolean;
}

export { IFirst, ISecond, IThird };
        `
      });

      const allNodes = await backend.getAllNodes();
      const first = allNodes.find(n => n.name === 'IFirst' && n.type === 'INTERFACE');
      const second = allNodes.find(n => n.name === 'ISecond' && n.type === 'INTERFACE');
      const third = allNodes.find(n => n.name === 'IThird' && n.type === 'INTERFACE');

      assert.ok(first, 'IFirst not found');
      assert.ok(second, 'ISecond not found');
      assert.ok(third, 'IThird not found');

      // All IDs should be unique
      const ids = [first.id, second.id, third.id];
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, 'All interface IDs should be unique');

      // All should use colon format (after migration)
      for (const node of [first, second, third]) {
        assert.ok(
          node.id.includes(':INTERFACE:'),
          `ID should use colon format: ${node.id}`
        );
      }
    });
  });

  // ============================================================================
  // 3. EXTENDS edge consistency tests
  // ============================================================================

  describe('EXTENDS edge consistency', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should create EXTENDS edge between interfaces in same file', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IBase {
  id: string;
}

interface IChild extends IBase {
  name: string;
}

export { IBase, IChild };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const baseNode = allNodes.find(n => n.name === 'IBase' && n.type === 'INTERFACE');
      const childNode = allNodes.find(n => n.name === 'IChild' && n.type === 'INTERFACE');

      assert.ok(baseNode, 'IBase not found');
      assert.ok(childNode, 'IChild not found');

      // Find EXTENDS edge from child to base
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' &&
        e.src === childNode.id &&
        e.dst === baseNode.id
      );

      assert.ok(extendsEdge,
        `EXTENDS edge from ${childNode.id} to ${baseNode.id} not found`);

      // Edge src/dst should match node IDs exactly
      assert.strictEqual(extendsEdge.src, childNode.id,
        'EXTENDS src should match child node ID');
      assert.strictEqual(extendsEdge.dst, baseNode.id,
        'EXTENDS dst should match base node ID');
    });

    it('should create EXTENDS edge with consistent ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IEntity {
  createdAt: Date;
}

interface IUser extends IEntity {
  email: string;
}

export { IEntity, IUser };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const entityNode = allNodes.find(n => n.name === 'IEntity' && n.type === 'INTERFACE');
      const userNode = allNodes.find(n => n.name === 'IUser' && n.type === 'INTERFACE');

      // Both nodes should have colon-formatted IDs (after migration)
      assert.ok(entityNode.id.includes(':INTERFACE:'),
        `IEntity ID should use colon format: ${entityNode.id}`);
      assert.ok(userNode.id.includes(':INTERFACE:'),
        `IUser ID should use colon format: ${userNode.id}`);

      // EXTENDS edge should reference these exact IDs
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' && e.src === userNode.id
      );

      assert.ok(extendsEdge, 'EXTENDS edge not found');
      assert.strictEqual(extendsEdge.dst, entityNode.id,
        'EXTENDS edge dst should use same ID format as entity node');
    });

    it('should handle multiple extends', async () => {
      await setupTest(backend, {
        'index.ts': `
interface ISerializable {
  serialize(): string;
}

interface ICloneable {
  clone(): this;
}

interface IModel extends ISerializable, ICloneable {
  id: string;
}

export { ISerializable, ICloneable, IModel };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const modelNode = allNodes.find(n => n.name === 'IModel' && n.type === 'INTERFACE');
      assert.ok(modelNode, 'IModel not found');

      // Should have extends array with both parents
      assert.deepStrictEqual(
        modelNode.extends?.sort(),
        ['ICloneable', 'ISerializable'].sort(),
        'IModel should extend both ISerializable and ICloneable'
      );

      // Should have EXTENDS edges to both parents
      const extendsEdges = allEdges.filter(e =>
        e.type === 'EXTENDS' && e.src === modelNode.id
      );

      assert.strictEqual(extendsEdges.length, 2,
        'Should have 2 EXTENDS edges from IModel');
    });
  });

  // ============================================================================
  // 4. External interface handling tests
  // ============================================================================

  describe('External interface handling', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should create external interface node with isExternal flag', async () => {
      await setupTest(backend, {
        'index.ts': `
// ISerializable is not defined in this file (external)
interface IMyService extends ISerializable {
  process(): void;
}

export { IMyService };
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the external interface node
      const externalNode = allNodes.find(n =>
        n.name === 'ISerializable' && n.type === 'INTERFACE'
      );

      assert.ok(externalNode,
        'External interface ISerializable should be created');
      assert.strictEqual(externalNode.isExternal, true,
        'External interface should have isExternal: true');
    });

    it('should use colon format for external interface IDs', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IHandler extends IDisposable {
  handle(): void;
}

export { IHandler };
        `
      });

      const allNodes = await backend.getAllNodes();

      const externalNode = allNodes.find(n =>
        n.name === 'IDisposable' && n.type === 'INTERFACE'
      );

      assert.ok(externalNode, 'External interface IDisposable not found');

      // External interface should also use colon format (after migration)
      assert.ok(
        externalNode.id.includes(':INTERFACE:IDisposable:'),
        `External interface ID should use colon format: ${externalNode.id}`
      );

      // Should NOT use # format
      assert.ok(
        !externalNode.id.includes('INTERFACE#'),
        `External interface ID should NOT use # format: ${externalNode.id}`
      );
    });

    it('should create EXTENDS edge to external interface', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IComponent extends IRenderable {
  render(): void;
}

export { IComponent };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const componentNode = allNodes.find(n =>
        n.name === 'IComponent' && n.type === 'INTERFACE'
      );
      const renderableNode = allNodes.find(n =>
        n.name === 'IRenderable' && n.type === 'INTERFACE'
      );

      assert.ok(componentNode, 'IComponent not found');
      assert.ok(renderableNode, 'External IRenderable not found');

      // Find EXTENDS edge
      const extendsEdge = allEdges.find(e =>
        e.type === 'EXTENDS' &&
        e.src === componentNode.id &&
        e.dst === renderableNode.id
      );

      assert.ok(extendsEdge,
        'EXTENDS edge from IComponent to external IRenderable not found');
    });

    it('should distinguish external from local interfaces', async () => {
      await setupTest(backend, {
        'index.ts': `
interface ILocal {
  value: string;
}

interface IMixed extends ILocal, IExternal {
  combined: boolean;
}

export { ILocal, IMixed };
        `
      });

      const allNodes = await backend.getAllNodes();

      const localNode = allNodes.find(n =>
        n.name === 'ILocal' && n.type === 'INTERFACE'
      );
      const externalNode = allNodes.find(n =>
        n.name === 'IExternal' && n.type === 'INTERFACE'
      );

      assert.ok(localNode, 'ILocal not found');
      assert.ok(externalNode, 'IExternal not found');

      // Local should NOT have isExternal (or be undefined/false)
      assert.ok(
        localNode.isExternal === undefined || localNode.isExternal === false,
        'Local interface should not have isExternal: true'
      );

      // External should have isExternal: true
      assert.strictEqual(externalNode.isExternal, true,
        'External interface should have isExternal: true');
    });
  });

  // ============================================================================
  // 5. NodeFactory.createInterface compatibility
  // ============================================================================

  describe('NodeFactory.createInterface compatibility', () => {
    it('should be alias for InterfaceNode.create', () => {
      const viaNodeFactory = NodeFactory.createInterface(
        'ITest',
        '/file.ts',
        10,
        0,
        { extends: ['IBase'] }
      );

      const viaInterfaceNode = InterfaceNode.create(
        'ITest',
        '/file.ts',
        10,
        0,
        { extends: ['IBase'] }
      );

      assert.deepStrictEqual(viaNodeFactory, viaInterfaceNode,
        'NodeFactory.createInterface should produce same result as InterfaceNode.create');
    });

    it('should pass validation for created interfaces', () => {
      const node = NodeFactory.createInterface(
        'IService',
        '/project/services.ts',
        15,
        0,
        {
          extends: ['IBase'],
          properties: [
            { name: 'init', type: 'Function' }
          ],
          isExternal: false
        }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });
  });

  // ============================================================================
  // 6. No inline ID strings (GraphBuilder migration verification)
  // ============================================================================

  describe('No inline ID strings', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should NOT use INTERFACE# format in analyzed code', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IData {
  items: string[];
}

export { IData };
        `
      });

      const allNodes = await backend.getAllNodes();
      const interfaceNode = allNodes.find(n =>
        n.name === 'IData' && n.type === 'INTERFACE'
      );

      assert.ok(interfaceNode, 'IData not found');

      // Check ID format
      assert.ok(
        !interfaceNode.id.includes('INTERFACE#'),
        `ID should NOT contain legacy INTERFACE# format: ${interfaceNode.id}`
      );

      assert.ok(
        interfaceNode.id.includes(':INTERFACE:'),
        `ID should use colon format: ${interfaceNode.id}`
      );
    });

    it('should match InterfaceNode.create ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IConfig {
  setting: boolean;
}

export { IConfig };
        `
      });

      const allNodes = await backend.getAllNodes();
      const analyzed = allNodes.find(n =>
        n.name === 'IConfig' && n.type === 'INTERFACE'
      );

      assert.ok(analyzed, 'IConfig not found');

      // Create expected ID using InterfaceNode.create
      // Note: We need to extract the actual line from the analyzed node
      const expected = InterfaceNode.create(
        'IConfig',
        analyzed.file,
        analyzed.line,
        0
      );

      // The ID format should match what InterfaceNode.create produces
      assert.ok(
        analyzed.id.startsWith(analyzed.file + ':INTERFACE:IConfig:'),
        `Analyzed ID should follow InterfaceNode.create format: ${analyzed.id}`
      );
    });
  });
});
