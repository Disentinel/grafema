/**
 * Tests for Object Property Mutation Tracking
 *
 * V3 model for obj.prop = value:
 *   - PROPERTY_ASSIGNMENT node (name="obj.prop") with READS_FROM to the source variable
 *   - PROPERTY_ACCESS node (name="obj.prop") as child of the PROPERTY_ASSIGNMENT
 *   - No FLOWS_INTO edges
 *
 * V3 model for this.prop = value in class:
 *   - PROPERTY_ASSIGNMENT node (name="this.prop") with READS_FROM to the source parameter/variable
 *   - PROPERTY_ACCESS node (name="this.prop") as child of the PROPERTY_ASSIGNMENT
 *   - No FLOWS_INTO edges
 *
 * V3 model for Object.assign(target, source):
 *   - CALL node with READS_FROM edges to all arguments (target + sources)
 *   - No FLOWS_INTO edges
 *
 * Originally tested FLOWS_INTO edges (v1). Updated for v2 EXPRESSION model.
 * Updated for v3 PROPERTY_ASSIGNMENT model (replaces EXPRESSION name="=").
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

  // Create test files (including subdirectory support)
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, content);
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
  // V3: Creates PROPERTY_ASSIGNMENT(obj.prop) + PROPERTY_ACCESS(obj.prop) with READS_FROM edges
  // ============================================================================
  describe('obj.prop = value', () => {
    it('should create PROPERTY_ASSIGNMENT and PROPERTY_ACCESS for assigned variable to object', async () => {
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

      // V3: PROPERTY_ASSIGNMENT(config.handler) with READS_FROM to handler
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'config.handler'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for config.handler not found');

      const readsFromHandler = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === handlerVar.id
      );
      assert.ok(
        readsFromHandler,
        `Expected READS_FROM edge from PROPERTY_ASSIGNMENT to handler variable. ` +
        `Found READS_FROM edges: ${JSON.stringify(allEdges.filter(e => e.type === 'READS_FROM'))}`
      );

      // V3: PROPERTY_ACCESS(config.handler) still exists as child of PROPERTY_ASSIGNMENT
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'config.handler'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for config.handler not found');

      const readsFromConfig = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAccess.id &&
        e.dst === configVar.id
      );
      assert.ok(
        readsFromConfig,
        `Expected READS_FROM edge from PROPERTY_ACCESS to config variable`
      );
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

      // V3: Two PROPERTY_ACCESS nodes for obj.a and obj.b still exist, both with READS_FROM to obj
      const propAccessNodes = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' && (n.name === 'obj.a' || n.name === 'obj.b')
      );
      assert.strictEqual(
        propAccessNodes.length, 2,
        `Expected 2 PROPERTY_ACCESS nodes (obj.a, obj.b), got ${propAccessNodes.length}`
      );

      // Each PROPERTY_ACCESS should have READS_FROM to obj
      for (const pa of propAccessNodes) {
        const rf = allEdges.find(e =>
          e.type === 'READS_FROM' && e.src === pa.id && e.dst === objVar.id
        );
        assert.ok(rf, `Expected READS_FROM edge from ${pa.name} to obj`);
      }
    });

    it('should create PROPERTY_ASSIGNMENT nodes for literal value assignments (no source variable edges)', async () => {
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

      // V3: PROPERTY_ASSIGNMENT nodes exist for the assignments
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && (n.name === 'config.port' || n.name === 'config.host')
      );
      assert.ok(propAssigns.length >= 2, 'Expected at least 2 PROPERTY_ASSIGNMENT nodes for literal assignments');

      // V3: The PROPERTY_ACCESS nodes should still exist as children
      const propAccessNodes = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' && (n.name === 'config.port' || n.name === 'config.host')
      );
      assert.ok(propAccessNodes.length >= 2, 'Expected PROPERTY_ACCESS nodes for config.port and config.host');
    });
  });

  // ============================================================================
  // obj['prop'] = value (bracket notation with string literal)
  // V3: Creates PROPERTY_ASSIGNMENT with bracket notation name + PROPERTY_ACCESS child
  // ============================================================================
  describe("obj['prop'] = value (bracket notation)", () => {
    it('should create PROPERTY_ASSIGNMENT and PROPERTY_ACCESS for string literal key', async () => {
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
      const handlerVar = allNodes.find(n =>
        n.name === 'handler' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(configVar, 'Variable "config" not found');
      assert.ok(handlerVar, 'Variable "handler" not found');

      // V3: PROPERTY_ASSIGNMENT with READS_FROM to handler variable
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name.includes('config')
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for config bracket assignment not found');

      const readsHandler = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === handlerVar.id
      );
      assert.ok(readsHandler, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to handler');

      // V3: PROPERTY_ACCESS for bracket notation still exists as child
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name.includes('config')
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for config bracket access not found');

      const readsConfig = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAccess.id &&
        e.dst === configVar.id
      );
      assert.ok(readsConfig, 'Expected READS_FROM edge from PROPERTY_ACCESS to config');
    });

    it('should create PROPERTY_ASSIGNMENT and PROPERTY_ACCESS for computed key', async () => {
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

      // V3: PROPERTY_ASSIGNMENT with READS_FROM to value variable
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name.includes('config')
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for config computed assignment not found');

      const readsValue = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === valueVar.id
      );
      assert.ok(readsValue, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to value');

      // V3: PROPERTY_ACCESS still exists as child
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name.includes('config')
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for config computed access not found');
    });
  });

  // ============================================================================
  // this.prop = value (in class methods/constructors)
  // V3: Creates PROPERTY_ASSIGNMENT(this.prop) + PROPERTY_ACCESS(this.prop) with READS_FROM
  // No FLOWS_INTO edges to CLASS or FUNCTION
  // ============================================================================
  describe('this.prop = value', () => {
    it('should create PROPERTY_ASSIGNMENT with READS_FROM to source parameter in constructor', async () => {
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

      // V2: METHOD node for constructor (not FUNCTION)
      const constructorMethod = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

      // Find the handler parameter
      const handlerParam = allNodes.find(n =>
        n.name === 'handler' && n.type === 'PARAMETER'
      );
      assert.ok(handlerParam, 'PARAMETER "handler" not found');

      // V3: PROPERTY_ASSIGNMENT(this.handler) with READS_FROM to handler parameter
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.handler'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for this.handler not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === handlerParam.id
      );
      assert.ok(
        readsFrom,
        `Expected READS_FROM edge from PROPERTY_ASSIGNMENT to handler PARAMETER. Found READS_FROM: ${JSON.stringify(allEdges.filter(e => e.type === 'READS_FROM'))}`
      );

      // V3: PROPERTY_ACCESS(this.handler) still exists as child of PROPERTY_ASSIGNMENT
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.handler'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for this.handler not found');
    });

    it('should create PROPERTY_ASSIGNMENT with READS_FROM to source parameter in class method', async () => {
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

      // V2: CLASS node
      const classNode = allNodes.find(n =>
        n.type === 'CLASS' && n.name === 'Service'
      );
      assert.ok(classNode, 'CLASS "Service" not found');

      // Find the h parameter
      const hParam = allNodes.find(n =>
        n.name === 'h' && n.type === 'PARAMETER'
      );
      assert.ok(hParam, 'PARAMETER "h" not found');

      // V3: PROPERTY_ASSIGNMENT(this.handler) with READS_FROM to h parameter
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.handler'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for this.handler not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === hParam.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to parameter "h"');
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

      // V2: METHOD node for constructor
      const constructorMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'constructor');
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

      // V3: 3 PROPERTY_ASSIGNMENT(this.propX) nodes with READS_FROM to parameters a, b, c
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' &&
        (n.name === 'this.propA' || n.name === 'this.propB' || n.name === 'this.propC')
      );
      assert.strictEqual(propAssigns.length, 3, `Expected 3 PROPERTY_ASSIGNMENT nodes, got ${propAssigns.length}`);

      // Each should have a READS_FROM to a parameter
      const params = ['a', 'b', 'c'];
      for (const paramName of params) {
        const param = allNodes.find(n => n.type === 'PARAMETER' && n.name === paramName);
        assert.ok(param, `PARAMETER "${paramName}" not found`);

        const rf = allEdges.find(e =>
          e.type === 'READS_FROM' &&
          e.dst === param.id &&
          propAssigns.some(pa => pa.id === e.src)
        );
        assert.ok(rf, `Expected READS_FROM edge from some PROPERTY_ASSIGNMENT to PARAMETER "${paramName}"`);
      }

      // V3: 3 PROPERTY_ACCESS(this.propX) nodes still exist as children
      const propAccesses = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' &&
        (n.name === 'this.propA' || n.name === 'this.propB' || n.name === 'this.propC')
      );
      assert.strictEqual(propAccesses.length, 3, `Expected 3 PROPERTY_ACCESS nodes for this.propX, got ${propAccesses.length}`);
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

      // V3: PROPERTY_ASSIGNMENT(this.helper) with READS_FROM to helper variable
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.helper'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for this.helper not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === helperVar.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to helper variable');
    });

    it('should create PROPERTY_ASSIGNMENT nodes for this.prop = literal (no source variable edges)', async () => {
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

      // V3: PROPERTY_ASSIGNMENT nodes should exist for literal assignments
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && (n.name === 'this.port' || n.name === 'this.host')
      );
      assert.ok(propAssigns.length >= 2, 'Expected at least 2 PROPERTY_ASSIGNMENT nodes for literal assignments');

      // V3: PROPERTY_ASSIGNMENT nodes for literals should NOT have READS_FROM to variables
      for (const pa of propAssigns) {
        const readsFromVar = allEdges.filter(e =>
          e.type === 'READS_FROM' &&
          e.src === pa.id
        ).filter(e => {
          const dst = allNodes.find(n => n.id === e.dst);
          return dst && (dst.type === 'VARIABLE' || dst.type === 'PARAMETER');
        });
        // Literal assignments should NOT have READS_FROM to variables
        assert.strictEqual(
          readsFromVar.length, 0,
          'Literal value assignments should not have READS_FROM edges to variables'
        );
      }
    });

    it('should handle nested classes correctly', async () => {
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

      // V2: Inner constructor is METHOD node
      const innerConstructor = allNodes.find(n =>
        n.type === 'METHOD' && n.name === 'constructor'
      );
      assert.ok(innerConstructor, 'METHOD "constructor" for Inner not found');

      // V3: PROPERTY_ASSIGNMENT(this.val) with READS_FROM to val parameter
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'this.val'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for this.val not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === valParam.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to val parameter');

      // V3: PROPERTY_ACCESS(this.val) still exists as child
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.val'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for this.val not found');
    });

    it('should create PROPERTY_ASSIGNMENT nodes in both constructor and method for this.prop', async () => {
      await setupTest(backend, {
        'index.js': `
class App {
  constructor(config) {
    this.config = config;
  }
  setLogger(logger) {
    this.logger = logger;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'App');
      assert.ok(classNode);

      const configParam = allNodes.find(n => n.type === 'PARAMETER' && n.name === 'config');
      assert.ok(configParam, 'PARAMETER "config" not found');

      const loggerParam = allNodes.find(n => n.type === 'PARAMETER' && n.name === 'logger');
      assert.ok(loggerParam, 'PARAMETER "logger" not found');

      // V3: PROPERTY_ASSIGNMENT nodes with READS_FROM to both params
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && (n.name === 'this.config' || n.name === 'this.logger')
      );
      assert.strictEqual(propAssigns.length, 2, `Expected 2 PROPERTY_ASSIGNMENT nodes, got ${propAssigns.length}`);

      const configRead = allEdges.find(e =>
        e.type === 'READS_FROM' && e.dst === configParam.id &&
        propAssigns.some(pa => pa.id === e.src)
      );
      assert.ok(configRead, 'Expected READS_FROM edge to config parameter');

      const loggerRead = allEdges.find(e =>
        e.type === 'READS_FROM' && e.dst === loggerParam.id &&
        propAssigns.some(pa => pa.id === e.src)
      );
      assert.ok(loggerRead, 'Expected READS_FROM edge to logger parameter');
    });

    it('should create PROPERTY_ASSIGNMENT and PROPERTY_ACCESS for files in subdirectories', async () => {
      await setupTest(backend, {
        'index.js': `import './src/App.js';`,
        'src/App.js': `
class App {
  constructor(config) {
    this.config = config;
  }
  setLogger(logger) {
    this.logger = logger;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: METHOD constructor
      const constructorMethod = allNodes.find(n => n.type === 'METHOD' && n.name === 'constructor');
      assert.ok(constructorMethod, 'METHOD "constructor" not found');

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'App');
      assert.ok(classNode, 'CLASS "App" not found');

      const configParam = allNodes.find(n => n.type === 'PARAMETER' && n.name === 'config');
      assert.ok(configParam, 'PARAMETER "config" not found');

      const loggerParam = allNodes.find(n => n.type === 'PARAMETER' && n.name === 'logger');
      assert.ok(loggerParam, 'PARAMETER "logger" not found');

      // V3: PROPERTY_ASSIGNMENT nodes with READS_FROM to parameters
      const propAssigns = allNodes.filter(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && (n.name === 'this.config' || n.name === 'this.logger')
      );
      assert.ok(propAssigns.length >= 2, 'Expected at least 2 PROPERTY_ASSIGNMENT nodes');

      const configRead = allEdges.find(e =>
        e.type === 'READS_FROM' && e.dst === configParam.id
      );
      assert.ok(configRead, 'Expected READS_FROM edge to config parameter');

      const loggerRead = allEdges.find(e =>
        e.type === 'READS_FROM' && e.dst === loggerParam.id
      );
      assert.ok(loggerRead, 'Expected READS_FROM edge to logger parameter');
    });

    it('should still create EXPRESSION nodes for this.prop outside class context', { todo: 'V2 does not create READS_FROM edges from assignment EXPRESSION to parameter for this.prop outside class' }, async () => {
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

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // V2: EXPRESSION and PROPERTY_ACCESS nodes are still created for this.prop outside class
      // The key difference is there's no CLASS node, but the nodes themselves still exist
      const xParam = allNodes.find(n => n.type === 'PARAMETER' && n.name === 'x');
      assert.ok(xParam, 'PARAMETER "x" not found');

      // V2: EXPRESSION with READS_FROM to x parameter
      const assignExpr = allNodes.find(n =>
        n.type === 'EXPRESSION' && n.name === '='
      );
      assert.ok(assignExpr, 'EXPRESSION node for this.x = x not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === assignExpr.id &&
        e.dst === xParam.id
      );
      assert.ok(readsFrom, 'Expected READS_FROM edge from EXPRESSION to x parameter');
    });
  });

  // ============================================================================
  // this.prop read access (READS_FROM edges to CLASS)
  // ============================================================================
  describe('this.prop read access (READS_FROM)', () => {
    it('should create PROPERTY_ACCESS for this.prop read in subdirectory file', async () => {
      await setupTest(backend, {
        'index.js': `import './src/App.js';`,
        'src/App.js': `
class App {
  constructor(config) {
    this.config = config;
  }
  getConfig() {
    return this.config;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'App');
      assert.ok(classNode, 'CLASS "App" not found');

      // V2: this.config in getConfig() should be a PROPERTY_ACCESS with name='this.config'
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'this.config'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS with name="this.config" not found');
    });
  });

  // ============================================================================
  // Object.assign(target, source)
  // V2: Creates CALL node with READS_FROM edges to all arguments
  // ============================================================================
  describe('Object.assign(target, source)', () => {
    it('should create CALL node with READS_FROM edges to target and source', async () => {
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

      // V2: CALL node for Object.assign
      const callNode = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'Object.assign'
      );
      assert.ok(callNode, 'CALL node for Object.assign not found');

      // V2: CALL has READS_FROM edges to both merged and defaults
      const readsMerged = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === callNode.id &&
        e.dst === mergedVar.id
      );
      assert.ok(readsMerged, 'Expected READS_FROM edge from Object.assign CALL to merged');

      const readsDefaults = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === callNode.id &&
        e.dst === defaultsVar.id
      );
      assert.ok(readsDefaults, 'Expected READS_FROM edge from Object.assign CALL to defaults');
    });

    it('should create READS_FROM edges for multiple sources', async () => {
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

      // V2: CALL node for Object.assign
      const callNode = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'Object.assign'
      );
      assert.ok(callNode, 'CALL node for Object.assign not found');

      // V2: CALL has READS_FROM to all 4 arguments (target + 3 sources)
      const readsFromEdges = allEdges.filter(e =>
        e.type === 'READS_FROM' &&
        e.src === callNode.id
      );

      assert.strictEqual(
        readsFromEdges.length, 4,
        `Expected 4 READS_FROM edges from CALL (target + 3 sources), got ${readsFromEdges.length}`
      );
    });

    it('should handle Object.assign with anonymous target', async () => {
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

      // V2: CALL node for Object.assign should exist
      const callNode = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'Object.assign'
      );
      assert.ok(callNode, 'CALL node for Object.assign not found');

      // V2: CALL should have READS_FROM to source
      const readsSource = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === callNode.id &&
        e.dst === sourceVar.id
      );
      assert.ok(readsSource, 'Expected READS_FROM edge from Object.assign CALL to source');
    });
  });

  // ============================================================================
  // Function-level mutations
  // V3: PROPERTY_ASSIGNMENT + PROPERTY_ACCESS with READS_FROM edges
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

      // V3: PROPERTY_ASSIGNMENT(config.handler) with READS_FROM to handler
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'config.handler'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for config.handler not found');

      const readsHandler = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === handlerVar.id
      );
      assert.ok(readsHandler, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to handler');

      // V3: PROPERTY_ACCESS(config.handler) still exists as child with READS_FROM to config
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'config.handler'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for config.handler not found');

      const readsConfig = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAccess.id &&
        e.dst === configParam.id
      );
      assert.ok(readsConfig, 'Expected READS_FROM edge from PROPERTY_ACCESS to config parameter');
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

      // V3: PROPERTY_ASSIGNMENT(config.database) with READS_FROM to db variable
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'config.database'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for config.database not found');

      const readsDb = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === dbVar.id
      );
      assert.ok(readsDb, 'Expected READS_FROM edge from PROPERTY_ASSIGNMENT to db variable');
    });
  });

  // ============================================================================
  // Edge direction verification
  // V3: PROPERTY_ASSIGNMENT reads FROM the value, PROPERTY_ACCESS reads FROM the object
  // ============================================================================
  describe('Edge direction verification', () => {
    it('should create READS_FROM with correct direction: PROPERTY_ASSIGNMENT reads FROM value', async () => {
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

      // V3: PROPERTY_ASSIGNMENT reads FROM item (value)
      const propAssign = allNodes.find(n =>
        n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'container.item'
      );
      assert.ok(propAssign, 'PROPERTY_ASSIGNMENT node for container.item not found');

      const readsFromItem = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAssign.id &&
        e.dst === itemVar.id
      );
      assert.ok(readsFromItem, 'PROPERTY_ASSIGNMENT should READS_FROM item (value)');

      // V3: PROPERTY_ACCESS reads FROM container (object)
      const propAccess = allNodes.find(n =>
        n.type === 'PROPERTY_ACCESS' && n.name === 'container.item'
      );
      assert.ok(propAccess, 'PROPERTY_ACCESS node for container.item not found');

      const readsFromContainer = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === propAccess.id &&
        e.dst === containerVar.id
      );
      assert.ok(readsFromContainer, 'PROPERTY_ACCESS should READS_FROM container (object)');
    });
  });
});
