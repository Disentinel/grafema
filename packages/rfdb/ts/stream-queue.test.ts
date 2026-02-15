/**
 * StreamQueue Unit Tests
 *
 * Tests for the push-pull adapter that bridges socket events
 * to async generator iteration. Pure data structure tests — no server dependency.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StreamQueue } from '../dist/stream-queue.js';

describe('StreamQueue', () => {
  it('push then pull — items available immediately', async () => {
    const q = new StreamQueue<number>();
    q.push(1);
    q.push(2);

    const r1 = await q.next();
    assert.deepStrictEqual(r1, { value: 1, done: false });
    const r2 = await q.next();
    assert.deepStrictEqual(r2, { value: 2, done: false });
  });

  it('pull then push — Promise resolves when item arrives', async () => {
    const q = new StreamQueue<number>();

    // Start waiting before any items
    const promise = q.next();

    // Push resolves the waiting consumer
    q.push(42);

    const result = await promise;
    assert.deepStrictEqual(result, { value: 42, done: false });
  });

  it('end() terminates iteration', async () => {
    const q = new StreamQueue<number>();
    q.push(1);
    q.end();

    const r1 = await q.next();
    assert.deepStrictEqual(r1, { value: 1, done: false });

    const r2 = await q.next();
    assert.strictEqual(r2.done, true);
  });

  it('fail() rejects waiting consumers', async () => {
    const q = new StreamQueue<number>();

    const promise = q.next();
    q.fail(new Error('test error'));

    await assert.rejects(promise, { message: 'test error' });
  });

  it('return() aborts stream', async () => {
    const q = new StreamQueue<number>();
    q.push(1);
    q.push(2);

    const r = await q.return();
    assert.strictEqual(r.done, true);

    // After return, next() returns done
    const r2 = await q.next();
    assert.strictEqual(r2.done, true);
  });

  it('for-await-of integration', async () => {
    const q = new StreamQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const collected: number[] = [];
    for await (const item of q) {
      collected.push(item);
    }

    assert.deepStrictEqual(collected, [1, 2, 3]);
  });

  it('end() resolves pending waiters with done', async () => {
    const q = new StreamQueue<number>();

    const promise = q.next();
    q.end();

    const result = await promise;
    assert.strictEqual(result.done, true);
  });

  it('push after end is ignored', async () => {
    const q = new StreamQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // Should be ignored

    const r1 = await q.next();
    assert.deepStrictEqual(r1, { value: 1, done: false });
    const r2 = await q.next();
    assert.strictEqual(r2.done, true);
  });

  it('fail() then next() rejects immediately', async () => {
    const q = new StreamQueue<number>();
    q.fail(new Error('broken'));

    await assert.rejects(q.next(), { message: 'broken' });
  });
});
