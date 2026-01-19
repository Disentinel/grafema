/**
 * WorkerPool - worker pool for parallel task execution
 *
 * Key property: HORIZONTAL SCALING
 * More workers = faster processing (up to CPU/IO limit)
 */

import { EventEmitter } from 'events';
import type { Task, QueueStats } from './PriorityQueue.js';

/**
 * Task handler function type
 */
export type TaskHandler = (task: Task) => Promise<unknown>;

/**
 * Handler registry
 */
export interface TaskHandlers {
  [taskType: string]: TaskHandler;
}

/**
 * Queue interface for WorkerPool
 */
export interface WorkerQueue {
  isEmpty: boolean;
  next(): Task | null;
  complete(taskId: string, result: unknown): void;
  fail(taskId: string, error: Error): void;
  getStats(): QueueStats;
}

/**
 * Worker pool statistics
 */
export interface WorkerPoolStats {
  workerCount: number;
  activeWorkers: number;
  running: boolean;
}

// === EVENT PAYLOADS ===

export interface WorkerTaskStartEvent {
  workerId: number;
  task: Task;
}

export interface WorkerTaskCompletedEvent {
  workerId: number;
  task: Task;
  result: unknown;
}

export interface WorkerTaskFailedEvent {
  workerId: number;
  task: Task;
  error: unknown;
}

export class WorkerPool extends EventEmitter {
  private workerCount: number;
  private handlers: TaskHandlers;
  private activeWorkers: number;
  private running: boolean;

  constructor(workerCount: number = 10, handlers: TaskHandlers = {}) {
    super();
    this.workerCount = workerCount;
    this.handlers = handlers;
    this.activeWorkers = 0;
    this.running = false;
  }

  /**
   * Register handler for task type
   */
  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers[taskType] = handler;
  }

  /**
   * Start queue processing
   */
  async processQueue(queue: WorkerQueue): Promise<void> {
    this.running = true;
    this.emit('pool:started', { workerCount: this.workerCount });

    // Create workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.workerCount; i++) {
      workers.push(this._worker(i, queue));
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    this.running = false;
    this.emit('pool:finished', queue.getStats());
  }

  /**
   * Worker - picks task from queue and executes
   */
  private async _worker(workerId: number, queue: WorkerQueue): Promise<void> {
    while (true) {
      // If queue is empty AND no active workers - exit
      if (queue.isEmpty && this.activeWorkers === 0) {
        break;
      }

      // Get next task
      const task = queue.next();

      if (!task) {
        // No ready tasks, wait a bit
        await this._sleep(10);
        continue;
      }

      this.activeWorkers++;
      this.emit('worker:task:start', { workerId, task });
      this.emit('worker:task:started', task); // For progress tracking

      try {
        // Execute task
        const handler = task.type ? this.handlers[task.type] : undefined;
        if (!handler) {
          throw new Error(`No handler for task type: ${task.type}`);
        }

        task.start();
        const result = await handler(task);

        queue.complete(task.id, result);
        this.emit('worker:task:completed', { workerId, task, result });
      } catch (error) {
        queue.fail(task.id, error as Error);
        this.emit('worker:task:failed', { workerId, task, error });
      } finally {
        this.activeWorkers--;
      }
    }

    this.emit('worker:stopped', { workerId });
  }

  /**
   * Sleep helper
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop pool (graceful shutdown)
   */
  async stop(): Promise<void> {
    this.running = false;

    // Wait for all active workers to complete current tasks
    while (this.activeWorkers > 0) {
      await this._sleep(100);
    }

    this.emit('pool:stopped');
  }

  /**
   * Statistics
   */
  getStats(): WorkerPoolStats {
    return {
      workerCount: this.workerCount,
      activeWorkers: this.activeWorkers,
      running: this.running
    };
  }
}
