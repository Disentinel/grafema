import { describe, it, beforeEach, afterEach } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/02-advanced-features');

describe('Advanced Features Analysis', () => {
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

  // ========================================
  // TEST #1: Import Statements
  // ========================================
  it('should detect import statements and create IMPORTS edges', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - MODULE:index.js -> IMPORTS -> MODULE:helper.js (relative import)
    // - MODULE:index.js -> IMPORTS -> EXTERNAL_MODULE:express (npm package)
    // - MODULE:index.js -> IMPORTS -> EXTERNAL_MODULE:fs/promises (node builtin)

    // 3 import statements total
    (await assertGraph(backend))
      .hasNodeCount('MODULE', 2)  // index.js and helper.js
      .hasEdgeCount('IMPORTS', 3)  // 3 import statements
      .hasEdge('MODULE', 'index.js', 'IMPORTS', 'MODULE', 'helper.js')
      .hasNode('EXTERNAL_MODULE', 'express')
      .hasNode('EXTERNAL_MODULE', 'fs/promises');
  });

  // ========================================
  // TEST #2: Arrow Functions
  // ========================================
  it('should detect arrow functions assigned to variables', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - FUNCTION:add (const add = (a, b) => a + b)
    // - FUNCTION:multiply (const multiply = (x, y) => { return x * y })
    // - Arrow functions in callbacks should also be detected:
    //   - map callback (line 18)
    //   - filter callback (line 19)
    //   - reduce callback (line 21)
    //   - process.on callback (line 32)
    //   - app.on callback (line 36)

    (await assertGraph(backend))
      .hasNode('FUNCTION', 'add')
      .hasNode('FUNCTION', 'multiply')
      // 13 functions total:
      // - 3 regular functions: processArray, setupServer, loadData
      // - 2 named arrow functions: add, multiply
      // - 5 anonymous arrow functions: map, filter, reduce, 2 event handlers
      // - 3 class methods: constructor, doSomething, calculate (from Helper class)
      .hasNodeCount('FUNCTION', 13);
  });

  // ========================================
  // TEST #3: Method Calls (beyond console.log)
  // ========================================
  it('should detect all method calls as CALL nodes', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED CALL nodes (unified from METHOD_CALL and CALL_SITE):
    // - app.listen(3000) - line 26
    // - helper.doSomething() - line 27
    // - helper.calculate(5) - line 29
    // - console.log('Result:', result) - line 30
    // - console.log('Shutting down') - line 33
    // - process.exit(0) - line 34
    // - console.error('Server error:', err) - line 38
    // - readFile('./data.txt', 'utf8') - line 43
    // - JSON.parse(data) - line 44
    // - arr.map(...) - line 18
    // - doubled.filter(...) - line 19
    // - filtered.reduce(...) - line 21
    // - loadData().catch(console.error) - line 51
    //
    // NOTE: process.on and app.on are event:listener nodes

    // Should detect multiple method calls (now unified as CALL)
    (await assertGraph(backend))
      .hasNode('CALL', 'app.listen')
      .hasNode('CALL', 'helper.doSomething')
      .hasNode('CALL', 'helper.calculate')
      .hasNode('CALL', 'process.exit')
      .hasNode('CALL', 'JSON.parse')
      .hasNode('CALL', 'arr.map')
      .hasNode('CALL', 'doubled.filter')
      .hasNode('CALL', 'filtered.reduce');

    // console.log and console.error should exist (at least 2)
    const consoleLogCalls = [];
    for await (const node of backend.queryNodes({ type: 'CALL' })) {
      if (node.name === 'console.log') {
        consoleLogCalls.push(node);
      }
    }
    if (consoleLogCalls.length < 2) {
      throw new Error(`Expected at least 2 console.log calls, found ${consoleLogCalls.length}`);
    }
  });

  // ========================================
  // TEST #4: Class Instantiation (new Expression)
  // ========================================
  it('should detect class instantiation and create INSTANCE_OF edges', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - const app = new express() -> VARIABLE:app -[INSTANCE_OF]-> CLASS:express
    // - const helper = new Helper() -> VARIABLE:helper -[INSTANCE_OF]-> CLASS:Helper

    (await assertGraph(backend))
      .hasNode('CONSTANT', 'app')
      .hasNode('CONSTANT', 'helper')
      .hasEdge('CONSTANT', 'app', 'INSTANCE_OF', 'CLASS', 'express')
      .hasEdge('CONSTANT', 'helper', 'INSTANCE_OF', 'CLASS', 'Helper');
  });

  // ========================================
  // TEST #5: Event Handlers (special event:listener nodes)
  // ========================================
  it('should detect event handlers as event:listener nodes', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - process.on('SIGINT', callback) -> event:listener:SIGINT
    // - app.on('error', callback) -> event:listener:error
    // - event:listener -> HANDLED_BY -> FUNCTION (callback)

    (await assertGraph(backend))
      .hasNode('event:listener', 'SIGINT')
      .hasNode('event:listener', 'error')
      .hasEdgeCount('HANDLED_BY', 2);  // 2 event listeners with handlers
  });

  // ========================================
  // TEST #6: Arrow Functions in Callbacks Context
  // ========================================
  it('should track arrow functions in method callback context', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - arr.map(x => x * 2) should have:
    //   - CALL:arr.map
    //   - FUNCTION for the arrow callback
    //   - CALL -[HAS_CALLBACK]-> FUNCTION

    const functions = await backend.getAllNodes({ type: 'FUNCTION' });
    const mapCallback = functions.find(n => n.line === 19);

    if (!mapCallback) {
      throw new Error('Arrow function callback on line 19 not found');
    }

    // Find HAS_CALLBACK edges to the callback
    const allEdges = await backend.getAllEdges();
    const callbackEdge = allEdges.find(e => e.type === 'HAS_CALLBACK' && e.dst === mapCallback.id);

    if (!callbackEdge) {
      throw new Error('No HAS_CALLBACK edge to the callback function found');
    }

    // Find the CALL node that has the edge (unified from METHOD_CALL)
    const calls = await backend.getAllNodes({ type: 'CALL' });
    const mapCall = calls.find(n => n.id === callbackEdge.src);

    if (!mapCall) {
      throw new Error('CALL source of HAS_CALLBACK edge not found');
    }

    if (mapCall.name !== 'arr.map') {
      throw new Error(`Expected CALL:arr.map but found CALL:${mapCall.name}`);
    }

    // Success - the edge exists from arr.map to the callback
  });

  // ========================================
  // TEST #7: Async/Await Detection
  // ========================================
  it('should detect async functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - FUNCTION:loadData should have async: true metadata

    const functions = await backend.getAllNodes({ type: 'FUNCTION' });
    const loadData = functions.find(n => n.name === 'loadData');

    if (!loadData) {
      throw new Error('Function loadData not found');
    }

    if (!loadData.async) {
      throw new Error('Function loadData should be marked as async');
    }
  });

  // ========================================
  // TEST #8: Complex Path Tracing
  // ========================================
  it('should trace path through imports and functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED PATH:
    // MODULE:index.js
    //   -> CONTAINS -> FUNCTION:setupServer
    //
    // Note: Simplified - SCOPE names contain ':' which conflicts with hasPath separator

    (await assertGraph(backend)).hasPath(
      'MODULE:index.js',
      'CONTAINS',
      'FUNCTION:setupServer'
    );
  });
});
