/**
 * Tests for Object Literal Variable Assignment (REG-328)
 *
 * When a variable is initialized with an object literal (`const x = { key: value }`),
 * we should create:
 * 1. OBJECT_LITERAL node with correct metadata (file, line, column)
 * 2. ASSIGNED_FROM edge from VARIABLE to OBJECT_LITERAL
 *
 * Edge direction: VARIABLE --ASSIGNED_FROM--> OBJECT_LITERAL
 *
 * This enables data flow tracing through object literal assignments.
 * Without this, variables assigned from object literals would have no
 * ASSIGNED_FROM edge, breaking the data flow guarantee.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests should be RED initially - implementation comes after.
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
  const testDir = join(tmpdir(), `grafema-test-obj-literal-assign-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-obj-literal-assign-${testCounter}`,
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

describe('Object Literal Variable Assignment (REG-328)', () => {
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
  // Basic object literal assignments
  // ============================================================================
  describe('Basic object literals', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to OBJECT_LITERAL for simple object', async () => {
      await setupTest(backend, {
        'index.js': `const data = { status: 'ok' };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const dataVar = allNodes.find(n =>
        n.name === 'data' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(dataVar, 'Variable "data" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === dataVar.id
      );
      assert.ok(
        assignment,
        `Variable "data" should have ASSIGNED_FROM edge. Found edges: ${JSON.stringify(allEdges.filter(e => e.src === dataVar.id))}`
      );

      // Find the source node - should be OBJECT_LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(
        source.type, 'OBJECT_LITERAL',
        `Expected OBJECT_LITERAL, got ${source.type}`
      );
    });

    it('should create OBJECT_LITERAL node with correct metadata', async () => {
      await setupTest(backend, {
        'index.js': `const config = { timeout: 5000, retries: 3 };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(configVar, 'Variable "config" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === configVar.id
      );
      assert.ok(assignment, 'Variable "config" should have ASSIGNED_FROM edge');

      // Find the OBJECT_LITERAL node
      const objectLiteral = allNodes.find(n => n.id === assignment.dst);
      assert.ok(objectLiteral, 'OBJECT_LITERAL node not found');
      assert.strictEqual(objectLiteral.type, 'OBJECT_LITERAL');

      // Check metadata
      assert.ok(objectLiteral.file, 'OBJECT_LITERAL should have file attribute');
      assert.ok(
        objectLiteral.file.endsWith('index.js'),
        `File should end with index.js, got ${objectLiteral.file}`
      );
      assert.strictEqual(objectLiteral.line, 1, 'Line should be 1');
      assert.ok(
        objectLiteral.column >= 0,
        `Column should be non-negative, got ${objectLiteral.column}`
      );
    });

    it('should handle object with multiple properties', async () => {
      await setupTest(backend, {
        'index.js': `
const user = {
  name: 'John',
  age: 30,
  active: true
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const userVar = allNodes.find(n =>
        n.name === 'user' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(userVar, 'Variable "user" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === userVar.id
      );
      assert.ok(assignment, 'Variable "user" should have ASSIGNED_FROM edge');

      // Verify it points to OBJECT_LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });
  });

  // ============================================================================
  // Nested objects
  // ============================================================================
  describe('Nested objects', () => {
    it('should handle nested object literals', async () => {
      await setupTest(backend, {
        'index.js': `const data = { nested: { deep: true } };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const dataVar = allNodes.find(n =>
        n.name === 'data' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(dataVar, 'Variable "data" not found');

      // Find ASSIGNED_FROM edge from variable
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === dataVar.id
      );
      assert.ok(assignment, 'Variable "data" should have ASSIGNED_FROM edge');

      // Verify outer object is OBJECT_LITERAL
      const outerObject = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(outerObject.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL for outer object, got ${outerObject.type}`);

      // Find all OBJECT_LITERAL nodes - should have both outer and inner
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');
      assert.ok(
        objectLiteralNodes.length >= 2,
        `Should have at least 2 OBJECT_LITERAL nodes (outer and inner), found: ${objectLiteralNodes.length}`
      );
    });

    it('should handle deeply nested object literals', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {
  database: {
    connection: {
      host: 'localhost',
      port: 5432
    }
  }
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(configVar, 'Variable "config" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === configVar.id
      );
      assert.ok(assignment, 'Variable "config" should have ASSIGNED_FROM edge');

      // Verify it points to OBJECT_LITERAL
      const outerObject = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(outerObject.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${outerObject.type}`);

      // Should have 3 nested OBJECT_LITERAL nodes (config, database, connection)
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');
      assert.ok(
        objectLiteralNodes.length >= 3,
        `Should have at least 3 OBJECT_LITERAL nodes, found: ${objectLiteralNodes.length}`
      );
    });
  });

  // ============================================================================
  // Object spread
  // ============================================================================
  describe('Object spread', () => {
    it('should handle object spread syntax', async () => {
      await setupTest(backend, {
        'index.js': `
const base = { a: 1 };
const extended = { ...base, b: 2 };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find extended variable
      const extendedVar = allNodes.find(n =>
        n.name === 'extended' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(extendedVar, 'Variable "extended" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === extendedVar.id
      );
      assert.ok(assignment, 'Variable "extended" should have ASSIGNED_FROM edge');

      // Verify it points to OBJECT_LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle multiple spreads in object literal', async () => {
      await setupTest(backend, {
        'index.js': `
const a = { x: 1 };
const b = { y: 2 };
const merged = { ...a, ...b, z: 3 };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find merged variable
      const mergedVar = allNodes.find(n =>
        n.name === 'merged' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(mergedVar, 'Variable "merged" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === mergedVar.id
      );
      assert.ok(assignment, 'Variable "merged" should have ASSIGNED_FROM edge');

      // Verify it points to OBJECT_LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });
  });

  // ============================================================================
  // Empty objects
  // ============================================================================
  describe('Empty objects', () => {
    it('should handle empty object literal', async () => {
      await setupTest(backend, {
        'index.js': `const empty = {};`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable
      const emptyVar = allNodes.find(n =>
        n.name === 'empty' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(emptyVar, 'Variable "empty" not found');

      // Find ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === emptyVar.id
      );
      assert.ok(
        assignment,
        `Variable "empty" should have ASSIGNED_FROM edge even for empty object. Found edges: ${JSON.stringify(allEdges.filter(e => e.src === emptyVar.id))}`
      );

      // Verify it points to OBJECT_LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });
  });

  // ============================================================================
  // Variable declaration contexts
  // ============================================================================
  describe('Different declaration contexts', () => {
    it('should handle let declaration', async () => {
      await setupTest(backend, {
        'index.js': `let mutable = { count: 0 };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const mutableVar = allNodes.find(n =>
        n.name === 'mutable' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(mutableVar, 'Variable "mutable" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === mutableVar.id
      );
      assert.ok(assignment, 'Variable "mutable" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle var declaration', async () => {
      await setupTest(backend, {
        'index.js': `var legacy = { old: true };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const legacyVar = allNodes.find(n =>
        n.name === 'legacy' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(legacyVar, 'Variable "legacy" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === legacyVar.id
      );
      assert.ok(assignment, 'Variable "legacy" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle object literal inside function', async () => {
      await setupTest(backend, {
        'index.js': `
function createConfig() {
  const config = { debug: true };
  return config;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the config variable inside function
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(configVar, 'Variable "config" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === configVar.id
      );
      assert.ok(assignment, 'Variable "config" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle object literal inside arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const factory = () => {
  const instance = { id: 1 };
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
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle object literal inside class method', async () => {
      await setupTest(backend, {
        'index.js': `
class Service {
  getDefaults() {
    const defaults = { timeout: 1000 };
    return defaults;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the defaults variable
      const defaultsVar = allNodes.find(n =>
        n.name === 'defaults' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(defaultsVar, 'Variable "defaults" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === defaultsVar.id
      );
      assert.ok(assignment, 'Variable "defaults" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });
  });

  // ============================================================================
  // Computed properties and shorthand syntax
  // ============================================================================
  describe('Special object syntax', () => {
    it('should handle shorthand property names', async () => {
      await setupTest(backend, {
        'index.js': `
const name = 'John';
const age = 30;
const person = { name, age };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const personVar = allNodes.find(n =>
        n.name === 'person' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(personVar, 'Variable "person" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === personVar.id
      );
      assert.ok(assignment, 'Variable "person" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle computed property names', async () => {
      await setupTest(backend, {
        'index.js': `
const key = 'dynamicKey';
const obj = { [key]: 'value' };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(objVar, 'Variable "obj" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === objVar.id
      );
      assert.ok(assignment, 'Variable "obj" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle method shorthand', async () => {
      await setupTest(backend, {
        'index.js': `
const api = {
  getData() { return []; },
  setData(d) { this.data = d; }
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const apiVar = allNodes.find(n =>
        n.name === 'api' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(apiVar, 'Variable "api" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === apiVar.id
      );
      assert.ok(assignment, 'Variable "api" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });

    it('should handle getter/setter syntax', async () => {
      await setupTest(backend, {
        'index.js': `
const state = {
  _value: 0,
  get value() { return this._value; },
  set value(v) { this._value = v; }
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const stateVar = allNodes.find(n =>
        n.name === 'state' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(stateVar, 'Variable "state" not found');

      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === stateVar.id
      );
      assert.ok(assignment, 'Variable "state" should have ASSIGNED_FROM edge');

      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'OBJECT_LITERAL', `Expected OBJECT_LITERAL, got ${source.type}`);
    });
  });

  // ============================================================================
  // Multiple variables in same file
  // ============================================================================
  describe('Multiple object literal assignments', () => {
    it('should handle multiple object literals in same file', async () => {
      await setupTest(backend, {
        'index.js': `
const a = { x: 1 };
const b = { y: 2 };
const c = { z: 3 };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find all OBJECT_LITERAL nodes
      const objectLiteralNodes = allNodes.filter(n => n.type === 'OBJECT_LITERAL');
      assert.strictEqual(
        objectLiteralNodes.length, 3,
        `Expected 3 OBJECT_LITERAL nodes, found: ${objectLiteralNodes.length}`
      );

      // Each variable should have ASSIGNED_FROM edge
      for (const varName of ['a', 'b', 'c']) {
        const v = allNodes.find(n => n.name === varName && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
        assert.ok(v, `Variable "${varName}" not found`);

        const edge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);
        assert.ok(edge, `Variable "${varName}" should have ASSIGNED_FROM edge`);

        const source = allNodes.find(n => n.id === edge.dst);
        assert.strictEqual(source.type, 'OBJECT_LITERAL', `Variable "${varName}" should be assigned from OBJECT_LITERAL`);
      }

      // Each OBJECT_LITERAL should have unique ID
      const ids = objectLiteralNodes.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, 'All OBJECT_LITERAL IDs should be unique');
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
const obj = { key: 'value' };
const str = "hello";
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // All three variables should have ASSIGNED_FROM edges
      for (const varName of ['num', 'obj', 'str']) {
        const v = allNodes.find(n => n.name === varName && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
        assert.ok(v, `Variable "${varName}" not found`);

        const edge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);
        assert.ok(edge, `Variable "${varName}" should have ASSIGNED_FROM edge`);
      }

      // Check source types
      const numVar = allNodes.find(n => n.name === 'num' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
      const objVar = allNodes.find(n => n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
      const strVar = allNodes.find(n => n.name === 'str' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));

      const numEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === numVar.id);
      const objEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === objVar.id);
      const strEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === strVar.id);

      const numSource = allNodes.find(n => n.id === numEdge.dst);
      const objSource = allNodes.find(n => n.id === objEdge.dst);
      const strSource = allNodes.find(n => n.id === strEdge.dst);

      assert.strictEqual(numSource.type, 'LITERAL', 'num source should be LITERAL');
      assert.strictEqual(objSource.type, 'OBJECT_LITERAL', 'obj source should be OBJECT_LITERAL');
      assert.strictEqual(strSource.type, 'LITERAL', 'str source should be LITERAL');
    });

    it('should coexist with CALL assignments', async () => {
      await setupTest(backend, {
        'index.js': `
function create() { return {}; }
const fromCall = create();
const fromObject = { created: true };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Filter out the 'create' function node when looking for 'fromCall' variable
      const fromCallVar = allNodes.find(n =>
        n.name === 'fromCall' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const fromObjectVar = allNodes.find(n =>
        n.name === 'fromObject' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(fromCallVar, 'Variable "fromCall" not found');
      assert.ok(fromObjectVar, 'Variable "fromObject" not found');

      const fromCallEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === fromCallVar.id);
      const fromObjectEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === fromObjectVar.id);

      assert.ok(fromCallEdge, 'Variable "fromCall" should have ASSIGNED_FROM edge');
      assert.ok(fromObjectEdge, 'Variable "fromObject" should have ASSIGNED_FROM edge');

      const fromCallSource = allNodes.find(n => n.id === fromCallEdge.dst);
      const fromObjectSource = allNodes.find(n => n.id === fromObjectEdge.dst);

      assert.strictEqual(fromCallSource.type, 'CALL', `fromCall source should be CALL, got ${fromCallSource.type}`);
      assert.strictEqual(fromObjectSource.type, 'OBJECT_LITERAL', `fromObject source should be OBJECT_LITERAL, got ${fromObjectSource.type}`);
    });

    it('should coexist with CONSTRUCTOR_CALL assignments', async () => {
      await setupTest(backend, {
        'index.js': `
const instance = new Date();
const config = { timestamp: 123 };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const instanceVar = allNodes.find(n =>
        n.name === 'instance' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(instanceVar, 'Variable "instance" not found');
      assert.ok(configVar, 'Variable "config" not found');

      const instanceEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === instanceVar.id);
      const configEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === configVar.id);

      assert.ok(instanceEdge, 'Variable "instance" should have ASSIGNED_FROM edge');
      assert.ok(configEdge, 'Variable "config" should have ASSIGNED_FROM edge');

      const instanceSource = allNodes.find(n => n.id === instanceEdge.dst);
      const configSource = allNodes.find(n => n.id === configEdge.dst);

      assert.strictEqual(instanceSource.type, 'CONSTRUCTOR_CALL', `instance source should be CONSTRUCTOR_CALL, got ${instanceSource.type}`);
      assert.strictEqual(configSource.type, 'OBJECT_LITERAL', `config source should be OBJECT_LITERAL, got ${configSource.type}`);
    });

    it('should coexist with ARRAY_LITERAL assignments', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const obj = { a: 1, b: 2 };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n =>
        n.name === 'arr' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      const objVar = allNodes.find(n =>
        n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(arrVar, 'Variable "arr" not found');
      assert.ok(objVar, 'Variable "obj" not found');

      const arrEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === arrVar.id);
      const objEdge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === objVar.id);

      assert.ok(arrEdge, 'Variable "arr" should have ASSIGNED_FROM edge');
      assert.ok(objEdge, 'Variable "obj" should have ASSIGNED_FROM edge');

      const arrSource = allNodes.find(n => n.id === arrEdge.dst);
      const objSource = allNodes.find(n => n.id === objEdge.dst);

      // Note: ARRAY_LITERAL support in trackVariableAssignment is not implemented yet
      // Arrays currently fall through to LITERAL handler (similar to how objects did before REG-328)
      // TODO: Add ArrayExpression handler similar to ObjectExpression (separate task)
      assert.ok(
        arrSource.type === 'ARRAY_LITERAL' || arrSource.type === 'LITERAL',
        `arr source should be ARRAY_LITERAL or LITERAL, got ${arrSource.type}`
      );
      assert.strictEqual(objSource.type, 'OBJECT_LITERAL', `obj source should be OBJECT_LITERAL, got ${objSource.type}`);
    });
  });

  // ============================================================================
  // Value tracing integration
  // ============================================================================
  describe('Integration with value tracing', () => {
    it('should allow tracing variable value source to OBJECT_LITERAL', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { timeout: 5000, debug: true };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the config variable
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(configVar, 'Variable "config" not found');

      // Trace value source via ASSIGNED_FROM edge
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === configVar.id
      );
      assert.ok(assignment, 'Should find ASSIGNED_FROM edge');

      const valueSource = allNodes.find(n => n.id === assignment.dst);
      assert.ok(valueSource, 'Should find value source node');
      assert.strictEqual(
        valueSource.type, 'OBJECT_LITERAL',
        `Value source should be OBJECT_LITERAL, got ${valueSource.type}`
      );
    });

    it('should trace through variable chain to OBJECT_LITERAL', async () => {
      await setupTest(backend, {
        'index.js': `
const original = { value: 42 };
const copy = original;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the original variable
      const originalVar = allNodes.find(n =>
        n.name === 'original' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(originalVar, 'Variable "original" not found');

      // original should be assigned from OBJECT_LITERAL
      const originalEdge = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === originalVar.id
      );
      assert.ok(originalEdge, 'Variable "original" should have ASSIGNED_FROM edge');

      const originalSource = allNodes.find(n => n.id === originalEdge.dst);
      assert.strictEqual(originalSource.type, 'OBJECT_LITERAL');

      // copy should be assigned from original variable
      const copyVar = allNodes.find(n =>
        n.name === 'copy' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(copyVar, 'Variable "copy" not found');

      const copyEdge = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === copyVar.id
      );
      assert.ok(copyEdge, 'Variable "copy" should have ASSIGNED_FROM edge');

      // copy can trace back to original (either directly to original var or to its value)
      // The important thing is that the chain is complete
    });
  });
});
