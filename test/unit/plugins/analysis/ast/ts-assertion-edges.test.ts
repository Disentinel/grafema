/**
 * TS Type Assertion Edge Tests (REG-599)
 *
 * Tests that TS type assertion expressions (as, satisfies, angle-bracket, non-null)
 * create ASSIGNED_FROM edges from wrapper EXPRESSION nodes to inner expression nodes,
 * enabling data flow tracing through assertion boundaries.
 *
 * What we verify:
 * - TSAsExpression.expression gets ASSIGNED_FROM edge
 * - TSSatisfiesExpression.expression gets ASSIGNED_FROM edge
 * - TSTypeAssertion.expression gets ASSIGNED_FROM edge + HAS_TYPE to typeAnnotation
 * - TSNonNullExpression.expression gets ASSIGNED_FROM edge
 * - Nested assertions chain correctly
 * - `as const` works without regression
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
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-ts-assert-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-ts-assert-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  writeFileSync(
    join(testDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        strict: true
      }
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

async function getOutgoingEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeId: string,
  edgeType: string
): Promise<EdgeRecord[]> {
  const outgoing = await backend.getOutgoingEdges(nodeId);
  return outgoing.filter((e: EdgeRecord) => e.type === edgeType);
}

// =============================================================================
// TESTS: TS Type Assertion Edges (REG-599)
// =============================================================================

describe('TS Type Assertion Edges (REG-599)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: fn() as Foo — EXPRESSION → ASSIGNED_FROM → CALL
  // ===========================================================================

  describe('TSAsExpression with call child', () => {
    it('should create ASSIGNED_FROM edge from EXPRESSION to CALL for "fn() as Foo"', async () => {
      await setupTest(backend, {
        'index.ts': `
type Foo = { x: number };
function fn(): unknown { return { x: 1 }; }
const y = fn() as Foo;
        `
      });

      // Find the EXPRESSION node for the "as" assertion
      const expressions = await getNodesByType(backend, 'EXPRESSION');
      const asExpression = expressions.find(n =>
        n.name?.includes('as') || n.name?.includes('_as_')
      );
      assert.ok(
        asExpression,
        `Should have an EXPRESSION node for the "as" assertion. ` +
        `Found expressions: ${expressions.map(n => n.name).join(', ')}`
      );

      // Should have ASSIGNED_FROM edge to the CALL node
      const assignedFromEdges = await getOutgoingEdgesByType(backend, asExpression!.id, 'ASSIGNED_FROM');
      assert.ok(
        assignedFromEdges.length >= 1,
        `EXPRESSION for "as" should have at least 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      // Verify the target is a CALL node
      const targetNode = await backend.getNode(assignedFromEdges[0].dst);
      assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
      assert.strictEqual(
        targetNode!.type,
        'CALL',
        `ASSIGNED_FROM target should be CALL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 2: x! where x is a call — TSNonNullExpression
  // ===========================================================================

  describe('TSNonNullExpression with call child', () => {
    it('should create ASSIGNED_FROM edge from EXPRESSION to CALL for "fn()!"', async () => {
      await setupTest(backend, {
        'index.ts': `
function getUser(): { name: string } | null { return { name: 'a' }; }
const user = getUser()!;
        `
      });

      const expressions = await getNodesByType(backend, 'EXPRESSION');
      const nonNullExpr = expressions.find(n =>
        n.name?.includes('!') || n.name?.includes('non_null')
      );
      assert.ok(
        nonNullExpr,
        `Should have an EXPRESSION node for the "!" assertion. ` +
        `Found expressions: ${expressions.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getOutgoingEdgesByType(backend, nonNullExpr!.id, 'ASSIGNED_FROM');
      assert.ok(
        assignedFromEdges.length >= 1,
        `EXPRESSION for "!" should have at least 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await backend.getNode(assignedFromEdges[0].dst);
      assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
      assert.strictEqual(
        targetNode!.type,
        'CALL',
        `ASSIGNED_FROM target should be CALL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 3: TSTypeAssertion edge-map entries exist
  // ===========================================================================
  // NOTE: Angle-bracket syntax (<Type>expr) cannot be tested at runtime because
  // Grafema's Babel parser uses TSX mode, which conflicts with angle brackets.
  // We verify the edge-map entries are registered so they fire when TSTypeAssertion
  // nodes are produced (e.g., in non-TSX .ts files).

  describe('TSTypeAssertion edge-map entries', () => {
    it('should have ASSIGNED_FROM and HAS_TYPE entries for TSTypeAssertion', async () => {
      const { EDGE_MAP } = await import('../../../../../packages/core-v2/dist/edge-map.js');

      assert.ok(
        EDGE_MAP['TSTypeAssertion.expression'],
        'Edge map should have entry for TSTypeAssertion.expression'
      );
      assert.strictEqual(
        EDGE_MAP['TSTypeAssertion.expression'].edgeType,
        'ASSIGNED_FROM',
        'TSTypeAssertion.expression should map to ASSIGNED_FROM'
      );

      assert.ok(
        EDGE_MAP['TSTypeAssertion.typeAnnotation'],
        'Edge map should have entry for TSTypeAssertion.typeAnnotation'
      );
      assert.strictEqual(
        EDGE_MAP['TSTypeAssertion.typeAnnotation'].edgeType,
        'HAS_TYPE',
        'TSTypeAssertion.typeAnnotation should map to HAS_TYPE'
      );
    });
  });

  // ===========================================================================
  // TEST 4: x satisfies T — TSSatisfiesExpression
  // ===========================================================================

  describe('TSSatisfiesExpression', () => {
    it('should create ASSIGNED_FROM edge for "fn() satisfies T"', async () => {
      await setupTest(backend, {
        'index.ts': `
type Config = { port: number };
function loadConfig(): Config { return { port: 3000 }; }
const cfg = loadConfig() satisfies Config;
        `
      });

      const expressions = await getNodesByType(backend, 'EXPRESSION');
      const satisfiesExpr = expressions.find(n =>
        n.name?.includes('satisfies')
      );
      assert.ok(
        satisfiesExpr,
        `Should have an EXPRESSION node for "satisfies". ` +
        `Found expressions: ${expressions.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getOutgoingEdgesByType(backend, satisfiesExpr!.id, 'ASSIGNED_FROM');
      assert.ok(
        assignedFromEdges.length >= 1,
        `EXPRESSION for "satisfies" should have at least 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await backend.getNode(assignedFromEdges[0].dst);
      assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
      assert.strictEqual(
        targetNode!.type,
        'CALL',
        `ASSIGNED_FROM target should be CALL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 5: Nested — (fn() as Foo)! — chain of assertions
  // ===========================================================================

  describe('Nested assertions: (fn() as Foo)!', () => {
    it('should create ASSIGNED_FROM chain through nested assertions', async () => {
      await setupTest(backend, {
        'index.ts': `
type Foo = { x: number };
function fn(): unknown { return { x: 1 }; }
const y = (fn() as Foo)!;
        `
      });

      // There should be two EXPRESSION nodes for the two assertions
      const expressions = await getNodesByType(backend, 'EXPRESSION');

      // Find all expressions with ASSIGNED_FROM edges
      const exprsWithAssignedFrom: NodeRecord[] = [];
      for (const expr of expressions) {
        const edges = await getOutgoingEdgesByType(backend, expr.id, 'ASSIGNED_FROM');
        if (edges.length > 0) {
          exprsWithAssignedFrom.push(expr);
        }
      }

      assert.ok(
        exprsWithAssignedFrom.length >= 2,
        `Should have at least 2 EXPRESSION nodes with ASSIGNED_FROM edges (one for "as", one for "!"). ` +
        `Got ${exprsWithAssignedFrom.length}. All expressions: ${expressions.map(n => n.name).join(', ')}`
      );

      // Verify the chain reaches a CALL node at the end
      // Follow ASSIGNED_FROM edges from the outermost expression
      let currentNode: NodeRecord | null = exprsWithAssignedFrom.find(n =>
        n.name?.includes('!') || n.name?.includes('non_null')
      ) || exprsWithAssignedFrom[0];

      let reachedCall = false;
      let depth = 0;
      while (currentNode && depth < 5) {
        if (currentNode.type === 'CALL') {
          reachedCall = true;
          break;
        }
        const edges = await getOutgoingEdgesByType(backend, currentNode.id, 'ASSIGNED_FROM');
        if (edges.length === 0) break;
        currentNode = await backend.getNode(edges[0].dst);
        depth++;
      }

      assert.ok(
        reachedCall,
        'Should reach a CALL node following ASSIGNED_FROM chain through nested assertions'
      );
    });
  });

  // ===========================================================================
  // TEST 6: as const — no regression
  // ===========================================================================

  describe('as const', () => {
    it('should create ASSIGNED_FROM edge for "{ ... } as const"', async () => {
      await setupTest(backend, {
        'index.ts': `
const config = { port: 3000, host: 'localhost' } as const;
        `
      });

      const expressions = await getNodesByType(backend, 'EXPRESSION');
      const asConstExpr = expressions.find(n =>
        n.name?.includes('as') || n.name?.includes('_as_')
      );
      assert.ok(
        asConstExpr,
        `Should have an EXPRESSION node for "as const". ` +
        `Found expressions: ${expressions.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getOutgoingEdgesByType(backend, asConstExpr!.id, 'ASSIGNED_FROM');
      assert.ok(
        assignedFromEdges.length >= 1,
        `EXPRESSION for "as const" should have at least 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      // Target should be the object node (OBJECT_LITERAL or LITERAL depending
      // on whether all properties are literal-valued — Grafema may collapse
      // all-literal objects to LITERAL)
      const targetNode = await backend.getNode(assignedFromEdges[0].dst);
      assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
      assert.ok(
        targetNode!.type === 'OBJECT_LITERAL' || targetNode!.type === 'LITERAL',
        `ASSIGNED_FROM target for "as const" should be OBJECT_LITERAL or LITERAL, got "${targetNode!.type}"`
      );
    });
  });
});
