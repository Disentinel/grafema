/**
 * Analyze utilities tests - REG-378
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchNodeEdgeCounts, exitWithCode } from '../src/commands/analyze.js';

class FakeBackend {
  public nodeCountCalls = 0;
  public edgeCountCalls = 0;
  public getStatsCalls = 0;

  async nodeCount(): Promise<number> {
    this.nodeCountCalls += 1;
    return 12;
  }

  async edgeCount(): Promise<number> {
    this.edgeCountCalls += 1;
    return 34;
  }

  async getStats(): Promise<never> {
    this.getStatsCalls += 1;
    throw new Error('getStats should not be called');
  }
}

describe('analyze utils', () => {
  it('fetchNodeEdgeCounts uses nodeCount/edgeCount only', async () => {
    const backend = new FakeBackend();
    const result = await fetchNodeEdgeCounts(backend);

    assert.deepStrictEqual(result, { nodeCount: 12, edgeCount: 34 });
    assert.strictEqual(backend.nodeCountCalls, 1);
    assert.strictEqual(backend.edgeCountCalls, 1);
    assert.strictEqual(backend.getStatsCalls, 0);
  });

  it('exitWithCode delegates to provided exit function', () => {
    const calls: number[] = [];
    const exitStub = (code: number): void => {
      calls.push(code);
    };

    exitWithCode(0, exitStub);

    assert.deepStrictEqual(calls, [0]);
  });
});
