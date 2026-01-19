/**
 * Тест для re-export паттернов (export * from)
 *
 * Проверяем что JSModuleIndexer следует за export * from
 * и правильно индексирует все транзитивные зависимости
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
const FIXTURE_PATH = join(__dirname, '../fixtures/08-reexports');

describe('Re-export Pattern Analysis', () => {
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
      .hasNode('SERVICE', 'reexports-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  describe('Module Discovery via export * from', () => {
    it('should discover barrel file (utils/index.js)', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('MODULE', 'index.js')
        .hasNode('MODULE', 'utils/index.js');
    });

    it('should follow export * from and discover math.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Ключевой тест: utils/math.js должен быть обнаружен
      // через цепочку index.js -> utils/index.js -> (export * from math.js)
      (await assertGraph(backend))
        .hasNode('MODULE', 'utils/math.js');
    });

    it('should follow export * from and discover string.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('MODULE', 'utils/string.js');
    });

    it('should follow named re-export and discover helpers.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // export { helper } from './helpers.js' тоже должен создавать зависимость
      (await assertGraph(backend))
        .hasNode('MODULE', 'utils/helpers.js');
    });

    it('should discover all modules in the dependency tree', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Полный список модулей:
      // 1. index.js (entry point)
      // 2. utils/index.js (barrel)
      // 3. utils/math.js (via export *)
      // 4. utils/string.js (via export *)
      // 5. utils/helpers.js (via named export)
      (await assertGraph(backend))
        .hasNodeCount('MODULE', 5);
    });
  });

  describe('Dependency Edges', () => {
    it('should create DEPENDS_ON edge from index.js to utils/index.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('MODULE', 'index.js', 'DEPENDS_ON', 'MODULE', 'utils/index.js');
    });

    it('should create DEPENDS_ON edges from barrel to actual modules', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const allNodes = await backend.getAllNodes();
      const dependsOnEdges = allEdges.filter(e => e.type === 'DEPENDS_ON');

      // Find barrel module node
      const barrelModule = allNodes.find(n =>
        n.type === 'MODULE' && n.name === 'utils/index.js'
      );
      assert.ok(barrelModule, 'Barrel module utils/index.js should exist');

      // barrel должен иметь DEPENDS_ON к math.js, string.js, helpers.js
      const barrelEdges = dependsOnEdges.filter(e => {
        const src = e.fromId || e.src;
        return src === barrelModule.id;
      });

      assert.ok(barrelEdges.length >= 3,
        `Expected at least 3 DEPENDS_ON edges from barrel, got ${barrelEdges.length}`);
    });
  });

  describe('Function Detection in Re-exported Modules', () => {
    it('should detect functions in math.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'add')
        .hasNode('FUNCTION', 'subtract')
        .hasNode('FUNCTION', 'multiply')
        .hasNode('FUNCTION', 'divide');
    });

    it('should detect functions in string.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'capitalize')
        .hasNode('FUNCTION', 'lowercase')
        .hasNode('FUNCTION', 'trim');
    });

    it('should detect functions in helpers.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'helper')
        .hasNode('FUNCTION', 'internalHelper');
    });
  });

  describe('Graph Structure Validation', () => {
    it('should have valid graph structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .allEdgesValid()
        .noDuplicateIds();
    });

    it('should connect all modules to service', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const containsEdges = allEdges.filter(e => e.type === 'CONTAINS');

      const allNodes = await backend.getAllNodes();
      const serviceNode = allNodes.find(n => n.type === 'SERVICE');
      const moduleNodes = allNodes.filter(n => n.type === 'MODULE');

      // Каждый модуль должен быть связан с сервисом через CONTAINS
      for (const mod of moduleNodes) {
        const hasContainsEdge = containsEdges.some(e => {
          const src = e.fromId || e.src;
          const dst = e.toId || e.dst;
          return src === serviceNode.id && dst === mod.id;
        });
        assert.ok(hasContainsEdge,
          `Module ${mod.name} should be connected to SERVICE via CONTAINS`);
      }
    });
  });
});
