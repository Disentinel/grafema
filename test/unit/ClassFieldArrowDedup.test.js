/**
 * Class Field Arrow Deduplication Tests (REG-562)
 *
 * Bug: `class A { field = x => x }` produces TWO FUNCTION nodes instead of one.
 *
 * In V2: Arrow function class fields create a PROPERTY node (with field name)
 * and a FUNCTION node (named '<arrow>'). Regular class methods are METHOD nodes.
 * There should be no extra FUNCTION nodes from FunctionVisitor for the same arrow.
 *
 * These tests verify:
 * 1. Basic class field arrow produces 1 PROPERTY + 1 FUNCTION (no duplicates)
 * 2. Class field with multiple params produces 1 PROPERTY + 1 FUNCTION
 * 3. Multiple class fields produce correct node counts
 * 4. Static class field produces 1 PROPERTY + 1 FUNCTION
 * 5. Private class field produces 1 PROPERTY + 1 FUNCTION
 * 6. Nested arrow inside class field body produces correct node counts
 * 7. Class field arrow alongside class method — no extra FUNCTION from FunctionVisitor
 * 8. Class expression (not declaration) produces correct node counts
 *
 * TDD: Tests written first per Kent Beck's methodology.
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
  const testDir = join(tmpdir(), `grafema-test-classfield-dedup-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classfield-dedup-${testCounter}`,
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

describe('Class Field Arrow Deduplication (REG-562)', () => {
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
  // Test 1: Basic class field arrow
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION nodes for basic class field arrow (no duplicates)', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    // V2: arrow field creates a PROPERTY named 'field' and a FUNCTION named '<arrow>'
    const namedField = allProperties.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `Should create exactly 1 PROPERTY node named 'field', got ${namedField.length}`
    );

    // Should have exactly 1 FUNCTION (the arrow, no duplicates)
    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 2: Class field with multiple params
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION for class field arrow with multiple params', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  handler = (e, ctx) => this.handle(e, ctx);
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    const namedHandler = allProperties.filter(n => n.name === 'handler');
    assert.strictEqual(
      namedHandler.length,
      1,
      `Should create exactly 1 PROPERTY node named 'handler'`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for multi-param class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 3: Multiple class fields
  // ==========================================================================
  it('should produce correct PROPERTY counts for two class field arrows', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  f1 = x => x;
  f2 = y => y;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    const f1 = allProperties.filter(n => n.name === 'f1');
    const f2 = allProperties.filter(n => n.name === 'f2');

    assert.strictEqual(f1.length, 1, 'Should have exactly 1 PROPERTY node for f1');
    assert.strictEqual(f2.length, 1, 'Should have exactly 1 PROPERTY node for f2');

    // Total: exactly 2 PROPERTY nodes — one per field, no duplicates
    assert.strictEqual(
      allProperties.length,
      2,
      `Expected exactly 2 PROPERTY nodes (one per class field), ` +
      `got ${allProperties.length}: ${allProperties.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 4: Static class field
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION for static class field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  static field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    const namedField = allProperties.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `Should create exactly 1 PROPERTY node named 'field' (static)`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for static class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 5: Private class field (ClassPrivateProperty in Babel)
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION for private class field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  #privateField = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    // V2: private fields are PROPERTY with '#' prefix name
    const namedPrivate = allProperties.filter(n => n.name === '#privateField');
    assert.strictEqual(
      namedPrivate.length,
      1,
      `Should create exactly 1 PROPERTY node named '#privateField', ` +
      `got ${namedPrivate.length}. All properties: ${allProperties.map(n => `${n.name}:${n.id}`).join(', ')}`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for private class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 6: Nested arrow inside class field body
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION nodes for class field arrow with nested inner arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  field = () => {
    const inner = x => x;
    return inner;
  };
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    // V2: PROPERTY 'field' for the outer arrow
    const namedField = allProperties.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `Should create exactly 1 PROPERTY node named 'field' (outer arrow)`
    );

    // V2: at least 1 FUNCTION for the arrow(s)
    assert.ok(
      allFunctions.length >= 1,
      `Expected at least 1 FUNCTION node (outer class field arrow), ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 7: Class field arrow alongside class method
  // ==========================================================================
  it('should produce correct node types for class with both method and field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  method() {}
  field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allMethods = allNodes.filter(n => n.type === 'METHOD');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    // V2: method() creates METHOD, field creates PROPERTY + FUNCTION
    const methodFunc = allMethods.filter(n => n.name === 'method');
    const fieldProp = allProperties.filter(n => n.name === 'field');

    assert.strictEqual(methodFunc.length, 1, 'Should have exactly 1 METHOD node for method');
    assert.strictEqual(fieldProp.length, 1, 'Should have exactly 1 PROPERTY node for field');

    // FUNCTION should have exactly 1 (the arrow for field)
    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node (arrow for field), ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 8: Class expression (not declaration)
  // ==========================================================================
  it('should produce PROPERTY + FUNCTION for class expression field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
const A = class {
  field = x => x;
};
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');
    const allProperties = allNodes.filter(n => n.type === 'PROPERTY');

    const namedField = allProperties.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `Should create exactly 1 PROPERTY node named 'field' in class expression`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for class expression field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });
});
