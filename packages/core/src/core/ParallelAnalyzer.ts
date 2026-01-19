/**
 * ParallelAnalyzer - orchestrates parallel AST analysis using worker threads
 *
 * Features:
 * - Configurable number of workers (default: CPU cores)
 * - Each worker connects to RFDB server directly
 * - Real-time statistics available during analysis
 * - Concurrent reads while writes are happening
 *
 * Usage:
 *   const analyzer = new ParallelAnalyzer({
 *     socketPath: '/tmp/rfdb.sock',
 *     maxWorkers: 4,
 *   });
 *   await analyzer.start();
 *   const stats = await analyzer.analyzeFiles(files);
 *   await analyzer.stop();
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { RFDBClient } from '@grafema/rfdb-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT = join(__dirname, 'AnalysisWorker.js');

/**
 * Analyzer options
 */
export interface ParallelAnalyzerOptions {
  socketPath?: string;
  maxWorkers?: number;
}

/**
 * File info for analysis
 */
export interface FileInfo {
  file: string;
  id?: string;
  moduleId?: string;
  name?: string;
  moduleName?: string;
}

/**
 * Analysis stats per file
 */
export interface FileStats {
  nodes?: number;
  edges?: number;
  functions?: number;
  calls?: number;
}

/**
 * Overall analysis statistics
 */
export interface AnalysisStats {
  filesTotal: number;
  filesProcessed: number;
  filesFailed: number;
  nodesCreated: number;
  edgesCreated: number;
  functionsFound: number;
  callsFound: number;
  startTime: number | null;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Analysis task
 */
interface AnalysisTask {
  taskId: number;
  file: string;
  moduleId: string;
  moduleName: string;
  resolve: (stats: FileStats | null) => void;
  reject: (error: Error) => void;
}

/**
 * Worker message types
 */
interface ReadyMessage {
  type: 'ready';
  workerId: number;
}

interface DoneMessage {
  type: 'done';
  file: string;
  stats: FileStats;
  workerId: number;
}

interface ErrorMessage {
  type: 'error';
  file?: string;
  error: string;
  workerId?: number;
}

type WorkerResponse = ReadyMessage | DoneMessage | ErrorMessage;

/**
 * Graph stats from RFDB
 */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
}

export class ParallelAnalyzer extends EventEmitter {
  private socketPath: string;
  private maxWorkers: number;
  private workers: Worker[];
  private readyWorkers: Worker[];
  private taskQueue: AnalysisTask[];
  private pendingTasks: Map<number, AnalysisTask>;
  private taskIdCounter: number;
  private running: boolean;
  private stats: AnalysisStats;
  private statsClient: RFDBClient | null;

  constructor(options: ParallelAnalyzerOptions = {}) {
    super();

    // Configuration
    this.socketPath = options.socketPath || '/tmp/rfdb.sock';
    this.maxWorkers = options.maxWorkers || cpus().length;
    this.maxWorkers = Math.min(this.maxWorkers, 16); // Cap at 16

    // State
    this.workers = [];
    this.readyWorkers = [];
    this.taskQueue = [];
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.running = false;

    // Stats (updated in real-time)
    this.stats = {
      filesTotal: 0,
      filesProcessed: 0,
      filesFailed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      functionsFound: 0,
      callsFound: 0,
      startTime: null,
      errors: []
    };

    // Stats client (for reading during analysis)
    this.statsClient = null;
  }

  /**
   * Start the analyzer (spawn workers)
   */
  async start(): Promise<void> {
    if (this.running) return;

    console.log(`[ParallelAnalyzer] Starting ${this.maxWorkers} workers...`);

    // Connect stats client for real-time queries
    this.statsClient = new RFDBClient(this.socketPath);
    await this.statsClient.connect();

    // Spawn workers
    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker(WORKER_SCRIPT, {
        workerData: {
          workerId: i,
          socketPath: this.socketPath,
          autoConnect: true
        }
      });

      const initPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Worker ${i} initialization timeout`));
        }, 30000);

        const onMessage = (msg: WorkerResponse) => {
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            worker.removeListener('message', onMessage);
            resolve();
          } else if (msg.type === 'error' && !this.running) {
            clearTimeout(timeout);
            worker.removeListener('message', onMessage);
            reject(new Error(msg.error));
          }
        };

        worker.on('message', onMessage);
        worker.once('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      worker.on('message', (msg: WorkerResponse) => this._handleWorkerMessage(worker, msg));
      worker.on('error', (err: Error) => this._handleWorkerError(worker, err));
      worker.on('exit', (code: number) => this._handleWorkerExit(worker, code));

      this.workers.push(worker);
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);

    this.readyWorkers = [...this.workers];
    this.running = true;

    console.log(`[ParallelAnalyzer] ${this.maxWorkers} workers ready`);
    this.emit('started', { workerCount: this.maxWorkers });
  }

  /**
   * Stop the analyzer (terminate workers)
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('[ParallelAnalyzer] Stopping workers...');

    // Close stats client
    if (this.statsClient) {
      await this.statsClient.close();
      this.statsClient = null;
    }

    // Terminate workers
    const terminatePromises = this.workers.map(worker => {
      return new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
        worker.postMessage({ type: 'exit' });
      });
    });

    await Promise.all(terminatePromises);

    this.workers = [];
    this.readyWorkers = [];
    this.running = false;

    console.log('[ParallelAnalyzer] Stopped');
    this.emit('stopped');
  }

  /**
   * Analyze multiple files in parallel
   */
  async analyzeFiles(files: FileInfo[]): Promise<AnalysisStats> {
    if (!this.running) {
      throw new Error('Analyzer not started. Call start() first.');
    }

    this.stats = {
      filesTotal: files.length,
      filesProcessed: 0,
      filesFailed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      functionsFound: 0,
      callsFound: 0,
      startTime: Date.now(),
      errors: []
    };

    console.log(`[ParallelAnalyzer] Analyzing ${files.length} files with ${this.maxWorkers} workers...`);

    // Create promises for all files
    const promises = files.map(f => this._analyzeFile(f));

    // Wait for all to complete
    await Promise.all(promises);

    const duration = Date.now() - this.stats.startTime!;
    const filesPerSecond = (this.stats.filesProcessed / (duration / 1000)).toFixed(2);

    console.log(`[ParallelAnalyzer] Done in ${duration}ms (${filesPerSecond} files/sec)`);
    console.log(`[ParallelAnalyzer] ${this.stats.filesProcessed} succeeded, ${this.stats.filesFailed} failed`);
    console.log(`[ParallelAnalyzer] ${this.stats.nodesCreated} nodes, ${this.stats.edgesCreated} edges`);

    this.emit('completed', { ...this.stats, duration });

    return this.stats;
  }

  /**
   * Get current statistics (can be called during analysis)
   */
  getStats(): AnalysisStats & { elapsed: number; activeWorkers: number; queuedTasks: number } {
    return {
      ...this.stats,
      elapsed: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
      activeWorkers: this.maxWorkers - this.readyWorkers.length,
      queuedTasks: this.taskQueue.length
    };
  }

  /**
   * Get graph statistics from RFDB (can be called during analysis)
   */
  async getGraphStats(): Promise<GraphStats> {
    if (!this.statsClient) {
      throw new Error('Analyzer not started');
    }

    const [nodeCount, edgeCount, nodesByType, edgesByType] = await Promise.all([
      this.statsClient.nodeCount(),
      this.statsClient.edgeCount(),
      this.statsClient.countNodesByType(),
      this.statsClient.countEdgesByType()
    ]);

    return { nodeCount, edgeCount, nodesByType, edgesByType };
  }

  /**
   * Query nodes from RFDB (can be called during analysis)
   */
  async queryNodes(nodeType: string): Promise<string[]> {
    if (!this.statsClient) {
      throw new Error('Analyzer not started');
    }
    return this.statsClient.findByType(nodeType as never);
  }

  // ===========================================================================
  // Internal methods
  // ===========================================================================

  private _analyzeFile(fileInfo: FileInfo): Promise<FileStats | null> {
    return new Promise((resolve, reject) => {
      const taskId = this.taskIdCounter++;
      const task: AnalysisTask = {
        taskId,
        file: fileInfo.file,
        moduleId: fileInfo.moduleId || fileInfo.id || fileInfo.file,
        moduleName: fileInfo.moduleName || fileInfo.name || fileInfo.file,
        resolve,
        reject
      };

      this.pendingTasks.set(taskId, task);
      this._dispatchTask(task);
    });
  }

  private _dispatchTask(task: AnalysisTask): void {
    if (this.readyWorkers.length > 0) {
      const worker = this.readyWorkers.pop()!;
      worker.postMessage({
        type: 'analyze',
        file: task.file,
        moduleId: task.moduleId,
        moduleName: task.moduleName,
        taskId: task.taskId
      });
      this.emit('taskStarted', { file: task.file });
    } else {
      this.taskQueue.push(task);
    }
  }

  private _handleWorkerMessage(worker: Worker, msg: WorkerResponse): void {
    switch (msg.type) {
      case 'done': {
        // Find task by file (workers don't track taskId internally)
        let task: AnalysisTask | null = null;
        for (const [id, t] of this.pendingTasks) {
          if (t.file === msg.file) {
            task = t;
            this.pendingTasks.delete(id);
            break;
          }
        }

        if (task) {
          // Update stats
          this.stats.filesProcessed++;
          this.stats.nodesCreated += msg.stats?.nodes || 0;
          this.stats.edgesCreated += msg.stats?.edges || 0;
          this.stats.functionsFound += msg.stats?.functions || 0;
          this.stats.callsFound += msg.stats?.calls || 0;

          this.emit('fileCompleted', { file: msg.file, stats: msg.stats });
          task.resolve(msg.stats);
        }

        this._workerReady(worker);
        break;
      }

      case 'error': {
        let task: AnalysisTask | null = null;
        for (const [id, t] of this.pendingTasks) {
          if (t.file === msg.file) {
            task = t;
            this.pendingTasks.delete(id);
            break;
          }
        }

        if (task) {
          this.stats.filesFailed++;
          this.stats.errors.push({ file: msg.file!, error: msg.error });

          this.emit('fileError', { file: msg.file, error: msg.error });
          task.resolve(null); // Don't reject, just continue
        }

        this._workerReady(worker);
        break;
      }

      case 'ready':
        // Worker reconnected
        if (!this.readyWorkers.includes(worker)) {
          this._workerReady(worker);
        }
        break;
    }
  }

  private _workerReady(worker: Worker): void {
    if (this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift()!;
      worker.postMessage({
        type: 'analyze',
        file: nextTask.file,
        moduleId: nextTask.moduleId,
        moduleName: nextTask.moduleName,
        taskId: nextTask.taskId
      });
      this.emit('taskStarted', { file: nextTask.file });
    } else {
      this.readyWorkers.push(worker);
    }
  }

  private _handleWorkerError(worker: Worker, error: Error): void {
    console.error('[ParallelAnalyzer] Worker error:', error);
    this.emit('workerError', { error });
  }

  private _handleWorkerExit(worker: Worker, code: number): void {
    if (code !== 0 && this.running) {
      console.error(`[ParallelAnalyzer] Worker exited with code ${code}`);
    }

    // Remove from lists
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);

    const readyIdx = this.readyWorkers.indexOf(worker);
    if (readyIdx !== -1) this.readyWorkers.splice(readyIdx, 1);
  }
}

export default ParallelAnalyzer;
