/**
 * Duplicate CALL Node Detection Tests (REG-418)
 *
 * Bug: processVariableDeclarations() in JSASTAnalyzer creates inline CALL nodes
 * (with IDs like `CALL#data.filter#file#7:18:inline`) independently of the
 * CallExpressionVisitor, which also creates a CALL node for the same call site.
 * This results in two CALL nodes for one call expression.
 *
 * These tests verify:
 * 1. Exactly one CALL node exists per call site (no duplicates)
 * 2. The variable has ASSIGNED_FROM edge to the single CALL node
 * 3. The CALL node uses the semantic ID format (not the `:inline` suffix format)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-dup-call-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-dup-call-${testCounter}`,
      type: 'module'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Duplicate CALL Nodes (REG-418)', () => {
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

  // ==========================================================================
  // 1. Core reproduction case from the issue
  // ==========================================================================
  describe('const valid = data.filter(this.validate) in class method', () => {
    it('should produce exactly 1 CALL node with method=filter', async () => {
      await setupTest(backend, {
        'index.js': `
class Pipeline {
  validate(item) { return item != null; }
  run(data) {
    const valid = data.filter(this.validate);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();

      const filterCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.method === 'filter'
      );

      assert.strictEqual(
        filterCalls.length,
        1,
        `Expected exactly 1 CALL node with method='filter', ` +
        `got ${filterCalls.length}: ${filterCalls.map(n => n.id).join(', ')}`
      );
    });

    it('should have ASSIGNED_FROM edge from variable to the CALL node', async () => {
      await setupTest(backend, {
        'index.js': `
class Pipeline {
  validate(item) { return item != null; }
  run(data) {
    const valid = data.filter(this.validate);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find the variable 'valid'
      const validVar = allNodes.find(n =>
        n.type === 'VARIABLE' && n.name === 'valid'
      );
      assert.ok(validVar, 'Should find variable "valid"');

      // Find the filter CALL node
      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      assert.ok(filterCall, 'Should find filter CALL node');

      // Variable should have ASSIGNED_FROM pointing to the CALL node
      const assignedFromEdges = allEdges.filter(e =>
        e.type === 'ASSIGNED_FROM' && e.src === validVar.id
      );
      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `Expected exactly 1 ASSIGNED_FROM edge from valid, got ${assignedFromEdges.length}`
      );

      const target = await backend.getNode(assignedFromEdges[0].dst);
      assert.ok(target, 'ASSIGNED_FROM target should exist');
      assert.strictEqual(
        target.type,
        'CALL',
        `Expected ASSIGNED_FROM to point to CALL node, got ${target.type}`
      );
      assert.strictEqual(
        target.method,
        'filter',
        `Expected CALL node method='filter', got ${target.method}`
      );
    });

    it('should use the semantic ID format, not the :inline format', async () => {
      await setupTest(backend, {
        'index.js': `
class Pipeline {
  validate(item) { return item != null; }
  run(data) {
    const valid = data.filter(this.validate);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();

      const filterCall = allNodes.find(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      assert.ok(filterCall, 'Should find filter CALL node');

      assert.ok(
        !filterCall.id.includes(':inline'),
        `CALL node ID should not contain ':inline' suffix. Got: ${filterCall.id}`
      );
    });
  });

  // ==========================================================================
  // 2. Simple case: const x = obj.method() at module level
  // ==========================================================================
  describe('const result = arr.map(fn) at module level', () => {
    it('should produce exactly 1 CALL node with method=map', async () => {
      await setupTest(backend, {
        'index.js': `
function double(x) { return x * 2; }
const arr = [1, 2, 3];
const result = arr.map(double);
`
      });

      const allNodes = await backend.getAllNodes();

      const mapCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.method === 'map'
      );

      assert.strictEqual(
        mapCalls.length,
        1,
        `Expected exactly 1 CALL node with method='map', ` +
        `got ${mapCalls.length}: ${mapCalls.map(n => n.id).join(', ')}`
      );
    });
  });

  // ==========================================================================
  // 3. Multiple variable assignments from method calls in same scope
  // ==========================================================================
  describe('multiple const = obj.method() in same function', () => {
    it('should produce exactly 1 CALL node per method call', async () => {
      await setupTest(backend, {
        'index.js': `
class Pipeline {
  validate(item) { return item != null; }
  transform(item) { return item * 2; }
  run(data) {
    const valid = data.filter(this.validate);
    const result = valid.map(this.transform);
  }
}
`
      });

      const allNodes = await backend.getAllNodes();

      const filterCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.method === 'filter'
      );
      const mapCalls = allNodes.filter(n =>
        n.type === 'CALL' && n.method === 'map'
      );

      assert.strictEqual(
        filterCalls.length,
        1,
        `Expected exactly 1 filter CALL node, ` +
        `got ${filterCalls.length}: ${filterCalls.map(n => n.id).join(', ')}`
      );
      assert.strictEqual(
        mapCalls.length,
        1,
        `Expected exactly 1 map CALL node, ` +
        `got ${mapCalls.length}: ${mapCalls.map(n => n.id).join(', ')}`
      );
    });
  });
});
