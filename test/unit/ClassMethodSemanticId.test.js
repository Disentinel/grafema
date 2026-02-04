/**
 * Class Method Semantic ID Tests
 *
 * Tests for REG-131: Complete Semantic ID Migration for Class Methods and Arrow Functions.
 *
 * Verifies that class methods, property functions, constructors, static methods,
 * and getters/setters all produce semantic IDs (not legacy FUNCTION# format).
 *
 * Expected format: {file}->{className}->FUNCTION->{methodName}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 * Note: Uses 'index.js' as the main file since JSModuleIndexer starts from index.js
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
function hasLegacyFunctionFormat(id) {
  if (!id || typeof id !== 'string') return false;
  return id.startsWith('FUNCTION#');
}

/**
 * Check if an ID is in semantic format
 * Semantic format: file->scope->FUNCTION->name
 */
function isSemanticFunctionId(id) {
  if (!id || typeof id !== 'string') return false;

  // Legacy format starts with FUNCTION#
  if (hasLegacyFunctionFormat(id)) return false;

  // Semantic format uses -> as separator and includes FUNCTION
  return id.includes('->FUNCTION->');
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
      const methodNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'getUser'
      );

      assert.ok(methodNode, 'FUNCTION node "getUser" not found');

      // Should have semantic ID format: test.js->UserService->FUNCTION->getUser
      assert.ok(
        isSemanticFunctionId(methodNode.id),
        `Method should have semantic ID format. Got: ${methodNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(methodNode.id),
        `Method ID should NOT start with FUNCTION#. Got: ${methodNode.id}`
      );

      // Should include class name in scope path
      assert.ok(
        methodNode.id.includes('UserService'),
        `Method ID should include class name. Got: ${methodNode.id}`
      );

      // Expected exact format
      assert.ok(
        methodNode.id.endsWith('->UserService->FUNCTION->getUser'),
        `Expected ID to end with "->UserService->FUNCTION->getUser". Got: ${methodNode.id}`
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

      const addMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'add');
      const subtractMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'subtract');
      const multiplyMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'multiply');

      assert.ok(addMethod, 'add method not found');
      assert.ok(subtractMethod, 'subtract method not found');
      assert.ok(multiplyMethod, 'multiply method not found');

      // All should have semantic IDs
      assert.ok(
        isSemanticFunctionId(addMethod.id),
        `add should have semantic ID. Got: ${addMethod.id}`
      );
      assert.ok(
        isSemanticFunctionId(subtractMethod.id),
        `subtract should have semantic ID. Got: ${subtractMethod.id}`
      );
      assert.ok(
        isSemanticFunctionId(multiplyMethod.id),
        `multiply should have semantic ID. Got: ${multiplyMethod.id}`
      );

      // All should include class name
      assert.ok(addMethod.id.includes('Calculator'), 'add should include Calculator');
      assert.ok(subtractMethod.id.includes('Calculator'), 'subtract should include Calculator');
      assert.ok(multiplyMethod.id.includes('Calculator'), 'multiply should include Calculator');

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
      const processNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'process'
      );

      assert.ok(processNode, 'FUNCTION node "process" not found');

      // Should have semantic ID format: test.js->Handler->FUNCTION->process
      assert.ok(
        isSemanticFunctionId(processNode.id),
        `Property function should have semantic ID format. Got: ${processNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(processNode.id),
        `Property function ID should NOT start with FUNCTION#. Got: ${processNode.id}`
      );

      // Should include class name
      assert.ok(
        processNode.id.includes('Handler'),
        `Property function ID should include class name. Got: ${processNode.id}`
      );

      // Expected exact format
      assert.ok(
        processNode.id.endsWith('->Handler->FUNCTION->process'),
        `Expected ID to end with "->Handler->FUNCTION->process". Got: ${processNode.id}`
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

      const onConnect = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'onConnect');
      const onDisconnect = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'onDisconnect');
      const onError = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'onError');

      assert.ok(onConnect, 'onConnect not found');
      assert.ok(onDisconnect, 'onDisconnect not found');
      assert.ok(onError, 'onError not found');

      // All should have semantic IDs
      [onConnect, onDisconnect, onError].forEach(node => {
        assert.ok(
          isSemanticFunctionId(node.id),
          `${node.name} should have semantic ID. Got: ${node.id}`
        );
        assert.ok(
          !hasLegacyFunctionFormat(node.id),
          `${node.name} should NOT have legacy format. Got: ${node.id}`
        );
        assert.ok(
          node.id.includes('EventEmitter'),
          `${node.name} should include class name. Got: ${node.id}`
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
      const constructorNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'constructor'
      );

      assert.ok(constructorNode, 'FUNCTION node "constructor" not found');

      // Should have semantic ID format: test.js->MyClass->FUNCTION->constructor
      assert.ok(
        isSemanticFunctionId(constructorNode.id),
        `Constructor should have semantic ID format. Got: ${constructorNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(constructorNode.id),
        `Constructor ID should NOT start with FUNCTION#. Got: ${constructorNode.id}`
      );

      // Should include class name
      assert.ok(
        constructorNode.id.includes('MyClass'),
        `Constructor ID should include class name. Got: ${constructorNode.id}`
      );

      // Expected exact format
      assert.ok(
        constructorNode.id.endsWith('->MyClass->FUNCTION->constructor'),
        `Expected ID to end with "->MyClass->FUNCTION->constructor". Got: ${constructorNode.id}`
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
        n.type === 'FUNCTION' && n.name === 'constructor'
      );

      assert.ok(constructorNode, 'Constructor not found');
      assert.ok(
        isSemanticFunctionId(constructorNode.id),
        `Constructor should have semantic ID. Got: ${constructorNode.id}`
      );
      assert.ok(
        constructorNode.id.includes('User'),
        `Constructor should include class name User. Got: ${constructorNode.id}`
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
        n.type === 'FUNCTION' && n.name === 'format'
      );

      assert.ok(formatNode, 'FUNCTION node "format" not found');

      // Should have semantic ID format: test.js->Utils->FUNCTION->format
      assert.ok(
        isSemanticFunctionId(formatNode.id),
        `Static method should have semantic ID format. Got: ${formatNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(formatNode.id),
        `Static method ID should NOT start with FUNCTION#. Got: ${formatNode.id}`
      );

      // Should include class name
      assert.ok(
        formatNode.id.includes('Utils'),
        `Static method ID should include class name. Got: ${formatNode.id}`
      );

      // Expected exact format
      assert.ok(
        formatNode.id.endsWith('->Utils->FUNCTION->format'),
        `Expected ID to end with "->Utils->FUNCTION->format". Got: ${formatNode.id}`
      );
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

      const addMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'add');
      const multiplyMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'multiply');
      const fetchRemoteMethod = allNodes.find(n => n.type === 'FUNCTION' && n.name === 'fetchRemote');

      assert.ok(addMethod, 'static add not found');
      assert.ok(multiplyMethod, 'static multiply not found');
      assert.ok(fetchRemoteMethod, 'static fetchRemote not found');

      // All should have semantic IDs with class name
      [addMethod, multiplyMethod, fetchRemoteMethod].forEach(node => {
        assert.ok(
          isSemanticFunctionId(node.id),
          `${node.name} should have semantic ID. Got: ${node.id}`
        );
        assert.ok(
          node.id.includes('Math'),
          `${node.name} should include class name Math. Got: ${node.id}`
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
      const getterNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'value'
      );

      assert.ok(getterNode, 'FUNCTION node "value" (getter) not found');

      // Should have semantic ID format: test.js->Config->FUNCTION->value
      assert.ok(
        isSemanticFunctionId(getterNode.id),
        `Getter should have semantic ID format. Got: ${getterNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(getterNode.id),
        `Getter ID should NOT start with FUNCTION#. Got: ${getterNode.id}`
      );

      // Should include class name
      assert.ok(
        getterNode.id.includes('Config'),
        `Getter ID should include class name. Got: ${getterNode.id}`
      );

      // Expected exact format
      assert.ok(
        getterNode.id.endsWith('->Config->FUNCTION->value'),
        `Expected ID to end with "->Config->FUNCTION->value". Got: ${getterNode.id}`
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
      const setterNode = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'value'
      );

      assert.ok(setterNode, 'FUNCTION node "value" (setter) not found');

      // Should have semantic ID format
      assert.ok(
        isSemanticFunctionId(setterNode.id),
        `Setter should have semantic ID format. Got: ${setterNode.id}`
      );

      // Should NOT start with FUNCTION#
      assert.ok(
        !hasLegacyFunctionFormat(setterNode.id),
        `Setter ID should NOT start with FUNCTION#. Got: ${setterNode.id}`
      );

      // Should include class name
      assert.ok(
        setterNode.id.includes('Config'),
        `Setter ID should include class name. Got: ${setterNode.id}`
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
      const dataFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.name === 'data'
      );

      // Should have at least one (getter/setter may be merged or separate)
      assert.ok(dataFunctions.length >= 1, 'At least one data function should exist');

      // All should have semantic IDs
      dataFunctions.forEach(node => {
        assert.ok(
          isSemanticFunctionId(node.id),
          `data function should have semantic ID. Got: ${node.id}`
        );
        assert.ok(
          node.id.includes('Store'),
          `data function should include class name Store. Got: ${node.id}`
        );
      });
    });
  });

  // ===========================================================================
  // No FUNCTION# prefix in any class method output
  // ===========================================================================

  describe('no FUNCTION# prefix in any class method output', () => {
    it('should have NO function IDs starting with FUNCTION# in class with multiple method types', async () => {
      await setupTest(backend, {
        'index.js': `
class CompleteClass {
  // Constructor
  constructor(config) {
    this.config = config;
  }

  // Regular method
  process() {
    return this.config;
  }

  // Static method
  static create(options) {
    return new CompleteClass(options);
  }

  // Getter
  get isReady() {
    return !!this.config;
  }

  // Setter
  set ready(value) {
    this.config = value ? {} : null;
  }

  // Arrow function property
  handleEvent = (event) => {
    console.log(event);
  }

  // Async method
  async fetchData() {
    return await fetch('/api');
  }

  // Generator method
  *generateItems() {
    yield 1;
    yield 2;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find all FUNCTION nodes
      const functionNodes = allNodes.filter(n => n.type === 'FUNCTION');

      // There should be multiple functions
      assert.ok(
        functionNodes.length >= 5,
        `Expected at least 5 FUNCTION nodes, got ${functionNodes.length}`
      );

      // NONE should have legacy FUNCTION# format
      const legacyNodes = functionNodes.filter(n => hasLegacyFunctionFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Found ${legacyNodes.length} functions with legacy FUNCTION# format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );

      // ALL should have semantic format
      functionNodes.forEach(node => {
        assert.ok(
          isSemanticFunctionId(node.id),
          `Function "${node.name}" should have semantic ID format. Got: ${node.id}`
        );
      });
    });

    it('should have NO FUNCTION# IDs when analyzing multiple classes', async () => {
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

      // Find all FUNCTION nodes
      const functionNodes = allNodes.filter(n => n.type === 'FUNCTION');

      // Check NO legacy format exists
      const legacyNodes = functionNodes.filter(n => hasLegacyFunctionFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Found ${legacyNodes.length} functions with legacy FUNCTION# format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );

      // Verify all methods are from their respective classes
      const methodA = allNodes.find(n => n.name === 'methodA');
      const methodB = allNodes.find(n => n.name === 'methodB');
      const handleC = allNodes.find(n => n.name === 'handleC');

      if (methodA) {
        assert.ok(methodA.id.includes('ServiceA'), `methodA should be in ServiceA. Got: ${methodA.id}`);
      }
      if (methodB) {
        assert.ok(methodB.id.includes('ServiceB'), `methodB should be in ServiceB. Got: ${methodB.id}`);
      }
      if (handleC) {
        assert.ok(handleC.id.includes('ServiceC'), `handleC should be in ServiceC. Got: ${handleC.id}`);
      }
    });
  });

  // ===========================================================================
  // Edge consistency (CallExpressionVisitor parentScopeId)
  // ===========================================================================

  describe('CONTAINS edges should use matching function IDs', () => {
    it('should have CONTAINS edges with semantic function IDs', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  helper();
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the outer function
      const outerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'outer'
      );

      assert.ok(outerFunc, 'outer function not found');
      assert.ok(
        isSemanticFunctionId(outerFunc.id),
        `outer should have semantic ID. Got: ${outerFunc.id}`
      );

      // Find CONTAINS edges from outer function
      const containsEdges = allEdges.filter(e =>
        e.type === 'CONTAINS' && e.src === outerFunc.id
      );

      // If there are CONTAINS edges, verify they reference the semantic ID
      containsEdges.forEach(edge => {
        assert.ok(
          isSemanticFunctionId(edge.src),
          `CONTAINS edge src should be semantic ID. Got: ${edge.src}`
        );
      });
    });

    it('should have CALL nodes with correct parentScopeId matching function semantic ID', async () => {
      await setupTest(backend, {
        'index.js': `
function outerFunction() {
  innerCall();
  anotherCall();
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find outer function
      const outerFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'outerFunction'
      );

      assert.ok(outerFunc, 'outerFunction not found');

      // Find CALL nodes
      const innerCall = allNodes.find(n => n.type === 'CALL' && n.name === 'innerCall');
      const anotherCall = allNodes.find(n => n.type === 'CALL' && n.name === 'anotherCall');

      // Find CONTAINS edges from outer function
      const containsFromOuter = allEdges.filter(e =>
        e.type === 'CONTAINS' && e.src === outerFunc.id
      );

      // The calls should be contained by the outer function
      // Verify edge source matches the semantic ID
      if (innerCall) {
        const edgeToInner = containsFromOuter.find(e => e.dst === innerCall.id);
        if (edgeToInner) {
          assert.strictEqual(
            edgeToInner.src,
            outerFunc.id,
            `CONTAINS edge to innerCall should have outer function's semantic ID as source`
          );
        }
      }
    });
  });

  // ===========================================================================
  // Stability: ID should not depend on line number
  // ===========================================================================

  describe('semantic ID stability', () => {
    it('should produce same ID when class method moves to different line', async () => {
      // First analysis
      await setupTest(backend, {
        'index.js': `
class Service {
  method() {}
}
        `
      });

      const nodes1 = await backend.getAllNodes();
      const method1 = nodes1.find(n => n.type === 'FUNCTION' && n.name === 'method');
      const id1 = method1?.id;
      const line1 = method1?.line;

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
      const method2 = nodes2.find(n => n.type === 'FUNCTION' && n.name === 'method');
      const id2 = method2?.id;
      const line2 = method2?.line;

      assert.ok(method1, 'method should exist in first analysis');
      assert.ok(method2, 'method should exist in second analysis');

      // IDs should be IDENTICAL (semantic, line-independent)
      assert.strictEqual(
        id1,
        id2,
        `Semantic ID should be stable across line changes. Before: ${id1}, After: ${id2}`
      );

      // But line numbers should differ
      assert.notStrictEqual(
        line1,
        line2,
        'Line numbers should differ between analyses'
      );
    });
  });
});
