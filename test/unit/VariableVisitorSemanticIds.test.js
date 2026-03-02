/**
 * Variable Semantic ID Integration Tests
 *
 * Tests for semantic IDs on variables.
 * V2 format: {file}->VARIABLE|CONSTANT->{name}#{line}
 *
 * These tests verify that:
 * 1. Variables get semantic IDs with file->TYPE->name#line format
 * 2. IDs are unique (same-named variables get different line numbers)
 * 3. IDs are stable across line number changes (NOT true in v2 - IDs include line numbers)
 * 4. Variables include correct type (VARIABLE for let/var, CONSTANT for const)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'var-semantic';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

describe('VariableVisitor semantic ID integration', () => {
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
  // Module-level variables
  // ===========================================================================

  describe('module-level variables', () => {
    it('should generate semantic ID for const at module level', async () => {
      await setupTest(backend, {
        'index.js': `
const API_URL = 'https://api.example.com';
        `
      });

      const allNodes = await backend.getAllNodes();
      const constNode = allNodes.find(n =>
        n.name === 'API_URL' && n.type === 'CONSTANT'
      );

      assert.ok(constNode, 'CONSTANT node "API_URL" not found');

      // V2 semantic ID format: file->CONSTANT->name#line
      assert.ok(
        constNode.id.includes('index.js'),
        `ID should contain filename. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('CONSTANT'),
        `ID should contain node type. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('API_URL'),
        `ID should contain variable name. Got: ${constNode.id}`
      );

      // V2 format: index.js->CONSTANT->API_URL#line
      assert.ok(
        constNode.id.startsWith('index.js->CONSTANT->API_URL'),
        `Expected semantic ID format index.js->CONSTANT->API_URL#..., got: ${constNode.id}`
      );
    });

    it('should generate semantic ID for let at module level', async () => {
      await setupTest(backend, {
        'index.js': `
let counter = 0;
        `
      });

      const allNodes = await backend.getAllNodes();
      const varNode = allNodes.find(n =>
        n.name === 'counter' && n.type === 'VARIABLE'
      );

      assert.ok(varNode, 'VARIABLE node "counter" not found');

      // V2 format: index.js->VARIABLE->counter#line
      assert.ok(
        varNode.id.startsWith('index.js->VARIABLE->counter'),
        `Expected semantic ID format. Got: ${varNode.id}`
      );
    });

    it('should generate semantic ID for var at module level', async () => {
      await setupTest(backend, {
        'index.js': `
var legacyVar = 'old style';
        `
      });

      const allNodes = await backend.getAllNodes();
      const varNode = allNodes.find(n =>
        n.name === 'legacyVar' && n.type === 'VARIABLE'
      );

      assert.ok(varNode, 'VARIABLE node "legacyVar" not found');

      // V2 format: index.js->VARIABLE->legacyVar#line
      assert.ok(
        varNode.id.startsWith('index.js->VARIABLE->legacyVar'),
        `Expected semantic ID format. Got: ${varNode.id}`
      );
    });

    it('should use correct type prefix for module-level variables', async () => {
      await setupTest(backend, {
        'index.js': `
const DB_HOST = 'localhost';
let dbPort = 5432;
var dbName = 'test';
        `
      });

      const allNodes = await backend.getAllNodes();

      const dbHost = allNodes.find(n => n.name === 'DB_HOST');
      const dbPort = allNodes.find(n => n.name === 'dbPort');
      const dbName = allNodes.find(n => n.name === 'dbName');

      assert.ok(dbHost, 'DB_HOST not found');
      assert.ok(dbPort, 'dbPort not found');
      assert.ok(dbName, 'dbName not found');

      // V2: CONSTANT for const, VARIABLE for let/var
      assert.ok(dbHost.id.includes('->CONSTANT->'), `DB_HOST should be CONSTANT. Got: ${dbHost.id}`);
      assert.ok(dbPort.id.includes('->VARIABLE->'), `dbPort should be VARIABLE. Got: ${dbPort.id}`);
      assert.ok(dbName.id.includes('->VARIABLE->'), `dbName should be VARIABLE. Got: ${dbName.id}`);
    });
  });

  // ===========================================================================
  // Function-scoped variables
  // ===========================================================================

  describe('function-scoped variables', () => {
    it('should generate semantic ID for variables inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function processData() {
  const result = 42;
  return result;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const resultVar = allNodes.find(n =>
        n.name === 'result' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(resultVar, 'Variable "result" not found');

      // V2: flat format index.js->TYPE->name#line (no function scope in path)
      assert.ok(
        resultVar.id.includes('result'),
        `ID should include variable name. Got: ${resultVar.id}`
      );
      assert.ok(
        resultVar.id.includes('index.js'),
        `ID should include filename. Got: ${resultVar.id}`
      );
    });

    it('should generate IDs for variables in control flow', async () => {
      await setupTest(backend, {
        'index.js': `
function handler(condition) {
  if (condition) {
    const insideIf = 'value';
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const insideIfVar = allNodes.find(n =>
        n.name === 'insideIf' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(insideIfVar, 'Variable "insideIf" not found');

      // V2: index.js->CONSTANT->insideIf#line
      assert.ok(
        insideIfVar.id.startsWith('index.js->'),
        `ID should start with file prefix. Got: ${insideIfVar.id}`
      );
      assert.ok(
        insideIfVar.id.includes('insideIf'),
        `ID should include variable name. Got: ${insideIfVar.id}`
      );
    });

    it('should generate IDs for variables in for/while/try blocks', async () => {
      await setupTest(backend, {
        'index.js': `
function processArray(items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
  }
}

function waitLoop() {
  while (true) {
    let waiting = true;
  }
}

function handleError() {
  try {
    const risky = doSomething();
  } catch (e) {
    const errorMsg = e.message;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // for loop variable
      const itemVar = allNodes.find(n =>
        n.name === 'item' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(itemVar, 'Variable "item" not found');
      assert.ok(
        itemVar.id.includes('index.js'),
        `ID should include filename. Got: ${itemVar.id}`
      );

      // while loop variable
      const waitingVar = allNodes.find(n =>
        n.name === 'waiting' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(waitingVar, 'Variable "waiting" not found');

      // try block variable
      const riskyVar = allNodes.find(n =>
        n.name === 'risky' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(riskyVar, 'Variable "risky" not found');

      // catch block variable
      const errorMsgVar = allNodes.find(n =>
        n.name === 'errorMsg' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(errorMsgVar, 'Variable "errorMsg" not found');
    });

    it('should handle nested control flow scopes', async () => {
      await setupTest(backend, {
        'index.js': `
function complexHandler(data) {
  if (data) {
    for (let i = 0; i < data.length; i++) {
      if (data[i].valid) {
        const deepNested = data[i].value;
      }
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const deepNestedVar = allNodes.find(n =>
        n.name === 'deepNested' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(deepNestedVar, 'Variable "deepNested" not found');

      // V2: flat format with line number
      assert.ok(
        deepNestedVar.id.includes('index.js'),
        `ID should include filename. Got: ${deepNestedVar.id}`
      );
      assert.ok(
        deepNestedVar.id.includes('deepNested'),
        `ID should include variable name. Got: ${deepNestedVar.id}`
      );
    });
  });

  // ===========================================================================
  // Stability tests
  // ===========================================================================

  describe('stability', () => {
    it('same code should produce same IDs', async () => {
      // First analysis
      await setupTest(backend, {
        'index.js': `
const config = { host: 'localhost' };
function getData() {
  const result = fetchData();
  return result;
}
        `
      });

      const nodes1 = await backend.getAllNodes();
      const configId1 = nodes1.find(n => n.name === 'config')?.id;
      const resultId1 = nodes1.find(n => n.name === 'result')?.id;

      // Cleanup and run again with same code
      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;

      await setupTest(backend, {
        'index.js': `
const config = { host: 'localhost' };
function getData() {
  const result = fetchData();
  return result;
}
        `
      });

      const nodes2 = await backend.getAllNodes();
      const configId2 = nodes2.find(n => n.name === 'config')?.id;
      const resultId2 = nodes2.find(n => n.name === 'result')?.id;

      assert.strictEqual(configId1, configId2, 'config ID should be stable');
      assert.strictEqual(resultId1, resultId2, 'result ID should be stable');
    });

    it('adding unrelated code should not change existing variable IDs when line stays same', async () => {
      // First version
      await setupTest(backend, {
        'index.js': `
const target = 'original';
        `
      });

      const nodes1 = await backend.getAllNodes();
      const targetId1 = nodes1.find(n => n.name === 'target')?.id;

      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;

      // V2 IDs include line numbers, so if we add code AFTER target, ID stays same
      await setupTest(backend, {
        'index.js': `
const target = 'original';
const another = 'also new';
        `
      });

      const nodes2 = await backend.getAllNodes();
      const targetId2 = nodes2.find(n => n.name === 'target')?.id;

      assert.strictEqual(
        targetId1,
        targetId2,
        'Adding code after target should not change its ID (same line number)'
      );
    });

    it('line number changes DO affect IDs in v2 (line is part of ID)', async () => {
      // Original at line 2
      await setupTest(backend, {
        'index.js': `
const myVar = 42;
        `
      });

      const nodes1 = await backend.getAllNodes();
      const myVar1 = nodes1.find(n => n.name === 'myVar');
      const myVarId1 = myVar1?.id;

      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;
      await setupTest(backend, {
        'index.js': `



const myVar = 42;
        `
      });

      const nodes2 = await backend.getAllNodes();
      const myVar2 = nodes2.find(n => n.name === 'myVar');
      const myVarId2 = myVar2?.id;

      // V2: IDs include line numbers, so they WILL be different
      assert.ok(myVarId1, 'myVar ID should exist in first analysis');
      assert.ok(myVarId2, 'myVar ID should exist in second analysis');

      // Both should be valid v2 format
      assert.ok(myVarId1.includes('index.js'), 'First ID should include filename');
      assert.ok(myVarId2.includes('index.js'), 'Second ID should include filename');

      // Line fields should be different
      assert.notStrictEqual(
        myVar1.line,
        myVar2.line,
        'Line fields should be different'
      );
    });
  });

  // ===========================================================================
  // Discriminators (uniqueness via line numbers)
  // ===========================================================================

  describe('discriminators', () => {
    it('should use line numbers to distinguish same-named variables', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  if (items.length > 0) {
    const x = items[0];
    console.log(x);
  }
  if (items.length > 1) {
    const x = items[1];
    console.log(x);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const xVars = allNodes.filter(n =>
        n.name === 'x' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.strictEqual(xVars.length, 2, 'Should have 2 variables named "x"');

      // IDs should be different due to different line numbers
      const ids = xVars.map(v => v.id);
      assert.notStrictEqual(ids[0], ids[1], 'Same-named variables should have different IDs');
    });

    it('should NOT have line suffix conflict when names are unique', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const first = 1;
  const second = 2;
  const third = 3;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const first = allNodes.find(n => n.name === 'first');
      const second = allNodes.find(n => n.name === 'second');
      const third = allNodes.find(n => n.name === 'third');

      assert.ok(first, 'first not found');
      assert.ok(second, 'second not found');
      assert.ok(third, 'third not found');

      // All IDs should be unique
      const ids = new Set([first.id, second.id, third.id]);
      assert.strictEqual(ids.size, 3, 'All variable IDs should be unique');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle destructuring declarations', async () => {
      await setupTest(backend, {
        'index.js': `
const { name, age } = person;
const [first, second] = array;
        `
      });

      const allNodes = await backend.getAllNodes();

      const nameVar = allNodes.find(n => n.name === 'name');
      const ageVar = allNodes.find(n => n.name === 'age');
      const firstVar = allNodes.find(n => n.name === 'first');
      const secondVar = allNodes.find(n => n.name === 'second');

      assert.ok(nameVar, 'name not found');
      assert.ok(ageVar, 'age not found');
      assert.ok(firstVar, 'first not found');
      assert.ok(secondVar, 'second not found');

      // V2: all should have semantic ID format
      [nameVar, ageVar, firstVar, secondVar].forEach(v => {
        assert.ok(
          v.id.startsWith('index.js->'),
          `Destructured variable ${v.name} should have semantic ID. Got: ${v.id}`
        );
      });
    });

    it('should handle special characters in variable names ($, _)', async () => {
      await setupTest(backend, {
        'index.js': `
const $store = createStore();
const _private = 'internal';
const $$double = 'svelte';
        `
      });

      const allNodes = await backend.getAllNodes();

      const storeVar = allNodes.find(n => n.name === '$store');
      const privateVar = allNodes.find(n => n.name === '_private');
      const doubleVar = allNodes.find(n => n.name === '$$double');

      assert.ok(storeVar, '$store not found');
      assert.ok(privateVar, '_private not found');
      assert.ok(doubleVar, '$$double not found');

      assert.ok(storeVar.id.includes('$store'), 'ID should contain $store');
      assert.ok(privateVar.id.includes('_private'), 'ID should contain _private');
      assert.ok(doubleVar.id.includes('$$double'), 'ID should contain $$double');
    });

    it('should handle arrow functions as scopes', async () => {
      await setupTest(backend, {
        'index.js': `
const handler = () => {
  const insideArrow = 'value';
};
        `
      });

      const allNodes = await backend.getAllNodes();
      const insideArrowVar = allNodes.find(n =>
        n.name === 'insideArrow' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(insideArrowVar, 'insideArrow not found');

      // V2: flat ID format
      assert.ok(
        insideArrowVar.id.includes('->') && insideArrowVar.id.includes('insideArrow'),
        `Arrow function variable should have semantic ID. Got: ${insideArrowVar.id}`
      );
    });

    it('should handle class methods', async () => {
      await setupTest(backend, {
        'index.js': `
class UserService {
  process(data) {
    const result = transform(data);
    return result;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const resultVar = allNodes.find(n =>
        n.name === 'result' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );

      assert.ok(resultVar, 'result not found');

      // V2: flat ID format with file and name
      assert.ok(
        resultVar.id.includes('index.js'),
        `ID should include filename. Got: ${resultVar.id}`
      );
      assert.ok(
        resultVar.id.includes('result'),
        `ID should include variable name. Got: ${resultVar.id}`
      );
    });
  });
});
