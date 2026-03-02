/**
 * Tests for property assignment tracking (REG-554, REG-573)
 *
 * When code does `this.prop = value` inside a class:
 * - PROPERTY_ASSIGNMENT node (name="this.prop") with ASSIGNED_FROM to source
 * - PROPERTY_ACCESS node (name="this.prop") as child via CONTAINS
 * - CLASS --HAS_MEMBER--> METHOD
 * - ASSIGNS_TO edge from PROPERTY_ASSIGNMENT to class PROPERTY (if declared)
 *
 * Non-this assignments (obj.prop = value):
 * - PROPERTY_ASSIGNMENT(obj.prop) with ASSIGNED_FROM to source
 * - PROPERTY_ACCESS(obj.prop) as child via CONTAINS
 * - No ASSIGNS_TO edge (no class context for non-this)
 *
 * Object literal properties:
 * - PROPERTY_ASSIGNMENT node for each property
 * - PROPERTY_KEY edge to LITERAL key node
 * - PROPERTY_VALUE edge to value expression
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

describe('PROPERTY_ASSIGNMENT nodes (REG-554, REG-573)', () => {
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
    it('should create PROPERTY_ASSIGNMENT and PROPERTY_ACCESS for this.bar = x in constructor', async () => {
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

      // PROPERTY_ASSIGNMENT with name="this.bar"
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="this.bar" not found');

      // PROPERTY_ACCESS(this.bar) should still exist as child of PROPERTY_ASSIGNMENT
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.bar'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node with name="this.bar" not found');
    });

    it('should create data flow edge from PROPERTY_ASSIGNMENT to RHS', async () => {
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
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT not found');

      // For simple Identifier RHS, visitIdentifier creates scope_lookup READS_FROM
      // (not ASSIGNED_FROM, because Identifier produces no graph node for edge-map to fire)
      const xParam = allNodes.find(n =>
        n.name === 'x' && n.type === 'PARAMETER'
      );
      assert.ok(xParam, 'PARAMETER "x" not found');

      const dataFlow = allEdges.find(e =>
        (e.type === 'READS_FROM' || e.type === 'ASSIGNED_FROM') &&
        e.src === propAssign.id &&
        e.dst === xParam.id
      );
      assert.ok(
        dataFlow,
        `Expected READS_FROM or ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT to PARAMETER. ` +
        `Found edges from PROPERTY_ASSIGNMENT: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => e.type))}`
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

      const constructorMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

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
    it('should create PROPERTY_ASSIGNMENT with ASSIGNED_FROM for options.graph!', async () => {
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

      // PROPERTY_ASSIGNMENT for this.graph
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.graph'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node with name="this.graph" not found');

      // PROPERTY_ASSIGNMENT should have ASSIGNED_FROM edge
      const assignedFrom = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === propAssign.id
      );
      assert.ok(
        assignedFrom,
        `Expected ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT. ` +
        `Found edges from PROPERTY_ASSIGNMENT: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => e.type))}`
      );
    });
  });

  // ==========================================================================
  // Group 3: 3-field constructor (AC3)
  // ==========================================================================
  describe('3-field constructor (AC3)', () => {
    it('should create 3 PROPERTY_ASSIGNMENT nodes', async () => {
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

      // 3 PROPERTY_ASSIGNMENT nodes for this.host, this.port, this.name
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' &&
        (n.name === 'this.host' || n.name === 'this.port' || n.name === 'this.name')
      );
      assert.strictEqual(
        propAssigns.length, 3,
        `Expected 3 PROPERTY_ASSIGNMENT nodes, got ${propAssigns.length}`
      );

      // 3 PROPERTY_ACCESS nodes for config.host, config.port, config.name (RHS)
      const configAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' &&
        (n.name === 'config.host' || n.name === 'config.port' || n.name === 'config.name')
      );
      assert.ok(configAccesses.length >= 3, `Expected at least 3 config.* PROPERTY_ACCESS nodes, got ${configAccesses.length}`);

      // CLASS should have HAS_MEMBER to constructor
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
  // Group 4: LITERAL RHS -- PROPERTY_ASSIGNMENT with ASSIGNED_FROM to LITERAL
  // ==========================================================================
  describe('LITERAL RHS', () => {
    it('should create PROPERTY_ASSIGNMENT with ASSIGNED_FROM to LITERAL for this.count = 0', async () => {
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

      // PROPERTY_ASSIGNMENT(this.count) should exist
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.count'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.count) not found');

      // CLASS should have HAS_MEMBER to constructor
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Counter');
      assert.ok(classNode, 'CLASS "Counter" not found');

      // ASSIGNED_FROM should point to a LITERAL (0), not a VARIABLE
      const assignedFrom = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === propAssign.id
      );
      assert.ok(assignedFrom, 'Expected ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT');

      const dst = allNodes.find(n => n.id === assignedFrom.dst);
      assert.ok(dst, 'ASSIGNED_FROM destination node not found');
      assert.strictEqual(dst.type, 'LITERAL', `Expected LITERAL target, got ${dst.type}`);
    });
  });

  // ==========================================================================
  // Group 5: Non-this assignment NOT indexed as class property
  // ==========================================================================
  describe('Non-this assignment NOT indexed', () => {
    it('should create PROPERTY_ASSIGNMENT for obj.x = value (no CLASS involvement)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.x = 5;
        `
      });

      const allNodes = await backend.getAllNodes();

      // No CLASS nodes
      const classNodes = allNodes.filter(n => n.type === 'CLASS');
      assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected');

      // PROPERTY_ASSIGNMENT(obj.x) should exist
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'obj.x'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(obj.x) should exist for obj.x = 5');

      // PROPERTY_ACCESS(obj.x) should still exist as child
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'obj.x'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS(obj.x) should exist as child');
    });

    it('should create PROPERTY_ASSIGNMENT with data flow for non-this variable assignment', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const handler = () => {};
obj.handler = handler;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // PROPERTY_ASSIGNMENT(obj.handler) exists
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'obj.handler'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(obj.handler) not found');

      // Data flow edge to handler (READS_FROM for Identifier RHS via scope_lookup)
      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(handlerVar, 'Variable "handler" not found');

      const dataFlow = allEdges.find(e =>
        (e.type === 'READS_FROM' || e.type === 'ASSIGNED_FROM') &&
        e.src === propAssign.id &&
        e.dst === handlerVar.id
      );
      assert.ok(dataFlow, 'Expected data flow edge from PROPERTY_ASSIGNMENT to handler');

      // PROPERTY_ACCESS(obj.handler) still exists as child
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'obj.handler'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS(obj.handler) not found');

      // PROPERTY_ACCESS(obj.handler) should have READS_FROM to obj
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

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
    it('should create distinct PROPERTY_ASSIGNMENT nodes for same property in different classes', async () => {
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

      // Two PROPERTY_ASSIGNMENT(this.x) nodes on different lines
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.x'
      );
      assert.strictEqual(
        propAssigns.length, 2,
        `Expected 2 PROPERTY_ASSIGNMENT nodes for "this.x", got ${propAssigns.length}`
      );

      // Distinct IDs (uses line numbers for disambiguation)
      assert.notStrictEqual(
        propAssigns[0].id,
        propAssigns[1].id,
        'Two PROPERTY_ASSIGNMENT nodes for "this.x" in different classes should have distinct IDs'
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
    it('should create PROPERTY_ASSIGNMENT but no CLASS context for module-level this.x', async () => {
      await setupTest(backend, {
        'index.js': `
this.globalProp = 'value';
        `
      });

      const allNodes = await backend.getAllNodes();

      // No CLASS nodes
      const classNodes = allNodes.filter(n => n.type === 'CLASS');
      assert.strictEqual(classNodes.length, 0, 'No CLASS nodes expected for module-level this.x');

      // PROPERTY_ASSIGNMENT(this.globalProp) should exist
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.globalProp'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.globalProp) should exist even at module level');

      // No classId (module level) — metadata is flattened to top-level by RFDB
      assert.ok(
        !propAssign.classId,
        'Module-level this.x should NOT have classId'
      );
    });
  });

  // ==========================================================================
  // Group 8: Multiple assignments to same property -- distinct IDs
  // ==========================================================================
  describe('Multiple assignments to same property', () => {
    it('should create distinct PROPERTY_ASSIGNMENT nodes for same property in different methods', async () => {
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

      // Two PROPERTY_ASSIGNMENT(this.x) nodes on different lines
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.x'
      );
      assert.strictEqual(
        propAssigns.length, 2,
        `Expected 2 PROPERTY_ASSIGNMENT nodes for "this.x", got ${propAssigns.length}`
      );

      // Distinct IDs
      assert.notStrictEqual(
        propAssigns[0].id,
        propAssigns[1].id,
        'Two PROPERTY_ASSIGNMENT nodes for "this.x" in different methods should have distinct IDs'
      );

      // CLASS Foo should have HAS_MEMBER edges to both methods
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Foo');
      assert.ok(classNode, 'CLASS "Foo" not found');

      const hasMemberEdges = allEdges.filter(e =>
        e.type === 'HAS_MEMBER' && e.src === classNode.id
      );
      assert.ok(hasMemberEdges.length >= 2, `Expected at least 2 HAS_MEMBER edges from CLASS, got ${hasMemberEdges.length}`);
    });
  });

  // ==========================================================================
  // Group 9: ASSIGNS_TO edge for this.prop = value when class field exists
  // ==========================================================================
  describe('ASSIGNS_TO edge resolution', () => {
    it('should create ASSIGNS_TO edge when class field is declared', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  bar;
  constructor(x) {
    this.bar = x;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // PROPERTY_ASSIGNMENT(this.bar)
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.bar) not found');

      // Class PROPERTY(bar)
      const classProp = allNodes.find(n =>
        n.type === 'PROPERTY' && n.name === 'bar'
      );
      assert.ok(classProp, 'PROPERTY(bar) not found');

      // ASSIGNS_TO edge from PROPERTY_ASSIGNMENT to PROPERTY
      const assignsTo = allEdges.find(e =>
        e.type === 'ASSIGNS_TO' &&
        e.src === propAssign.id &&
        e.dst === classProp.id
      );
      assert.ok(
        assignsTo,
        `Expected ASSIGNS_TO edge from PROPERTY_ASSIGNMENT to PROPERTY. ` +
        `Found edges from PA: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => e.type))}`
      );
    });

    it('should NOT create ASSIGNS_TO when class field is not declared', async () => {
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
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.bar) not found');

      // No ASSIGNS_TO edge (no class field declaration)
      const assignsTo = allEdges.find(e =>
        e.type === 'ASSIGNS_TO' && e.src === propAssign.id
      );
      assert.ok(
        !assignsTo,
        `ASSIGNS_TO should NOT exist when class field is not declared. Found: ${JSON.stringify(assignsTo)}`
      );
    });

    it('should NOT create ASSIGNS_TO for obj.prop = value (non-this)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.x = 5;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'obj.x'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(obj.x) not found');

      const assignsTo = allEdges.find(e =>
        e.type === 'ASSIGNS_TO' && e.src === propAssign.id
      );
      assert.ok(!assignsTo, 'ASSIGNS_TO should NOT exist for non-this assignments');
    });
  });

  // ==========================================================================
  // Group 10: Compound assignment (this.prop += value)
  // ==========================================================================
  describe('Compound assignment', () => {
    it('should create PROPERTY_ASSIGNMENT for this.prop += value', async () => {
      await setupTest(backend, {
        'index.js': `
class Counter {
  increment(n) {
    this.count += n;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.count'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.count) not found for compound assignment');
      // Metadata is flattened to top-level by RFDB
      assert.strictEqual(propAssign.operator, '+=', 'Expected += operator');
    });
  });

  // ============================================================================
  // Chained member expressions (a.b.c = value)
  // ============================================================================
  describe('Chained member expressions', () => {
    it('should extract full dotted path for a.b.c = value', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { db: { host: '' } };
config.db.host = 'localhost';
`
      });

      const allNodes = await backend.getAllNodes();
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'config.db.host'
      );
      assert.ok(
        propAssign,
        `PROPERTY_ASSIGNMENT(config.db.host) not found. ` +
        `PA nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT').map(n => n.name))}`
      );
      assert.strictEqual(propAssign.objectName, 'config.db');
      assert.strictEqual(propAssign.property, 'host');
    });

    it('should extract path for this.state.value = x in class', async () => {
      await setupTest(backend, {
        'index.js': `
class Widget {
  update(v) {
    this.state.value = v;
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.state.value'
      );
      assert.ok(
        propAssign,
        `PROPERTY_ASSIGNMENT(this.state.value) not found. ` +
        `PA nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT').map(n => n.name))}`
      );
      assert.strictEqual(propAssign.objectName, 'this.state');
      assert.strictEqual(propAssign.property, 'value');
    });
  });

  // ============================================================================
  // WRITES_TO edge from PROPERTY_ASSIGNMENT to root variable
  // ============================================================================
  describe('WRITES_TO edge to root variable', () => {
    it('should create WRITES_TO from obj.bar = value to variable obj', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { bar: 0 };
obj.bar = 42;
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'obj.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(obj.bar) not found');

      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === propAssign.id && e.dst === objVar.id
      );
      assert.ok(
        writesTo,
        `WRITES_TO edge from PROPERTY_ASSIGNMENT(obj.bar) to VARIABLE(obj) not found. ` +
        `Edges from PA: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => ({ type: e.type, dst: e.dst })))}`
      );
    });

    it('should create WRITES_TO from a.b.c = value to root variable a', async () => {
      await setupTest(backend, {
        'index.js': `
const a = { b: { c: 0 } };
a.b.c = 99;
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'a.b.c'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(a.b.c) not found');

      const aVar = allNodes.find(n =>
        n.name === 'a' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(aVar, 'Variable "a" not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === propAssign.id && e.dst === aVar.id
      );
      assert.ok(
        writesTo,
        `WRITES_TO edge from PROPERTY_ASSIGNMENT(a.b.c) to VARIABLE(a) not found`
      );
    });

    it('should NOT create WRITES_TO for this.prop = value (this is not a variable)', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  bar;
  set(v) { this.bar = v; }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.bar'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(this.bar) not found');

      const writesTo = allEdges.find(e =>
        e.type === 'WRITES_TO' && e.src === propAssign.id
      );
      assert.ok(
        !writesTo,
        `WRITES_TO should NOT exist for this.bar (this is not a variable). ` +
        `Found: ${JSON.stringify(writesTo)}`
      );
    });
  });

  // ==========================================================================
  // Group 11: Object literal PROPERTY_VALUE with Identifier value (REG-598)
  // ==========================================================================
  describe('Object literal PROPERTY_VALUE with Identifier value (REG-598)', () => {
    it('should create PROPERTY_VALUE edge for { name: userName }', async () => {
      await setupTest(backend, {
        'index.js': `
const userName = 'Alice';
const obj = { name: userName };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'name'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(name) not found');

      const userNameVar = allNodes.find(n =>
        n.name === 'userName' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(userNameVar, 'Variable "userName" not found');

      const propValue = allEdges.find(e =>
        e.type === 'PROPERTY_VALUE' &&
        e.src === propAssign.id &&
        e.dst === userNameVar.id
      );
      assert.ok(
        propValue,
        `Expected PROPERTY_VALUE edge from PROPERTY_ASSIGNMENT(name) to VARIABLE(userName). ` +
        `Found edges from PA: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => ({ type: e.type, dst: e.dst })))}`
      );
    });

    it('should NOT create READS_FROM for non-shorthand Identifier value', async () => {
      await setupTest(backend, {
        'index.js': `
const userName = 'Alice';
const obj = { name: userName };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'name'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(name) not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' && e.src === propAssign.id
      );
      assert.ok(
        !readsFrom,
        `Non-shorthand { name: userName } should produce PROPERTY_VALUE, not READS_FROM. ` +
        `Found: ${JSON.stringify(readsFrom)}`
      );
    });

    it('should still produce READS_FROM for shorthand { x } (regression)', async () => {
      await setupTest(backend, {
        'index.js': `
const x = 42;
const obj = { x };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'x'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(x) not found');

      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(xVar, 'Variable "x" not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === xVar.id
      );
      assert.ok(
        readsFrom,
        `Shorthand { x } should produce READS_FROM, not PROPERTY_VALUE. ` +
        `Found edges from PA: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => ({ type: e.type, dst: e.dst })))}`
      );
    });

    it('should still produce PROPERTY_VALUE for literal values via edge-map', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { key: "literal" };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'key'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(key) not found');

      const literalNode = allNodes.find(n =>
        n.type === 'LITERAL' && n.name === 'literal'
      );
      assert.ok(literalNode, 'LITERAL("literal") not found');

      const propValue = allEdges.find(e =>
        e.type === 'PROPERTY_VALUE' &&
        e.src === propAssign.id &&
        e.dst === literalNode.id
      );
      assert.ok(
        propValue,
        `Expected PROPERTY_VALUE edge from PROPERTY_ASSIGNMENT(key) to LITERAL. ` +
        `Found edges from PA: ${JSON.stringify(allEdges.filter(e => e.src === propAssign.id).map(e => ({ type: e.type, dst: e.dst })))}`
      );
    });
  });
});
