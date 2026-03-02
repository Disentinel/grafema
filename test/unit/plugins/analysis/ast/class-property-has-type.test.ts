/**
 * ClassProperty / ClassPrivateProperty HAS_TYPE edge tests (REG-604)
 *
 * Verifies that class field type annotations produce HAS_TYPE edges,
 * consistent with TSPropertySignature.typeAnnotation behavior.
 *
 * Acceptance criteria:
 * - `class { bar: string }` → PROPERTY --HAS_TYPE--> TYPE_REFERENCE:string
 * - `class { #priv: number }` → PROPERTY --HAS_TYPE--> TYPE_REFERENCE:number
 * - ClassAccessorProperty also produces HAS_TYPE edge
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
  const testDir = join(tmpdir(), `grafema-test-classproptypes-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classproptypes-${testCounter}`,
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

async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

// =============================================================================
// TESTS: ClassProperty / ClassPrivateProperty HAS_TYPE edges (REG-604)
// =============================================================================

describe('ClassProperty / ClassPrivateProperty HAS_TYPE edges (REG-604)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: ClassProperty with type annotation → HAS_TYPE edge
  // ===========================================================================

  it('should create HAS_TYPE edge from class field PROPERTY to TYPE_REFERENCE for type annotation', async () => {
    await setupTest(backend, {
      'index.ts': `
class Foo {
  bar: string;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const propertyNode = allNodes.find(
      (n: NodeRecord) => n.type === 'PROPERTY' && n.name === 'bar'
    );
    assert.ok(propertyNode, 'Should have PROPERTY node for "bar"');

    const hasTypeEdges = await getEdgesByType(backend, 'HAS_TYPE');
    const edge = hasTypeEdges.find(
      (e: EdgeRecord) => e.src === propertyNode!.id
    );

    assert.ok(
      edge,
      `Should have HAS_TYPE edge from PROPERTY "bar". ` +
      `Found ${hasTypeEdges.length} HAS_TYPE edges total.`
    );

    // Target should be a TYPE_REFERENCE node
    const targetNode = allNodes.find((n: NodeRecord) => n.id === edge!.dst);
    assert.ok(targetNode, 'HAS_TYPE edge target node should exist');
    assert.strictEqual(
      targetNode!.type,
      'TYPE_REFERENCE',
      `HAS_TYPE target should be TYPE_REFERENCE, got "${targetNode!.type}"`
    );
  });

  // ===========================================================================
  // TEST 2: ClassPrivateProperty with type annotation → HAS_TYPE edge
  // ===========================================================================

  it('should create HAS_TYPE edge from private class field PROPERTY to TYPE_REFERENCE', async () => {
    await setupTest(backend, {
      'index.ts': `
class Foo {
  #priv: number;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const propertyNode = allNodes.find(
      (n: NodeRecord) => n.type === 'PROPERTY' && n.name === '#priv'
    );
    assert.ok(propertyNode, 'Should have PROPERTY node for "#priv"');

    const hasTypeEdges = await getEdgesByType(backend, 'HAS_TYPE');
    const edge = hasTypeEdges.find(
      (e: EdgeRecord) => e.src === propertyNode!.id
    );

    assert.ok(
      edge,
      `Should have HAS_TYPE edge from PROPERTY "#priv". ` +
      `Found ${hasTypeEdges.length} HAS_TYPE edges total.`
    );

    const targetNode = allNodes.find((n: NodeRecord) => n.id === edge!.dst);
    assert.ok(targetNode, 'HAS_TYPE edge target node should exist');
    assert.strictEqual(
      targetNode!.type,
      'TYPE_REFERENCE',
      `HAS_TYPE target should be TYPE_REFERENCE, got "${targetNode!.type}"`
    );
  });

  // ===========================================================================
  // TEST 3: No type annotation → no HAS_TYPE edge
  // ===========================================================================

  it('should NOT create HAS_TYPE edge when class field has no type annotation', async () => {
    await setupTest(backend, {
      'index.ts': `
class NoType {
  value = 42;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    // Find VARIABLE node (fields with initializers become VARIABLE via ClassVisitor)
    const fieldNode = allNodes.find(
      (n: NodeRecord) =>
        (n.type === 'PROPERTY' || n.type === 'VARIABLE') &&
        n.name === 'value'
    );

    if (fieldNode) {
      const hasTypeEdges = await getEdgesByType(backend, 'HAS_TYPE');
      const edge = hasTypeEdges.find(
        (e: EdgeRecord) => e.src === fieldNode!.id
      );

      assert.ok(
        !edge,
        'Should NOT have HAS_TYPE edge when no type annotation present'
      );
    }
  });

  // ===========================================================================
  // TEST 4: Multiple typed fields → each gets HAS_TYPE
  // ===========================================================================

  it('should create HAS_TYPE edges for multiple typed class fields', async () => {
    await setupTest(backend, {
      'index.ts': `
class Multi {
  name: string;
  count: number;
  active: boolean;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const propertyNodes = allNodes.filter(
      (n: NodeRecord) => n.type === 'PROPERTY' && ['name', 'count', 'active'].includes(n.name)
    );
    assert.strictEqual(
      propertyNodes.length,
      3,
      `Should have 3 PROPERTY nodes, got ${propertyNodes.length}: ${propertyNodes.map(n => n.name).join(', ')}`
    );

    const hasTypeEdges = await getEdgesByType(backend, 'HAS_TYPE');

    for (const prop of propertyNodes) {
      const edge = hasTypeEdges.find((e: EdgeRecord) => e.src === prop.id);
      assert.ok(
        edge,
        `PROPERTY "${prop.name}" should have a HAS_TYPE edge`
      );
    }
  });

  // ===========================================================================
  // TEST 5: Consistency with TSPropertySignature behavior
  // ===========================================================================

  it('should produce HAS_TYPE edges consistent with TSPropertySignature', async () => {
    await setupTest(backend, {
      'index.ts': `
interface IFoo {
  bar: string;
}

class Foo {
  bar: string;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const hasTypeEdges = await getEdgesByType(backend, 'HAS_TYPE');

    // Interface property (TSPropertySignature) HAS_TYPE edge
    const interfaceProperty = allNodes.find(
      (n: NodeRecord) => n.type === 'PROPERTY' && n.name === 'bar' &&
        n.id.includes('IFoo')
    );

    // Class property HAS_TYPE edge
    const classProperty = allNodes.find(
      (n: NodeRecord) => n.type === 'PROPERTY' && n.name === 'bar' &&
        n.id.includes('Foo') && !n.id.includes('IFoo')
    );

    if (interfaceProperty && classProperty) {
      const interfaceEdge = hasTypeEdges.find(
        (e: EdgeRecord) => e.src === interfaceProperty!.id
      );
      const classEdge = hasTypeEdges.find(
        (e: EdgeRecord) => e.src === classProperty!.id
      );

      assert.ok(interfaceEdge, 'TSPropertySignature "bar" should have HAS_TYPE edge');
      assert.ok(classEdge, 'ClassProperty "bar" should have HAS_TYPE edge');
    }
  });
});
