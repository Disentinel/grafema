/**
 * Tests for property assignment tracking (REG-554)
 *
 * V2 model: When code does `this.prop = value` inside a class:
 * - EXPRESSION node (name="=") with READS_FROM to source (VARIABLE, PARAMETER)
 * - PROPERTY_ACCESS node (name="this.prop")
 * - CLASS --HAS_MEMBER--> METHOD
 * - No PROPERTY_ASSIGNMENT node type in v2
 * - No CLASS --CONTAINS--> assignment edge
 * - No ASSIGNED_FROM edge from assignment nodes
 *
 * Non-this assignments (obj.prop = value):
 * - EXPRESSION(=) with READS_FROM to source
 * - PROPERTY_ACCESS(obj.prop) with READS_FROM to object variable
 * - No FLOWS_INTO edges in v2
 *
 * Originally tested PROPERTY_ASSIGNMENT nodes. Updated for v2 EXPRESSION model.
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

describe('PROPERTY_ASSIGNMENT nodes (REG-554) - v2 migration', () => {
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
  // V2: EXPRESSION(=) + PROPERTY_ACCESS(this.bar) + READS_FROM to parameter
  // ==========================================================================
  describe('Basic this.x = variable', () => {
    it('should create EXPRESSION and PROPERTY_ACCESS for this.bar = x in constructor', async () => {
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

      // V2: PROPERTY_ACCESS with name="this.bar"
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.bar'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node with name="this.bar" not found');

      // V2: EXPRESSION(=) should exist
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) node not found');
    });

    it('should create READS_FROM edge from EXPRESSION to parameter', async () => {
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

      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) not found');

      // Find the x parameter
      const xParam = allNodes.find(n =>
        n.name === 'x' && n.type === 'PARAMETER'
      );
      assert.ok(xParam, 'PARAMETER "x" not found');

      // V2: EXPRESSION --READS_FROM--> PARAMETER
      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === xParam.id
      );
      assert.ok(
        readsFrom,
        `Expected READS_FROM edge from EXPRESSION "${assignExpr.id}" to PARAMETER "${xParam.id}". ` +
        `Found READS_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'READS_FROM'))}`
      );
    });

    it('should create CLASS --HAS_MEMBER--> METHOD edge', async () => {
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

      // V2: METHOD "constructor" (not FUNCTION)
      const constructorMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

      // V2: CLASS --HAS_MEMBER--> METHOD
      const hasMember = allEdges.find(e =>
        e.type === 'HAS_MEMBER' &&
        e.src === classNode.id &&
        e.dst === constructorMethod.id
      );
      assert.ok(
        hasMember,
        `Expected HAS_MEMBER edge from CLASS "${classNode.id}" to METHOD "${constructorMethod.id}". ` +
        `Found HAS_MEMBER edges: ${JSON.stringify(allEdges.filter(e => e.type === 'HAS_MEMBER'))}`
      );
    });
  });

  // ==========================================================================
  // Group 2: TSNonNullExpression wrapping MemberExpression
  // ==========================================================================
  describe('TSNonNullExpression wrapping MemberExpression', () => {
    it('should create EXPRESSION with READS_FROM to source for options.graph!', async () => {
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

      // V2: PROPERTY_ACCESS for this.graph
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.graph'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node with name="this.graph" not found');

      // V2: EXPRESSION(=) should exist
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) not found');

      // V2: EXPRESSION(=) should have ASSIGNED_FROM to the TSNonNullExpression wrapper
      // The chain is: EXPRESSION(=) --ASSIGNED_FROM--> EXPRESSION(?!) for TSNonNull
      const assignmentEdges = allEdges.filter(e =>
        (e.type === 'READS_FROM' || e.type === 'ASSIGNED_FROM') && e.src === assignExpr.id
      );
      assert.ok(
        assignmentEdges.length > 0,
        `Expected at least one READS_FROM or ASSIGNED_FROM edge from EXPRESSION. ` +
        `Found edges from EXPRESSION: ${JSON.stringify(allEdges.filter(e => e.src === assignExpr.id))}`
      );
    });
  });

  // ==========================================================================
  // Group 3: 3-field constructor (AC3)
  // ==========================================================================
  describe('3-field constructor (AC3)', () => {
    it('should create 3 EXPRESSION nodes with READS_FROM edges', async () => {
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

      // V2: 3 EXPRESSION(=) nodes
      const assignExprs = allNodes.filter(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.strictEqual(
        assignExprs.length, 3,
        `Expected 3 EXPRESSION(=) nodes, got ${assignExprs.length}`
      );

      // V2: 3 PROPERTY_ACCESS nodes for this.host, this.port, this.name
      const propAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' &&
        (n.name === 'this.host' || n.name === 'this.port' || n.name === 'this.name')
      );
      assert.strictEqual(propAccesses.length, 3, `Expected 3 this.* PROPERTY_ACCESS nodes, got ${propAccesses.length}`);

      // V2: 3 PROPERTY_ACCESS nodes for config.host, config.port, config.name
      const configAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' &&
        (n.name === 'config.host' || n.name === 'config.port' || n.name === 'config.name')
      );
      // These are the RHS of the assignments: each EXPRESSION reads from a config.X
      assert.ok(configAccesses.length >= 3, `Expected at least 3 config.* PROPERTY_ACCESS nodes, got ${configAccesses.length}`);

      // V2: CLASS should have HAS_MEMBER to constructor
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Server');
      assert.ok(classNode, 'CLASS "Server" not found');

      const constructorMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

      const hasMember = allEdges.find(e =>
        e.type === 'HAS_MEMBER' && e.src === classNode.id && e.dst === constructorMethod.id
      );
      assert.ok(hasMember, 'Expected HAS_MEMBER from CLASS to constructor METHOD');
    });
  });

  // ==========================================================================
  // Group 4: LITERAL RHS -- EXPRESSION created, no READS_FROM to variable
  // ==========================================================================
  describe('LITERAL RHS', () => {
    it('should create EXPRESSION node with no READS_FROM to variable for literal', async () => {
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

      // V2: EXPRESSION(=) should exist
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) not found');

      // V2: CLASS should have HAS_MEMBER to constructor
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Counter');
      assert.ok(classNode, 'CLASS "Counter" not found');

      // V2: No READS_FROM to VARIABLE or PARAMETER
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
  });

  // ==========================================================================
  // Group 5: Non-this assignment NOT indexed as class property
  // ==========================================================================
  describe('Non-this assignment NOT indexed', () => {
    it('should create EXPRESSION for obj.x = value (no CLASS involvement)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.x = 5;
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: No CLASS nodes
      const classNodes = allNodes.filter(n => n.type === 'CLASS');
      assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected');

      // V2: EXPRESSION(=) and PROPERTY_ACCESS(obj.x) still created
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) should exist for obj.x = 5');

      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'obj.x'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS(obj.x) should exist');
    });

    it('should create EXPRESSION with READS_FROM for non-this variable assignment', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const handler = () => {};
obj.handler = handler;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: EXPRESSION(=) with READS_FROM to handler
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION(=) not found');

      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(handlerVar, 'Variable "handler" not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === handlerVar.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from EXPRESSION to handler');

      // V2: PROPERTY_ACCESS(obj.handler) with READS_FROM to obj
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'obj.handler'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS(obj.handler) not found');

      const readsObj = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAccess.id &&
        e.dst === objVar.id
      );
      assert.ok(readsObj, 'Expected READS_FROM from PROPERTY_ACCESS to obj');
    });
  });

  // ==========================================================================
  // Group 6: Semantic ID uniqueness -- same property name, different classes
  // ==========================================================================
  describe('Semantic ID uniqueness', () => {
    it('should create distinct EXPRESSION and PROPERTY_ACCESS nodes for same property in different classes', async () => {
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

      // V2: Two PROPERTY_ACCESS(this.x) nodes on different lines
      const propAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.x'
      );
      assert.strictEqual(
        propAccesses.length, 2,
        `Expected 2 PROPERTY_ACCESS nodes for "this.x", got ${propAccesses.length}`
      );

      // Distinct IDs (v2 uses line numbers for disambiguation)
      assert.notStrictEqual(
        propAccesses[0].id,
        propAccesses[1].id,
        'Two PROPERTY_ACCESS nodes for "this.x" in different classes should have distinct IDs'
      );

      // Two CLASS nodes: A and B
      const classNames = allNodes.filter(n => n.type === 'CLASS').map(n => n.name).sort();
      assert.deepStrictEqual(classNames, ['A', 'B'], 'Should have classes A and B');
    });
  });

  // ==========================================================================
  // Group 7: Module-level this.x = value
  // ==========================================================================
  describe('Module-level this.x = value', () => {
    it('should create EXPRESSION but no CLASS context for module-level this.x', async () => {
      await setupTest(backend, {
        'index.js': `
this.globalProp = 'value';
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: No CLASS nodes
      const classNodes = allNodes.filter(n => n.type === 'CLASS');
      assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected for module-level this.x');

      // V2: PROPERTY_ACCESS(this.globalProp) should still exist
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.globalProp'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS(this.globalProp) should exist even at module level');
    });
  });

  // ==========================================================================
  // Group 8: Multiple assignments to same property -- distinct IDs
  // ==========================================================================
  describe('Multiple assignments to same property', () => {
    it('should create distinct EXPRESSION and PROPERTY_ACCESS nodes for same property in different methods', async () => {
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

      // V2: Two PROPERTY_ACCESS(this.x) nodes on different lines
      const propAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.x'
      );
      assert.strictEqual(
        propAccesses.length, 2,
        `Expected 2 PROPERTY_ACCESS nodes for "this.x", got ${propAccesses.length}`
      );

      // Distinct IDs
      assert.notStrictEqual(
        propAccesses[0].id,
        propAccesses[1].id,
        'Two PROPERTY_ACCESS nodes for "this.x" in different methods should have distinct IDs'
      );

      // V2: Two EXPRESSION(=) nodes
      const assignExprs = allNodes.filter(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.strictEqual(assignExprs.length, 2, `Expected 2 EXPRESSION(=) nodes, got ${assignExprs.length}`);

      // V2: CLASS Foo should have HAS_MEMBER edges to both methods
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
      assert.ok(classNode, 'CLASS "Foo" not found');

      const hasMemberEdges = allEdges.filter(e =>
        e.type === 'HAS_MEMBER' && e.src === classNode.id
      );
      assert.ok(hasMemberEdges.length >= 2, `Expected at least 2 HAS_MEMBER edges from CLASS, got ${hasMemberEdges.length}`);
    });
  });
});
