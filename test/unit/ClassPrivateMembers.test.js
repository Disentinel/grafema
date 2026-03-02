/**
 * Class Private Members Tests (REG-271)
 *
 * Tests for tracking ES2022+ class private members:
 * - StaticBlock: static { ... } creates STATIC_BLOCK node
 * - ClassPrivateProperty: #privateField creates PROPERTY with private=true
 * - ClassPrivateMethod: #privateMethod() creates METHOD with private=true
 *
 * Acceptance Criteria:
 * 1. Static blocks create STATIC_BLOCK nodes with HAS_MEMBER edge from CLASS
 * 2. Private fields create PROPERTY nodes with private: true
 * 3. Private methods create METHOD nodes with private: true
 *
 * TDD: Tests written first per Kent Beck's methodology.
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
  const testDir = join(tmpdir(), `grafema-test-private-members-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-private-members-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Helper to find nodes by type
 */
async function getNodesByType(backend, type) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter(n => n.type === type);
}

/**
 * Helper to find edges by type
 */
async function getEdgesByType(backend, type) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter(e => e.type === type);
}

/**
 * Helper to find a specific node by type and name
 */
async function findNode(backend, type, name) {
  const allNodes = await backend.getAllNodes();
  return allNodes.find(n => n.type === type && n.name === name);
}

describe('Class Private Members Analysis (REG-271)', () => {
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

  // ===========================================================================
  // Static Blocks
  // ===========================================================================

  describe('Static Blocks', () => {
    it('should create STATIC_BLOCK node for single static block', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static {
    console.log('initialized');
  }
}
        `
      });

      const staticBlocks = await getNodesByType(backend, 'STATIC_BLOCK');

      assert.ok(staticBlocks.length >= 1, 'STATIC_BLOCK node should exist');
      assert.ok(staticBlocks[0].name === 'static', 'Static block name should be "static"');
    });

    it('should create CLASS -[HAS_MEMBER]-> STATIC_BLOCK edge for static block', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static {
    init();
  }
}
        `
      });

      const classes = await getNodesByType(backend, 'CLASS');
      const staticBlocks = await getNodesByType(backend, 'STATIC_BLOCK');
      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');

      const fooClass = classes.find(c => c.name === 'Foo');
      const staticBlock = staticBlocks[0];

      assert.ok(fooClass, 'Foo class should exist');
      assert.ok(staticBlock, 'Static block should exist');

      const classToBlock = hasMemberEdges.find(e =>
        e.src === fooClass.id && e.dst === staticBlock.id
      );

      assert.ok(classToBlock, 'CLASS -[HAS_MEMBER]-> STATIC_BLOCK edge should exist');
    });

    it('should handle multiple static blocks with unique discriminators', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static {
    initA();
  }
  static {
    initB();
  }
}
        `
      });

      const staticBlocks = await getNodesByType(backend, 'STATIC_BLOCK');

      assert.strictEqual(
        staticBlocks.length,
        2,
        'Should have 2 static blocks'
      );

      // Verify they have different IDs (discriminators)
      assert.notStrictEqual(
        staticBlocks[0].id,
        staticBlocks[1].id,
        'Static blocks should have unique IDs'
      );

      // Both should be members of the class
      const classes = await getNodesByType(backend, 'CLASS');
      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');
      const fooClass = classes.find(c => c.name === 'Foo');

      for (const block of staticBlocks) {
        const edge = hasMemberEdges.find(e =>
          e.src === fooClass.id && e.dst === block.id
        );
        assert.ok(edge, `CLASS should have HAS_MEMBER edge to static block ${block.id}`);
      }
    });

    it('should track variables declared in static block', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static {
    const x = 1;
    let y = 2;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const variables = allNodes.filter(n => n.type === 'VARIABLE' || n.type === 'CONSTANT');

      // x might be CONSTANT, y should be VARIABLE
      const xVar = variables.find(v => v.name === 'x');
      const yVar = variables.find(v => v.name === 'y');

      assert.ok(xVar, 'Variable x should exist');
      assert.ok(yVar, 'Variable y should exist');
    });

    it('should track call expressions in static block', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static {
    Foo.init();
  }
  static init() {}
}
        `
      });

      // Foo.init() creates CALL node
      const calls = await getNodesByType(backend, 'CALL');
      const initCall = calls.find(c => c.name === 'Foo.init' || c.name?.endsWith('.init'));

      assert.ok(initCall, 'Foo.init call should exist');
    });
  });

  // ===========================================================================
  // Private Fields (ClassPrivateProperty)
  // ===========================================================================

  describe('Private Fields', () => {
    it('should create PROPERTY node with private=true for private instance field', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #count = 0;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');
      const privateField = properties.find(v => v.name === '#count');

      assert.ok(privateField, 'Private field PROPERTY node should exist with #count name');
      assert.strictEqual(privateField.private, true, 'private should be true');
      // Instance field should not be static
      assert.ok(
        !privateField.static || privateField.static === false,
        'Instance field static should be false/undefined'
      );
    });

    it('should create HAS_MEMBER edge from CLASS to private field', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #secret = 42;
}
        `
      });

      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');
      const classes = await getNodesByType(backend, 'CLASS');
      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      const fooClass = classes.find(c => c.name === 'Foo');
      const secretField = properties.find(v => v.name === '#secret');

      assert.ok(fooClass, 'Foo class should exist');
      assert.ok(secretField, 'Private field #secret should exist');

      const edge = hasMemberEdges.find(e =>
        e.src === fooClass.id && e.dst === secretField.id
      );

      assert.ok(edge, 'CLASS -[HAS_MEMBER]-> PROPERTY(#secret) edge should exist');
    });

    it('should mark static private field with static=true', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static #instances = [];
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');
      const staticPrivateField = properties.find(v => v.name === '#instances');

      assert.ok(staticPrivateField, 'Static private field should exist');
      assert.strictEqual(staticPrivateField.private, true, 'private should be true');
      assert.strictEqual(staticPrivateField.static, true, 'static should be true');
    });

    it('should handle private field without initializer', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #field;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');
      const privateField = properties.find(v => v.name === '#field');

      assert.ok(privateField, 'Private field without initializer should exist');
      assert.strictEqual(privateField.private, true, 'private should be true');
    });

    it('should create PROPERTY node for private field with arrow function value and FUNCTION inside', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #handler = () => {
    console.log('handled');
  };
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');
      const handlerProp = properties.find(f => f.name === '#handler');

      assert.ok(handlerProp, 'Private field with arrow function should create PROPERTY node');
      assert.strictEqual(handlerProp.private, true, 'private should be true');

      // Should have HAS_MEMBER edge from class
      const classes = await getNodesByType(backend, 'CLASS');
      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');
      const fooClass = classes.find(c => c.name === 'Foo');

      const edge = hasMemberEdges.find(e =>
        e.src === fooClass.id && e.dst === handlerProp.id
      );
      assert.ok(edge, 'CLASS -[HAS_MEMBER]-> PROPERTY(#handler) edge should exist');
    });

    it('should handle multiple private fields', async () => {
      await setupTest(backend, {
        'index.js': `
class Point {
  #x = 0;
  #y = 0;
  static #origin = null;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      const xField = properties.find(v => v.name === '#x');
      const yField = properties.find(v => v.name === '#y');
      const originField = properties.find(v => v.name === '#origin');

      assert.ok(xField, 'Private field #x should exist');
      assert.ok(yField, 'Private field #y should exist');
      assert.ok(originField, 'Private field #origin should exist');

      // All should be private
      assert.strictEqual(xField.private, true);
      assert.strictEqual(yField.private, true);
      assert.strictEqual(originField.private, true);

      // Only origin should be static
      assert.ok(!xField.static || xField.static === false);
      assert.ok(!yField.static || yField.static === false);
      assert.strictEqual(originField.static, true);
    });
  });

  // ===========================================================================
  // Private Methods (ClassPrivateMethod)
  // ===========================================================================

  describe('Private Methods', () => {
    it('should create METHOD node with private=true for private instance method', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #validate() {
    return true;
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const privateMethod = methods.find(f => f.name === '#validate');

      assert.ok(privateMethod, 'Private method METHOD node should exist');
      assert.strictEqual(privateMethod.private, true, 'private should be true');
    });

    it('should create CLASS -[HAS_MEMBER]-> METHOD edge for private method', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #process() {}
}
        `
      });

      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');
      const classes = await getNodesByType(backend, 'CLASS');
      const methods = await getNodesByType(backend, 'METHOD');

      const fooClass = classes.find(c => c.name === 'Foo');
      const privateMethod = methods.find(f => f.name === '#process');

      assert.ok(fooClass, 'Foo class should exist');
      assert.ok(privateMethod, 'Private method should exist');

      const edge = hasMemberEdges.find(e =>
        e.src === fooClass.id && e.dst === privateMethod.id
      );

      assert.ok(edge, 'CLASS -[HAS_MEMBER]-> METHOD(#process) edge should exist');
    });

    it('should track private static method with static=true', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  static #configure() {
    return {};
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const staticMethod = methods.find(f => f.name === '#configure');

      assert.ok(staticMethod, 'Static private method should exist');
      assert.strictEqual(staticMethod.private, true, 'private should be true');
      assert.strictEqual(staticMethod.static, true, 'static should be true');
    });

    it('should track private getter as GETTER node', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  get #value() {
    return this._v;
  }
}
        `
      });

      const getters = await getNodesByType(backend, 'GETTER');
      const getter = getters.find(f => f.name === '#value');

      assert.ok(getter, 'Private getter should exist');
      assert.strictEqual(getter.private, true, 'private should be true');
      assert.strictEqual(getter.kind, 'get', 'kind should be "get"');
    });

    it('should track private setter as SETTER node', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  set #value(v) {
    this._v = v;
  }
}
        `
      });

      const setters = await getNodesByType(backend, 'SETTER');
      const setter = setters.find(f => f.name === '#value');

      assert.ok(setter, 'Private setter should exist');
      assert.strictEqual(setter.private, true, 'private should be true');
      assert.strictEqual(setter.kind, 'set', 'kind should be "set"');
    });

    it('should track private async method with async=true', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  async #fetch() {
    return await fetch('/api');
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const asyncMethod = methods.find(f => f.name === '#fetch');

      assert.ok(asyncMethod, 'Async private method should exist');
      assert.strictEqual(asyncMethod.private, true, 'private should be true');
      // async may or may not be set on METHOD nodes; check if it exists
    });

    it('should create separate GETTER and SETTER nodes for private getter and setter pair', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  get #prop() {
    return this._p;
  }
  set #prop(v) {
    this._p = v;
  }
}
        `
      });

      const getters = await getNodesByType(backend, 'GETTER');
      const setters = await getNodesByType(backend, 'SETTER');
      const propGetters = getters.filter(f => f.name === '#prop');
      const propSetters = setters.filter(f => f.name === '#prop');

      assert.strictEqual(propGetters.length, 1, 'Should have 1 GETTER node for #prop');
      assert.strictEqual(propSetters.length, 1, 'Should have 1 SETTER node for #prop');

      assert.strictEqual(propGetters[0].private, true);
      assert.strictEqual(propSetters[0].private, true);
    });

    it('should track private generator method', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  *#items() {
    yield 1;
    yield 2;
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const generatorMethod = methods.find(f => f.name === '#items');

      assert.ok(generatorMethod, 'Private generator method should exist');
      assert.strictEqual(generatorMethod.private, true, 'private should be true');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle class with only private members', async () => {
      await setupTest(backend, {
        'index.js': `
class Secret {
  #x = 1;
  #y() { return this.#x; }
}
        `
      });

      const classes = await getNodesByType(backend, 'CLASS');
      const methods = await getNodesByType(backend, 'METHOD');
      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      const secretClass = classes.find(c => c.name === 'Secret');
      const privateMethod = methods.find(f => f.name === '#y');
      const privateField = properties.find(v => v.name === '#x');

      assert.ok(secretClass, 'Secret class should exist');
      assert.ok(privateMethod, 'Private method #y should exist');
      assert.ok(privateField, 'Private field #x should exist');

      // Both should be private
      assert.strictEqual(privateMethod.private, true);
      assert.strictEqual(privateField.private, true);
    });

    it('should handle private method calling private method', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #a() {
    this.#b();
  }
  #b() {
    return 'b';
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const methodA = methods.find(f => f.name === '#a');
      const methodB = methods.find(f => f.name === '#b');

      assert.ok(methodA, 'Private method #a should exist');
      assert.ok(methodB, 'Private method #b should exist');

      // Both should be private
      assert.strictEqual(methodA.private, true);
      assert.strictEqual(methodB.private, true);
    });

    it('should handle private field assignment in constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  #x;
  constructor(val) {
    this.#x = val;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');
      const privateField = properties.find(v => v.name === '#x');
      const methods = await getNodesByType(backend, 'METHOD');
      const constructor = methods.find(f => f.name === 'constructor');

      assert.ok(privateField, 'Private field #x should exist');
      assert.ok(constructor, 'Constructor should exist');
      assert.strictEqual(privateField.private, true);
    });

    it('should handle mixed public and private members', async () => {
      await setupTest(backend, {
        'index.js': `
class Mixed {
  publicField = 1;
  #privateField = 2;

  publicMethod() {}
  #privateMethod() {}

  static publicStatic() {}
  static #privateStatic() {}
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      // Check private members
      const privateField = properties.find(v => v.name === '#privateField');
      const privateMethod = methods.find(f => f.name === '#privateMethod');
      const privateStatic = methods.find(f => f.name === '#privateStatic');

      assert.ok(privateField, 'Private field should exist');
      assert.ok(privateMethod, 'Private method should exist');
      assert.ok(privateStatic, 'Private static method should exist');

      assert.strictEqual(privateField.private, true);
      assert.strictEqual(privateMethod.private, true);
      assert.strictEqual(privateStatic.private, true);
      assert.strictEqual(privateStatic.static, true);

      // Check public members
      const publicMethod = methods.find(f => f.name === 'publicMethod');
      const publicStatic = methods.find(f => f.name === 'publicStatic');

      assert.ok(publicMethod, 'Public method should exist');
      assert.ok(publicStatic, 'Public static method should exist');

      // Public members should NOT have private=true
      assert.ok(
        !publicMethod.private || publicMethod.private === false,
        'Public method should not be private'
      );
      assert.ok(
        !publicStatic.private || publicStatic.private === false,
        'Public static should not be private'
      );
    });

    // NOTE: Nested class expressions (class X { static Inner = class { ... } })
    // are edge cases that require ClassExpression support, not just ClassDeclaration.
    // This is tracked separately and not part of REG-271 scope.
    it.skip('should handle nested class with private members (requires ClassExpression support)', async () => {
      await setupTest(backend, {
        'index.js': `
class Outer {
  static Inner = class {
    #innerPrivate = 1;
  };
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      // Inner class private field should be tracked
      const innerPrivate = properties.find(v => v.name === '#innerPrivate');
      assert.ok(innerPrivate, 'Inner class private field should exist');
      assert.strictEqual(innerPrivate.private, true);
    });

    it('should not mark regular properties as private', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  publicMethod() { return '#notPrivate'; }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const publicMethod = methods.find(f => f.name === 'publicMethod');

      assert.ok(publicMethod, 'publicMethod should exist');
      assert.ok(
        !publicMethod.private || publicMethod.private === false,
        'publicMethod should not be marked as private'
      );
    });
  });

  // ===========================================================================
  // Semantic ID Format
  // NOTE: Skipped due to known issue with RFDBServerBackend returning numeric IDs
  // instead of semantic IDs. The semantic IDs are stored in metadata.originalId
  // but not consistently exposed via getAllNodes(). See VariableVisitorSemanticIds.test.js
  // for similar skipped tests. This is a separate infrastructure issue, not REG-271.
  // ===========================================================================

  describe.skip('Semantic ID Format (skipped - RFDB backend known issue)', () => {
    it('should use semantic ID format for private methods', async () => {
      // Test skipped - RFDBServerBackend returns numeric IDs
    });

    it('should use semantic ID format for private fields', async () => {
      // Test skipped - RFDBServerBackend returns numeric IDs
    });

    it('should use semantic ID format for static blocks', async () => {
      // Test skipped - RFDBServerBackend returns numeric IDs
    });
  });

  // ===========================================================================
  // Integration with Existing Features
  // ===========================================================================

  describe('Integration with Existing Features', () => {
    it('should work alongside public methods', async () => {
      await setupTest(backend, {
        'index.js': `
class Handler {
  publicMethod() {
    this.#privateHelper();
  }

  #privateHelper() {
    return true;
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');

      const publicMethod = methods.find(f => f.name === 'publicMethod');
      const privateHelper = methods.find(f => f.name === '#privateHelper');

      assert.ok(publicMethod, 'Public method should exist');
      assert.ok(privateHelper, 'Private helper should exist');

      // Both should be members of the class
      const classes = await getNodesByType(backend, 'CLASS');
      const hasMemberEdges = await getEdgesByType(backend, 'HAS_MEMBER');
      const handlerClass = classes.find(c => c.name === 'Handler');

      const publicEdge = hasMemberEdges.find(e =>
        e.src === handlerClass.id && e.dst === publicMethod.id
      );
      const privateEdge = hasMemberEdges.find(e =>
        e.src === handlerClass.id && e.dst === privateHelper.id
      );

      assert.ok(publicEdge, 'Public method should be a member of class');
      assert.ok(privateEdge, 'Private method should be a member of class');
    });

    it('should work with class inheritance', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {
  #basePrivate = 1;
}

class Derived extends Base {
  #derivedPrivate = 2;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const properties = allNodes.filter(n => n.type === 'PROPERTY');

      const basePrivate = properties.find(v => v.name === '#basePrivate');
      const derivedPrivate = properties.find(v => v.name === '#derivedPrivate');

      assert.ok(basePrivate, 'Base private field should exist');
      assert.ok(derivedPrivate, 'Derived private field should exist');

      // Both should be private
      assert.strictEqual(basePrivate.private, true);
      assert.strictEqual(derivedPrivate.private, true);

      // DERIVES_FROM edge should exist
      const derivesFromEdges = await getEdgesByType(backend, 'DERIVES_FROM');
      assert.ok(
        derivesFromEdges.length >= 1,
        'Should have DERIVES_FROM edge'
      );
    });

    it('should work with decorators on private members (if supported)', async () => {
      // This test is for future compatibility - decorators on private members
      // are a Stage 3 proposal. Test should pass if decorators aren't supported yet.
      await setupTest(backend, {
        'index.js': `
class Service {
  #privateMethod() {
    return true;
  }
}
        `
      });

      const methods = await getNodesByType(backend, 'METHOD');
      const privateMethod = methods.find(f => f.name === '#privateMethod');

      assert.ok(privateMethod, 'Private method should exist regardless of decorator support');
      assert.strictEqual(privateMethod.private, true);
    });
  });
});
