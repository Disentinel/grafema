/**
 * Tests for Object Literal Variable Assignment (REG-328)
 *
 * When a variable is initialized with an object literal (`const x = { key: value }`),
 * V2 creates:
 * 1. LITERAL node with valueType:"object" and name:"{...}"
 * 2. ASSIGNED_FROM edge from VARIABLE to LITERAL
 *
 * Edge direction: VARIABLE --ASSIGNED_FROM--> LITERAL
 *
 * V2 NOTE: Object literals are represented as LITERAL nodes (not OBJECT_LITERAL).
 * The LITERAL node has name="{...}" and valueType="object".
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
  // Basic object literal assignments
  // ============================================================================
  describe('Basic object literals', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to LITERAL for simple object', async () => {
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

      // V2: source is LITERAL with name="{...}"
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(
        source.type, 'LITERAL',
        `Expected LITERAL, got ${source.type}`
      );
    });

    it('should create LITERAL node with correct metadata for object', async () => {
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

      // V2: Find the LITERAL node (object)
      const objectLiteral = allNodes.find(n => n.id === assignment.dst);
      assert.ok(objectLiteral, 'LITERAL node not found');
      assert.strictEqual(objectLiteral.type, 'LITERAL');

      // Check metadata
      assert.ok(objectLiteral.file, 'LITERAL should have file attribute');
      assert.ok(
        objectLiteral.file.endsWith('index.js'),
        `File should end with index.js, got ${objectLiteral.file}`
      );
      assert.strictEqual(objectLiteral.line, 1, 'Line should be 1');
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

      // V2: Verify it points to LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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

      // V2: Verify outer object is LITERAL
      const outerObject = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(outerObject.type, 'LITERAL', `Expected LITERAL for outer object, got ${outerObject.type}`);
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

      // V2: Verify it points to LITERAL
      const outerObject = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(outerObject.type, 'LITERAL', `Expected LITERAL, got ${outerObject.type}`);
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

      // V2: Verify it points to LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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

      // V2: Verify it points to LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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

      // V2: Verify it points to LITERAL
      const source = allNodes.find(n => n.id === assignment.dst);
      assert.ok(source, 'Source node not found');
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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
      assert.strictEqual(source.type, 'LITERAL', `Expected LITERAL, got ${source.type}`);
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

      // Each variable should have ASSIGNED_FROM edge to a LITERAL
      for (const varName of ['a', 'b', 'c']) {
        const v = allNodes.find(n => n.name === varName && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
        assert.ok(v, `Variable "${varName}" not found`);

        const edge = allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === v.id);
        assert.ok(edge, `Variable "${varName}" should have ASSIGNED_FROM edge`);

        const source = allNodes.find(n => n.id === edge.dst);
        assert.strictEqual(source.type, 'LITERAL', `Variable "${varName}" should be assigned from LITERAL`);
      }
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

      // V2: All sources are LITERAL type (numbers, strings, and objects are all LITERAL)
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
      assert.strictEqual(objSource.type, 'LITERAL', 'obj source should be LITERAL');
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
      assert.strictEqual(fromObjectSource.type, 'LITERAL', `fromObject source should be LITERAL, got ${fromObjectSource.type}`);
    });

    it('should coexist with new expression assignments', async () => {
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

      // V2: new Date() creates CALL with isNew:true, not CONSTRUCTOR_CALL
      assert.strictEqual(instanceSource.type, 'CALL', `instance source should be CALL (with isNew), got ${instanceSource.type}`);
      assert.strictEqual(configSource.type, 'LITERAL', `config source should be LITERAL, got ${configSource.type}`);
    });

    it('should coexist with array literal assignments', async () => {
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

      // V2: Both arrays and objects are LITERAL type
      assert.strictEqual(arrSource.type, 'LITERAL', `arr source should be LITERAL, got ${arrSource.type}`);
      assert.strictEqual(objSource.type, 'LITERAL', `obj source should be LITERAL, got ${objSource.type}`);
    });
  });

  // ============================================================================
  // Value tracing integration
  // ============================================================================
  describe('Integration with value tracing', () => {
    it('should allow tracing variable value source to LITERAL', async () => {
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
        valueSource.type, 'LITERAL',
        `Value source should be LITERAL, got ${valueSource.type}`
      );
    });

    it('should trace through variable chain', async () => {
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

      // original should be assigned from LITERAL
      const originalEdge = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === originalVar.id
      );
      assert.ok(originalEdge, 'Variable "original" should have ASSIGNED_FROM edge');

      const originalSource = allNodes.find(n => n.id === originalEdge.dst);
      assert.strictEqual(originalSource.type, 'LITERAL');

      // copy should exist
      const copyVar = allNodes.find(n =>
        n.name === 'copy' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(copyVar, 'Variable "copy" not found');
    });
  });

  // ============================================================================
  // PROPERTY_ASSIGNMENT nodes for object properties (REG-573)
  // ============================================================================
  describe('PROPERTY_ASSIGNMENT nodes for object properties (REG-573)', () => {
    it('should create PROPERTY_ASSIGNMENT nodes with PROPERTY_KEY edges', async () => {
      await setupTest(backend, {
        'index.js': `const data = { status: 'ok', code: 200 };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // PROPERTY_ASSIGNMENT nodes for each property
      const statusPA = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'status'
      );
      assert.ok(statusPA, 'PROPERTY_ASSIGNMENT "status" not found');

      const codePA = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'code'
      );
      assert.ok(codePA, 'PROPERTY_ASSIGNMENT "code" not found');

      // PROPERTY_KEY edges to LITERAL key nodes
      const statusKeyEdge = allEdges.find(e =>
        e.type === 'PROPERTY_KEY' && e.src === statusPA.id
      );
      assert.ok(statusKeyEdge, 'PROPERTY_KEY edge for "status" not found');

      const keyNode = allNodes.find(n => n.id === statusKeyEdge.dst);
      assert.ok(keyNode, 'Key LITERAL node not found');
      assert.strictEqual(keyNode.type, 'LITERAL', `Key should be LITERAL, got ${keyNode.type}`);
      assert.strictEqual(keyNode.name, 'status', `Key name should be "status", got ${keyNode.name}`);
    });

    it('should create PROPERTY_VALUE edges to value expressions', async () => {
      await setupTest(backend, {
        'index.js': `const data = { msg: 'hello' };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const msgPA = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'msg'
      );
      assert.ok(msgPA, 'PROPERTY_ASSIGNMENT "msg" not found');

      // PROPERTY_VALUE edge to the string LITERAL
      const valueEdge = allEdges.find(e =>
        e.type === 'PROPERTY_VALUE' && e.src === msgPA.id
      );
      assert.ok(valueEdge, 'PROPERTY_VALUE edge not found');

      const valueNode = allNodes.find(n => n.id === valueEdge.dst);
      assert.ok(valueNode, 'Value node not found');
      assert.strictEqual(valueNode.type, 'LITERAL', `Value should be LITERAL, got ${valueNode.type}`);
    });

    it('should handle shorthand properties with READS_FROM', async () => {
      await setupTest(backend, {
        'index.js': `
const x = 10;
const obj = { x };
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xPA = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'x'
      );
      assert.ok(xPA, 'PROPERTY_ASSIGNMENT "x" not found for shorthand');

      // PROPERTY_KEY edge exists
      const keyEdge = allEdges.find(e =>
        e.type === 'PROPERTY_KEY' && e.src === xPA.id
      );
      assert.ok(keyEdge, 'PROPERTY_KEY edge not found for shorthand');

      // READS_FROM edge to the variable x
      const xVar = allNodes.find(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(xVar, 'Variable "x" not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === xPA.id &&
        e.dst === xVar.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from shorthand PROPERTY_ASSIGNMENT to variable');
    });

    it('should handle computed property keys', async () => {
      await setupTest(backend, {
        'index.js': `
const key = 'dynamic';
const obj = { [key]: 'value' };
        `
      });

      const allNodes = await backend.getAllNodes();

      // Metadata is flattened to top-level by RFDB
      const pa = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.computed === true
      );
      assert.ok(pa, 'PROPERTY_ASSIGNMENT with computed:true not found');
    });

    it('should handle string literal keys', async () => {
      await setupTest(backend, {
        'index.js': `const obj = { "my-key": 42 };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const pa = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'my-key'
      );
      assert.ok(pa, 'PROPERTY_ASSIGNMENT "my-key" not found');

      const keyEdge = allEdges.find(e =>
        e.type === 'PROPERTY_KEY' && e.src === pa.id
      );
      assert.ok(keyEdge, 'PROPERTY_KEY edge for string key not found');
    });

    it('should handle numeric keys', async () => {
      await setupTest(backend, {
        'index.js': `const obj = { 0: 'first', 1: 'second' };`
      });

      const allNodes = await backend.getAllNodes();

      const pa0 = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === '0'
      );
      assert.ok(pa0, 'PROPERTY_ASSIGNMENT "0" not found');

      const pa1 = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === '1'
      );
      assert.ok(pa1, 'PROPERTY_ASSIGNMENT "1" not found');
    });

    it('should handle nested object with PROPERTY_VALUE to nested LITERAL', async () => {
      await setupTest(backend, {
        'index.js': `const obj = { a: { b: 1 } };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const aPA = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'a'
      );
      assert.ok(aPA, 'PROPERTY_ASSIGNMENT "a" not found');

      // PROPERTY_VALUE should point to a nested LITERAL (object)
      const valueEdge = allEdges.find(e =>
        e.type === 'PROPERTY_VALUE' && e.src === aPA.id
      );
      assert.ok(valueEdge, 'PROPERTY_VALUE edge for nested object not found');

      const nestedLit = allNodes.find(n => n.id === valueEdge.dst);
      assert.ok(nestedLit, 'Nested LITERAL not found');
      assert.strictEqual(nestedLit.type, 'LITERAL', `Nested value should be LITERAL, got ${nestedLit.type}`);
    });

    it('should NOT create PROPERTY_ASSIGNMENT for empty object', async () => {
      await setupTest(backend, {
        'index.js': `const empty = {};`
      });

      const allNodes = await backend.getAllNodes();

      const paNodes = allNodes.filter(n => n.type === 'PROPERTY_ASSIGNMENT');
      assert.strictEqual(paNodes.length, 0, 'Empty object should not have PROPERTY_ASSIGNMENT nodes');
    });

    it('should connect HAS_PROPERTY from LITERAL(object) to PROPERTY_ASSIGNMENT', async () => {
      await setupTest(backend, {
        'index.js': `const data = { key: 'val' };`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the object LITERAL
      const objLit = allNodes.find(n =>
        n.type === 'LITERAL' && n.name === '{...}'
      );
      assert.ok(objLit, 'Object LITERAL not found');

      // Find HAS_PROPERTY edge
      const hasProp = allEdges.find(e =>
        e.type === 'HAS_PROPERTY' && e.src === objLit.id
      );
      assert.ok(hasProp, 'HAS_PROPERTY edge from LITERAL not found');

      // Destination should be PROPERTY_ASSIGNMENT
      const dst = allNodes.find(n => n.id === hasProp.dst);
      assert.ok(dst, 'HAS_PROPERTY destination not found');
      assert.strictEqual(
        dst.type, 'PROPERTY_ASSIGNMENT',
        `HAS_PROPERTY should point to PROPERTY_ASSIGNMENT, got ${dst.type}`
      );
    });
  });

  // ============================================================================
  // SPREADS_FROM edges for object spread (REG-573)
  // ============================================================================
  describe('SPREADS_FROM edges for object spread', () => {
    it('should create SPREADS_FROM edge for ...obj in object literal', async () => {
      await setupTest(backend, {
        'index.js': `
const base = { x: 1, y: 2 };
const extended = { ...base, z: 3 };
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the spread EXPRESSION node
      const spreadNode = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === 'spread'
      );
      assert.ok(spreadNode, 'EXPRESSION(spread) node not found');

      // Find SPREADS_FROM edge from spread to base variable
      const baseVar = allNodes.find(n =>
        n.name === 'base' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(baseVar, 'Variable "base" not found');

      const spreadsFrom = allEdges.find(e =>
        e.type === 'SPREADS_FROM' && e.src === spreadNode.id && e.dst === baseVar.id
      );
      assert.ok(
        spreadsFrom,
        `SPREADS_FROM edge from spread to "base" not found. ` +
        `Edges from spread: ${JSON.stringify(allEdges.filter(e => e.src === spreadNode.id))}`
      );
    });

    it('should create SPREADS_FROM edge for ...fn() (non-Identifier argument)', async () => {
      await setupTest(backend, {
        'index.js': `
function getDefaults() { return { a: 1 }; }
const obj = { ...getDefaults(), b: 2 };
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const spreadNode = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === 'spread'
      );
      assert.ok(spreadNode, 'EXPRESSION(spread) node not found');

      // For function call argument, SPREADS_FROM goes from spread to CALL node
      const callNode = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'getDefaults'
      );
      assert.ok(callNode, 'CALL(getDefaults) node not found');

      const spreadsFrom = allEdges.find(e =>
        e.type === 'SPREADS_FROM' && e.src === spreadNode.id && e.dst === callNode.id
      );
      assert.ok(
        spreadsFrom,
        `SPREADS_FROM edge from spread to CALL(getDefaults) not found. ` +
        `Edges from spread: ${JSON.stringify(allEdges.filter(e => e.src === spreadNode.id))}`
      );
    });
  });
});
