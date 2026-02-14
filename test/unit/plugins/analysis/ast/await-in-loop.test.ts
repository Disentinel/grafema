/**
 * Await-in-Loop Detection Tests (REG-298)
 *
 * Tests for tracking `isInsideLoop` metadata on CALL nodes when
 * an awaited call occurs inside a loop body. This enables detection
 * of sequential await patterns that could be parallelized.
 *
 * Forward registration: `isInsideLoop` is set during AST walk via
 * `controlFlowState.loopDepth` counter (same pattern as `isInsideTry`).
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-await-loop-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-await-loop-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getCallNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === 'CALL');
}

function findCall(nodes: NodeRecord[], name: string): NodeRecord | undefined {
  return nodes.find((n: NodeRecord) => n.name === name || n.name?.endsWith(`.${name}`));
}

// =============================================================================
// TESTS
// =============================================================================

describe('Await-in-Loop Detection (REG-298)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // GROUP 1: Basic await-in-loop detection
  // ===========================================================================

  describe('Basic await-in-loop detection', () => {
    it('should mark awaited call inside for-of loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function fetchAll(urls) {
            for (const url of urls) {
              const data = await fetch(url);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const fetchCall = findCall(calls, 'fetch');

      assert.ok(fetchCall, 'fetch call node should exist');
      assert.strictEqual((fetchCall as any).isAwaited, true, 'fetch should be awaited');
      assert.strictEqual((fetchCall as any).isInsideLoop, true, 'fetch should be inside loop');
    });

    it('should mark awaited method call inside for loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function processItems(items) {
            for (let i = 0; i < items.length; i++) {
              await db.query(items[i]);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const queryCall = findCall(calls, 'query');

      assert.ok(queryCall, 'db.query call node should exist');
      assert.strictEqual((queryCall as any).isAwaited, true, 'db.query should be awaited');
      assert.strictEqual((queryCall as any).isInsideLoop, true, 'db.query should be inside loop');
    });

    it('should mark awaited call inside while loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function drain(queue) {
            while (queue.length > 0) {
              const item = queue.shift();
              await process(item);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const processCall = findCall(calls, 'process');

      assert.ok(processCall, 'process call node should exist');
      assert.strictEqual((processCall as any).isAwaited, true);
      assert.strictEqual((processCall as any).isInsideLoop, true);
    });

    it('should mark awaited call inside for-in loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function loadConfigs(configs) {
            for (const key in configs) {
              await loadConfig(key);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const loadCall = findCall(calls, 'loadConfig');

      assert.ok(loadCall, 'loadConfig call node should exist');
      assert.strictEqual((loadCall as any).isAwaited, true);
      assert.strictEqual((loadCall as any).isInsideLoop, true);
    });

    it('should mark awaited call inside do-while loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function retryUntilSuccess() {
            let result;
            do {
              result = await attempt();
            } while (!result.ok);
          }
        `
      });

      const calls = await getCallNodes(backend);
      const attemptCall = findCall(calls, 'attempt');

      assert.ok(attemptCall, 'attempt call node should exist');
      assert.strictEqual((attemptCall as any).isAwaited, true);
      assert.strictEqual((attemptCall as any).isInsideLoop, true);
    });
  });

  // ===========================================================================
  // GROUP 2: Non-loop await (should NOT be flagged)
  // ===========================================================================

  describe('Non-loop await (should NOT be flagged)', () => {
    it('should NOT mark awaited call outside any loop', async () => {
      await setupTest(backend, {
        'index.js': `
          async function main() {
            const data = await fetch('http://example.com');
          }
        `
      });

      const calls = await getCallNodes(backend);
      const fetchCall = findCall(calls, 'fetch');

      assert.ok(fetchCall, 'fetch call node should exist');
      assert.strictEqual((fetchCall as any).isAwaited, true, 'should be awaited');
      assert.ok(
        !(fetchCall as any).isInsideLoop,
        'should NOT have isInsideLoop=true'
      );
    });

    it('should NOT mark non-awaited call inside loop', async () => {
      await setupTest(backend, {
        'index.js': `
          async function fireAndForget(urls) {
            for (const url of urls) {
              fetch(url);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const fetchCall = findCall(calls, 'fetch');

      assert.ok(fetchCall, 'fetch call node should exist');
      assert.ok(!(fetchCall as any).isAwaited, 'should NOT be awaited');
    });
  });

  // ===========================================================================
  // GROUP 3: Callback in loop (function boundary reset)
  // ===========================================================================

  describe('Callback in loop (function boundary reset)', () => {
    it('should NOT flag await inside callback in a loop', async () => {
      await setupTest(backend, {
        'index.js': `
          async function processAll(items) {
            for (const item of items) {
              items.map(async (x) => {
                await transform(x);
              });
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const transformCall = findCall(calls, 'transform');

      assert.ok(transformCall, 'transform call node should exist');
      assert.strictEqual((transformCall as any).isAwaited, true, 'should be awaited');
      assert.ok(
        !(transformCall as any).isInsideLoop,
        'should NOT be inside loop (callback creates new function scope)'
      );
    });

    it('should NOT flag await inside Promise constructor in a loop', async () => {
      await setupTest(backend, {
        'index.js': `
          async function processAll(items) {
            for (const item of items) {
              await new Promise(async (resolve) => {
                await doWork(item);
                resolve();
              });
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const doWorkCall = findCall(calls, 'doWork');

      assert.ok(doWorkCall, 'doWork call node should exist');
      assert.strictEqual((doWorkCall as any).isAwaited, true);
      assert.ok(
        !(doWorkCall as any).isInsideLoop,
        'should NOT be inside loop (Promise executor is new function scope)'
      );
    });
  });

  // ===========================================================================
  // GROUP 4: Nested loops
  // ===========================================================================

  describe('Nested loops', () => {
    it('should mark await in nested loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function matrix(rows) {
            for (const row of rows) {
              for (const cell of row) {
                await processCell(cell);
              }
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const processCall = findCall(calls, 'processCell');

      assert.ok(processCall, 'processCell call node should exist');
      assert.strictEqual((processCall as any).isAwaited, true);
      assert.strictEqual((processCall as any).isInsideLoop, true);
    });
  });

  // ===========================================================================
  // GROUP 5: Conditional await in loop
  // ===========================================================================

  describe('Conditional await in loop', () => {
    it('should mark conditional await in loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function conditionalFetch(items) {
            for (const item of items) {
              if (item.needsRefresh) {
                await refresh(item);
              }
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const refreshCall = findCall(calls, 'refresh');

      assert.ok(refreshCall, 'refresh call node should exist');
      assert.strictEqual((refreshCall as any).isAwaited, true);
      assert.strictEqual((refreshCall as any).isInsideLoop, true);
    });
  });

  // ===========================================================================
  // GROUP 6: for-await-of
  // ===========================================================================

  describe('for-await-of', () => {
    it('should mark inner await in for-await-of loop with isInsideLoop=true', async () => {
      await setupTest(backend, {
        'index.js': `
          async function consumeStream(stream) {
            for await (const chunk of stream) {
              await writeToFile(chunk);
            }
          }
        `
      });

      const calls = await getCallNodes(backend);
      const writeCall = findCall(calls, 'writeToFile');

      assert.ok(writeCall, 'writeToFile call node should exist');
      assert.strictEqual((writeCall as any).isAwaited, true);
      assert.strictEqual((writeCall as any).isInsideLoop, true);
    });
  });
});
