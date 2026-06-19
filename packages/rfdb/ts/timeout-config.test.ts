/**
 * RFDB RPC timeout-config unit tests.
 *
 * Verifies the env-configurable, per-operation timeout ceilings that unblock
 * large-graph self-analyze: bulk writes / streaming first-chunk / durable
 * drops must get a longer ceiling than interactive ops, and both must be
 * overridable via env (RFDB_RPC_TIMEOUT_MS / RFDB_RPC_BULK_TIMEOUT_MS).
 *
 * Imports from ../dist (the built JS), matching the other rfdb tests.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  getDefaultTimeoutMs,
  getBulkTimeoutMs,
  resolveTimeoutMs,
} from '../dist/timeout-config.js';

function clearEnv(): void {
  delete process.env.RFDB_RPC_TIMEOUT_MS;
  delete process.env.RFDB_RPC_BULK_TIMEOUT_MS;
}

describe('rfdb timeout-config', () => {
  afterEach(clearEnv);

  it('defaults: interactive 300s, bulk 3x = 900s', () => {
    clearEnv();
    assert.strictEqual(getDefaultTimeoutMs(), 300_000);
    assert.strictEqual(getBulkTimeoutMs(), 900_000);
  });

  it('classifies interactive vs bulk commands', () => {
    clearEnv();
    // interactive
    assert.strictEqual(resolveTimeoutMs('getNode'), 300_000);
    assert.strictEqual(resolveTimeoutMs('neighbors'), 300_000);
    assert.strictEqual(resolveTimeoutMs('ping'), 300_000);
    // bulk / streaming / drop
    assert.strictEqual(resolveTimeoutMs('addEdges'), 900_000);
    assert.strictEqual(resolveTimeoutMs('addNodes'), 900_000);
    assert.strictEqual(resolveTimeoutMs('commitBatch'), 900_000);
    assert.strictEqual(resolveTimeoutMs('clear'), 900_000);
    assert.strictEqual(resolveTimeoutMs('dropDatabase'), 900_000);
  });

  it('honors an explicit per-call override', () => {
    clearEnv();
    assert.strictEqual(resolveTimeoutMs('getNode', 1234), 1234);
    assert.strictEqual(resolveTimeoutMs('addEdges', 1234), 1234);
  });

  it('RFDB_RPC_TIMEOUT_MS overrides interactive and rescales bulk (3x)', () => {
    clearEnv();
    process.env.RFDB_RPC_TIMEOUT_MS = '120000';
    assert.strictEqual(getDefaultTimeoutMs(), 120_000);
    assert.strictEqual(getBulkTimeoutMs(), 360_000);
    assert.strictEqual(resolveTimeoutMs('addEdges'), 360_000);
  });

  it('RFDB_RPC_BULK_TIMEOUT_MS overrides bulk independently', () => {
    clearEnv();
    process.env.RFDB_RPC_BULK_TIMEOUT_MS = '600000';
    assert.strictEqual(getBulkTimeoutMs(), 600_000);
    assert.strictEqual(getDefaultTimeoutMs(), 300_000);
    assert.strictEqual(resolveTimeoutMs('getNode'), 300_000);
    assert.strictEqual(resolveTimeoutMs('addEdges'), 600_000);
  });

  it('ignores malformed / non-positive env values (fails safe to defaults)', () => {
    clearEnv();
    process.env.RFDB_RPC_TIMEOUT_MS = 'notanumber';
    assert.strictEqual(getDefaultTimeoutMs(), 300_000);
    process.env.RFDB_RPC_TIMEOUT_MS = '-5';
    assert.strictEqual(getDefaultTimeoutMs(), 300_000);
    process.env.RFDB_RPC_TIMEOUT_MS = '0';
    assert.strictEqual(getDefaultTimeoutMs(), 300_000);
  });
});
