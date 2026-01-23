/**
 * VariableVisitor Semantic ID Integration Tests
 *
 * Tests for integrating semantic IDs into VariableVisitor.
 * These tests verify that:
 * 1. Variables at module level get semantic IDs
 * 2. Function-scoped variables include scope path
 * 3. Control flow scopes are included in variable IDs
 * 4. IDs are stable across line number changes
 * 5. Discriminators work for same-named variables
 *
 * Format: {file}->{scope_path}->VARIABLE|CONSTANT->{name}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 *
 * User Decisions:
 * 1. Replace `id`: Semantic ID becomes the primary `id` field (breaking change)
 * 2. Full scope path: Variables include control flow scope in path
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'var-semantic';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

describe('VariableVisitor semantic ID integration', () => {
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

      // Semantic ID format: file->global->CONSTANT->name
      // Should NOT contain line numbers
      assert.ok(
        !constNode.id.includes(':'),
        `ID should not contain line:column format. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('index.js'),
        `ID should contain filename. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('global'),
        `ID should contain 'global' scope. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('CONSTANT'),
        `ID should contain node type. Got: ${constNode.id}`
      );
      assert.ok(
        constNode.id.includes('API_URL'),
        `ID should contain variable name. Got: ${constNode.id}`
      );

      // Expected format: index.js->global->CONSTANT->API_URL
      assert.strictEqual(
        constNode.id,
        'index.js->global->CONSTANT->API_URL',
        `Expected semantic ID format`
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

      // Expected format: index.js->global->VARIABLE->counter
      assert.strictEqual(
        varNode.id,
        'index.js->global->VARIABLE->counter',
        `Expected semantic ID format`
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

      // Expected format: index.js->global->VARIABLE->legacyVar
      assert.strictEqual(
        varNode.id,
        'index.js->global->VARIABLE->legacyVar',
        `Expected semantic ID format`
      );
    });

    it('should use global scope for module-level variables', async () => {
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

      // All should have 'global' in their scope path
      assert.ok(dbHost.id.includes('->global->'), `DB_HOST should have global scope`);
      assert.ok(dbPort.id.includes('->global->'), `dbPort should have global scope`);
      assert.ok(dbName.id.includes('->global->'), `dbName should have global scope`);
    });
  });

  // ===========================================================================
  // Function-scoped variables
  // ===========================================================================

  describe('function-scoped variables', () => {
    it('should include function name in scope path', async () => {
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

      // Expected format: index.js->processData->CONSTANT->result
      assert.ok(
        resultVar.id.includes('processData'),
        `ID should include function name. Got: ${resultVar.id}`
      );
      assert.strictEqual(
        resultVar.id,
        'index.js->processData->CONSTANT->result',
        `Expected semantic ID with function scope`
      );
    });

    it('should include control flow in scope path (if)', async () => {
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

      // Expected format: index.js->handler->if#0->CONSTANT->insideIf
      assert.ok(
        insideIfVar.id.includes('if#'),
        `ID should include if scope with discriminator. Got: ${insideIfVar.id}`
      );
      assert.strictEqual(
        insideIfVar.id,
        'index.js->handler->if#0->CONSTANT->insideIf',
        `Expected semantic ID with if scope`
      );
    });

    it('should include control flow in scope path (for/while/try)', async () => {
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
        itemVar.id.includes('for#'),
        `ID should include for scope. Got: ${itemVar.id}`
      );

      // while loop variable
      const waitingVar = allNodes.find(n =>
        n.name === 'waiting' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(waitingVar, 'Variable "waiting" not found');
      assert.ok(
        waitingVar.id.includes('while#'),
        `ID should include while scope. Got: ${waitingVar.id}`
      );

      // try block variable
      const riskyVar = allNodes.find(n =>
        n.name === 'risky' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(riskyVar, 'Variable "risky" not found');
      assert.ok(
        riskyVar.id.includes('try#'),
        `ID should include try scope. Got: ${riskyVar.id}`
      );

      // catch block variable
      const errorMsgVar = allNodes.find(n =>
        n.name === 'errorMsg' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(errorMsgVar, 'Variable "errorMsg" not found');
      assert.ok(
        errorMsgVar.id.includes('catch#'),
        `ID should include catch scope. Got: ${errorMsgVar.id}`
      );
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

      // Expected format: index.js->complexHandler->if#0->for#0->if#0->CONSTANT->deepNested
      // (nested if has its own #0 discriminator within the for scope)
      assert.ok(
        deepNestedVar.id.includes('complexHandler'),
        `ID should include function name. Got: ${deepNestedVar.id}`
      );
      assert.ok(
        (deepNestedVar.id.match(/if#/g) || []).length === 2,
        `ID should include two if scopes for nesting. Got: ${deepNestedVar.id}`
      );
      assert.ok(
        deepNestedVar.id.includes('for#'),
        `ID should include for scope. Got: ${deepNestedVar.id}`
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
      await backend.cleanup();
      backend = createTestBackend();
      await backend.connect();

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

    it('adding unrelated code should not change existing variable IDs', async () => {
      // First version
      await setupTest(backend, {
        'index.js': `
const target = 'original';
        `
      });

      const nodes1 = await backend.getAllNodes();
      const targetId1 = nodes1.find(n => n.name === 'target')?.id;

      await backend.cleanup();
      backend = createTestBackend();
      await backend.connect();

      // Second version with more code
      await setupTest(backend, {
        'index.js': `
const unrelated = 'new variable';
const target = 'original';
const another = 'also new';
        `
      });

      const nodes2 = await backend.getAllNodes();
      const targetId2 = nodes2.find(n => n.name === 'target')?.id;

      assert.strictEqual(
        targetId1,
        targetId2,
        'Adding unrelated code should not change target ID'
      );
    });

    it('line number changes should not affect IDs', async () => {
      // Original at line 2
      await setupTest(backend, {
        'index.js': `
const myVar = 42;
        `
      });

      const nodes1 = await backend.getAllNodes();
      const myVarId1 = nodes1.find(n => n.name === 'myVar')?.id;

      await backend.cleanup();
      backend = createTestBackend();
      await backend.connect();

      // Same variable but at different line (added empty lines)
      await setupTest(backend, {
        'index.js': `




const myVar = 42;
        `
      });

      const nodes2 = await backend.getAllNodes();
      const myVarId2 = nodes2.find(n => n.name === 'myVar')?.id;

      assert.strictEqual(
        myVarId1,
        myVarId2,
        'Line number changes should not affect ID'
      );

      // Verify line field is different (it stores actual line for location)
      const myVar1 = nodes1.find(n => n.name === 'myVar');
      const myVar2 = nodes2.find(n => n.name === 'myVar');

      assert.notStrictEqual(
        myVar1.line,
        myVar2.line,
        'Line fields should be different'
      );
    });
  });

  // ===========================================================================
  // Discriminators
  // ===========================================================================

  describe('discriminators', () => {
    it('should use discriminator for same-named variables in same scope', async () => {
      // This is a rare case but can happen with block scopes
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

      // IDs should be different due to different if#N scopes
      const ids = xVars.map(v => v.id);
      assert.notStrictEqual(ids[0], ids[1], 'Same-named variables should have different IDs');

      // One should be in if#0, other in if#1
      assert.ok(
        ids.some(id => id.includes('if#0')),
        'One x should be in if#0'
      );
      assert.ok(
        ids.some(id => id.includes('if#1')),
        'Other x should be in if#1'
      );
    });

    it('should NOT use discriminator when names are unique', async () => {
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

      // IDs should NOT have discriminators (#N) for unique names
      assert.ok(
        !first.id.includes('#'),
        `Unique variable should not have discriminator. Got: ${first.id}`
      );
      assert.ok(
        !second.id.includes('#'),
        `Unique variable should not have discriminator. Got: ${second.id}`
      );
      assert.ok(
        !third.id.includes('#'),
        `Unique variable should not have discriminator. Got: ${third.id}`
      );
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

      // All should have semantic ID format
      [nameVar, ageVar, firstVar, secondVar].forEach(v => {
        assert.ok(
          v.id.includes('index.js->global'),
          `Destructured variable ${v.name} should have semantic ID`
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

      // Should have some function scope (could be 'handler' or 'anonymous[N]')
      assert.ok(
        insideArrowVar.id.includes('->') && !insideArrowVar.id.includes('->global->CONSTANT->insideArrow'),
        `Arrow function body should create scope. Got: ${insideArrowVar.id}`
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

      // Should include class and method in scope path
      assert.ok(
        resultVar.id.includes('UserService'),
        `ID should include class name. Got: ${resultVar.id}`
      );
      assert.ok(
        resultVar.id.includes('process'),
        `ID should include method name. Got: ${resultVar.id}`
      );
    });
  });
});
