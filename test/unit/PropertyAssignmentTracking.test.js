/**
 * Property Assignment Tracking Tests (REG-554)
 *
 * Tests for the PROPERTY_ASSIGNMENT node type created when `this.x = value`
 * occurs inside a class method or constructor.
 *
 * For each `this.x = value` inside a class, the graph should contain:
 * - PROPERTY_ASSIGNMENT node with name=x, objectName='this', className=<enclosing class>
 * - CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge
 * - PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node> edge (when rhs is VARIABLE or PARAMETER)
 *
 * This is additive: existing FLOWS_INTO edges from MutationBuilder are preserved.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL (RED) until implementation is done.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

/**
 * Helper to create a test project with given files, run analysis, return backend
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-prop-assign-${Date.now()}-${testCounter++}`);
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

describe('Property Assignment Tracking (REG-554)', () => {
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
  // Test 1: Constructor with 3 field assignments (acceptance criteria)
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT nodes for each this.x = param in constructor', async () => {
    await setupTest(backend, {
      'index.js': `
class Config {
  constructor(graph, router, logger) {
    this.graph = graph;
    this.router = router;
    this.logger = logger;
  }
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find PROPERTY_ASSIGNMENT nodes
    const paNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
    assert.strictEqual(
      paNodes.length, 3,
      `Expected 3 PROPERTY_ASSIGNMENT nodes, got ${paNodes.length}. ` +
      `All node types: ${JSON.stringify([...new Set(allNodes.map(n => n.type))])}`
    );

    // Verify names
    const paNames = paNodes.map(n => n.name).sort();
    assert.deepStrictEqual(paNames, ['graph', 'logger', 'router']);

    // Verify each has type === 'PROPERTY_ASSIGNMENT'
    for (const pa of paNodes) {
      assert.strictEqual(pa.type, 'PROPERTY_ASSIGNMENT');
    }

    // Verify each has className === 'Config'
    for (const pa of paNodes) {
      assert.strictEqual(
        pa.className, 'Config',
        `PROPERTY_ASSIGNMENT "${pa.name}" should have className 'Config', got '${pa.className}'`
      );
    }

    // Verify CLASS "Config" --CONTAINS--> each PROPERTY_ASSIGNMENT
    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
    assert.ok(classNode, 'CLASS "Config" not found');

    for (const pa of paNodes) {
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.src === classNode.id &&
        e.dst === pa.id
      );
      assert.ok(
        containsEdge,
        `Expected CLASS "Config" --CONTAINS--> PROPERTY_ASSIGNMENT "${pa.name}". ` +
        `CONTAINS edges from class: ${JSON.stringify(allEdges.filter(e => e.type === 'CONTAINS' && e.src === classNode.id))}`
      );
    }

    // Verify each PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> the corresponding PARAMETER
    for (const pa of paNodes) {
      const param = allNodes.find(n =>
        n.type === 'PARAMETER' && n.name === pa.name
      );
      assert.ok(param, `PARAMETER "${pa.name}" not found`);

      const assignedFrom = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' &&
        e.src === pa.id &&
        e.dst === param.id
      );
      assert.ok(
        assignedFrom,
        `Expected PROPERTY_ASSIGNMENT "${pa.name}" --ASSIGNED_FROM--> PARAMETER "${pa.name}". ` +
        `ASSIGNED_FROM edges from this PA: ${JSON.stringify(allEdges.filter(e => e.type === 'ASSIGNED_FROM' && e.src === pa.id))}`
      );
    }
  });

  // ==========================================================================
  // Test 2: Single this.x = parameter in constructor
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT with ASSIGNED_FROM to PARAMETER for single field', async () => {
    await setupTest(backend, {
      'index.js': `
class Service {
  constructor(dep) {
    this.dep = dep;
  }
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find PROPERTY_ASSIGNMENT "dep"
    const paNode = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'dep'
    );
    assert.ok(
      paNode,
      `PROPERTY_ASSIGNMENT "dep" not found. All PROPERTY_ASSIGNMENT nodes: ` +
      `${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT'))}`
    );

    // Find PARAMETER "dep"
    const paramNode = allNodes.find(n =>
      n.type === 'PARAMETER' && n.name === 'dep'
    );
    assert.ok(paramNode, 'PARAMETER "dep" not found');

    // Verify ASSIGNED_FROM edge
    const assignedFrom = allEdges.find(e =>
      e.type === 'ASSIGNED_FROM' &&
      e.src === paNode.id &&
      e.dst === paramNode.id
    );
    assert.ok(
      assignedFrom,
      `Expected PROPERTY_ASSIGNMENT "dep" --ASSIGNED_FROM--> PARAMETER "dep". ` +
      `ASSIGNED_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'ASSIGNED_FROM'))}`
    );
  });

  // ==========================================================================
  // Test 3: this.x = local variable in method
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT with ASSIGNED_FROM to VARIABLE in method', async () => {
    await setupTest(backend, {
      'index.js': `
class Svc {
  init() {
    const helper = () => {};
    this.helper = helper;
  }
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find PROPERTY_ASSIGNMENT "helper"
    const paNode = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'helper'
    );
    assert.ok(
      paNode,
      `PROPERTY_ASSIGNMENT "helper" not found. All PROPERTY_ASSIGNMENT nodes: ` +
      `${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT'))}`
    );

    // Find VARIABLE/CONSTANT "helper"
    const helperVar = allNodes.find(n =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'helper'
    );
    assert.ok(helperVar, 'VARIABLE "helper" not found');

    // Verify ASSIGNED_FROM edge
    const assignedFrom = allEdges.find(e =>
      e.type === 'ASSIGNED_FROM' &&
      e.src === paNode.id &&
      e.dst === helperVar.id
    );
    assert.ok(
      assignedFrom,
      `Expected PROPERTY_ASSIGNMENT "helper" --ASSIGNED_FROM--> VARIABLE "helper". ` +
      `ASSIGNED_FROM edges from PA: ${JSON.stringify(allEdges.filter(e => e.type === 'ASSIGNED_FROM' && e.src === paNode.id))}`
    );
  });

  // ==========================================================================
  // Test 4: this.x = literal -- node created, no ASSIGNED_FROM edge
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT node for literal value but no ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.js': `
class Config {
  constructor() {
    this.port = 3000;
  }
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find PROPERTY_ASSIGNMENT "port"
    const paNode = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'port'
    );
    assert.ok(
      paNode,
      `PROPERTY_ASSIGNMENT "port" not found. All PROPERTY_ASSIGNMENT nodes: ` +
      `${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT'))}`
    );

    // No ASSIGNED_FROM edge should exist from this PROPERTY_ASSIGNMENT
    const assignedFromEdges = allEdges.filter(e =>
      e.type === 'ASSIGNED_FROM' && e.src === paNode.id
    );
    assert.strictEqual(
      assignedFromEdges.length, 0,
      `Literal values should NOT produce ASSIGNED_FROM edges. Found: ${JSON.stringify(assignedFromEdges)}`
    );
  });

  // ==========================================================================
  // Test 5: this.x = value outside class -- NO PROPERTY_ASSIGNMENT created
  // ==========================================================================
  it('should NOT create PROPERTY_ASSIGNMENT nodes for this.x outside class', async () => {
    await setupTest(backend, {
      'index.js': `
function standalone(x) {
  this.x = x;
}
      `
    });

    const allNodes = await backend.getAllNodes();

    // Zero PROPERTY_ASSIGNMENT nodes expected
    const paNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
    assert.strictEqual(
      paNodes.length, 0,
      `Expected 0 PROPERTY_ASSIGNMENT nodes outside class context, got ${paNodes.length}: ` +
      `${JSON.stringify(paNodes)}`
    );
  });

  // ==========================================================================
  // Test 6: CONTAINS edge direction is CLASS -> PROPERTY_ASSIGNMENT
  // ==========================================================================
  it('should create CONTAINS edge with direction CLASS -> PROPERTY_ASSIGNMENT', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  constructor(bar) {
    this.bar = bar;
  }
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find CLASS "Foo"
    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
    assert.ok(classNode, 'CLASS "Foo" not found');

    // Find PROPERTY_ASSIGNMENT "bar"
    const paNode = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'bar'
    );
    assert.ok(
      paNode,
      `PROPERTY_ASSIGNMENT "bar" not found. All PROPERTY_ASSIGNMENT nodes: ` +
      `${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT'))}`
    );

    // Verify edge direction: CLASS (src) -> PROPERTY_ASSIGNMENT (dst)
    const containsEdge = allEdges.find(e =>
      e.type === 'CONTAINS' &&
      e.src === classNode.id &&
      e.dst === paNode.id
    );
    assert.ok(
      containsEdge,
      `Expected CONTAINS edge with src=CLASS "${classNode.id}" and dst=PROPERTY_ASSIGNMENT "${paNode.id}". ` +
      `All CONTAINS edges: ${JSON.stringify(allEdges.filter(e => e.type === 'CONTAINS'))}`
    );

    // Verify it is NOT reversed (no PROPERTY_ASSIGNMENT -> CLASS edge of type CONTAINS)
    const reversedEdge = allEdges.find(e =>
      e.type === 'CONTAINS' &&
      e.src === paNode.id &&
      e.dst === classNode.id
    );
    assert.strictEqual(
      reversedEdge, undefined,
      'CONTAINS edge should NOT be reversed (PROPERTY_ASSIGNMENT -> CLASS)'
    );
  });
});
