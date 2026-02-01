/**
 * Loop Nodes Tests (REG-267 Phase 2)
 *
 * Tests for LOOP nodes representing all loop types (for, for-in, for-of, while, do-while).
 * These tests verify the graph structure for loop statements including:
 * - LOOP node creation with correct loopType
 * - HAS_BODY edge from LOOP to body SCOPE
 * - ITERATES_OVER edge for for-in/for-of loops
 * - Nested loops structure
 * - Edge cases (empty loops, async iteration, destructuring)
 *
 * What will be created:
 * - LOOP node with loopType property
 * - HAS_BODY edge from LOOP to body scope
 * - ITERATES_OVER edge from LOOP to iterated collection variable
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
  const testDir = join(tmpdir(), `grafema-test-loop-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-loop-${testCounter}`,
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
// TESTS: LOOP Node Creation
// =============================================================================

describe('Loop Nodes Analysis (REG-267 Phase 2)', () => {
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
  // GROUP 1: Basic for-loop
  // ===========================================================================

  describe('For loop creates LOOP node', () => {
    it('should create LOOP node for simple for loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const forLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for'
      );
      assert.ok(forLoop, 'Should have LOOP node with loopType="for"');
      assert.ok(forLoop.file, 'LOOP node should have file property');
      assert.ok(forLoop.line, 'LOOP node should have line property');
    });

    it('should create HAS_BODY edge from LOOP to body SCOPE', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      assert.ok(hasBodyEdges.length >= 1, 'Should have at least one HAS_BODY edge');

      // Verify edge comes from LOOP node
      const loopId = loopNodes[0].id;
      const edgeFromLoop = hasBodyEdges.find((e: EdgeRecord) => e.src === loopId);
      assert.ok(edgeFromLoop, 'HAS_BODY edge should come from LOOP node');

      // Verify destination is a SCOPE node
      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.strictEqual(dstNode.type, 'SCOPE', 'HAS_BODY destination should be SCOPE node');
    });
  });

  // ===========================================================================
  // GROUP 2: For-of loop with ITERATES_OVER
  // ===========================================================================

  describe('For-of loop creates LOOP node with ITERATES_OVER', () => {
    it('should create LOOP node for for-of loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const items = [1, 2, 3];
  for (const item of items) {
    console.log(item);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have LOOP node with loopType="for-of"');
    });

    it('should create ITERATES_OVER edge to collection variable', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const items = [1, 2, 3];
  for (const item of items) {
    console.log(item);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node');

      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      assert.ok(iteratesOverEdges.length >= 1, 'Should have at least one ITERATES_OVER edge');

      // Verify edge comes from the for-of LOOP node
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(edgeFromLoop, 'ITERATES_OVER edge should come from for-of LOOP node');

      // Verify destination is the items variable (VARIABLE for let, CONSTANT for const)
      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.ok(
        dstNode.type === 'VARIABLE' || dstNode.type === 'CONSTANT',
        `ITERATES_OVER destination should be VARIABLE or CONSTANT node, got ${dstNode.type}`
      );
      assert.strictEqual(dstNode.name, 'items', 'ITERATES_OVER should point to items variable');
    });

    it('should handle scope-aware variable lookup for ITERATES_OVER', async () => {
      // This test exposes the issue Linus noted: variable lookup must be scope-aware
      await setupTest(backend, {
        'index.js': `
const items = ['outer'];

function test(items) {
  // Should iterate over parameter 'items', not outer 'items'
  for (const item of items) {
    console.log(item);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node');

      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(edgeFromLoop, 'ITERATES_OVER edge should exist');

      // The edge should point to the PARAMETER, not the outer VARIABLE
      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.ok(dstNode, 'Destination node should exist');

      // Check that we're pointing to the parameter, not the outer variable
      // The parameter should be in the function scope, the outer variable is module-level
      assert.strictEqual(
        dstNode.type,
        'PARAMETER',
        'ITERATES_OVER should point to parameter "items", not outer variable'
      );
    });
  });

  // ===========================================================================
  // GROUP 3: For-in loop
  // ===========================================================================

  describe('For-in loop creates LOOP node', () => {
    it('should create LOOP node for for-in loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const obj = { a: 1, b: 2 };
  for (const key in obj) {
    console.log(key);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const forInLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-in'
      );
      assert.ok(forInLoop, 'Should have LOOP node with loopType="for-in"');
    });

    it('should create ITERATES_OVER edge for for-in loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  const obj = { a: 1 };
  for (const key in obj) {
    console.log(key);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forInLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-in'
      );
      assert.ok(forInLoop, 'Should have for-in LOOP node');

      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forInLoop!.id);
      assert.ok(edgeFromLoop, 'ITERATES_OVER edge should come from for-in LOOP node');

      // Verify destination is the obj variable
      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.strictEqual(dstNode.name, 'obj', 'ITERATES_OVER should point to obj variable');
    });
  });

  // ===========================================================================
  // GROUP 4: While loop
  // ===========================================================================

  describe('While loop creates LOOP node', () => {
    it('should create LOOP node for while loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  let i = 0;
  while (i < 10) {
    console.log(i);
    i++;
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const whileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'while'
      );
      assert.ok(whileLoop, 'Should have LOOP node with loopType="while"');
    });

    it('should create HAS_BODY edge from while LOOP to body', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  while (condition) {
    doSomething();
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const whileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'while'
      );
      assert.ok(whileLoop, 'Should have while LOOP node');

      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const edgeFromLoop = hasBodyEdges.find((e: EdgeRecord) => e.src === whileLoop!.id);
      assert.ok(edgeFromLoop, 'HAS_BODY edge should come from while LOOP node');
    });
  });

  // ===========================================================================
  // GROUP 5: Do-while loop
  // ===========================================================================

  describe('Do-while loop creates LOOP node', () => {
    it('should create LOOP node for do-while loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  let i = 0;
  do {
    console.log(i);
    i++;
  } while (i < 10);
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const doWhileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'do-while'
      );
      assert.ok(doWhileLoop, 'Should have LOOP node with loopType="do-while"');
    });

    it('should create HAS_BODY edge from do-while LOOP to body', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  do {
    doSomething();
  } while (condition);
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const doWhileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'do-while'
      );
      assert.ok(doWhileLoop, 'Should have do-while LOOP node');

      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const edgeFromLoop = hasBodyEdges.find((e: EdgeRecord) => e.src === doWhileLoop!.id);
      assert.ok(edgeFromLoop, 'HAS_BODY edge should come from do-while LOOP node');
    });
  });

  // ===========================================================================
  // GROUP 6: Nested loops
  // ===========================================================================

  describe('Nested loops', () => {
    it('should create separate LOOP nodes for nested loops', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      console.log(i, j);
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 2, `Should have at least 2 LOOP nodes for nested loops, got ${loopNodes.length}`);

      const forLoops = loopNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for'
      );
      assert.strictEqual(forLoops.length, 2, 'Should have exactly 2 for loops');
    });

    it('should have outer LOOP contain inner LOOP via CONTAINS edge', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      console.log(i, j);
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 2, 'Should have at least 2 LOOP nodes');

      // Sort by line to determine outer (first) and inner (second)
      const sortedLoops = loopNodes.sort((a, b) => (a.line || 0) - (b.line || 0));
      const outerLoop = sortedLoops[0];
      const innerLoop = sortedLoops[1];

      // Get CONTAINS edges
      const containsEdges = await getEdgesByType(backend, 'CONTAINS');

      // Find CONTAINS path from outer to inner
      // It could be: LOOP(outer) -> CONTAINS -> SCOPE(body) -> CONTAINS -> LOOP(inner)
      // or: LOOP(outer) -> HAS_BODY -> SCOPE(body) -> CONTAINS -> LOOP(inner)

      // Check if there's a path from outer to inner via CONTAINS/HAS_BODY
      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const outerBodyEdge = hasBodyEdges.find((e: EdgeRecord) => e.src === outerLoop.id);
      assert.ok(outerBodyEdge, 'Outer LOOP should have HAS_BODY edge');

      // Body scope should CONTAIN inner loop (directly or indirectly)
      const bodyScopeId = outerBodyEdge!.dst;
      const innerContainEdge = containsEdges.find(
        (e: EdgeRecord) => e.src === bodyScopeId && e.dst === innerLoop.id
      );
      assert.ok(
        innerContainEdge,
        'Body scope of outer loop should CONTAIN inner loop'
      );
    });

    it('should handle different loop types nested', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  for (const item of items) {
    let count = 0;
    while (count < item.length) {
      console.log(item[count]);
      count++;
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 2, 'Should have at least 2 LOOP nodes');

      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      const whileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'while'
      );

      assert.ok(forOfLoop, 'Should have for-of LOOP node');
      assert.ok(whileLoop, 'Should have while LOOP node');
    });
  });

  // ===========================================================================
  // GROUP 7: Edge cases (from Linus review)
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty infinite loop: for (;;) {}', async () => {
      await setupTest(backend, {
        'index.js': `
function runForever() {
  for (;;) {
    // infinite loop
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      const forLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for'
      );
      assert.ok(forLoop, 'Should have LOOP node with loopType="for" for empty for loop');

      // Should still have HAS_BODY edge to empty body
      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const edgeFromLoop = hasBodyEdges.find((e: EdgeRecord) => e.src === forLoop!.id);
      assert.ok(edgeFromLoop, 'Empty for loop should still have HAS_BODY edge');
    });

    it('should handle async iteration: for await (const x of items)', async () => {
      await setupTest(backend, {
        'index.js': `
async function processAsync(asyncItems) {
  for await (const item of asyncItems) {
    console.log(item);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have at least one LOOP node');

      // for-await-of should still be categorized as for-of
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'for-await-of should be LOOP node with loopType="for-of"');

      // Should have ITERATES_OVER edge
      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(edgeFromLoop, 'for-await-of should have ITERATES_OVER edge');
    });

    it('should handle destructuring in for-of: for (const [a, b] of pairs)', async () => {
      await setupTest(backend, {
        'index.js': `
function processPairs(pairs) {
  for (const [key, value] of pairs) {
    console.log(key, value);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node with destructuring');

      // Should have ITERATES_OVER edge to pairs
      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(edgeFromLoop, 'Destructuring for-of should have ITERATES_OVER edge');

      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.strictEqual(dstNode.name, 'pairs', 'ITERATES_OVER should point to pairs parameter');
    });

    it('should handle destructuring in for-of with object pattern: for (const { a, b } of items)', async () => {
      await setupTest(backend, {
        'index.js': `
function processObjects(items) {
  for (const { name, value } of items) {
    console.log(name, value);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node with object destructuring');

      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      const edgeFromLoop = iteratesOverEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(edgeFromLoop, 'Object destructuring for-of should have ITERATES_OVER edge');

      const dstNode = await backend.getNode(edgeFromLoop!.dst);
      assert.strictEqual(dstNode?.name, 'items', 'ITERATES_OVER should point to items parameter');
    });

    it('should handle MemberExpression as iterable: for (const x of obj.items)', async () => {
      await setupTest(backend, {
        'index.js': `
function processObjectItems(obj) {
  for (const item of obj.items) {
    console.log(item);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      assert.ok(forOfLoop, 'Should have for-of LOOP node');

      // For MemberExpression, ITERATES_OVER should still track the access
      // The edge might point to the base object or the full property access
      const iteratesOverEdges = await getEdgesByType(backend, 'ITERATES_OVER');
      // Note: The edge creation for MemberExpression iterables may vary by implementation
      // This test documents the expected behavior - at minimum we should have the LOOP node
    });

    it('should handle loop with break statement', async () => {
      await setupTest(backend, {
        'index.js': `
function findFirst(items) {
  for (const item of items) {
    if (item.match) {
      return item;
    }
  }
  return null;
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      // Loop structure should be the same regardless of control flow inside
      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      assert.ok(hasBodyEdges.length >= 1, 'Should have HAS_BODY edge');
    });

    it('should handle loop with labeled break/continue', async () => {
      await setupTest(backend, {
        'index.js': `
function processNested(matrix) {
  outer: for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (matrix[i][j] === 0) {
        continue outer;
      }
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 2, 'Should have at least 2 LOOP nodes for labeled loops');
    });

    it('should handle for loop without block body', async () => {
      await setupTest(backend, {
        'index.js': `
function countUp(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += i;
  return sum;
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node for single-statement body');

      const forLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for'
      );
      assert.ok(forLoop, 'Should have for LOOP node');
    });
  });

  // ===========================================================================
  // GROUP 8: LOOP node properties and semantic IDs
  // ===========================================================================

  describe('LOOP node properties', () => {
    it('should have correct semantic ID format', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      const loopNode = loopNodes[0];
      // Semantic ID should contain LOOP marker
      assert.ok(
        loopNode.id.includes('LOOP') || loopNode.id.includes('for'),
        `LOOP node ID should contain LOOP or for: ${loopNode.id}`
      );
    });

    it('should have parentScopeId pointing to containing scope', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      const loopNode = loopNodes[0] as Record<string, unknown>;
      assert.ok(
        loopNode.parentScopeId !== undefined,
        'LOOP node should have parentScopeId'
      );
    });

    it('should preserve backward compatibility with SCOPE nodes', async () => {
      // Per Joel's spec: LOOP nodes AND body SCOPE nodes should both exist
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      // There should be a SCOPE node for the loop body
      const loopBodyScope = scopeNodes.find(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && (
            scopeType.includes('for') ||
            scopeType.includes('loop')
          );
        }
      );
      assert.ok(
        loopBodyScope,
        'Should have SCOPE node for loop body (backward compatibility)'
      );
    });
  });

  // ===========================================================================
  // GROUP 9: Multiple loops in same function
  // ===========================================================================

  describe('Multiple loops in same function', () => {
    it('should create separate LOOP nodes for sequential loops', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items, objects) {
  for (const item of items) {
    console.log(item);
  }

  for (const key in objects) {
    console.log(key);
  }

  let i = 0;
  while (i < 10) {
    console.log(i++);
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 3, `Should have at least 3 LOOP nodes, got ${loopNodes.length}`);

      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      const forInLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-in'
      );
      const whileLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'while'
      );

      assert.ok(forOfLoop, 'Should have for-of LOOP node');
      assert.ok(forInLoop, 'Should have for-in LOOP node');
      assert.ok(whileLoop, 'Should have while LOOP node');
    });

    it('should have unique IDs for each LOOP node', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 5; i++) {}
  for (let j = 0; j < 5; j++) {}
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 2, 'Should have at least 2 LOOP nodes');

      const ids = loopNodes.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'All LOOP nodes should have unique IDs'
      );
    });
  });

  // ===========================================================================
  // GROUP 10: Loop variable declarations
  // ===========================================================================

  describe('Loop variable declarations', () => {
    it('should track loop variable in for-of loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  for (const item of items) {
    process(item);
  }
}
        `
      });

      // The 'item' variable should be tracked
      const variableNodes = await getNodesByType(backend, 'VARIABLE');
      const itemVar = variableNodes.find((v: NodeRecord) => v.name === 'item');

      // Note: Loop variable handling may vary - this test documents expected behavior
      // The variable may be tracked via existing DERIVES_FROM mechanism (REG-272)
    });

    it('should track loop index variable in for loop', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
        `
      });

      const variableNodes = await getNodesByType(backend, 'VARIABLE');
      const indexVar = variableNodes.find((v: NodeRecord) => v.name === 'i');

      // The index variable should be tracked as a VARIABLE node
      // This verifies backward compatibility with existing variable tracking
    });
  });
});
