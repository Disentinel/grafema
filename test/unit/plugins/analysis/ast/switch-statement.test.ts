/**
 * Switch Statement Tests (REG-275)
 *
 * Tests for BRANCH and CASE nodes representing SwitchStatement AST nodes.
 * These tests verify the graph structure for switch statements including:
 * - BRANCH node creation for switch statements
 * - HAS_CONDITION edge from BRANCH to discriminant expression
 * - HAS_CASE edges from BRANCH to case clauses
 * - HAS_DEFAULT edge for default case
 * - Fall-through detection
 *
 * What will be created:
 * - BRANCH node with branchType='switch'
 * - CASE nodes for each case clause
 * - HAS_CONDITION, HAS_CASE, HAS_DEFAULT edges
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
  const testDir = join(tmpdir(), `grafema-test-switch-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-switch-${testCounter}`,
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
// TESTS: BRANCH Node Creation for Switch Statements
// =============================================================================

describe('Switch Statement Analysis (REG-275)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = await createTestDatabase(); backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // GROUP 1: Basic BRANCH node creation
  // ===========================================================================

  describe('Basic BRANCH node creation', () => {
    it('should create BRANCH node for simple switch', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    default:
      return 'other';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have at least one BRANCH node');

      const switchBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'switch'
      );
      assert.ok(switchBranch, 'Should have BRANCH node with branchType="switch"');
      assert.ok(switchBranch.file, 'BRANCH node should have file property');
      assert.ok(switchBranch.line, 'BRANCH node should have line property');
    });

    it('should create BRANCH node with correct semantic ID format', async () => {
      await setupTest(backend, {
        'index.js': `
function reducer(state, action) {
  switch (action.type) {
    case 'INCREMENT':
      return state + 1;
    default:
      return state;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const switchBranch = branchNodes[0];
      // Semantic ID should contain BRANCH and switch marker
      // Expected format: {file}->scope_path->BRANCH->switch#N
      assert.ok(
        switchBranch.id.includes('BRANCH') || switchBranch.id.includes('switch'),
        `BRANCH node ID should contain BRANCH or switch: ${switchBranch.id}`
      );
    });
  });

  // ===========================================================================
  // GROUP 2: HAS_CONDITION edge creation
  // ===========================================================================

  describe('HAS_CONDITION edge creation', () => {
    it('should create HAS_CONDITION edge from BRANCH to EXPRESSION for simple identifier', async () => {
      await setupTest(backend, {
        'index.js': `
function process(x) {
  switch (x) {
    case 1:
      return 'one';
    default:
      return 'other';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      assert.ok(hasConditionEdges.length >= 1, 'Should have at least one HAS_CONDITION edge');

      // Verify edge comes from BRANCH node
      const branchId = branchNodes[0].id;
      const edgeFromBranch = hasConditionEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(edgeFromBranch, 'HAS_CONDITION edge should come from BRANCH node');
    });

    it('should handle MemberExpression discriminant', async () => {
      await setupTest(backend, {
        'index.js': `
function reducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return [...state, action.payload];
    case 'REMOVE':
      return state.filter(x => x.id !== action.payload);
    default:
      return state;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      assert.ok(hasConditionEdges.length >= 1, 'Should have HAS_CONDITION edge for MemberExpression');

      // Verify destination is an EXPRESSION node (or the expression node exists)
      const branchId = branchNodes[0].id;
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge from BRANCH');

      // The destination should be an EXPRESSION or CALL node
      const dstNode = await backend.getNode(conditionEdge!.dst);
      // Note: destination might be EXPRESSION, CALL, or other node type depending on discriminant
      assert.ok(dstNode, 'Destination of HAS_CONDITION edge should exist');
    });

    it('should handle CallExpression discriminant', async () => {
      await setupTest(backend, {
        'index.js': `
function getType() {
  return 'A';
}

function process() {
  switch (getType()) {
    case 'A':
      return 1;
    case 'B':
      return 2;
    default:
      return 0;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');
      const branchId = branchNodes[0].id;
      const conditionEdge = hasConditionEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(conditionEdge, 'Should have HAS_CONDITION edge for CallExpression discriminant');

      // Verify destination exists (should be CALL or EXPRESSION node)
      const dstNode = await backend.getNode(conditionEdge!.dst);
      assert.ok(dstNode, 'CallExpression discriminant node should exist');
    });
  });

  // ===========================================================================
  // GROUP 3: HAS_CASE edge creation
  // ===========================================================================

  describe('HAS_CASE edge creation', () => {
    it('should create CASE nodes for each case clause', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      return 1;
    case 'B':
      return 2;
    case 'C':
      return 3;
    default:
      return 0;
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');
      // Should have 4 CASE nodes: 'A', 'B', 'C', and default
      assert.ok(caseNodes.length >= 4, `Should have at least 4 CASE nodes, got ${caseNodes.length}`);
    });

    it('should create HAS_CASE edges from BRANCH to each CASE', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'ADD':
      return 'add';
    case 'REMOVE':
      return 'remove';
    default:
      return 'unknown';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');

      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');
      assert.ok(hasCaseEdges.length >= 2, `Should have at least 2 HAS_CASE edges (non-default), got ${hasCaseEdges.length}`);

      // All HAS_CASE edges should come from the BRANCH node
      const branchId = branchNodes[0].id;
      const edgesFromBranch = hasCaseEdges.filter((e: EdgeRecord) => e.src === branchId);
      assert.ok(
        edgesFromBranch.length >= 2,
        `All HAS_CASE edges should come from BRANCH node, got ${edgesFromBranch.length}`
      );
    });

    it('should include case value in CASE node', async () => {
      await setupTest(backend, {
        'index.js': `
function dispatch(action) {
  switch (action) {
    case 'INCREMENT':
      return 1;
    case 'DECREMENT':
      return -1;
    default:
      return 0;
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');
      assert.ok(caseNodes.length >= 2, 'Should have CASE nodes');

      // Find case nodes with values
      const incrementCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'INCREMENT'
      );
      const decrementCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'DECREMENT'
      );

      assert.ok(incrementCase, 'Should have CASE node with value="INCREMENT"');
      assert.ok(decrementCase, 'Should have CASE node with value="DECREMENT"');
    });

    it('should handle numeric case values', async () => {
      await setupTest(backend, {
        'index.js': `
function getLabel(code) {
  switch (code) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    case 100:
      return 'hundred';
    default:
      return 'unknown';
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const case1 = caseNodes.find((n: NodeRecord) => (n as Record<string, unknown>).value === 1);
      const case2 = caseNodes.find((n: NodeRecord) => (n as Record<string, unknown>).value === 2);
      const case100 = caseNodes.find((n: NodeRecord) => (n as Record<string, unknown>).value === 100);

      assert.ok(case1, 'Should have CASE node with value=1');
      assert.ok(case2, 'Should have CASE node with value=2');
      assert.ok(case100, 'Should have CASE node with value=100');
    });

    it('should handle identifier case values', async () => {
      await setupTest(backend, {
        'index.js': `
const ACTION_ADD = 'ADD';
const ACTION_REMOVE = 'REMOVE';

function process(action) {
  switch (action) {
    case ACTION_ADD:
      return 'adding';
    case ACTION_REMOVE:
      return 'removing';
    default:
      return 'unknown';
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      // Identifier case values should store the identifier name
      const addCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'ACTION_ADD'
      );
      const removeCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'ACTION_REMOVE'
      );

      assert.ok(addCase, 'Should have CASE node with value="ACTION_ADD"');
      assert.ok(removeCase, 'Should have CASE node with value="ACTION_REMOVE"');
    });
  });

  // ===========================================================================
  // GROUP 4: HAS_DEFAULT edge creation
  // ===========================================================================

  describe('HAS_DEFAULT edge creation', () => {
    it('should create HAS_DEFAULT edge for default case', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      return 1;
    default:
      return 0;
  }
}
        `
      });

      const hasDefaultEdges = await getEdgesByType(backend, 'HAS_DEFAULT');
      assert.ok(hasDefaultEdges.length >= 1, 'Should have at least one HAS_DEFAULT edge');

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const branchId = branchNodes[0].id;

      const defaultEdge = hasDefaultEdges.find((e: EdgeRecord) => e.src === branchId);
      assert.ok(defaultEdge, 'HAS_DEFAULT edge should come from BRANCH node');
    });

    it('should mark default CASE node with isDefault: true', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      return 1;
    case 'B':
      return 2;
    default:
      return -1;
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const defaultCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).isDefault === true
      );
      assert.ok(defaultCase, 'Should have CASE node with isDefault=true');

      // Default case should have null value
      assert.strictEqual(
        (defaultCase as Record<string, unknown>).value,
        null,
        'Default case should have value=null'
      );
    });

    it('should handle switch without default case', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      return 1;
    case 'B':
      return 2;
  }
}
        `
      });

      const hasDefaultEdges = await getEdgesByType(backend, 'HAS_DEFAULT');
      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');

      // Should have HAS_CASE edges but NO HAS_DEFAULT edge
      assert.ok(hasCaseEdges.length >= 2, 'Should have HAS_CASE edges');
      assert.strictEqual(
        hasDefaultEdges.length,
        0,
        'Should NOT have HAS_DEFAULT edge when no default case'
      );
    });
  });

  // ===========================================================================
  // GROUP 5: Fall-through detection
  // ===========================================================================

  describe('Fall-through detection', () => {
    it('should mark case as fallsThrough when no break/return', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  let result = '';
  switch (value) {
    case 'A':
      result = 'a';
      // No break - falls through!
    case 'B':
      result += 'b';
      break;
    default:
      result = 'other';
  }
  return result;
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const caseA = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'A'
      );
      assert.ok(caseA, 'Should have CASE node for "A"');
      assert.strictEqual(
        (caseA as Record<string, unknown>).fallsThrough,
        true,
        'Case "A" should have fallsThrough=true'
      );
    });

    it('should NOT mark case as fallsThrough when has break', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      console.log('A');
      break;
    case 'B':
      console.log('B');
      break;
    default:
      console.log('default');
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const caseA = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'A'
      );
      const caseB = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'B'
      );

      assert.ok(caseA, 'Should have CASE node for "A"');
      assert.ok(caseB, 'Should have CASE node for "B"');

      assert.strictEqual(
        (caseA as Record<string, unknown>).fallsThrough,
        false,
        'Case "A" with break should have fallsThrough=false'
      );
      assert.strictEqual(
        (caseB as Record<string, unknown>).fallsThrough,
        false,
        'Case "B" with break should have fallsThrough=false'
      );
    });

    it('should NOT mark case as fallsThrough when has return', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      return 1;
    case 'B':
      return 2;
    default:
      return 0;
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      for (const caseNode of caseNodes) {
        assert.strictEqual(
          (caseNode as Record<string, unknown>).fallsThrough,
          false,
          `Case with return should have fallsThrough=false: ${JSON.stringify(caseNode)}`
        );
      }
    });

    it('should handle empty case (intentional fall-through)', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
    case 'B':
    case 'C':
      return 'ABC';
    default:
      return 'other';
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const caseA = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'A'
      );
      const caseB = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'B'
      );
      const caseC = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'C'
      );

      assert.ok(caseA, 'Should have CASE node for "A"');
      assert.ok(caseB, 'Should have CASE node for "B"');
      assert.ok(caseC, 'Should have CASE node for "C"');

      // Empty cases should have fallsThrough=true
      assert.strictEqual(
        (caseA as Record<string, unknown>).fallsThrough,
        true,
        'Empty case "A" should have fallsThrough=true'
      );
      assert.strictEqual(
        (caseB as Record<string, unknown>).fallsThrough,
        true,
        'Empty case "B" should have fallsThrough=true'
      );
    });

    it('should mark empty cases with isEmpty: true', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'X':
    case 'Y':
      return 'XY';
    case 'Z':
      return 'Z';
    default:
      return 'other';
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const caseX = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'X'
      );
      const caseY = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'Y'
      );
      const caseZ = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'Z'
      );

      assert.ok(caseX, 'Should have CASE node for "X"');
      assert.ok(caseY, 'Should have CASE node for "Y"');
      assert.ok(caseZ, 'Should have CASE node for "Z"');

      assert.strictEqual(
        (caseX as Record<string, unknown>).isEmpty,
        true,
        'Case "X" with no statements should have isEmpty=true'
      );
      assert.strictEqual(
        (caseY as Record<string, unknown>).isEmpty,
        false,
        'Case "Y" with return should have isEmpty=false'
      );
      assert.strictEqual(
        (caseZ as Record<string, unknown>).isEmpty,
        false,
        'Case "Z" with return should have isEmpty=false'
      );
    });
  });

  // ===========================================================================
  // GROUP 6: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle switch with single case', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'only':
      return 'single case';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const caseNodes = await getNodesByType(backend, 'CASE');
      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');

      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');
      assert.ok(caseNodes.length >= 1, 'Should have at least 1 CASE node');
      assert.ok(hasCaseEdges.length >= 1, 'Should have at least 1 HAS_CASE edge');
    });

    it('should handle switch with only default', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    default:
      return 'always default';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const caseNodes = await getNodesByType(backend, 'CASE');
      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');
      const hasDefaultEdges = await getEdgesByType(backend, 'HAS_DEFAULT');

      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');
      assert.ok(caseNodes.length >= 1, 'Should have default CASE node');
      assert.strictEqual(hasCaseEdges.length, 0, 'Should NOT have HAS_CASE edges');
      assert.ok(hasDefaultEdges.length >= 1, 'Should have HAS_DEFAULT edge');

      const defaultCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).isDefault === true
      );
      assert.ok(defaultCase, 'Should have default CASE node');
    });

    it('should handle nested switch statements', async () => {
      await setupTest(backend, {
        'index.js': `
function process(outer, inner) {
  switch (outer) {
    case 'A':
      switch (inner) {
        case 1:
          return 'A1';
        case 2:
          return 'A2';
        default:
          return 'A?';
      }
    case 'B':
      return 'B';
    default:
      return 'other';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');

      // Should have 2 BRANCH nodes - one for each switch
      assert.ok(branchNodes.length >= 2, `Should have at least 2 BRANCH nodes for nested switch, got ${branchNodes.length}`);

      // Each should have branchType='switch'
      const switchBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'switch'
      );
      assert.ok(switchBranches.length >= 2, 'Both BRANCH nodes should have branchType="switch"');
    });

    it('should handle switch inside function with correct parent scope', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction(value) {
  const prefix = 'result: ';
  switch (value) {
    case 'A':
      return prefix + 'A';
    default:
      return prefix + 'other';
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const functionNodes = await getNodesByType(backend, 'FUNCTION');

      assert.ok(branchNodes.length >= 1, 'Should have BRANCH node');
      assert.ok(functionNodes.length >= 1, 'Should have FUNCTION node');

      const switchBranch = branchNodes[0] as Record<string, unknown>;

      // BRANCH should have parentScopeId pointing to function's scope
      assert.ok(
        switchBranch.parentScopeId !== undefined,
        'BRANCH node should have parentScopeId'
      );
    });
  });

  // ===========================================================================
  // GROUP 7: Edge connectivity verification
  // ===========================================================================

  describe('Edge connectivity', () => {
    it('should have valid src and dst node IDs in all switch-related edges', async () => {
      await setupTest(backend, {
        'index.js': `
function process(action) {
  switch (action.type) {
    case 'ADD':
      return 'adding';
    case 'REMOVE':
      return 'removing';
    default:
      return 'unknown';
  }
}
        `
      });

      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');
      const hasDefaultEdges = await getEdgesByType(backend, 'HAS_DEFAULT');
      const hasConditionEdges = await getEdgesByType(backend, 'HAS_CONDITION');

      // Verify all edges have valid src and dst
      for (const edge of [...hasCaseEdges, ...hasDefaultEdges, ...hasConditionEdges]) {
        const srcNode = await backend.getNode(edge.src);
        const dstNode = await backend.getNode(edge.dst);

        assert.ok(srcNode, `Source node ${edge.src} should exist for edge type ${edge.type}`);
        assert.ok(dstNode, `Destination node ${edge.dst} should exist for edge type ${edge.type}`);
      }
    });

    it('should connect BRANCH to correct CASE nodes', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'FIRST':
      return 1;
    case 'SECOND':
      return 2;
    default:
      return 0;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const caseNodes = await getNodesByType(backend, 'CASE');
      const hasCaseEdges = await getEdgesByType(backend, 'HAS_CASE');
      const hasDefaultEdges = await getEdgesByType(backend, 'HAS_DEFAULT');

      const branchId = branchNodes[0].id;

      // All HAS_CASE edges should:
      // 1. Come from the BRANCH node
      // 2. Point to CASE nodes
      for (const edge of hasCaseEdges) {
        assert.strictEqual(edge.src, branchId, 'HAS_CASE edge src should be BRANCH node');

        const dstNode = await backend.getNode(edge.dst);
        assert.ok(dstNode, 'HAS_CASE destination should exist');
        assert.strictEqual(dstNode.type, 'CASE', 'HAS_CASE destination should be CASE node');
        assert.strictEqual(
          (dstNode as Record<string, unknown>).isDefault,
          false,
          'HAS_CASE destination should NOT be default case'
        );
      }

      // HAS_DEFAULT edge should point to CASE node with isDefault=true
      for (const edge of hasDefaultEdges) {
        assert.strictEqual(edge.src, branchId, 'HAS_DEFAULT edge src should be BRANCH node');

        const dstNode = await backend.getNode(edge.dst);
        assert.ok(dstNode, 'HAS_DEFAULT destination should exist');
        assert.strictEqual(dstNode.type, 'CASE', 'HAS_DEFAULT destination should be CASE node');
        assert.strictEqual(
          (dstNode as Record<string, unknown>).isDefault,
          true,
          'HAS_DEFAULT destination should be default case'
        );
      }
    });
  });

  // ===========================================================================
  // GROUP 8: Complex patterns
  // ===========================================================================

  describe('Complex switch patterns', () => {
    it('should handle switch with throw statements', async () => {
      await setupTest(backend, {
        'index.js': `
function validate(type) {
  switch (type) {
    case 'valid':
      return true;
    case 'invalid':
      throw new Error('Invalid type');
    default:
      throw new Error('Unknown type');
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const invalidCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'invalid'
      );

      assert.ok(invalidCase, 'Should have CASE node for "invalid"');
      // throw should terminate the case, so fallsThrough should be false
      assert.strictEqual(
        (invalidCase as Record<string, unknown>).fallsThrough,
        false,
        'Case with throw should have fallsThrough=false'
      );
    });

    it('should handle switch with continue in loop context', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  const results = [];
  for (const item of items) {
    switch (item.type) {
      case 'skip':
        continue;
      case 'process':
        results.push(item);
        break;
      default:
        continue;
    }
  }
  return results;
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      const skipCase = caseNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).value === 'skip'
      );

      assert.ok(skipCase, 'Should have CASE node for "skip"');
      // continue terminates the switch case in loop context
      assert.strictEqual(
        (skipCase as Record<string, unknown>).fallsThrough,
        false,
        'Case with continue should have fallsThrough=false'
      );
    });

    it('should handle MemberExpression case values', async () => {
      await setupTest(backend, {
        'index.js': `
const Actions = {
  ADD: 'add',
  REMOVE: 'remove'
};

function process(action) {
  switch (action) {
    case Actions.ADD:
      return 'adding';
    case Actions.REMOVE:
      return 'removing';
    default:
      return 'unknown';
  }
}
        `
      });

      const caseNodes = await getNodesByType(backend, 'CASE');

      // MemberExpression case values should be stored as string representation
      const addCase = caseNodes.find(
        (n: NodeRecord) => {
          const value = (n as Record<string, unknown>).value;
          return value === 'Actions.ADD' || String(value).includes('Actions');
        }
      );

      assert.ok(addCase, 'Should have CASE node for Actions.ADD MemberExpression');
    });
  });
});
