/**
 * AnalysisQueue - Queue-based parallel analysis orchestration
 *
 * Architecture:
 * - Tasks are file + applicable plugins
 * - Workers pick tasks from queue, run plugins, write to RFDB
 * - Barrier waits for all tasks before ENRICHMENT phase
 *
 * Usage:
 *   const queue = new AnalysisQueue({
 *     socketPath: '/tmp/rfdb.sock',
 *     maxWorkers: 4,
 *     plugins: [JSASTAnalyzer, ExpressRouteAnalyzer, ...]
 *   });
 *
 *   await queue.start();
 *   queue.addTask({ file: '/path/to/file.js', moduleId: '...', plugins: ['JSASTAnalyzer'] });
 *   await queue.waitForCompletion();
 *   await queue.stop();
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT = join(__dirname, 'QueueWorker.ts');

/**
 * Queue options
 */
export interface AnalysisQueueOptions {
  socketPath?: string;
  maxWorkers?: number;
  plugins?: unknown[];
}

/**
 * Task definition
 */
export interface AnalysisTask {
  file: string;
  moduleId: string;
  moduleName: string;
  plugins?: string[];
}

/**
 * Internal task with ID
 */
interface FullTask extends AnalysisTask {
  taskId: number;
}

/**
 * Active task info
 */
interface ActiveTaskInfo {
  file: string;
  worker: WorkerInfo;
  startTime: number;
}

/**
 * Worker info
 */
interface WorkerInfo {
  worker: Worker;
  busy: boolean;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  nodesCreated: number;
  edgesCreated: number;
  startTime: number | null;
  errors: Array<{ file: string; error: string }>;
  pending?: number;
  active?: number;
  elapsed?: number;
}

/**
 * Task stats from worker
 */
interface TaskStats {
  nodes?: number;
  edges?: number;
}

/**
 * Worker message types
 */
interface ReadyMessage {
  type: 'ready';
}

interface DoneMessage {
  type: 'done';
  taskId: number;
  stats: TaskStats;
}

interface ErrorMessage {
  type: 'error';
  taskId: number;
  error: string;
}

interface ProgressMessage {
  type: 'progress';
  [key: string]: unknown;
}

type WorkerResponse = ReadyMessage | DoneMessage | ErrorMessage | ProgressMessage;

export class AnalysisQueue extends EventEmitter {
  private socketPath: string;
  private maxWorkers: number;
  private pluginConfigs: unknown[];
  private workers: WorkerInfo[];
  private pendingTasks: FullTask[];
  private activeTasks: Map<number, ActiveTaskInfo>;
  private completedCount: number;
  private failedCount: number;
  private taskIdCounter: number;
  private running: boolean;
  private draining: boolean;
  private completionPromise: Promise<void> | null;
  private completionResolve: (() => void) | null;
  private stats: QueueStats;

  constructor(options: AnalysisQueueOptions = {}) {
    super();

    // Configuration
    this.socketPath = options.socketPath || '/tmp/rfdb.sock';
    this.maxWorkers = Math.min(options.maxWorkers || cpus().length, 16);
    this.pluginConfigs = options.plugins || [];

    // State
    this.workers = [];
    this.pendingTasks = [];
    this.activeTasks = new Map();
    this.completedCount = 0;
    this.failedCount = 0;
    this.taskIdCounter = 0;
    this.running = false;
    this.draining = false;

    // Completion tracking
    this.completionPromise = null;
    this.completionResolve = null;

    // Stats
    this.stats = {
      tasksTotal: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      startTime: null,
      errors: []
    };
  }

  /**
   * Start the queue (spawn workers)
   */
  async start(): Promise<void> {
    if (this.running) return;

    console.log(`[AnalysisQueue] Starting ${this.maxWorkers} workers...`);

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker(WORKER_SCRIPT, {
        workerData: {
          workerId: i,
          socketPath: this.socketPath,
          pluginConfigs: this.pluginConfigs
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
            reject(new Error((msg as ErrorMessage).error));
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

      this.workers.push({ worker, busy: false });
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);

    this.running = true;
    this.stats.startTime = Date.now();

    console.log(`[AnalysisQueue] ${this.maxWorkers} workers ready`);
    this.emit('started', { workerCount: this.maxWorkers });
  }

  /**
   * Stop the queue (terminate workers)
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('[AnalysisQueue] Stopping workers...');

    const terminatePromises = this.workers.map(({ worker }) => {
      return new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
        worker.postMessage({ type: 'exit' });
      });
    });

    await Promise.all(terminatePromises);

    this.workers = [];
    this.running = false;

    console.log('[AnalysisQueue] Stopped');
    this.emit('stopped');
  }

  /**
   * Add a task to the queue
   */
  addTask(task: AnalysisTask): number {
    const taskId = this.taskIdCounter++;
    const fullTask: FullTask = {
      taskId,
      file: task.file,
      moduleId: task.moduleId,
      moduleName: task.moduleName,
      plugins: task.plugins || []
    };

    this.pendingTasks.push(fullTask);
    this.stats.tasksTotal++;

    // Try to dispatch immediately if workers available
    this._dispatchNext();

    return taskId;
  }

  /**
   * Add multiple tasks at once
   */
  addTasks(tasks: AnalysisTask[]): void {
    for (const task of tasks) {
      this.addTask(task);
    }
  }

  /**
   * Wait for all tasks to complete
   */
  async waitForCompletion(): Promise<QueueStats> {
    if (this.pendingTasks.length === 0 && this.activeTasks.size === 0) {
      return this.getStats();
    }

    this.draining = true;

    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve;
    });

    await this.completionPromise;

    this.draining = false;
    return this.getStats();
  }

  /**
   * Get current statistics
   */
  getStats(): QueueStats {
    return {
      ...this.stats,
      pending: this.pendingTasks.length,
      active: this.activeTasks.size,
      elapsed: this.stats.startTime ? Date.now() - this.stats.startTime : 0
    };
  }

  // ===========================================================================
  // Internal methods
  // ===========================================================================

  private _dispatchNext(): void {
    if (!this.running) return;
    if (this.pendingTasks.length === 0) return;

    // Find an idle worker
    const idleWorker = this.workers.find(w => !w.busy);
    if (!idleWorker) return;

    // Get next task
    const task = this.pendingTasks.shift()!;

    // Mark worker as busy
    idleWorker.busy = true;
    this.activeTasks.set(task.taskId, {
      file: task.file,
      worker: idleWorker,
      startTime: Date.now()
    });

    // Send to worker
    idleWorker.worker.postMessage({
      type: 'process',
      taskId: task.taskId,
      file: task.file,
      moduleId: task.moduleId,
      moduleName: task.moduleName,
      plugins: task.plugins
    });

    this.emit('taskStarted', { taskId: task.taskId, file: task.file });
  }

  private _handleWorkerMessage(worker: Worker, msg: WorkerResponse): void {
    switch (msg.type) {
      case 'done': {
        const taskInfo = this.activeTasks.get(msg.taskId);
        if (taskInfo) {
          this.activeTasks.delete(msg.taskId);
          taskInfo.worker.busy = false;

          // Update stats
          this.stats.tasksCompleted++;
          this.stats.nodesCreated += msg.stats?.nodes || 0;
          this.stats.edgesCreated += msg.stats?.edges || 0;

          this.emit('taskCompleted', {
            taskId: msg.taskId,
            file: taskInfo.file,
            stats: msg.stats,
            duration: Date.now() - taskInfo.startTime
          });
        }

        this._dispatchNext();
        this._checkCompletion();
        break;
      }

      case 'error': {
        const taskInfo = this.activeTasks.get(msg.taskId);
        if (taskInfo) {
          this.activeTasks.delete(msg.taskId);
          taskInfo.worker.busy = false;

          this.stats.tasksFailed++;
          this.stats.errors.push({ file: taskInfo.file, error: msg.error });

          this.emit('taskFailed', {
            taskId: msg.taskId,
            file: taskInfo.file,
            error: msg.error
          });
        }

        this._dispatchNext();
        this._checkCompletion();
        break;
      }

      case 'progress': {
        this.emit('progress', msg);
        break;
      }
    }
  }

  private _handleWorkerError(worker: Worker, error: Error): void {
    console.error('[AnalysisQueue] Worker error:', error);
    this.emit('workerError', { error });
  }

  private _handleWorkerExit(worker: Worker, code: number): void {
    if (code !== 0 && this.running) {
      console.error(`[AnalysisQueue] Worker exited with code ${code}`);
    }

    // Remove from workers list
    const idx = this.workers.findIndex(w => w.worker === worker);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
    }
  }

  private _checkCompletion(): void {
    if (
      this.draining &&
      this.pendingTasks.length === 0 &&
      this.activeTasks.size === 0
    ) {
      const duration = Date.now() - this.stats.startTime!;
      console.log(`[AnalysisQueue] All tasks complete in ${duration}ms`);
      console.log(`[AnalysisQueue] ${this.stats.tasksCompleted} succeeded, ${this.stats.tasksFailed} failed`);

      if (this.completionResolve) {
        this.completionResolve();
        this.completionResolve = null;
      }
    }
  }
}

export default AnalysisQueue;
