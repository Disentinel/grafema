/**
 * Tests for computed property tracking (computedPropertyVar)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/computed-property');

describe('Computed Property Tracking', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('computedPropertyVar attribute', () => {
    it('should track computedPropertyVar for computed property access', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Query for EXPRESSION nodes with computed=true
      const computedExpressions = await backend.checkGuarantee(`
        violation(X) :- node(X, "EXPRESSION"), attr(X, "computed", "true").
      `);

      console.log(`Found ${computedExpressions.length} computed EXPRESSION nodes`);

      // Should have at least 2 computed expressions (handlers[action], items[i])
      assert.ok(computedExpressions.length >= 2, `Should have at least 2 computed EXPRESSION nodes, got ${computedExpressions.length}`);

      // Check for computedPropertyVar attribute
      let foundWithComputedVar = 0;
      for (const result of computedExpressions) {
        const nodeId = result.bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          // Log without BigInt issue
          console.log('Computed EXPRESSION node:', node?.name, node?.object, node?.property, 'computedPropertyVar:', node?.computedPropertyVar);
          if (node && node.computedPropertyVar) {
            foundWithComputedVar++;
            console.log(`  -> computedPropertyVar: ${node.computedPropertyVar}`);
          }
        }
      }

      assert.ok(foundWithComputedVar >= 2, `Should have at least 2 nodes with computedPropertyVar, got ${foundWithComputedVar}`);
    });

    it('should track computedPropertyVar for handlers[action]', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find m1 variable (could be CONSTANT or VARIABLE)
      let m1Var = await backend.checkGuarantee(`
        violation(X) :- node(X, "CONSTANT"), attr(X, "name", "m1").
      `);
      if (m1Var.length === 0) {
        m1Var = await backend.checkGuarantee(`
          violation(X) :- node(X, "VARIABLE"), attr(X, "name", "m1").
        `);
      }

      assert.ok(m1Var.length >= 1, 'Should have m1 variable or constant');

      // Get the EXPRESSION it's assigned from
      const m1Id = m1Var[0].bindings.find(b => b.name === 'X')?.value;
      const m1Node = await backend.getNode(m1Id);
      console.log('m1 node:', m1Node?.name, m1Node?.type);

      // Get ASSIGNED_FROM edges
      const edges = await backend.getOutgoingEdges(m1Id, ['ASSIGNED_FROM']);
      console.log('ASSIGNED_FROM edges count:', edges.length);

      let foundComputedPropertyVar = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log('Target node:', targetNode?.name, targetNode?.type, 'computed:', targetNode?.computed, 'computedPropertyVar:', targetNode?.computedPropertyVar);
        if (targetNode && targetNode.computed) {
          if (targetNode.computedPropertyVar === 'action') {
            foundComputedPropertyVar = true;
          }
        }
      }

      assert.ok(foundComputedPropertyVar, `Should find computedPropertyVar='action' in EXPRESSION node`);
    });
  });
});
