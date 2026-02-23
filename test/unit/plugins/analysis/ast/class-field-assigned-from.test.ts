/**
 * Class Field ASSIGNED_FROM Edge Tests (REG-570)
 *
 * Tests for ASSIGNED_FROM edges created from class field initializer expressions.
 *
 * What we verify:
 * - Each initialized class field's VARIABLE node has an ASSIGNED_FROM edge to its initializer
 * - Numeric, string, array, and object literal initializers create the correct target node type
 * - Uninitialized fields (no initializer) have no ASSIGNED_FROM edge and produce no
 *   ERR_MISSING_ASSIGNMENT from DataFlowValidator
 * - Private fields (#name) with initializers get ASSIGNED_FROM edges
 * - Static fields with initializers get ASSIGNED_FROM edges
 * - ClassExpression fields (both public and private) get ASSIGNED_FROM edges
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests FAIL against current code (ClassVisitor does not call trackVariableAssignment).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import { DataFlowValidator } from '@grafema/core';
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
  const testDir = join(tmpdir(), `grafema-test-classfield-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classfield-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  // tsconfig.json for TypeScript parsing
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

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get class property VARIABLE nodes (nodes with type='VARIABLE' and isClassProperty=true)
 */
async function getClassPropertyNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) =>
    n.type === 'VARIABLE' &&
    (n as Record<string, unknown>).isClassProperty === true
  );
}

/**
 * Get all edges from backend
 */
async function getAllEdges(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<EdgeRecord[]> {
  return backend.getAllEdges();
}

/**
 * Get edges by type
 */
async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await getAllEdges(backend);
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Find the ASSIGNED_FROM edge originating from a given node ID
 */
async function getAssignedFromEdgesForNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeId: string
): Promise<EdgeRecord[]> {
  const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');
  return assignedFromEdges.filter((e: EdgeRecord) => e.src === nodeId);
}

/**
 * Find the target node of an ASSIGNED_FROM edge
 */
async function getAssignmentTargetNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeRecord: EdgeRecord
): Promise<NodeRecord | null> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => n.id === edgeRecord.dst) || null;
}

// =============================================================================
// TESTS: Class Field ASSIGNED_FROM Edges (REG-570)
// =============================================================================

describe('Class Field ASSIGNED_FROM Edges (REG-570)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: Basic number initializer creates ASSIGNED_FROM edge
  // ===========================================================================

  describe('Basic number initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to LITERAL for numeric initializer', async () => {
      await setupTest(backend, {
        'index.ts': `
class Service {
  private count = 0;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const countNode = classPropertyNodes.find(n => n.name === 'count');

      assert.ok(countNode, 'Should have VARIABLE node for "count"');

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, countNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "count" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 2: String literal initializer
  // ===========================================================================

  describe('String literal initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to LITERAL for string initializer', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  name = 'default';
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const nameNode = classPropertyNodes.find(n => n.name === 'name');

      assert.ok(nameNode, 'Should have VARIABLE node for "name"');

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, nameNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "name" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 3: Array literal initializer
  // ===========================================================================

  describe('Array literal initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to ARRAY_LITERAL for array initializer', async () => {
      await setupTest(backend, {
        'index.ts': `
class Renderer {
  phases = ['a', 'b'];
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const phasesNode = classPropertyNodes.find(n => n.name === 'phases');

      assert.ok(phasesNode, 'Should have VARIABLE node for "phases"');

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, phasesNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "phases" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'ARRAY_LITERAL',
        `ASSIGNED_FROM target should be ARRAY_LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 4: Object literal initializer
  // ===========================================================================

  describe('Object literal initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE to OBJECT_LITERAL for object initializer', async () => {
      await setupTest(backend, {
        'index.ts': `
class Options {
  config = { debug: true };
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const configNode = classPropertyNodes.find(n => n.name === 'config');

      assert.ok(configNode, 'Should have VARIABLE node for "config"');

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, configNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "config" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'OBJECT_LITERAL',
        `ASSIGNED_FROM target should be OBJECT_LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 5: Uninitialized field produces no warning (no false positive)
  // ===========================================================================

  describe('Uninitialized field (no false positive)', () => {
    it('should have isClassProperty=true, no ASSIGNED_FROM edge, and no ERR_MISSING_ASSIGNMENT', async () => {
      await setupTest(backend, {
        'index.ts': `
class Typed {
  private graph: GraphBackend;
}
        `
      });

      // Part 1: Verify VARIABLE node exists with isClassProperty=true
      const classPropertyNodes = await getClassPropertyNodes(backend);
      const graphNode = classPropertyNodes.find(n => n.name === 'graph');

      assert.ok(graphNode, 'Should have VARIABLE node for "graph"');
      assert.strictEqual(
        (graphNode as Record<string, unknown>).isClassProperty,
        true,
        'graph field should have isClassProperty = true'
      );

      // Part 2: Verify NO ASSIGNED_FROM edge exists (field is uninitialized)
      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, graphNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        0,
        `Uninitialized field "graph" should have 0 ASSIGNED_FROM edges, got ${assignedFromEdges.length}`
      );

      // Part 3: Run DataFlowValidator and verify zero ERR_MISSING_ASSIGNMENT for this field
      const validator = new DataFlowValidator();
      const result = await validator.execute({ graph: backend });

      const missingAssignmentErrors = result.errors.filter(
        (e: { code: string; context?: Record<string, unknown> }) =>
          e.code === 'ERR_MISSING_ASSIGNMENT' &&
          e.context?.variable === 'graph'
      );

      assert.strictEqual(
        missingAssignmentErrors.length,
        0,
        `Uninitialized class field "graph" with isClassProperty=true should NOT produce ` +
        `ERR_MISSING_ASSIGNMENT. Got ${missingAssignmentErrors.length} error(s): ` +
        `${JSON.stringify(missingAssignmentErrors.map((e: { message: string }) => e.message))}`
      );
    });
  });

  // ===========================================================================
  // TEST 6: Private field with initializer
  // ===========================================================================

  describe('Private field with initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE "#count" to LITERAL', async () => {
      await setupTest(backend, {
        'index.ts': `
class Private {
  #count = 42;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const countNode = classPropertyNodes.find(n => n.name === '#count');

      assert.ok(
        countNode,
        `Should have VARIABLE node for "#count". ` +
        `Found class property nodes: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, countNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "#count" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 7: Static field with initializer
  // ===========================================================================

  describe('Static field with initializer', () => {
    it('should create ASSIGNED_FROM edge from VARIABLE "MAX" to LITERAL', async () => {
      await setupTest(backend, {
        'index.ts': `
class Statics {
  static MAX = 100;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const maxNode = classPropertyNodes.find(n => n.name === 'MAX');

      assert.ok(
        maxNode,
        `Should have VARIABLE node for "MAX". ` +
        `Found class property nodes: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, maxNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "MAX" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 8: ClassExpression public field
  // ===========================================================================

  describe('ClassExpression public field', () => {
    it('should create ASSIGNED_FROM edge for public field in class expression', async () => {
      await setupTest(backend, {
        'index.ts': `
const MyClass = class {
  value = 'hello';
};
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const valueNode = classPropertyNodes.find(n => n.name === 'value');

      assert.ok(
        valueNode,
        `Should have VARIABLE node for "value". ` +
        `Found class property nodes: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, valueNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "value" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });

  // ===========================================================================
  // TEST 9: ClassExpression private field
  // ===========================================================================

  describe('ClassExpression private field', () => {
    it('should create ASSIGNED_FROM edge for private field in class expression', async () => {
      await setupTest(backend, {
        'index.ts': `
const MyClass = class {
  #count = 42;
};
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      const countNode = classPropertyNodes.find(n => n.name === '#count');

      assert.ok(
        countNode,
        `Should have VARIABLE node for "#count" in class expression. ` +
        `Found class property nodes: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );

      const assignedFromEdges = await getAssignedFromEdgesForNode(backend, countNode!.id);

      assert.strictEqual(
        assignedFromEdges.length,
        1,
        `VARIABLE "#count" should have exactly 1 ASSIGNED_FROM edge, got ${assignedFromEdges.length}`
      );

      const targetNode = await getAssignmentTargetNode(backend, assignedFromEdges[0]);
      assert.ok(targetNode, 'ASSIGNED_FROM edge should point to an existing node');
      assert.strictEqual(
        targetNode!.type,
        'LITERAL',
        `ASSIGNED_FROM target should be LITERAL, got "${targetNode!.type}"`
      );
    });
  });
});
