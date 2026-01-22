/**
 * IMPLEMENTS Edge Migration Tests (REG-128)
 *
 * TDD tests for IMPLEMENTS edges (CLASS -> INTERFACE).
 *
 * Verifies:
 * 1. When a class implements an interface in the same file, an IMPLEMENTS edge is created
 * 2. The IMPLEMENTS edge dst ID must match the INTERFACE node ID (factory format: {file}:INTERFACE:{name}:{line})
 * 3. When a class implements an external interface, an external interface node with isExternal: true is created
 *
 * Current state (before fix):
 * - TypeScriptVisitor computes interfaceId that matches factory format by coincidence
 * - bufferImplementsEdges() uses iface.id from visitor
 *
 * Target state (after fix):
 * - bufferImplementsEdges() should lookup interface by name and use factory-created node ID
 * - No reliance on visitor-computed IDs
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests verify current behavior as baseline.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { InterfaceNode } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-implements-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-implements-${testCounter}`,
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

describe('IMPLEMENTS Edge Migration (REG-128)', () => {
  // ============================================================================
  // 1. Basic IMPLEMENTS edge creation
  // ============================================================================

  describe('IMPLEMENTS edge creation (same file)', () => {
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

    it('should create IMPLEMENTS edge when class implements interface in same file', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IUser {
  name: string;
  getId(): string;
}

class User implements IUser {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  getId(): string {
    return this.name;
  }
}

export { IUser, User };
        `
      });

      const allEdges = await backend.getAllEdges();
      const implementsEdges = allEdges.filter(e => e.type === 'IMPLEMENTS');

      assert.strictEqual(implementsEdges.length, 1,
        'Should have exactly one IMPLEMENTS edge');

      const edge = implementsEdges[0];

      // src should be CLASS node ID (semantic ID format: {file}->{scope}->CLASS->{name})
      assert.ok(edge.src.includes('->CLASS->User'),
        `IMPLEMENTS src should be CLASS node. Got: ${edge.src}`);

      // dst should be INTERFACE node ID (factory format: {file}:INTERFACE:{name}:{line})
      assert.ok(edge.dst.includes(':INTERFACE:IUser:'),
        `IMPLEMENTS dst should be INTERFACE node. Got: ${edge.dst}`);
    });

    it('should match IMPLEMENTS edge dst to actual INTERFACE node ID', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IService {
  start(): void;
}

class MyService implements IService {
  start(): void {
    console.log('started');
  }
}

export { IService, MyService };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the INTERFACE node
      const interfaceNode = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IService'
      );
      assert.ok(interfaceNode, 'INTERFACE node IService not found');

      // Find the IMPLEMENTS edge
      const implementsEdge = allEdges.find(e => e.type === 'IMPLEMENTS');
      assert.ok(implementsEdge, 'IMPLEMENTS edge not found');

      // Edge dst should EXACTLY match interface node ID
      assert.strictEqual(implementsEdge.dst, interfaceNode.id,
        `IMPLEMENTS edge dst (${implementsEdge.dst}) should match INTERFACE node ID (${interfaceNode.id})`);
    });

    it('should use factory ID format for IMPLEMENTS edge dst', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IRepository {
  save(item: any): void;
}

class Repository implements IRepository {
  save(item: any): void {
    // save logic
  }
}

export { IRepository, Repository };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const interfaceNode = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IRepository'
      );

      const implementsEdge = allEdges.find(e => e.type === 'IMPLEMENTS');

      // Verify the edge dst matches factory format: {file}:INTERFACE:{name}:{line}
      const expectedIdPattern = new RegExp(
        `${interfaceNode.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:INTERFACE:IRepository:\\d+`
      );

      assert.ok(expectedIdPattern.test(implementsEdge.dst),
        `IMPLEMENTS dst should match factory format. Got: ${implementsEdge.dst}`);

      // Should NOT have legacy # format
      assert.ok(!implementsEdge.dst.includes('#'),
        `IMPLEMENTS dst should NOT use # separator. Got: ${implementsEdge.dst}`);
    });

    it('should create multiple IMPLEMENTS edges for class implementing multiple interfaces', async () => {
      await setupTest(backend, {
        'index.ts': `
interface ISerializable {
  serialize(): string;
}

interface ICloneable {
  clone(): this;
}

class Model implements ISerializable, ICloneable {
  serialize(): string {
    return JSON.stringify(this);
  }

  clone(): this {
    return Object.create(this);
  }
}

export { ISerializable, ICloneable, Model };
        `
      });

      const allEdges = await backend.getAllEdges();
      const implementsEdges = allEdges.filter(e => e.type === 'IMPLEMENTS');

      assert.strictEqual(implementsEdges.length, 2,
        'Should have two IMPLEMENTS edges');

      // All edges should reference the same CLASS (Model)
      const srcIds = new Set(implementsEdges.map(e => e.src));
      assert.strictEqual(srcIds.size, 1, 'All IMPLEMENTS edges should have same src (Model class)');

      // Each edge should reference different INTERFACE
      const dstIds = new Set(implementsEdges.map(e => e.dst));
      assert.strictEqual(dstIds.size, 2, 'IMPLEMENTS edges should reference different interfaces');

      // Verify both interfaces are referenced
      const dstNames = implementsEdges.map(e => {
        const match = e.dst.match(/:INTERFACE:(\w+):/);
        return match ? match[1] : null;
      });
      assert.ok(dstNames.includes('ISerializable'), 'Should implement ISerializable');
      assert.ok(dstNames.includes('ICloneable'), 'Should implement ICloneable');
    });
  });

  // ============================================================================
  // 2. External interface handling
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

    it('should create external interface node when class implements undefined interface', async () => {
      await setupTest(backend, {
        'index.ts': `
// IExternal is not defined in this file
class MyHandler implements IExternal {
  handle(): void {
    // handler logic
  }
}

export { MyHandler };
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the external interface node
      const externalInterface = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IExternal'
      );

      assert.ok(externalInterface, 'External interface IExternal should be created');
      assert.strictEqual(externalInterface.isExternal, true,
        'External interface should have isExternal: true');
    });

    it('should create IMPLEMENTS edge to external interface', async () => {
      await setupTest(backend, {
        'index.ts': `
class MyComponent implements IDisposable {
  dispose(): void {
    // cleanup
  }
}

export { MyComponent };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'MyComponent'
      );
      const externalInterface = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IDisposable'
      );

      assert.ok(classNode, 'CLASS MyComponent not found');
      assert.ok(externalInterface, 'External INTERFACE IDisposable not found');

      const implementsEdge = allEdges.find(e =>
        e.type === 'IMPLEMENTS' &&
        e.src === classNode.id &&
        e.dst === externalInterface.id
      );

      assert.ok(implementsEdge,
        `IMPLEMENTS edge from ${classNode.id} to ${externalInterface.id} not found`);
    });

    it('should use factory format for external interface ID', async () => {
      await setupTest(backend, {
        'index.ts': `
class Renderer implements IRenderable {
  render(): void {}
}

export { Renderer };
        `
      });

      const allNodes = await backend.getAllNodes();

      const externalInterface = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IRenderable'
      );

      assert.ok(externalInterface, 'External interface not found');

      // ID should use colon format
      assert.ok(externalInterface.id.includes(':INTERFACE:IRenderable:'),
        `External interface ID should use colon format. Got: ${externalInterface.id}`);

      // Should NOT use legacy # format
      assert.ok(!externalInterface.id.includes('#'),
        `External interface ID should NOT use # format. Got: ${externalInterface.id}`);
    });

    it('should distinguish local from external interfaces', async () => {
      await setupTest(backend, {
        'index.ts': `
interface ILocal {
  localMethod(): void;
}

class Mixed implements ILocal, IExternal {
  localMethod(): void {}
  externalMethod(): void {}
}

export { ILocal, Mixed };
        `
      });

      const allNodes = await backend.getAllNodes();

      const localInterface = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'ILocal'
      );
      const externalInterface = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IExternal'
      );

      assert.ok(localInterface, 'Local interface ILocal not found');
      assert.ok(externalInterface, 'External interface IExternal not found');

      // Local should NOT have isExternal (or be false/undefined)
      assert.ok(
        localInterface.isExternal === undefined || localInterface.isExternal === false,
        'Local interface should not have isExternal: true'
      );

      // External should have isExternal: true
      assert.strictEqual(externalInterface.isExternal, true,
        'External interface should have isExternal: true');
    });
  });

  // ============================================================================
  // 3. Edge ID consistency verification
  // ============================================================================

  describe('Edge ID consistency', () => {
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

    it('should have CLASS node with ID matching IMPLEMENTS edge src', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IEntity {
  id: string;
}

class Entity implements IEntity {
  id: string = '';
}

export { IEntity, Entity };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Entity'
      );
      const implementsEdge = allEdges.find(e => e.type === 'IMPLEMENTS');

      assert.ok(classNode, 'CLASS Entity not found');
      assert.ok(implementsEdge, 'IMPLEMENTS edge not found');

      // Edge src should match class node ID exactly
      assert.strictEqual(implementsEdge.src, classNode.id,
        `Edge src (${implementsEdge.src}) should match CLASS node ID (${classNode.id})`);
    });

    it('should have INTERFACE node with ID matching IMPLEMENTS edge dst', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IConfig {
  value: string;
}

class Config implements IConfig {
  value: string = 'default';
}

export { IConfig, Config };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const interfaceNode = allNodes.find(n =>
        n.type === 'INTERFACE' && n.name === 'IConfig'
      );
      const implementsEdge = allEdges.find(e => e.type === 'IMPLEMENTS');

      assert.ok(interfaceNode, 'INTERFACE IConfig not found');
      assert.ok(implementsEdge, 'IMPLEMENTS edge not found');

      // Edge dst should match interface node ID exactly
      assert.strictEqual(implementsEdge.dst, interfaceNode.id,
        `Edge dst (${implementsEdge.dst}) should match INTERFACE node ID (${interfaceNode.id})`);
    });

    it('should verify edge connects existing nodes (no dangling references)', async () => {
      await setupTest(backend, {
        'index.ts': `
interface IWorker {
  work(): void;
}

class Worker implements IWorker {
  work(): void {
    console.log('working');
  }
}

export { IWorker, Worker };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const implementsEdge = allEdges.find(e => e.type === 'IMPLEMENTS');
      assert.ok(implementsEdge, 'IMPLEMENTS edge not found');

      const nodeIds = new Set(allNodes.map(n => n.id));

      // Both src and dst should reference existing nodes
      assert.ok(nodeIds.has(implementsEdge.src),
        `Edge src ${implementsEdge.src} should reference existing node`);
      assert.ok(nodeIds.has(implementsEdge.dst),
        `Edge dst ${implementsEdge.dst} should reference existing node`);
    });
  });

  // ============================================================================
  // 4. InterfaceNode.create format verification
  // ============================================================================

  describe('InterfaceNode.create format verification', () => {
    it('should generate ID with format {file}:INTERFACE:{name}:{line}', () => {
      const node = InterfaceNode.create(
        'ITest',
        '/src/types.ts',
        10,
        0
      );

      assert.strictEqual(
        node.id,
        '/src/types.ts:INTERFACE:ITest:10',
        'InterfaceNode ID should use colon format'
      );
    });

    it('should NOT contain # separator', () => {
      const node = InterfaceNode.create(
        'IService',
        '/app/services.ts',
        25,
        0
      );

      assert.ok(!node.id.includes('#'),
        `ID should not contain # separator. Got: ${node.id}`);
    });

    it('should create external interface with isExternal flag', () => {
      const node = InterfaceNode.create(
        'IExternal',
        '/src/impl.ts',
        5,
        0,
        { isExternal: true }
      );

      assert.strictEqual(node.isExternal, true,
        'External interface should have isExternal: true');
      assert.ok(node.id.includes(':INTERFACE:IExternal:'),
        'External interface should use standard ID format');
    });
  });
});
