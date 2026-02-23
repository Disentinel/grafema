/**
 * Class Property Declarations Tests (REG-552)
 *
 * Tests for VARIABLE nodes created from TypeScript class field declarations.
 *
 * What we verify:
 * - Each non-function class field declaration creates a VARIABLE node with isClassProperty: true
 * - metadata.accessibility: 'public' | 'private' | 'protected' (default 'public' when no modifier)
 * - metadata.readonly: true (only present when readonly modifier used)
 * - metadata.tsType: TypeScript type annotation string (when present)
 * - Correct name, line, column on each node
 * - CLASS -> HAS_PROPERTY -> VARIABLE edge exists
 *
 * Skip cases (should NOT create VARIABLE nodes):
 * - declare name: string (TypeScript declare-only fields, no runtime presence)
 * - Function-valued properties (handler = () => {} -> FUNCTION node, not VARIABLE)
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

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-classprop-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classprop-${testCounter}`,
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
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
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

// =============================================================================
// TESTS: Class Property Declarations (REG-552)
// =============================================================================

describe('Class Property Declarations (REG-552)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: Basic modifiers — private, protected, public
  // ===========================================================================

  describe('Basic accessibility modifiers', () => {
    it('should create VARIABLE nodes for class fields with private, protected, and public modifiers', async () => {
      await setupTest(backend, {
        'index.ts': `
class MyService {
  private graph: GraphBackend;
  protected config: OrchestratorOptions;
  public name: string;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);

      assert.strictEqual(
        classPropertyNodes.length,
        3,
        `Should have exactly 3 class property VARIABLE nodes, got ${classPropertyNodes.length}: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );

      // Verify each field by name and accessibility
      const graphField = classPropertyNodes.find(n => n.name === 'graph');
      assert.ok(graphField, 'Should have VARIABLE node for "graph"');
      assert.strictEqual(
        (graphField as Record<string, unknown>).accessibility,
        'private',
        'graph field should have accessibility = "private"'
      );

      const configField = classPropertyNodes.find(n => n.name === 'config');
      assert.ok(configField, 'Should have VARIABLE node for "config"');
      assert.strictEqual(
        (configField as Record<string, unknown>).accessibility,
        'protected',
        'config field should have accessibility = "protected"'
      );

      const nameField = classPropertyNodes.find(n => n.name === 'name');
      assert.ok(nameField, 'Should have VARIABLE node for "name"');
      assert.strictEqual(
        (nameField as Record<string, unknown>).accessibility,
        'public',
        'name field should have accessibility = "public"'
      );
    });
  });

  // ===========================================================================
  // TEST 2: No modifier defaults to public
  // ===========================================================================

  describe('Default accessibility (no modifier)', () => {
    it('should default to accessibility = "public" when no modifier is specified', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  name: string;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      assert.strictEqual(classPropertyNodes.length, 1, 'Should have 1 class property VARIABLE node');

      const nameField = classPropertyNodes[0];
      assert.strictEqual(nameField.name, 'name');
      assert.strictEqual(
        (nameField as Record<string, unknown>).accessibility,
        'public',
        'Field with no modifier should have accessibility = "public"'
      );
    });
  });

  // ===========================================================================
  // TEST 3: readonly combination — private readonly db: Database
  // ===========================================================================

  describe('readonly modifier', () => {
    it('should store both accessibility and readonly for "private readonly" fields', async () => {
      await setupTest(backend, {
        'index.ts': `
class DbManager {
  private readonly db: Database;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      assert.strictEqual(classPropertyNodes.length, 1, 'Should have 1 class property VARIABLE node');

      const dbField = classPropertyNodes[0];
      assert.strictEqual(dbField.name, 'db');
      assert.strictEqual(
        (dbField as Record<string, unknown>).accessibility,
        'private',
        'private readonly field should have accessibility = "private"'
      );
      assert.strictEqual(
        (dbField as Record<string, unknown>).readonly,
        true,
        'private readonly field should have readonly = true'
      );
    });

    it('should store readonly = true for "readonly" without access modifier', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  readonly maxRetries: number;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      assert.strictEqual(classPropertyNodes.length, 1, 'Should have 1 class property VARIABLE node');

      const field = classPropertyNodes[0];
      assert.strictEqual(field.name, 'maxRetries');
      // readonly without access modifier -> accessibility defaults to 'public'
      assert.strictEqual(
        (field as Record<string, unknown>).accessibility,
        'public',
        'readonly field without access modifier should default to accessibility = "public"'
      );
      assert.strictEqual(
        (field as Record<string, unknown>).readonly,
        true,
        'readonly field should have readonly = true'
      );
    });
  });

  // ===========================================================================
  // TEST 4: Type annotation stored in metadata
  // ===========================================================================

  describe('TypeScript type annotation', () => {
    it('should store the TypeScript type annotation string', async () => {
      await setupTest(backend, {
        'index.ts': `
class Service {
  private graph: GraphBackend;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      assert.strictEqual(classPropertyNodes.length, 1, 'Should have 1 class property VARIABLE node');

      const graphField = classPropertyNodes[0];
      assert.strictEqual(graphField.name, 'graph');

      const record = graphField as Record<string, unknown>;
      assert.strictEqual(record.accessibility, 'private', 'Should have accessibility metadata');
      assert.strictEqual(record.tsType, 'GraphBackend', 'Should have tsType metadata');
    });
  });

  // ===========================================================================
  // TEST 5: Line and column position
  // ===========================================================================

  describe('Line and column position', () => {
    it('should store correct line number on VARIABLE node', async () => {
      await setupTest(backend, {
        'index.ts': `class Positioned {
  private x: number;
  protected y: string;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);
      assert.strictEqual(classPropertyNodes.length, 2, 'Should have 2 class property VARIABLE nodes');

      const xField = classPropertyNodes.find(n => n.name === 'x');
      assert.ok(xField, 'Should have VARIABLE node for "x"');
      assert.strictEqual(xField.line, 2, 'x field should be on line 2');
      assert.ok(
        typeof (xField as Record<string, unknown>).column === 'number',
        'x field should have a column number'
      );

      const yField = classPropertyNodes.find(n => n.name === 'y');
      assert.ok(yField, 'Should have VARIABLE node for "y"');
      assert.strictEqual(yField.line, 3, 'y field should be on line 3');
    });
  });

  // ===========================================================================
  // TEST 6: HAS_PROPERTY edge from CLASS to VARIABLE
  // ===========================================================================

  describe('HAS_PROPERTY edge', () => {
    it('should create HAS_PROPERTY edge from CLASS to field VARIABLE', async () => {
      await setupTest(backend, {
        'index.ts': `
class Bar {
  private value: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(
        (n: NodeRecord) => n.type === 'CLASS' && n.name === 'Bar'
      );
      const fieldNode = allNodes.find(
        (n: NodeRecord) => n.type === 'VARIABLE' && n.name === 'value' &&
        (n as Record<string, unknown>).isClassProperty === true
      );

      assert.ok(classNode, 'Should have CLASS node for "Bar"');
      assert.ok(fieldNode, 'Should have VARIABLE node for "value"');

      // Check for HAS_PROPERTY edge
      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      const edge = hasPropertyEdges.find(
        (e: EdgeRecord) => e.src === classNode!.id && e.dst === fieldNode!.id
      );

      assert.ok(
        edge,
        `Should have HAS_PROPERTY edge from CLASS "${classNode!.id}" to VARIABLE "${fieldNode!.id}". ` +
        `Found ${hasPropertyEdges.length} HAS_PROPERTY edges: ${JSON.stringify(hasPropertyEdges.map(e => ({ src: e.src, dst: e.dst })))}`
      );
    });

    it('should create HAS_PROPERTY edges for multiple fields', async () => {
      await setupTest(backend, {
        'index.ts': `
class Multi {
  private a: string;
  protected b: number;
  public c: boolean;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(
        (n: NodeRecord) => n.type === 'CLASS' && n.name === 'Multi'
      );
      assert.ok(classNode, 'Should have CLASS node');

      const hasPropertyEdges = await getEdgesByType(backend, 'HAS_PROPERTY');
      const classEdges = hasPropertyEdges.filter(
        (e: EdgeRecord) => e.src === classNode!.id
      );

      assert.ok(
        classEdges.length >= 3,
        `CLASS "Multi" should have at least 3 HAS_PROPERTY edges, got ${classEdges.length}`
      );
    });
  });

  // ===========================================================================
  // TEST 7: declare field skipped
  // ===========================================================================

  describe('declare field (should be skipped)', () => {
    it('should NOT create a VARIABLE node for TypeScript declare-only fields', async () => {
      await setupTest(backend, {
        'index.ts': `
class WithDeclare {
  declare name: string;
  private realField: number;
}
        `
      });

      const classPropertyNodes = await getClassPropertyNodes(backend);

      // Only realField should produce a VARIABLE node, not the declare field
      assert.strictEqual(
        classPropertyNodes.length,
        1,
        `Should have exactly 1 class property VARIABLE node (only "realField"), ` +
        `got ${classPropertyNodes.length}: ${classPropertyNodes.map(n => n.name).join(', ')}`
      );
      assert.strictEqual(
        classPropertyNodes[0].name,
        'realField',
        'The only VARIABLE node should be "realField"'
      );
    });
  });

  // ===========================================================================
  // TEST 8: Function-valued field stays FUNCTION, not VARIABLE
  // ===========================================================================

  describe('Function-valued field (should create FUNCTION, not VARIABLE)', () => {
    it('should create FUNCTION node for arrow function field and VARIABLE for value field', async () => {
      await setupTest(backend, {
        'index.ts': `
class Mixed {
  private handler = () => {};
  private value: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // handler should be a FUNCTION node, not a VARIABLE
      const functionNodes = allNodes.filter(
        (n: NodeRecord) => n.type === 'FUNCTION' && n.name === 'handler'
      );
      assert.ok(
        functionNodes.length >= 1,
        'Arrow function class property "handler" should create a FUNCTION node'
      );

      // value should be a VARIABLE node with isClassProperty
      const classPropertyNodes = await getClassPropertyNodes(backend);
      const variableNames = classPropertyNodes.map(n => n.name);

      assert.strictEqual(
        classPropertyNodes.length,
        1,
        `Should have exactly 1 class property VARIABLE node (only "value"), ` +
        `got ${classPropertyNodes.length}: ${variableNames.join(', ')}`
      );
      assert.strictEqual(
        classPropertyNodes[0].name,
        'value',
        'The VARIABLE node should be "value", not "handler"'
      );

      // Verify handler is NOT in the VARIABLE nodes
      const handlerAsVariable = classPropertyNodes.find(n => n.name === 'handler');
      assert.ok(
        !handlerAsVariable,
        'handler should NOT be a VARIABLE node (it is a function)'
      );
    });
  });
});
