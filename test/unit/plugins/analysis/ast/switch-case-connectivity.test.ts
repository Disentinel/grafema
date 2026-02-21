/**
 * Switch Case Connectivity Tests (REG-536)
 *
 * Tests for ensuring nodes inside switch/case blocks are connected
 * to the main graph via CONTAINS chain. The bug is that SCOPE, EXPRESSION,
 * and LITERAL nodes created inside switch/case blocks are disconnected
 * because:
 * 1. No case-body SCOPE nodes are created for each case clause
 * 2. BranchHandler uses ctx.parentScopeId instead of ctx.getCurrentScopeId()
 *
 * The fix will:
 * - Create case-body SCOPE nodes for each non-empty case clause
 * - Push each SCOPE onto scopeIdStack in SwitchCase.enter visitor
 * - Fix BranchHandler to use ctx.getCurrentScopeId()
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially — implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../../helpers/TestRFDB.js';
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
  const testDir = join(tmpdir(), `grafema-test-switch-conn-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-switch-conn-${testCounter}`,
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
 * Infrastructure node types that are not part of the code graph
 * and should be excluded from connectivity checks. These are
 * always present and are not connected to MODULE/SERVICE roots.
 */
const INFRASTRUCTURE_TYPES = new Set(['grafema:plugin', 'GRAPH_META']);

/**
 * Check if a node is an infrastructure node (not part of the code graph).
 * These nodes are always present in the graph regardless of analyzed code.
 */
function isInfrastructureNode(node: NodeRecord): boolean {
  if (INFRASTRUCTURE_TYPES.has(node.type)) return true;
  // Singleton network/IO nodes (e.g., net:request(__network__))
  if (node.id.startsWith('net:')) return true;
  if (node.id.startsWith('grafema:')) return true;
  return false;
}

/**
 * Find disconnected nodes using BFS from root nodes (same algorithm
 * as GraphConnectivityValidator). Returns array of unreachable code nodes.
 * Infrastructure nodes (plugins, graph metadata) are excluded.
 */
async function findDisconnectedNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();

  // Root node types (same as GraphConnectivityValidator)
  const rootTypes = ['SERVICE', 'MODULE', 'PROJECT'];
  const rootNodes = allNodes.filter((n: NodeRecord) => rootTypes.includes(n.type));

  if (rootNodes.length === 0) {
    return []; // No roots — can't check connectivity
  }

  // BFS from root nodes, traversing both directions
  const reachable = new Set<string>();
  const queue: string[] = rootNodes.map((n: NodeRecord) => n.id);

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);

    const outgoing = await backend.getOutgoingEdges(nodeId);
    const incoming = await backend.getIncomingEdges(nodeId);

    for (const edge of outgoing) {
      if (!reachable.has(edge.dst)) {
        queue.push(edge.dst);
      }
    }
    for (const edge of incoming) {
      if (!reachable.has(edge.src)) {
        queue.push(edge.src);
      }
    }
  }

  // Return only code nodes that are unreachable (exclude infrastructure)
  return allNodes.filter((n: NodeRecord) =>
    !reachable.has(n.id) && !isInfrastructureNode(n)
  );
}

// =============================================================================
// TESTS: Switch Case Connectivity (REG-536)
// =============================================================================

describe('Switch Case Connectivity (REG-536)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // GROUP 1: Case body SCOPE creation
  // ===========================================================================

  describe('Case body SCOPE creation', () => {
    it('should have SCOPE nodes for each non-empty case body', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      console.log('a');
      break;
    case 'B':
      console.log('b');
      break;
    default:
      console.log('other');
  }
}
        `
      });

      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      // Look for case-body SCOPEs
      const caseBodyScopes = scopeNodes.filter(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('case');
        }
      );

      // Should have at least 3 case-body SCOPE nodes (case A, case B, default)
      assert.ok(
        caseBodyScopes.length >= 3,
        `Should have at least 3 case-body SCOPE nodes, got ${caseBodyScopes.length}. ` +
        `All scope types: ${scopeNodes.map(s => (s as Record<string, unknown>).scopeType).join(', ')}`
      );
    });

    it('should NOT have SCOPE nodes for empty fall-through cases', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
    case 'B':
      console.log('a or b');
      break;
    case 'C':
      console.log('c');
      break;
  }
}
        `
      });

      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      const caseBodyScopes = scopeNodes.filter(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('case');
        }
      );

      // Cases A is empty (fall-through), B and C have bodies
      // Should have 2 case-body SCOPEs (for B and C), NOT 3
      assert.strictEqual(
        caseBodyScopes.length,
        2,
        `Should have exactly 2 case-body SCOPEs (B and C), not A (empty fall-through). ` +
        `Got ${caseBodyScopes.length}`
      );
    });

    it('should handle default case', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 1:
      return 'one';
    default:
      return 'other';
  }
}
        `
      });

      const scopeNodes = await getNodesByType(backend, 'SCOPE');

      const caseBodyScopes = scopeNodes.filter(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('case');
        }
      );

      // Should have 2 case-body SCOPEs (case 1 and default)
      assert.ok(
        caseBodyScopes.length >= 2,
        `Should have at least 2 case-body SCOPE nodes (including default), got ${caseBodyScopes.length}`
      );
    });
  });

  // ===========================================================================
  // GROUP 2: Connectivity — zero disconnected nodes
  // ===========================================================================

  describe('Connectivity — zero disconnected nodes', () => {
    it('should have zero disconnected nodes in function with switch statement', async () => {
      await setupTest(backend, {
        'index.js': `
function process(action) {
  switch (action) {
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

      const disconnected = await findDisconnectedNodes(backend);

      assert.strictEqual(
        disconnected.length,
        0,
        `Expected 0 disconnected nodes, found ${disconnected.length}: ` +
        disconnected.map(n => `${n.type}(${n.name || n.id})`).join(', ')
      );
    });

    it('should have zero disconnected nodes when switch is nested inside for loop', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  const results = [];
  for (const item of items) {
    switch (item.type) {
      case 'add':
        results.push(item.value);
        break;
      case 'remove':
        results.pop();
        break;
      default:
        console.log('unknown type');
    }
  }
  return results;
}
        `
      });

      const disconnected = await findDisconnectedNodes(backend);

      assert.strictEqual(
        disconnected.length,
        0,
        `Expected 0 disconnected nodes in switch-inside-for-loop, found ${disconnected.length}: ` +
        disconnected.map(n => `${n.type}(${n.name || n.id})`).join(', ')
      );
    });

    it('should have zero disconnected nodes with nested switch statements', async () => {
      await setupTest(backend, {
        'index.js': `
function dispatch(category, action) {
  switch (category) {
    case 'user':
      switch (action) {
        case 'create':
          return 'creating user';
        case 'delete':
          return 'deleting user';
        default:
          return 'unknown user action';
      }
    case 'admin':
      return 'admin action';
    default:
      return 'unknown category';
  }
}
        `
      });

      const disconnected = await findDisconnectedNodes(backend);

      assert.strictEqual(
        disconnected.length,
        0,
        `Expected 0 disconnected nodes in nested switch, found ${disconnected.length}: ` +
        disconnected.map(n => `${n.type}(${n.name || n.id})`).join(', ')
      );
    });

    it('should have zero disconnected nodes with variable declarations inside case bodies', async () => {
      await setupTest(backend, {
        'index.js': `
function compute(op, a, b) {
  switch (op) {
    case 'add': {
      const sum = a + b;
      return sum;
    }
    case 'multiply': {
      const product = a * b;
      return product;
    }
    case 'negate': {
      const negated = -a;
      return negated;
    }
    default:
      return 0;
  }
}
        `
      });

      const disconnected = await findDisconnectedNodes(backend);

      assert.strictEqual(
        disconnected.length,
        0,
        `Expected 0 disconnected nodes with var decls in cases, found ${disconnected.length}: ` +
        disconnected.map(n => `${n.type}(${n.name || n.id})`).join(', ')
      );
    });

    it('should have zero disconnected nodes with call sites inside case bodies', async () => {
      await setupTest(backend, {
        'index.js': `
function handleEvent(event) {
  switch (event.type) {
    case 'click':
      handleClick(event.target);
      logEvent('click', event);
      break;
    case 'hover':
      handleHover(event.target);
      break;
    case 'scroll':
      requestAnimationFrame(() => {
        handleScroll(event);
      });
      break;
    default:
      console.warn('Unknown event:', event.type);
  }
}
        `
      });

      const disconnected = await findDisconnectedNodes(backend);

      assert.strictEqual(
        disconnected.length,
        0,
        `Expected 0 disconnected nodes with call sites in cases, found ${disconnected.length}: ` +
        disconnected.map(n => `${n.type}(${n.name || n.id})`).join(', ')
      );
    });
  });

  // ===========================================================================
  // GROUP 3: Correct CONTAINS chain
  // ===========================================================================

  describe('Correct CONTAINS chain', () => {
    it('should link nodes inside case body to case-body SCOPE via CONTAINS', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  switch (value) {
    case 'A':
      console.log('handling A');
      break;
    default:
      console.log('default');
  }
}
        `
      });

      const scopeNodes = await getNodesByType(backend, 'SCOPE');
      const containsEdges = await getEdgesByType(backend, 'CONTAINS');

      // Find case-body SCOPE nodes
      const caseBodyScopes = scopeNodes.filter(
        (s: NodeRecord) => {
          const scopeType = (s as Record<string, unknown>).scopeType as string;
          return scopeType && scopeType.includes('case');
        }
      );

      assert.ok(
        caseBodyScopes.length >= 1,
        `Should have at least one case-body SCOPE, got ${caseBodyScopes.length}`
      );

      // At least one case-body SCOPE should have CONTAINS edges pointing to child nodes
      let hasChildNodes = false;
      for (const scope of caseBodyScopes) {
        const childEdges = containsEdges.filter(
          (e: EdgeRecord) => e.src === scope.id
        );
        if (childEdges.length > 0) {
          hasChildNodes = true;
          break;
        }
      }

      assert.ok(
        hasChildNodes,
        'At least one case-body SCOPE should CONTAIN child nodes'
      );
    });

    it('should use correct parent scope when switch is nested inside a loop', async () => {
      await setupTest(backend, {
        'index.js': `
function processAll(items) {
  for (const item of items) {
    switch (item.type) {
      case 'valid':
        console.log('valid');
        break;
      default:
        console.log('invalid');
    }
  }
}
        `
      });

      // The BRANCH node for the switch should be contained in the loop body SCOPE,
      // not in the function body SCOPE (which would happen if parentScopeId is used
      // instead of getCurrentScopeId())
      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const switchBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'switch'
      );
      assert.ok(switchBranch, 'Should have switch BRANCH node');

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');

      // Get the loop body SCOPE
      const hasBodyEdges = await getEdgesByType(backend, 'HAS_BODY');
      const loopBodyEdge = hasBodyEdges.find(
        (e: EdgeRecord) => e.src === loopNodes[0].id
      );
      assert.ok(loopBodyEdge, 'LOOP should have HAS_BODY edge');
      const loopBodyScopeId = loopBodyEdge!.dst;

      // The switch BRANCH should be CONTAINED in the loop body SCOPE
      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const branchInLoopBody = containsEdges.find(
        (e: EdgeRecord) => e.src === loopBodyScopeId && e.dst === switchBranch!.id
      );

      // Or check parentScopeId on the BRANCH node
      const branchParentScope = (switchBranch as Record<string, unknown>).parentScopeId;

      assert.ok(
        branchInLoopBody || branchParentScope === loopBodyScopeId,
        `Switch BRANCH should be inside loop body SCOPE (${loopBodyScopeId}), ` +
        `but parentScopeId is ${branchParentScope}. ` +
        `This indicates BranchHandler uses ctx.parentScopeId instead of ctx.getCurrentScopeId().`
      );
    });
  });
});
