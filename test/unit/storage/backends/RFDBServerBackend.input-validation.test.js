/**
 * RFDBServerBackend Input Validation Tests
 *
 * Verifies that addNodes/addEdges throw clear errors when required
 * fields are missing, instead of silently accepting bad data.
 *
 * Key behaviors tested:
 * 1. addEdges throws on missing 'src' (with hint if 'source' present)
 * 2. addEdges throws on missing 'dst' (with hint if 'target' present)
 * 3. addEdges throws on missing edge type
 * 4. addNodes throws on missing 'id'
 * 5. addNodes throws on missing type
 * 6. skipValidation=true bypasses edge validation
 * 7. Valid data passes without error
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { RFDBServerBackend } from '@grafema/util';

let testCounter = 0;

function createTestPaths() {
  const testId = `iv-${testCounter++}`;
  // Short path to avoid macOS unix socket path length limit
  const testDir = join('/tmp', `.grf-${testId}`);
  const dbPath = join(testDir, 'g.rfdb');
  const socketPath = join(testDir, 'r.sock');
  mkdirSync(testDir, { recursive: true });
  return { testDir, dbPath, socketPath };
}

describe('RFDBServerBackend Input Validation', () => {
  let testPaths;
  let backend;

  before(async () => {
    testPaths = createTestPaths();
    backend = new RFDBServerBackend({
      dbPath: testPaths.dbPath,
      socketPath: testPaths.socketPath,
    });
    await backend.connect();
  });

  after(async () => {
    if (backend) await backend.close();
    if (testPaths) rmSync(testPaths.testDir, { recursive: true, force: true });
  });

  // --- addEdges validation ---

  it('throws on missing src field', async () => {
    await assert.rejects(
      () => backend.addEdges([{ dst: 'b', edgeType: 'CALLS' }]),
      (err) => {
        assert.match(err.message, /missing required 'src' field/);
        return true;
      }
    );
  });

  it('throws on missing src with hint when source is present', async () => {
    await assert.rejects(
      () => backend.addEdges([{ source: 'a', target: 'b', edgeType: 'CALLS' }]),
      (err) => {
        assert.match(err.message, /missing required 'src' field/);
        assert.match(err.message, /Did you mean 'src'\?/);
        assert.match(err.message, /Found 'source'/);
        return true;
      }
    );
  });

  it('throws on missing dst field', async () => {
    await assert.rejects(
      () => backend.addEdges([{ src: 'a', edgeType: 'CALLS' }]),
      (err) => {
        assert.match(err.message, /missing required 'dst' field/);
        return true;
      }
    );
  });

  it('throws on missing dst with hint when target is present', async () => {
    await assert.rejects(
      () => backend.addEdges([{ src: 'a', target: 'b', edgeType: 'CALLS' }]),
      (err) => {
        assert.match(err.message, /missing required 'dst' field/);
        assert.match(err.message, /Did you mean 'dst'\?/);
        return true;
      }
    );
  });

  it('throws on missing edge type', async () => {
    await assert.rejects(
      () => backend.addEdges([{ src: 'a', dst: 'b' }]),
      (err) => {
        assert.match(err.message, /missing edge type/);
        return true;
      }
    );
  });

  it('reports correct index for bad edge in batch', async () => {
    await assert.rejects(
      () => backend.addEdges([
        { src: 'a', dst: 'b', edgeType: 'CALLS' },
        { src: 'c', dst: 'd', edgeType: 'CALLS' },
        { source: 'e', target: 'f', edgeType: 'CALLS' },  // bad at index 2
      ]),
      (err) => {
        assert.match(err.message, /index 2/);
        return true;
      }
    );
  });

  it('skipValidation=true bypasses checks', async () => {
    // Should not throw even with bad data
    await backend.addEdges(
      [{ source: 'a', target: 'b', edgeType: 'CALLS' }],
      true  // skipValidation
    );
  });

  it('accepts valid edges without error', async () => {
    await backend.addEdges([
      { src: 'node-a', dst: 'node-b', edgeType: 'CALLS' },
      { src: 'node-c', dst: 'node-d', type: 'IMPORTS_FROM' },
      { src: 'node-e', dst: 'node-f', edge_type: 'EXTENDS' },
    ]);
  });

  // --- addNodes validation ---

  it('throws on missing id field', async () => {
    await assert.rejects(
      () => backend.addNodes([{ type: 'FUNCTION', name: 'foo' }]),
      (err) => {
        assert.match(err.message, /missing required 'id' field/);
        return true;
      }
    );
  });

  it('throws on missing type fields', async () => {
    await assert.rejects(
      () => backend.addNodes([{ id: 'node-1', name: 'foo' }]),
      (err) => {
        assert.match(err.message, /missing type/);
        return true;
      }
    );
  });

  it('accepts valid nodes without error', async () => {
    await backend.addNodes([
      { id: 'test-node-1', type: 'FUNCTION', name: 'foo', file: 'test.py' },
      { id: 'test-node-2', nodeType: 'CLASS', name: 'Bar', file: 'test.py' },
    ]);
  });
});
