/**
 * Task - базовая единица работы в очереди
 */

import type { TaskData, TaskType } from './TaskTypes.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskOptions {
  id: string;
  type: TaskType;
  priority?: number;
  data: TaskData;
  dependencies?: string[];
}

export class Task {
  readonly id: string;
  readonly type: TaskType;
  readonly priority: number;
  readonly data: TaskData;
  readonly dependencies: string[];

  status: TaskStatus;
  result: unknown;
  error: Error | null;
  startedAt: number | null;
  completedAt: number | null;
  retries: number;
  maxRetries: number;

  constructor({ id, type, priority = 50, data, dependencies = [] }: TaskOptions) {
    this.id = id;
    this.type = type;
    this.priority = priority;
    this.data = data;
    this.dependencies = dependencies;

    this.status = 'pending';
    this.result = null;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.retries = 0;
    this.maxRetries = 3;
  }

  /**
   * Может ли задача выполняться (все зависимости готовы)
   */
  canExecute(completedTasks: Set<string>): boolean {
    return this.dependencies.every(depId => completedTasks.has(depId));
  }

  /**
   * Начать выполнение
   */
  start(): void {
    this.status = 'running';
    this.startedAt = Date.now();
  }

  /**
   * Завершить успешно
   */
  complete(result: unknown): void {
    this.status = 'completed';
    this.result = result;
    this.completedAt = Date.now();
  }

  /**
   * Завершить с ошибкой
   */
  fail(error: Error): void {
    this.status = 'failed';
    this.error = error;
    this.completedAt = Date.now();
  }

  /**
   * Можно ли повторить
   */
  canRetry(): boolean {
    return this.retries < this.maxRetries;
  }

  /**
   * Повторить задачу
   */
  retry(): void {
    this.retries++;
    this.status = 'pending';
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
  }

  /**
   * Продолжительность выполнения (мс)
   */
  get duration(): number {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }
}
