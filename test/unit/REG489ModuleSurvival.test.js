/**
 * MODULE Survival Tests (REG-489)
 *
 * Verifies that protectedTypes parameter on commitBatch prevents deletion
 * of specified node types during the delete-then-add cycle.
 *
 * Root cause: INDEXING phase creates MODULE nodes, then ANALYSIS phase calls
 * commitBatch for the same file -- which deletes ALL nodes including MODULE.
 * The fix adds protectedTypes: ["MODULE"] to skip deletion of MODULE nodes.
 *
 * Test scenarios:
 * 1. MODULE survives analysis commitBatch when protectedTypes includes MODULE
 * 2. Without protectedTypes, MODULE is deleted (regression baseline)
 * 3. CONTAINS edge from SERVICE to MODULE survives with protected MODULE
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('MODULE Survival with protectedTypes (REG-489)', () => {
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

  describe('protectedTypes preserves MODULE nodes', () => {
    it('should preserve MODULE node when protectedTypes includes MODULE', async () => {
      const client = backend._client;

      // INDEXING phase: add MODULE and FUNCTION nodes for app.js
      await backend.addNodes([
        { id: 'mod:app.js', type: 'MODULE', name: 'app', file: 'app.js' },
        { id: 'fn:oldHandler', type: 'FUNCTION', name: 'oldHandler', file: 'app.js' },
      ]);

      // Add SERVICE node (different file) and CONTAINS edge to MODULE
      await backend.addNodes([
        { id: 'svc:myService', type: 'SERVICE', name: 'myService', file: 'service.js' },
      ]);
      await backend.addEdges([
        { src: 'svc:myService', dst: 'mod:app.js', type: 'CONTAINS' },
      ]);

      // Verify MODULE exists before ANALYSIS
      const modulesBefore = await backend.findByType('MODULE');
      assert.ok(modulesBefore.length > 0, 'MODULE should exist after INDEXING');

      // ANALYSIS phase: commitBatch with protectedTypes: ["MODULE"]
      // This simulates JSASTAnalyzer replacing FUNCTION nodes for app.js
      client.beginBatch();
      client.batchNode({
        id: 'fn:newHandler',
        type: 'FUNCTION',
        name: 'newHandler',
        file: 'app.js',
      });
      // Add file to changed list so server knows to delete old app.js nodes
      client._batchFiles.add('app.js');

      const delta = await client.commitBatch(
        ['JSASTAnalyzer', 'ANALYSIS', 'app.js'],
        false,
        ['MODULE'],
      );

      // MODULE should survive
      const modulesAfter = await backend.findByType('MODULE');
      assert.ok(modulesAfter.length > 0,
        `MODULE node should survive with protectedTypes: ["MODULE"]. Found ${modulesAfter.length} MODULE nodes`);

      // New FUNCTION should exist
      const functionsAfter = await backend.findByType('FUNCTION');
      assert.ok(functionsAfter.length > 0, 'New FUNCTION node should be added');

      // CONTAINS edge from SERVICE to MODULE should survive
      const svcEdges = await backend.getOutgoingEdges('svc:myService');
      const containsEdge = svcEdges.find(e => e.type === 'CONTAINS');
      assert.ok(containsEdge, 'SERVICE -> MODULE CONTAINS edge should survive with protected MODULE');
    });
  });

  describe('legacy behavior without protectedTypes', () => {
    it('should delete MODULE when protectedTypes is not provided', async () => {
      const client = backend._client;

      // INDEXING phase: add MODULE and FUNCTION nodes for app.js
      await backend.addNodes([
        { id: 'mod:app.js', type: 'MODULE', name: 'app', file: 'app.js' },
        { id: 'fn:handler', type: 'FUNCTION', name: 'handler', file: 'app.js' },
      ]);

      // Verify MODULE exists before ANALYSIS
      const modulesBefore = await backend.findByType('MODULE');
      assert.ok(modulesBefore.length > 0, 'MODULE should exist after INDEXING');

      // ANALYSIS phase: commitBatch WITHOUT protectedTypes (legacy behavior)
      client.beginBatch();
      client.batchNode({
        id: 'fn:newHandler',
        type: 'FUNCTION',
        name: 'newHandler',
        file: 'app.js',
      });
      client._batchFiles.add('app.js');

      await client.commitBatch(
        ['JSASTAnalyzer', 'ANALYSIS', 'app.js'],
        false,
        // No protectedTypes -- legacy delete-all behavior
      );

      // MODULE should be deleted (this is the bug REG-489 fixes)
      const modulesAfter = await backend.findByType('MODULE');
      assert.strictEqual(modulesAfter.length, 0,
        'MODULE node should be deleted without protectedTypes (legacy behavior)');

      // New FUNCTION should exist
      const functionsAfter = await backend.findByType('FUNCTION');
      assert.ok(functionsAfter.length > 0, 'New FUNCTION node should be added');
    });
  });

  describe('edge preservation with protectedTypes', () => {
    it('should preserve edges FROM protected nodes when their targets are also protected', async () => {
      const client = backend._client;

      // Create two MODULE nodes with DEPENDS_ON edge between them
      await backend.addNodes([
        { id: 'mod:a.js', type: 'MODULE', name: 'moduleA', file: 'a.js' },
        { id: 'mod:b.js', type: 'MODULE', name: 'moduleB', file: 'b.js' },
        { id: 'fn:funcA', type: 'FUNCTION', name: 'funcA', file: 'a.js' },
      ]);
      await backend.addEdges([
        { src: 'mod:a.js', dst: 'mod:b.js', type: 'DEPENDS_ON' },
        { src: 'mod:a.js', dst: 'fn:funcA', type: 'CONTAINS' },
      ]);

      // ANALYSIS commitBatch for a.js with protectedTypes: ["MODULE"]
      client.beginBatch();
      client.batchNode({
        id: 'fn:funcA_v2',
        type: 'FUNCTION',
        name: 'funcA_v2',
        file: 'a.js',
      });
      client._batchFiles.add('a.js');

      await client.commitBatch(
        ['JSASTAnalyzer', 'ANALYSIS', 'a.js'],
        false,
        ['MODULE'],
      );

      // Both MODULE nodes should survive
      const modules = await backend.findByType('MODULE');
      assert.strictEqual(modules.length, 2,
        `Both MODULE nodes should survive. Found ${modules.length}`);

      // DEPENDS_ON edge between the two MODULEs should survive
      const modAEdges = await backend.getOutgoingEdges('mod:a.js');
      const dependsOnEdge = modAEdges.find(e => e.type === 'DEPENDS_ON');
      assert.ok(dependsOnEdge,
        'MODULE -> MODULE DEPENDS_ON edge should survive when both endpoints are protected');
    });
  });
});
