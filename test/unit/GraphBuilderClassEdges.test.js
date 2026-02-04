/**
 * GraphBuilder Class Edges Tests
 *
 * Tests that GraphBuilder creates DERIVES_FROM and INSTANCE_OF edges
 * with computed IDs instead of creating placeholder CLASS nodes.
 *
 * Verifies:
 * 1. DERIVES_FROM edge has dst ID format: {file}->global->CLASS->{superClass} (semantic ID)
 * 2. NO placeholder CLASS nodes created for superclasses
 * 3. INSTANCE_OF edge for external class has computed semantic ID
 * 4. Semantic IDs are stable across line number changes
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-graphbuilder-edges-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-graphbuilder-edges-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('GraphBuilder class edges without placeholders', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // DERIVES_FROM edges
  // ===========================================================================

  describe('DERIVES_FROM edges', () => {
    it('should create DERIVES_FROM edge with computed superclass ID', async () => {
      await setupTest(backend, {
        'index.js': `
class User {
  constructor(name) {
    this.name = name;
  }
}

class Admin extends User {
  constructor(name, role) {
    super(name);
    this.role = role;
  }
}
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM'
      );

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge not found');

      // dst should be computed semantic ID with format: {file}->global->CLASS->{superClass}
      assert.ok(
        derivesFromEdge.dst.includes('->CLASS->'),
        'dst should have ->CLASS-> format (semantic ID)'
      );
      assert.ok(
        derivesFromEdge.dst.includes('User'),
        'dst should reference User class'
      );
      assert.ok(
        derivesFromEdge.dst.endsWith('->User'),
        'dst should end with class name (semantic ID format)'
      );

      // Verify pattern: {path}/index.js->global->CLASS->User
      assert.ok(
        /index\.js->global->CLASS->User$/.test(derivesFromEdge.dst),
        `DERIVES_FROM dst should match semantic ID pattern. Got: ${derivesFromEdge.dst}`
      );
    });

    it('should NOT create placeholder CLASS node for superclass', async () => {
      await setupTest(backend, {
        'index.js': `
class Admin extends User {
  constructor() {
    super();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNodes = allNodes.filter(n => n.type === 'CLASS');

      // Should only have Admin CLASS node, NOT User placeholder
      assert.strictEqual(
        classNodes.length,
        1,
        'Should have only Admin CLASS node, no placeholder for User'
      );

      const adminNode = classNodes[0];
      assert.strictEqual(adminNode.name, 'Admin', 'Only class should be Admin');
    });

    it('should create dangling edge when superclass not yet analyzed', async () => {
      await setupTest(backend, {
        'index.js': `
class Derived extends BaseClass {
  method() {
    return 'derived';
  }
}
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM'
      );

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');

      // Edge should reference BaseClass even though it doesn't exist yet
      assert.ok(
        derivesFromEdge.dst.includes('BaseClass'),
        'Edge should reference BaseClass'
      );

      // Verify BaseClass node doesn't exist (dangling edge)
      const allNodes = await backend.getAllNodes();
      const baseClassNode = allNodes.find(n =>
        n.name === 'BaseClass' && n.type === 'CLASS'
      );

      assert.ok(
        !baseClassNode,
        'BaseClass node should NOT exist (dangling edge is expected)'
      );
    });

    it('should resolve dangling edge when superclass analyzed later', async () => {
      // Both classes in same file - orchestrator only discovers index.js
      await setupTest(backend, {
        'index.js': `
class User {
  constructor(name) {
    this.name = name;
  }
}

class Admin extends User {
  isAdmin() {
    return true;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Both classes should exist
      const adminNode = allNodes.find(n => n.name === 'Admin' && n.type === 'CLASS');
      const userNode = allNodes.find(n => n.name === 'User' && n.type === 'CLASS');

      assert.ok(adminNode, 'Admin class should exist');
      assert.ok(userNode, 'User class should exist');

      // DERIVES_FROM edge should exist
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM' && e.src === adminNode.id
      );

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');

      // Edge should point to User class (computed ID)
      assert.ok(
        derivesFromEdge.dst.includes('User'),
        'Edge should reference User'
      );
    });

    it('should use line 0 in computed superclass ID', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {}

class Derived extends Base {
  method() {}
}
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM'
      );

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');

      // dst should use semantic ID format (no line numbers)
      assert.ok(
        derivesFromEdge.dst.includes('->CLASS->'),
        'dst should use ->CLASS-> semantic ID format'
      );

      // Verify pattern: {path}/index.js->global->CLASS->Base
      assert.ok(
        /index\.js->global->CLASS->Base$/.test(derivesFromEdge.dst),
        `dst should match semantic ID pattern. Got: ${derivesFromEdge.dst}`
      );
    });
  });

  // ===========================================================================
  // INSTANCE_OF edges
  // ===========================================================================

  describe('INSTANCE_OF edges', () => {
    it('should create INSTANCE_OF edge with computed class ID', async () => {
      await setupTest(backend, {
        'index.js': `
class User {}
const user = new User();
        `
      });

      const allEdges = await backend.getAllEdges();
      const instanceOfEdge = allEdges.find(e =>
        e.type === 'INSTANCE_OF'
      );

      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // dst should reference User class
      assert.ok(
        instanceOfEdge.dst.includes('User'),
        'dst should reference User class'
      );
    });

    it('should NOT create placeholder CLASS node for external class', async () => {
      await setupTest(backend, {
        'index.js': `
const component = new ExternalClass();
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNodes = allNodes.filter(n => n.type === 'CLASS');

      // Should NOT have any CLASS nodes (ExternalClass not defined)
      assert.strictEqual(
        classNodes.length,
        0,
        'Should not create placeholder CLASS node for external class'
      );
    });

    it('should create INSTANCE_OF edge for external class with computed ID', async () => {
      await setupTest(backend, {
        'index.js': `
const instance = new ExternalService();
        `
      });

      const allEdges = await backend.getAllEdges();
      const instanceOfEdge = allEdges.find(e =>
        e.type === 'INSTANCE_OF'
      );

      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // dst should be computed semantic ID
      assert.ok(
        instanceOfEdge.dst.includes('->CLASS->'),
        'dst should have ->CLASS-> format (semantic ID)'
      );
      assert.ok(
        instanceOfEdge.dst.includes('ExternalService'),
        'dst should reference ExternalService'
      );
      assert.ok(
        instanceOfEdge.dst.endsWith('->ExternalService'),
        'dst should end with class name (semantic ID format)'
      );
    });

    it('should use same file for computed external class ID', async () => {
      await setupTest(backend, {
        'index.js': `
const service = new ServiceClass();
        `
      });

      const allEdges = await backend.getAllEdges();
      const instanceOfEdge = allEdges.find(e =>
        e.type === 'INSTANCE_OF'
      );

      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // Computed ID should reference same file (basename in semantic ID)
      assert.ok(
        instanceOfEdge.dst.includes('index.js->'),
        'dst should use same file as instantiation'
      );

      // Verify pattern: index.js->global->CLASS->ServiceClass
      assert.ok(
        /index\.js->global->CLASS->ServiceClass$/.test(instanceOfEdge.dst),
        `dst should match semantic ID pattern. Got: ${instanceOfEdge.dst}`
      );
    });
  });

  // ===========================================================================
  // INSTANCE_OF semantic IDs (REG-205)
  // ===========================================================================

  describe('INSTANCE_OF semantic IDs', () => {
    it('should create INSTANCE_OF edge with semantic ID for external class', async () => {
      await setupTest(backend, {
        'index.js': `
const service = new ExternalService();
        `
      });

      const allEdges = await backend.getAllEdges();
      const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // SEMANTIC ID format: {file}->global->CLASS->{name}
      // NOT legacy format: {file}:CLASS:{name}:0
      assert.ok(
        instanceOfEdge.dst.includes('->global->CLASS->'),
        `dst should use semantic ID format with ->global->CLASS->. Got: ${instanceOfEdge.dst}`
      );
      assert.ok(
        instanceOfEdge.dst.includes('ExternalService'),
        'dst should reference ExternalService'
      );
      assert.ok(
        !instanceOfEdge.dst.includes(':CLASS:'),
        'dst should NOT use legacy :CLASS: separator'
      );
    });

    it('should match actual CLASS node ID when class is defined', async () => {
      await setupTest(backend, {
        'index.js': `
class SocketService {
  connect() {}
}
const service = new SocketService();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'SocketService');
      const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

      assert.ok(classNode, 'SocketService CLASS node should exist');
      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // CRITICAL: Edge destination must match actual CLASS node ID
      assert.strictEqual(
        instanceOfEdge.dst,
        classNode.id,
        'INSTANCE_OF edge dst should match CLASS node id exactly'
      );
    });
  });

  // ===========================================================================
  // No placeholder nodes
  // ===========================================================================

  describe('no placeholder nodes', () => {
    it('should never create CLASS nodes with isInstantiationRef flag', async () => {
      await setupTest(backend, {
        'index.js': `
class Local {}
const local = new Local();
const external = new External();
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNodes = allNodes.filter(n => n.type === 'CLASS');

      // Should only have Local class
      assert.strictEqual(
        classNodes.length,
        1,
        'Should only have declared class, no placeholders'
      );

      const localClass = classNodes[0];
      assert.strictEqual(localClass.name, 'Local', 'Only class should be Local');

      // No CLASS node should have isInstantiationRef
      for (const node of classNodes) {
        assert.ok(
          !node.isInstantiationRef,
          'No CLASS node should have isInstantiationRef flag'
        );
      }
    });

    it('should create edges without creating placeholder nodes', async () => {
      await setupTest(backend, {
        'index.js': `
class A extends B {}
class C extends D {}
const x = new E();
const y = new F();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNodes = allNodes.filter(n => n.type === 'CLASS');

      // Should only have A and C (declared classes)
      assert.strictEqual(
        classNodes.length,
        2,
        'Should only have declared classes A and C'
      );

      // But should have edges for B, D, E, F
      const derivesFromEdges = allEdges.filter(e => e.type === 'DERIVES_FROM');
      const instanceOfEdges = allEdges.filter(e => e.type === 'INSTANCE_OF');

      assert.strictEqual(
        derivesFromEdges.length,
        2,
        'Should have 2 DERIVES_FROM edges (A->B, C->D)'
      );
      assert.strictEqual(
        instanceOfEdges.length,
        2,
        'Should have 2 INSTANCE_OF edges (x->E, y->F)'
      );
    });
  });

  // ===========================================================================
  // Edge ID formats
  // ===========================================================================

  describe('edge ID formats', () => {
    it('should NOT use CLASS# format in edge dst', async () => {
      await setupTest(backend, {
        'index.js': `
class Derived extends Base {}
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e =>
        e.type === 'DERIVES_FROM'
      );

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');

      // Should NOT have CLASS# format
      assert.ok(
        !derivesFromEdge.dst.includes('CLASS#'),
        'dst should NOT use legacy CLASS# format'
      );

      // Should use semantic ID format with ->CLASS->
      assert.ok(
        derivesFromEdge.dst.includes('->CLASS->'),
        'dst should use ->CLASS-> separator (semantic ID)'
      );
    });

    it('should use consistent ID format across all class edges', async () => {
      await setupTest(backend, {
        'index.js': `
class A extends B {}
const x = new C();
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e => e.type === 'DERIVES_FROM');
      const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');
      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // Both should use semantic ID format pattern: {file}->global->CLASS->{name}
      const dstPattern = /^[^->]+->global->CLASS->[^->]+$/;

      assert.ok(
        dstPattern.test(derivesFromEdge.dst),
        `DERIVES_FROM dst should match semantic ID pattern {file}->global->CLASS->{name}. Got: ${derivesFromEdge.dst}`
      );
      assert.ok(
        dstPattern.test(instanceOfEdge.dst),
        `INSTANCE_OF dst should match semantic ID pattern {file}->global->CLASS->{name}. Got: ${instanceOfEdge.dst}`
      );
    });
  });

  // ===========================================================================
  // Integration tests
  // ===========================================================================

  describe('integration', () => {
    it('should handle inheritance chain with computed IDs', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {}
class Middle extends Base {}
class Derived extends Middle {}
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdges = allEdges.filter(e => e.type === 'DERIVES_FROM');

      assert.strictEqual(
        derivesFromEdges.length,
        2,
        'Should have 2 DERIVES_FROM edges in chain'
      );

      // Middle -> Base
      const middleToBase = derivesFromEdges.find(e =>
        e.dst.includes('Base')
      );
      assert.ok(middleToBase, 'Middle -> Base edge should exist');
      assert.ok(
        /index\.js->global->CLASS->Base$/.test(middleToBase.dst),
        `Middle -> Base dst should match semantic ID pattern. Got: ${middleToBase.dst}`
      );

      // Derived -> Middle
      const derivedToMiddle = derivesFromEdges.find(e =>
        e.dst.includes('Middle')
      );
      assert.ok(derivedToMiddle, 'Derived -> Middle edge should exist');
      assert.ok(
        /index\.js->global->CLASS->Middle$/.test(derivedToMiddle.dst),
        `Derived -> Middle dst should match semantic ID pattern. Got: ${derivedToMiddle.dst}`
      );
    });

    it('should handle class instantiation and inheritance together', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {}
class Service extends Base {
  constructor() {
    super();
  }
}
const instance = new Service();
        `
      });

      const allEdges = await backend.getAllEdges();
      const derivesFromEdge = allEdges.find(e => e.type === 'DERIVES_FROM');
      const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

      assert.ok(derivesFromEdge, 'DERIVES_FROM edge should exist');
      assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

      // DERIVES_FROM: Service -> Base (computed semantic ID)
      assert.ok(
        /index\.js->global->CLASS->Base$/.test(derivesFromEdge.dst),
        `DERIVES_FROM dst should match semantic ID pattern. Got: ${derivesFromEdge.dst}`
      );

      // INSTANCE_OF: instance -> Service
      // This may use actual Service class ID (not computed)
      assert.ok(
        instanceOfEdge.dst.includes('Service'),
        'INSTANCE_OF should reference Service'
      );
    });
  });
});
