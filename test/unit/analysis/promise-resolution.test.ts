/**
 * Tests for Promise Dataflow Tracking (REG-334)
 *
 * Tests Promise executor callback detection and RESOLVES_TO edge creation
 * for tracking data flow through resolve() calls.
 *
 * Graph structure we're testing:
 * ```
 * VARIABLE[result] --ASSIGNED_FROM--> CONSTRUCTOR_CALL[new Promise]
 * CALL[resolve(42)] --RESOLVES_TO--> CONSTRUCTOR_CALL[new Promise]
 * CALL[resolve(42)] --PASSES_ARGUMENT--> LITERAL[42]
 * ```
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(
  backend: ReturnType<typeof createTestBackend>,
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-promise-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-promise-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true
  });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: ReturnType<typeof createTestBackend>,
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Find CONSTRUCTOR_CALL node for Promise
 */
async function findPromiseConstructorCall(
  backend: ReturnType<typeof createTestBackend>,
  file?: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => {
    if (n.type !== 'CONSTRUCTOR_CALL') return false;
    const call = n as unknown as { className?: string; file?: string };
    const isPromise = call.className === 'Promise';
    if (file) {
      return isPromise && call.file?.includes(file);
    }
    return isPromise;
  });
}

/**
 * Find CALL node by callee name
 */
async function findCallNode(
  backend: ReturnType<typeof createTestBackend>,
  calleeName: string,
  file?: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => {
    if (n.type !== 'CALL') return false;
    const call = n as unknown as { name?: string; file?: string };
    const matchesName = call.name === calleeName;
    if (file) {
      return matchesName && call.file?.includes(file);
    }
    return matchesName;
  });
}

/**
 * Find all CALL nodes by callee name
 */
async function findAllCallNodes(
  backend: ReturnType<typeof createTestBackend>,
  calleeName: string,
  file?: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => {
    if (n.type !== 'CALL') return false;
    const call = n as unknown as { name?: string; file?: string };
    const matchesName = call.name === calleeName;
    if (file) {
      return matchesName && call.file?.includes(file);
    }
    return matchesName;
  });
}

/**
 * Find edges by type
 */
async function findEdgesByType(
  backend: ReturnType<typeof createTestBackend>,
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Find RESOLVES_TO edge from a specific source node
 */
async function findResolvesToEdge(
  backend: ReturnType<typeof createTestBackend>,
  srcNodeId: string
): Promise<EdgeRecord | undefined> {
  const allEdges = await backend.getAllEdges();
  return allEdges.find((e: EdgeRecord) =>
    e.type === 'RESOLVES_TO' && e.src === srcNodeId
  );
}

// =============================================================================
// TESTS: Promise Executor Detection
// =============================================================================

describe('Promise Resolution Detection (REG-334)', () => {
  let backend: ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend() as ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  // ===========================================================================
  // TEST 1: Simple Promise with inline resolve
  // ===========================================================================

  describe('Simple Promise with inline resolve', () => {
    it('should create RESOLVES_TO edge from resolve CALL to Promise CONSTRUCTOR_CALL', async () => {
      await setupTest(backend, {
        'index.js': `
const result = new Promise((resolve) => {
  resolve(42);
});
        `
      });

      // Find Promise CONSTRUCTOR_CALL node
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should have CONSTRUCTOR_CALL node for new Promise()');

      // Find resolve CALL node
      const resolveNode = await findCallNode(backend, 'resolve');
      assert.ok(
        resolveNode,
        `Should have CALL node for resolve(). ` +
        `All nodes: ${JSON.stringify(await getNodesByType(backend, 'CALL'))}`
      );

      // Find RESOLVES_TO edge from resolve to Promise
      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');
      assert.ok(
        resolvesToEdges.length > 0,
        `Should have RESOLVES_TO edge. Found edges: ${JSON.stringify(resolvesToEdges)}`
      );

      // Verify edge connects resolve CALL to Promise CONSTRUCTOR_CALL
      const edge = resolvesToEdges.find(e =>
        e.src === resolveNode!.id && e.dst === promiseNode!.id
      );
      assert.ok(
        edge,
        `RESOLVES_TO edge should connect resolve CALL to Promise CONSTRUCTOR_CALL. ` +
        `resolveNode.id: ${resolveNode!.id}, promiseNode.id: ${promiseNode!.id}, ` +
        `edges: ${JSON.stringify(resolvesToEdges)}`
      );
    });

    it('should have PASSES_ARGUMENT edge from resolve CALL to the argument', async () => {
      await setupTest(backend, {
        'index.js': `
const result = new Promise((resolve) => {
  resolve(42);
});
        `
      });

      // Find resolve CALL node
      const resolveNode = await findCallNode(backend, 'resolve');
      assert.ok(resolveNode, 'Should have CALL node for resolve()');

      // Find PASSES_ARGUMENT edge from resolve call
      const allEdges = await backend.getAllEdges();
      const passesArgEdge = allEdges.find((e: EdgeRecord) =>
        e.type === 'PASSES_ARGUMENT' && e.src === resolveNode!.id
      );

      assert.ok(
        passesArgEdge,
        `resolve(42) should have PASSES_ARGUMENT edge to its argument. ` +
        `Edges from resolve: ${JSON.stringify(allEdges.filter((e: EdgeRecord) => e.src === resolveNode!.id))}`
      );
    });
  });

  // ===========================================================================
  // TEST 2: Promise with resolve and reject
  // ===========================================================================

  describe('Promise with resolve and reject', () => {
    it('should create RESOLVES_TO edges for both resolve and reject calls', async () => {
      await setupTest(backend, {
        'index.js': `
const data = new Promise((resolve, reject) => {
  const condition = Math.random() > 0.5;
  if (condition) {
    resolve('success');
  } else {
    reject(new Error('failed'));
  }
});
        `
      });

      // Find Promise CONSTRUCTOR_CALL node
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should have CONSTRUCTOR_CALL node for new Promise()');

      // Find RESOLVES_TO edges
      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');

      // Should have edges for both resolve and reject
      assert.ok(
        resolvesToEdges.length >= 2,
        `Should have at least 2 RESOLVES_TO edges (one for resolve, one for reject). ` +
        `Found: ${resolvesToEdges.length}`
      );

      // All RESOLVES_TO edges should point to the same Promise CONSTRUCTOR_CALL
      const allPointToPromise = resolvesToEdges.every(e => e.dst === promiseNode!.id);
      assert.ok(
        allPointToPromise,
        `All RESOLVES_TO edges should point to the same Promise CONSTRUCTOR_CALL. ` +
        `Edges: ${JSON.stringify(resolvesToEdges)}`
      );

      // Check isReject metadata
      const rejectEdges = resolvesToEdges.filter(e => {
        const metadata = e.metadata as { isReject?: boolean } | undefined;
        return metadata?.isReject === true;
      });
      const resolveEdges = resolvesToEdges.filter(e => {
        const metadata = e.metadata as { isReject?: boolean } | undefined;
        return metadata?.isReject === false || metadata?.isReject === undefined;
      });

      assert.ok(
        rejectEdges.length >= 1,
        `Should have at least one RESOLVES_TO edge with isReject=true. ` +
        `Found reject edges: ${JSON.stringify(rejectEdges)}`
      );
      assert.ok(
        resolveEdges.length >= 1,
        `Should have at least one RESOLVES_TO edge with isReject=false. ` +
        `Found resolve edges: ${JSON.stringify(resolveEdges)}`
      );
    });
  });

  // ===========================================================================
  // TEST 3: Nested callback inside executor
  // ===========================================================================

  describe('Nested callback inside executor', () => {
    it('should create RESOLVES_TO edge even from deeply nested resolve call', async () => {
      await setupTest(backend, {
        'index.js': `
function mockDb() {
  return {
    query: (sql, callback) => callback(null, [{ id: 1 }])
  };
}

const db = mockDb();

const rows = new Promise((resolve) => {
  db.query('SELECT *', (err, data) => {
    resolve(data);
  });
});
        `
      });

      // Find Promise CONSTRUCTOR_CALL node
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should have CONSTRUCTOR_CALL node for new Promise()');

      // Find RESOLVES_TO edges
      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');

      // Should have edge from resolve(data) to Promise
      assert.ok(
        resolvesToEdges.length >= 1,
        `Should have RESOLVES_TO edge from nested resolve call. ` +
        `Found: ${resolvesToEdges.length}`
      );

      // Edge should point to Promise
      const edgeToPromise = resolvesToEdges.find(e => e.dst === promiseNode!.id);
      assert.ok(
        edgeToPromise,
        `RESOLVES_TO edge should point to Promise CONSTRUCTOR_CALL. ` +
        `Edges: ${JSON.stringify(resolvesToEdges)}`
      );
    });
  });

  // ===========================================================================
  // TEST 4: Nested Promises (no cross-linking)
  // ===========================================================================

  describe('Nested Promises', () => {
    it('should link each resolve to its own Promise (no cross-linking)', async () => {
      await setupTest(backend, {
        'index.js': `
const outer = new Promise((resolveOuter) => {
  const inner = new Promise((resolveInner) => {
    resolveInner('inner');
  });
  resolveOuter('outer');
});
        `
      });

      // Find both Promise CONSTRUCTOR_CALL nodes
      const allNodes = await backend.getAllNodes();
      const promiseNodes = allNodes.filter((n: NodeRecord) =>
        n.type === 'CONSTRUCTOR_CALL' &&
        (n as unknown as { className?: string }).className === 'Promise'
      );

      assert.strictEqual(
        promiseNodes.length, 2,
        `Should have 2 CONSTRUCTOR_CALL nodes for nested Promises. Found: ${promiseNodes.length}`
      );

      // Find all RESOLVES_TO edges
      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');

      // Should have 2 edges (one for each resolve)
      assert.strictEqual(
        resolvesToEdges.length, 2,
        `Should have 2 RESOLVES_TO edges. Found: ${resolvesToEdges.length}`
      );

      // Each edge should point to a different Promise
      const dstIds = resolvesToEdges.map(e => e.dst);
      const uniqueDstIds = new Set(dstIds);
      assert.strictEqual(
        uniqueDstIds.size, 2,
        `Each RESOLVES_TO edge should point to a different Promise. ` +
        `Got dst IDs: ${JSON.stringify(dstIds)}`
      );

      // All dst IDs should be Promise CONSTRUCTOR_CALL nodes
      const promiseNodeIds = new Set(promiseNodes.map(n => n.id));
      for (const dstId of dstIds) {
        assert.ok(
          promiseNodeIds.has(dstId),
          `RESOLVES_TO dst should be a Promise CONSTRUCTOR_CALL. ` +
          `dstId: ${dstId}, promiseNodeIds: ${JSON.stringify([...promiseNodeIds])}`
        );
      }
    });
  });

  // ===========================================================================
  // TEST 5: Edge cases - graceful handling
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle Promise with no resolve parameter (no crash)', async () => {
      await setupTest(backend, {
        'index.js': `
// Edge case: executor with no parameters
const empty = new Promise(() => {
  console.log('no resolve');
});
        `
      });

      // Should not crash, just no RESOLVES_TO edges
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should still create CONSTRUCTOR_CALL node for Promise');

      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');
      assert.strictEqual(
        resolvesToEdges.length, 0,
        `Should have no RESOLVES_TO edges when no resolve parameter. Found: ${resolvesToEdges.length}`
      );
    });

    it('should handle Promise with non-inline executor (out of scope)', async () => {
      await setupTest(backend, {
        'index.js': `
function existingFunc(resolve, reject) {
  resolve('value');
}

// Edge case: executor is a variable reference, not inline function
const withExisting = new Promise(existingFunc);
        `
      });

      // Should not crash, no RESOLVES_TO edges expected (out of scope for MVP)
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should still create CONSTRUCTOR_CALL node for Promise');

      // Note: This is documented out of scope for MVP
      // Just verify no crash occurs
    });

    it('should handle multiple resolve calls in same executor', async () => {
      await setupTest(backend, {
        'index.js': `
const result = new Promise((resolve) => {
  const rand = Math.random();
  if (rand > 0.7) {
    resolve('high');
  } else if (rand > 0.3) {
    resolve('medium');
  } else {
    resolve('low');
  }
});
        `
      });

      // Find Promise CONSTRUCTOR_CALL node
      const promiseNode = await findPromiseConstructorCall(backend);
      assert.ok(promiseNode, 'Should have CONSTRUCTOR_CALL node for Promise');

      // Find all resolve CALL nodes
      const resolveNodes = await findAllCallNodes(backend, 'resolve');
      assert.strictEqual(
        resolveNodes.length, 3,
        `Should have 3 resolve CALL nodes. Found: ${resolveNodes.length}`
      );

      // Find RESOLVES_TO edges
      const resolvesToEdges = await findEdgesByType(backend, 'RESOLVES_TO');
      assert.strictEqual(
        resolvesToEdges.length, 3,
        `Should have 3 RESOLVES_TO edges (one per resolve call). Found: ${resolvesToEdges.length}`
      );

      // All should point to the same Promise
      const allPointToPromise = resolvesToEdges.every(e => e.dst === promiseNode!.id);
      assert.ok(
        allPointToPromise,
        `All RESOLVES_TO edges should point to the same Promise`
      );
    });
  });
});

// =============================================================================
// TESTS: traceValues with Promises
// =============================================================================

describe('traceValues with RESOLVES_TO edges (REG-334)', () => {
  let backend: ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend() as ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  /**
   * Note: These integration tests verify that traceValues can trace
   * through RESOLVES_TO edges to find actual data sources.
   *
   * We use the traceValues utility from @grafema/core.
   */
  it('should trace variable through Promise to literal value', async () => {
    await setupTest(backend, {
      'index.js': `
const result = new Promise((resolve) => {
  resolve(42);
});
        `
    });

    // Import traceValues
    const { traceValues } = await import('@grafema/core');

    // Find the variable 'result'
    const allNodes = await backend.getAllNodes();
    const resultVar = allNodes.find((n: NodeRecord) =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') &&
      (n as unknown as { name?: string }).name === 'result'
    );
    assert.ok(resultVar, 'Should find variable "result"');

    // Trace values
    const traced = await traceValues(backend, resultVar!.id);

    // Should trace through Promise and RESOLVES_TO to find the literal
    // Note: This will FAIL until traceValues is extended to handle CONSTRUCTOR_CALL
    assert.ok(
      traced.length >= 1,
      `Should trace at least one value. Got: ${JSON.stringify(traced)}`
    );

    // Check if we found the literal value 42
    const foundLiteral = traced.find(t => t.value === 42);
    assert.ok(
      foundLiteral,
      `Should trace to literal value 42. Got values: ${JSON.stringify(traced.map(t => t.value))}`
    );
    assert.strictEqual(foundLiteral!.isUnknown, false, 'Literal value should not be unknown');
  });

  it('should trace variable through Promise to find multiple resolve values', async () => {
    await setupTest(backend, {
      'index.js': `
const flag = new Promise((resolve) => {
  if (Math.random() > 0.5) {
    resolve('heads');
  } else {
    resolve('tails');
  }
});
        `
    });

    // Import traceValues
    const { traceValues } = await import('@grafema/core');

    // Find the variable 'flag'
    const allNodes = await backend.getAllNodes();
    const flagVar = allNodes.find((n: NodeRecord) =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') &&
      (n as unknown as { name?: string }).name === 'flag'
    );
    assert.ok(flagVar, 'Should find variable "flag"');

    // Trace values
    const traced = await traceValues(backend, flagVar!.id);

    // Should find both possible values
    const values = traced.filter(t => !t.isUnknown).map(t => t.value).sort();
    assert.ok(
      values.includes('heads') && values.includes('tails'),
      `Should find both 'heads' and 'tails'. Got: ${JSON.stringify(values)}`
    );
  });

  it('should handle Promise without RESOLVES_TO as unknown', async () => {
    await setupTest(backend, {
      'index.js': `
// Promise with existing function reference (no RESOLVES_TO edges)
function existingFunc(resolve) {
  resolve('value');
}
const withExisting = new Promise(existingFunc);
        `
    });

    // Import traceValues
    const { traceValues } = await import('@grafema/core');

    // Find the variable
    const allNodes = await backend.getAllNodes();
    const existingVar = allNodes.find((n: NodeRecord) =>
      (n.type === 'VARIABLE' || n.type === 'CONSTANT') &&
      (n as unknown as { name?: string }).name === 'withExisting'
    );
    assert.ok(existingVar, 'Should find variable "withExisting"');

    // Trace values
    const traced = await traceValues(backend, existingVar!.id);

    // Without RESOLVES_TO edges, should return unknown with reason
    assert.ok(
      traced.length >= 1,
      `Should return at least one result`
    );

    // Either finds resolve through some other means, or marks as unknown
    // Note: Before REG-334 implementation, traceValues returns no_sources for CONSTRUCTOR_CALL
    // After implementation, should return constructor_call
    const hasConstructorCallUnknown = traced.some(t =>
      t.isUnknown && (
        t.reason === 'constructor_call' ||
        t.reason === 'call_result' ||
        t.reason === 'no_sources'  // Current behavior before implementation
      )
    );
    const hasFoundValue = traced.some(t => !t.isUnknown);

    assert.ok(
      hasConstructorCallUnknown || hasFoundValue,
      `Should either find value or mark as unknown with appropriate reason. Got: ${JSON.stringify(traced)}`
    );
  });
});
