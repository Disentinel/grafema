/**
 * Return Statement Edges Tests for NESTED Functions (REG-336)
 *
 * Tests for RETURNS edge creation from return statements in NESTED arrow functions.
 * This is a regression test for a bug where nested arrow functions returning method calls
 * don't create RETURNS edges.
 *
 * Test case: Arrow function inside another arrow function returning a method call.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('RETURNS Edges for Nested Arrow Functions (REG-336)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  /**
   * Create a temporary test directory with specified files
   */
  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-returns-nested-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Create package.json to make it a valid project with main pointing to index.js
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({
        name: `test-returns-nested-${testCounter}`,
        type: 'module',
        main: 'index.js'
      })
    );

    // Write test files
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    return testDir;
  }

  /**
   * Clean up test directory
   */
  function cleanupTestDir() {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      testDir = null;
    }
  }

  beforeEach(async () => {
    if (db) {
      await db.cleanup();
    }
    cleanupTestDir();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) {
      await db.cleanup();
    }
    cleanupTestDir();
  });

  describe('Nested arrow function returning method call', () => {
    it('should create RETURNS edge for nested arrow function returning method call', async () => {
      const projectPath = await setupTest({
        'index.js': `
export const outer = () => {
  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  }

  return formatDate('2024-01-01')
}
        `.trim()
      });

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(projectPath);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the nested formatDate function
      const formatDateFunc = allNodes.find(n =>
        n.name === 'formatDate' && n.type === 'FUNCTION'
      );
      assert.ok(formatDateFunc, 'Nested function "formatDate" should exist');

      // Find RETURNS edge from formatDate (function -[RETURNS]-> returnValue)
      const returnsEdge = allEdges.find(e =>
        e.type === 'RETURNS' && e.src === formatDateFunc.id
      );

      // DEBUG: Print ALL function nodes
      console.log('All FUNCTION nodes:');
      const funcNodes = allNodes.filter(n => n.type === 'FUNCTION');
      funcNodes.forEach(n => console.log(`  ${n.id} (${n.name}) at ${n.line}:${n.column}`));

      // DEBUG: Print all edges for formatDate if no RETURNS edge found
      if (!returnsEdge) {
        console.log('formatDate function ID:', formatDateFunc.id);
        console.log('Edges involving formatDate:');
        const relatedEdges = allEdges.filter(e =>
          e.src === formatDateFunc.id || e.dst === formatDateFunc.id
        );
        relatedEdges.forEach(e => console.log(`  ${e.type}: ${e.src} -> ${e.dst}`));

        console.log('All CALL nodes:');
        const callNodes = allNodes.filter(n => n.type === 'CALL');
        callNodes.forEach(n => console.log(`  ${n.id} (${n.name}) at ${n.line}:${n.column}`));

        console.log('All RETURNS edges:');
        const returnsEdges = allEdges.filter(e => e.type === 'RETURNS');
        returnsEdges.forEach(e => console.log(`  ${e.src} -> ${e.dst}`));
      }

      assert.ok(returnsEdge, 'RETURNS edge should exist from formatDate to method call');

      // Verify the destination is the method call node (function -[RETURNS]-> returnValue)
      const target = allNodes.find(n => n.id === returnsEdge.dst);
      assert.ok(target, 'Target node should exist');
      assert.strictEqual(target.type, 'CALL', `Expected CALL, got ${target.type}`);
      assert.strictEqual(target.method, 'toLocaleDateString', 'Method name should be "toLocaleDateString"');
    });
  });
});
