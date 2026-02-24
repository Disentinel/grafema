/**
 * Tests for PROPERTY_ASSIGNMENT nodes (REG-554)
 *
 * When code does `this.prop = value` inside a class, we create:
 * - PROPERTY_ASSIGNMENT node with: name (property name), objectName ('this'), className
 * - CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge
 * - PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> source node (VARIABLE, PARAMETER, or PROPERTY_ACCESS)
 *
 * Only `this.prop = value` inside a class body creates PROPERTY_ASSIGNMENT nodes.
 * Non-this assignments (obj.prop = value) are tracked by FLOWS_INTO edges only.
 *
 * TDD test file for REG-554. Tests are written BEFORE implementation.
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
 * Helper to create a test project with given files and run the orchestrator.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-prop-assign-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-prop-assign-${testCounter}`,
      type: 'module'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('PROPERTY_ASSIGNMENT nodes (REG-554)', () => {
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

  // ==========================================================================
  // Group 1: Basic this.x = value (VARIABLE RHS)
  // ==========================================================================
  describe('Basic this.x = variable', () => {
    it('should create PROPERTY_ASSIGNMENT node for this.bar = x in constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  constructor(x) {
    this.bar = x;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="bar" not found');
      assert.strictEqual(propAssign.objectName, 'this', 'objectName should be "this"');
      assert.strictEqual(propAssign.className, 'Foo', 'className should be "Foo"');
    });

    it('should create ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT to parameter', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  constructor(x) {
    this.bar = x;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="bar" not found');

      // Find the x parameter
      const xParam = allNodes.find(n =>
        n.name === 'x' && n.type === 'PARAMETER'
      );
      assert.ok(xParam, 'PARAMETER "x" not found');

      // PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> PARAMETER
      const assignedFrom = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' &&
        e.src === propAssign.id &&
        e.dst === xParam.id
      );
      assert.ok(
        assignedFrom,
        `Expected ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT "${propAssign.id}" to PARAMETER "${xParam.id}". ` +
        `Found ASSIGNED_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'ASSIGNED_FROM'))}`
      );
    });

    it('should create CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  constructor(x) {
    this.bar = x;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Foo'
      );
      assert.ok(classNode, 'CLASS "Foo" not found');

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="bar" not found');

      // CLASS --CONTAINS--> PROPERTY_ASSIGNMENT
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.src === classNode.id &&
        e.dst === propAssign.id
      );
      assert.ok(
        containsEdge,
        `Expected CONTAINS edge from CLASS "${classNode.id}" to PROPERTY_ASSIGNMENT "${propAssign.id}". ` +
        `Found CONTAINS edges from CLASS: ${JSON.stringify(allEdges.filter(e => e.type === 'CONTAINS' && e.src === classNode.id))}`
      );
    });
  });

  // ==========================================================================
  // Group 2: TSNonNullExpression wrapping MemberExpression
  // ==========================================================================
  describe('TSNonNullExpression wrapping MemberExpression', () => {
    it('should create PROPERTY_ASSIGNMENT with ASSIGNED_FROM to PROPERTY_ACCESS for options.graph!', async () => {
      await setupTest(backend, {
        'index.ts': `
class GraphRunner {
  constructor(options) {
    this.graph = options.graph!;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // PROPERTY_ASSIGNMENT node for "graph"
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'graph'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="graph" not found');

      // PROPERTY_ACCESS node for options.graph (created by PropertyAccessVisitor)
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.objectName === 'options' && n.name === 'graph'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for options.graph not found');

      // PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> PROPERTY_ACCESS
      const assignedFrom = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' &&
        e.src === propAssign.id &&
        e.dst === propAccess.id
      );
      assert.ok(
        assignedFrom,
        `Expected ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT "${propAssign.id}" to PROPERTY_ACCESS "${propAccess.id}". ` +
        `Found ASSIGNED_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'ASSIGNED_FROM'))}`
      );
    });
  });

  // ==========================================================================
  // Group 3: 3-field constructor (AC3)
  // ==========================================================================
  describe('3-field constructor (AC3)', () => {
    it('should create 3 PROPERTY_ASSIGNMENT nodes with ASSIGNED_FROM edges', async () => {
      await setupTest(backend, {
        'index.ts': `
class Server {
  constructor(config) {
    this.host = config.host;
    this.port = config.port;
    this.name = config.name;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // 3 PROPERTY_ASSIGNMENT nodes
      const propAssignNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
      assert.strictEqual(
        propAssignNodes.length, 3,
        `Expected 3 PROPERTY_ASSIGNMENT nodes, got ${propAssignNodes.length}. ` +
        `Found: ${JSON.stringify(propAssignNodes.map(n => n.name))}`
      );

      const names = propAssignNodes.map(n => n.name).sort();
      assert.deepStrictEqual(names, ['host', 'name', 'port'], 'Should have host, name, port');

      // Each should have objectName 'this' and className 'Server'
      for (const node of propAssignNodes) {
        assert.strictEqual(node.objectName, 'this', `${node.name}: objectName should be "this"`);
        assert.strictEqual(node.className, 'Server', `${node.name}: className should be "Server"`);
      }

      // Each should have a CONTAINS edge from CLASS
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Server');
      assert.ok(classNode, 'CLASS "Server" not found');

      for (const node of propAssignNodes) {
        const containsEdge = allEdges.find(e =>
          e.type === 'CONTAINS' && e.src === classNode.id && e.dst === node.id
        );
        assert.ok(containsEdge, `Missing CONTAINS edge from CLASS to PROPERTY_ASSIGNMENT "${node.name}"`);
      }

      // Each should have an ASSIGNED_FROM edge to a PROPERTY_ACCESS node
      for (const node of propAssignNodes) {
        const assignedFrom = allEdges.find(e =>
          e.type === 'ASSIGNED_FROM' && e.src === node.id
        );
        assert.ok(assignedFrom, `Missing ASSIGNED_FROM edge for PROPERTY_ASSIGNMENT "${node.name}"`);

        const targetNode = allNodes.find(n => n.id === assignedFrom.dst);
        assert.ok(targetNode, `ASSIGNED_FROM target node not found for "${node.name}"`);
        assert.strictEqual(
          targetNode.type, 'PROPERTY_ACCESS',
          `ASSIGNED_FROM target for "${node.name}" should be PROPERTY_ACCESS, got ${targetNode.type}`
        );
        assert.strictEqual(targetNode.objectName, 'config', `ASSIGNED_FROM target objectName should be "config"`);
        assert.strictEqual(
          targetNode.name, node.name,
          `ASSIGNED_FROM target property name should match: expected "${node.name}", got "${targetNode.name}"`
        );
      }
    });
  });

  // ==========================================================================
  // Group 4: LITERAL RHS — node created, no ASSIGNED_FROM edge
  // ==========================================================================
  describe('LITERAL RHS', () => {
    it('should create PROPERTY_ASSIGNMENT node with no ASSIGNED_FROM edge for literal', async () => {
      await setupTest(backend, {
        'index.js': `
class Counter {
  constructor() {
    this.count = 0;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'count'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="count" not found');

      // CLASS --CONTAINS--> PROPERTY_ASSIGNMENT
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Counter');
      assert.ok(classNode, 'CLASS "Counter" not found');

      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' && e.src === classNode.id && e.dst === propAssign.id
      );
      assert.ok(containsEdge, 'Missing CONTAINS edge from CLASS to PROPERTY_ASSIGNMENT');

      // No ASSIGNED_FROM edge for literal RHS
      const assignedFromEdges = allEdges.filter(e =>
        e.type === 'ASSIGNED_FROM' && e.src === propAssign.id
      );
      assert.strictEqual(
        assignedFromEdges.length, 0,
        `Expected 0 ASSIGNED_FROM edges for literal RHS, got ${assignedFromEdges.length}. ` +
        `Found: ${JSON.stringify(assignedFromEdges)}`
      );
    });
  });

  // ==========================================================================
  // Group 5: Non-this assignment NOT indexed
  // ==========================================================================
  describe('Non-this assignment NOT indexed', () => {
    it('should NOT create PROPERTY_ASSIGNMENT node for obj.x = value', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.x = 5;
        `
      });

      const allNodes = await backend.getAllNodes();

      const propAssignNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
      assert.strictEqual(
        propAssignNodes.length, 0,
        `Expected 0 PROPERTY_ASSIGNMENT nodes for non-this assignment, got ${propAssignNodes.length}. ` +
        `Found: ${JSON.stringify(propAssignNodes.map(n => ({ name: n.name, objectName: n.objectName })))}`
      );
    });

    it('should still create FLOWS_INTO edge for non-this assignment (regression guard)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const handler = () => {};
obj.handler = handler;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // No PROPERTY_ASSIGNMENT nodes
      const propAssignNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
      assert.strictEqual(propAssignNodes.length, 0, 'No PROPERTY_ASSIGNMENT nodes for non-this');

      // FLOWS_INTO edge should still exist
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(handlerVar, 'Variable "handler" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === handlerVar.id &&
        e.dst === objVar.id
      );
      assert.ok(flowsInto, 'FLOWS_INTO edge from handler to obj should still exist');
    });
  });

  // ==========================================================================
  // Group 6: Semantic ID uniqueness — same property name, different classes
  // ==========================================================================
  describe('Semantic ID uniqueness', () => {
    it('should create two distinct PROPERTY_ASSIGNMENT nodes for same property in different classes', async () => {
      await setupTest(backend, {
        'index.js': `
class A {
  constructor() {
    this.x = 1;
  }
}
class B {
  constructor() {
    this.x = 2;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const propAssignNodes = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'x'
      );
      assert.strictEqual(
        propAssignNodes.length, 2,
        `Expected 2 PROPERTY_ASSIGNMENT nodes for "x", got ${propAssignNodes.length}`
      );

      // Distinct IDs
      assert.notStrictEqual(
        propAssignNodes[0].id,
        propAssignNodes[1].id,
        'Two PROPERTY_ASSIGNMENT nodes for "x" in different classes should have distinct IDs'
      );

      // Different classNames
      const classNames = propAssignNodes.map(n => n.className).sort();
      assert.deepStrictEqual(classNames, ['A', 'B'], 'Should belong to classes A and B');
    });
  });

  // ==========================================================================
  // Group 7: Module-level this.x = value does NOT create a node
  // ==========================================================================
  describe('Module-level this.x = value', () => {
    it('should NOT create PROPERTY_ASSIGNMENT node without class context', async () => {
      await setupTest(backend, {
        'index.js': `
this.globalProp = 'value';
        `
      });

      const allNodes = await backend.getAllNodes();

      const propAssignNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
      assert.strictEqual(
        propAssignNodes.length, 0,
        `Expected 0 PROPERTY_ASSIGNMENT nodes for module-level this.x, got ${propAssignNodes.length}`
      );
    });
  });

  // ==========================================================================
  // Group 8: Multiple assignments to same property — distinct IDs
  // ==========================================================================
  describe('Multiple assignments to same property', () => {
    it('should create 2 PROPERTY_ASSIGNMENT nodes with distinct IDs for same property in different methods', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  constructor(a) {
    this.x = a;
  }
  reset(b) {
    this.x = b;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssignNodes = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'x'
      );
      assert.strictEqual(
        propAssignNodes.length, 2,
        `Expected 2 PROPERTY_ASSIGNMENT nodes for "x", got ${propAssignNodes.length}`
      );

      // Distinct IDs (discriminator ensures uniqueness)
      assert.notStrictEqual(
        propAssignNodes[0].id,
        propAssignNodes[1].id,
        'Two PROPERTY_ASSIGNMENT nodes for "x" in different methods should have distinct IDs'
      );

      // Both have CONTAINS edges from Foo CLASS
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
      assert.ok(classNode, 'CLASS "Foo" not found');

      for (const node of propAssignNodes) {
        const containsEdge = allEdges.find(e =>
          e.type === 'CONTAINS' && e.src === classNode.id && e.dst === node.id
        );
        assert.ok(containsEdge, `Missing CONTAINS edge from CLASS to PROPERTY_ASSIGNMENT "${node.name}" (id: ${node.id})`);
      }
    });
  });
});
