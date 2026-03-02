/**
 * Tests for Constructor Call Tracking (CALL nodes with isNew:true and ASSIGNED_FROM edges)
 *
 * REG-200: When code uses `new ClassName()`, we create:
 * - CALL node with: isNew=true, name="new ClassName", file, line, column
 * - ASSIGNED_FROM edge from the variable to the CALL node
 *
 * Edge direction: VARIABLE --ASSIGNED_FROM--> CALL(isNew:true)
 *
 * V2 migration: CONSTRUCTOR_CALL type no longer exists.
 * Constructor calls are represented as CALL nodes with isNew=true metadata.
 * The className is encoded in the name field as "new ClassName".
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
  const testDir = join(tmpdir(), `navi-test-constructor-call-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-constructor-call-${testCounter}`,
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

/**
 * V2 helper: find constructor call nodes (CALL with isNew:true)
 */
function findConstructorCalls(allNodes) {
  return allNodes.filter(n => n.type === 'CALL' && n.isNew === true);
}

/**
 * V2 helper: extract class name from "new ClassName" format
 */
function getClassName(callNode) {
  if (callNode.name && callNode.name.startsWith('new ')) {
    return callNode.name.slice(4); // strip "new " prefix
  }
  return callNode.name;
}

describe('Constructor Call Tracking', () => {
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

  // ============================================================================
  // Built-in constructors
  // ============================================================================
  describe('Built-in constructors', () => {
    it('should create CALL(isNew:true) node for new Date()', async () => {
      await setupTest(backend, {
        'index.js': `const date = new Date();`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const dateVar = allNodes.find(n =>
        n.name === 'date' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(dateVar, 'Variable "date" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === dateVar.id
      );
      assert.ok(
        assignment,
        `Variable "date" should have ASSIGNED_FROM edge. Found edges: ${JSON.stringify(allEdges.filter(e => e.src === dateVar.id))}`
      );

      // Find the source node - should be CALL with isNew:true
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(
        source.type, 'CALL',
        `Expected CALL, got ${source.type}`
      );
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      assert.strictEqual(getClassName(source), 'Date', `Expected name="new Date", got ${source.name}`);
      assert.ok(source.line !== undefined, 'CALL(isNew:true) should have line');
      assert.ok(source.column !== undefined, 'CALL(isNew:true) should have column');
    });

    it('should create CALL(isNew:true) node for new Map()', async () => {
      await setupTest(backend, {
        'index.js': `const cache = new Map();`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const cacheVar = allNodes.find(n =>
        n.name === 'cache' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(cacheVar, 'Variable "cache" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === cacheVar.id
      );
      assert.ok(assignment, 'Variable "cache" should have ASSIGNED_FROM edge');

      // Find the source node - should be CALL with isNew:true
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      assert.strictEqual(getClassName(source), 'Map', `Expected name="new Map", got ${source.name}`);
    });

    it('should recognize all standard built-in constructors', async () => {
      await setupTest(backend, {
        'index.js': `
const date = new Date();
const map = new Map();
const set = new Set();
const weakMap = new WeakMap();
const weakSet = new WeakSet();
const arr = new Array();
const obj = new Object();
const regexp = new RegExp('test');
const err = new Error('message');
const promise = new Promise((resolve) => resolve());
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find all constructor call nodes (CALL with isNew:true)
      const constructorCalls = findConstructorCalls(allNodes);

      const builtinClassNames = ['Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'RegExp', 'Error', 'Promise'];

      for (const className of builtinClassNames) {
        const node = constructorCalls.find(n => getClassName(n) === className);
        assert.ok(node, `CALL(isNew:true) node for ${className} not found. All constructor calls: ${JSON.stringify(constructorCalls.map(n => n.name))}`);
      }
    });
  });

  // ============================================================================
  // User-defined class constructors
  // ============================================================================
  describe('User-defined class constructors', () => {
    it('should create CALL(isNew:true) node for user-defined class', async () => {
      await setupTest(backend, {
        'index.js': `
class Database {}
const db = new Database();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const dbVar = allNodes.find(n =>
        n.name === 'db' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(dbVar, 'Variable "db" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === dbVar.id
      );
      assert.ok(assignment, 'Variable "db" should have ASSIGNED_FROM edge');

      // Find the source node - should be CALL with isNew:true
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      assert.strictEqual(getClassName(source), 'Database', `Expected name="new Database", got ${source.name}`);
    });

    it('should handle class with constructor parameters', async () => {
      await setupTest(backend, {
        'index.js': `
class HttpClient {
  constructor(config) {
    this.config = config;
  }
}
const config = { timeout: 5000 };
const client = new HttpClient(config);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the client variable
      const clientVar = allNodes.find(n =>
        n.name === 'client' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(clientVar, 'Variable "client" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === clientVar.id
      );
      assert.ok(assignment, 'Variable "client" should have ASSIGNED_FROM edge');

      // Find the source node
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      assert.strictEqual(getClassName(source), 'HttpClient', `Expected name="new HttpClient", got ${source.name}`);
    });
  });

  // ============================================================================
  // Multiple constructors in same file
  // ============================================================================
  describe('Multiple constructors in same file', () => {
    it('should create distinct CALL(isNew:true) nodes for multiple new expressions', async () => {
      await setupTest(backend, {
        'index.js': `
const d1 = new Date();
const d2 = new Date();
const m = new Map();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find all constructor call nodes
      const constructorCalls = findConstructorCalls(allNodes);

      assert.strictEqual(
        constructorCalls.length, 3,
        `Expected 3 CALL(isNew:true) nodes (d1, d2, m), got ${constructorCalls.length}. Nodes: ${JSON.stringify(constructorCalls.map(n => ({id: n.id, name: n.name})))}`
      );

      // Each should have different line/column
      const dateNodes = constructorCalls.filter(n => getClassName(n) === 'Date');
      const mapNodes = constructorCalls.filter(n => getClassName(n) === 'Map');

      assert.strictEqual(dateNodes.length, 2, 'Should have 2 Date constructor calls');
      assert.strictEqual(mapNodes.length, 1, 'Should have 1 Map constructor call');

      // The two Date nodes should have different positions
      assert.notDeepStrictEqual(
        { line: dateNodes[0].line, column: dateNodes[0].column },
        { line: dateNodes[1].line, column: dateNodes[1].column },
        'Two Date constructor calls should have different line/column'
      );

      // Verify all variables have ASSIGNED_FROM edges
      const d1Var = allNodes.find(n => n.name === 'd1');
      const d2Var = allNodes.find(n => n.name === 'd2');
      const mVar = allNodes.find(n => n.name === 'm');

      assert.ok(d1Var, 'Variable d1 not found');
      assert.ok(d2Var, 'Variable d2 not found');
      assert.ok(mVar, 'Variable m not found');

      for (const v of [d1Var, d2Var, mVar]) {
        const edge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);
        assert.ok(edge, `Variable "${v.name}" should have ASSIGNED_FROM edge`);
      }
    });
  });

  // ============================================================================
  // Data flow query
  // ============================================================================
  describe('Data flow query', () => {
    it('should allow tracing variable value source to CALL(isNew:true)', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { timeout: 5000 };
const client = new HttpClient(config);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the client variable
      const clientVar = allNodes.find(n =>
        n.name === 'client' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(clientVar, 'Variable "client" not found');

      // Trace value source via ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === clientVar.id
      );
      assert.ok(assignment, 'Should find ASSIGNED_FROM edge');

      const valueSource = allNodes.find(n => n.id === assignment.dst);
      assert.ok(valueSource, 'Should find value source node');
      assert.strictEqual(
        valueSource.type, 'CALL',
        `Value source should be CALL, got ${valueSource.type}`
      );
      assert.strictEqual(
        valueSource.isNew, true,
        'Value source should have isNew=true'
      );
      assert.strictEqual(
        getClassName(valueSource), 'HttpClient',
        `Value source name should contain HttpClient, got ${valueSource.name}`
      );
    });
  });

  // ============================================================================
  // CALL(isNew:true) node attributes
  // ============================================================================
  describe('CALL(isNew:true) node attributes', () => {
    it('should include file path in constructor call node', async () => {
      await setupTest(backend, {
        'index.js': `const date = new Date();`
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes)[0];
      assert.ok(constructorCall, 'CALL(isNew:true) node not found');
      assert.ok(constructorCall.file, 'CALL(isNew:true) should have file attribute');
      assert.ok(
        constructorCall.file.endsWith('index.js'),
        `File should end with index.js, got ${constructorCall.file}`
      );
    });

    it('should include correct line and column numbers', async () => {
      await setupTest(backend, {
        'index.js': `const date = new Date();`  // line 1, new starts at column ~14
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes)[0];
      assert.ok(constructorCall, 'CALL(isNew:true) node not found');
      assert.strictEqual(constructorCall.line, 1, 'Line should be 1');
      assert.ok(
        constructorCall.column >= 0,
        `Column should be non-negative, got ${constructorCall.column}`
      );
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================
  describe('Edge cases', () => {
    it('should handle new expression inside function', async () => {
      await setupTest(backend, {
        'index.js': `
function createCache() {
  const cache = new Map();
  return cache;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the cache variable inside function
      const cacheVar = allNodes.find(n =>
        n.name === 'cache' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(cacheVar, 'Variable "cache" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === cacheVar.id
      );
      assert.ok(assignment, 'Variable "cache" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
    });

    it('should handle new expression inside arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const factory = () => {
  const instance = new Set();
  return instance;
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the instance variable
      const instanceVar = allNodes.find(n =>
        n.name === 'instance' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(instanceVar, 'Variable "instance" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === instanceVar.id
      );
      assert.ok(assignment, 'Variable "instance" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      assert.strictEqual(getClassName(source), 'Set');
    });

    it('should handle new expression inside class method', async () => {
      await setupTest(backend, {
        'index.js': `
class Service {
  init() {
    const pool = new Map();
    return pool;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the pool variable
      const poolVar = allNodes.find(n =>
        n.name === 'pool' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(poolVar, 'Variable "pool" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === poolVar.id
      );
      assert.ok(assignment, 'Variable "pool" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
    });

    it('should handle new expression with member expression callee', async () => {
      // e.g., new module.ClassName()
      await setupTest(backend, {
        'index.js': `
const module = { Database: class {} };
const db = new module.Database();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the db variable
      const dbVar = allNodes.find(n =>
        n.name === 'db' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(dbVar, 'Variable "db" not found');

      // Should still have ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === dbVar.id
      );
      assert.ok(assignment, 'Variable "db" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'CALL', `Expected CALL, got ${source.type}`);
      assert.strictEqual(source.isNew, true, 'Should have isNew=true');
      // V2: member expression name is "new module.Database"
      assert.ok(
        source.name.includes('Database'),
        `Expected name to include Database, got ${source.name}`
      );
    });

    it('should handle chained new expression (assigned to temp)', async () => {
      // Pattern: const x = new A().method()
      // The new A() part should still create CALL(isNew:true) even if result is immediately used
      await setupTest(backend, {
        'index.js': `
class Builder {
  build() { return {}; }
}
const result = new Builder().build();
        `
      });

      const allNodes = await backend.getAllNodes();

      // CALL(isNew:true) node should exist for new Builder()
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Builder'
      );
      assert.ok(
        constructorCall,
        `CALL(isNew:true) node for Builder should exist. Nodes: ${JSON.stringify(findConstructorCalls(allNodes).map(n => n.name))}`
      );
    });
  });

  // ============================================================================
  // Integration with existing patterns
  // ============================================================================
  describe('Integration with existing patterns', () => {
    it('should coexist with LITERAL assignments', async () => {
      await setupTest(backend, {
        'index.js': `
const num = 42;
const date = new Date();
const str = "hello";
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // All three variables should have ASSIGNED_FROM edges
      for (const varName of ['num', 'date', 'str']) {
        const v = allNodes.find(n => n.name === varName);
        assert.ok(v, `Variable "${varName}" not found`);

        const edge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);
        assert.ok(edge, `Variable "${varName}" should have ASSIGNED_FROM edge`);
      }

      // Check source types
      const numVar = allNodes.find(n => n.name === 'num');
      const dateVar = allNodes.find(n => n.name === 'date');
      const strVar = allNodes.find(n => n.name === 'str');

      const numEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === numVar.id);
      const dateEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === dateVar.id);
      const strEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === strVar.id);

      const numSource = allNodes.find(n => n.id === numEdge.dst);
      const dateSource = allNodes.find(n => n.id === dateEdge.dst);
      const strSource = allNodes.find(n => n.id === strEdge.dst);

      assert.strictEqual(numSource.type, 'LITERAL', 'num source should be LITERAL');
      // V2: constructor calls are CALL with isNew:true
      assert.strictEqual(dateSource.type, 'CALL', 'date source should be CALL');
      assert.strictEqual(dateSource.isNew, true, 'date source should have isNew=true');
      assert.strictEqual(strSource.type, 'LITERAL', 'str source should be LITERAL');
    });

    it('should coexist with CALL assignments', async () => {
      await setupTest(backend, {
        'index.js': `
function create() { return {}; }
const obj = create();
const date = new Date();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj' && n.type !== 'FUNCTION');
      const dateVar = allNodes.find(n => n.name === 'date');

      assert.ok(objVar, 'Variable "obj" not found');
      assert.ok(dateVar, 'Variable "date" not found');

      const objEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === objVar.id);
      const dateEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === dateVar.id);

      assert.ok(objEdge, 'Variable "obj" should have ASSIGNED_FROM edge');
      assert.ok(dateEdge, 'Variable "date" should have ASSIGNED_FROM edge');

      const objSource = allNodes.find(n => n.id === objEdge.dst);
      const dateSource = allNodes.find(n => n.id === dateEdge.dst);

      assert.strictEqual(objSource.type, 'CALL', `obj source should be CALL, got ${objSource.type}`);
      // V2: both are CALL, but date has isNew=true
      assert.strictEqual(dateSource.type, 'CALL', `date source should be CALL, got ${dateSource.type}`);
      assert.strictEqual(dateSource.isNew, true, 'date source should have isNew=true');
    });
  });

  // ============================================================================
  // Constructor call node existence (V2: no CONTAINS edges to CALL nodes)
  // ============================================================================
  describe('Constructor call node existence', () => {
    it('should create CALL(isNew:true) node at module level', async () => {
      await setupTest(backend, {
        'index.js': `const x = new Foo();`
      });

      const allNodes = await backend.getAllNodes();

      // Find the CALL(isNew:true) node
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Foo not found');
      assert.ok(constructorCall.file.endsWith('index.js'), 'Should have correct file');
    });

    it('should create CALL(isNew:true) node inside function scope', async () => {
      await setupTest(backend, {
        'index.js': `
function f() {
  const x = new Foo();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the CALL(isNew:true) node
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Foo not found');
    });

    it('should create CALL(isNew:true) node for thrown constructor call', async () => {
      await setupTest(backend, {
        'index.js': `
function f() {
  throw new Error('something went wrong');
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CALL(isNew:true) node for Error
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Error'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Error not found');

      // This constructor call is NOT assigned to a variable -- no ASSIGNED_FROM edge expected
      const assignedFromEdge = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.dst === constructorCall.id
      );
      // Verify it has NO ASSIGNED_FROM (it's thrown, not assigned)
      assert.ok(
        !assignedFromEdge,
        'Thrown constructor call should NOT have ASSIGNED_FROM edge'
      );
    });

    it('should create CALL(isNew:true) node for constructor call passed as argument', async () => {
      await setupTest(backend, {
        'index.js': `
function f() {
  console.log(new Foo());
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the CALL(isNew:true) node for Foo
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Foo not found');
    });

    it('should create CALL(isNew:true) node for constructor call in return statement', async () => {
      await setupTest(backend, {
        'index.js': `
function f() {
  return new Foo();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find the CALL(isNew:true) node for Foo
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Foo not found');
    });
  });

  // ============================================================================
  // No INVOKES edges (as per simplified spec)
  // ============================================================================
  describe('No INVOKES edges', () => {
    it('should NOT create INVOKES edge from constructor call to CLASS', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {}
const instance = new MyClass();
        `
      });

      const allEdges = await backend.getAllEdges();

      // Find any INVOKES edges
      const invokesEdges = allEdges.filter(e => e.type === 'INVOKES');

      // According to simplified spec, no INVOKES edges should be created for constructor calls
      const constructorInvokes = invokesEdges.filter(e => {
        // V2: Check if edge is related to constructor call (CALL with "new" in name)
        return e.src?.includes('new ') || e.dst?.includes('new ');
      });

      assert.strictEqual(
        constructorInvokes.length, 0,
        `Should NOT create INVOKES edges for constructor calls. Found: ${JSON.stringify(constructorInvokes)}`
      );
    });
  });

  // ============================================================================
  // V2: Constructor calls are CALL(isNew:true) - no duplicates
  // ============================================================================
  describe('V2: Constructor calls are CALL(isNew:true)', () => {
    it('should produce CALL(isNew:true) for new Foo()', async () => {
      await setupTest(backend, {
        'index.js': `const x = new Foo();`
      });

      const allNodes = await backend.getAllNodes();

      // V2: constructor calls are CALL with isNew:true
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for Foo should exist');
    });

    it('should produce CALL(isNew:true) for module-level new expression', async () => {
      await setupTest(backend, {
        'index.js': `const x = new Foo();`
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) node for module-level new Foo() should exist');

      // Verify it has correct attributes
      assert.ok(constructorCall.file.endsWith('index.js'), `file should end with index.js, got ${constructorCall.file}`);
      assert.ok(constructorCall.line >= 1, `line should be >= 1, got ${constructorCall.line}`);
    });

    it('should produce exactly N CALL(isNew:true) nodes for N new expressions', async () => {
      await setupTest(backend, {
        'index.js': `
const a = new Date();
const b = new Map();
const c = new Set();
        `
      });

      const allNodes = await backend.getAllNodes();

      // Exactly 3 constructor call nodes
      const constructorCalls = findConstructorCalls(allNodes);
      assert.strictEqual(
        constructorCalls.length, 3,
        `Expected exactly 3 CALL(isNew:true) nodes, got ${constructorCalls.length}: ${JSON.stringify(constructorCalls.map(n => ({ id: n.id, name: n.name })))}`
      );
    });

    it('should produce CALL(isNew:true) with correct name for namespaced new ns.Foo()', async () => {
      await setupTest(backend, {
        'index.js': `
const ns = { Foo: class {} };
const x = new ns.Foo();
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: namespaced constructor has name "new ns.Foo"
      const constructorCall = findConstructorCalls(allNodes).find(n =>
        n.name.includes('Foo')
      );
      assert.ok(
        constructorCall,
        `CALL(isNew:true) with name containing 'Foo' should exist for new ns.Foo(). ` +
        `All constructor calls: ${JSON.stringify(findConstructorCalls(allNodes).map(n => n.name))}`
      );
    });

    it('should produce CALL(isNew:true) inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function createCache() {
  const cache = new Map();
  return cache;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Map'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) for Map inside function should exist');
    });

    it('should produce CALL(isNew:true) for thrown constructors', async () => {
      await setupTest(backend, {
        'index.js': `
function fail() {
  throw new Error('boom');
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Error'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) for thrown Error should exist');
    });

    it('should produce CALL(isNew:true) for constructor in return', async () => {
      await setupTest(backend, {
        'index.js': `
function create() {
  return new Foo();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) for returned Foo should exist');
    });

    it('should produce CALL(isNew:true) for constructor passed as argument', async () => {
      await setupTest(backend, {
        'index.js': `
function f() {
  console.log(new Foo());
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = findConstructorCalls(allNodes).find(n =>
        getClassName(n) === 'Foo'
      );
      assert.ok(constructorCall, 'CALL(isNew:true) for Foo passed as argument should exist');
    });
  });
});
