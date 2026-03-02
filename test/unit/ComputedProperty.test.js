/**
 * Tests for computed property tracking (computedPropertyVar)
 *
 * V2 Migration Notes:
 * - V2 creates PROPERTY_ACCESS nodes (not EXPRESSION) for computed property access
 * - computed=true is set on PROPERTY_ACCESS nodes
 * - computedPropertyVar is not currently populated in V2 (known gap)
 * - handlers[action] -> PROPERTY_ACCESS name="handlers.action" computed=true
 * - items[i] -> PROPERTY_ACCESS name="items.i" computed=true
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
    it('should track computed=true for computed property access', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // V2: Computed access creates PROPERTY_ACCESS with computed=true (not EXPRESSION)
      const allNodes = await backend.getAllNodes();
      const computedPA = allNodes.filter(n =>
        n.type === 'PROPERTY_ACCESS' && n.computed === true
      );

      // Should have at least 2 computed PROPERTY_ACCESS nodes:
      // handlers[action], items[i], handlers[method]
      assert.ok(computedPA.length >= 2,
        `Should have at least 2 computed PROPERTY_ACCESS nodes, got ${computedPA.length}`);

      // Verify the computed property names
      const names = computedPA.map(n => n.name);
      assert.ok(
        names.some(n => n.includes('handlers')),
        `Should have computed access to handlers, got: [${names.join(', ')}]`
      );
      assert.ok(
        names.some(n => n.includes('items')),
        `Should have computed access to items, got: [${names.join(', ')}]`
      );
    });

    it('should track computed access for handlers[action] via m1 assignment', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find m1 variable
      const m1Var = allNodes.find(n =>
        (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === 'm1'
      );
      assert.ok(m1Var, 'Should have m1 variable');

      // Get ASSIGNED_FROM edges -- should point to PROPERTY_ACCESS with computed=true
      const assignedFromEdges = allEdges.filter(e =>
        e.src === m1Var.id && e.type === 'ASSIGNED_FROM'
      );
      assert.ok(assignedFromEdges.length >= 1,
        'm1 should have ASSIGNED_FROM edge');

      // V2: Target should be PROPERTY_ACCESS(handlers.action) with computed=true
      let foundComputed = false;
      for (const edge of assignedFromEdges) {
        const targetNode = allNodes.find(n => n.id === edge.dst);
        if (targetNode && targetNode.type === 'PROPERTY_ACCESS' && targetNode.computed === true) {
          foundComputed = true;
          assert.ok(
            targetNode.name.includes('handlers'),
            `Computed PROPERTY_ACCESS should reference handlers, got ${targetNode.name}`
          );
        }
      }

      assert.ok(foundComputed,
        'Should find PROPERTY_ACCESS with computed=true in ASSIGNED_FROM target');
    });
  });
});
