/**
 * Test: AnalysisQueue - Queue-based parallel analysis
 *
 * Tests:
 * 1. Queue initialization with workers
 * 2. Task distribution and processing
 * 3. Barrier waiting for completion
 * 4. Plugin selection per file
 * 5. Error handling
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { existsSync, rmSync, readdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { tmpdir } from 'os';
import { setTimeout as sleep } from 'timers/promises';

import { AnalysisQueue } from '@grafema/core';
import { RFDBClient } from '@grafema/core';

/**
 * Wrap a promise with a timeout
 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${message}`)), ms)
    )
  ]);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDir = mkdtempSync(join(tmpdir(), 'rfdb-queue-'));
const TEST_DB_PATH = join(testDir, 'graph.rfdb');
const TEST_SOCKET_PATH = join(testDir, 'rfdb.sock');
const SERVER_BINARY = join(__dirname, '../../packages/rfdb-server/target/debug/rfdb-server');
const FIXTURE_PATH = join(__dirname, '../fixtures/03-complex-async');

describe('AnalysisQueue', () => {
  let serverProcess = null;
  let queue = null;

  before(async () => {
    // Ensure server binary exists
    if (!existsSync(SERVER_BINARY)) {
      console.log('Building rfdb-server...');
      const { execSync } = await import('child_process');
      execSync('cargo build --bin rfdb-server', {
        cwd: join(__dirname, '../../packages/rfdb-server'),
        stdio: 'inherit'
      });
    }

    // Start server
    console.log('Starting rfdb-server...');
    serverProcess = spawn(SERVER_BINARY, [TEST_DB_PATH, '--socket', TEST_SOCKET_PATH], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg.includes('FLUSH') && !msg.includes('WRITER')) {
        console.log(`[server] ${msg}`);
      }
    });

    // Wait for server
    await sleep(1500);
    assert.ok(existsSync(TEST_SOCKET_PATH), 'Server socket should exist');
  });

  after(async () => {
    // Stop queue
    if (queue) {
      await queue.stop();
    }

    // Stop server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
    }

    // Cleanup temp directory
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should initialize with configurable worker count', async () => {
    queue = new AnalysisQueue({
      socketPath: TEST_SOCKET_PATH,
      maxWorkers: 2,
      plugins: ['JSASTAnalyzer'],
    });

    await queue.start();

    assert.strictEqual(queue.maxWorkers, 2);
    assert.strictEqual(queue.workers.length, 2);
    assert.ok(queue.running);
  });

  it('should process tasks through the queue', async () => {
    // Collect JS files from fixture
    const files = readdirSync(FIXTURE_PATH)
      .filter(f => f.endsWith('.js'))
      .map((f, i) => ({
        file: join(FIXTURE_PATH, f),
        moduleId: `MODULE#queue_test${i}`,
        moduleName: f.replace('.js', ''),
        plugins: ['JSASTAnalyzer'],
      }));

    console.log(`Adding ${files.length} tasks to queue...`);

    // Add tasks
    for (const task of files) {
      queue.addTask(task);
    }

    // Wait for completion with timeout
    const stats = await withTimeout(
      queue.waitForCompletion(),
      30000,
      'waitForCompletion() - tasks may not be completing'
    );

    console.log('Queue stats:', stats);

    assert.strictEqual(stats.tasksCompleted + stats.tasksFailed, files.length);
    assert.ok(stats.nodesCreated > 0, 'Should create nodes');
    assert.ok(stats.edgesCreated > 0, 'Should create edges');
  });

  it('should run multiple plugins per file', async () => {
    // Reset queue state for new batch
    queue.stats = {
      tasksTotal: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      startTime: Date.now(),
      errors: [],
    };
    queue.draining = false;

    const testFile = join(FIXTURE_PATH, 'app.js');

    queue.addTask({
      file: testFile,
      moduleId: 'MODULE#multi_plugin_test',
      moduleName: 'multi_plugin_test',
      plugins: ['JSASTAnalyzer', 'ExpressRouteAnalyzer', 'FetchAnalyzer'],
    });

    const stats = await withTimeout(
      queue.waitForCompletion(),
      30000,
      'waitForCompletion() - multi-plugin task not completing'
    );

    assert.strictEqual(stats.tasksCompleted, 1, `Expected 1 completed, got ${stats.tasksCompleted}. Errors: ${JSON.stringify(stats.errors)}`);
    assert.ok(stats.nodesCreated > 0, 'Should create nodes from JSASTAnalyzer');
  });

  it('should handle errors gracefully', async () => {
    // Reset queue state for new batch
    queue.stats = {
      tasksTotal: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      startTime: Date.now(),
      errors: [],
    };
    queue.draining = false;

    // Add task with non-existent file
    queue.addTask({
      file: '/nonexistent/file.js',
      moduleId: 'MODULE#error_test',
      moduleName: 'error_test',
      plugins: ['JSASTAnalyzer'],
    });

    const stats = await withTimeout(
      queue.waitForCompletion(),
      30000,
      'waitForCompletion() - error handling task not completing'
    );

    assert.strictEqual(stats.tasksFailed, 1);
    assert.ok(stats.errors.length > 0, 'Should record error');
  });

  it('should provide real-time stats', async () => {
    // Stop current queue
    await queue.stop();

    // Create new queue with more workers
    queue = new AnalysisQueue({
      socketPath: TEST_SOCKET_PATH,
      maxWorkers: 4,
      plugins: ['JSASTAnalyzer'],
    });

    await queue.start();

    // Add many tasks
    const files = readdirSync(FIXTURE_PATH)
      .filter(f => f.endsWith('.js'));

    // Triple the files for more tasks
    for (let batch = 0; batch < 3; batch++) {
      for (const f of files) {
        queue.addTask({
          file: join(FIXTURE_PATH, f),
          moduleId: `MODULE#stats_test_${batch}_${f}`,
          moduleName: `stats_test_${batch}_${f}`,
          plugins: ['JSASTAnalyzer'],
        });
      }
    }

    // Check stats while running
    let sawProgress = false;
    let checksCount = 0;

    while (checksCount < 20) {
      await sleep(50);
      const currentStats = queue.getStats();

      if (currentStats.tasksCompleted > 0 &&
          currentStats.tasksCompleted < currentStats.tasksTotal) {
        sawProgress = true;
        console.log(`Progress: ${currentStats.tasksCompleted}/${currentStats.tasksTotal} (${currentStats.active} active)`);
      }

      if (currentStats.pending === 0 && currentStats.active === 0) {
        break;
      }

      checksCount++;
    }

    await withTimeout(
      queue.waitForCompletion(),
      30000,
      'waitForCompletion() - real-time stats tasks not completing'
    );

    const finalStats = queue.getStats();
    assert.strictEqual(finalStats.pending, 0);
    assert.strictEqual(finalStats.active, 0);
  });

  it('should verify results in RFDB', async () => {
    // Connect to RFDB and verify nodes were created
    const client = new RFDBClient(TEST_SOCKET_PATH);
    await client.connect();

    const nodeCount = await client.nodeCount();
    const edgeCount = await client.edgeCount();

    console.log(`RFDB contains: ${nodeCount} nodes, ${edgeCount} edges`);

    assert.ok(nodeCount > 0, 'RFDB should have nodes');
    assert.ok(edgeCount > 0, 'RFDB should have edges');

    // Check for MODULE nodes
    const modules = await client.findByType('MODULE');
    assert.ok(modules.length > 0, 'Should have MODULE nodes');

    // Check for FUNCTION nodes
    const functions = await client.findByType('FUNCTION');
    assert.ok(functions.length > 0, 'Should have FUNCTION nodes');

    await client.close();
  });
});
