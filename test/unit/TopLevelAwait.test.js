/**
 * Top-Level Await Tracking Tests (REG-297)
 *
 * Tests for:
 * 1. hasTopLevelAwait: true on MODULE node when module uses top-level await
 * 2. isAwaited: true on CALL nodes at module level when wrapped in await
 *
 * Query examples this enables:
 * - "Does this module block on initialization?" → MODULE { hasTopLevelAwait: true }
 * - "What does this module await at startup?" → MODULE --CONTAINS--> CALL { isAwaited: true }
 *
 * Test cases:
 * 1. Basic await call: `const data = await fetchData();` → MODULE.hasTopLevelAwait + CALL.isAwaited
 * 2. Method call: `await db.connect();` → CALL.isAwaited on method call
 * 3. for await...of: `for await (const x of stream) {}` → MODULE.hasTopLevelAwait
 * 4. Await inside function only → NO hasTopLevelAwait
 * 5. Multiple top-level awaits → all CALL nodes marked
 * 6. No await → no hasTopLevelAwait
 * 7. Await variable (no call): `const x = await promise;` → MODULE.hasTopLevelAwait
 * 8. Conditional await: `if (x) { await foo(); }` → MODULE.hasTopLevelAwait + CALL.isAwaited
 * 9. Try/catch await: `try { await foo(); } catch (e) {}` → MODULE.hasTopLevelAwait + CALL.isAwaited
 * 10. Mixed: top-level await + function-level await → only MODULE gets hasTopLevelAwait
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('Top-Level Await Tracking (REG-297)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-tla-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project (type: module for top-level await)
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-tla-${testCounter}`, type: 'module' })
    );

    // Write test files
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    return testDir;
  }

  /**
   * Clean up test directory
   */
  function cleanupTestDir() {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      testDir = null;
    }
  }

  beforeEach(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
  });

  describe('hasTopLevelAwait on MODULE node', () => {
    it('should set hasTopLevelAwait when module has awaited function call', async () => {
      const projectPath = await setupTest({
        'index.js': `
const data = await fetchData();
export { data };
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');
    });

    it('should NOT set hasTopLevelAwait when await is only inside functions', async () => {
      const projectPath = await setupTest({
        'index.js': `
async function loadData() {
  const data = await fetchData();
  return data;
}
export { loadData };
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.ok(!moduleNode.hasTopLevelAwait, 'MODULE should NOT have hasTopLevelAwait');
    });

    it('should NOT set hasTopLevelAwait when module has no await', async () => {
      const projectPath = await setupTest({
        'index.js': `
const x = 42;
export { x };
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.ok(!moduleNode.hasTopLevelAwait, 'MODULE should NOT have hasTopLevelAwait');
    });

    it('should set hasTopLevelAwait for awaited method call', async () => {
      const projectPath = await setupTest({
        'index.js': `
const db = {};
await db.connect();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');
    });

    it('should set hasTopLevelAwait for for-await-of', async () => {
      const projectPath = await setupTest({
        'index.js': `
const stream = [];
for await (const item of stream) {
  console.log(item);
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true for for-await-of');
    });

    it('should set hasTopLevelAwait for await on variable (no call)', async () => {
      const projectPath = await setupTest({
        'index.js': `
const promise = Promise.resolve(42);
const result = await promise;
export { result };
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait even when awaiting a variable');
    });

    it('should set hasTopLevelAwait for multiple top-level awaits', async () => {
      const projectPath = await setupTest({
        'index.js': `
const config = await loadConfig();
const db = await connectDB();
const server = await startServer();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');
    });
  });

  describe('isAwaited on CALL nodes at module level', () => {
    it('should mark module-level call as isAwaited when wrapped in await', async () => {
      const projectPath = await setupTest({
        'index.js': `
const data = await fetchData();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchData');
      assert.ok(callNode, 'CALL node for fetchData should exist');
      assert.strictEqual(callNode.isAwaited, true, 'CALL node should have isAwaited: true');
    });

    it('should mark module-level method call as isAwaited when wrapped in await', async () => {
      const projectPath = await setupTest({
        'index.js': `
const db = {};
await db.connect();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'db.connect');
      assert.ok(callNode, 'CALL node for db.connect should exist');
      assert.strictEqual(callNode.isAwaited, true, 'CALL node should have isAwaited: true');
    });

    it('should NOT mark module-level call as isAwaited when not wrapped in await', async () => {
      const projectPath = await setupTest({
        'index.js': `
const data = fetchData();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchData');
      assert.ok(callNode, 'CALL node for fetchData should exist');
      assert.ok(!callNode.isAwaited, 'CALL node should NOT have isAwaited');
    });

    it('should mark all awaited calls in module with multiple awaits', async () => {
      const projectPath = await setupTest({
        'index.js': `
const config = await loadConfig();
const db = await connectDB();
const sync = fetchSync();
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const loadConfigCall = allNodes.find(n => n.type === 'CALL' && n.name === 'loadConfig');
      assert.ok(loadConfigCall, 'CALL node for loadConfig should exist');
      assert.strictEqual(loadConfigCall.isAwaited, true, 'loadConfig CALL should have isAwaited: true');

      const connectDBCall = allNodes.find(n => n.type === 'CALL' && n.name === 'connectDB');
      assert.ok(connectDBCall, 'CALL node for connectDB should exist');
      assert.strictEqual(connectDBCall.isAwaited, true, 'connectDB CALL should have isAwaited: true');

      const fetchSyncCall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchSync');
      assert.ok(fetchSyncCall, 'CALL node for fetchSync should exist');
      assert.ok(!fetchSyncCall.isAwaited, 'fetchSync CALL should NOT have isAwaited');
    });

    it('should mark awaited call inside conditional at module level', async () => {
      const projectPath = await setupTest({
        'index.js': `
const env = process.env.NODE_ENV;
if (env === 'production') {
  await setupProd();
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');

      const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'setupProd');
      assert.ok(callNode, 'CALL node for setupProd should exist');
      assert.strictEqual(callNode.isAwaited, true, 'setupProd CALL should have isAwaited: true');
    });

    it('should mark awaited call inside try/catch at module level', async () => {
      const projectPath = await setupTest({
        'index.js': `
try {
  await riskyInit();
} catch (e) {
  console.error(e);
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');

      const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'riskyInit');
      assert.ok(callNode, 'CALL node for riskyInit should exist');
      assert.strictEqual(callNode.isAwaited, true, 'riskyInit CALL should have isAwaited: true');
    });
  });

  describe('Mixed scenarios', () => {
    it('should set hasTopLevelAwait even when function-level await also exists', async () => {
      const projectPath = await setupTest({
        'index.js': `
const config = await loadConfig();

async function processData() {
  const data = await fetchData();
  return data;
}

export { config, processData };
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();

      const moduleNode = allNodes.find(n => n.type === 'MODULE' && n.name === 'index.js');
      assert.ok(moduleNode, 'MODULE node should exist');
      assert.strictEqual(moduleNode.hasTopLevelAwait, true, 'MODULE should have hasTopLevelAwait: true');

      // Module-level call should be marked awaited
      const loadConfigCall = allNodes.find(n => n.type === 'CALL' && n.name === 'loadConfig');
      assert.ok(loadConfigCall, 'CALL node for loadConfig should exist');
      assert.strictEqual(loadConfigCall.isAwaited, true, 'loadConfig should be isAwaited');
    });
  });
});
