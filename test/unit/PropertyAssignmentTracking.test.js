/**
 * Property Assignment Tracking Tests (REG-554)
 *
 * V2 model: When `this.x = value` occurs inside a class method/constructor:
 * - EXPRESSION node (name="=") with READS_FROM edge to the source (parameter/variable)
 * - PROPERTY_ACCESS node (name="this.x")
 * - CLASS --HAS_MEMBER--> METHOD
 * - No PROPERTY_ASSIGNMENT node type in v2
 * - No CONTAINS edge from CLASS to assignment
 * - No ASSIGNED_FROM edge from assignment node
 *
 * Originally tested PROPERTY_ASSIGNMENT nodes with CONTAINS and ASSIGNED_FROM.
 * Updated for v2 EXPRESSION + PROPERTY_ACCESS model.
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
  // V2: 3 EXPRESSION(=) nodes with READS_FROM to each parameter
  // ==========================================================================
  it('should create EXPRESSION nodes with READS_FROM for each this.x = param in constructor', async () => {
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

    // V2: EXPRESSION(=) nodes for each assignment
    const assignExprs = allNodes.filter(n =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.strictEqual(
      assignExprs.length, 3,
      `Expected 3 EXPRESSION(=) nodes, got ${assignExprs.length}. ` +
      `All node types: ${JSON.stringify([...new Set(allNodes.map(n => n.type))])}`
    );

    // V2: PROPERTY_ACCESS nodes for this.graph, this.router, this.logger
    const propAccesses = allNodes.filter(n =>
      n.type === 'PROPERTY_ACCESS' &&
      (n.name === 'this.graph' || n.name === 'this.router' || n.name === 'this.logger')
    );
    assert.strictEqual(propAccesses.length, 3, `Expected 3 PROPERTY_ACCESS nodes for this.*, got ${propAccesses.length}`);

    // V2: Each EXPRESSION should have READS_FROM to a PARAMETER
    const params = ['graph', 'router', 'logger'];
    for (const paramName of params) {
      const param = allNodes.find(n => n.type === 'PARAMETER' && n.name === paramName);
      assert.ok(param, `PARAMETER "${paramName}" not found`);

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.dst === param.id &&
        assignExprs.some(expr => expr.id === e.src)
      );
      assert.ok(
        readsFrom,
        `Expected READS_FROM edge from EXPRESSION to PARAMETER "${paramName}"`
      );
    }

    // V2: CLASS "Config" should have HAS_MEMBER to METHOD constructor
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
  it('should create EXPRESSION with READS_FROM to PARAMETER for single field', async () => {
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

    // V2: EXPRESSION(=) with READS_FROM to dep parameter
    const assignExpr = allNodes.find(n =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.ok(assignExpr, 'EXPRESSION(=) not found');

    const depParam = allNodes.find(n =>
      n.type === 'PARAMETER' && n.name === 'dep'
    );
    assert.ok(depParam, 'PARAMETER "dep" not found');

    const readsFrom = allEdges.find(e =>
      e.type === 'READS_FROM' &&
      e.src === assignExpr.id &&
      e.dst === depParam.id
    );
    assert.ok(
      readsFrom,
      `Expected READS_FROM edge from EXPRESSION to PARAMETER "dep". ` +
      `READS_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'READS_FROM'))}`
    );
  });

  // ==========================================================================
  // Test 3: this.x = local variable in method
  // ==========================================================================
  it('should create EXPRESSION with READS_FROM to VARIABLE in method', async () => {
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

    // V2: EXPRESSION(=) with READS_FROM to helper variable
    const assignExpr = allNodes.find(n =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.ok(assignExpr, 'EXPRESSION(=) not found');

    const helperVar = allNodes.find(n =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'helper'
    );
    assert.ok(helperVar, 'VARIABLE "helper" not found');

    const readsFrom = allEdges.find(e =>
      e.type === 'READS_FROM' &&
      e.src === assignExpr.id &&
      e.dst === helperVar.id
    );
    assert.ok(
      readsFrom,
      `Expected READS_FROM edge from EXPRESSION to VARIABLE "helper"`
    );

    // V2: PROPERTY_ACCESS(this.helper) should exist
    const propAccess = allNodes.find(n =>
      n.type === 'PROPERTY_ACCESS' && n.name === 'this.helper'
    );
    assert.ok(propAccess, 'PROPERTY_ACCESS node for this.helper not found');
  });

  // ==========================================================================
  // Test 4: this.x = literal -- EXPRESSION created, no READS_FROM to variable
  // ==========================================================================
  it('should create EXPRESSION node for literal value but no READS_FROM to variable', async () => {
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

    // V2: EXPRESSION(=) should exist for the assignment
    const assignExpr = allNodes.find(n =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.ok(assignExpr, 'EXPRESSION(=) not found');

    // V2: No READS_FROM edge to a VARIABLE or PARAMETER (it reads from a LITERAL)
    const readsFromVar = allEdges.filter(e =>
      e.type === 'READS_FROM' && e.src === assignExpr.id
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
  // Test 5: this.x = value outside class -- EXPRESSION still created
  // ==========================================================================
  it('should still create EXPRESSION for this.x outside class (but no CLASS/HAS_MEMBER)', async () => {
    await setupTest(backend, {
      'index.js': `
function standalone(x) {
  this.x = x;
}
      `
    });

    const allNodes = await backend.getAllNodes();

    // V2: No CLASS node since this is outside class context
    const classNodes = allNodes.filter(n => n.type === 'CLASS');
    assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected outside class context');

    // V2: EXPRESSION(=) and PROPERTY_ACCESS(this.x) still exist
    const assignExpr = allNodes.find(n =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.ok(assignExpr, 'EXPRESSION(=) should exist even outside class');

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

    // V2: CLASS "Foo"
    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
    assert.ok(classNode, 'CLASS "Foo" not found');

    // V2: METHOD "constructor"
    const constructorMethod = allNodes.find(n =>
      n.type === 'METHOD' && n.name === 'constructor'
    );
    assert.ok(constructorMethod, 'METHOD "constructor" not found');

    // V2: HAS_MEMBER edge from CLASS to METHOD
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
