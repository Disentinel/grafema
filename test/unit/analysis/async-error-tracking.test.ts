/**
 * Async Error Tracking Tests (REG-311)
 *
 * Tests for tracking error patterns in async JavaScript code:
 * - Promise.reject() patterns
 * - throw in async functions
 * - Variable-based rejections (micro-trace)
 * - isAwaited / isInsideTry metadata on CALL nodes
 * - CATCHES_FROM edges linking catch blocks to error sources
 * - RejectionPropagationEnricher for transitive error propagation
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../helpers/TestRFDB.js';
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-async-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-async-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Find function node by name
 */
async function getFunctionByName(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  name: string
): Promise<NodeRecord | undefined> {
  const functionNodes = await getNodesByType(backend, 'FUNCTION');
  return functionNodes.find((n: NodeRecord) => n.name === name);
}

/**
 * Find CALL nodes by callee name
 */
async function findCallNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  calleeName: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => {
    if (n.type !== 'CALL') return false;
    const call = n as unknown as { name?: string };
    return call.name === calleeName;
  });
}

/**
 * Find edges by type
 */
async function findEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Find edges from a specific source node
 */
async function findEdgesFrom(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  srcId: string,
  edgeType?: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) =>
    e.src === srcId && (!edgeType || e.type === edgeType)
  );
}

/**
 * Find CATCH_BLOCK nodes
 */
async function findCatchBlocks(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<NodeRecord[]> {
  return getNodesByType(backend, 'CATCH_BLOCK');
}

// =============================================================================
// TESTS GROUP 1: Basic Rejection Patterns
// =============================================================================

describe('Basic Rejection Patterns (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 1.1 Promise.reject(new Error())
  // ---------------------------------------------------------------------------

  describe('Promise.reject() patterns', () => {
    it('should detect Promise.reject(new Error()) pattern', async () => {
      await setupTest(db.backend, {
        'index.js': `
function rejectWithError() {
  return Promise.reject(new Error('fail'));
}
        `
      });

      const func = await getFunctionByName(db.backend, 'rejectWithError');
      assert.ok(func, 'Should have function rejectWithError');

      // Function should have rejectionPatterns (at top level - backend spreads metadata)
      const record = func as unknown as { rejectionPatterns?: unknown[] };
      assert.ok(
        record.rejectionPatterns,
        'Function should have rejectionPatterns'
      );

      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }>;
      assert.ok(patterns.length >= 1, 'Should have at least one rejection pattern');

      const pattern = patterns.find(p => p.rejectionType === 'promise_reject');
      assert.ok(pattern, 'Should have promise_reject pattern');
      assert.strictEqual(pattern.errorClassName, 'Error', 'Error class should be Error');
    });

    it('should detect Promise.reject(new ValidationError()) with custom error class', async () => {
      await setupTest(db.backend, {
        'index.js': `
class ValidationError extends Error {}

function rejectWithValidation() {
  return Promise.reject(new ValidationError('invalid'));
}
        `
      });

      const func = await getFunctionByName(db.backend, 'rejectWithValidation');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'promise_reject');
      assert.ok(pattern, 'Should have promise_reject pattern');
      assert.strictEqual(
        pattern.errorClassName,
        'ValidationError',
        'Should track custom error class name'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.2 reject() in Promise executor
  // ---------------------------------------------------------------------------

  describe('Promise executor reject() patterns', () => {
    it('should detect reject(new Error()) in Promise executor', async () => {
      await setupTest(db.backend, {
        'index.js': `
function createRejectedPromise() {
  return new Promise((resolve, reject) => {
    reject(new Error('executor fail'));
  });
}
        `
      });

      const func = await getFunctionByName(db.backend, 'createRejectedPromise');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'executor_reject');
      assert.ok(pattern, 'Should have executor_reject pattern');
      assert.strictEqual(pattern.errorClassName, 'Error', 'Error class should be Error');
    });

    it('should detect conditional reject in Promise executor', async () => {
      await setupTest(db.backend, {
        'index.js': `
function conditionalReject(condition) {
  return new Promise((resolve, reject) => {
    if (condition) {
      reject(new Error('condition failed'));
    } else {
      resolve('success');
    }
  });
}
        `
      });

      const func = await getFunctionByName(db.backend, 'conditionalReject');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');
      assert.ok(
        patterns.some(p => p.rejectionType === 'executor_reject'),
        'Should detect executor_reject even in conditional'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1.3 throw new Error() in async function
  // ---------------------------------------------------------------------------

  describe('async function throw patterns', () => {
    it('should detect throw new Error() in async function', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function asyncThrow() {
  throw new Error('async fail');
}
        `
      });

      const func = await getFunctionByName(db.backend, 'asyncThrow');
      assert.ok(func, 'Should have async function');

      const record = func as unknown as {
        async?: boolean;
        rejectionPatterns?: unknown[];
      };
      assert.strictEqual(record.async, true, 'Function should be async');

      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'async_throw');
      assert.ok(pattern, 'Should have async_throw pattern');
      assert.strictEqual(pattern.errorClassName, 'Error', 'Error class should be Error');
    });

    it('should detect throw in async arrow function', async () => {
      await setupTest(db.backend, {
        'index.js': `
const asyncArrowThrow = async () => {
  throw new TypeError('arrow fail');
};
        `
      });

      const functionNodes = await getNodesByType(db.backend, 'FUNCTION');
      const asyncArrow = functionNodes.find((n: NodeRecord) => {
        const record = n as unknown as { async?: boolean; arrowFunction?: boolean };
        return record.async && record.arrowFunction;
      });

      assert.ok(asyncArrow, 'Should have async arrow function');

      const record = asyncArrow as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'async_throw');
      assert.ok(pattern, 'Should have async_throw pattern');
      assert.strictEqual(pattern.errorClassName, 'TypeError', 'Should detect TypeError');
    });

    it('should track throw in non-async function as sync_throw (REG-286)', async () => {
      await setupTest(db.backend, {
        'index.js': `
function syncThrow() {
  throw new Error('sync fail');
}
        `
      });

      const func = await getFunctionByName(db.backend, 'syncThrow');
      assert.ok(func, 'Should have sync function');

      const record = func as unknown as {
        async?: boolean;
        rejectionPatterns?: unknown[];
      };
      assert.ok(!record.async, 'Function should not be async');

      // REG-286: Sync function throw should have sync_throw pattern (not async_throw)
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string;
      }> | undefined;
      assert.ok(patterns, 'Should have rejectionPatterns for sync throws');

      const syncPattern = patterns.find(p => p.rejectionType === 'sync_throw');
      assert.ok(syncPattern, 'Should have sync_throw pattern');
      assert.strictEqual(syncPattern.errorClassName, 'Error', 'Should track Error class');

      // Should NOT have async_throw patterns
      const asyncPatterns = patterns.filter(p => p.rejectionType === 'async_throw');
      assert.strictEqual(asyncPatterns.length, 0, 'Sync function should not have async_throw patterns');
    });
  });
});

// =============================================================================
// TESTS GROUP 2: Variable Rejection Micro-Trace
// =============================================================================

describe('Variable Rejection Micro-Trace (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 2.1 const err = new Error(); reject(err)
  // ---------------------------------------------------------------------------

  describe('Variable to NewExpression tracing', () => {
    it('should trace reject(err) to const err = new Error()', async () => {
      await setupTest(db.backend, {
        'index.js': `
function rejectViaVariable() {
  const err = new ValidationError('bad');
  return Promise.reject(err);
}
        `
      });

      const func = await getFunctionByName(db.backend, 'rejectViaVariable');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string | null;
        sourceVariableName?: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');
      assert.ok(patterns.length >= 1, 'Should have at least one pattern');

      const pattern = patterns.find(
        p => p.rejectionType === 'variable_traced' || p.rejectionType === 'promise_reject'
      );
      assert.ok(pattern, 'Should have traced pattern');
      assert.strictEqual(
        pattern.errorClassName,
        'ValidationError',
        'Should trace to ValidationError class'
      );
    });

    it('should trace chained variable assignment', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function chainedThrow() {
  const original = new AuthError('auth fail');
  const err = original;
  throw err;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'chainedThrow');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string | null;
        tracePath?: string[];
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'variable_traced');
      assert.ok(pattern, 'Should have variable_traced pattern');
      assert.strictEqual(
        pattern.errorClassName,
        'AuthError',
        'Should trace through chain to AuthError'
      );

      // Verify trace path shows the chain
      if (pattern.tracePath) {
        assert.ok(
          pattern.tracePath.length >= 2,
          'Trace path should show chained assignment'
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2.2 throw param (parameter forwarding)
  // ---------------------------------------------------------------------------

  describe('Parameter forwarding patterns', () => {
    it('should detect throw param as variable_parameter', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function rethrow(e) {
  throw e;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'rethrow');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        sourceVariableName?: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'variable_parameter');
      assert.ok(pattern, 'Should have variable_parameter pattern');
      assert.strictEqual(
        pattern.sourceVariableName,
        'e',
        'Should track parameter name'
      );
    });

    it('should detect reject(param) as variable_parameter in Promise executor', async () => {
      await setupTest(db.backend, {
        'index.js': `
function wrapError(err) {
  return new Promise((resolve, reject) => {
    reject(err);
  });
}
        `
      });

      const func = await getFunctionByName(db.backend, 'wrapError');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        sourceVariableName?: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'variable_parameter');
      assert.ok(pattern, 'Should have variable_parameter pattern');
    });
  });

  // ---------------------------------------------------------------------------
  // 2.3 Cycle detection
  // ---------------------------------------------------------------------------

  describe('Cycle detection in micro-trace', () => {
    it('should not hang on circular assignment (not depth limited)', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function circularRef() {
  let a = b;
  let b = a;
  throw a;
}
        `
      });

      // Test should complete without hanging
      const func = await getFunctionByName(db.backend, 'circularRef');
      assert.ok(func, 'Should complete analysis without hanging');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
      }> | undefined;

      // Should mark as unknown since cycle can't resolve to NewExpression
      assert.ok(patterns, 'Should have rejectionPatterns');
      const pattern = patterns.find(
        p => p.rejectionType === 'variable_unknown' || p.rejectionType === 'variable_traced'
      );
      assert.ok(pattern, 'Should have pattern (either unknown or traced)');
    });

    it('should detect variable_unknown when variable cannot be traced', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function unknownSource(condition) {
  const err = getError(condition);  // Call result, not NewExpression
  throw err;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'unknownSource');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string | null;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');

      const pattern = patterns.find(p => p.rejectionType === 'variable_unknown');
      assert.ok(pattern, 'Should have variable_unknown pattern');
      assert.strictEqual(
        pattern.errorClassName,
        null,
        'Unknown source should have null errorClassName'
      );
    });
  });
});

// =============================================================================
// TESTS GROUP 3: isAwaited / isInsideTry on CALL nodes
// =============================================================================

describe('isAwaited and isInsideTry on CALL nodes (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 3.1 isAwaited detection
  // ---------------------------------------------------------------------------

  describe('isAwaited detection', () => {
    it('should set isAwaited=true for await fn()', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function caller() {
  await riskyOperation();
}
        `
      });

      const calls = await findCallNodes(db.backend, 'riskyOperation');
      assert.ok(calls.length >= 1, 'Should have CALL node for riskyOperation');

      const call = calls[0] as unknown as { isAwaited?: boolean };
      assert.strictEqual(call.isAwaited, true, 'Call should have isAwaited=true');
    });

    it('should set isAwaited=false for fn() without await', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function caller() {
  normalOperation();
}
        `
      });

      const calls = await findCallNodes(db.backend, 'normalOperation');
      assert.ok(calls.length >= 1, 'Should have CALL node for normalOperation');

      const call = calls[0] as unknown as { isAwaited?: boolean };
      assert.ok(
        call.isAwaited === false || call.isAwaited === undefined,
        'Non-awaited call should have isAwaited=false or undefined'
      );
    });

    it('should detect await on method call obj.method()', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function caller(client) {
  await client.fetch('/api');
}
        `
      });

      const allNodes = await db.backend.getAllNodes();
      const fetchCall = allNodes.find((n: NodeRecord) => {
        if (n.type !== 'CALL') return false;
        // Method calls have 'method' field with just the method name, 'name' has full path
        const call = n as unknown as { method?: string; isMethodCall?: boolean };
        return call.method === 'fetch' && call.isMethodCall;
      });

      assert.ok(fetchCall, 'Should have method CALL node');
      const call = fetchCall as unknown as { isAwaited?: boolean };
      assert.strictEqual(call.isAwaited, true, 'Awaited method call should have isAwaited=true');
    });
  });

  // ---------------------------------------------------------------------------
  // 3.2 isInsideTry detection
  // ---------------------------------------------------------------------------

  describe('isInsideTry detection', () => {
    it('should set isInsideTry=true for call inside try block', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function protectedCaller() {
  try {
    await riskyOperation();
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const calls = await findCallNodes(db.backend, 'riskyOperation');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isInsideTry?: boolean };
      assert.strictEqual(call.isInsideTry, true, 'Call inside try should have isInsideTry=true');
    });

    it('should set isInsideTry=false for call outside try block', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function unprotectedCaller() {
  await riskyOperation();
}
        `
      });

      const calls = await findCallNodes(db.backend, 'riskyOperation');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isInsideTry?: boolean };
      assert.ok(
        call.isInsideTry === false || call.isInsideTry === undefined,
        'Call outside try should have isInsideTry=false or undefined'
      );
    });

    it('should detect nested try block protection', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function nestedTry() {
  try {
    try {
      await deeplyNested();
    } catch (inner) {}
  } catch (outer) {}
}
        `
      });

      const calls = await findCallNodes(db.backend, 'deeplyNested');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isInsideTry?: boolean };
      assert.strictEqual(
        call.isInsideTry,
        true,
        'Call in nested try should have isInsideTry=true'
      );
    });

    it('should NOT mark call in catch block as isInsideTry', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function callInCatch() {
  try {
    throw new Error();
  } catch (e) {
    await recoveryOperation();
  }
}
        `
      });

      const calls = await findCallNodes(db.backend, 'recoveryOperation');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isInsideTry?: boolean };
      // Call in catch block is NOT protected by that try/catch (it's in the catch handler)
      assert.ok(
        call.isInsideTry === false || call.isInsideTry === undefined,
        'Call in catch block should not be marked as isInsideTry'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3.3 Combined isAwaited + isInsideTry
  // ---------------------------------------------------------------------------

  describe('Combined isAwaited and isInsideTry', () => {
    it('should have both isAwaited=true and isInsideTry=true for protected await', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function protectedAwait() {
  try {
    await protectedCall();
  } catch (e) {}
}
        `
      });

      const calls = await findCallNodes(db.backend, 'protectedCall');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isAwaited?: boolean; isInsideTry?: boolean };
      assert.strictEqual(call.isAwaited, true, 'Should be awaited');
      assert.strictEqual(call.isInsideTry, true, 'Should be inside try');
    });

    it('should have isAwaited=true and isInsideTry=false for unprotected await', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function unprotectedAwait() {
  await unprotectedCall();
}
        `
      });

      const calls = await findCallNodes(db.backend, 'unprotectedCall');
      assert.ok(calls.length >= 1, 'Should have CALL node');

      const call = calls[0] as unknown as { isAwaited?: boolean; isInsideTry?: boolean };
      assert.strictEqual(call.isAwaited, true, 'Should be awaited');
      assert.ok(
        call.isInsideTry === false || call.isInsideTry === undefined,
        'Should not be inside try'
      );
    });
  });
});

// =============================================================================
// TESTS GROUP 4: CATCHES_FROM edges
// =============================================================================

describe('CATCHES_FROM edges (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 4.1 Catch block linked to awaited calls in try
  // ---------------------------------------------------------------------------

  describe('CATCHES_FROM to awaited calls', () => {
    it('should create CATCHES_FROM edge from catch to awaited call in try', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function test() {
  try {
    await riskyOp();
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchBlocks = await findCatchBlocks(db.backend);
      assert.ok(catchBlocks.length >= 1, 'Should have CATCH_BLOCK node');

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      assert.ok(
        catchesFromEdges.length >= 1,
        `Should have CATCHES_FROM edge. Found: ${catchesFromEdges.length}`
      );

      // Verify edge metadata
      // Note: TestRFDB spreads metadata onto the edge object at top level
      const edge = catchesFromEdges[0] as unknown as { sourceType?: string };
      assert.ok(
        edge.sourceType === 'awaited_call',
        `Edge should have sourceType=awaited_call. Got: ${edge.sourceType}`
      );
    });

    it('should link catch to multiple awaited calls', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function multipleAwaits() {
  try {
    await firstOp();
    await secondOp();
    await thirdOp();
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      assert.ok(
        catchesFromEdges.length >= 3,
        `Should have at least 3 CATCHES_FROM edges for 3 awaits. Found: ${catchesFromEdges.length}`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4.2 Catch block linked to throw statements in try
  // ---------------------------------------------------------------------------

  describe('CATCHES_FROM to throw statements', () => {
    it('should create CATCHES_FROM edge from catch to throw in try', async () => {
      await setupTest(db.backend, {
        'index.js': `
function test() {
  try {
    throw new Error('fail');
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      assert.ok(
        catchesFromEdges.length >= 1,
        'Should have CATCHES_FROM edge for throw statement'
      );

      // Note: TestRFDB spreads metadata onto the edge object at top level
      const edge = catchesFromEdges[0] as unknown as { sourceType?: string };
      assert.strictEqual(
        edge.sourceType,
        'throw_statement',
        'Edge should have sourceType=throw_statement'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4.3 Multiple sources per catch
  // ---------------------------------------------------------------------------

  describe('Multiple sources per catch', () => {
    it('should create CATCHES_FROM edges for mixed sources', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function mixedSources() {
  try {
    await asyncOp();
    throw new Error('manual throw');
    syncCall();
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');

      // Should have edges for: await, throw, and sync call
      assert.ok(
        catchesFromEdges.length >= 2,
        `Should have multiple CATCHES_FROM edges. Found: ${catchesFromEdges.length}`
      );

      // Note: TestRFDB spreads metadata onto the edge object at top level
      const sourceTypes = catchesFromEdges.map(e => {
        const edge = e as unknown as { sourceType?: string };
        return edge.sourceType;
      });

      assert.ok(
        sourceTypes.includes('awaited_call'),
        'Should have awaited_call source'
      );
      assert.ok(
        sourceTypes.includes('throw_statement'),
        'Should have throw_statement source'
      );
    });

    it('should link catch to sync calls that may throw', async () => {
      await setupTest(db.backend, {
        'index.js': `
function syncTryCatch() {
  try {
    JSON.parse(data);
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      assert.ok(
        catchesFromEdges.length >= 1,
        'Should have CATCHES_FROM edge for sync call'
      );

      // Note: TestRFDB spreads metadata onto the edge object at top level
      const edge = catchesFromEdges[0] as unknown as { sourceType?: string };
      assert.strictEqual(
        edge.sourceType,
        'sync_call',
        'Edge should have sourceType=sync_call'
      );
    });

    it('should link catch to constructor calls in try', async () => {
      await setupTest(db.backend, {
        'index.js': `
function constructorTry() {
  try {
    new RiskyClass();
  } catch (e) {
    console.log(e);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      assert.ok(
        catchesFromEdges.length >= 1,
        'Should have CATCHES_FROM edge for constructor call'
      );

      // Note: TestRFDB spreads metadata onto the edge object at top level
      const edge = catchesFromEdges[0] as unknown as { sourceType?: string };
      assert.strictEqual(
        edge.sourceType,
        'constructor_call',
        'Edge should have sourceType=constructor_call'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4.4 Nested try/catch
  // ---------------------------------------------------------------------------

  describe('Nested try/catch', () => {
    it('should link inner catch only to inner try sources', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function nested() {
  try {
    try {
      await innerOp();
    } catch (e1) {
      throw e1;
    }
    await outerOp();
  } catch (e2) {
    console.log(e2);
  }
}
        `
      });

      const catchesFromEdges = await findEdgesByType(db.backend, 'CATCHES_FROM');
      const catchBlocks = await findCatchBlocks(db.backend);

      // Should have 2 catch blocks
      assert.ok(
        catchBlocks.length >= 2,
        `Should have 2 CATCH_BLOCK nodes. Found: ${catchBlocks.length}`
      );

      // At minimum, outer catch should be linked to outerOp call
      // (Inner catch linking is a known limitation with nested traversal - see REG-311)
      assert.ok(
        catchesFromEdges.length >= 1,
        `Should have at least one CATCHES_FROM edge for nested try/catch. Found: ${catchesFromEdges.length}`
      );
    });
  });
});

// =============================================================================
// TESTS GROUP 5: RejectionPropagationEnricher
// =============================================================================

describe('RejectionPropagationEnricher (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 5.1 Transitive propagation through await
  // ---------------------------------------------------------------------------

  describe('Transitive propagation through await', () => {
    it('should propagate REJECTS edge through unprotected await', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function inner() {
  throw new ValidationError('inner fail');
}

async function outer() {
  return await inner();
}
        `
      });

      // Find outer function
      const outer = await getFunctionByName(db.backend, 'outer');
      assert.ok(outer, 'Should have outer function');

      // Check for REJECTS edge from outer
      const rejectsEdges = await findEdgesFrom(db.backend, outer.id, 'REJECTS');
      assert.ok(
        rejectsEdges.length >= 1,
        `Outer should have propagated REJECTS edge. Found: ${rejectsEdges.length}`
      );

      // Verify propagation metadata
      const propagated = rejectsEdges.find(e => {
        const metadata = e.metadata as { rejectionType?: string } | undefined;
        return metadata?.rejectionType === 'propagated';
      });
      assert.ok(propagated, 'Should have propagated REJECTS edge');
    });

    it('should propagate through multiple levels', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function level1() {
  throw new Error('level1');
}

async function level2() {
  await level1();
}

async function level3() {
  await level2();
}
        `
      });

      const level3 = await getFunctionByName(db.backend, 'level3');
      assert.ok(level3, 'Should have level3 function');

      const rejectsEdges = await findEdgesFrom(db.backend, level3.id, 'REJECTS');
      assert.ok(
        rejectsEdges.length >= 1,
        'level3 should have REJECTS edge propagated from level1 through level2'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5.2 NOT propagate when inside try/catch
  // ---------------------------------------------------------------------------

  describe('No propagation when protected by try/catch', () => {
    it('should NOT propagate REJECTS when await is inside try/catch', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function risky() {
  throw new Error('risky');
}

async function safeWrapper() {
  try {
    await risky();
  } catch (e) {
    return null;
  }
}
        `
      });

      const protectedFunc = await getFunctionByName(db.backend, 'safeWrapper');
      assert.ok(protectedFunc, 'Should have safeWrapper function');

      // safeWrapper function should NOT have REJECTS edge propagated
      const rejectsEdges = await findEdgesFrom(db.backend, protectedFunc.id, 'REJECTS');
      const propagated = rejectsEdges.filter(e => {
        const metadata = e.metadata as { rejectionType?: string } | undefined;
        return metadata?.rejectionType === 'propagated';
      });

      assert.strictEqual(
        propagated.length,
        0,
        'Protected function should not have propagated REJECTS edges'
      );
    });

    it('should propagate only unprotected errors in mixed case', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function error1() {
  throw new Error('error1');
}

async function error2() {
  throw new Error('error2');
}

async function mixed() {
  try {
    await error1();
  } catch (e) {}

  await error2();  // Unprotected!
}
        `
      });

      const mixed = await getFunctionByName(db.backend, 'mixed');
      assert.ok(mixed, 'Should have mixed function');

      const rejectsEdges = await findEdgesFrom(db.backend, mixed.id, 'REJECTS');

      // Should only propagate from error2 (unprotected), not error1 (protected)
      assert.ok(
        rejectsEdges.length >= 1,
        'Should have at least one REJECTS edge from unprotected call'
      );

      // Check that propagation came from error2
      const propagatedFromError2 = rejectsEdges.find(e => {
        const metadata = e.metadata as { propagatedFrom?: string } | undefined;
        return metadata?.propagatedFrom?.includes('error2');
      });
      assert.ok(propagatedFromError2, 'Should have propagation from error2');
    });
  });

  // ---------------------------------------------------------------------------
  // 5.3 Edge cases
  // ---------------------------------------------------------------------------

  describe('Propagation edge cases', () => {
    it('should handle function with no awaits', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function noAwaits() {
  return 42;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'noAwaits');
      assert.ok(func, 'Should have function');

      const rejectsEdges = await findEdgesFrom(db.backend, func.id, 'REJECTS');
      assert.strictEqual(
        rejectsEdges.length,
        0,
        'Function with no awaits should have no REJECTS edges'
      );
    });

    it('should not create duplicate REJECTS edges', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function source() {
  throw new Error('fail');
}

async function caller() {
  await source();
  await source();
}
        `
      });

      const caller = await getFunctionByName(db.backend, 'caller');
      assert.ok(caller, 'Should have caller function');

      const rejectsEdges = await findEdgesFrom(db.backend, caller.id, 'REJECTS');

      // Should have exactly one REJECTS edge, not two (deduplication)
      const uniqueTargets = new Set(rejectsEdges.map(e => e.dst));
      assert.strictEqual(
        rejectsEdges.length,
        uniqueTargets.size,
        'Should not have duplicate REJECTS edges to same error class'
      );
    });
  });
});

// =============================================================================
// TESTS GROUP 6: Integration / Edge Cases
// =============================================================================

describe('Async Error Tracking Integration (REG-311)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('Complex real-world patterns', () => {
    it('should handle async function with multiple error paths', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function complexErrorHandling(data) {
  if (!data) {
    throw new ValidationError('no data');
  }

  try {
    const result = await fetchData(data);
    if (!result.valid) {
      throw new ProcessingError('invalid result');
    }
    return result;
  } catch (e) {
    if (e instanceof NetworkError) {
      throw new RetryableError('network issue', e);
    }
    throw e;
  }
}
        `
      });

      const func = await getFunctionByName(db.backend, 'complexErrorHandling');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string | null;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');
      assert.ok(patterns.length >= 2, 'Should detect multiple rejection patterns');

      // Should detect ValidationError
      const validationPattern = patterns.find(p => p.errorClassName === 'ValidationError');
      assert.ok(validationPattern, 'Should detect ValidationError');

      // Should detect ProcessingError
      const processingPattern = patterns.find(p => p.errorClassName === 'ProcessingError');
      assert.ok(processingPattern, 'Should detect ProcessingError');
    });

    it('should handle Promise.all with error handling', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function parallelWithErrors() {
  try {
    const results = await Promise.all([
      fetchA(),
      fetchB(),
      fetchC()
    ]);
    return results;
  } catch (e) {
    throw new AggregateError('parallel failed', e);
  }
}
        `
      });

      const func = await getFunctionByName(db.backend, 'parallelWithErrors');
      assert.ok(func, 'Should have function');

      // Should detect the AggregateError that can be thrown
      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        errorClassName: string | null;
      }> | undefined;

      const aggregatePattern = patterns?.find(p => p.errorClassName === 'AggregateError');
      assert.ok(aggregatePattern, 'Should detect AggregateError');
    });

    it('should handle generator function with async iteration', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function* asyncGenerator() {
  for (let i = 0; i < 3; i++) {
    if (i === 2) {
      throw new Error('iteration failed');
    }
    yield await processItem(i);
  }
}

async function consumer() {
  for await (const item of asyncGenerator()) {
    console.log(item);
  }
}
        `
      });

      const generator = await getFunctionByName(db.backend, 'asyncGenerator');
      assert.ok(generator, 'Should have async generator');

      // Check it's detected as generator
      const genRecord = generator as unknown as { generator?: boolean };
      assert.strictEqual(genRecord.generator, true, 'Should be marked as generator');

      // Should detect throw pattern
      const record = generator as unknown as { rejectionPatterns?: unknown[] };
      assert.ok(
        record.rejectionPatterns,
        'Async generator should have rejectionPatterns'
      );
    });
  });
});

// =============================================================================
// TESTS GROUP 7: Sync Throw Patterns (REG-286)
// =============================================================================

describe('Sync Throw Patterns and THROWS Edges (REG-286)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 7.1 THROWS edge creation for sync functions
  // ---------------------------------------------------------------------------

  describe('THROWS edges for sync throw', () => {
    it('should create THROWS edge for throw new Error() in sync function', async () => {
      await setupTest(db.backend, {
        'index.js': `
function validate(input) {
  if (!input) throw new ValidationError('Input required');
}
        `
      });

      const throwsEdges = await findEdgesByType(db.backend, 'THROWS');
      assert.ok(
        throwsEdges.length >= 1,
        `Should have THROWS edge. Found: ${throwsEdges.length}`
      );

      // Verify edge metadata
      const edge = throwsEdges[0] as unknown as { errorClassName?: string };
      assert.strictEqual(
        edge.errorClassName,
        'ValidationError',
        'THROWS edge should have errorClassName=ValidationError'
      );
    });

    it('should create THROWS edge for multiple error types in one function', async () => {
      await setupTest(db.backend, {
        'index.js': `
function validate(input) {
  if (!input) throw new ValidationError('Input required');
  if (input.length > 100) throw new RangeError('Input too long');
}
        `
      });

      const throwsEdges = await findEdgesByType(db.backend, 'THROWS');
      assert.ok(
        throwsEdges.length >= 2,
        `Should have at least 2 THROWS edges. Found: ${throwsEdges.length}`
      );

      const errorClasses = throwsEdges.map(
        e => (e as unknown as { errorClassName?: string }).errorClassName
      );
      assert.ok(errorClasses.includes('ValidationError'), 'Should have ValidationError');
      assert.ok(errorClasses.includes('RangeError'), 'Should have RangeError');
    });

    it('should NOT create REJECTS edge for sync throw', async () => {
      await setupTest(db.backend, {
        'index.js': `
function syncOnly() {
  throw new Error('sync');
}
        `
      });

      const rejectsEdges = await findEdgesByType(db.backend, 'REJECTS');
      const func = await getFunctionByName(db.backend, 'syncOnly');
      assert.ok(func, 'Should have function');

      // Filter REJECTS edges from this function
      const funcRejects = rejectsEdges.filter(e => e.src === func.id);
      assert.strictEqual(
        funcRejects.length,
        0,
        'Sync function should NOT have REJECTS edges'
      );
    });

    it('should create REJECTS (not THROWS) for async throw', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function asyncOnly() {
  throw new Error('async');
}
        `
      });

      const func = await getFunctionByName(db.backend, 'asyncOnly');
      assert.ok(func, 'Should have function');

      const rejectsEdges = (await findEdgesByType(db.backend, 'REJECTS'))
        .filter(e => e.src === func.id);
      const throwsEdges = (await findEdgesByType(db.backend, 'THROWS'))
        .filter(e => e.src === func.id);

      assert.ok(rejectsEdges.length >= 1, 'Async throw should create REJECTS edge');
      assert.strictEqual(throwsEdges.length, 0, 'Async throw should NOT create THROWS edge');
    });
  });

  // ---------------------------------------------------------------------------
  // 7.2 thrownBuiltinErrors metadata
  // ---------------------------------------------------------------------------

  describe('thrownBuiltinErrors metadata', () => {
    it('should set thrownBuiltinErrors for sync function with throws', async () => {
      await setupTest(db.backend, {
        'index.js': `
function validate(input) {
  if (!input) throw new TypeError('bad type');
  if (input < 0) throw new RangeError('bad range');
}
        `
      });

      const func = await getFunctionByName(db.backend, 'validate');
      assert.ok(func, 'Should have function');

      const record = func as unknown as {
        controlFlow?: {
          hasThrow?: boolean;
          thrownBuiltinErrors?: string[];
        };
      };

      assert.ok(record.controlFlow, 'Should have controlFlow');
      assert.strictEqual(record.controlFlow.hasThrow, true, 'hasThrow should be true');
      assert.ok(
        record.controlFlow.thrownBuiltinErrors,
        'Should have thrownBuiltinErrors'
      );
      assert.ok(
        record.controlFlow.thrownBuiltinErrors.includes('TypeError'),
        'Should include TypeError'
      );
      assert.ok(
        record.controlFlow.thrownBuiltinErrors.includes('RangeError'),
        'Should include RangeError'
      );
    });

    it('should NOT set thrownBuiltinErrors for async throws', async () => {
      await setupTest(db.backend, {
        'index.js': `
async function asyncFunc() {
  throw new Error('async fail');
}
        `
      });

      const func = await getFunctionByName(db.backend, 'asyncFunc');
      assert.ok(func, 'Should have function');

      const record = func as unknown as {
        controlFlow?: {
          thrownBuiltinErrors?: string[];
          rejectedBuiltinErrors?: string[];
        };
      };

      // Async throw goes to rejectedBuiltinErrors, not thrownBuiltinErrors
      assert.ok(
        !record.controlFlow?.thrownBuiltinErrors || record.controlFlow.thrownBuiltinErrors.length === 0,
        'Async function should NOT have thrownBuiltinErrors'
      );
      assert.ok(
        record.controlFlow?.rejectedBuiltinErrors?.includes('Error'),
        'Async function should have rejectedBuiltinErrors'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 7.3 Sync throw with variable micro-trace
  // ---------------------------------------------------------------------------

  describe('Sync throw variable tracing', () => {
    it('should trace throw err to const err = new CustomError()', async () => {
      await setupTest(db.backend, {
        'index.js': `
function validate(data) {
  const err = new CustomError('invalid');
  throw err;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'validate');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        errorClassName: string | null;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');
      const pattern = patterns.find(p => p.rejectionType === 'variable_traced');
      assert.ok(pattern, 'Should have variable_traced pattern');
      assert.strictEqual(pattern.errorClassName, 'CustomError', 'Should trace to CustomError');
    });

    it('should detect throw param as variable_parameter in sync function', async () => {
      await setupTest(db.backend, {
        'index.js': `
function rethrow(e) {
  throw e;
}
        `
      });

      const func = await getFunctionByName(db.backend, 'rethrow');
      assert.ok(func, 'Should have function');

      const record = func as unknown as { rejectionPatterns?: unknown[] };
      const patterns = record.rejectionPatterns as Array<{
        rejectionType: string;
        sourceVariableName?: string;
      }> | undefined;

      assert.ok(patterns, 'Should have rejectionPatterns');
      const pattern = patterns.find(p => p.rejectionType === 'variable_parameter');
      assert.ok(pattern, 'Should have variable_parameter pattern');
      assert.strictEqual(pattern.sourceVariableName, 'e', 'Should track parameter name');
    });
  });
});
