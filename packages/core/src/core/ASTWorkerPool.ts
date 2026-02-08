/**
 * ASTWorkerPool - pool of worker_threads for parallel AST parsing
 *
 * Uses actual OS threads via Node.js worker_threads module
 * for true parallel CPU-intensive parsing with Babel.
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ASTCollections } from './ASTWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT = join(__dirname, 'ASTWorker.js');

/**
 * Module info for parsing
 */
export interface ModuleInfo {
  id: string;
  file: string;
  name: string;
}

/**
 * Parse task
 */
interface ParseTask {
  taskId: number;
  filePath: string;
  moduleId: string;
  moduleName: string;
  resolve: (collections: ASTCollections) => void;
  reject: (error: Error) => void;
}

/**
 * Parse result
 */
export interface ParseResult {
  module: ModuleInfo;
  collections: ASTCollections | null;
  error: Error | null;
}

/**
 * Worker message types
 */
interface ResultMessage {
  type: 'result';
  taskId: number;
  collections: ASTCollections;
}

interface ErrorMessage {
  type: 'error';
  taskId: number;
  error: string;
}

interface ReadyMessage {
  type: 'ready';
}

type WorkerResponse = ResultMessage | ErrorMessage | ReadyMessage;

/**
 * Pool stats
 */
export interface ASTWorkerPoolStats {
  workerCount: number;
  activeWorkers: number;
  queuedTasks: number;
  pendingTasks: number;
}

export class ASTWorkerPool extends EventEmitter {
  private workerCount: number;
  private workers: Worker[];
  private taskQueue: ParseTask[];
  private pendingTasks: Map<number, ParseTask>;
  private taskIdCounter: number;
  private readyWorkers: Worker[];
  private initialized: boolean;

  constructor(workerCount: number = 4) {
    super();
    this.workerCount = Math.min(workerCount, 8); // Cap at 8 threads
    this.workers = [];
    this.taskQueue = [];
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.readyWorkers = [];
    this.initialized = false;
  }

  /**
   * Initialize the worker pool
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(WORKER_SCRIPT);

      const initPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Worker ${i} initialization timeout`));
        }, 10000);

        worker.once('message', (msg: WorkerResponse) => {
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        });

        worker.once('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      worker.on('message', (msg: WorkerResponse) => this._handleMessage(worker, msg));
      worker.on('error', (err: Error) => this._handleError(worker, err));
      worker.on('exit', (code: number) => this._handleExit(worker, code));

      this.workers.push(worker);
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);

    // All workers ready
    this.readyWorkers = [...this.workers];
    this.initialized = true;
    this.emit('pool:ready', { workerCount: this.workerCount });
  }

  /**
   * Parse a module using a worker thread
   * Returns promise that resolves to collections
   */
  parseModule(filePath: string, moduleId: string, moduleName: string): Promise<ASTCollections> {
    return new Promise((resolve, reject) => {
      const taskId = this.taskIdCounter++;
      const task: ParseTask = { taskId, filePath, moduleId, moduleName, resolve, reject };

      this.pendingTasks.set(taskId, task);

      // Try to dispatch immediately
      this._dispatchNext(task);
    });
  }

  /**
   * Parse multiple modules in parallel
   */
  async parseModules(modules: ModuleInfo[]): Promise<ParseResult[]> {
    await this.init();

    const promises = modules.map(m =>
      this.parseModule(m.file, m.id, m.name)
        .then(collections => ({ module: m, collections, error: null }))
        .catch(error => ({ module: m, collections: null, error: error instanceof Error ? error : new Error(String(error)) }))
    );

    return Promise.all(promises);
  }

  /**
   * Dispatch task to available worker or queue it
   */
  private _dispatchNext(task: ParseTask): void {
    if (this.readyWorkers.length > 0) {
      const worker = this.readyWorkers.pop()!;
      worker.postMessage({
        type: 'parse',
        taskId: task.taskId,
        filePath: task.filePath,
        moduleId: task.moduleId,
        moduleName: task.moduleName
      });
      this.emit('task:started', { taskId: task.taskId, filePath: task.filePath });
    } else {
      // Queue the task
      this.taskQueue.push(task);
    }
  }

  /**
   * Handle message from worker
   */
  private _handleMessage(worker: Worker, msg: WorkerResponse): void {
    if (msg.type === 'result') {
      const task = this.pendingTasks.get(msg.taskId);
      if (task) {
        this.pendingTasks.delete(msg.taskId);
        task.resolve(msg.collections);
        this.emit('task:completed', { taskId: msg.taskId });
      }

      // Worker is ready for more work
      this._workerReady(worker);
    } else if (msg.type === 'error') {
      const task = this.pendingTasks.get(msg.taskId);
      if (task) {
        this.pendingTasks.delete(msg.taskId);
        task.reject(new Error(msg.error));
        this.emit('task:failed', { taskId: msg.taskId, error: msg.error });
      }

      // Worker is still ready
      this._workerReady(worker);
    }
  }

  /**
   * Mark worker as ready and dispatch queued task
   */
  private _workerReady(worker: Worker): void {
    if (this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift()!;
      worker.postMessage({
        type: 'parse',
        taskId: nextTask.taskId,
        filePath: nextTask.filePath,
        moduleId: nextTask.moduleId,
        moduleName: nextTask.moduleName
      });
      this.emit('task:started', { taskId: nextTask.taskId, filePath: nextTask.filePath });
    } else {
      this.readyWorkers.push(worker);
    }
  }

  /**
   * Handle worker error
   */
  private _handleError(worker: Worker, error: Error): void {
    console.error('[ASTWorkerPool] Worker error:', error);
    this.emit('worker:error', { error });
  }

  /**
   * Handle worker exit
   */
  private _handleExit(worker: Worker, code: number): void {
    if (code !== 0) {
      console.error(`[ASTWorkerPool] Worker exited with code ${code}`);
    }

    // Remove from workers list
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }

    // Remove from ready workers
    const readyIndex = this.readyWorkers.indexOf(worker);
    if (readyIndex !== -1) {
      this.readyWorkers.splice(readyIndex, 1);
    }
  }

  /**
   * Terminate all workers
   */
  async terminate(): Promise<void> {
    const terminatePromises = this.workers.map(worker => {
      return new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
        worker.postMessage({ type: 'exit' });
      });
    });

    await Promise.all(terminatePromises);
    this.workers = [];
    this.readyWorkers = [];
    this.initialized = false;
    this.emit('pool:terminated');
  }

  /**
   * Get pool stats
   */
  getStats(): ASTWorkerPoolStats {
    return {
      workerCount: this.workerCount,
      activeWorkers: this.workerCount - this.readyWorkers.length,
      queuedTasks: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size
    };
  }
}
