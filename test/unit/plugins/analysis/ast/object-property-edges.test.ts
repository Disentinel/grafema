/**
 * Object Property Edge Tests (REG-228)
 *
 * Tests for HAS_PROPERTY edges connecting OBJECT_LITERAL nodes to their
 * property value nodes (LITERAL, nested OBJECT_LITERAL, ARRAY_LITERAL, etc.)
 *
 * What already works:
 * - LITERAL nodes ARE created for property values (via `literals` collection)
 * - OBJECT_LITERAL nodes ARE created
 * - HAS_PROPERTY edge type IS defined
 *
 * What's missing (and should fail initially):
 * - HAS_PROPERTY edges are NOT being created
 *   (the `objectProperties` collection is collected but not passed to GraphBuilder)
 *
 * The fix should:
 * - Create HAS_PROPERTY edges from OBJECT_LITERAL -> value nodes
 * - Include propertyName in edge metadata
 * - Handle nested objects (OBJECT_LITERAL -> nested OBJECT_LITERAL)
 * - Handle multiple properties creating multiple edges
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
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
  backend: ReturnType<typeof createTestBackend>,
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-obj-props-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-obj-props-${testCounter}`,
      type: 'module',
      main: 'index.js'
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
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: ReturnType<typeof createTestBackend>,
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: ReturnType<typeof createTestBackend>,
  edgeType: string
): Promise<EdgeRecord[]> {
  // Backend stores edges, we need to query all and filter
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

// =============================================================================
// TESTS: HAS_PROPERTY Edges for Object Literals
// =============================================================================

describe('Object Property Edges (REG-228)', () => {
  let backend: ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = createTestBackend() as ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // TESTS: Basic HAS_PROPERTY edge creation
  // ===========================================================================

  describe('Basic HAS_PROPERTY edge creation', () => {
    it('should create HAS_PROPERTY edge from OBJECT_LITERAL to LITERAL', async () => {
      // Setup: Object literal with a simple literal property value
      await setupTest(backend, {
        'index.js': `
function configure(opts) {
  return opts;
}

configure({
  port: 3000
});
        `
      });

      // Find the OBJECT_LITERAL node
      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 1, 'Should have at least one OBJECT_LITERAL node');

      // Find HAS_PROPERTY edges
      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      assert.ok(hasPropertyEdges.length >= 1, 'Should have at least one HAS_PROPERTY edge');

      // Verify edge connects OBJECT_LITERAL to a value node
      const objectLiteralId = objectLiterals[0].id;
      const edgesFromObject = hasPropertyEdges.filter((e: EdgeRecord) => e.src === objectLiteralId);
      assert.ok(edgesFromObject.length >= 1, 'Should have HAS_PROPERTY edge from OBJECT_LITERAL');
    });

    it('should include propertyName in edge metadata', async () => {
      await setupTest(backend, {
        'index.js': `
function process(settings) {
  return settings;
}

process({
  host: "localhost",
  port: 8080
});
        `
      });

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      assert.ok(hasPropertyEdges.length >= 2, 'Should have at least 2 HAS_PROPERTY edges');

      // Each edge should have propertyName in metadata
      for (const edge of hasPropertyEdges) {
        const metadata = typeof edge.metadata === 'string'
          ? JSON.parse(edge.metadata)
          : (edge.metadata || {});
        const propName = metadata.propertyName ?? (edge as unknown as { propertyName?: string }).propertyName;
        assert.ok(
          propName,
          `Edge should have propertyName in metadata: ${JSON.stringify(edge)}`
        );
      }

      // Verify specific property names exist
      const propertyNames = hasPropertyEdges.map((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        return metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
      });
      assert.ok(propertyNames.includes('host'), 'Should have edge for "host" property');
      assert.ok(propertyNames.includes('port'), 'Should have edge for "port" property');
    });

    it('should create multiple edges for multiple properties', async () => {
      await setupTest(backend, {
        'index.js': `
function createUser(data) {
  return data;
}

createUser({
  name: "Alice",
  age: 30,
  active: true
});
        `
      });

      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 1, 'Should have OBJECT_LITERAL node');

      const objectLiteralId = objectLiterals[0].id;
      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      const edgesFromObject = hasPropertyEdges.filter((e: EdgeRecord) => e.src === objectLiteralId);

      assert.strictEqual(
        edgesFromObject.length,
        3,
        `Should have 3 HAS_PROPERTY edges from object, got ${edgesFromObject.length}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Nested object literals
  // ===========================================================================

  describe('Nested object literals', () => {
    it('should create HAS_PROPERTY edge from parent to nested OBJECT_LITERAL', async () => {
      await setupTest(backend, {
        'index.js': `
function init(config) {
  return config;
}

init({
  database: {
    host: "localhost"
  }
});
        `
      });

      // Should have 2 OBJECT_LITERAL nodes (parent and nested)
      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 2, `Should have at least 2 OBJECT_LITERAL nodes, got ${objectLiterals.length}`);

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');

      // Find edge with propertyName="database" that points to nested OBJECT_LITERAL
      const databaseEdge = hasPropertyEdges.find((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        const propName = metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
        return propName === 'database';
      });

      assert.ok(databaseEdge, 'Should have HAS_PROPERTY edge for "database" property');

      // Verify destination is an OBJECT_LITERAL
      const dstNode = await backend.getNode(databaseEdge!.dst);
      assert.ok(dstNode, 'Destination node should exist');
      assert.strictEqual(dstNode.type, 'OBJECT_LITERAL', 'Destination should be nested OBJECT_LITERAL');
    });

    it('should handle deeply nested objects', async () => {
      await setupTest(backend, {
        'index.js': `
function process(deep) {
  return deep;
}

process({
  level1: {
    level2: {
      value: 42
    }
  }
});
        `
      });

      // Should have 3 OBJECT_LITERAL nodes
      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 3, `Should have at least 3 OBJECT_LITERAL nodes, got ${objectLiterals.length}`);

      // Should have HAS_PROPERTY edges connecting them
      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');

      // Should have edges for: level1, level2, value
      assert.ok(hasPropertyEdges.length >= 3, `Should have at least 3 HAS_PROPERTY edges, got ${hasPropertyEdges.length}`);
    });
  });

  // ===========================================================================
  // TESTS: Object literals as function arguments
  // ===========================================================================

  describe('Object literals as function arguments', () => {
    it('should create HAS_PROPERTY edges for object literals passed to functions', async () => {
      await setupTest(backend, {
        'index.js': `
function configure(opts) {
  return opts;
}

configure({ timeout: 5000, retry: 3 });
        `
      });

      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 1, 'Should have OBJECT_LITERAL node for argument');

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      assert.ok(hasPropertyEdges.length >= 2, 'Should have HAS_PROPERTY edges for argument properties');

      const propertyNames = hasPropertyEdges.map((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        return metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
      });
      assert.ok(propertyNames.includes('timeout'), 'Should have edge for "timeout"');
      assert.ok(propertyNames.includes('retry'), 'Should have edge for "retry"');
    });

    it('should create HAS_PROPERTY edges for nested objects in function arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function doFetch(url, options) {
  return { url, options };
}

doFetch('/api', {
  headers: {
    contentType: 'application/json'
  }
});
        `
      });

      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 2, 'Should have OBJECT_LITERAL nodes for both levels');

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      assert.ok(hasPropertyEdges.length >= 2, 'Should have HAS_PROPERTY edges');

      // Check for "headers" edge pointing to nested OBJECT_LITERAL
      const headersEdge = hasPropertyEdges.find((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        const propName = metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
        return propName === 'headers';
      });
      assert.ok(headersEdge, 'Should have edge for "headers"');

      if (headersEdge) {
        const dstNode = await backend.getNode(headersEdge.dst);
        assert.ok(dstNode, 'Headers destination should exist');
        assert.strictEqual(dstNode.type, 'OBJECT_LITERAL', 'Headers should point to OBJECT_LITERAL');
      }
    });
  });

  // ===========================================================================
  // TESTS: Mixed property value types
  // ===========================================================================

  describe('Mixed property value types', () => {
    it('should create HAS_PROPERTY edges for array literal values', async () => {
      await setupTest(backend, {
        'index.js': `
function init(config) {
  return config;
}

init({
  ports: [8080, 8081, 8082]
});
        `
      });

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');

      const portsEdge = hasPropertyEdges.find((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        const propName = metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
        return propName === 'ports';
      });
      assert.ok(portsEdge, 'Should have edge for "ports" property');

      // Verify destination is ARRAY_LITERAL
      if (portsEdge) {
        const dstNode = await backend.getNode(portsEdge.dst);
        assert.ok(dstNode, 'Destination node should exist');
        assert.strictEqual(dstNode.type, 'ARRAY_LITERAL', 'ports should point to ARRAY_LITERAL');
      }
    });

    it('should handle object with mixed literal types', async () => {
      await setupTest(backend, {
        'index.js': `
function process(mixed) {
  return mixed;
}

process({
  name: "test",
  count: 42,
  enabled: true,
  ratio: 3.14,
  nothing: null
});
        `
      });

      const objectLiterals = await getNodesByType(backend, 'OBJECT_LITERAL');
      assert.ok(objectLiterals.length >= 1, 'Should have OBJECT_LITERAL node');

      const objectLiteralId = objectLiterals[0].id;
      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      const edgesFromObject = hasPropertyEdges.filter((e: EdgeRecord) => e.src === objectLiteralId);

      assert.strictEqual(
        edgesFromObject.length,
        5,
        `Should have 5 HAS_PROPERTY edges, got ${edgesFromObject.length}`
      );

      // Verify each property has an edge
      const propertyNames = edgesFromObject.map((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        return metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
      });
      assert.ok(propertyNames.includes('name'), 'Should have edge for "name"');
      assert.ok(propertyNames.includes('count'), 'Should have edge for "count"');
      assert.ok(propertyNames.includes('enabled'), 'Should have edge for "enabled"');
      assert.ok(propertyNames.includes('ratio'), 'Should have edge for "ratio"');
      assert.ok(propertyNames.includes('nothing'), 'Should have edge for "nothing"');
    });
  });

  // ===========================================================================
  // TESTS: Edge connectivity verification
  // ===========================================================================

  describe('Edge connectivity', () => {
    it('should have valid src and dst node IDs in edges', async () => {
      await setupTest(backend, {
        'index.js': `
function process(obj) {
  return obj;
}

process({ key: "value" });
        `
      });

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');

      for (const edge of hasPropertyEdges) {
        const srcNode = await backend.getNode(edge.src);
        const dstNode = await backend.getNode(edge.dst);

        assert.ok(srcNode, `Source node ${edge.src} should exist`);
        assert.ok(dstNode, `Destination node ${edge.dst} should exist`);
        assert.strictEqual(srcNode.type, 'OBJECT_LITERAL', 'Source should be OBJECT_LITERAL');
      }
    });

    it('should connect parent OBJECT_LITERAL to correct child nodes', async () => {
      await setupTest(backend, {
        'index.js': `
function process(parent) {
  return parent;
}

process({
  child: {
    grandchild: "value"
  }
});
        `
      });

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');

      // Find "child" edge
      const childEdge = hasPropertyEdges.find((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        const propName = metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
        return propName === 'child';
      });
      assert.ok(childEdge, 'Should have edge for "child"');

      // The src of "child" edge should be different from src of "grandchild" edge
      const grandchildEdge = hasPropertyEdges.find((e: EdgeRecord) => {
        const metadata = typeof e.metadata === 'string'
          ? JSON.parse(e.metadata)
          : (e.metadata || {});
        const propName = metadata.propertyName ?? (e as unknown as { propertyName?: string }).propertyName;
        return propName === 'grandchild';
      });
      assert.ok(grandchildEdge, 'Should have edge for "grandchild"');

      // "grandchild" src should be the nested object (which is "child" dst)
      if (childEdge && grandchildEdge) {
        assert.strictEqual(
          grandchildEdge.src,
          childEdge.dst,
          'Grandchild edge src should equal child edge dst (the nested object)'
        );
      }
    });
  });
});
