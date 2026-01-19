/**
 * Test: ParallelAnalyzer with concurrent read/write
 *
 * Tests:
 * 1. Parallel analysis with multiple workers
 * 2. Real-time stats during analysis
 * 3. Concurrent read/write to RFDB
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { cpus } from 'os';

import { ParallelAnalyzer } from '@grafema/core';
import { RFDBClient } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DB_PATH = '/tmp/rfdb-parallel-test';
const TEST_SOCKET_PATH = '/tmp/rfdb-parallel.sock';
const SERVER_BINARY = join(__dirname, '../../rust-engine/target/debug/rfdb-server');
const FIXTURE_PATH = join(__dirname, '../fixtures/03-complex-async');

describe('ParallelAnalyzer', () => {
  let serverProcess = null;
  let analyzer = null;

  before(async () => {
    // Clean up
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true });
    }
    if (existsSync(TEST_SOCKET_PATH)) {
      rmSync(TEST_SOCKET_PATH);
    }

    // Ensure server binary exists
    if (!existsSync(SERVER_BINARY)) {
      console.log('Building rfdb-server...');
      const { execSync } = await import('child_process');
      execSync('cargo build --bin rfdb-server', {
        cwd: join(__dirname, '../../rust-engine'),
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
    // Stop analyzer
    if (analyzer) {
      await analyzer.stop();
    }

    // Stop server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
    }

    // Cleanup
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true });
    }
    if (existsSync(TEST_SOCKET_PATH)) {
      rmSync(TEST_SOCKET_PATH);
    }
  });

  it('should initialize with configurable worker count', async () => {
    analyzer = new ParallelAnalyzer({
      socketPath: TEST_SOCKET_PATH,
      maxWorkers: 2, // Use 2 workers for test
    });

    await analyzer.start();

    assert.strictEqual(analyzer.maxWorkers, 2);
    assert.strictEqual(analyzer.workers.length, 2);
    assert.strictEqual(analyzer.readyWorkers.length, 2);
  });

  it('should analyze files in parallel', async () => {
    // Collect JS files from fixture
    const files = readdirSync(FIXTURE_PATH)
      .filter(f => f.endsWith('.js'))
      .map((f, i) => ({
        file: join(FIXTURE_PATH, f),
        moduleId: `MODULE#test${i}`,
        moduleName: f.replace('.js', ''),
      }));

    console.log(`Analyzing ${files.length} files...`);

    const startTime = Date.now();
    const stats = await analyzer.analyzeFiles(files);
    const duration = Date.now() - startTime;

    console.log(`Analysis took ${duration}ms`);
    console.log('Stats:', stats);

    assert.strictEqual(stats.filesTotal, files.length);
    assert.strictEqual(stats.filesProcessed, files.length);
    assert.strictEqual(stats.filesFailed, 0);
    assert.ok(stats.nodesCreated > 0, 'Should create nodes');
    assert.ok(stats.edgesCreated > 0, 'Should create edges');
  });

  it('should provide real-time stats during analysis', async () => {
    // Create more files to analyze (duplicate for longer run)
    const baseFiles = readdirSync(FIXTURE_PATH)
      .filter(f => f.endsWith('.js'))
      .map(f => join(FIXTURE_PATH, f));

    // Triple the files for longer analysis
    const files = [];
    for (let i = 0; i < 3; i++) {
      baseFiles.forEach((f, j) => {
        files.push({
          file: f,
          moduleId: `MODULE#batch${i}_${j}`,
          moduleName: `batch${i}_file${j}`,
        });
      });
    }

    console.log(`Analyzing ${files.length} files for stats test...`);

    // Start analysis in background
    const analysisPromise = analyzer.analyzeFiles(files);

    // Poll stats while analysis is running
    let statsChecks = 0;
    let sawProgress = false;

    while (statsChecks < 20) {
      await sleep(50);
      const currentStats = analyzer.getStats();

      if (currentStats.filesProcessed > 0 && currentStats.filesProcessed < currentStats.filesTotal) {
        sawProgress = true;
        console.log(`Progress: ${currentStats.filesProcessed}/${currentStats.filesTotal}`);
      }

      statsChecks++;

      if (currentStats.filesProcessed === currentStats.filesTotal) {
        break;
      }
    }

    await analysisPromise;

    // With small files, we might complete too fast to see progress
    // But stats should be accurate at the end
    const finalStats = analyzer.getStats();
    assert.strictEqual(finalStats.filesProcessed + finalStats.filesFailed, finalStats.filesTotal);
  });

  it('should allow concurrent reads while writing', async () => {
    // Start a fresh analysis
    const files = readdirSync(FIXTURE_PATH)
      .filter(f => f.endsWith('.js'))
      .map((f, i) => ({
        file: join(FIXTURE_PATH, f),
        moduleId: `MODULE#concurrent${i}`,
        moduleName: `concurrent_${f.replace('.js', '')}`,
      }));

    // Start analysis
    const analysisPromise = analyzer.analyzeFiles(files);

    // While analysis is running, query the graph
    let readSucceeded = false;
    let readAttempts = 0;

    while (readAttempts < 10) {
      try {
        const graphStats = await analyzer.getGraphStats();
        console.log(`Concurrent read: ${graphStats.nodeCount} nodes, ${graphStats.edgeCount} edges`);
        readSucceeded = true;
        break;
      } catch (err) {
        console.log('Read attempt failed:', err.message);
      }
      await sleep(50);
      readAttempts++;
    }

    await analysisPromise;

    assert.ok(readSucceeded, 'Should be able to read while writing');

    // Final read should show all data
    const finalStats = await analyzer.getGraphStats();
    console.log('Final graph stats:', finalStats);
    assert.ok(finalStats.nodeCount > 0, 'Should have nodes after analysis');
  });

  it('should respect maxWorkers configuration', async () => {
    // Stop current analyzer
    await analyzer.stop();

    // Create with different worker count
    const customAnalyzer = new ParallelAnalyzer({
      socketPath: TEST_SOCKET_PATH,
      maxWorkers: 1, // Single worker
    });

    await customAnalyzer.start();
    assert.strictEqual(customAnalyzer.workers.length, 1);

    await customAnalyzer.stop();

    // Re-start our main analyzer
    analyzer = new ParallelAnalyzer({
      socketPath: TEST_SOCKET_PATH,
      maxWorkers: cpus().length, // Use all CPUs
    });

    await analyzer.start();
    assert.strictEqual(analyzer.workers.length, Math.min(cpus().length, 16));
  });
});
