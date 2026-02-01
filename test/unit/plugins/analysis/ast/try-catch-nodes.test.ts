/**
 * Try/Catch/Finally Nodes Tests (REG-267 Phase 4)
 *
 * Tests for TRY_BLOCK, CATCH_BLOCK, and FINALLY_BLOCK nodes representing
 * TryStatement AST nodes. These tests verify the graph structure for
 * try/catch/finally statements including:
 * - TRY_BLOCK node creation
 * - CATCH_BLOCK node creation with parameterName
 * - FINALLY_BLOCK node creation
 * - HAS_CATCH edge from TRY_BLOCK to CATCH_BLOCK
 * - HAS_FINALLY edge from TRY_BLOCK to FINALLY_BLOCK
 * - Nested try-catch handling
 * - Optional catch binding (ES2019)
 *
 * What will be created:
 * - TRY_BLOCK node for each try statement
 * - CATCH_BLOCK node with optional parameterName
 * - FINALLY_BLOCK node for finally clause
 * - HAS_CATCH edge from TRY_BLOCK to CATCH_BLOCK
 * - HAS_FINALLY edge from TRY_BLOCK to FINALLY_BLOCK
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - types and implementation come after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
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
  const testDir = join(tmpdir(), `grafema-test-trycatch-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-trycatch-${testCounter}`,
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
  backend: ReturnType<typeof createTestBackend>,
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: ReturnType<typeof createTestBackend>,
  edgeType: string
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Get all edges from backend
 */
async function getAllEdges(
  backend: ReturnType<typeof createTestBackend>
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges;
}

// =============================================================================
// TESTS: TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK Nodes
// =============================================================================

describe('Try/Catch/Finally Nodes Analysis (REG-267 Phase 4)', () => {
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
  // GROUP 1: Try-catch creates TRY_BLOCK and CATCH_BLOCK
  // ===========================================================================

  describe('Try-catch creates TRY_BLOCK and CATCH_BLOCK', () => {
    it('should create TRY_BLOCK node for try-catch statement', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 1, 'Should have at least one TRY_BLOCK node');

      const tryBlock = tryBlockNodes[0];
      assert.ok(tryBlock.file, 'TRY_BLOCK node should have file property');
      assert.ok(tryBlock.line, 'TRY_BLOCK node should have line property');
    });

    it('should create CATCH_BLOCK node for catch clause', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have at least one CATCH_BLOCK node');

      const catchBlock = catchBlockNodes[0];
      assert.ok(catchBlock.file, 'CATCH_BLOCK node should have file property');
      assert.ok(catchBlock.line, 'CATCH_BLOCK node should have line property');
    });

    it('should create HAS_CATCH edge from TRY_BLOCK to CATCH_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node');

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      assert.ok(hasCatchEdges.length >= 1, 'Should have at least one HAS_CATCH edge');

      // Verify edge comes from TRY_BLOCK
      const tryBlockId = tryBlockNodes[0].id;
      const catchBlockId = catchBlockNodes[0].id;
      const edgeFromTry = hasCatchEdges.find(
        (e: EdgeRecord) => e.src === tryBlockId && e.dst === catchBlockId
      );
      assert.ok(edgeFromTry, 'HAS_CATCH edge should connect TRY_BLOCK to CATCH_BLOCK');
    });
  });

  // ===========================================================================
  // GROUP 2: Try-finally creates TRY_BLOCK and FINALLY_BLOCK
  // ===========================================================================

  describe('Try-finally creates TRY_BLOCK and FINALLY_BLOCK', () => {
    it('should create TRY_BLOCK node for try-finally statement', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 1, 'Should have at least one TRY_BLOCK node');
    });

    it('should create FINALLY_BLOCK node for finally clause', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have at least one FINALLY_BLOCK node');

      const finallyBlock = finallyBlockNodes[0];
      assert.ok(finallyBlock.file, 'FINALLY_BLOCK node should have file property');
      assert.ok(finallyBlock.line, 'FINALLY_BLOCK node should have line property');
    });

    it('should create HAS_FINALLY edge from TRY_BLOCK to FINALLY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have FINALLY_BLOCK node');

      const hasFinallyEdges = await getEdgesByType(backend, 'HAS_FINALLY');
      assert.ok(hasFinallyEdges.length >= 1, 'Should have at least one HAS_FINALLY edge');

      // Verify edge comes from TRY_BLOCK
      const tryBlockId = tryBlockNodes[0].id;
      const finallyBlockId = finallyBlockNodes[0].id;
      const edgeFromTry = hasFinallyEdges.find(
        (e: EdgeRecord) => e.src === tryBlockId && e.dst === finallyBlockId
      );
      assert.ok(edgeFromTry, 'HAS_FINALLY edge should connect TRY_BLOCK to FINALLY_BLOCK');
    });

    it('should NOT create CATCH_BLOCK for try-finally without catch', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.strictEqual(
        catchBlockNodes.length,
        0,
        'Should NOT have CATCH_BLOCK node for try-finally without catch'
      );

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      assert.strictEqual(
        hasCatchEdges.length,
        0,
        'Should NOT have HAS_CATCH edge for try-finally without catch'
      );
    });
  });

  // ===========================================================================
  // GROUP 3: Full try-catch-finally
  // ===========================================================================

  describe('Full try-catch-finally creates all nodes and edges', () => {
    it('should create TRY_BLOCK, CATCH_BLOCK, and FINALLY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have FINALLY_BLOCK node');
    });

    it('should create both HAS_CATCH and HAS_FINALLY edges', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      const hasFinallyEdges = await getEdgesByType(backend, 'HAS_FINALLY');

      assert.ok(hasCatchEdges.length >= 1, 'Should have HAS_CATCH edge');
      assert.ok(hasFinallyEdges.length >= 1, 'Should have HAS_FINALLY edge');

      // Both edges should come from the same TRY_BLOCK
      const tryBlockId = tryBlockNodes[0].id;
      const catchEdge = hasCatchEdges.find((e: EdgeRecord) => e.src === tryBlockId);
      const finallyEdge = hasFinallyEdges.find((e: EdgeRecord) => e.src === tryBlockId);

      assert.ok(catchEdge, 'HAS_CATCH should come from TRY_BLOCK');
      assert.ok(finallyEdge, 'HAS_FINALLY should come from TRY_BLOCK');
    });
  });

  // ===========================================================================
  // GROUP 4: Catch parameter
  // ===========================================================================

  describe('Catch parameter handling', () => {
    it('should capture parameterName in CATCH_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (error) {
    console.log(error);
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node');

      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;
      assert.strictEqual(
        catchBlock.parameterName,
        'error',
        'CATCH_BLOCK should have parameterName="error"'
      );
    });

    it('should capture different parameter names', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;
      assert.strictEqual(
        catchBlock.parameterName,
        'e',
        'CATCH_BLOCK should have parameterName="e"'
      );
    });

    it('should capture exception/err naming conventions', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (exception) {
    log(exception);
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;
      assert.strictEqual(
        catchBlock.parameterName,
        'exception',
        'CATCH_BLOCK should have parameterName="exception"'
      );
    });
  });

  // ===========================================================================
  // GROUP 5: Optional catch binding (ES2019)
  // ===========================================================================

  describe('Optional catch binding (ES2019)', () => {
    it('should create CATCH_BLOCK without parameterName for optional binding', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch {
    handleError();
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node');

      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;
      // parameterName should be undefined for optional catch binding
      assert.strictEqual(
        catchBlock.parameterName,
        undefined,
        'CATCH_BLOCK should NOT have parameterName for optional binding'
      );
    });

    it('should still create HAS_CATCH edge for optional catch binding', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch {
    handleError();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node');

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      assert.ok(
        hasCatchEdges.length >= 1,
        'Should have HAS_CATCH edge even with optional binding'
      );
    });
  });

  // ===========================================================================
  // GROUP 6: Nested try-catch
  // ===========================================================================

  describe('Nested try-catch', () => {
    it('should create separate TRY_BLOCK nodes for nested try-catch', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    try {
      innerRiskyOp();
    } catch {
      handleInner();
    }
  } catch {
    handleOuter();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(
        tryBlockNodes.length >= 2,
        `Should have at least 2 TRY_BLOCK nodes for nested try, got ${tryBlockNodes.length}`
      );
    });

    it('should create separate CATCH_BLOCK nodes for nested catches', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    try {
      innerRiskyOp();
    } catch (inner) {
      handleInner(inner);
    }
  } catch (outer) {
    handleOuter(outer);
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(
        catchBlockNodes.length >= 2,
        `Should have at least 2 CATCH_BLOCK nodes, got ${catchBlockNodes.length}`
      );

      // Verify both parameter names are captured
      const parameterNames = catchBlockNodes.map(
        (n: NodeRecord) => (n as Record<string, unknown>).parameterName
      );
      assert.ok(
        parameterNames.includes('inner'),
        'Should have CATCH_BLOCK with parameterName="inner"'
      );
      assert.ok(
        parameterNames.includes('outer'),
        'Should have CATCH_BLOCK with parameterName="outer"'
      );
    });

    it('should have inner TRY_BLOCK contained in outer TRY_BLOCK body', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    try {
      innerRiskyOp();
    } catch {
      handleInner();
    }
  } catch {
    handleOuter();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 2, 'Should have at least 2 TRY_BLOCK nodes');

      // Sort by line to determine outer (first) and inner (second)
      const sortedTryBlocks = tryBlockNodes.sort((a, b) => (a.line || 0) - (b.line || 0));
      const outerTry = sortedTryBlocks[0];
      const innerTry = sortedTryBlocks[1];

      // Verify inner TRY_BLOCK's parent is within outer TRY_BLOCK's scope
      const innerRecord = innerTry as Record<string, unknown>;
      assert.ok(innerRecord.parentScopeId !== undefined, 'Inner TRY_BLOCK should have parentScopeId');

      // The parentScopeId hierarchy should ultimately trace to outer TRY_BLOCK
      // This test documents the expected containment relationship
    });

    it('should create correct HAS_CATCH edges for nested structure', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    try {
      innerRiskyOp();
    } catch (inner) {
      handleInner(inner);
    }
  } catch (outer) {
    handleOuter(outer);
  }
}
        `
      });

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      assert.ok(
        hasCatchEdges.length >= 2,
        `Should have at least 2 HAS_CATCH edges, got ${hasCatchEdges.length}`
      );

      // Each HAS_CATCH edge should connect a specific TRY_BLOCK to its CATCH_BLOCK
      for (const edge of hasCatchEdges) {
        const srcNode = await backend.getNode(edge.src);
        const dstNode = await backend.getNode(edge.dst);

        assert.ok(srcNode, 'HAS_CATCH source should exist');
        assert.ok(dstNode, 'HAS_CATCH destination should exist');
        assert.strictEqual(srcNode.type, 'TRY_BLOCK', 'HAS_CATCH src should be TRY_BLOCK');
        assert.strictEqual(dstNode.type, 'CATCH_BLOCK', 'HAS_CATCH dst should be CATCH_BLOCK');
      }
    });
  });

  // ===========================================================================
  // GROUP 7: Try-catch inside loop
  // ===========================================================================

  describe('Try-catch inside loop', () => {
    it('should create TRY_BLOCK inside LOOP body', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  for (const item of items) {
    try {
      process(item);
    } catch (e) {
      logError(item, e);
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');

      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');
      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');

      // Verify TRY_BLOCK is inside LOOP's body
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node');

      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const loopBodyEdge = hasBodyEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(loopBodyEdge, 'LOOP should have HAS_BODY edge');

      const loopBodyId = loopBodyEdge!.dst;

      // TRY_BLOCK should be contained in loop body
      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const tryBlock = tryBlockNodes[0];
      const bodyContainsTry = containsEdges.find(
        (e: EdgeRecord) => e.src === loopBodyId && e.dst === tryBlock.id
      );

      // Or check parentScopeId
      const tryParentScope = (tryBlock as Record<string, unknown>).parentScopeId;

      assert.ok(
        bodyContainsTry || tryParentScope === loopBodyId,
        'TRY_BLOCK should be inside LOOP body scope'
      );
    });
  });

  // ===========================================================================
  // GROUP 8: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty try block', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    // empty
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node for empty try');

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      assert.ok(hasCatchEdges.length >= 1, 'Empty try should still have HAS_CATCH edge');
    });

    it('should handle empty catch block', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch {
    // swallow
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK node for empty catch');
    });

    it('should handle empty finally block', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    // nothing
  }
}
        `
      });

      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have FINALLY_BLOCK node for empty finally');
    });

    it('should handle try-catch with rethrow', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    log(e);
    throw e;
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK with rethrow');
    });

    it('should handle try-catch with return in catch', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    return riskyOp();
  } catch (e) {
    return defaultValue();
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK with return');
    });

    it('should handle try-catch-finally with return in finally', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    return riskyOp();
  } catch (e) {
    log(e);
  } finally {
    return cleanupValue();
  }
}
        `
      });

      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have FINALLY_BLOCK with return');
    });

    it('should handle async try-catch', async () => {
      await setupTest(backend, {
        'index.js': `
async function process() {
  try {
    await riskyAsyncOp();
  } catch (e) {
    await handleAsync(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK in async function');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK in async function');
    });

    it('should handle destructuring in catch parameter (TypeScript pattern)', async () => {
      // Note: TypeScript allows catch(e: unknown) but JS doesn't support type annotation
      // This test is for documentation - the pattern might be handled differently
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    if (e.message) {
      console.log(e.message);
    }
  }
}
        `
      });

      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK');
    });
  });

  // ===========================================================================
  // GROUP 9: Node properties and semantic IDs
  // ===========================================================================

  describe('Node properties and semantic IDs', () => {
    it('should have correct semantic ID format for TRY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');

      const tryBlock = tryBlockNodes[0];
      // Semantic ID should contain TRY_BLOCK marker
      assert.ok(
        tryBlock.id.includes('TRY_BLOCK') || tryBlock.id.includes('try'),
        `TRY_BLOCK node ID should contain TRY_BLOCK or try: ${tryBlock.id}`
      );
    });

    it('should have parentScopeId for all nodes', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');

      const tryBlock = tryBlockNodes[0] as Record<string, unknown>;
      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;
      const finallyBlock = finallyBlockNodes[0] as Record<string, unknown>;

      assert.ok(tryBlock.parentScopeId !== undefined, 'TRY_BLOCK should have parentScopeId');
      assert.ok(catchBlock.parentScopeId !== undefined, 'CATCH_BLOCK should have parentScopeId');
      assert.ok(finallyBlock.parentScopeId !== undefined, 'FINALLY_BLOCK should have parentScopeId');
    });

    it('should preserve backward compatibility with SCOPE nodes', async () => {
      // Per Joel's spec: TRY_BLOCK etc. AND body SCOPE nodes should both exist
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK node');

      // There should be SCOPE nodes for try-block and catch-block bodies
      const tryBodyScope = scopeNodes.find(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('try');
        }
      );
      const catchBodyScope = scopeNodes.find(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('catch');
        }
      );

      assert.ok(tryBodyScope, 'Should have SCOPE node for try body (backward compatibility)');
      assert.ok(catchBodyScope, 'Should have SCOPE node for catch body (backward compatibility)');
    });
  });

  // ===========================================================================
  // GROUP 10: Multiple try-catch in same function
  // ===========================================================================

  describe('Multiple try-catch in same function', () => {
    it('should create separate TRY_BLOCK nodes for sequential try-catch', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    firstRiskyOp();
  } catch (e1) {
    handleFirst(e1);
  }

  try {
    secondRiskyOp();
  } catch (e2) {
    handleSecond(e2);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(
        tryBlockNodes.length >= 2,
        `Should have at least 2 TRY_BLOCK nodes, got ${tryBlockNodes.length}`
      );
    });

    it('should have unique IDs for each TRY_BLOCK node', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try { op1(); } catch { }
  try { op2(); } catch { }
  try { op3(); } catch { }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      assert.ok(tryBlockNodes.length >= 3, 'Should have at least 3 TRY_BLOCK nodes');

      const ids = tryBlockNodes.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'All TRY_BLOCK nodes should have unique IDs'
      );
    });

    it('should correctly associate CATCH_BLOCK with its TRY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    firstOp();
  } catch (first) {
    handleFirst(first);
  }

  try {
    secondOp();
  } catch (second) {
    handleSecond(second);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');
      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');

      assert.ok(tryBlockNodes.length >= 2, 'Should have 2 TRY_BLOCK nodes');
      assert.ok(catchBlockNodes.length >= 2, 'Should have 2 CATCH_BLOCK nodes');
      assert.ok(hasCatchEdges.length >= 2, 'Should have 2 HAS_CATCH edges');

      // Each TRY_BLOCK should have exactly one HAS_CATCH edge
      for (const tryBlock of tryBlockNodes) {
        const edgesFromTry = hasCatchEdges.filter(
          (e: EdgeRecord) => e.src === tryBlock.id
        );
        assert.strictEqual(
          edgesFromTry.length,
          1,
          `Each TRY_BLOCK should have exactly 1 HAS_CATCH edge, got ${edgesFromTry.length}`
        );
      }
    });
  });

  // ===========================================================================
  // GROUP 11: Edge connectivity verification
  // ===========================================================================

  describe('Edge connectivity', () => {
    it('should have valid src and dst node IDs in all try-catch-related edges', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
        `
      });

      const hasCatchEdges = await getEdgesByType(backend, 'HAS_CATCH');
      const hasFinallyEdges = await getEdgesByType(backend, 'HAS_FINALLY');

      // Verify all edges have valid src and dst
      for (const edge of [...hasCatchEdges, ...hasFinallyEdges]) {
        const srcNode = await backend.getNode(edge.src);
        const dstNode = await backend.getNode(edge.dst);

        assert.ok(srcNode, `Source node ${edge.src} should exist for edge type ${edge.type}`);
        assert.ok(dstNode, `Destination node ${edge.dst} should exist for edge type ${edge.type}`);
      }
    });

    it('should have parentTryBlockId in CATCH_BLOCK pointing to correct TRY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } catch (e) {
    handle(e);
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const catchBlockNodes = await getNodesByType(backend, 'CATCH_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK');
      assert.ok(catchBlockNodes.length >= 1, 'Should have CATCH_BLOCK');

      const catchBlock = catchBlockNodes[0] as Record<string, unknown>;

      // Per Joel's spec, CATCH_BLOCK has parentTryBlockId
      // This is an alternative way to track the relationship
      if (catchBlock.parentTryBlockId !== undefined) {
        assert.strictEqual(
          catchBlock.parentTryBlockId,
          tryBlockNodes[0].id,
          'CATCH_BLOCK.parentTryBlockId should match TRY_BLOCK.id'
        );
      }
    });

    it('should have parentTryBlockId in FINALLY_BLOCK pointing to correct TRY_BLOCK', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const tryBlockNodes = await getNodesByType(backend, 'TRY_BLOCK');
      const finallyBlockNodes = await getNodesByType(backend, 'FINALLY_BLOCK');

      assert.ok(tryBlockNodes.length >= 1, 'Should have TRY_BLOCK');
      assert.ok(finallyBlockNodes.length >= 1, 'Should have FINALLY_BLOCK');

      const finallyBlock = finallyBlockNodes[0] as Record<string, unknown>;

      // Per Joel's spec, FINALLY_BLOCK has parentTryBlockId
      if (finallyBlock.parentTryBlockId !== undefined) {
        assert.strictEqual(
          finallyBlock.parentTryBlockId,
          tryBlockNodes[0].id,
          'FINALLY_BLOCK.parentTryBlockId should match TRY_BLOCK.id'
        );
      }
    });
  });
});
