/**
 * PriorityQueue - fast task queue with priorities
 *
 * Uses Map for O(1) access by ID + sorted array for fast retrieval
 */

import { EventEmitter } from 'events';
import type { TaskData, TaskType } from './TaskTypes.js';

/**
 * Task status type
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Task interface
 */
export interface Task {
  id: string;
  type: TaskType;
  priority: number;
  status: TaskStatus;
  data: TaskData;
  retryCount?: number;
  maxRetries?: number;
  result?: unknown;
  error: Error | null;
  canExecute(completedTasks: Set<string>): boolean;
  complete(result: unknown): void;
  fail(error: Error): void;
  canRetry(): boolean;
  retry(): void;
  start(): void;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export class PriorityQueue extends EventEmitter {
  private tasks: Map<string, Task>;
  private sorted: Task[];
  private completedTasks: Set<string>;

  constructor() {
    super();
    this.tasks = new Map();
    this.sorted = [];
    this.completedTasks = new Set();
  }

  /**
   * Add task to queue
   */
  add(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists in queue`);
    }

    this.tasks.set(task.id, task);

    // Insert with sort preservation (binary search)
    this._insertSorted(task);

    this.emit('task:added', task);
  }

  /**
   * Insert into sorted array (O(log n) search + O(n) insert)
   * For better performance could use heap, but for <10K tasks array is faster
   */
  private _insertSorted(task: Task): void {
    let left = 0;
    let right = this.sorted.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sorted[mid].priority > task.priority) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    this.sorted.splice(left, 0, task);
  }

  /**
   * Remove task from sorted array
   */
  private _removeSorted(task: Task): void {
    const index = this.sorted.indexOf(task);
    if (index !== -1) {
      this.sorted.splice(index, 1);
    }
  }

  /**
   * Get next task for execution (highest priority + all dependencies ready)
   * O(n) in worst case, but O(1) in practice if few dependencies
   */
  next(): Task | null {
    for (const task of this.sorted) {
      if (task.status === 'pending' && task.canExecute(this.completedTasks)) {
        return task;
      }
    }
    return null;
  }

  /**
   * Get task by ID
   */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Mark task as completed
   */
  complete(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.complete(result);
    this.completedTasks.add(taskId);
    this._removeSorted(task);

    this.emit('task:completed', task);
  }

  /**
   * Mark task as failed
   */
  fail(taskId: string, error: Error): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.fail(error);

    // Retry if possible
    if (task.canRetry()) {
      task.retry();
      this.emit('task:retry', task);
    } else {
      this._removeSorted(task);
      this.emit('task:failed', task);
    }
  }

  /**
   * Number of tasks
   */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * Number of pending tasks
   */
  get pendingCount(): number {
    return this.sorted.length;
  }

  /**
   * Number of completed tasks
   */
  get completedCount(): number {
    return this.completedTasks.size;
  }

  /**
   * All tasks completed?
   */
  get isEmpty(): boolean {
    return this.sorted.length === 0;
  }

  /**
   * Statistics
   */
  getStats(): QueueStats {
    const stats: QueueStats = {
      total: this.size,
      pending: 0,
      running: 0,
      completed: this.completedCount,
      failed: 0
    };

    for (const task of this.tasks.values()) {
      if (task.status === 'pending') stats.pending++;
      else if (task.status === 'running') stats.running++;
      else if (task.status === 'failed') stats.failed++;
    }

    return stats;
  }

  /**
   * Iterate over completed tasks
   */
  *getCompletedTasks(): Generator<Task> {
    for (const task of this.tasks.values()) {
      if (task.status === 'completed') {
        yield task;
      }
    }
  }

  /**
   * Clear queue
   */
  clear(): void {
    this.tasks.clear();
    this.sorted = [];
    this.completedTasks.clear();
    this.emit('queue:cleared');
  }
}
