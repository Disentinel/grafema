/**
 * Тест для простого скрипта
 * Проверяем базовую функциональность: парсинг функций, вызовов, console.log
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
const FIXTURE_PATH = join(__dirname, '../fixtures/01-simple-script');

describe('Simple Script Analysis', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();

    // Используем унифицированный helper для создания orchestrator
    orchestrator = createTestOrchestrator(backend);
  });

  afterEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  it('should detect SERVICE from package.json', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - SERVICE node: "simple-script"

    (await assertGraph(backend))
      .hasNode('SERVICE', 'simple-script')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect MODULE node for index.js', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - MODULE node: "index.js"
    // - SERVICE -> CONTAINS -> MODULE

    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js')
      .hasEdge('SERVICE', 'simple-script', 'CONTAINS', 'MODULE', 'index.js');
  });

  it('should detect FUNCTION nodes', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - FUNCTION nodes: "greet", "conditionalGreet", "createCounter", "main"
    // - FunctionExpression: "increment" (внутри createCounter)
    // - MODULE -> CONTAINS -> FUNCTION (x4 named functions)

    (await assertGraph(backend))
      .hasNode('FUNCTION', 'greet')
      .hasNode('FUNCTION', 'conditionalGreet')
      .hasNode('FUNCTION', 'createCounter')
      .hasNode('FUNCTION', 'main')
      .hasNode('FUNCTION', 'increment')  // FunctionExpression внутри createCounter
      .hasNodeCount('FUNCTION', 5) // 4 FunctionDeclarations + 1 FunctionExpression
      .hasEdge('MODULE', 'index.js', 'CONTAINS', 'FUNCTION', 'greet')
      .hasEdge('MODULE', 'index.js', 'CONTAINS', 'FUNCTION', 'main');
  });

  it('should detect const DECLARATIONS', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED (NEW ARCHITECTURE):
    // - FUNCTION:main has SCOPE:main:body
    // - SCOPE:main:body declares VARIABLE:result
    // - SCOPE:main:body declares VARIABLE:counter

    (await assertGraph(backend))
      .hasNode('VARIABLE', 'result')
      .hasNode('VARIABLE', 'counter')
      .hasNode('SCOPE', 'main:body')
      .hasEdge('FUNCTION', 'main', 'HAS_SCOPE', 'SCOPE', 'main:body')
      .hasEdge('SCOPE', 'main:body', 'DECLARES', 'VARIABLE', 'result')
      .hasEdge('SCOPE', 'main:body', 'DECLARES', 'VARIABLE', 'counter');
  });

  it('should detect function CALLS', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED (NEW ARCHITECTURE):
    // - CALL nodes exist for each call (unified from CALL_SITE and METHOD_CALL)
    // - MODULE contains CALL:main (module level call)
    // - SCOPE:main:body contains CALL:greet (unconditional call in main)
    // - SCOPE:if:8 contains CALL:greet (conditional call in conditionalGreet)
    // - CALL -> CALLS -> FUNCTION

    (await assertGraph(backend))
      .hasNode('CALL', 'main')
      // Module calls main()
      .hasEdge('MODULE', 'index.js', 'CONTAINS', 'CALL', 'main')
      .hasEdge('CALL', 'main', 'CALLS', 'FUNCTION', 'main');
  });

  it('should detect closures and MODIFY operations', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - createCounter declares variable 'count'
    // - increment function (closure) CAPTURES 'count' from parent scope
    // - increment function MODIFIES 'count' (count++)

    (await assertGraph(backend))
      // createCounter has a scope that declares count
      .hasNode('FUNCTION', 'createCounter')
      .hasNode('SCOPE', 'createCounter:body')
      .hasNode('VARIABLE', 'count')
      .hasEdge('FUNCTION', 'createCounter', 'HAS_SCOPE', 'SCOPE', 'createCounter:body')
      .hasEdge('SCOPE', 'createCounter:body', 'DECLARES', 'VARIABLE', 'count')
      // increment function captures count
      .hasNode('FUNCTION', 'increment')
      .hasEdge('SCOPE', 'increment:body', 'CAPTURES', 'VARIABLE', 'count')
      // increment modifies count (count++)
      .hasEdge('SCOPE', 'increment:body', 'MODIFIES', 'VARIABLE', 'count');
  });

  it('should detect console.log as WRITES_TO __stdio__', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - net:stdio node: "__stdio__"
    // - CALL nodes for console.log (x3: greet, increment, main)
    // - CALL -> WRITES_TO -> net:stdio (x3)

    (await assertGraph(backend))
      .hasNode('net:stdio', '__stdio__')
      // Check via WRITES_TO edges since CALL now includes both function calls and method calls
      .hasEdgeCount('WRITES_TO', 3);    // 3 console.log calls write to stdio
  });

  it('should have valid graph structure', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // VALIDATION:
    // - All edges point to existing nodes
    // - No duplicate IDs

    (await assertGraph(backend))
      .allEdgesValid()
      .noDuplicateIds();
  });

  it('should trace path: SERVICE -> MODULE -> FUNCTION', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED PATH:
    // SERVICE:simple-script
    //   -> CONTAINS -> MODULE:index.js
    //   -> CONTAINS -> FUNCTION:greet
    //
    // Note: Simplified path test - SCOPE names contain ':' which conflicts with hasPath separator

    (await assertGraph(backend)).hasPath(
      'SERVICE:simple-script',
      'CONTAINS',
      'MODULE:index.js',
      'CONTAINS',
      'FUNCTION:greet'
    );
  });
});
