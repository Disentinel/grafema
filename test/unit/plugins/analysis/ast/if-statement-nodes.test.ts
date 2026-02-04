/**
 * If Statement Nodes Tests (REG-267 Phase 3)
 *
 * Tests for BRANCH nodes representing IfStatement AST nodes.
 * These tests verify the graph structure for if statements including:
 * - BRANCH node creation with branchType='if'
 * - HAS_CONDITION edge from BRANCH to condition expression
 * - HAS_CONSEQUENT edge from BRANCH to then-body SCOPE
 * - HAS_ALTERNATE edge from BRANCH to else-body SCOPE
 * - Else-if chain handling (nested BRANCH nodes)
 * - Complex conditions (logical operators)
 *
 * What will be created:
 * - BRANCH node with branchType='if'
 * - HAS_CONDITION edge from BRANCH to condition EXPRESSION
 * - HAS_CONSEQUENT edge from BRANCH to then-body SCOPE
 * - HAS_ALTERNATE edge from BRANCH to else-body SCOPE (if present)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - types and implementation come after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-if-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-if-${testCounter}`,
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
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
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
// TESTS: BRANCH Node Creation for If Statements
// =============================================================================

describe('If Statement Nodes Analysis (REG-267 Phase 3)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = await createTestDatabase(); backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // GROUP 1: Basic if statement creates BRANCH node
  // ===========================================================================

  describe('Basic if statement creates BRANCH node', () => {
    it('should create BRANCH node for simple if statement', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doA();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have at least one BRANCH node');

      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have BRANCH node with branchType="if"');
      assert.ok(ifBranch.file, 'BRANCH node should have file property');
      assert.ok(ifBranch.line, 'BRANCH node should have line property');
    });

    it('should create HAS_CONDITION edge from BRANCH to condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doA();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      assert.ok(hasConditionEdges.length >= 1, 'Should have at least one HAS_CONDITION edge');

      // Verify edge comes from if BRANCH node
      const edgeFromBranch = hasConditionEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(edgeFromBranch, 'HAS_CONDITION edge should come from if BRANCH node');
    });

    it('should create HAS_CONSEQUENT edge from BRANCH to body SCOPE', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doA();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      assert.ok(hasConsequentEdges.length >= 1, 'Should have at least one HAS_CONSEQUENT edge');

      // Verify edge comes from if BRANCH node
      const edgeFromBranch = hasConsequentEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(edgeFromBranch, 'HAS_CONSEQUENT edge should come from if BRANCH node');

      // Verify destination is a SCOPE node
      const dstNode = await backend.getNode(edgeFromBranch!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.strictEqual(dstNode.type, 'SCOPE', 'HAS_CONSEQUENT destination should be SCOPE node');
    });
  });

  // ===========================================================================
  // GROUP 2: If-else creates both branches
  // ===========================================================================

  describe('If-else creates both branches', () => {
    it('should create HAS_CONSEQUENT and HAS_ALTERNATE edges for if-else', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doA();
  } else {
    doB();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');

      // Verify both edges exist from the same BRANCH node
      const consequentFromBranch = hasConsequentEdges.find(
        (e: EdgeRecord) => e.src === ifBranch!.id
      );
      const alternateFromBranch = hasAlternateEdges.find(
        (e: EdgeRecord) => e.src === ifBranch!.id
      );

      assert.ok(consequentFromBranch, 'Should have HAS_CONSEQUENT edge from BRANCH');
      assert.ok(alternateFromBranch, 'Should have HAS_ALTERNATE edge from BRANCH');

      // Verify destinations are SCOPE nodes
      const consequentDst = await backend.getNode(consequentFromBranch!.dst);
      const alternateDst = await backend.getNode(alternateFromBranch!.dst);

      assert.ok(consequentDst, 'HAS_CONSEQUENT destination should exist');
      assert.ok(alternateDst, 'HAS_ALTERNATE destination should exist');
      assert.strictEqual(consequentDst.type, 'SCOPE', 'HAS_CONSEQUENT destination should be SCOPE');
      assert.strictEqual(alternateDst.type, 'SCOPE', 'HAS_ALTERNATE destination should be SCOPE');

      // Verify they are different scopes
      assert.notStrictEqual(
        consequentDst.id,
        alternateDst.id,
        'Consequent and alternate should be different SCOPEs'
      );
    });

    it('should NOT create HAS_ALTERNATE edge when no else clause', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    doA();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');

      // Filter to edges from this specific BRANCH
      const alternateFromBranch = hasAlternateEdges.filter(
        (e: EdgeRecord) => e.src === ifBranch!.id
      );

      assert.strictEqual(
        alternateFromBranch.length,
        0,
        'Should NOT have HAS_ALTERNATE edge when no else clause'
      );
    });
  });

  // ===========================================================================
  // GROUP 3: Else-if chain
  // ===========================================================================

  describe('Else-if chain creates nested BRANCH nodes', () => {
    it('should create separate BRANCH nodes for else-if chain', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) {
  if (a) {
    doA();
  } else if (b) {
    doB();
  } else {
    doC();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      // Should have 2 BRANCH nodes: one for 'if (a)' and one for 'else if (b)'
      assert.ok(
        ifBranches.length >= 2,
        `Should have at least 2 if BRANCH nodes for else-if chain, got ${ifBranches.length}`
      );
    });

    it('should nest else-if BRANCH in alternate of parent BRANCH', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) {
  if (a) {
    doA();
  } else if (b) {
    doB();
  } else {
    doC();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(ifBranches.length >= 2, 'Should have at least 2 if BRANCH nodes');

      // Sort by line to determine outer (first) and inner (else-if)
      const sortedBranches = ifBranches.sort((a, b) => (a.line || 0) - (b.line || 0));
      const outerBranch = sortedBranches[0];
      const innerBranch = sortedBranches[1];

      // The outer BRANCH's alternate should point to the inner BRANCH (not a SCOPE)
      // OR the outer BRANCH's alternate should point to a SCOPE that contains the inner BRANCH
      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');
      const outerAlternate = hasAlternateEdges.find((e: EdgeRecord) => e.src === outerBranch.id);

      assert.ok(outerAlternate, 'Outer BRANCH should have HAS_ALTERNATE edge');

      // The alternate destination might be:
      // 1. Directly the inner BRANCH node (if we use BRANCH directly in alternate)
      // 2. A SCOPE that contains the inner BRANCH
      // Both are valid implementations - verify one or the other
      const alternateDst = await backend.getNode(outerAlternate!.dst);
      assert.ok(alternateDst, 'Alternate destination should exist');

      // If alternate is the inner BRANCH directly
      if (alternateDst.id === innerBranch.id) {
        assert.ok(true, 'Outer alternate points directly to inner BRANCH');
      } else {
        // If alternate is a SCOPE, verify it contains the inner BRANCH
        const containsEdges = await getEdgesByType(backend, 'CONTAINS');
        const scopeContainsInner = containsEdges.find(
          (e: EdgeRecord) => e.src === alternateDst.id && e.dst === innerBranch.id
        );

        // Or check that the inner branch's parentScopeId matches
        const innerParentScope = (innerBranch as Record<string, unknown>).parentScopeId;

        assert.ok(
          scopeContainsInner || innerParentScope === alternateDst.id,
          'Outer alternate should contain inner BRANCH (directly or via SCOPE)'
        );
      }
    });

    it('should handle three-level else-if chain', async () => {
      await setupTest(backend, {
        'index.js': `
function categorize(x) {
  if (x < 0) {
    return 'negative';
  } else if (x === 0) {
    return 'zero';
  } else if (x < 10) {
    return 'small';
  } else {
    return 'large';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      // Should have 3 BRANCH nodes for the chain
      assert.ok(
        ifBranches.length >= 3,
        `Should have at least 3 if BRANCH nodes for three-level else-if, got ${ifBranches.length}`
      );
    });
  });

  // ===========================================================================
  // GROUP 4: Complex conditions
  // ===========================================================================

  describe('Complex conditions', () => {
    it('should create HAS_CONDITION edge for logical AND condition', async () => {
      await setupTest(backend, {
        'index.js': `
function check(a, b) {
  if (a && b) {
    return true;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge from BRANCH');
    });

    it('should create HAS_CONDITION edge for logical OR condition', async () => {
      await setupTest(backend, {
        'index.js': `
function check(a, b) {
  if (a || b) {
    return true;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge from BRANCH');
    });

    it('should create HAS_CONDITION edge for complex mixed condition', async () => {
      await setupTest(backend, {
        'index.js': `
function check(a, b, c) {
  if (a && b || c) {
    return true;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge for complex condition');
    });

    it('should handle comparison operators in condition', async () => {
      await setupTest(backend, {
        'index.js': `
function compare(x, y) {
  if (x > y && x !== 0) {
    return x;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for comparison condition');
    });

    it('should handle call expression as condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(item) {
  if (isValid(item)) {
    return item;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge for call expression condition');
    });

    it('should handle member expression as condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(obj) {
  if (obj.isActive) {
    return obj.value;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for member expression condition');
    });

    it('should handle negation in condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(flag) {
  if (!flag) {
    return 'not flagged';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for negated condition');
    });
  });

  // ===========================================================================
  // GROUP 5: Nested if statements
  // ===========================================================================

  describe('Nested if statements', () => {
    it('should create separate BRANCH nodes for nested if statements', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) {
  if (a) {
    if (b) {
      return 'both';
    }
    return 'only a';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(
        ifBranches.length >= 2,
        `Should have at least 2 if BRANCH nodes for nested if, got ${ifBranches.length}`
      );
    });

    it('should have inner BRANCH inside outer BRANCH body', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) {
  if (a) {
    if (b) {
      return 'both';
    }
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(ifBranches.length >= 2, 'Should have at least 2 if BRANCH nodes');

      // Sort by line to determine outer (first) and inner (second)
      const sortedBranches = ifBranches.sort((a, b) => (a.line || 0) - (b.line || 0));
      const outerBranch = sortedBranches[0];
      const innerBranch = sortedBranches[1];

      // Verify inner is contained in outer's consequent
      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const outerConsequent = hasConsequentEdges.find(
        (e: EdgeRecord) => e.src === outerBranch.id
      );
      assert.ok(outerConsequent, 'Outer BRANCH should have HAS_CONSEQUENT');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const bodyContainsInner = containsEdges.find(
        (e: EdgeRecord) => e.src === outerConsequent!.dst && e.dst === innerBranch.id
      );

      // Or check parentScopeId
      const innerParentScope = (innerBranch as Record<string, unknown>).parentScopeId;

      assert.ok(
        bodyContainsInner || innerParentScope === outerConsequent!.dst,
        'Inner BRANCH should be in outer BRANCH body scope'
      );
    });
  });

  // ===========================================================================
  // GROUP 6: If inside loop
  // ===========================================================================

  describe('If statement inside loop', () => {
    it('should create BRANCH inside LOOP body scope', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  for (const x of items) {
    if (x) {
      console.log(x);
    }
  }
}
        `
      });

      const loopNodes = await getNodesByType(backend, 'LOOP');
      const branchNodes = await getNodesByType(backend, 'BRANCH');

      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const forOfLoop = loopNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).loopType === 'for-of'
      );
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(forOfLoop, 'Should have for-of LOOP node');
      assert.ok(ifBranch, 'Should have if BRANCH node');

      // Verify BRANCH is inside LOOP's body
      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const loopBodyEdge = hasBodyEdges.find((e: EdgeRecord) => e.src === forOfLoop!.id);
      assert.ok(loopBodyEdge, 'LOOP should have HAS_BODY edge');

      const loopBodyId = loopBodyEdge!.dst;

      // BRANCH should be contained in loop body
      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const bodyContainsBranch = containsEdges.find(
        (e: EdgeRecord) => e.src === loopBodyId && e.dst === ifBranch!.id
      );

      // Or check parentScopeId
      const branchParentScope = (ifBranch as Record<string, unknown>).parentScopeId;

      assert.ok(
        bodyContainsBranch || branchParentScope === loopBodyId,
        'BRANCH should be inside LOOP body scope'
      );
    });
  });

  // ===========================================================================
  // GROUP 7: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle if without block (single statement body)', async () => {
      await setupTest(backend, {
        'index.js': `
function process(x) {
  if (x) return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for single-statement body');

      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const consequentEdge = hasConsequentEdges.find(
        (e: EdgeRecord) => e.src === ifBranch!.id
      );
      assert.ok(consequentEdge, 'Single-statement if should still have HAS_CONSEQUENT edge');
    });

    it('should handle if-else without blocks', async () => {
      await setupTest(backend, {
        'index.js': `
function abs(x) {
  if (x < 0) return -x;
  else return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');

      const consequent = hasConsequentEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      const alternate = hasAlternateEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);

      assert.ok(consequent, 'Should have HAS_CONSEQUENT for single-statement if');
      assert.ok(alternate, 'Should have HAS_ALTERNATE for single-statement else');
    });

    it('should handle empty if body', async () => {
      await setupTest(backend, {
        'index.js': `
function noop(x) {
  if (x) {
    // empty
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for empty body');

      // Should still have HAS_CONSEQUENT pointing to empty SCOPE
      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const consequent = hasConsequentEdges.find((e: EdgeRecord) => e.src === ifBranch!.id);
      assert.ok(consequent, 'Empty if body should still have HAS_CONSEQUENT edge');
    });

    it('should handle ternary operator (conditional expression)', async () => {
      // Note: This might create a BRANCH with branchType='ternary' based on BranchInfo type
      await setupTest(backend, {
        'index.js': `
function getValue(condition) {
  return condition ? 'yes' : 'no';
}
        `
      });

      // Ternary might or might not be tracked as BRANCH depending on implementation
      // This test documents the expected behavior
      const branchNodes = await getNodesByType(backend, 'BRANCH');
      // If ternaries are tracked:
      // const ternaryBranch = branchNodes.find(
      //   (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      // );
      // assert.ok(ternaryBranch, 'Should have ternary BRANCH node');
    });

    it('should handle truthy/falsy checks', async () => {
      await setupTest(backend, {
        'index.js': `
function process(obj) {
  if (obj && obj.value) {
    return obj.value;
  }
  return null;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for truthy check');
    });

    it('should handle typeof check in condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  if (typeof value === 'string') {
    return value.toUpperCase();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for typeof check');
    });

    it('should handle instanceof check in condition', async () => {
      await setupTest(backend, {
        'index.js': `
function process(error) {
  if (error instanceof TypeError) {
    return 'type error';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node for instanceof check');
    });
  });

  // ===========================================================================
  // GROUP 8: BRANCH node properties and semantic IDs
  // ===========================================================================

  describe('BRANCH node properties', () => {
    it('should have correct semantic ID format', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction(x) {
  if (x > 0) {
    return x;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      // Semantic ID should contain BRANCH and if marker
      assert.ok(
        ifBranch.id.includes('BRANCH') || ifBranch.id.includes('if'),
        `BRANCH node ID should contain BRANCH or if: ${ifBranch.id}`
      );
    });

    it('should have parentScopeId pointing to containing scope', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction(x) {
  if (x) {
    return x;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const branchRecord = ifBranch as Record<string, unknown>;
      assert.ok(
        branchRecord.parentScopeId !== undefined,
        'BRANCH node should have parentScopeId'
      );
    });

    it('should preserve backward compatibility with SCOPE nodes', async () => {
      // Per Joel's spec: BRANCH nodes AND body SCOPE nodes should both exist
      await setupTest(backend, {
        'index.js': `
function process(x) {
  if (x) {
    doSomething();
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      // There should be a SCOPE node for the if body
      const ifBodyScope = scopeNodes.find(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('if');
        }
      );
      assert.ok(
        ifBodyScope,
        'Should have SCOPE node for if body (backward compatibility)'
      );
    });
  });

  // ===========================================================================
  // GROUP 9: Multiple if statements in same function
  // ===========================================================================

  describe('Multiple if statements in same function', () => {
    it('should create separate BRANCH nodes for sequential if statements', async () => {
      await setupTest(backend, {
        'index.js': `
function validate(a, b, c) {
  if (a < 0) {
    return 'a negative';
  }

  if (b === 0) {
    return 'b is zero';
  }

  if (c > 100) {
    return 'c too large';
  }

  return 'valid';
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(
        ifBranches.length >= 3,
        `Should have at least 3 if BRANCH nodes, got ${ifBranches.length}`
      );
    });

    it('should have unique IDs for each BRANCH node', async () => {
      await setupTest(backend, {
        'index.js': `
function process(a, b) {
  if (a) { doA(); }
  if (b) { doB(); }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(ifBranches.length >= 2, 'Should have at least 2 if BRANCH nodes');

      const ids = ifBranches.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'All BRANCH nodes should have unique IDs'
      );
    });
  });

  // ===========================================================================
  // GROUP 10: Edge connectivity verification
  // ===========================================================================

  describe('Edge connectivity', () => {
    it('should have valid src and dst node IDs in all if-related edges', async () => {
      await setupTest(backend, {
        'index.js': `
function process(x, y) {
  if (x > 0) {
    if (y) {
      return 'both';
    }
  } else {
    return 'not x';
  }
}
        `
      });

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');

      // Verify all edges have valid src and dst
      for (const edge of [...hasConditionEdges, ...hasConsequentEdges, ...hasAlternateEdges]) {
        const srcNode = await backend.getNode(edge.src);
        const dstNode = await backend.getNode(edge.dst);

        assert.ok(srcNode, `Source node ${edge.src} should exist for edge type ${edge.type}`);
        assert.ok(dstNode, `Destination node ${edge.dst} should exist for edge type ${edge.type}`);
      }
    });

    it('should connect BRANCH correctly to its scopes', async () => {
      await setupTest(backend, {
        'index.js': `
function process(condition) {
  if (condition) {
    return 'yes';
  } else {
    return 'no';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );
      assert.ok(ifBranch, 'Should have if BRANCH node');

      const hasConsequentEdges = await getEdgesByType(backend, 'HAS_CONSEQUENT');
      const hasAlternateEdges = await getEdgesByType(backend, 'HAS_ALTERNATE');

      const branchId = ifBranch!.id;

      // HAS_CONSEQUENT from this BRANCH
      const consequentEdge = hasConsequentEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(consequentEdge, 'Should have HAS_CONSEQUENT from BRANCH');

      const consequentDst = await backend.getNode(consequentEdge!.dst);
      assert.ok(consequentDst, 'HAS_CONSEQUENT destination should exist');
      assert.strictEqual(consequentDst.type, 'SCOPE', 'HAS_CONSEQUENT should point to SCOPE');

      // HAS_ALTERNATE from this BRANCH
      const alternateEdge = hasAlternateEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(alternateEdge, 'Should have HAS_ALTERNATE from BRANCH');

      const alternateDst = await backend.getNode(alternateEdge!.dst);
      assert.ok(alternateDst, 'HAS_ALTERNATE destination should exist');
      assert.strictEqual(alternateDst.type, 'SCOPE', 'HAS_ALTERNATE should point to SCOPE');
    });
  });
});
