/**
 * Tests for Constructor Call Tracking (CONSTRUCTOR_CALL nodes and ASSIGNED_FROM edges)
 *
 * REG-200: When code uses `new ClassName()`, we create:
 * - CONSTRUCTOR_CALL node with: className, isBuiltin, file, line, column
 * - ASSIGNED_FROM edge from the variable to the CONSTRUCTOR_CALL node
 *
 * Edge direction: VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
 *
 * Built-in constructors (Date, Map, Set, WeakMap, WeakSet, Array, etc.)
 * have isBuiltin=true. User-defined classes have isBuiltin=false.
 *
 * This is the TDD test file for REG-200. Tests are written BEFORE implementation,
 * so they should be RED initially.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
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

describe('Constructor Call Tracking', () => {
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

  // ============================================================================
  // Built-in constructors
  // ============================================================================
  describe('Built-in constructors', () => {
    it('should create CONSTRUCTOR_CALL node for new Date() with isBuiltin=true', async () => {
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

      // Find the source node - should be CONSTRUCTOR_CALL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(
        source.type, 'CONSTRUCTOR_CALL',
        `Expected CONSTRUCTOR_CALL, got ${source.type}`
      );
      assert.strictEqual(source.className, 'Date', `Expected className=Date, got ${source.className}`);
      assert.strictEqual(source.isBuiltin, true, 'Date should be marked as builtin');
      assert.ok(source.line !== undefined, 'CONSTRUCTOR_CALL should have line');
      assert.ok(source.column !== undefined, 'CONSTRUCTOR_CALL should have column');
    });

    it('should create CONSTRUCTOR_CALL node for new Map() with isBuiltin=true', async () => {
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

      // Find the source node - should be CONSTRUCTOR_CALL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
      assert.strictEqual(source.className, 'Map', `Expected className=Map, got ${source.className}`);
      assert.strictEqual(source.isBuiltin, true, 'Map should be marked as builtin');
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

      // Find all CONSTRUCTOR_CALL nodes
      const constructorCalls = allNodes.filter(n => n.type === 'CONSTRUCTOR_CALL');

      const builtinClassNames = ['Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'RegExp', 'Error', 'Promise'];

      for (const className of builtinClassNames) {
        const node = constructorCalls.find(n => n.className === className);
        assert.ok(node, `CONSTRUCTOR_CALL node for ${className} not found`);
        assert.strictEqual(
          node.isBuiltin, true,
          `${className} should be marked as builtin`
        );
      }
    });
  });

  // ============================================================================
  // User-defined class constructors
  // ============================================================================
  describe('User-defined class constructors', () => {
    it('should create CONSTRUCTOR_CALL node for user-defined class with isBuiltin=false', async () => {
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

      // Find the source node - should be CONSTRUCTOR_CALL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
      assert.strictEqual(source.className, 'Database', `Expected className=Database, got ${source.className}`);
      assert.strictEqual(source.isBuiltin, false, 'Database should NOT be marked as builtin');
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
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
      assert.strictEqual(source.className, 'HttpClient', `Expected className=HttpClient, got ${source.className}`);
      assert.strictEqual(source.isBuiltin, false, 'HttpClient should NOT be marked as builtin');
    });
  });

  // ============================================================================
  // Multiple constructors in same file
  // ============================================================================
  describe('Multiple constructors in same file', () => {
    it('should create distinct CONSTRUCTOR_CALL nodes for multiple new expressions', async () => {
      await setupTest(backend, {
        'index.js': `
const d1 = new Date();
const d2 = new Date();
const m = new Map();
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find all CONSTRUCTOR_CALL nodes
      const constructorCalls = allNodes.filter(n => n.type === 'CONSTRUCTOR_CALL');

      assert.strictEqual(
        constructorCalls.length, 3,
        `Expected 3 CONSTRUCTOR_CALL nodes (d1, d2, m), got ${constructorCalls.length}. Nodes: ${JSON.stringify(constructorCalls)}`
      );

      // Each should have different line/column
      const dateNodes = constructorCalls.filter(n => n.className === 'Date');
      const mapNodes = constructorCalls.filter(n => n.className === 'Map');

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
    it('should allow tracing variable value source to CONSTRUCTOR_CALL', async () => {
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
        valueSource.type, 'CONSTRUCTOR_CALL',
        `Value source should be CONSTRUCTOR_CALL, got ${valueSource.type}`
      );
      assert.strictEqual(
        valueSource.className, 'HttpClient',
        `Value source className should be HttpClient, got ${valueSource.className}`
      );
    });
  });

  // ============================================================================
  // CONSTRUCTOR_CALL node attributes
  // ============================================================================
  describe('CONSTRUCTOR_CALL node attributes', () => {
    it('should include file path in CONSTRUCTOR_CALL node', async () => {
      await setupTest(backend, {
        'index.js': `const date = new Date();`
      });

      const allNodes = await backend.getAllNodes();

      const constructorCall = allNodes.find(n => n.type === 'CONSTRUCTOR_CALL');
      assert.ok(constructorCall, 'CONSTRUCTOR_CALL node not found');
      assert.ok(constructorCall.file, 'CONSTRUCTOR_CALL should have file attribute');
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

      const constructorCall = allNodes.find(n => n.type === 'CONSTRUCTOR_CALL');
      assert.ok(constructorCall, 'CONSTRUCTOR_CALL node not found');
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
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
      assert.strictEqual(source.className, 'Set');
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
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'CONSTRUCTOR_CALL', `Expected CONSTRUCTOR_CALL, got ${source.type}`);
      // For member expression, className should be the rightmost identifier
      assert.strictEqual(source.className, 'Database', `Expected className=Database, got ${source.className}`);
    });

    it('should handle chained new expression (assigned to temp)', async () => {
      // Pattern: const x = new A().method()
      // The new A() part should still create CONSTRUCTOR_CALL even if result is immediately used
      await setupTest(backend, {
        'index.js': `
class Builder {
  build() { return {}; }
}
const result = new Builder().build();
        `
      });

      const allNodes = await backend.getAllNodes();

      // CONSTRUCTOR_CALL node should exist for new Builder()
      const constructorCall = allNodes.find(n =>
        n.type === 'CONSTRUCTOR_CALL' && n.className === 'Builder'
      );
      assert.ok(
        constructorCall,
        `CONSTRUCTOR_CALL node for Builder should exist. Nodes: ${JSON.stringify(allNodes.filter(n => n.type === 'CONSTRUCTOR_CALL'))}`
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
      assert.strictEqual(dateSource.type, 'CONSTRUCTOR_CALL', 'date source should be CONSTRUCTOR_CALL');
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
      assert.strictEqual(dateSource.type, 'CONSTRUCTOR_CALL', `date source should be CONSTRUCTOR_CALL, got ${dateSource.type}`);
    });
  });

  // ============================================================================
  // No INVOKES edges (as per simplified spec)
  // ============================================================================
  describe('No INVOKES edges', () => {
    it('should NOT create INVOKES edge from CONSTRUCTOR_CALL to CLASS', async () => {
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
        // Check if edge is related to constructor call
        return e.src?.includes('CONSTRUCTOR_CALL') || e.dst?.includes('CONSTRUCTOR_CALL');
      });

      assert.strictEqual(
        constructorInvokes.length, 0,
        `Should NOT create INVOKES edges for constructor calls. Found: ${JSON.stringify(constructorInvokes)}`
      );
    });
  });
});
