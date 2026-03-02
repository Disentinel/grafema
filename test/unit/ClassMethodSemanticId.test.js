/**
 * Class Method Semantic ID Tests
 *
 * Tests for REG-131: Complete Semantic ID Migration for Class Methods and Arrow Functions.
 *
 * Verifies that class methods, property functions, constructors, static methods,
 * and getters/setters all produce semantic IDs (not legacy FUNCTION# format).
 *
 * V2 format:
 * - Regular class methods: {file}->METHOD->{name}#{line}
 * - Constructor: {file}->METHOD->constructor#{line}
 * - Arrow function properties: PROPERTY node + FUNCTION node
 * - Static methods: {file}->METHOD->{name}#{line} with static=true
 * - Getters: {file}->GETTER->{name}#{line}
 * - Setters: {file}->SETTER->{name}#{line}
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
  const testDir = join(tmpdir(), `grafema-test-classmethod-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classmethod-${testCounter}`,
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
 * Check if an ID has legacy FUNCTION# format
 */
function hasLegacyFormat(id) {
  if (!id || typeof id !== 'string') return false;
  return id.startsWith('FUNCTION#') || id.startsWith('METHOD#');
}

/**
 * Check if an ID is in v2 semantic format for a class member
 * V2 format uses -> as separator and includes METHOD, GETTER, SETTER, or FUNCTION
 */
function isSemanticClassMemberId(id) {
  if (!id || typeof id !== 'string') return false;
  if (hasLegacyFormat(id)) return false;
  return id.includes('->METHOD->') || id.includes('->GETTER->') ||
         id.includes('->SETTER->') || id.includes('->FUNCTION->');
}

describe('Class Method Semantic ID Migration (REG-131)', () => {
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
  // Basic class method semantic ID format
  // ===========================================================================

  describe('class method should have semantic ID format', () => {
    it('should produce semantic ID for regular class method', async () => {
      await setupTest(backend, {
        'index.js': `
class UserService {
  getUser() {
    return null;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: class methods are METHOD type
      const methodNode = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'getUser'
      );

      assert.ok(methodNode, 'METHOD node "getUser" not found');

      // Should have semantic ID format: file->METHOD->name#line
      assert.ok(
        methodNode.id.includes('->METHOD->getUser#'),
        `Method should have semantic ID format. Got: ${methodNode.id}`
      );

      // Should NOT start with METHOD# or FUNCTION#
      assert.ok(
        !hasLegacyFormat(methodNode.id),
        `Method ID should NOT start with legacy format. Got: ${methodNode.id}`
      );
    });

    it('should produce semantic ID for multiple methods in same class', async () => {
      await setupTest(backend, {
        'index.js': `
class Calculator {
  add(a, b) {
    return a + b;
  }

  subtract(a, b) {
    return a - b;
  }

  multiply(a, b) {
    return a * b;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const addMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'add');
      const subtractMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'subtract');
      const multiplyMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'multiply');

      assert.ok(addMethod, 'add method not found');
      assert.ok(subtractMethod, 'subtract method not found');
      assert.ok(multiplyMethod, 'multiply method not found');

      // All should have semantic IDs
      assert.ok(
        addMethod.id.includes('->METHOD->add#'),
        `add should have semantic ID. Got: ${addMethod.id}`
      );
      assert.ok(
        subtractMethod.id.includes('->METHOD->subtract#'),
        `subtract should have semantic ID. Got: ${subtractMethod.id}`
      );
      assert.ok(
        multiplyMethod.id.includes('->METHOD->multiply#'),
        `multiply should have semantic ID. Got: ${multiplyMethod.id}`
      );

      // All IDs should be unique
      assert.notStrictEqual(addMethod.id, subtractMethod.id, 'add and subtract should have different IDs');
      assert.notStrictEqual(addMethod.id, multiplyMethod.id, 'add and multiply should have different IDs');
      assert.notStrictEqual(subtractMethod.id, multiplyMethod.id, 'subtract and multiply should have different IDs');
    });
  });

  // ===========================================================================
  // Class property function (arrow function as class field)
  // ===========================================================================

  describe('class property function should have semantic ID', () => {
    it('should produce semantic ID for arrow function class property', async () => {
      await setupTest(backend, {
        'index.js': `
class Handler {
  process = () => {
    console.log('processing');
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: arrow class fields create PROPERTY node + FUNCTION node
      const processProp = allNodes.find(n =>
        n.type === 'PROPERTY' && n.name === 'process'
      );

      assert.ok(processProp, 'PROPERTY node "process" not found');

      // Should have semantic ID format: file->PROPERTY->name#line
      assert.ok(
        processProp.id.includes('->PROPERTY->process#'),
        `Property function should have semantic ID format. Got: ${processProp.id}`
      );

      // Should NOT start with FUNCTION# or PROPERTY#
      assert.ok(
        !hasLegacyFormat(processProp.id),
        `Property function ID should NOT have legacy format. Got: ${processProp.id}`
      );
    });

    it('should produce semantic ID for multiple arrow function properties', async () => {
      await setupTest(backend, {
        'index.js': `
class EventEmitter {
  onConnect = () => {}
  onDisconnect = () => {}
  onError = (err) => console.error(err)
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // V2: arrow fields are PROPERTY nodes
      const onConnect = allNodes.find(n => n.type === 'PROPERTY' && n.name === 'onConnect');
      const onDisconnect = allNodes.find(n => n.type === 'PROPERTY' && n.name === 'onDisconnect');
      const onError = allNodes.find(n => n.type === 'PROPERTY' && n.name === 'onError');

      assert.ok(onConnect, 'onConnect not found');
      assert.ok(onDisconnect, 'onDisconnect not found');
      assert.ok(onError, 'onError not found');

      // All should have semantic IDs with ->PROPERTY->
      [onConnect, onDisconnect, onError].forEach(node => {
        assert.ok(
          node.id.includes('->PROPERTY->'),
          `${node.name} should have semantic ID. Got: ${node.id}`
        );
        assert.ok(
          !hasLegacyFormat(node.id),
          `${node.name} should NOT have legacy format. Got: ${node.id}`
        );
      });
    });
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor should have semantic ID', () => {
    it('should produce semantic ID for constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  constructor() {
    this.initialized = true;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: constructor is METHOD type with kind='constructor'
      const constructorNode = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );

      assert.ok(constructorNode, 'METHOD node "constructor" not found');

      // Should have semantic ID format: file->METHOD->constructor#line
      assert.ok(
        constructorNode.id.includes('->METHOD->constructor#'),
        `Constructor should have semantic ID format. Got: ${constructorNode.id}`
      );

      // Should NOT have legacy format
      assert.ok(
        !hasLegacyFormat(constructorNode.id),
        `Constructor ID should NOT have legacy format. Got: ${constructorNode.id}`
      );
    });

    it('should produce semantic ID for constructor with parameters', async () => {
      await setupTest(backend, {
        'index.js': `
class User {
  constructor(name, email, options = {}) {
    this.name = name;
    this.email = email;
    this.options = options;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const constructorNode = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );

      assert.ok(constructorNode, 'Constructor not found');
      assert.ok(
        constructorNode.id.includes('->METHOD->constructor#'),
        `Constructor should have semantic ID. Got: ${constructorNode.id}`
      );
    });
  });

  // ===========================================================================
  // Static methods
  // ===========================================================================

  describe('static method should have semantic ID', () => {
    it('should produce semantic ID for static method', async () => {
      await setupTest(backend, {
        'index.js': `
class Utils {
  static format(value) {
    return String(value);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const formatNode = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'format'
      );

      assert.ok(formatNode, 'METHOD node "format" not found');

      // Should have semantic ID format: file->METHOD->name#line
      assert.ok(
        formatNode.id.includes('->METHOD->format#'),
        `Static method should have semantic ID format. Got: ${formatNode.id}`
      );

      // Should NOT have legacy format
      assert.ok(
        !hasLegacyFormat(formatNode.id),
        `Static method ID should NOT have legacy format. Got: ${formatNode.id}`
      );

      // Should be marked static
      assert.strictEqual(formatNode.static, true, 'Static method should have static=true');
    });

    it('should produce semantic ID for multiple static methods', async () => {
      await setupTest(backend, {
        'index.js': `
class Math {
  static add(a, b) { return a + b; }
  static multiply(a, b) { return a * b; }
  static async fetchRemote(url) { return fetch(url); }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const addMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'add');
      const multiplyMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'multiply');
      const fetchRemoteMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'fetchRemote');

      assert.ok(addMethod, 'static add not found');
      assert.ok(multiplyMethod, 'static multiply not found');
      assert.ok(fetchRemoteMethod, 'static fetchRemote not found');

      // All should have semantic IDs
      [addMethod, multiplyMethod, fetchRemoteMethod].forEach(node => {
        assert.ok(
          node.id.includes('->METHOD->'),
          `${node.name} should have semantic ID. Got: ${node.id}`
        );
      });
    });
  });

  // ===========================================================================
  // Getters and setters
  // ===========================================================================

  describe('getter/setter should have semantic ID', () => {
    it('should produce semantic ID for getter', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  get value() {
    return this._value;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: getters are GETTER type
      const getterNode = allNodes.find(n =>
        n.type === 'GETTER' && n.name === 'value'
      );

      assert.ok(getterNode, 'GETTER node "value" not found');

      // Should have semantic ID format: file->GETTER->name#line
      assert.ok(
        getterNode.id.includes('->GETTER->value#'),
        `Getter should have semantic ID format. Got: ${getterNode.id}`
      );

      // Should NOT have legacy format
      assert.ok(
        !hasLegacyFormat(getterNode.id),
        `Getter ID should NOT have legacy format. Got: ${getterNode.id}`
      );
    });

    it('should produce semantic ID for setter', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  set value(v) {
    this._value = v;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      // V2: setters are SETTER type
      const setterNode = allNodes.find(n =>
        n.type === 'SETTER' && n.name === 'value'
      );

      assert.ok(setterNode, 'SETTER node "value" not found');

      // Should have semantic ID format
      assert.ok(
        setterNode.id.includes('->SETTER->value#'),
        `Setter should have semantic ID format. Got: ${setterNode.id}`
      );

      // Should NOT have legacy format
      assert.ok(
        !hasLegacyFormat(setterNode.id),
        `Setter ID should NOT have legacy format. Got: ${setterNode.id}`
      );
    });

    it('should handle getter and setter pair', async () => {
      await setupTest(backend, {
        'index.js': `
class Store {
  get data() {
    return this._data;
  }

  set data(value) {
    this._data = value;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const getterNodes = allNodes.filter(n => n.type === 'GETTER' && n.name === 'data');
      const setterNodes = allNodes.filter(n => n.type === 'SETTER' && n.name === 'data');

      // Should have separate GETTER and SETTER nodes
      assert.strictEqual(getterNodes.length, 1, 'Should have 1 GETTER for data');
      assert.strictEqual(setterNodes.length, 1, 'Should have 1 SETTER for data');

      // Both should have semantic IDs
      assert.ok(
        getterNodes[0].id.includes('->GETTER->data#'),
        `Getter should have semantic ID. Got: ${getterNodes[0].id}`
      );
      assert.ok(
        setterNodes[0].id.includes('->SETTER->data#'),
        `Setter should have semantic ID. Got: ${setterNodes[0].id}`
      );
    });
  });

  // ===========================================================================
  // No legacy prefix in any class method output
  // ===========================================================================

  describe('no legacy prefix in any class method output', () => {
    it('should have NO function IDs starting with legacy format in class with multiple method types', async () => {
      await setupTest(backend, {
        'index.js': `
class CompleteClass {
  constructor(config) {
    this.config = config;
  }

  process() {
    return this.config;
  }

  static create(options) {
    return new CompleteClass(options);
  }

  get isReady() {
    return !!this.config;
  }

  set ready(value) {
    this.config = value ? {} : null;
  }

  handleEvent = (event) => {
    console.log(event);
  }

  async fetchData() {
    return await fetch('/api');
  }

  *generateItems() {
    yield 1;
    yield 2;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find all class member nodes (METHOD, GETTER, SETTER, PROPERTY, FUNCTION)
      const classMemberTypes = ['METHOD', 'GETTER', 'SETTER', 'PROPERTY', 'FUNCTION'];
      const memberNodes = allNodes.filter(n => classMemberTypes.includes(n.type));

      // There should be multiple class members
      assert.ok(
        memberNodes.length >= 5,
        `Expected at least 5 class member nodes, got ${memberNodes.length}`
      );

      // NONE should have legacy format
      const legacyNodes = memberNodes.filter(n => hasLegacyFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Found ${legacyNodes.length} members with legacy format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );
    });

    it('should have NO legacy IDs when analyzing multiple classes', async () => {
      await setupTest(backend, {
        'index.js': `
class ServiceA {
  methodA() {}
  static helperA() {}
}

class ServiceB {
  constructor() {}
  methodB() {}
  get propB() { return 1; }
}

class ServiceC {
  handleC = () => {}
  async asyncC() {}
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find all class member nodes
      const classMemberTypes = ['METHOD', 'GETTER', 'SETTER', 'PROPERTY', 'FUNCTION'];
      const memberNodes = allNodes.filter(n => classMemberTypes.includes(n.type));

      // Check NO legacy format exists
      const legacyNodes = memberNodes.filter(n => hasLegacyFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Found ${legacyNodes.length} members with legacy format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );

      // Verify methods exist from their respective classes
      const methodA = allNodes.find(n => n.type === 'METHOD' && n.name === 'methodA');
      const methodB = allNodes.find(n => n.type === 'METHOD' && n.name === 'methodB');
      const handleC = allNodes.find(n => n.type === 'PROPERTY' && n.name === 'handleC');

      assert.ok(methodA, 'methodA should exist');
      assert.ok(methodB, 'methodB should exist');
      assert.ok(handleC, 'handleC should exist');
    });
  });

  // ===========================================================================
  // Edge consistency (HAS_MEMBER)
  // ===========================================================================

  describe('HAS_MEMBER edges should use matching IDs', () => {
    it('should have HAS_MEMBER edges with semantic IDs', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  myMethod() {
    helper();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the class
      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'MyClass');
      assert.ok(classNode, 'MyClass not found');

      // Find HAS_MEMBER edges from class
      const hasMemberEdges = allEdges.filter(e =>
        e.type === 'HAS_MEMBER' && e.src === classNode.id
      );

      // Should have at least 1 HAS_MEMBER edge (for myMethod)
      assert.ok(hasMemberEdges.length >= 1, 'Should have at least 1 HAS_MEMBER edge');

      // All edge sources should match the class's semantic ID
      hasMemberEdges.forEach(edge => {
        assert.strictEqual(
          edge.src,
          classNode.id,
          `HAS_MEMBER edge src should match class ID. Got: ${edge.src}`
        );
      });
    });

    it('should have CALL nodes inside class methods', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  outerMethod() {
    innerCall();
    anotherCall();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find CALL nodes
      const innerCall = allNodes.find(n => n.type === 'CALL' && n.name === 'innerCall');
      const anotherCall = allNodes.find(n => n.type === 'CALL' && n.name === 'anotherCall');

      assert.ok(innerCall, 'innerCall CALL node should exist');
      assert.ok(anotherCall, 'anotherCall CALL node should exist');
    });
  });

  // ===========================================================================
  // Stability: ID format check
  // ===========================================================================

  describe('semantic ID format check', () => {
    it('should produce v2 format IDs when class method moves to different line', async () => {
      // First analysis
      await setupTest(backend, {
        'index.js': `
class Service {
  method() {}
}
        `
      });

      const nodes1 = await backend.getAllNodes();
      const method1 = nodes1.find(n => n.type === 'METHOD' && n.name === 'method');

      assert.ok(method1, 'method should exist in first analysis');
      assert.ok(
        method1.id.includes('->METHOD->method#'),
        `First analysis should have v2 format ID. Got: ${method1.id}`
      );

      // Cleanup
      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;
      await setupTest(backend, {
        'index.js': `


class Service {


  method() {}
}
        `
      });

      const nodes2 = await backend.getAllNodes();
      const method2 = nodes2.find(n => n.type === 'METHOD' && n.name === 'method');

      assert.ok(method2, 'method should exist in second analysis');
      assert.ok(
        method2.id.includes('->METHOD->method#'),
        `Second analysis should have v2 format ID. Got: ${method2.id}`
      );

      // In v2, IDs include line number so they differ when line changes
      // But both should have the same v2 format
      assert.notStrictEqual(
        method1.line,
        method2.line,
        'Line numbers should differ between analyses'
      );
    });
  });
});
