/**
 * Тест для ES6+ modern syntax
 * Проверяем: spread/rest, template literals, destructuring
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/05-modern-syntax');

describe('Modern Syntax Analysis', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
    orchestrator = createTestOrchestrator(backend);
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should detect SERVICE from package.json', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('SERVICE', 'modern-syntax-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect all MODULE files', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js')
      .hasNode('MODULE', 'src/spread-rest.js')
      .hasNode('MODULE', 'src/template-literals.js')
      .hasNode('MODULE', 'src/destructuring.js')
      .hasNodeCount('MODULE', 4);
  });

  describe('Spread/Rest Syntax (spread-rest.js)', () => {
    it('should detect functions with rest parameters', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Функции с rest параметрами: sum, concatenate, processRequest, wrapWithMetadata
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'sum')
        .hasNode('FUNCTION', 'concatenate')
        .hasNode('FUNCTION', 'processRequest')
        .hasNode('FUNCTION', 'wrapWithMetadata');
    });

    it('should detect functions with spread operators', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Функции со spread: mergeArrays, cloneArray, mergeObjects, updateUser, callWithSpread, maxOfArray
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'mergeArrays')
        .hasNode('FUNCTION', 'cloneArray')
        .hasNode('FUNCTION', 'mergeObjects')
        .hasNode('FUNCTION', 'updateUser')
        .hasNode('FUNCTION', 'callWithSpread')
        .hasNode('FUNCTION', 'maxOfArray');
    });

    it('should detect all spread-rest functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'insertInMiddle')
        .hasNode('FUNCTION', 'addDefaults')
        .hasNode('FUNCTION', 'extractAndMerge')
        .hasNode('FUNCTION', 'buildConfig')
        .hasNode('FUNCTION', 'createFullList')
        .hasNode('FUNCTION', 'processGroups');
    });
  });

  describe('Template Literals (template-literals.js)', () => {
    it('should detect functions using template literals', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'greet')
        .hasNode('FUNCTION', 'generateEmail')
        .hasNode('FUNCTION', 'calculateTotal')
        .hasNode('FUNCTION', 'buildUrl');
    });

    it('should detect functions with nested template calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // formatUser вызывает getUserName и getUserRole внутри template literal
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'formatUser')
        .hasNode('FUNCTION', 'getUserName')
        .hasNode('FUNCTION', 'getUserRole');
    });

    it('should detect tagged template function', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // highlight - tagged template function
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'highlight')
        .hasNode('FUNCTION', 'formatMessage');
    });

    it('should detect all template-literal functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'createMessage')
        .hasNode('FUNCTION', 'displayUserInfo')
        .hasNode('FUNCTION', 'generateReport')
        .hasNode('FUNCTION', 'formatStatus')
        .hasNode('FUNCTION', 'getGreeting');
    });
  });

  describe('Destructuring (destructuring.js)', () => {
    it('should detect functions with object destructuring', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'processUser')
        .hasNode('FUNCTION', 'processConfig')
        .hasNode('FUNCTION', 'createUser');
    });

    it('should detect functions with array destructuring', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'getCoordinates')
        .hasNode('FUNCTION', 'getFirstAndRest')
        .hasNode('FUNCTION', 'swapValues');
    });

    it('should detect functions with destructuring in parameters', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // greetUser({ name, greeting = 'Hello' })
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'greetUser');
    });

    it('should detect all destructuring functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'extractMainFields')
        .hasNode('FUNCTION', 'processEntries')
        .hasNode('FUNCTION', 'getUserData')
        .hasNode('FUNCTION', 'displayUserData')
        .hasNode('FUNCTION', 'processProduct')
        .hasNode('FUNCTION', 'processResponse');
    });
  });

  describe('Graph Structure Validation', () => {
    it('should have valid graph structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .allEdgesValid()
        .noDuplicateIds();
    });

    it('should connect modules to service', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('SERVICE', 'modern-syntax-fixture', 'CONTAINS', 'MODULE', 'index.js')
        .hasEdge('SERVICE', 'modern-syntax-fixture', 'CONTAINS', 'MODULE', 'src/spread-rest.js')
        .hasEdge('SERVICE', 'modern-syntax-fixture', 'CONTAINS', 'MODULE', 'src/template-literals.js')
        .hasEdge('SERVICE', 'modern-syntax-fixture', 'CONTAINS', 'MODULE', 'src/destructuring.js');
    });

    it('should connect functions to modules', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('MODULE', 'src/spread-rest.js', 'CONTAINS', 'FUNCTION', 'sum')
        .hasEdge('MODULE', 'src/template-literals.js', 'CONTAINS', 'FUNCTION', 'greet')
        .hasEdge('MODULE', 'src/destructuring.js', 'CONTAINS', 'FUNCTION', 'processUser');
    });
  });

  describe('Arrow Functions Detection', () => {
    it('should detect arrow functions inside regular functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // sum использует arrow function: numbers.reduce((acc, n) => acc + n, 0)
      // highlight использует arrow function в reduce
      const allNodes = await backend.getAllNodes();
      const arrowFunctions = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.name && n.name.includes('anonymous')
      );

      // Должны быть anonymous arrow functions
      assert.ok(arrowFunctions.length >= 1,
        `Expected at least 1 anonymous arrow function, got ${arrowFunctions.length}`);
    });
  });
});
