/**
 * ParallelAnalysisRunner — queue-based parallel analysis using worker_threads and RFDB server.
 * Extracted from Orchestrator.ts (REG-462).
 *
 * Responsibilities:
 * - Start/stop RFDB server for parallel workers
 * - Queue per-file analysis tasks
 * - Track progress and handle failures
 * - Barrier: wait for all tasks before returning
 */

import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import { spawn, execSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { AnalysisQueue } from './core/AnalysisQueue.js';
import type { Plugin } from './plugins/Plugin.js';
import type { GraphBackend, Logger } from '@grafema/types';
import type { ProgressCallback } from './PhaseRunner.js';
import type { ParallelConfig, DiscoveryManifest } from './OrchestratorTypes.js';

export class ParallelAnalysisRunner {
  private analysisQueue: AnalysisQueue | null = null;
  private rfdbServerProcess: ChildProcess | null = null;
  private _serverWasExternal = false;

  constructor(
    private graph: GraphBackend,
    private plugins: Plugin[],
    private parallelConfig: ParallelConfig,
    private onProgress: ProgressCallback,
    private logger: Logger,
  ) {}

  /**
   * Run queue-based parallel analysis.
   *
   * Architecture:
   * - Tasks are queued per-file with list of applicable plugins
   * - Workers pick tasks, run plugins, write directly to RFDB
   * - Barrier waits for all tasks before ENRICHMENT phase
   */
  async run(manifest: DiscoveryManifest): Promise<void> {
    const socketPath = this.parallelConfig.socketPath || '/tmp/rfdb.sock';
    const maxWorkers = this.parallelConfig.maxWorkers || null;

    const mainDbPath = (this.graph as unknown as { dbPath?: string }).dbPath || join(manifest.projectPath, '.grafema', 'graph.rfdb');

    this.logger.debug('Starting queue-based parallel analysis', { database: mainDbPath });

    await this.startRfdbServer(socketPath, mainDbPath);

    const analysisPlugins = this.plugins
      .filter(p => p.metadata?.phase === 'ANALYSIS')
      .map(p => p.metadata.name);

    this.logger.debug('Analysis plugins', { plugins: analysisPlugins });

    this.analysisQueue = new AnalysisQueue({
      socketPath,
      maxWorkers: maxWorkers || undefined,
      plugins: analysisPlugins,
    });

    await this.analysisQueue.start();

    let moduleCount = 0;
    let completedCount = 0;

    this.analysisQueue.on('taskCompleted', ({ file, stats, duration }: { file: string; stats?: { nodes?: number }; duration: number }) => {
      completedCount++;
      this.onProgress({
        phase: 'analysis',
        currentPlugin: 'AnalysisQueue',
        message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
        totalFiles: moduleCount,
        processedFiles: completedCount,
        currentService: file,
      });
    });

    for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
      if (!node.file?.match(/\.(js|jsx|ts|tsx|mjs|cjs)$/)) continue;

      this.analysisQueue.addTask({
        file: node.file,
        moduleId: node.id,
        moduleName: node.name as string,
        plugins: analysisPlugins,
      });
      moduleCount++;
    }

    this.logger.debug('Queued modules for analysis', { count: moduleCount });

    this.analysisQueue.on('taskFailed', ({ file, error }: { file: string; error: string }) => {
      this.logger.error('Analysis failed', { file, error });
    });

    const stats = await this.analysisQueue.waitForCompletion();

    this.logger.debug('Queue complete', {
      nodesCreated: stats.nodesCreated,
      edgesCreated: stats.edgesCreated,
      succeeded: stats.tasksCompleted,
      failed: stats.tasksFailed
    });

    await this.analysisQueue.stop();
    this.analysisQueue = null;
    await this.stopRfdbServer();
  }

  /**
   * Start RFDB server process (or connect to existing one).
   */
  private async startRfdbServer(socketPath: string, dbPath: string): Promise<void> {
    if (existsSync(socketPath)) {
      try {
        const { RFDBClient } = await import('@grafema/rfdb-client');
        const testClient = new RFDBClient(socketPath);
        await testClient.connect();
        await testClient.ping();
        await testClient.close();
        this.logger.debug('Using existing RFDB server', { socketPath });
        this.rfdbServerProcess = null;
        this._serverWasExternal = true;
        return;
      } catch {
        this.logger.debug('Stale socket found, removing');
        unlinkSync(socketPath);
      }
    }

    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const serverBinary = join(projectRoot, 'packages/rfdb-server/target/release/rfdb-server');
    const debugBinary = join(projectRoot, 'packages/rfdb-server/target/debug/rfdb-server');

    let binaryPath = existsSync(serverBinary) ? serverBinary : debugBinary;

    if (!existsSync(binaryPath)) {
      this.logger.debug('RFDB server binary not found, building', { path: binaryPath });
      execSync('cargo build --bin rfdb-server', {
        cwd: join(projectRoot, 'packages/rfdb-server'),
        stdio: 'inherit',
      });
      binaryPath = debugBinary;
    }

    this.logger.debug('Starting RFDB server', { binary: binaryPath, database: dbPath });
    this.rfdbServerProcess = spawn(binaryPath, [dbPath, '--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._serverWasExternal = false;

    this.rfdbServerProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes('FLUSH') && !msg.includes('WRITER')) {
        this.logger.debug('rfdb-server', { message: msg });
      }
    });

    let attempts = 0;
    while (!existsSync(socketPath) && attempts < 30) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(socketPath)) {
      throw new Error('RFDB server failed to start');
    }

    this.logger.debug('RFDB server started', { socketPath });
  }

  /**
   * Stop RFDB server process (only if we started it).
   */
  private async stopRfdbServer(): Promise<void> {
    if (this._serverWasExternal) {
      this.logger.debug('Leaving external RFDB server running');
      return;
    }

    if (this.rfdbServerProcess) {
      this.rfdbServerProcess.kill('SIGTERM');
      await sleep(200);
      this.rfdbServerProcess = null;
      this.logger.debug('RFDB server stopped');
    }
  }
}
