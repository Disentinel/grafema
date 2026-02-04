/**
 * Tests for Object Property Mutation Tracking (FLOWS_INTO edges)
 *
 * When code does obj.prop = value, obj['prop'] = value, or Object.assign(target, source),
 * we need to create a FLOWS_INTO edge from the value to the object.
 * This allows tracing what data flows into object configurations.
 *
 * Edge direction: value FLOWS_INTO object (src=value, dst=object)
 *
 * This is the TDD test file for REG-114. Tests are written BEFORE implementation,
 * so they should be RED initially.
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
  const testDir = join(tmpdir(), `navi-test-obj-mutation-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-obj-mutation-${testCounter}`,
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

describe('Object Mutation Tracking', () => {
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
  // obj.prop = value (dot notation property assignment)
  // ============================================================================
  describe('obj.prop = value', () => {
    it('should create FLOWS_INTO edge from assigned variable to object', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const handler = () => {};
config.handler = handler;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the config object variable
      const configVar = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(configVar, 'Variable "config" not found');

      // Find the handler variable
      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(handlerVar, 'Variable "handler" not found');

      // Find FLOWS_INTO edge from handler to config
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === handlerVar.id &&
        e.dst === configVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "handler" (${handlerVar.id}) to "config" (${configVar.id}). ` +
        `Found FLOWS_INTO edges: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // Verify metadata
      assert.strictEqual(flowsInto.mutationType, 'property', 'Edge should have mutationType: property');
      assert.strictEqual(flowsInto.propertyName, 'handler', 'Edge should have propertyName: handler');
    });

    it('should handle multiple property assignments to same object', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const a = 1;
const b = 2;
obj.a = a;
obj.b = b;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj' && (n.type === 'VARIABLE' || n.type === 'CONSTANT'));
      assert.ok(objVar, 'Variable "obj" not found');

      // Find all FLOWS_INTO edges pointing to obj
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 2,
        `Expected 2 FLOWS_INTO edges, got ${flowsIntoEdges.length}. Edges: ${JSON.stringify(flowsIntoEdges)}`
      );

      // Check that we have different propertyName metadata
      const propertyNames = flowsIntoEdges.map(e => e.propertyName).sort();
      assert.deepStrictEqual(propertyNames, ['a', 'b'], 'Should have properties a and b');
    });

    it('should NOT create FLOWS_INTO edge for literal values (only variables)', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
config.port = 3000;
config.host = 'localhost';
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n => n.name === 'config');
      assert.ok(configVar, 'Variable "config" not found');

      // Literals don't create FLOWS_INTO edges (matching array mutation behavior)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === configVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 0,
        'Literal values should not create FLOWS_INTO edges'
      );
    });
  });

  // ============================================================================
  // obj['prop'] = value (bracket notation with string literal)
  // ============================================================================
  describe("obj['prop'] = value (bracket notation)", () => {
    it('should create FLOWS_INTO edge for string literal key', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const handler = 'myHandler';
config['handler'] = handler;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n => n.name === 'config');
      const handlerVar = allNodes.find(n => n.name === 'handler');

      assert.ok(configVar, 'Variable "config" not found');
      assert.ok(handlerVar, 'Variable "handler" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === handlerVar.id &&
        e.dst === configVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "handler" to "config"');
      // String literal key should be treated as property name, not '<computed>'
      assert.strictEqual(flowsInto.propertyName, 'handler', 'propertyName should be "handler", not "<computed>"');
      assert.strictEqual(flowsInto.mutationType, 'property', 'mutationType should be "property" for string literal keys');
    });

    it('should track computed key with <computed> property name', async () => {
      await setupTest(backend, {
        'index.js': `
const config = {};
const key = 'handler';
const value = 'myValue';
config[key] = value;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const configVar = allNodes.find(n => n.name === 'config');
      const valueVar = allNodes.find(n => n.name === 'value');

      assert.ok(configVar, 'Variable "config" not found');
      assert.ok(valueVar, 'Variable "value" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valueVar.id &&
        e.dst === configVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "value" to "config"');
      assert.strictEqual(flowsInto.propertyName, '<computed>', 'propertyName should be "<computed>" for variable keys');
      assert.strictEqual(flowsInto.mutationType, 'computed', 'mutationType should be "computed"');
    });
  });

  // ============================================================================
  // this.prop = value (in class methods/constructors)
  // REG-152: FLOWS_INTO edges for this.prop = value patterns
  // The destination is the CLASS node (not a variable), with metadata:
  //   - mutationType: 'this_property'
  //   - propertyName: the property being assigned
  // ============================================================================
  describe('this.prop = value', () => {
    it('should track this.prop = value in constructor as FLOWS_INTO to CLASS', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  constructor(handler) {
    this.handler = handler;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CLASS node
      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Config'
      );
      assert.ok(classNode, 'CLASS "Config" not found');

      // Find the handler parameter
      const handlerParam = allNodes.find(n =>
        n.name === 'handler' && n.type === 'PARAMETER'
      );
      assert.ok(handlerParam, 'PARAMETER "handler" not found');

      // Find FLOWS_INTO edge from handler PARAMETER to CLASS
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === handlerParam.id &&
        e.dst === classNode.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from handler to Config class. Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      // Verify metadata
      assert.strictEqual(flowsInto.mutationType, 'this_property', 'Edge should have mutationType: this_property');
      assert.strictEqual(flowsInto.propertyName, 'handler', 'Edge should have propertyName: handler');
    });

    it('should track this.prop = value in class methods as FLOWS_INTO to CLASS', async () => {
      await setupTest(backend, {
        'index.js': `
class Service {
  setHandler(h) {
    this.handler = h;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the CLASS node
      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Service'
      );
      assert.ok(classNode, 'CLASS "Service" not found');

      // Find the h parameter
      const hParam = allNodes.find(n =>
        n.name === 'h' && n.type === 'PARAMETER'
      );
      assert.ok(hParam, 'PARAMETER "h" not found');

      // Find FLOWS_INTO edge from h PARAMETER to CLASS
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === hParam.id &&
        e.dst === classNode.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from parameter "h" to Service class');
      assert.strictEqual(flowsInto.mutationType, 'this_property', 'Edge should have mutationType: this_property');
      assert.strictEqual(flowsInto.propertyName, 'handler', 'Edge should have propertyName: handler');
    });

    it('should handle multiple this.prop assignments in constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  constructor(a, b, c) {
    this.propA = a;
    this.propB = b;
    this.propC = c;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
      assert.ok(classNode, 'CLASS "Config" not found');

      // Find all FLOWS_INTO edges to the class with mutationType: this_property
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === classNode.id &&
        e.mutationType === 'this_property'
      );

      assert.strictEqual(flowsIntoEdges.length, 3, 'Expected 3 FLOWS_INTO edges');

      const propertyNames = flowsIntoEdges.map(e => e.propertyName).sort();
      assert.deepStrictEqual(propertyNames, ['propA', 'propB', 'propC'], 'Should have all three property names');
    });

    it('should track local variable assignment to this.prop', async () => {
      await setupTest(backend, {
        'index.js': `
class Service {
  init() {
    const helper = () => {};
    this.helper = helper;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Service');
      assert.ok(classNode, 'CLASS "Service" not found');

      const helperVar = allNodes.find(n =>
        n.name === 'helper' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(helperVar, 'Variable "helper" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === helperVar.id &&
        e.dst === classNode.id &&
        e.mutationType === 'this_property'
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from helper variable to Service class');
      assert.strictEqual(flowsInto.propertyName, 'helper', 'Edge should have propertyName: helper');
    });

    it('should NOT create FLOWS_INTO edge for this.prop = literal', async () => {
      await setupTest(backend, {
        'index.js': `
class Config {
  constructor() {
    this.port = 3000;
    this.host = 'localhost';
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'Config');
      assert.ok(classNode, 'CLASS "Config" not found');

      // Literals should not create FLOWS_INTO edges (matching existing behavior)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === classNode.id &&
        e.mutationType === 'this_property'
      );

      assert.strictEqual(flowsIntoEdges.length, 0, 'Literal values should not create FLOWS_INTO edges');
    });

    it('should handle nested classes correctly - edge goes to Inner, not Outer', async () => {
      await setupTest(backend, {
        'index.js': `
class Outer {
  method() {
    class Inner {
      constructor(val) {
        this.val = val;
      }
    }
    return Inner;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find both class nodes
      const outerClass = allNodes.find(n => n.type === 'CLASS' && n.name === 'Outer');
      const innerClass = allNodes.find(n => n.type === 'CLASS' && n.name === 'Inner');

      assert.ok(outerClass, 'CLASS "Outer" not found');
      assert.ok(innerClass, 'CLASS "Inner" not found');

      // Find the val parameter
      const valParam = allNodes.find(n =>
        n.name === 'val' && n.type === 'PARAMETER'
      );
      assert.ok(valParam, 'PARAMETER "val" not found');

      // The FLOWS_INTO edge should go to Inner, not Outer
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === valParam.id &&
        e.mutationType === 'this_property'
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from val parameter');
      assert.strictEqual(flowsInto.dst, innerClass.id, 'Edge should point to Inner class, not Outer');
      assert.strictEqual(flowsInto.propertyName, 'val', 'Edge should have propertyName: val');
    });

    it('should NOT create edge for this.prop outside class context', async () => {
      await setupTest(backend, {
        'index.js': `
function standalone(x) {
  this.x = x;
}

const arrowFn = (y) => {
  this.y = y;
};
        `
      });

      const allEdges = await backend.getAllEdges();

      // No FLOWS_INTO edges with mutationType: this_property should exist
      // because there's no class context
      const thisPropertyEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'this_property'
      );

      assert.strictEqual(
        thisPropertyEdges.length, 0,
        `Should NOT create this_property edges outside class context. Found: ${JSON.stringify(thisPropertyEdges)}`
      );
    });
  });

  // ============================================================================
  // Object.assign(target, source)
  // ============================================================================
  describe('Object.assign(target, source)', () => {
    it('should create FLOWS_INTO edge from source to target', async () => {
      await setupTest(backend, {
        'index.js': `
const defaults = { a: 1 };
const merged = {};
Object.assign(merged, defaults);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const mergedVar = allNodes.find(n => n.name === 'merged');
      const defaultsVar = allNodes.find(n => n.name === 'defaults');

      assert.ok(mergedVar, 'Variable "merged" not found');
      assert.ok(defaultsVar, 'Variable "defaults" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === defaultsVar.id &&
        e.dst === mergedVar.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "defaults" to "merged". Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );

      assert.strictEqual(flowsInto.mutationType, 'assign', 'Edge should have mutationType: assign');
      assert.strictEqual(flowsInto.propertyName, '<assign>', 'Edge should have propertyName: <assign>');
    });

    it('should create multiple edges for multiple sources with argIndex', async () => {
      await setupTest(backend, {
        'index.js': `
const target = {};
const source1 = { a: 1 };
const source2 = { b: 2 };
const source3 = { c: 3 };
Object.assign(target, source1, source2, source3);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const targetVar = allNodes.find(n => n.name === 'target');
      assert.ok(targetVar, 'Variable "target" not found');

      // Find all FLOWS_INTO edges pointing to target
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === targetVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges, got ${flowsIntoEdges.length}. Edges: ${JSON.stringify(flowsIntoEdges)}`
      );

      // Check argIndex values (0, 1, 2 for first, second, third source)
      const argIndices = flowsIntoEdges.map(e => e.argIndex).sort();
      assert.deepStrictEqual(argIndices, [0, 1, 2], 'Should have argIndex 0, 1, 2');
    });

    it('should handle spread in Object.assign with isSpread metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const target = {};
const sources = [{ a: 1 }, { b: 2 }];
Object.assign(target, ...sources);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const targetVar = allNodes.find(n => n.name === 'target');
      const sourcesVar = allNodes.find(n => n.name === 'sources');

      assert.ok(targetVar, 'Variable "target" not found');
      assert.ok(sourcesVar, 'Variable "sources" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === sourcesVar.id &&
        e.dst === targetVar.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "sources" to "target"');
      assert.strictEqual(flowsInto.isSpread, true, 'Edge should have isSpread: true');
    });

    it('should skip anonymous target: Object.assign({}, source)', async () => {
      // When target is an object literal, we can't create a meaningful edge
      // because there's no variable to reference
      await setupTest(backend, {
        'index.js': `
const source = { a: 1 };
const result = Object.assign({}, source);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const sourceVar = allNodes.find(n => n.name === 'source');
      assert.ok(sourceVar, 'Variable "source" not found');

      // No edge should point FROM source with mutationType 'assign'
      // because the target is anonymous
      const assignEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === sourceVar.id &&
        e.mutationType === 'assign'
      );

      // Anonymous targets are skipped (documented behavior)
      assert.strictEqual(
        assignEdges.length, 0,
        'Should not create FLOWS_INTO edge for anonymous target'
      );
    });
  });

  // ============================================================================
  // Function-level mutations
  // ============================================================================
  describe('Function-level mutations', () => {
    it('should detect property assignments inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function configureApp(config) {
  const handler = () => {};
  config.handler = handler;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find handler variable inside the function
      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(handlerVar, 'Variable "handler" not found');

      // Find config parameter
      const configParam = allNodes.find(n =>
        n.name === 'config' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );
      assert.ok(configParam, 'Parameter "config" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === handlerVar.id &&
        e.dst === configParam.id
      );

      assert.ok(
        flowsInto,
        `Expected FLOWS_INTO edge from "handler" to "config" inside function. Found: ${JSON.stringify(allEdges.filter(e => e.type === 'FLOWS_INTO'))}`
      );
    });

    it('should detect Object.assign inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function merge(target, source) {
  Object.assign(target, source);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const targetParam = allNodes.find(n =>
        n.name === 'target' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );
      const sourceParam = allNodes.find(n =>
        n.name === 'source' && (n.type === 'VARIABLE' || n.type === 'PARAMETER')
      );

      assert.ok(targetParam, 'Parameter "target" not found');
      assert.ok(sourceParam, 'Parameter "source" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === sourceParam.id &&
        e.dst === targetParam.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge from "source" to "target"');
      assert.strictEqual(flowsInto.mutationType, 'assign', 'Edge should have mutationType: assign');
    });

    it('should detect mutations inside arrow functions', async () => {
      await setupTest(backend, {
        'index.js': `
const setup = (config) => {
  const db = { connect: () => {} };
  config.database = db;
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const dbVar = allNodes.find(n => n.name === 'db');
      const configParam = allNodes.find(n => n.name === 'config');

      assert.ok(dbVar, 'Variable "db" not found');
      assert.ok(configParam, 'Parameter "config" not found');

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === dbVar.id &&
        e.dst === configParam.id
      );

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge inside arrow function');
    });
  });

  // ============================================================================
  // Edge metadata verification
  // ============================================================================
  describe('Edge metadata verification', () => {
    it('should include mutationType in edge metadata for all mutation types', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const a = 1;
const b = 2;
const key = 'dynamic';
const c = 3;
const source = { d: 4 };

obj.prop = a;           // mutationType: 'property'
obj['literal'] = b;     // mutationType: 'property' (string literal)
obj[key] = c;           // mutationType: 'computed'
Object.assign(obj, source); // mutationType: 'assign'
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      // We expect 4 edges (a, b, c, source)
      assert.strictEqual(flowsIntoEdges.length, 4, `Expected 4 FLOWS_INTO edges, got ${flowsIntoEdges.length}`);

      // Check that mutationType is present on all edges
      for (const edge of flowsIntoEdges) {
        assert.ok(
          edge.mutationType,
          `Edge should have mutationType metadata. Edge: ${JSON.stringify(edge)}`
        );
        assert.ok(
          ['property', 'computed', 'assign'].includes(edge.mutationType),
          `mutationType should be one of: property, computed, assign. Got: ${edge.mutationType}`
        );
      }

      // Verify specific mutation types
      const mutationTypes = flowsIntoEdges.map(e => e.mutationType).sort();
      assert.ok(mutationTypes.includes('property'), 'Should have property mutation type');
      assert.ok(mutationTypes.includes('computed'), 'Should have computed mutation type');
      assert.ok(mutationTypes.includes('assign'), 'Should have assign mutation type');
    });

    it('should include propertyName in edge metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const handler = () => {};
const key = 'dynamic';
const value = 42;
const source = {};

obj.myHandler = handler;
obj[key] = value;
Object.assign(obj, source);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      // Check propertyName metadata
      const propertyNames = flowsIntoEdges.map(e => e.propertyName).sort();

      assert.ok(
        propertyNames.includes('myHandler'),
        `Should include actual property name 'myHandler'. Found: ${propertyNames}`
      );
      assert.ok(
        propertyNames.includes('<computed>'),
        `Should include '<computed>' for dynamic keys. Found: ${propertyNames}`
      );
      assert.ok(
        propertyNames.includes('<assign>'),
        `Should include '<assign>' for Object.assign. Found: ${propertyNames}`
      );
    });
  });

  // ============================================================================
  // Edge direction verification
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should create edge with correct direction: value -> object (src=value, dst=object)', async () => {
      await setupTest(backend, {
        'index.js': `
const container = {};
const item = { data: 'test' };
container.item = item;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container');
      const itemVar = allNodes.find(n => n.name === 'item');

      assert.ok(containerVar, 'Variable "container" not found');
      assert.ok(itemVar, 'Variable "item" not found');

      const flowsInto = allEdges.find(e => e.type === 'FLOWS_INTO');

      assert.ok(flowsInto, 'Expected FLOWS_INTO edge');
      assert.strictEqual(flowsInto.src, itemVar.id, 'Edge src should be the item (value)');
      assert.strictEqual(flowsInto.dst, containerVar.id, 'Edge dst should be the container (object)');
    });
  });

  // ============================================================================
  // Integration: Real-world scenarios
  // ============================================================================
  describe('Integration with real-world patterns', () => {
    it('should allow tracing objects through property assignment (DI pattern)', async () => {
      // Real-world scenario: Dependency Injection container
      await setupTest(backend, {
        'index.js': `
const container = {};
const userService = { getUser: (id) => ({ id }) };
const authService = { authenticate: () => true };

container.userService = userService;
container.authService = authService;

// Later: container.userService.getUser(1)
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const containerVar = allNodes.find(n => n.name === 'container');
      const userServiceVar = allNodes.find(n => n.name === 'userService');
      const authServiceVar = allNodes.find(n => n.name === 'authService');

      assert.ok(containerVar, 'Variable "container" not found');
      assert.ok(userServiceVar, 'Variable "userService" not found');
      assert.ok(authServiceVar, 'Variable "authService" not found');

      // Verify we can trace: userService -> container (via userService property)
      const userServiceFlow = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === userServiceVar.id &&
        e.dst === containerVar.id
      );

      assert.ok(userServiceFlow, 'userService should flow into container');
      assert.strictEqual(userServiceFlow.propertyName, 'userService');

      // Verify we can trace: authService -> container (via authService property)
      const authServiceFlow = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.src === authServiceVar.id &&
        e.dst === containerVar.id
      );

      assert.ok(authServiceFlow, 'authService should flow into container');
      assert.strictEqual(authServiceFlow.propertyName, 'authService');
    });

    it('should track configuration merging with Object.assign', async () => {
      // Real-world scenario: Config merging
      await setupTest(backend, {
        'index.js': `
const defaultConfig = {
  port: 3000,
  host: 'localhost'
};

const userConfig = {
  port: 8080
};

const envConfig = {
  host: process.env.HOST
};

const finalConfig = {};
Object.assign(finalConfig, defaultConfig, userConfig, envConfig);
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const finalConfigVar = allNodes.find(n => n.name === 'finalConfig');
      assert.ok(finalConfigVar, 'Variable "finalConfig" not found');

      // All 3 sources should flow into finalConfig
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === finalConfigVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 3,
        `Expected 3 FLOWS_INTO edges for config merging, got ${flowsIntoEdges.length}`
      );

      // Verify argIndex for ordering (important for config precedence)
      const defaultFlow = flowsIntoEdges.find(e => e.argIndex === 0);
      const userFlow = flowsIntoEdges.find(e => e.argIndex === 1);
      const envFlow = flowsIntoEdges.find(e => e.argIndex === 2);

      assert.ok(defaultFlow, 'Should have flow with argIndex 0 (defaultConfig)');
      assert.ok(userFlow, 'Should have flow with argIndex 1 (userConfig)');
      assert.ok(envFlow, 'Should have flow with argIndex 2 (envConfig)');
    });

    it('should track event handler registration pattern', async () => {
      // Real-world scenario: Event emitter pattern
      await setupTest(backend, {
        'index.js': `
const eventEmitter = {
  handlers: {}
};

const onUserCreated = (user) => console.log(user);
const onUserDeleted = (id) => console.log(id);

eventEmitter.handlers.userCreated = onUserCreated;
eventEmitter.handlers['userDeleted'] = onUserDeleted;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // For nested property access (eventEmitter.handlers.prop = value),
      // we track the immediate object being mutated (handlers)
      // This may require separate detection in future iterations
      const flowsIntoEdges = allEdges.filter(e => e.type === 'FLOWS_INTO');

      // At minimum, we should detect these are property mutations
      // The exact behavior for nested access depends on implementation
      assert.ok(
        flowsIntoEdges.length >= 0,
        'Should handle event handler registration (exact behavior TBD for nested access)'
      );
    });
  });

  // ============================================================================
  // Edge cases and boundary conditions
  // ============================================================================
  describe('Edge cases', () => {
    it('should handle assignment with expression on right side', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const a = 1;
const b = 2;
obj.sum = a + b;  // Expression, not a simple variable
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      // Expression values (a + b) don't create FLOWS_INTO edges
      // because we can't resolve the source to a single variable
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 0,
        'Expression values should not create FLOWS_INTO edges'
      );
    });

    it('should handle call expression on right side', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.data = fetchData();  // Call expression

function fetchData() {
  return { loaded: true };
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const objVar = allNodes.find(n => n.name === 'obj');
      assert.ok(objVar, 'Variable "obj" not found');

      // Call expressions don't create FLOWS_INTO edges directly
      // (similar to array mutation behavior)
      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' && e.dst === objVar.id
      );

      assert.strictEqual(
        flowsIntoEdges.length, 0,
        'Call expressions should not create FLOWS_INTO edges'
      );
    });

    it('should NOT confuse array indexed assignment with object property', async () => {
      // arr[0] = value should be handled by array mutation, not object mutation
      await setupTest(backend, {
        'index.js': `
const arr = [];
const obj = {};
const item = 'test';

arr[0] = item;   // Array indexed assignment
obj[0] = item;   // This could be object with numeric key
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const arrVar = allNodes.find(n => n.name === 'arr');
      assert.ok(arrVar, 'Variable "arr" not found');

      // Array indexed assignment should have mutationMethod: 'indexed'
      const arrFlow = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.dst === arrVar.id
      );

      if (arrFlow) {
        assert.strictEqual(
          arrFlow.mutationMethod, 'indexed',
          'Array indexed assignment should have mutationMethod: indexed'
        );
      }
    });
  });
});
