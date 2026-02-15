/**
 * StreamQueue<T> — Push-pull adapter for bridging event-driven data
 * arrival (socket responses) to pull-based async iteration (for...await).
 *
 * Used by RFDBClient to bridge _handleResponse (push) to
 * queryNodesStream() (pull via async generator).
 *
 * Backpressure model:
 * - Producer is faster: items buffer in `queue` (unbounded for V1 —
 *   TCP flow control on Unix socket provides natural backpressure)
 * - Consumer is faster: consumer waits on a pending Promise
 */
export class StreamQueue<T> {
  private _queue: T[] = [];
  private _waiters: Array<{
    resolve: (result: IteratorResult<T, undefined>) => void;
    reject: (error: Error) => void;
  }> = [];
  private _done: boolean = false;
  private _error: Error | null = null;

  /** Push an item into the queue. If a consumer is waiting, resolves immediately. */
  push(item: T): void {
    if (this._done) return;
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve({ value: item, done: false });
    } else {
      this._queue.push(item);
    }
  }

  /** Signal that no more items will be pushed. Resolves all waiting consumers. */
  end(): void {
    this._done = true;
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** Signal an error. Rejects all waiting consumers. */
  fail(error: Error): void {
    this._error = error;
    this._done = true;
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.reject(error);
    }
  }

  /** Pull the next item. Returns immediately if buffered, otherwise waits. */
  next(): Promise<IteratorResult<T, undefined>> {
    if (this._error) {
      return Promise.reject(this._error);
    }

    if (this._queue.length > 0) {
      const item = this._queue.shift()!;
      return Promise.resolve({ value: item, done: false as const });
    }

    if (this._done) {
      return Promise.resolve({ value: undefined, done: true as const });
    }

    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /** Consumer abort. Clears buffer and marks stream as done. */
  return(): Promise<IteratorResult<T, undefined>> {
    this._done = true;
    this._queue = [];
    this._waiters = [];
    return Promise.resolve({ value: undefined, done: true as const });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
