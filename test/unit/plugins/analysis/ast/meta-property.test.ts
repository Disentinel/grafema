/**
 * MetaProperty (new.target) Tests (REG-301)
 *
 * Tests for tracking `new.target` as PROPERTY_ACCESS nodes.
 *
 * `new.target` is a MetaProperty AST node that appears in constructors
 * and functions called with `new`. It's commonly used for abstract class detection.
 *
 * We track it as PROPERTY_ACCESS with objectName="new", propertyName="target"
 * — consistent with how `this.prop` uses objectName="this".
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

async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-meta-property-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-meta-property-${testCounter}`,
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

async function findPropertyAccessNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  name: string,
  objectName?: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => {
    if (n.type !== 'PROPERTY_ACCESS') return false;
    if (n.name !== name) return false;
    if (objectName !== undefined) {
      return (n as unknown as { objectName?: string }).objectName === objectName;
    }
    return true;
  });
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
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];
  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

// =============================================================================
// TESTS
// =============================================================================

describe('MetaProperty: new.target (REG-301)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // Basic new.target tracking
  // ===========================================================================

  describe('Basic new.target in constructor', () => {
    it('should create PROPERTY_ACCESS node for new.target', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {
  constructor() {
    if (new.target === Base) throw new Error('Abstract class');
  }
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'target', 'new');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node for new.target');
      assert.strictEqual(propAccess.type, 'PROPERTY_ACCESS');
      assert.strictEqual(propAccess.name, 'target');
      assert.strictEqual(
        (propAccess as unknown as { objectName?: string }).objectName,
        'new'
      );
    });

    it('should have file and line information', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {
  constructor() {
    console.log(new.target);
  }
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'target', 'new');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node');
      assert.ok(propAccess.file, 'Should have file path');
      assert.ok(propAccess.line, 'Should have line number');
    });
  });

  // ===========================================================================
  // CONTAINS edges
  // ===========================================================================

  describe('CONTAINS edges', () => {
    it('should have CONTAINS edge from enclosing function', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  constructor() {
    if (new.target === MyClass) {
      throw new Error('Cannot instantiate directly');
    }
  }
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'target', 'new');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node');

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const constructor = functionNodes.find(n => n.name === 'constructor');
      assert.ok(constructor, 'Should have constructor function');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const fnContainsProp = containsEdges.find(e =>
        e.src === constructor!.id && e.dst === propAccess.id
      );

      assert.ok(
        fnContainsProp,
        'Constructor should CONTAIN the new.target PROPERTY_ACCESS node'
      );
    });
  });

  // ===========================================================================
  // new.target in regular functions
  // ===========================================================================

  describe('new.target in regular functions', () => {
    it('should track new.target in function declarations', async () => {
      await setupTest(backend, {
        'index.js': `
function Foo() {
  if (!new.target) {
    return new Foo();
  }
  this.value = 42;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'target', 'new');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS for new.target in function');
    });
  });

  // ===========================================================================
  // Semantic IDs
  // ===========================================================================

  describe('Semantic IDs', () => {
    it('should have semanticId field', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {
  constructor() {
    console.log(new.target);
  }
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'target', 'new');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node');

      const semanticId = (propAccess as unknown as { semanticId?: string }).semanticId;
      assert.ok(semanticId, 'new.target PROPERTY_ACCESS should have semanticId');
    });
  });

  // ===========================================================================
  // Multiple new.target usages
  // ===========================================================================

  describe('Multiple usages', () => {
    it('should track multiple new.target in same constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class Base {
  constructor() {
    console.log(new.target.name);
    if (new.target === Base) throw new Error('Abstract');
  }
}
        `
      });

      // There should be at least one new.target PROPERTY_ACCESS
      // (the second may or may not be separate depending on chain handling)
      const allNodes = await backend.getAllNodes();
      const newTargetNodes = allNodes.filter((n: NodeRecord) =>
        n.type === 'PROPERTY_ACCESS' &&
        (n as unknown as { objectName?: string }).objectName === 'new' &&
        n.name === 'target'
      );

      assert.ok(
        newTargetNodes.length >= 1,
        `Should have at least 1 new.target PROPERTY_ACCESS, got ${newTargetNodes.length}`
      );
    });
  });
});
