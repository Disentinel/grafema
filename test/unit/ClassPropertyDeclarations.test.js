/**
 * Class Property Declaration Tests (REG-552)
 *
 * Tests for indexing TypeScript class property declarations:
 * - private/public/protected fields create VARIABLE nodes with modifier
 * - TypeScript type annotations stored in declaredType
 * - HAS_PROPERTY edge from CLASS to field VARIABLE
 * - Correct source positions (file, line, column)
 * - readonly modifier support
 * - Fields with initializers (count = 0) still indexed
 * - Function-valued properties still create FUNCTION nodes (no regression)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL initially — implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a TypeScript test project with given files.
 *
 * Automatically creates:
 * - package.json with type: 'module'
 * - tsconfig.json (required for TS source discovery)
 * - All provided files
 *
 * tsconfig.json is essential: without it, resolveSourceEntrypoint()
 * returns null and the project falls back to 'index.js'.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-class-props-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json — type: 'module' for ESM
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-class-props-${testCounter}`,
      type: 'module'
    })
  );

  // tsconfig.json — signals this is a TypeScript project
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
    const filePath = join(testDir, filename);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Helper to find nodes by type
 */
async function getNodesByType(backend, type) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter(n => n.type === type);
}

/**
 * Helper to find edges by type
 */
async function getEdgesByType(backend, type) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter(e => e.type === type);
}

describe('Class Property Declarations (REG-552)', () => {
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

  // ===========================================================================
  // 1. Three fields with different modifiers all indexed
  // ===========================================================================

  it('should create VARIABLE nodes for fields with private/public/protected modifiers', async () => {
    await setupTest(backend, {
      'index.ts': `
class Service {
  private graph: GraphBackend;
  public name: string;
  protected config: Config;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const variables = allNodes.filter(n => n.type === 'VARIABLE');

    const graphField = variables.find(v => v.name === 'graph');
    const nameField = variables.find(v => v.name === 'name');
    const configField = variables.find(v => v.name === 'config');

    assert.ok(graphField, 'private graph field should exist as VARIABLE');
    assert.ok(nameField, 'public name field should exist as VARIABLE');
    assert.ok(configField, 'protected config field should exist as VARIABLE');

    assert.strictEqual(graphField.modifier, 'private',
      `graph modifier should be 'private', got: ${graphField.modifier}`);
    assert.strictEqual(nameField.modifier, 'public',
      `name modifier should be 'public', got: ${nameField.modifier}`);
    assert.strictEqual(configField.modifier, 'protected',
      `config modifier should be 'protected', got: ${configField.modifier}`);
  });

  // ===========================================================================
  // 2. TypeScript type annotation stored in declaredType
  // ===========================================================================

  it('should store TypeScript type annotation in declaredType', async () => {
    await setupTest(backend, {
      'index.ts': `
class Repo {
  private db: Database;
  public items: string[];
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const variables = allNodes.filter(n => n.type === 'VARIABLE');

    const dbField = variables.find(v => v.name === 'db');
    const itemsField = variables.find(v => v.name === 'items');

    assert.ok(dbField, 'db field should exist');
    assert.strictEqual(dbField.declaredType, 'Database',
      `db type should be 'Database', got: ${dbField.declaredType}`);

    assert.ok(itemsField, 'items field should exist');
    assert.strictEqual(itemsField.declaredType, 'string[]',
      `items type should be 'string[]', got: ${itemsField.declaredType}`);
  });

  // ===========================================================================
  // 3. HAS_PROPERTY edge from CLASS to field VARIABLE
  // ===========================================================================

  it('should create HAS_PROPERTY edge from CLASS to field VARIABLE', async () => {
    await setupTest(backend, {
      'index.ts': `
class Worker {
  private queue: string[];
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const workerClass = allNodes.find(n => n.type === 'CLASS' && n.name === 'Worker');
    const queueField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'queue');

    assert.ok(workerClass, 'Worker class should exist');
    assert.ok(queueField, 'queue field should exist as VARIABLE');

    const edge = allEdges.find(e =>
      e.type === 'HAS_PROPERTY' && e.src === workerClass.id && e.dst === queueField.id
    );
    assert.ok(edge, 'CLASS -[HAS_PROPERTY]-> VARIABLE(queue) edge should exist');
  });

  // ===========================================================================
  // 4. Field has correct file, line, column
  // ===========================================================================

  it('should record correct source position for field', async () => {
    await setupTest(backend, {
      'index.ts': `
class Foo {
  private bar: number;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const barField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'bar');

    assert.ok(barField, 'bar field should exist');
    assert.ok(barField.file, 'bar field should have file path');
    assert.ok(barField.file.endsWith('index.ts'), `file should end with index.ts, got: ${barField.file}`);
    assert.strictEqual(typeof barField.line, 'number', 'bar field should have numeric line');
    assert.ok(barField.line > 0, `line should be positive, got: ${barField.line}`);
  });

  // ===========================================================================
  // 5. readonly modifier
  // ===========================================================================

  it('should handle readonly modifier', async () => {
    await setupTest(backend, {
      'index.ts': `
class Config {
  readonly maxRetries: number;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const field = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'maxRetries');

    assert.ok(field, 'maxRetries field should exist');
    assert.ok(
      field.modifier?.includes('readonly'),
      `modifier should include 'readonly', got: ${field.modifier}`
    );
  });

  // ===========================================================================
  // 6. Field with initializer (count = 0) still gets indexed
  // ===========================================================================

  it('should index field with initializer value', async () => {
    await setupTest(backend, {
      'index.ts': `
class Counter {
  count = 0;
}
      `
    });

    const allNodes = await backend.getAllNodes();
    const countField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'count');

    assert.ok(countField, 'count field with initializer should exist as VARIABLE');
  });

  // ===========================================================================
  // 7. Function-valued property still creates FUNCTION node (no regression)
  // ===========================================================================

  it('should not break function-valued class properties (regression check)', async () => {
    await setupTest(backend, {
      'index.ts': `
class Handler {
  private label: string;
  handle = () => { return 'handled'; };
}
      `
    });

    const allNodes = await backend.getAllNodes();

    // label -> VARIABLE with modifier
    const labelField = allNodes.filter(n => n.type === 'VARIABLE').find(v => v.name === 'label');
    assert.ok(labelField, 'label field should exist as VARIABLE');
    assert.strictEqual(labelField.modifier, 'private',
      `label modifier should be 'private', got: ${labelField.modifier}`);

    // handle -> FUNCTION (existing behavior, must not regress)
    const handleFunc = allNodes.filter(n => n.type === 'FUNCTION').find(f => f.name === 'handle');
    assert.ok(handleFunc, 'handle should exist as FUNCTION (arrow function property)');
  });
});
