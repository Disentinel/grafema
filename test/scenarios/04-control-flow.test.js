/**
 * Тест для control flow конструкций
 * Проверяем: loops, switch, try/catch/finally, ternary, optional chaining
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
const FIXTURE_PATH = join(__dirname, '../fixtures/04-control-flow');

describe('Control Flow Analysis', () => {
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
      .hasNode('SERVICE', 'control-flow-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect all MODULE files', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // index.js + 3 src files = 4 modules
    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js')
      .hasNode('MODULE', 'src/loops.js')
      .hasNode('MODULE', 'src/exceptions.js')
      .hasNode('MODULE', 'src/conditionals.js')
      .hasNodeCount('MODULE', 4);
  });

  describe('Loop Detection (loops.js)', () => {
    it('should detect for-loop scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // loops.js содержит:
      // - processWithForLoop: 1 for loop (line 6)
      // - generateMatrix: 2 nested for loops (lines 66, 68)
      // - findFirst: 1 for loop (line 79)
      // - processEvenOnly: 1 for loop (line 91)

      const allNodes = await backend.getAllNodes();
      const forLoopScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'for-loop');

      assert.ok(forLoopScopes.length >= 5,
        `Expected at least 5 for-loop scopes, got ${forLoopScopes.length}`);
    });

    it('should detect for-of and for-in loop scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // loops.js содержит:
      // - sumWithForOf: for...of (line 18)
      // - processObjectKeys: for...in (line 29)

      const allNodes = await backend.getAllNodes();
      const forOfScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'for-of-loop');
      const forInScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'for-in-loop');

      assert.ok(forOfScopes.length >= 1,
        `Expected at least 1 for-of-loop scope, got ${forOfScopes.length}`);
      assert.ok(forInScopes.length >= 1,
        `Expected at least 1 for-in-loop scope, got ${forInScopes.length}`);
    });

    it('should detect while and do-while loop scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // loops.js содержит:
      // - countDown: while loop (line 41)
      // - readUntilValid: do-while loop (line 54)

      const allNodes = await backend.getAllNodes();
      const whileScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'while-loop');
      const doWhileScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'do-while-loop');

      assert.ok(whileScopes.length >= 1,
        `Expected at least 1 while-loop scope, got ${whileScopes.length}`);
      assert.ok(doWhileScopes.length >= 1,
        `Expected at least 1 do-while-loop scope, got ${doWhileScopes.length}`);
    });

    it('should detect all loop-related functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'processWithForLoop')
        .hasNode('FUNCTION', 'sumWithForOf')
        .hasNode('FUNCTION', 'processObjectKeys')
        .hasNode('FUNCTION', 'countDown')
        .hasNode('FUNCTION', 'readUntilValid')
        .hasNode('FUNCTION', 'generateMatrix')
        .hasNode('FUNCTION', 'findFirst')
        .hasNode('FUNCTION', 'processEvenOnly');
    });
  });

  describe('Exception Handling Detection (exceptions.js)', () => {
    it('should detect try-block scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // exceptions.js содержит несколько try/catch/finally блоков

      const allNodes = await backend.getAllNodes();
      const tryBlockScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'try-block');

      assert.ok(tryBlockScopes.length >= 5,
        `Expected at least 5 try-block scopes, got ${tryBlockScopes.length}`);
    });

    it('should detect catch-block scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const catchBlockScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'catch-block');

      assert.ok(catchBlockScopes.length >= 5,
        `Expected at least 5 catch-block scopes, got ${catchBlockScopes.length}`);
    });

    it('should detect finally-block scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // readFileWithErrorHandling и withFinally имеют finally блоки

      const allNodes = await backend.getAllNodes();
      const finallyBlockScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'finally-block');

      assert.ok(finallyBlockScopes.length >= 2,
        `Expected at least 2 finally-block scopes, got ${finallyBlockScopes.length}`);
    });

    it('should detect exception handling functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'readFileWithErrorHandling')
        .hasNode('FUNCTION', 'validateAndProcess')
        .hasNode('FUNCTION', 'complexOperation')
        .hasNode('FUNCTION', 'fetchWithRetry')
        .hasNode('FUNCTION', 'handleDifferentErrors')
        .hasNode('FUNCTION', 'withFinally');
    });
  });

  describe('Switch Statement Detection (conditionals.js)', () => {
    it('should detect switch-case scopes', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // conditionals.js содержит:
      // - processCommand: switch (line 5)
      // - getCategory: switch (line 37)

      const allNodes = await backend.getAllNodes();
      const switchScopes = allNodes.filter(n => n.type === 'SCOPE' && n.scopeType === 'switch-case');

      assert.ok(switchScopes.length >= 2,
        `Expected at least 2 switch-case scopes, got ${switchScopes.length}`);
    });

    it('should detect conditional functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'processCommand')
        .hasNode('FUNCTION', 'getCategory')
        .hasNode('FUNCTION', 'getStatus')
        .hasNode('FUNCTION', 'calculatePrice')
        .hasNode('FUNCTION', 'getGrade')
        .hasNode('FUNCTION', 'processUser');
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
        .hasEdge('SERVICE', 'control-flow-fixture', 'CONTAINS', 'MODULE', 'index.js')
        .hasEdge('SERVICE', 'control-flow-fixture', 'CONTAINS', 'MODULE', 'src/loops.js')
        .hasEdge('SERVICE', 'control-flow-fixture', 'CONTAINS', 'MODULE', 'src/exceptions.js')
        .hasEdge('SERVICE', 'control-flow-fixture', 'CONTAINS', 'MODULE', 'src/conditionals.js');
    });

    it('should connect functions to modules', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('MODULE', 'src/loops.js', 'CONTAINS', 'FUNCTION', 'processWithForLoop')
        .hasEdge('MODULE', 'src/exceptions.js', 'CONTAINS', 'FUNCTION', 'readFileWithErrorHandling')
        .hasEdge('MODULE', 'src/conditionals.js', 'CONTAINS', 'FUNCTION', 'processCommand');
    });

    it('should connect loop scopes to parent functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Функция processWithForLoop должна иметь скоуп body
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'processWithForLoop')
        .hasNode('SCOPE', 'processWithForLoop:body')
        .hasEdge('FUNCTION', 'processWithForLoop', 'HAS_SCOPE', 'SCOPE', 'processWithForLoop:body');
    });
  });

  describe('Console.log Detection in Control Flow', () => {
    it('should detect console.log calls inside loops', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // countDown и processObjectKeys содержат console.log внутри циклов
      (await assertGraph(backend))
        .hasNode('net:stdio', '__stdio__');

      const allNodes = await backend.getAllNodes();
      const methodCalls = allNodes.filter(n => n.type === 'CALL' && n.name === 'console.log');

      assert.ok(methodCalls.length >= 2,
        `Expected at least 2 console.log calls, got ${methodCalls.length}`);
    });

    it('should detect console.error calls in catch blocks', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // exceptions.js содержит console.error в catch блоках
      const allNodes = await backend.getAllNodes();
      const errorCalls = allNodes.filter(n => n.type === 'CALL' && n.name === 'console.error');

      assert.ok(errorCalls.length >= 3,
        `Expected at least 3 console.error calls, got ${errorCalls.length}`);
    });
  });
});
