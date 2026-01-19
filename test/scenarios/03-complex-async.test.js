import { describe, it, beforeEach, afterEach } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/03-complex-async');

describe('Complex Async Patterns Analysis', () => {
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

  it('should detect generator functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // app.js has: function* processDataGenerator
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'processDataGenerator')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'processDataGenerator', generator: true });

    // dataProcessor.js has: *processBatch
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'processBatch')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'processBatch', generator: true });

    // dataProcessor.js has: *getStats
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'getStats')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'getStats', generator: true });

    // Check total generator count
    const allFunctions = await backend.getAllNodes({ type: 'FUNCTION' });
    const generators = allFunctions.filter(n => n.generator);
    (await assertGraph(backend)).assert(
      generators.length >= 3,
      `Expected at least 3 generator functions, got ${generators.length}`
    );
  });

  it('should detect async generator functions', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // app.js has: async function* fetchDataStream
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'fetchDataStream')
      .hasNodeWithProps({
        type: 'FUNCTION',
        name: 'fetchDataStream',
        generator: true,
        async: true
      });

    // dataProcessor.js has: async *fetchUsersStream
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'fetchUsersStream')
      .hasNodeWithProps({
        type: 'FUNCTION',
        name: 'fetchUsersStream',
        generator: true,
        async: true
      });

    // Check async generator count
    const asyncGenerators = (await backend.getAllNodes()).filter(n =>
      n.type === 'FUNCTION' && n.generator && n.async
    );
    (await assertGraph(backend)).assert(
      asyncGenerators.length >= 2,
      `Expected at least 2 async generators, got ${asyncGenerators.length}`
    );
  });

  it('should detect class instantiation with new keyword', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // app.js line 10: const app = new express();
    (await assertGraph(backend))
      .hasNode('CONSTANT', 'app')
      .hasNode('CLASS', 'express')
      .hasEdge('CONSTANT', 'app', 'INSTANCE_OF', 'CLASS', 'express');

    // app.js line 11: const redisClient = createClient();
    // This is NOT new expression, should be VARIABLE
    const redisClient = (await backend.getAllNodes()).find(n =>
      n.name === 'redisClient' && n.line === 11
    );
    (await assertGraph(backend)).assert(
      redisClient && redisClient.type === 'VARIABLE',
      'redisClient should be VARIABLE (not new expression)'
    );

    // app.js line 41: const config = new AppConfig();
    (await assertGraph(backend))
      .hasNode('CONSTANT', 'config')
      .hasNode('CLASS', 'AppConfig')
      .hasEdge('CONSTANT', 'config', 'INSTANCE_OF', 'CLASS', 'AppConfig');
  });

  it('should detect classes with methods and this binding', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // AppConfig class methods
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'constructor')
      .hasNode('FUNCTION', 'getPort')
      .hasNode('FUNCTION', 'initDatabase')
      .hasNode('FUNCTION', 'logError');

    // Arrow function as method (preserves this)
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'handleError');

    const handleError = (await backend.getAllNodes()).find(n =>
      n.type === 'FUNCTION' && n.name === 'handleError'
    );
    (await assertGraph(backend)).assert(
      handleError && handleError.arrowFunction,
      'handleError should be arrow function'
    );

    // DataProcessor class
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'initialize')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'initialize', async: true });
  });

  it('should detect callback hell patterns', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // routes/api.js: POST /users/register has 6-level callback pyramid
    // Should detect nested callbacks through multiple function nodes

    // Check that we detect the main route handler
    const routeHandlers = (await backend.getAllNodes()).filter(n =>
      n.type === 'FUNCTION' &&
      n.file && n.file.includes('routes/api.js')
    );

    (await assertGraph(backend)).assert(
      routeHandlers.length >= 10,
      `Expected at least 10 functions in routes/api.js (callback handlers), got ${routeHandlers.length}`
    );
  });

  it('should detect promise chains', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Functions that return promises
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'loadUserData')
      .hasNode('FUNCTION', 'retryWithBackoff')
      .hasNode('FUNCTION', 'promiseRace')
      .hasNode('FUNCTION', 'sequentialPromises');
  });

  it('should detect method calls on external objects', async () => {
    await orchestrator.run(FIXTURE_PATH);


    // mongoose.connect() calls (now unified as CALL type)
    const mongooseCalls = (await backend.getAllNodes()).filter(n =>
      n.type === 'CALL' &&
      n.name && n.name.includes('mongoose.connect')
    );

    (await assertGraph(backend)).assert(
      mongooseCalls.length >= 1,
      `Expected mongoose.connect calls, got ${mongooseCalls.length}`
    );

    // redis method calls (now unified as CALL type)
    const redisCalls = (await backend.getAllNodes()).filter(n =>
      n.type === 'CALL' &&
      n.name && (n.name.includes('redis') || n.name.includes('redisClient'))
    );

    (await assertGraph(backend)).assert(
      redisCalls.length >= 5,
      `Expected multiple Redis method calls, got ${redisCalls.length}`
    );
  });

  it('should detect Mongoose schema methods with this binding', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // models/User.js schema methods
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'comparePassword')
      .hasNode('FUNCTION', 'generateAuthToken')
      .hasNode('FUNCTION', 'updateLastLogin')
      .hasNode('FUNCTION', 'getFullProfile');

    // Static methods
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'findByEmail')
      .hasNode('FUNCTION', 'findActive')
      .hasNode('FUNCTION', 'createWithProfile');

    // Pre/post hooks
    const preSaveHook = (await backend.getAllNodes()).find(n =>
      n.type === 'FUNCTION' &&
      n.file && n.file.includes('models/User.js') &&
      n.line >= 170 && n.line <= 185
    );

    (await assertGraph(backend)).assert(
      preSaveHook,
      'Expected pre-save hook function in User.js'
    );
  });

  it('should detect Express middleware and routes', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Middleware functions
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'authMiddleware')
      .hasNode('FUNCTION', 'authMiddlewareCallback')
      .hasNode('FUNCTION', 'authMiddlewarePromise')
      .hasNode('FUNCTION', 'rateLimitMiddleware');

    // Route handler detection
    const routeHandlers = (await backend.getAllNodes()).filter(n =>
      n.type === 'FUNCTION' &&
      n.file && n.file.includes('api.js')
    );

    (await assertGraph(backend)).assert(
      routeHandlers.length >= 10,
      `Expected multiple route handlers, got ${routeHandlers.length}`
    );
  });

  it('should detect event listeners on process', async () => {
    await orchestrator.run(FIXTURE_PATH);


    // process.on('SIGINT', callback)
    (await assertGraph(backend))
      .hasNode('event:listener', 'SIGINT');

    // process.on('uncaughtException', callback)
    (await assertGraph(backend))
      .hasNode('event:listener', 'uncaughtException');

    const eventListeners = (await backend.getAllNodes()).filter(n => n.type === 'event:listener');
    (await assertGraph(backend)).assert(
      eventListeners.length >= 2,
      `Expected at least 2 event listeners, got ${eventListeners.length}`
    );
  });

  it('should detect arrow functions in callbacks', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Count arrow functions
    const arrowFunctions = (await backend.getAllNodes()).filter(n =>
      n.type === 'FUNCTION' && n.arrowFunction
    );

    (await assertGraph(backend)).assert(
      arrowFunctions.length >= 50,
      `Expected many arrow functions (callbacks), got ${arrowFunctions.length}`
    );
  });

  it('should detect async/await patterns', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Async functions
    (await assertGraph(backend))
      .hasNode('FUNCTION', 'processUserRequest')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'processUserRequest', async: true });

    (await assertGraph(backend))
      .hasNode('FUNCTION', 'initDatabase')
      .hasNodeWithProps({ type: 'FUNCTION', name: 'initDatabase', async: true });

    const asyncFunctions = (await backend.getAllNodes()).filter(n =>
      n.type === 'FUNCTION' && n.async
    );

    (await assertGraph(backend)).assert(
      asyncFunctions.length >= 10,
      `Expected multiple async functions, got ${asyncFunctions.length}`
    );
  });

  it('should detect complex nested structures', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Verify we have multiple modules
    const modules = (await backend.getAllNodes()).filter(n => n.type === 'MODULE');
    (await assertGraph(backend)).assert(
      modules.length === 6,
      `Expected 6 modules, got ${modules.length}`
    );

    // Verify we have scopes
    const scopes = (await backend.getAllNodes()).filter(n => n.type === 'SCOPE');
    (await assertGraph(backend)).assert(
      scopes.length >= 10,
      `Expected multiple scopes, got ${scopes.length}`
    );

    // Verify CONTAINS edges
    const containsEdges = (await backend.getAllEdges()).filter(e => e.type === 'CONTAINS');
    (await assertGraph(backend)).assert(
      containsEdges.length >= 50,
      `Expected many CONTAINS edges, got ${containsEdges.length}`
    );
  });

  it('should detect imported modules', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // app.js imports
    (await assertGraph(backend))
      .hasNode('EXTERNAL_MODULE', 'express')
      .hasNode('EXTERNAL_MODULE', 'mongoose')
      .hasNode('EXTERNAL_MODULE', 'redis');

    // models/User.js imports
    (await assertGraph(backend))
      .hasNode('EXTERNAL_MODULE', 'bcrypt')
      .hasNode('EXTERNAL_MODULE', 'jsonwebtoken');

    // Check IMPORTS edges (19 total: 9 external + 6 module-to-module)
    // EXTERNAL_MODULE imports (9 edges):
    // - models/User.js: 3 (mongoose, bcrypt, jsonwebtoken)
    // - app.js: 3 (express, mongoose, redis)
    // - routes/api.js: 3 (express, mongoose, redis)
    // - services/dataProcessor.js: 2 (mongoose, redis)
    // - middleware/auth.js: 2 (jsonwebtoken, redis)
    //
    // MODULE->MODULE imports (6 edges):
    // - app.js: 4 (routes/api.js, middleware/auth.js, services/dataProcessor.js, utils/asyncHelpers.js)
    // - routes/api.js: 1 (models/User.js)
    // - middleware/auth.js: 1 (models/User.js)
    const importsEdges = (await backend.getAllEdges()).filter(e => e.type === 'IMPORTS');
    (await assertGraph(backend)).assert(
      importsEdges.length === 19,
      `Expected 19 IMPORTS edges (9 external + 6 module-to-module + 4 internal), got ${importsEdges.length}`
    );
  });

  it('should handle errors gracefully and continue analyzing other files', async () => {
    await orchestrator.run(FIXTURE_PATH);
    

    // Even if some files have errors, we should still get results
    const modules = (await backend.getAllNodes()).filter(n => n.type === 'MODULE');
    (await assertGraph(backend)).assert(
      modules.length >= 1,
      'Should analyze at least one module even with errors'
    );

    const functions = (await backend.getAllNodes()).filter(n => n.type === 'FUNCTION');
    (await assertGraph(backend)).assert(
      functions.length >= 10,
      'Should detect functions even with some errors'
    );
  });
});
