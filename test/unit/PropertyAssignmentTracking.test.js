/**
 * Property Assignment Tracking Tests (REG-554)
 *
 * V3 model: When `this.x = value` or `obj.x = value` occurs:
 * - PROPERTY_ASSIGNMENT node (name="this.x" or "obj.x") replaces EXPRESSION(=)
 * - PROPERTY_ACCESS node (name="this.x") still exists as child of PROPERTY_ASSIGNMENT (via CONTAINS)
 * - READS_FROM edge from PROPERTY_ASSIGNMENT to the source (parameter/variable)
 * - CLASS --HAS_MEMBER--> METHOD
 * - For simple Identifier RHS (e.g. `this.bar = x`), the edge is READS_FROM (scope_lookup deferred)
 *
 * Originally tested EXPRESSION(=) nodes. Updated for PROPERTY_ASSIGNMENT model.
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
  // Test 1: Constructor with 3 field assignments
  // V3: 3 PROPERTY_ASSIGNMENT nodes with READS_FROM to each parameter
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT nodes with READS_FROM for each this.x = param in constructor', async () => {
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

    // V3: PROPERTY_ASSIGNMENT nodes for each assignment
    const propAssigns = allNodes.filter(n =>
      n.type === 'PROPERTY_ASSIGNMENT'
    );
    assert.strictEqual(
      propAssigns.length, 3,
      `Expected 3 PROPERTY_ASSIGNMENT nodes, got ${propAssigns.length}. ` +
      `All node types: ${JSON.stringify([...new Set(allNodes.map(n => n.type))])}`
    );

    // V3: PROPERTY_ASSIGNMENT names should be this.graph, this.router, this.logger
    const expectedNames = ['this.graph', 'this.router', 'this.logger'];
    for (const name of expectedNames) {
      const pa = propAssigns.find(n => n.name === name);
      assert.ok(pa, `PROPERTY_ASSIGNMENT "${name}" not found. Got: ${propAssigns.map(n => n.name)}`);
    }

    // V3: PROPERTY_ACCESS nodes for this.graph, this.router, this.logger still exist
    const propAccesses = allNodes.filter(n =>
      n.type === 'PROPERTY_ACCESS' &&
      (n.name === 'this.graph' || n.name === 'this.router' || n.name === 'this.logger')
    );
    assert.strictEqual(propAccesses.length, 3, `Expected 3 PROPERTY_ACCESS nodes for this.*, got ${propAccesses.length}`);

    // V3: Each PROPERTY_ASSIGNMENT should have READS_FROM to a PARAMETER
    const params = ['graph', 'router', 'logger'];
    for (const paramName of params) {
      const param = allNodes.find(n => n.type === 'PARAMETER' && n.name === paramName);
      assert.ok(param, `PARAMETER "${paramName}" not found`);

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.dst === param.id &&
        propAssigns.some(pa => pa.id === e.src)
      );
      assert.ok(
        readsFrom,
        `Expected READS_FROM edge from PROPERTY_ASSIGNMENT to PARAMETER "${paramName}"`
      );
    }

    // V3: CLASS "Config" should have HAS_MEMBER to METHOD constructor
    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
    assert.ok(classNode, 'CLASS "Config" not found');

    const constructorMethod = allNodes.find(n =>
      n.type === 'METHOD' && n.name === 'constructor'
    );
    assert.ok(constructorMethod, 'METHOD "constructor" not found');

    const hasMember = allEdges.find(e =>
      e.type === 'HAS_MEMBER' &&
      e.src === classNode.id &&
      e.dst === constructorMethod.id
    );
    assert.ok(hasMember, 'Expected HAS_MEMBER edge from CLASS to constructor METHOD');
  });

  // ==========================================================================
  // Test 2: Single this.x = parameter in constructor
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT with READS_FROM to PARAMETER for single field', async () => {
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

    // V3: PROPERTY_ASSIGNMENT(this.dep) with READS_FROM to dep parameter
    const propAssign = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.dep'
    );
    assert.ok(propAssign, 'PROPERTY_ASSIGNMENT "this.dep" not found');

    const depParam = allNodes.find(n =>
      n.type === 'PARAMETER' && n.name === 'dep'
    );
    assert.ok(depParam, 'PARAMETER "dep" not found');

    const readsFrom = allEdges.find(e =>
      e.type === 'READS_FROM' &&
      e.src === propAssign.id &&
      e.dst === depParam.id
    );
    assert.ok(
      readsFrom,
      `Expected READS_FROM edge from PROPERTY_ASSIGNMENT to PARAMETER "dep". ` +
      `READS_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'READS_FROM'))}`
    );
  });

  // ==========================================================================
  // Test 3: this.x = local variable in method
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT with READS_FROM to VARIABLE in method', async () => {
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

    // V3: PROPERTY_ASSIGNMENT(this.helper) with READS_FROM to helper variable
    const propAssign = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.helper'
    );
    assert.ok(propAssign, 'PROPERTY_ASSIGNMENT "this.helper" not found');

    const helperVar = allNodes.find(n =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'helper'
    );
    assert.ok(helperVar, 'VARIABLE "helper" not found');

    const readsFrom = allEdges.find(e =>
      e.type === 'READS_FROM' &&
      e.src === propAssign.id &&
      e.dst === helperVar.id
    );
    assert.ok(
      readsFrom,
      `Expected READS_FROM edge from PROPERTY_ASSIGNMENT to VARIABLE "helper"`
    );

    // V3: PROPERTY_ACCESS(this.helper) should still exist as child of PROPERTY_ASSIGNMENT
    const propAccess = allNodes.find(n =>
      n.type === 'PROPERTY_ACCESS' && n.name === 'this.helper'
    );
    assert.ok(propAccess, 'PROPERTY_ACCESS node for this.helper not found');
  });

  // ==========================================================================
  // Test 4: this.x = literal -- PROPERTY_ASSIGNMENT created, no READS_FROM to variable
  // ==========================================================================
  it('should create PROPERTY_ASSIGNMENT node for literal value but no READS_FROM to variable', async () => {
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

    // V3: PROPERTY_ASSIGNMENT(this.port) should exist for the assignment
    const propAssign = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.port'
    );
    assert.ok(propAssign, 'PROPERTY_ASSIGNMENT "this.port" not found');

    // V3: No READS_FROM edge to a VARIABLE or PARAMETER (it reads from a LITERAL)
    const readsFromVar = allEdges.filter(e =>
      e.type === 'READS_FROM' && e.src === propAssign.id
    ).filter(e => {
      const dst = allNodes.find(n => n.id === e.dst);
      return dst && (dst.type === 'VARIABLE' || dst.type === 'PARAMETER');
    });

    assert.strictEqual(
      readsFromVar.length, 0,
      `Literal values should NOT produce READS_FROM to variables. Found: ${JSON.stringify(readsFromVar)}`
    );
  });

  // ==========================================================================
  // Test 5: this.x = value outside class -- PROPERTY_ASSIGNMENT still created
  // ==========================================================================
  it('should still create PROPERTY_ASSIGNMENT for this.x outside class (but no CLASS/HAS_MEMBER)', async () => {
    await setupTest(backend, {
      'index.js': `
function standalone(x) {
  this.x = x;
}
      `
    });

    const allNodes = await backend.getAllNodes();

    // V3: No CLASS node since this is outside class context
    const classNodes = allNodes.filter(n => n.type === 'CLASS');
    assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected outside class context');

    // V3: PROPERTY_ASSIGNMENT(this.x) and PROPERTY_ACCESS(this.x) still exist
    const propAssign = allNodes.find(n =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.x'
    );
    assert.ok(propAssign, 'PROPERTY_ASSIGNMENT "this.x" should exist even outside class');

    const propAccess = allNodes.find(n =>
      n.type === 'PROPERTY_ACCESS' && n.name === 'this.x'
    );
    assert.ok(propAccess, 'PROPERTY_ACCESS(this.x) should exist even outside class');
  });

  // ==========================================================================
  // Test 6: CLASS --HAS_MEMBER--> METHOD (replaces CLASS --CONTAINS--> PROPERTY_ASSIGNMENT)
  // ==========================================================================
  it('should create HAS_MEMBER edge from CLASS to METHOD (constructor)', async () => {
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

    // V3: CLASS "Foo"
    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
    assert.ok(classNode, 'CLASS "Foo" not found');

    // V3: METHOD "constructor"
    const constructorMethod = allNodes.find(n =>
      n.type === 'METHOD' && n.name === 'constructor'
    );
    assert.ok(constructorMethod, 'METHOD "constructor" not found');

    // V3: HAS_MEMBER edge from CLASS to METHOD
    const hasMember = allEdges.find(e =>
      e.type === 'HAS_MEMBER' &&
      e.src === classNode.id &&
      e.dst === constructorMethod.id
    );
    assert.ok(
      hasMember,
      `Expected HAS_MEMBER edge from CLASS "${classNode.id}" to METHOD "${constructorMethod.id}". ` +
      `HAS_MEMBER edges: ${JSON.stringify(allEdges.filter(e => e.type === 'HAS_MEMBER'))}`
    );
  });
});
